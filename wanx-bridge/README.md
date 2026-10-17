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
WANX_BRIDGE_OIDC_HOST=127.0.0.1
WANX_BRIDGE_OIDC_PORT=18089
WANX_BRIDGE_STATE_DIR=/data/wanx-bridge
WANX_BRIDGE_ADMIN_CREDENTIAL_FILE=/data/.octop/credential.json
```

Octop 本身使用 `OCTOP_BIND_HOST=127.0.0.1`、`OCTOP_PORT=18088`。仅公开 bridge 的端口，OIDC listener 必须保持 loopback。进程初始化成功前公开健康检查不能报告 `ok=true`；任一必要进程意外退出时，监督入口停止另一方。

盒端 Ed25519 公钥须已通过真实设备证书证明登记；平台公钥须通过可信渠道分发。私钥只读挂载并由服务 UID 可读。原生管理凭据文件格式是 `{"username":"…","password":"…"}`，POSIX 上必须属于当前运行 UID 且权限 `0600`。bridge 只用其调用登录与管理 API，凭据不会返回给客户端。已有数据但缺少有效凭据时停止初始化，不自动重置账号。

独立状态目录必须持久化且仅服务用户可访问，包含 challenge/租约状态及 OIDC 身份材料；不要当作临时缓存删除。无需挂载 Octop 数据库给独立 bridge 进程。

## 部署兼容条件

- 原生 Octop 已配置其他 OIDC issuer/client 时拒绝启动配置，错误码 `BOX_UPSTREAM_OIDC_CONFLICT`；不会覆盖企业登录配置。
- 管理登录仅支持当前原生 `slider` 配置。启用强验证码时返回 `BOX_UPSTREAM_CAPTCHA_REQUIRED`，不会自动降低验证码要求。
- 私有端口 `18088`、`18089` 必须空闲，公开端口不能与其冲突。
- 同机 Zhijun 使用内部 Octop 地址；OS 自动调整默认 upstream，显式配置需自行核对。
- 关闭盒端 `platform_sso` 恢复原始单进程，但持久化 OIDC 配置仍保留。需要隐藏该登录入口时，由管理员通过原生管理界面/API 停用 provider。不会自动删除原生账号或 bridge 状态。
- 客户端关闭 P2P 是独立操作，不会改动盒端 OIDC 配置，本机/Web 开发不需要启动 bridge。

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
