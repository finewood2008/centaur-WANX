# Builder 的盒端 Codex 与设备模型

## 交付边界

个人版（Mini）和团队版（Studio）共用同一套盒端 WANX 底座与镜像。Codex 是团队版“开物”的盒端执行依赖，随共享镜像内置一份；个人版的日常功能不依赖 Codex。盒端继续使用同一套 WANX 组件发行和 OTA 流程。

两个桌面客户端都不携带或安装 Codex CLI。个人版资源装配跳过 Builder，团队版只装配 Builder 界面和 Electron 运行外壳，由盒端执行构建任务。开发或打包机器在安装 Studio 依赖时会安装 Codex，这些 Node 依赖不会整体复制到桌面安装包。

Codex 是 WANX 镜像中的固定版本运行依赖。镜像构建阶段安装，盒子运行时不从 ChatGPT 官网、npm 或 GitHub 下载 CLI，也不自行更新。升级 Codex 时同时更新 Studio 的 `package.json` 和锁文件，验证后通过现有 Admin 的 WANX 组件发行、验收、推广和设备升级流程交付。

当前固定版本为 `@openai/codex` `0.160.1`。镜像在最终运行身份下、关闭网络后验证随包 CLI 的版本与 app-server 握手。更换版本必须重新验证该协议，不能只验证 `codex --version`。

## 模型与凭据

调用路径为 `Builder → Codex app-server → 本地设备模型代理 → qeetoken /v1/responses`。

盒端服务初始化后立即开始同步，默认每轮同步后等待 60 秒；间隔可配置为 15～120 秒。同步使用既有设备 DeviceKey 获取 Admin 的设备 Provider 租约。本地可信模式由 WANX 自身生命周期启动同步与 `127.0.0.1:18089` 私有推理服务，通过领域服务更新 Provider；旧模式继续由 Bridge 承载。私有服务只提供模型推理接口，不提供登录或 Provider 管理 HTTP 接口。物理设备 ID 必须与本地可信配置及必需策略中的盒子身份一致，Admin Registry ID 可以另行映射。

当前 V3 qeetoken 的模型列表来自中转站的 `/models`；该协议要求 qeetoken 的 `allowedModels` 为空。通用同步逻辑也兼容其他 Provider 或旧协议的非空允许列表，这时直接使用允许列表。同步生成盒端 `admin-managed-qeetoken` Provider，Builder 在预检、访谈和执行任务时读取它的当前配置。

当前 Builder 按实际模型 ID 筛选：以小写 `gpt-` 开头，并排除图片、音频、实时语音、Embedding 等非文本生成模型；展示名称不参与筛选，也不要求 ID 包含 `codex`。优先使用该 Provider 下符合条件的 WANX 默认模型，否则按模型 ID 字典序取第一个。此排序不代表模型能力；目前没有独立的 Builder 默认模型设置，自定义别名未以 `gpt-` 开头时不会被选中。

- 复用 Admin 下发的 `qeetoken` 设备 Provider，不新增独立的全局 Codex Key。
- Builder 使用受管 Provider 的 GPT 文本模型，优先使用其已选中的默认模型；默认模型不适合时，从该 Provider 的可用 GPT 文本模型中稳定选择。此选择不修改普通聊天的默认模型。
- Codex 只持有本地代理令牌；qeetoken 的设备上游凭据由设备模型代理保存在内存中。上游凭据不写入 Provider 数据库、项目、构建产物、终端参数或日志。
- Codex 状态按 Builder 用户隔离，盒端运行不依赖宿主的 ChatGPT 登录或个人 `~/.codex` 配置。缺少受管 Provider 或随包 CLI 时报告未配置，不回退到个人账号。
- Provider、模型或凭据变化后重建对应 worker。Bridge 在请求及流式传输期间继续校验租约、设备归属、模型允许范围和禁用状态。

代理原样保留 Responses 输入、工具调用、工具结果和 SSE 事件。普通 WANX 聊天继续使用原来的 Chat Completions 路由，不做协议转换。当前集成使用 HTTP JSON 与 SSE，不启用模型 WebSocket 传输。

配置未变化的 V3 模型列表刷新保留有效代理令牌与活动请求；发现失败、模型移除或设备授权变化仍会撤销相关调用。云端配置变化在后续同步时生效，离线时仅使用尚未过期的设备租约；租约最长 300 秒。Builder 的本地团队权限另由每任务的本地可信上下文检查，不把本地团队版本与云端授权版本混用。

## 主机配置与引擎登记

2026-10-27 的主机配置参考说明记录了另一台 macOS 开发机使用全局 Codex 和 ChatGPT 登录的情况。正式盒端采用本节的受管配置；参考机的 CLI 0.162.1、模型名称和个人登录缓存不作为镜像默认配置。

在运行 WANX 的同一服务账号下准备 Python 3.12+、Node.js 22.14+ 和完整 Builder 服务目录。按锁文件安装依赖；服务编译需要 esbuild 等开发依赖，不能仅安装生产依赖。Node 必须在服务 PATH 中，Codex 则从 Builder 的 `node_modules/.bin/codex` 读取，无需全局安装或执行 `codex login`。

源码运行可自动发现 `wanx-studio/`；wheel 部署设置 `WANX_STUDIO_ROOT` 指向包含 `package.json`、`backend/`、`codex/`、`core/`、`tools/`、关联帮助模块和匹配 Node 依赖的服务目录。桌面客户端包不能替代这个目录。

服务账号必须能写 WANX 数据目录及临时目录。Codex 持久状态位于 `$OCTOP_HOME/.wanx-app-studio/codex/<owner hash>/`，访谈和开发使用同一用户的隔离状态。不要复制开发者的 `~/.codex/auth.json`，也不要向 runner 的 `env` 填入 API Key、代理或自定义启动命令。

有可用设备 Provider 时，新用户的默认受信引擎为：

```json
{"codex":{"enabled":true,"command":"codex","args":["app-server"],"env":{},"trusted":true}}
```

已保存的用户引擎配置优先，明确禁用不会被自动覆盖。使用 `GET /api/acp` 维护现有配置时，注意 `PUT /api/acp` 替换整个 runners 列表，应保留其他引擎。引擎登记控制能否使用 Codex，实际模型仍来自 Admin 设备 Provider，不从该登记写入新的凭据或模型设置。

受管模式的推理强度沿用所选模型的能力元数据；元数据没有指定时不强行发送 effort。非受管开发主机沿用已有主机配置及 medium turn 强度。不要把参考机的模型和推理强度硬编码到盒端。

## 配置检查与验收结果

镜像阶段可在服务目录执行：

```bash
node tools/verify-bundled-codex.mjs
```

它使用临时隔离状态核对固定 CLI 版本和 app-server 握手，不读取宿主登录、不发送模型请求。该检查不验证 Admin Provider 是否已同步。

运行中的盒子应由团队管理员通过现有登录与盒子上下文打开开物，点击引擎检查；对应 `POST /api/app-studio/engines/check`，请求体为 `{"engineId":"codex"}`。需要完整报告时，在同一认证上下文读取 `GET /api/app-studio/preflight`。该接口解析当前用户实际使用的 Provider 和隔离状态，报告 `configurationSource`、`binarySource`、模型和推理强度，以及 `cliVersion`、`nodeVersion`；不会返回令牌、完整配置文件、环境或状态目录路径。

完整探针报告 `check:"protocol"`、`modelCalls:0`。任务入场仅检查配置时报告 `check:"configuration"`，实际 worker 随后自行握手，不额外启动一次探针。两者都不能证明模型额度充足或产品构建成功。配置或本地代理令牌变化后，预检缓存和 worker 会按新的配置指纹更新。

不要在受管盒端用无 service/owner 参数的 `runtime_config()` 来替代上述检查；该调用面向非受管开发主机，会选择主机 PATH 与个人 home。底层 `probe-codex.mjs` 的私有启动环境应由 WANX 生成，失败输出固定 JSON 并以非零状态退出，不要求运维手写令牌。

| 错误码 | 检查方向 |
|---|---|
| `CODEX_OWNER_REQUIRED` | 从万象重新建立当前用户与盒子上下文。 |
| `CODEX_DEVICE_PROVIDER_UNAVAILABLE` | 检查 Admin Provider 启用状态、设备租约和可用 GPT 文本模型；不改为宿主登录。 |
| `CODEX_BUNDLE_MISSING` | 检查随包 CLI、完整依赖和服务目录；通过匹配的 WANX 组件重新部署。 |
| `CODEX_HOST_CLI_MISSING` | 仅非受管开发主机：检查服务账号 PATH 中的 Codex。 |
| `CODEX_NODE_MISSING` | 检查服务 PATH 中的 Node.js。 |
| `CODEX_CONFIG_INVALID` | 检查实际状态目录内 config.toml 的格式和相关字段类型。 |
| `CODEX_STATE_UNAVAILABLE` / `CODEX_TEMP_DIRECTORY_UNAVAILABLE` | 检查服务账号权限、目录和磁盘状态。 |
| `CODEX_VERSION_FAILED` / `CODEX_VERSION_INVALID` / `CODEX_DEPENDENCIES_MISSING` | 检查安装完整性和锁定版本。 |
| `CODEX_PROBE_TIMEOUT` / `PREFLIGHT_FAILED` | 重试连接检查，核对组件版本与服务进程状态。 |
| `CODEX_INTERRUPTED` | 检查已取消，可重新发起；探针会清理本次启动的进程。 |
| `CODEX_PROBE_CLEANUP_FAILED` / `CODEX_CLEANUP_FAILED` | 检查探针进程和临时目录是否能正常清理。 |

最后在测试设备使用合成资料完成一次多轮 PRD、构建校验、试用保存和后续修改，并验证普通成员不能发起构建、不同用户和项目不串会话。记录组件版本、无凭据的配置摘要及构建记录；真实任务会消耗模型额度，离线握手不能替代这一步。

## 升级与回退

Codex 随 WANX 镜像切换，沿用盒端现有镜像健康检查与失败回退。具备 Builder 升级保护能力的新镜像在后台任务期间持有活动锁；OTA 获得独占升级锁后才允许停机，期间新任务不能入场。忙碌时保持现有任务运行，待任务结束后重试升级。

备份应包含 Builder 数据、产物及上述按用户隔离的 Codex 状态；活动 SQLite 使用一致性备份。回滚保留历史版本和会话，不通过删除状态目录来重新配置。

旧镜像没有活动锁协议，第一次迁移仍须安排无构建、访谈或编辑任务的空闲窗口。新版本之间的升级才具备原子任务保护。不要将旧镜像的优雅停机误认为等待 Builder 任务完成。

## 验收

1. 在无宿主 Codex 配置和凭据的环境中启动随包 CLI，完成 app-server 握手。
2. 通过真实 CLI 与本地合成 Responses 服务验证流式完成、工具调用与结果回传、后续轮次；合成验证不等同于真实模型生成质量验收。
3. 通过 Bridge 验证本地令牌与上游凭据隔离，以及 Provider 禁用、凭据轮换、租约过期和设备归属变化后的撤权。
4. 验证升级准备与任务入场互斥，忙碌不停止容器，失败释放保护，原有普通停机行为不变。
5. 在 Linux 镜像构建中执行离线 CLI 检查，再用测试设备完成真实 qeetoken 的 Builder 访谈、生成与后续修改闭环。

协议依据：[OpenAI 网关兼容要求](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility)、[使用 Provider 凭据接入网关](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway)。
