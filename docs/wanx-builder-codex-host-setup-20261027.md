HOST CONFIGURATION / INTERNAL HANDOFF

# 万象·开物：Codex 调用与标准主机配置说明

面向主机预装、部署与维护人员。按当前源码和本机运行链路整理，不需要了解前端实现也能完成配置。

核对日期 2026-10-27 · 以 Linux 盒端为部署示例 · macOS 本机链路已核验 · 不含凭据与业务资料

## 先看结论

**把 Codex 装在运行 WANX 后端的那台主机上，并使用运行 WANX 服务的同一个操作系统账号完成 Codex 登录。**\
开物界面将需求交给 WANX 后端；后端启动 Node worker，再启动 Codex 原生 `app-server`。不是在每个用户的客户端上执行 Codex，也不要求安装 Codex 桌面应用。

1.  准备 Python 3.12+、Node.js 22.14+、可用的 Codex CLI，以及包含 Node 依赖的 Builder 服务组件。
2.  在服务账号下配置 Codex 模型、完成登录；后台服务的 PATH 必须找到 `node` 和 `codex`。
3.  让 WANX 挂载 Builder 服务组件，并在管理员自己的 WANX 引擎配置中启用受信的 `codex`。
4.  先做不调用模型的连接检查，再用合成项目跑完 PRD、构建、试用和一次修改，才算这台主机验收完成。

### 这是团队版管理员能力

个人版没有开物入口。普通成员使用已获准的成品应用，不直接发起开物构建。独立“万象·开物”应用仍由 WANX Host 提供当前账号和盒子上下文。

### 三个配置要分开

**Codex 登录与模型**负责 PRD / 编码；**WANX 引擎登记**决定管理员能否选择 Codex；**WANX 模型配置 / 应用主模型**用于 AI 补全、能力探测和成品运行。

## 01 / 当前真实调用架构

1.  团队版 / 独立万象·开物 — 只负责界面、需求输入、资源选择、预览与版本操作；下一步：WANX Host 已登录会话与当前盒子连接
2.  盒端 WANX：/api/app-studio — 管理员校验 · 项目 / PRD / 版本存储 · 能力和资源授权；下一步：Python → 持久 Node worker（JSONL stdin / stdout）
3.  访谈 interview.mjs / 开发 driver.mjs — 不同用户、项目、角色分别隔离，顺序使用自己的 worker；下一步：Unix socket 上的 WebSocket / JSON-RPC
4.  Codex CLI：codex app-server --listen unix://…/server.sock — initialize → thread/start 或 thread/resume → turn/start → 流式事件；下一步：当轮自动注入、受控 MCP 工具
5.  wanx_interview / wanx_task — 资料读取 / PRD 保存 / 源码变更 / 固定编译校验 → WANX 版本与预览

**“ACP 构建器”是已有的配置入口与登记形式，当前 Codex 执行链路已经走原生 app-server。**开物没有在构建时调用 ACP 包的 npx 命令，也不采用每一轮重新运行 `codex exec` 的方式。仓库仍保留 ACP 依赖和兼容定义，它们不等于当前执行路径。

原版 Codex CLI 的“制作过程”终端只读连接同一个开发会话；不是第二个编码 Agent。终端显示失败时，主构建仍可继续。

### 对接代码：启动参数与消息形态

下列内容是实际实现的简化形态，用于团队理解。由开物自动生成，不需要运维手动启动这些内部进程，也不要把节选配置替换成完整安全策略。

``` bash
# shared-server.mjs 的启动形态（省略完整受控覆盖项）
codex app-server --listen unix://<私有临时目录>/server.sock \
  -c 'features={shell_tool=false,unified_exec=false,multi_agent=false}' \
  -c 'web_search="disabled"' \
  -c 'projects={"<本轮受控cwd>"={trust_level="trusted"}}'
```

app-server 通过 WebSocket 帧收发 JSON-RPC 风格消息；当前协议请求不附加 jsonrpc 字段。正常新会话的关键消息如下：

``` jsonl
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"wanx_builder_native","title":"WANX Builder","version":"1.0.0"},"capabilities":{"experimentalApi":true}}}
{"method":"initialized","params":{}}
{"id":2,"method":"thread/start","params":{"cwd":"<任务目录>","approvalPolicy":"never","sandbox":"read-only","config":{"mcp_servers":{"wanx_task":{"command":"<实际Node绝对路径>","args":["<Builder根目录>/codex/tools.mjs"],"env":{"WANX_TASK_PROXY":"http://127.0.0.1:<随机端口>","WANX_TASK_TOKEN":"<临时随机凭据>"}}}}}}
{"id":3,"method":"turn/start","params":{"threadId":"<返回的thread.id>","input":[{"type":"text","text":"<本轮受控任务指令>"}],"effort":"medium"}}
```

流式文本读取 `item/agentMessage/delta`，工具活动读取 `item/started` / `item/completed` 中的 mcpToolCall；`turn/completed` 的 status 必须是 completed 才算模型轮次正常结束。开发成功还要满足开物自己的 validate_app 提交和产物校验。

恢复时先以原 threadId 调用 `thread/read`，使用保存的 cwd / historyMode 兼容恢复，再调用 `thread/resume`；热会话不重复 resume。访谈同理，但注入 wanx_interview，运行 interview-tools.mjs。

app-server 是 OpenAI 提供的集成协议；当前官方仍标为实验性能力，交付应锁定已验收版本并进行升级回归。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)

## 02 / 本次核对到的当前基线

| 项目 | 本机实测 / 当前实现 | 交付要求 |
|----|----|----|
| Codex CLI | `codex-cli 0.162.1`；`/opt/homebrew/bin/codex`，通过 npm 安装的入口 | 可作为本次参考锁定版本；目标主机仍须跑完整验收，不把 Mac 验证等同于 Linux 验证。 |
| Node.js | 本机 `v25.9.0`；Builder package 声明 `>=22.14` | 标准镜像选定并锁定一个符合声明的版本，服务启动路径固定。 |
| Python | Builder 声明 `>=3.12` | 使用 WANX 服务自己的 Python 虚拟环境；只读 PTY 也用该 Python。 |
| Codex 登录 | `codex login status` 返回 `Logged in using ChatGPT` | 客户 / 组织自行提供获准的 Codex 账户或 API 凭据；不预装开发者自己的登录缓存。 |
| Codex 模型 | 本机配置 `model = "gpt-6.1-sol"`；配置文件默认 effort 为 xhigh，但开物访谈和开发 turn 均显式使用 `medium` | 模型沿 Codex 配置 / 默认值。目标账号必须有对应权限；改应用主模型不会改变编码模型。 |
| 本机检查 | `available:true`、`transport:app-server`、`modelCalls:0` | 仅证明进程启动与协议握手，不证明模型额度和真实构建通过。 |

### 本机路径仅供定位，不要原样写进客户镜像

本机服务组件位于 `~/Library/Application Support/wanx-app-studio/service`，由 LaunchAgent 中 `--builder-root` 指向；本机服务账号为 `finewood`。这属于当前机器已有启动包装器的参数，不能直接当作 `octop run` 的通用选项。

已核对运行中的 `native-session.mjs`、`shared-server.mjs`、`driver.mjs`、`interview.mjs`、`codex_config.py` 与开发源码一致。运行服务包的 package 元数据仍写 0.5.0，开发包为 1.0.1，部分 Python 文件也有差异；本说明只按核对过的调用逻辑描述。标准镜像必须使用同一交付版本的后端、Builder 服务组件和客户端，并记录文件清单 / 校验值，不能只看 UI 版本号。

## 03 / 安装、运行账号与 Codex 登录

### 3.1 确定唯一的服务账号

以下以 Linux 用户 `wanx-runner`、仓库目录 `/opt/wanx/current`、WANX 数据目录 `/var/lib/wanx` 为示例。路径可按镜像规范替换。该用户需要真实、可写的 home，能读 Builder 服务组件，并能写 WANX 数据和临时目录。

``` bash
# 以下命令必须在运行 WANX 的同一个操作系统账号下检查
id -un
command -v node
node --version
command -v codex
codex --version
codex login status
```

**不要只在 root 或运维自己的账号下登录。**WANX 用户隔离项目，但当前 Codex 凭据来自主机服务账号；同一服务账号下的构建会使用它的 Codex 账户和额度，并非每个 WANX 管理员自动使用各自的 ChatGPT 订阅。

### 3.2 安装 Codex CLI 与 Builder 依赖

``` bash
# 使用镜像选定的 Node/npm，在服务可访问的安装前缀下安装
# 0.162.1 是本机本次核对版本；变更版本需要重新验收
npm install -g @openai/codex@0.162.1
codex --version

# 已准备好 WANX 源码部署环境时
cd /opt/wanx/current
uv sync --frozen
npm --prefix wanx-studio ci
```

如 npm 全局目录不在后台服务 PATH，安装成功也会报找不到 Codex。Builder 服务需要 `ws`、`esbuild` 等依赖；按锁文件完整安装。当前 esbuild 在开发依赖中，不能只执行 `npm ci --omit=dev` 后就认为服务可编译。

客户端的开物应用包提供界面和 Host 桥，**不替代盒端 Builder 服务目录**。后端需要 `backend/`、`codex/`、`core/`、`tools/`、关联的 `dsh/` 帮助模块和对应 Node 依赖；建议分发同版本完整服务组件。

### 3.3 Codex 配置文件与登录

当前开物代码读取实际服务账号的 `~/.codex/config.toml`。以下是相关配置片段，不要覆盖已有完整配置：

``` toml
# /home/wanx-runner/.codex/config.toml
# 使用目标账户可用、已验收的模型。本机参考值如下。
model = "gpt-6.1-sol"

# 适用于没有可用系统钥匙串的 Linux 常驻服务；按组织要求选用。
cli_auth_credentials_store = "file"
```

在服务账号的登录环境中，选择一种认证方式。下面是官方支持的 CLI 登录方式：[OpenAI 认证说明](https://learn.chatgpt.com/docs/auth)。

``` bash
# 有浏览器的主机
codex login

# 无头 Linux 主机：需账户/组织允许设备码登录
codex login --device-auth

# 或使用组织提供的 API Key，经该次登录 shell 的安全环境注入
# 只把 Key 通过 stdin 交给登录命令；不写进本说明或启动参数
printenv OPENAI_API_KEY | codex login --with-api-key

# 最后检查缓存的认证方式
codex login status
```

**当前不能只在 systemd / shell 中 export OPENAI_API_KEY、CODEX_HOME 或代理变量，然后就认为 Builder 会继承。**worker 只保留 PATH、LANG、TMPDIR 等明确允许的启动上下文；Codex 子进程不会自动继承任意环境。部署优先在实际服务账号默认 home 下完成持久登录。自定义 provider 依赖的 env_key、HTTPS_PROXY / HTTP_PROXY、额外 CA 环境变量同样不能假设会透传。

文件存储模式的登录缓存位于该用户 `~/.codex/auth.json`，应限制文件权限、排除出源码和公共镜像。macOS 若使用系统钥匙串，需要对应用户会话可访问；不要把“终端能读取钥匙串”当作“所有后台服务都能读取”。

### 3.4 平台与网络

- **推荐盒端：Linux；本机已核验：macOS。**实现依赖 Unix socket；只读 CLI 终端还依赖 Python 的 pty / fcntl / termios。Windows 原生盒端不在这份配置说明的已验收范围。
- Windows 客户端连接 Linux 盒子时，Codex 安装在 Linux 盒子。若采用 WSL2，WANX、Builder、Node 和 Codex 必须在同一个 Linux 环境、同一服务账号中运行，不能只在 WSL 安装 Codex，却让 Windows 服务去寻找它。
- 盒端要能访问 Codex 认证与所选模型服务。联网、DNS、系统时间和 TLS 信任应在服务环境中有效；不能只验证交互式终端代理。客户端本身联网不能替代盒端出网。
- Codex app-server 仅使用内部 Unix socket；不需要给每个用户手工启动一个公开 TCP 服务，也不需要把这个 socket 暴露到公网。

## 04 / 将 Builder 挂载到现有 WANX

WANX 从仓库运行时会尝试定位仓库根目录的 `wanx-studio/`。wheel / 独立服务组件部署可显式设置 `WANX_STUDIO_ROOT`，并保证 Python 能导入对应 `wanx_studio`。组件随现有 WANX 服务运行，不另外启动第二套账号和数据服务。

``` ini
# Linux systemd 服务片段；替换为镜像的实际路径
[Service]
User=wanx-runner
WorkingDirectory=/opt/wanx/current
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
Environment="LANG=C.UTF-8"
Environment="TMPDIR=/tmp"
Environment="OCTOP_HOME=/var/lib/wanx"
Environment="WANX_STUDIO_ROOT=/opt/wanx/current/wanx-studio"
Environment="PYTHONPATH=/opt/wanx/current/wanx-studio/backend"
ExecStart=/opt/wanx/current/.venv/bin/octop run --host 127.0.0.1 --port 8089
Restart=on-failure
```

这是部署片段，不是完整主机安装器。node / codex 如装在其他目录，把实际可执行目录加入 PATH；监听地址、端口、已有网关与服务名沿用 WANX 主机方案。本例仅监听本机地址，不是公网开放模板。目标 WANX 账号和数据库需按既有部署流程先初始化。

| 目录 / 设置 | 用途 | 要求 |
|----|----|----|
| `WANX_STUDIO_ROOT` | 可执行的 Builder 服务组件 | 必须存在 package.json 与工具源码，依赖版本匹配；不是项目数据目录。 |
| `$OCTOP_HOME/.wanx-app-studio/` | studio.sqlite、任务、访谈和版本等 | 服务账号可写；升级保留，备份应包含数据库及产物，活动 SQLite 应做一致性备份。 |
| `~/.codex/` | Codex 配置、认证缓存与会话 | 归服务账号；恢复会话需要原登录环境和持久状态，不能当临时缓存清空。 |
| `TMPDIR/wanx-codex-*/` | 私有 server.sock / observer.sock | 服务账号可创建 Unix socket；目录 0700、socket 0600；路径不要过长，不改成共享可写目录。 |

以下变量由开物后端自动产生，不要求运维手写：

- `WANX_CODEX_PATH`：每次通过服务 PATH 的 `shutil.which('codex')` 发现。
- `WANX_CODEX_CONFIG`：开物生成的受控覆盖项，禁止 Shell、外部 MCP 等。
- `WANX_CODEX_CONFIG_STAMP`：config.toml 的修改时间戳，用于配置变化时替换 worker。
- `WANX_TASK_PROXY / WANX_TASK_TOKEN`、`WANX_INTERVIEW_PROXY / WANX_INTERVIEW_TOKEN`：每个私有 worker 的本机工具代理和随机凭据，不是给用户填写的全局 Key。

## 05 / WANX 构建引擎配置

Codex CLI 已安装，只完成了主机层。还需为**当前 WANX 管理员用户**登记并启用构建引擎。配置实际保存在 WANX 的用户级 ACP runners 设置中，当前开物只适配受信 Codex。

``` json
{
  "runners": {
    "codex": {
      "enabled": true,
      "command": "codex",
      "args": ["app-server"],
      "env": {},
      "trusted": true,
      "tool_parse_mode": "update_detail"
    }
  }
}
```

| 字段 | 含义 / 必须满足 |
|----|----|
| `id: codex` | 登记名固定；任意别名、自定义 executable 不是开物支持的执行器。 |
| `enabled:true / trusted:true` | 已启用、已由管理员信任。普通用户不能配置。 |
| `command / args` | 推荐新主机登记 codex + \[app-server\]。这组值用于适配校验；实际启动仍由开物查找 PATH 的 codex，并加入受控参数。 |
| `env:{}` | 当前适配不接受 runner 自定义 env。不要在这里填 Codex Key、Shell 命令或代理绕过。 |

使用现有维护配置流程或 API 操作：`GET /api/acp` 读取当前管理员配置，`PUT /api/acp` 保存。**PUT 是替换当前用户的 runners，不是局部补丁**；先保留其他 runner，再合并上面的 codex 项。不要把最小示例直接覆盖已有完整列表，也不需要为日常用户增加 Dashboard 入口。

随后在开物中选择 Codex，点击检查，并为项目绑定这一配置。技术核验接口：

``` text
GET  /api/app-studio/engines
POST /api/app-studio/engines/check
     {"engineId":"codex"}
PUT  /api/app-studio/engines/default
     {"engineId":"codex"}
GET  /api/app-studio/preflight
```

上述请求均使用现有 WANX 管理员认证。项目记录引擎 fingerprint；更改引擎配置后，旧项目可能需要重新确认绑定，不能悄悄使用一份不同配置继续构建。

### 已有 ACP 定义为什么仍能用？

当前适配层也认可受信的 `codex-acp` 空参数，以及 `npx -y @zed-industries/codex-acp` / `npx -y @agentclientprotocol/codex-acp`，用于保留已有配置的可用性。本机数据库仍保存第一种 npx 定义，但实际运行已核对为原生 app-server。新镜像按上面的原生定义登记，无需为了开物特意全局安装 ACP 包。

## 06 / 从需求到成品，一轮实际发生什么

1.  客户端准备 — 简单输入 / AI 补全；选择星图、空间、参考资料和 Codex 引擎。
2.  PRD 访谈 — Python 产品经理 → interview worker → Codex 原生 thread。
3.  确认与冻结 — 用户看到完整 PRD 并确认；冻结方案、数据契约、源码基线。
4.  受控开发 — build worker → Codex；读材料、读源码、公开计划、修改、固定校验。
5.  生成与试用 — 保存新版，预览和试用；用户独立选择采用、安装和公司上架。

### PRD 会话：wanx_interview

Codex 调用 `read_project` 获取简报和当前 PRD；按用户需求使用 `search_context` 在已选且获准的星图 / 背景资料中检索，再以 `read_context` 精读必要原文。通过 `ask_product` 提问、`update_prd` 增量保存、`propose_contract` 整理契约、`complete_prd` 完成方案。

星图资料用于理解产品和辅助 PRD，不会成为自动采纳的用户要求，也不会自动授予成品应用读取整仓的权限。无需给主机 Codex 手工接入空间 MCP 或星图 MCP；访谈工具由开物按当轮权限注入。这里的内部任务 MCP，与用户管理 Agent 专属盘的空间 MCP、按仓库授权的星图 MCP 是不同用途。

### 开发会话：wanx_task

Codex 只可用 `read_material`、`list_sources`、`read_source`、`update_plan`、`patch_source`、`write_source`、`validate_app` 和必要时 `require_plan`。文件变更先由开物代理验证并保存，`validate_app` 执行固定编译和契约检查。只有校验提交完成才生成成功版本；“Codex 回答结束”本身不代表构建成功。

### 会话复用与后续修改

Python 按 `(owner, project_id, role)` 加配置 fingerprint 复用 worker。访谈和开发角色分开，不跨用户或项目共享会话；同一 worker 不同时执行两个 turn。热会话直接继续，冷恢复先 `thread/read` 再 `thread/resume`，找不到旧记录时可新建 thread。worker 空闲约 5 分钟会退出，持久项目和 Codex 会话不随之删除。

首版成功后，明确的文字修改和标记修改进入直接迭代队列，最终复用开发 worker 与版本存储；不要求重新走首次 PRD。查看历史版不会自动改变迭代基线。需要试用、采用、上架的操作仍由用户决定。

| 模型所在环节 | 配置来源 |
|----|----|
| 客户端 AI 补全 / WANX 能力探测 | WANX 自己的已配置模型能力，不是通过当前 Codex 开发 thread 调用。 |
| PRD 访谈与代码构建 | Codex CLI 的模型配置 / 默认模型；开物 turn 显式指定 medium 推理强度。 |
| 成品应用 api.model.generate / 应用主模型 | WANX 的应用运行模型配置，与开发过程用的 Codex 模型无关。 |

## 07 / 工具与权限边界

- thread 参数固定为 `approvalPolicy:"never"`、`sandbox:"read-only"`。Shell、unified_exec、内置文件改写路径、外部插件、全局 MCP、主机技能发现、浏览器和 web search 等由开物覆盖为关闭。
- “never”不是允许 Codex 任意操作主机：命令 / 文件审批请求由桥接层拒绝。允许的源码修改通过开物专用 MCP 完成；真实用户选择题由产品工具处理。
- 用户在 Codex 全局配置的其他 MCP 不会自动带入。当前角色只注入 `wanx_interview` 或 `wanx_task`。不要通过全局配置重新开放任意工具来解决兼容问题。
- 每次任务工具调用重新校验当前上下文；账号、盒子或权限失效时停止旧任务回写。只读终端只允许观察当前 thread 的白名单请求，不能输入命令或启动第二个 turn。
- 成品必须基于 WANX 已有 data / model / files / knowledge / reports 能力和账号两级角色开发；不允许模型修改底层公开接口、生成另一套用户登录或把访问 Key 写进产物。

上述是当前产品的应用层受控调用边界，不应把它宣传成通用不受信代码执行平台或完整 OS 级租户隔离。主机预装、更新和依赖安装由运维完成，不交给构建中的 Codex。

## 08 / 配置完成后的验收

### A. 零模型调用检查

以下检查使用 Builder 自带探针，只启动一次临时 app-server 并握手，不新建产品、不发送模型 turn。请使用服务账号、服务实际 PATH 和 WANX 的虚拟环境 Python。

``` bash
cd /opt/wanx/current/wanx-studio
/opt/wanx/current/.venv/bin/python - <<'PY'
import json, os, subprocess, sys
from pathlib import Path
root = Path.cwd()
sys.path.insert(0, str(root / "backend"))
from wanx_studio.codex_config import runtime_config
config = runtime_config()
if config is None:
    raise SystemExit("CODEX_NOT_CONFIGURED: 检查服务账号 PATH")
env = {k: v for k, v in os.environ.items()
       if k in {"PATH", "LANG", "TMPDIR"}}
result = subprocess.run(
    ["node", str(root / "tools/probe-codex.mjs")],
    cwd=root, env={**env, **config},
    capture_output=True, text=True, timeout=45)
print(result.stdout.strip())
if result.returncode or not json.loads(result.stdout).get("available"):
    raise SystemExit("Codex 探针未通过")
PY
```

预期至少看到：`{"available":true,"executor":"Codex","transport":"app-server","modelCalls":0}`。如果 CLI 登录状态正常、探针通过，仍需真实模型任务才能确认该模型可用和额度足够；不要把连接检查标成“产品构建已验收”。

### B. 真实验收：一个合成会议助手

- [ ] 团队管理员登录目标盒子，开物可选 Codex，位置显示该 WANX 服务主机。
- [ ] 输入“做一个会议助手，记录标题、纪要和行动项”；选择测试空间与合成参考资料。
- [ ] PRD 可多轮问答、增量保存；如选星图，能找到真实引用，未授权仓库不能读取。
- [ ] 确认完整 PRD 后发起构建，能看到阶段 / 源码事件；Mac/Linux 可核验只读制作终端，终端失败不误报构建成功或阻塞主任务。
- [ ] validate_app 成功后出现可试用新版，新增一条合成会议并保存、重新打开确认存在。
- [ ] 左侧发送“首页标题改成会议助手”，直接生成新版；旧版保留、能对比，不重走首次 PRD。
- [ ] 第二个管理员 / 项目不串会话；普通用户不能发起管理构建，获准后可使用公司应用。
- [ ] 记录 OS/CPU、Node/Python/Codex 版本、服务账号、组件清单哈希、引擎配置摘要和真实构建记录；不保存密码、Key、登录令牌。

真实验收会消耗 Codex / 模型额度，且能力检查可能调用 WANX 模型。用合成资料和测试目录，不将“探针通过”替代这组验收。

### C. 本次说明制作时做了什么

只读核对源码、实际服务挂载路径、非敏感配置字段、CLI 版本与登录方式，并按实际服务 PATH 跑了一次零模型探针，结果通过。**没有修改服务配置、登录状态或产品代码，没有为写说明新建真实构建，也没有完成目标 Linux 标准机验收。**

## 09 / 常见故障、升级与恢复

| 现象 / 代码 | 优先检查 | 处理方向 |
|----|----|----|
| CODEX_NOT_CONFIGURED / 找不到 node | WANX 服务账号和实际服务 PATH | 在服务上下文定位 binary。不要仅改个人 shell 的 .zshrc；不要把 runner command 当成二进制路径覆盖项。 |
| ENGINE_NOT_CONFIGURED / DISABLED / NOT_ADAPTED | 当前 WANX 管理员的 codex runner | 登记 codex、enabled/trusted 为 true、env 为空；使用受支持 command/args，保留其他 runner 配置。 |
| ENGINE_CONFIGURATION_CHANGED / BINDING_REQUIRED | 项目绑定的配置 fingerprint | 回到项目准备中重新确认对应配置，不直接删项目或改数据库。 |
| CODEX_SHARED_SERVER_FAILED / TIMEOUT | Codex 版本、config.toml 有效性、临时目录权限 / socket 路径、依赖和数据库锁 | 先运行服务上下文探针，检查结构化 diagnostic；服务等待 app-server 最长约 30 秒。保留同一个进程的启动过程，避免循环冷启动。 |
| CODEX_REQUEST_TIMEOUT | app-server RPC 是否响应，CLI / 协议版本是否一致 | 当前单个 RPC 等待约 40 秒；与 30 分钟构建上限是两回事。升级后应核验 thread/read、resume 等兼容性。 |
| 登录失效、401、模型不可用 / 额度不足 | 实际服务账号的 Codex 登录、模型权限、额度和盒端网络 | 在同一账号重新登录 / 检查账户；不要把 API Key 粘进 runner env。握手通过不能排除这些问题。 |
| 终端能用、服务不能用 | 是否换了 OS 用户 / PATH、依赖代理或 CA env、钥匙串是否可访问 | 复现最小允许环境；当前不透传任意代理与自定义 provider 环境，不用放开 Shell 解决。 |
| Cannot find package ws / esbuild | WANX_STUDIO_ROOT 是否指到完整服务组件；Node 依赖是否完整 | 在匹配版本组件目录按锁文件安装依赖，不把客户端 release 包当服务包。 |
| TASK_AUTHORIZATION_EXPIRED / 上下文变化 | 任务 / 编辑 lease、WANX 账号与盒子是否切换、后端工具请求是否及时响应 | 本码不是 Codex 登录过期的同义词。检查项目任务状态和心跳，保留草稿与版本，不无限重试构建。 |
| 只读终端空白 / Trust this folder / CODEX_TERMINAL\_\* | pty 支持、终端 Python、--remote unix://、原 thread 恢复 | 先判断主模型是否仍在开发；终端应为非阻塞观察。Windows 原生终端链路不作为已支持能力交付。 |
| BUILD_CONCURRENCY_LIMIT | 当前 Runner 是否已有构建任务 | 当前实现有限制同时构建的保护，不代表装上更多核数就支持多项目无限并发。 |
| 页面提示“版本已生成”，但应用行为不符合 | 校验、真实试用、采用、安装 / 上架是否分别完成 | 编译提交不等于业务验收；保留上一版，用左侧迭代继续修改。 |

### 升级与回滚原则

1.  先确认没有活动访谈、构建、队列任务或未保存操作；备份 WANX / Builder 数据和所需 Codex 状态，限制备份访问权限。
2.  锁定 WANX、Builder 服务组件、Node、Codex 的交付版本；实验性协议升级先在合成项目验证，再切生产主机。
3.  更新服务组件 / PATH / Codex 版本后，在维护窗口重启 WANX 服务，避免旧 worker 继续持有旧配置；不要只更新客户端来解决盒端二进制问题。
4.  回滚恢复匹配的服务组件与依赖，保留数据和版本历史；出现数据库兼容变化按对应发布流程恢复，不删除 .wanx-app-studio 或 .codex 目录“重来”。

当前参考超时：worker 内工具回调约 10 秒；app-server 启动约 30 秒；单 RPC 约 40 秒；PRD 单轮约 600 秒；构建单轮约 1800 秒；worker 空闲回收约 300 秒。用于定位卡在哪层，不建议未经验证直接放大所有超时。

## 10 / 团队查代码时从哪里开始

以下均为 WANX 仓库相对路径。以交付源码为准；本机开发工作区有未提交修改，文件存在不代表已经推到目标 CodeUp 分支。

<table>
<colgroup>
<col style="width: 50%" />
<col style="width: 50%" />
</colgroup>
<thead>
<tr>
<th>文件 / 函数</th>
<th>负责内容</th>
</tr>
</thead>
<tbody>
<tr>
<td><code>src/octop/api/studio.py · mount_studio</code></td>
<td>WANX 挂载 Builder，解析 WANX_STUDIO_ROOT。</td>
</tr>
<tr>
<td><code>wanx-studio/backend/wanx_studio/wanx.py · mount_wanx</code></td>
<td>接现有登录、模型、空间、引擎登记与团队权限。</td>
</tr>
<tr>
<td><code>wanx-studio/backend/wanx_studio/codex_config.py · runtime_config</code></td>
<td>发现 codex、读取非敏感 config、生成受控覆盖项。</td>
</tr>
<tr>
<td><code>wanx-studio/backend/wanx_studio/native_codex.py · acquire / release</code></td>
<td>按用户 / 项目 / 角色管理持久 Node worker 与互斥锁。</td>
</tr>
<tr>
<td><code>wanx-studio/backend/wanx_studio/engines.py · supported / guard</code></td>
<td>引擎适配约束、用户配置与项目 fingerprint 绑定。</td>
</tr>
<tr>
<td><code>wanx-studio/backend/wanx_studio/product_manager.py · execute_turn</code></td>
<td>PRD 会话、星图背景读取规则和产品问答。</td>
</tr>
<tr>
<td><code>wanx-studio/backend/wanx_studio/runner.py · preflight / execute</code></td>
<td>连接探针、冻结任务材料、构建授权、状态与结果。</td>
</tr>
<tr>
<td><code>wanx-studio/backend/wanx_studio/edits.py</code></td>
<td>首版后的直接迭代协调与队列。</td>
</tr>
<tr>
<td><code>wanx-studio/codex/shared-server.mjs · startSharedServer</code></td>
<td>真实 spawn 参数、Unix socket、启动诊断与清理。</td>
</tr>
<tr>
<td><code>wanx-studio/codex/native-session.mjs · open / prompt</code></td>
<td>initialize、thread/start/read/resume、turn/start、流式通知与拒绝越界请求。</td>
</tr>
<tr>
<td><code>wanx-studio/codex/interview.mjs / interview-tools.mjs</code></td>
<td>访谈 worker 与 wanx_interview 工具面。</td>
</tr>
<tr>
<td><code>wanx-studio/codex/driver.mjs / tools.mjs</code></td>
<td>开发 worker 与 wanx_task 源码 / 编译工具面。</td>
</tr>
<tr>
<td><code>wanx-studio/codex/observer.mjs / terminal.mjs / terminal.py</code></td>
<td>原版 Codex CLI 的同会话只读制作过程。</td>
</tr>
<tr>
<td><code>wanx-studio/tools/probe-codex.mjs</code></td>
<td>无模型调用的连接验收入口。</td>
</tr>
<tr>
<td><code>src/octop/api/routers/acp.py</code><br />
<code>src/octop/infra/agents/settings/acp.py</code></td>
<td>管理员用户级引擎配置 API 与保存逻辑。</td>
</tr>
</tbody>
</table>

官方资料仅用于核对 CLI 的安装 / 认证 / 协议语义；WANX 自己的调用链、环境白名单与权限限制以上述源码为依据。

- [OpenAI Docs：Codex App Server](https://learn.chatgpt.com/docs/app-server) — transport、initialize、thread / turn、remote terminal。
- [OpenAI Docs：Authentication](https://learn.chatgpt.com/docs/auth) — ChatGPT / API Key 登录、device-auth、凭据存储。
- [OpenAI Docs：Codex CLI](https://learn.chatgpt.com/docs/codex/cli) — 官方 CLI 安装与使用入口。

万象·开物 / WanX Builder · 标准主机配置交接说明 · 2026-10-27\
本文件可离线阅读、转发与打印；外部官方资料链接需要联网。复选框只辅助交付讨论，不是自动验收记录。
