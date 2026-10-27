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

## 升级与回退

Codex 随 WANX 镜像切换，沿用盒端现有镜像健康检查与失败回退。具备 Builder 升级保护能力的新镜像在后台任务期间持有活动锁；OTA 获得独占升级锁后才允许停机，期间新任务不能入场。忙碌时保持现有任务运行，待任务结束后重试升级。

旧镜像没有活动锁协议，第一次迁移仍须安排无构建、访谈或编辑任务的空闲窗口。新版本之间的升级才具备原子任务保护。不要将旧镜像的优雅停机误认为等待 Builder 任务完成。

## 验收

1. 在无宿主 Codex 配置和凭据的环境中启动随包 CLI，完成 app-server 握手。
2. 通过真实 CLI 与本地合成 Responses 服务验证流式完成、工具调用与结果回传、后续轮次；合成验证不等同于真实模型生成质量验收。
3. 通过 Bridge 验证本地令牌与上游凭据隔离，以及 Provider 禁用、凭据轮换、租约过期和设备归属变化后的撤权。
4. 验证升级准备与任务入场互斥，忙碌不停止容器，失败释放保护，原有普通停机行为不变。
5. 在 Linux 镜像构建中执行离线 CLI 检查，再用测试设备完成真实 qeetoken 的 Builder 访谈、生成与后续修改闭环。

协议依据：[OpenAI 网关兼容要求](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility)、[使用 Provider 凭据接入网关](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway)。
