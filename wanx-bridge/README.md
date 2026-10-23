# WANX 盒端桥接服务

本目录是独立 Python 包，承接万象平台签票、会话租约与 HTTP/SSE/WebSocket 代理。它使用 Octop 已有的公共 HTTP/OIDC 接口，不导入 Octop 内部模块、不读写 Octop 数据库、不读取其 JWT 签名密钥。发布包依赖不包含 Octop。

## 身份与请求边界

```text
万象客户端 ──P2P──> bridge :8088 ──HTTP──> Octop 127.0.0.1:18088
                         │                    │
                         └─ 内部 OIDC 127.0.0.1:18089 <─┘
```

客户端先取得盒端签名 challenge，再向平台申请当前账号、客户端和盒子的访问票据。bridge 验证票据、消费一次性 challenge，通过原生 OIDC 授权码、PKCE、nonce 流程映射独立用户；角色通过原生管理 API 同步。返回客户端的是短期 bridge 会话标识，原生 Octop JWT 留在盒端。

bridge 在请求与长连接上强制校验租约；续期保留当前流，过期或授权版本变化关闭连接。Octop 自身 JWT 的有效期仍有效，超过其期限的 WebSocket 依照原生行为重连。部署不得同时公开原始 Octop 端口，否则远程访问会绕过 bridge。

个人资料允许有效平台会话调用 `GET/PATCH /api/auth/me`（读取资料、修改显示名称、语言和预设头像）以及 `POST/DELETE /api/auth/me/avatar`（上传、删除头像）；客户端网关与 bridge 使用相同的方法和路径范围，仍由上游校验当前用户及请求字段。

公开入口限制原生账号、角色、邀请与密码管理写入，以及备份创建/档案传输/恢复、setup 和 OIDC 配置接口；这些操作由平台授权流程或可信本地管理入口执行。经有效平台会话认证的 `GET /api/admin/backup/list`、`status`、`auto` 可读取元数据，仍由原生备份权限校验。备份可能包含原生签名与 OIDC 凭据，不能经远程会话下载。常规聊天与工作界面保持原有交互，但不能把远程入口描述为全部管理员能力均可用。主机 root 或具备终端任意代码执行能力的管理员属于本地信任边界，应用代理不提供对这些权限的沙箱隔离。

## 运行配置

需要 Python 3.12+。开发环境可在仓库根目录执行：

```sh
uv sync --project wanx-bridge
# 先单独启动原始 Octop，并配置下列环境变量
uv run --project wanx-bridge python -m wanx_bridge
```

生产使用 OS 的 `deployment/docker/wanx.Dockerfile` 和监督入口，将两个服务作为同容器子进程运行。环境示例中的真实身份和密钥必须由部署系统提供：

```text
WANX_PLATFORM_SSO_ENABLED=1
WANX_PLATFORM_DEVICE_ID=<设备证书的不可变 identity ID>
WANX_PLATFORM_ISSUER=nexusaos-platform
WANX_PLATFORM_BOX_KEY_FILE=/run/wanx-platform/box-key.pem
WANX_PLATFORM_PUBLIC_KEY_FILE=/run/wanx-platform/platform-public.pem
WANX_BRIDGE_UPSTREAM_URL=http://127.0.0.1:18088
WANX_BRIDGE_BIND_HOST=<盒子的 P2P IP>
WANX_BRIDGE_PORT=8088
WANX_BRIDGE_CLIPBOARD_URL=http://127.0.0.1:8092
WANX_BRIDGE_OIDC_HOST=127.0.0.1
WANX_BRIDGE_OIDC_PORT=18089
WANX_BRIDGE_STATE_DIR=/data/wanx-bridge
WANX_BRIDGE_ADMIN_CREDENTIAL_FILE=/data/.octop/credential.json
```

Octop 本身使用 `OCTOP_BIND_HOST=127.0.0.1`、`OCTOP_PORT=18088`。仅公开 bridge 的端口，OIDC listener 必须保持 loopback。进程初始化成功前公开健康检查不能报告 `ok=true`；任一必要进程意外退出时，监督入口停止另一方。

`/api/clipboard/v1` 是独立便签业务的部署转发，目标仅允许回环 HTTP 地址（默认 8092，空配置禁用）。它复用平台租约，不转给原始核心；业务服务以同一租约回调当前 bridge 的既有用户和空间接口，因此每次存储操作仍检查权限。业务服务需要单独启动，且上游应指向该 bridge 实际绑定的地址，不能绕过 bridge 直接使用原始核心端口。独立业务故障不影响其他路由，客户端按可重试错误保存草稿。此路由不提供 WebSocket，不把上游 JWT 或 cookie 返回客户端。

盒端 Ed25519 公钥须已通过真实设备证书证明登记；平台公钥须通过可信渠道分发。私钥只读挂载并由服务 UID 可读。原生管理凭据文件格式是 `{"username":"…","password":"…"}`，POSIX 上必须属于当前运行 UID 且权限 `0600`。bridge 只用其调用登录与管理 API，凭据不会返回给客户端。已有数据但缺少有效凭据时停止初始化，不自动重置账号。

独立状态目录必须持久化且仅服务用户可访问，包含 challenge/租约状态及 OIDC 身份材料；不要当作临时缓存删除。无需挂载 Octop 数据库给独立 bridge 进程。

## 部署兼容条件

- 原生 Octop 已配置其他 OIDC issuer/client 时拒绝启动配置，错误码 `BOX_UPSTREAM_OIDC_CONFLICT`；不会覆盖企业登录配置。
- 管理登录仅支持当前原生 `slider` 配置。启用强验证码时返回 `BOX_UPSTREAM_CAPTCHA_REQUIRED`，不会自动降低验证码要求。
- 私有端口 `18088`、`18089` 必须空闲，公开端口不能与其冲突。
- 同机 Zhijun 使用内部 Octop 地址；OS 自动调整默认 upstream，显式配置需自行核对。
- 关闭盒端 `platform_sso` 恢复原始单进程，但持久化 OIDC 配置仍保留。需要隐藏该登录入口时，由管理员通过原生管理界面/API 停用 provider。不会自动删除原生账号或 bridge 状态。
- 客户端关闭 P2P 是独立操作，不会改动盒端 OIDC 配置，本机/Web 开发不需要启动 bridge。

## 独立 Semantica 原生接口

`wanx_bridge/semantica/` 注册独立部署的 Semantica standalone HTTP 接口。Bridge 不导入
Semantica 或 Octop 的内部模块，不读取两者的业务数据库，也不修改 Octop 代码。

```text
/api/semantica/native/settings/status  -> Semantica /api/settings/status
/api/semantica/native/documents        -> Semantica /api/documents
/api/semantica/native/skills           -> Semantica /api/skills
/api/semantica/native/reasoning/prepare -> Semantica /api/reasoning/prepare
```

上游默认是 `http://127.0.0.1:8090`，使用 `WANX_BRIDGE_SEMANTICA_URL` 指定独立容器或主机的
HTTP(S) origin，例如 `http://semantica:8090`。地址不能包含用户名、密码、路径或查询参数；
请求不能选择上游。没有新增启用开关。Semantica 继续使用 standalone 模式，并按其原有规则
配置监听地址与 `APP_PUBLIC_URL`。本次注册不启动、安装或修改 Semantica。

原生接口是实例级工作台，不能假定它已经按万象账号隔离。入口要求有效 bridge 会话，且每次
请求通过 Octop 的公共 `GET /api/auth/me` 确认当前身份是允许的应用身份下的管理员；普通成员
不能通过原生入口读取其他工作空间或修改实例模型设置。保留 Semantica 自身的材料保护、
版本检查和删除确认逻辑。它不是面向普通成员的按仓授权适配层。

支持 `health`、`settings`、`jobs`、`documents`、`ontologies`、`knowledge`、`search`、`graph`、
`evidence`、`sensitive`、`skills` 和 `reasoning` 原生 API 路径。请求方法、查询参数、JSON、
multipart 和文件响应保持原生契约，上传下载使用流式转发。bridge/Octop 凭据、Cookie、
Referer 及调用方提供的集成和管理授权头不会传给 Semantica；会话失效或客户端断开会取消
进行中的转发，包括等待上游响应头的请求。上游重定向仅允许已注册的原生 API 路径，
并改写回此入口；拒绝路径穿越、其他命名空间及外部地址。原生 WebSocket
未注册，`integration`、`open/v1` 等其他命名空间不通过此入口转发。

## STARLINK 桌面适配与模型回调

STARLINK 页面开发请先阅读 [前端开发接入指引](docs/starlink-frontend-guide.md)，其中包含全部 47 个
service 动作、参数与返回、上传下载、模型/Skill/推理交互、错误处理及真实链路验收清单。

桌面 URL 保持不变，由 `semantica/desktop_routes.py` 和 `desktop.py` 接管，直接调用独立
Semantica 已有的集成接口。`native` 注册在桌面适配之前，继续作为管理员原生入口。
未知路径拒绝访问，缺少万象设备身份或已有配置损坏时返回 503，不回退到旧 Octop Semantica 路由。

| 万象入口（省略 `/api/semantica`） | Semantica 目标 | 上下文 |
|---|---|---|
| `/status`、`/capabilities`、`/warehouses/*` 管理接口、`/processing*` | `/api/integration` + 原路径 | 当前用户的个人 scope；仓管理由服务验证 owner |
| `/warehouses/{id}/documents` 等按仓接口 | `/api/integration/documents` 等去掉仓前缀后的路径 | bridge 按旧 UUIDv5 算法派生仓 workspace |
| `/documents` 等无仓前缀形式 | `/api/integration` + 原路径 | 默认个人 workspace |
| `/open/v1/*` | `/api/open/v1/*` | 当前万象会话 + `X-Xingtu-Key` 转 Bearer Key |
| `/native/*` | `/api/*` | 当前万象管理员；保持原生契约 |

桌面适配覆盖材料、任务、本人图谱、检索、保护设置、分块导入、数据仓、Key、迁移、
按仓模型、Skill 和八种推理操作。它复用 Semantica 的业务接口和持久操作账本，不在 bridge
复制这些业务。HTTP 成功仍返回业务对象；错误规范化为顶层 `{code,message}`。
分块 PATCH 的 `operation_id` 放在请求上下文，按服务契约从 body 删除；其余写操作保留
稳定操作 ID、版本和确认字段。支持 4 MiB Skill ZIP 的 base64 请求与 8 MiB ZIP 的 JSON 下载。

用户登录与权限决策统一归万象。每次桌面请求检查当前用户及 `knowledge_bases` 权限
（管理员可用），返回前再次核对；bridge 会话过期和断开会取消正在等待的上游请求。
普通用户不能通过 bridge 选择任意 workspace 或透传身份头。bridge 根据已验证会话生成
`X-Semantica-Scope`，传递用户、仓、读写许可及幂等 ID。standalone 不校验服务 Bearer 或 HMAC，
不比对 Semantica `.env` 中的 box/application；缺少或无效上下文返回 400，不回退到共享默认仓。
因此 `/api/integration/*` 必须只对可信万象后端可达；上下文自身不构成身份认证。
开放 Key 的范围和撤销仍由 Semantica 执行，不能因万象已经登录就跳过。

新部署无需额外创建 `semantica.json`：bridge 复用已配置的万象 device ID，使用固定的
`semantica` 应用命名空间和当前用户 ID 构造上下文，上游默认 `http://127.0.0.1:8090`。
不需要向 Semantica 同步服务密钥、box ID 或 application ID，也没有新增启用开关。

已有部署继续读取 `WANX_BRIDGE_ADMIN_CREDENTIAL_FILE` **同目录**的 `semantica.json`，
默认 `/data/.octop/semantica.json`，保留原数据身份。不读取 Octop 数据库或 JWT 密钥。
standalone 的旧身份配置可不含服务密钥：

```json
{
  "service_url": "http://127.0.0.1:8090",
  "box_id": "<保留原有 box_id>",
  "application_id": "<保留原有 application_id>"
}
```

部署时限制此文件仅服务用户可读。已有数据必须沿用原有 box/application 标识及用户 ID，
否则会派生另一套 workspace。`WANX_BRIDGE_SEMANTICA_URL` 若显式设置，会覆盖桌面配置的
service_url，同时作为 native 的上游；未设置时 native 默认 8090，桌面采用配置文件地址。
不同容器部署须显式配置同一个目标。不要删除承载旧数据身份的配置文件。
若旧文件仍有有效 `service_token`，bridge 保留签名输出以兼容显式 managed 部署；
standalone 会忽略签名，不要求密钥与本地配置一致。已有配置损坏时不会改用新身份。

`semantica/model_relay.py` 在 bridge **私有 loopback listener**（默认 18089）注册
`POST /internal/starklink/models`，不开放到公开 listener。standalone 使用
`x-starklink-time/nonce`，不发送签名；bridge 只接受回环来源且拒绝浏览器 Origin，
不以调用方提供的转发头证明来源。携带签名的旧 managed 请求仍执行原有验证。
提供 `catalog/check/infer`：

- 只通过万象公共 HTTP API 读取用户、Provider 和模型目录，不导入 Octop 内部模型运行时。
- 当前支持 OpenAI Chat Completions 兼容接口与 Ollama；其他 Provider 协议显示不可用。
  模型仍须通过合成文本检查，目录不向 Semantica 返回 Provider 凭据。
- 推理调用前、执行中及返回前检查用户权限、模型 revision 和任务授权。
  内部调用 Semantica `/api/integration/processing/authorize` 必须明确返回 `authorized: true`。
  此授权接口不在桌面允许列表中；任务撤销和配置变化会取消模型请求。
- 重放记录持久化；并发上限为全局 4、每用户 2、总排队与执行请求 32。
  JSON Schema 校验禁止远程引用；工具调用或不符合 schema 的结果不会交付。
- 用量记录保存在 bridge 状态目录的 `semantica-models.sqlite3`，只记录归属及 token 计数，
  不保存正文、模型结果或密钥；没有写入 Octop 的用量表，当前不会出现在其用量面板。

独立 Semantica 的 `WANX_MODEL_URL` 默认已对齐 `http://127.0.0.1:18089`；已有显式配置仍须核对实际私有端口。
其现有配置仅接受同设备 loopback，分容器时须共享可达的网络命名空间；这里没有放宽此约束。
模型 revision 来自公共 API 可见配置，与旧内部模块算法不同，迁移后需重新检查并保存模型。
长桌面请求使用 285 秒截止与 300 秒上下文有效期；搜索为 85 秒，其余为 45 秒，均短于 STARLINK
外层的 330/90/60 秒。上下文有效期检查在两种模式均保留。

**尚未完成真实部署的端到端验收**：Semantica 源码已修复 standalone 集成 scope 建立，
并启动真实处理能力监测；原生接口及 standalone MCP 保持原有访问方式。
这不要求启用 managed 或另建用户权限系统。修改经离线契约和隔离实例验证，
运行服务仍需重启、核对服务地址并部署 bridge；没有修改 Octop。

### 与运行中 Semantica 的契约核对（2026-10-19）

目标为 `http://127.0.0.1:8090`，版本 `0.12.0-i11`。读取实际 `/openapi.json` 后，
对照了 **73 个方法/操作组合**（两个推理动态路由各展开八种 operation），并核对源码中的
签名、workspace 绑定、standalone 中间件和模型回调。结果区分如下：

| 检查项 | 结果与边界 |
|---|---|
| 方法、路径、查询参数 | 73 项映射通过；修复了 bridge `/open/v1/warehouse` 错误允许 `limit/offset` 的问题 |
| 请求体 | 依据实际 OpenAPI 生成样例，经 bridge 转换后验证 schema；含分块 PATCH、仓管理、模型、Skill、推理外层及八种 arguments schema；不代表业务写入已执行 |
| 返回 | 已声明的响应 schema 样例保持原样；源码核对业务对象和顶层/嵌套错误。多数集成路由没有细粒度 response_model，因此不把 OpenAPI 通过等同于完整业务返回验证 |
| 服务上下文和 workspace | 2026-10-20 更新：standalone 使用无签名头、空服务凭据建立 scope；managed 保留 authenticate 验证。资源绑定及 operation_id 检查均通过；使用合成配置离线执行 |
| 模型回调 | 执行 Semantica 实际 relay 序列化逻辑，核对 catalog/check/infer 的路径、owner、payload、返回对象；standalone 不携带签名，managed HMAC 保持兼容；未调用真实模型 |
| 运行服务 | live、ready、原生 settings/status 均为 200；settings 确认 integration_mode=standalone |
| 桌面初始化链路 | 初次运行服务核对返回 401。2026-10-20 按新要求取消 standalone 验签，源码及隔离实例通过无共享凭据回归；最新代码仍需重启部署后做真实链路验证 |

Semantica 修复与剩余部署事项：

1. 已在 **standalone 保持原生 API 可用**的前提下，为 `/api/integration/*` 接收、校验万象可信上下文，
   设置并清理 `request_scope` / `request_auth_headers`，保留资源归属、写权限、operation_id、
   过期检查和请求体限制。standalone 无服务鉴权，身份可信性由万象及部署网络边界保证；
   不接收缺少上下文的请求，也不取消资源归属检查。
2. `processing_readiness` 已在两种模式启动，按实际依赖和 worker 状态提供能力。
   本地 embedding 仍需符合模型清单；远程 embedding 不据此宣称就绪，模型配置完整不等于推理已验证。
   `/api/health/ready=200` 与此业务能力不是同一含义。
3. `WANX_MODEL_URL` 源码默认已由 **8089** 调整为 **18089**，与 bridge 默认私有 listener 一致。
   运行实例实际环境值未读取或改写；显式配置优先，同设备 loopback 约束仍存在，更新需重启生效。
   standalone 不再同步两端 box/application/service token；身份仅由 bridge 提供。
   已有数据沿用 bridge 原有配置中的身份，不自动重命名；managed 保留原配置要求。

Semantica 的单次小文件上传、替换全文、单材料删除、跨 workspace 检索四个集成入口，不在当前
STARLINK 桌面消费范围，未额外开放。`/processing/authorize` 则仅由 bridge 私有模型回调调用。
本轮没有对运行实例执行上传、建仓、清仓、删除、修改配置或模型调用。

可重复核对（在 `wanx-bridge` 目录执行，输出文件放任意可写临时目录）：

```powershell
curl.exe --noproxy "*" -fsS -o <临时目录>/openapi.json http://127.0.0.1:8090/openapi.json
uv run --python 3.12 python tests/contracts/semantica_contract.py --openapi <临时目录>/openapi.json --source D:/项目文件/semantica --url http://127.0.0.1:8090 --output <临时目录>/report.json
```

省略 `--url` 可完全离线执行。脚本退出 0 表示映射/schema 检查通过，**不表示** standalone
阻塞已消失；需同时查看报告中的 `auth.standalone_establishes_scope` 和只读 HTTP 状态。

### STARLINK 桌面契约核对（2026-10-19）

核对对象是 STARLINK
`desktop/shell/service.mjs`、`desktop/ui/app.js`、`desktop/ui/native-skills.js`，以及独立
Semantica 的 `app/api/{routes,integration,warehouses,processing,skills,reasoning,managed_reasoning}.py`。
范围为当前 Electron 的全部 47 个 service 动作，另列 Host/IPC 和开放接口，不把未被桌面调用
的后端接口算成桌面依赖。下表保留原生 API 对比，解释为何桌面适配选择集成接口；
“原生缺口”不等于 Semantica 没有集成实现。实际 bridge 映射以上节为准，代码尚未部署。

**约定**：桌面路径均省略 `/api/semantica`；`W=/warehouses/{warehouse_id}`；`S` 表示 `W`
或空前缀（service 保留未选仓调用形式，Skill/推理强制选仓）。上游列写 Semantica 原始路径；
调用新入口时 `/api/...` 对应 `/api/semantica/native/...`。`op` 为稳定 `operation_id`，
不是每次重试重新生成的 ID。所有写操作的版本、确认令牌、幂等和按仓授权语义必须保留。

#### 初始化、材料和任务

| 桌面动作 / 方法与路径 | 请求参数 | 桌面需要的返回 | standalone 对应及差异 |
|---|---|---|---|
| initialize → GET `/status` | 无 | 状态对象直接返回 | GET `/api/settings/status`；可改路径 |
| initialize → GET `/capabilities` | 无 | `accepted_suffixes`, `document_max_bytes`；完整集成响应还声明处理能力 | 无同名原生接口；可由 settings 的 `document_formats` 补点号构造后缀，但能力列表与就绪状态不能伪造 |
| initialize / warehouses → GET `/warehouses` | 无 | `{items:[仓信息]}` | 仅 `/api/integration/warehouses`，standalone 原生缺口 |
| initialize / runtime → GET `/warehouses/runtime` | 无 | `local_only`, `model`, `embedding`, `api_base_url`, `host_api_prefix`；另有迁移限制 | 仅 integration；部分设备配置可从 settings 读取，但仓与迁移能力不能凭空声明 |
| documents → GET `S/documents` | `limit=100`, `offset` | `{items,total}`；重处理依赖 `items[].active_version_id` | GET `/api/documents?workspace_id=…`；原生 `public_document()` 隐藏 `active_version_id`，集成列表会补回；不能直接透传完成重处理 |
| document / download 首步 → GET `S/documents/{id}` | 列表查看使用 `segment_offset`, `segment_limit=100`；下载首步无分页参数 | `{document,version,segments,blocks,block_count,processing}`；下载读取 `document.original_name` | GET `/api/documents/{id}`；须校验资源属于当前仓；原生无集成的 `segment_next_offset` 与逐文档 `processing.sensitive_status`，且没有集成层 256 KiB 文本截断 |
| jobs → GET `S/jobs` | `limit=100`, `offset` | `{items,total,limit,offset,activity}` | GET `/api/jobs?workspace_id=…`；查询参数转换，字段结构相近 |
| graph → GET `S/owner/graph` | `limit=120` | `{nodes,edges}`，关系包含 `evidence[]` | **无等价原生入口**；GET `/api/graph/neighborhood` 执行交付保护，而 owner 图是本人原始视图，不能直接替换 |
| retrieval → GET `S/retrieval/status` | 无 | 原样索引状态对象 | GET `/api/search/indexes?workspace_id=…`；可转换路径 |
| search → POST `S/search` | `{query,document_ids,entity_types,limit:10}` | 命中 `items`、证据及 `graph` 等原样字段 | POST `/api/search` 加服务端绑定的 `workspace_id`；原生 `delivery_mode` 为 `policy/confirm`，不能照搬旧集成层的 `masked`；需验证交付保护等价性 |
| sensitive → GET `S/sensitive/settings` | 无 | 保护设置对象，含 `enabled`, `semantic_enabled`, `revision`, `rules` | GET `/api/sensitive/settings?workspace_id=…`；可转换查询 |
| save-sensitive → PUT `S/sensitive/settings` | `{op,payload:{expected_revision,enabled,semantic_enabled,rules,…}}` | 更新后的保护设置 | POST `/api/sensitive/settings`，展开 `payload` 并绑定 workspace；不能丢弃 `op` 的持久幂等语义 |
| correct → POST `S/documents/{id}/correction` | `{op,payload:{base_version_id,segments:[{id,text}]}}` | 更正结果；UI 随后重新取详情 | PATCH `/api/documents/{id}/content`，展开 payload；须保留版本冲突及操作重放语义 |
| retry-job → POST `S/jobs/{id}/retry` | `{op}` | job 对象 | POST `/api/jobs/{id}/retry` 无 body；原生没有等价的控制操作幂等记录 |
| build-index → POST `S/retrieval/indexes` | `{op}` | `{index,job,reused}` | POST `/api/search/indexes` body `{workspace_id}`；原生任务去重不等于按 `op` 重放 |

initialize 并发依赖四个请求；任何一个失败都会使初始化失败。不能仅接通 `/status` 就报告
桌面可用。`active_version_id` 缺失会使“重新处理”过滤掉材料，即使材料列表看起来正常。

#### 材料分块上传和原件下载

| 动作阶段 / 方法与路径 | 请求参数 | 桌面需要的返回 | standalone 对应及差异 |
|---|---|---|---|
| upload 开始 → POST `S/imports` | `{op,external_document_id,filename,size_bytes,sha256}` | `{upload_handle,offset}` 或 `received_bytes`；已提交可直接返回 `document` | 原生只有 POST `/api/documents` multipart `file,workspace_id`；缺少持久分块、续传、外部 ID 和操作账本 |
| upload 分块 → PATCH `S/imports/{handle}` | `{op,offset,content_base64}`，解码后每块 ≤1 MiB | 成功 JSON；当前桌面自行累加 offset | 原生无入口；旧集成 client 会把 `op` 移到签名上下文，从 JSON 删除；不能原样发送给 `AppendImportInput` |
| upload 提交 → POST `S/imports/{handle}/commit` | `{op}` | `{document,job,reused}` | 需暂存/摘要校验后提交 multipart；不得把“已收到”当成“已提交” |
| upload 提交结果不确定 → GET `S/operations/{op}` | 无 | `{status:"committed",result:{document,…}}` 或顶层 `document` | 原生无对账入口；不能自动重复创建材料 |
| download → GET `S/documents/{id}/blob` | `offset,length=1048576`；后续块携带 `expected_origin_revision,expected_sha256` | `{content_base64,offset,length,total_bytes,origin_revision,sha256,…}` | 原生 GET `/api/documents/{id}/original` 返回二进制；需安全范围读取、base64 包装、整件摘要与版本一致性校验，不能用单块摘要代替原件摘要 |

桌面材料下载最大 1 GiB，最终按整件 SHA-256 校验后才替换目标文件。原生响应中的
`original_url`、`preview_url` 仍指向 `/api/documents/...`，将来暴露给桌面时须改写或过滤，
避免落到 Octop 的同名路径。现桌面下载使用 `/blob`，并不直接使用这些 URL。

#### 数据仓、Key 与迁移

此组对应 `app/api/warehouses.py` 的 `/api/integration/warehouses...`。源码中功能存在，
但 **standalone 原生 HTTP 没有这些等价入口**。不能把 warehouse ID 直接当 workspace ID，
也不能以一个虚构默认仓代替真实账号所有权、仓状态、确认和撤权。

| 桌面动作 / 方法与路径 | 请求参数 | 桌面需要的返回 |
|---|---|---|
| create-warehouse → POST `/warehouses` | `{op,name,description}` | 新仓对象（含 `id`） |
| warehouse → GET `W` | 无 | 仓信息/统计，含名称、状态、材料/实体/关系计数 |
| keys → GET `W/keys` | 无 | `{items:[凭证元数据]}`，不含历史 token 明文 |
| create-key → POST `W/keys` | `{op,name,days,scopes}` | `{token,key}`，token 仅创建时返回 |
| revoke-key → POST `W/keys/{id}/revoke` | `{op}` | 撤销结果 JSON |
| prepare-clear → POST `W/clear/prepare` | `{op}` | `{confirmation_token,warehouse,…}`，warehouse 含待清空计数 |
| clear-warehouse → POST `W/clear` | `{op,confirmation_token,typed_name}` | 清空结果；联动原件、索引、Skill、推理准备和 Key |
| prepare-delete → POST `W/delete/prepare` | `{op}` | 独立删除确认令牌及仓统计 |
| delete-warehouse → POST `W/delete` | `{op,confirmation_token,typed_name}` | 删除结果；成功后桌面清除该仓文件选择 |
| export-warehouse → POST `W/exports` | `{op}` | transfer 对象（`id,kind,state` 等） |
| transfers → GET `/warehouses/transfers` | 无 | `{items:[transfer]}` |
| transfer / save-migration 首步 → GET `/warehouses/transfers/{id}` | 无 | `kind,state,size_bytes,sha256,result.filename`；迁入结果还含仓信息 |
| save-migration → GET `/warehouses/transfers/{id}/blob` | `offset,length≤1048576` | `{content_base64,offset,length,total_bytes,sha256}` |
| import-migration 开始 → POST `/warehouses/imports` | 同材料 begin；文件 `.xingtu` / `.zip` | `{upload_handle,offset}` 或 `received_bytes` |
| import-migration 分块 → PATCH `/warehouses/imports/{handle}` | `{op,offset,content_base64}` | 成功 JSON；上游集成 body 同样要去掉 op |
| import-migration 提交 → POST `/warehouses/imports/{handle}/commit` | `{op}` | transfer 对象；不能套用材料 `{document,job}` |

STARLINK 现在默认发送全部五项 scopes：`documents,evidence,graph,reasoning,search`；显式
子集仍保留。Semantica 当前 `CreateKey` 也默认五项，先前“缺省 scopes 不兼容”的差异已经消失。
迁移包最大 2 GiB，下载时校验整包摘要；迁入提交失败不会使用材料 `/operations` 做对账。

#### 模型、Skill 与推理

| 桌面动作 / 方法与路径 | 请求参数 | 桌面需要的返回 | standalone 对应及差异 |
|---|---|---|---|
| processing → GET `/processing` | 可选 `warehouse_id`；默认配置不传 | `effective,stages,revision,inherit,affected_warehouses` | 仅 `/api/integration/processing`；`/api/settings/llm` 是实例配置，不能等同按仓继承、模型快照 |
| model-catalog → GET `/processing/catalog` | 无 | `{items:[模型 id/revision/location/available 等]}` | 万象模型目录能力；无原生等价入口 |
| check-models → POST `/processing/check` | `{op,warehouse_id,extraction,cloud_confirmations,…}` | `check_id` 等检查结果 | 仅 integration；不能用单次 LLM 连通性测试替代模型授权/版本检查 |
| save-models → PUT `/processing` | `{op,warehouse_id,expected_revision,inherit,check_id}`；默认仓为 null | 更新结果 | 仅 integration；保留检查记录及配置版本 |
| reprocess-models → POST `/processing/reprocess` | `{op,warehouse_id,documents:[{id,version_id}],expected_signature}` | `{job_ids}` | 仅 integration；逐文档原生抽取不包含等价的批量签名检查和模型快照 |
| skills → GET `W/skills` | `limit=20,offset,keyword` | `{items,total,…}`；item 含 `id,title,description,default_version` | GET `/api/skills?workspace_id=…`；结构相近，须建立按仓映射 |
| skill → GET `W/skills/{id}` | `path` 默认 `SKILL.md` | `{skill,version,files,file:{path,text,…},…}` | 组合 GET `/api/skills/{id}/package` 与 `/package/file`；不能使用普通 skill detail 代替包详情；两次读需固定同一版本 |
| import-skill → POST `W/skills/import` | `{op,content_base64}`；ZIP ≤4 MiB | `skill.id` 及包导入结果 | POST `/api/skills/import-zip` multipart `file,workspace_id`；注意 `/api/skills/import` 实际是 Markdown 导入；需保留操作幂等 |
| download-skill → GET `W/skills/{id}/download` | 无 | `{filename,content_base64,sha256}`；桌面 ≤8 MiB 且校验摘要 | GET `/api/skills/{id}/package/download` 返回 ZIP；需封装 JSON 与摘要 |
| delete-skill → POST `W/skills/{id}/delete` | `{op,expected_revision,expected_draft_revision,typed_name,confirm,invalidate_dependents}` | 删除结果 | DELETE `/api/skills/{id}` 使用 query；原生不校验 `typed_name`，不能转换时默默丢掉名称确认与 op |
| reasoning → POST `W/reasoning/{operation}` | `{op,arguments:{…}}`；8 个 operation 见下 | 各操作结果直接返回 | 原生 body 为展开的 arguments 加绑定 workspace；有路径和主体身份差异 |

推理逐项路径：`discover→/api/reasoning/discover`、`prepare→/api/reasoning/prepare`、
`reference→/api/reasoning/reference`、`scope→/api/reasoning/scope`、
`search→/api/reasoning/search`、`evidence→/api/reasoning/evidence`、
`read-document→/api/reasoning/documents/read`、`coverage→/api/reasoning/coverage`。
prepare 使用 `skill_id,idempotency_key,document_ids,detect,delivery_mode`；后续操作携带
`preparation_id`，reference 增加 `skill_id,reference_id`，search 增加 `query,limit`，
evidence 增加 `evidence_id`，read-document 增加 `document_id`。
结果中的 `preparation_id,preparation_status,fully_executable,next_action,content.references`
和检测/交付状态须保留，不能统一包装成另一种结果。只有模型 check/save 与 reasoning 设置
330 秒 timeout；search 为 90 秒，其余 service 请求默认 60 秒，reprocess 仍是 60 秒。

集成推理使用账号绑定的 principal、选定模型及检测任务记录；原生推理使用自身 principal
和模型路径。这是接口契约差异，不代表独立部署必须使用 managed 模式。
展开 arguments 只能解决请求形状，不能证明准备记录隔离、`detect`、清仓失效
及模型用量等语义一致。不要修改 `unverified/failed` 为“安全”或“已完成”。

#### 错误格式、权限与其他系统来源

桌面 HTTP 成功返回**业务对象本身**，不是 `{data:…}` 或 `{ok:true,value:…}`。后者是
`main.mjs` 与 preload 的 Electron IPC 包装，不属于 HTTP 契约。201/202 同样可接受，
但成功响应必须能解析为 JSON，不能用 204 空响应或二进制替代。HTTP 错误应为顶层
`{code,message}`；桌面只保留 `SEMANTICA/WAREHOUSE/MIGRATION/ACCESS_KEY/MODEL/SKILL/REASONING`
前缀的码，后六类允许 ≤200 字符的公开 message。原生 `{detail:{code,message}}` 不被识别，
现在由桌面适配层解包、筛选；不会将未经检查的上游 detail 全部暴露。

服务鉴权失败应转换为 `503 SEMANTICA_SERVICE_AUTH_FAILED`，开放 Key 的 401 转为
`403 ACCESS_KEY_INVALID`，避免 Host 将其当成万象会话过期；真正 bridge 会话过期仍是 401。
native 当前保持原生错误及状态码，因此不会被本次契约测试误认成桌面兼容接口。

| 其他调用来源 | 当前入口与边界 |
|---|---|
| 账号、盒子与连接状态 | `host.context()` / Host 会话；不由 Semantica 返回 |
| 空间文件 | `host.drive.overview/list/stat/read`；`space-list/select-space-files` 使用此服务，最终导入才进入 Semantica；不能改成 `/api/semantica/space/*` |
| 本地文件选择、保存、仓切换 | Electron 文件对话框和本地 service 状态；`select-files/select-migration/release-files/select-warehouse` 自身不调用 Semantica HTTP |
| 打开模型管理 | `main.mjs` 的 `open-model-management` → 进程 IPC `wanx:open-models`，不是 Semantica API |
| 开放接口 | 文档/工具通过 Host `/api/semantica/open/v1/{warehouse,documents,graph,search,evidence/{id},reasoning/{operation}}`，传 `X-Xingtu-Key`；独立上游 `/api/open/v1/*` 使用 Bearer Key；不属于 service 的 47 个动作，不受 native 入口注册覆盖 |

旧集成客户端按账号/应用/盒子派生 workspace 并签名，仓 ID 与 workspace ID 不保证相同。
native 当前是管理员实例入口，不能把普通桌面成员直接接入，再信任其提交的 workspace。
Semantica 的 `ManagedAuthMiddleware` 在 standalone 集成分支读取 bridge 的上下文并建立
integration 的 `_invoke()` / `warehouses.signed()` 所需 `request_scope`，不再验证服务签名。
原生请求不会自动获得万象上下文；没有更改部署模式。

旧 WANX `src/octop/infra/semantica/client.py` 的允许列表尚未包含
`processing/skills/reasoning` 及 Skill 的 `keyword/path` 查询；旧 router 对 JSON 限制 2 MiB，
而桌面 4 MiB ZIP 编码后的请求可超过 5 MiB。独立 Semantica 附带的集成样例已经扩展，
不代表 WANX 本地 Octop 已同步。新 bridge 桌面适配绕过该旧链路，直接对接独立 Semantica，
包含新增路径及 Skill 请求大小支持；Octop 代码保持不变。

#### 离线验证与剩余接入条件

在 WANX 根目录执行（Node 22；项目路径是命令参数，测试不硬编码本机目录）：

```powershell
node wanx-bridge/tests/contracts/starlink.contract.mjs D:/项目文件/startlink
uv run --python 3.12 --project wanx-bridge pytest -c wanx-bridge/pyproject.toml wanx-bridge/tests/test_semantica_desktop_contract.py wanx-bridge/tests/test_semantica_model_relay.py wanx-bridge/tests/test_semantica_native.py -q
```

该测试直接加载真实 `SemanticaService`，用 mock Host 核对请求路径、方法、完整 JSON、
query、timeout 和返回消费；涵盖 47 动作、8 种推理操作、分块上传/对账、原件/迁移/Skill
下载摘要、五权限 Key 及错误降级。用例输出源码 SHA-256，新增未覆盖的 service case 会使
覆盖检查失败。合成响应只证明消费者契约，不证明 Semantica 业务实现；不启动任何后端。
它不执行 Electron UI、Host 授权或真实网络，不替代后续集成验证。
Python 回归验证桌面路径直达 Semantica integration、万象身份与历史 workspace 派生、
operation_id、开放 Key、错误规范化、大包、会话撤销、权限复查及断开取消；模型回调覆盖
重放、任务明确授权、配置变更、禁用用户、协议和输出校验。模型与服务端均为 mock。

后续接入须重启更新后的 Semantica 与 bridge、核对内部服务及模型回调地址，并完成真实业务验证，
特别是初始化能力、清仓/撤 Key/任务取消联动和模型配置迁移。不可把测试中的合成响应当作
端到端可用证明。当前 Windows 环境缺少 `make`，入口测试另受现有 `resource_cache.py`
导入 POSIX `fcntl` 限制，未通过 `make all` 或完整运行入口测试。

## 专家与技能包资源同步

启用现有 `WANX_RESOURCES_ENABLED=1` 后，Bridge 按配置周期同步签名目录，在应用准备时按需下载完整依赖；不会把整个市场下载到盒子。官方来源的自动检查由 Admin 独立 worker 负责，只创建草稿。

Bridge 主动声明 `resourceProtocol:2`，支持带 `releaseAccess:account` 的签名资源。账号来自已验证的会话，缓存命中仍检查资源准入。`/download` 负责新获取，`/access` 负责已安装实例使用；灰度转正式沿用签名，正式撤回不删除已有实例。受控资源需要当前在线准入，原非受控正式资源保留既有本地回退行为。

已有兼容专家保持原实例并报告可用更新，不自动覆盖记忆或对话。资源灰度应使用新测试绑定验收。受控全局技能包作为 Bridge 内部暂存，不通过原生技能包入口对其他账号开放；资源准备仍通过未修改的 Octop 公共 API 将完整文件复制到客户私有专家。

部署文档位于 Admin 仓库 `docs/operations/resource-upstream-sync.md`。本功能没有修改 Octop 内核；升级需要更新 Bridge，旧 Bridge 继续使用原正式资源。

## 静态资源加速

bridge 从已安装的 `octop` distribution 定位 `dashboard/assets`，不导入或修改上游实现。部署镜像使用非 editable 安装，无需新增环境变量。仅 JS、CSS、字体进入资源清单；HTML、业务 API、用户上传文件不参与缓存。

`GET /api/platform/assets/manifest` 必须携带当前有效的盒子会话，返回资源 SHA-256、大小和清单摘要版本。客户端在建立本地网关时并行获取清单，超时或旧盒子未支持时直接按原流程流式访问，不阻塞页面。清单有效时，客户端按账号、盒子、清单版本、路径和内容摘要隔离持久缓存，命中仍要求本地引导完成且盒子租约有效。

盒端在跨公网前对清单资源按 `Accept-Encoding` 进行 gzip 压缩，并支持 HEAD、ETag/304 和 Vary。客户端保存校验后的解压内容，重开随机端口和临时浏览器会话也能复用静态资源；浏览器账号会话仍然隔离。单资源上限 8 MiB，清单最多 2048 项、256 MiB；客户端磁盘缓存默认 256 MiB 并淘汰最久未使用内容，同时最多捕获 4 个响应。超限、摘要不匹配或目录不可用时回退原始流式代理。

镜像内静态目录按一次部署保持不变；运行时发现文件内容改变时，当前请求回退代理并使清单失效。正式升级仍应重新部署镜像，不依赖原地修改文件。只有客户端和盒端 bridge 都更新，持久静态缓存才能生效；单独升级盒端也可改善首次 gzip 传输。

## 验证

从 WANX 仓库根目录运行：

```sh
npm run test:bridge
# 等价命令；使用根环境中的 Octop 验证公共接口合同
uv run pytest -c wanx-bridge/pyproject.toml wanx-bridge/tests -q
```

测试包含签名与重放、租约、流式代理、OIDC 以及 Octop 的真实公共接口合同。`test_upstream.py` 的真实 Octop fixture 使用仓库测试工具；它是测试依赖，不是 standalone 包运行依赖。单独安装 bridge 包并不包含该完整合同测试环境。

应用会话兑换由 Octop 原生路由 `POST /api/auth/application/exchange` 提供，
随 `octop run` 启动注册；不需要额外启动器或运行时包。HTTP bridge 继续通过公共
接口调用，不导入 Octop 内部模块。兑换要求真实 WANX 登录及当前产品授权，
应用会话保持同一用户，且有效期不超过父会话。根目录验证：

```sh
uv run --no-sync pytest tests/unit/api/test_application_exchange.py -q
```

bridge 的真实接口测试也验证原生路由注册、应用授权和撤权。

OS 仓库另运行：

```sh
python3 -m unittest tests.test_wanx_platform tests.test_app_modules tests.test_wanx_bootstrap -q
```

还需真实部署验收入网、盒子目录、打开盒子、授权撤销、持续聊天和两个内部端口的外部不可达。当前文档不表示新镜像已上线。完整平台准备、公钥登记及验收步骤见[部署与联调](../docs/wanx-auto-p2p-deployment.md)。
