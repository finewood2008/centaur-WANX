# 万象电脑端

当前客户端是 `wanx-desktop/` 中独立运行的 Electron 应用。它复用原 Dashboard 的组件和功能页面，加载自己随安装包交付的界面，通过 SDK 连接盒子里的 WANX 服务端。盒子连接与应用中心是电脑端导航中的两个同级入口；盒子服务端导航不增加这两个客户端入口。

## 账号与盒子连接

1. **登录电脑端平台账号**：使用 SDK Consumer 手机号/密码或短信登录。平台账号决定可访问的设备目录。
2. **选择授权盒子**：使用 SDK 返回的 `deviceId` UUID，展示在线状态、设备角色和授权范围。不能手工编造 `centauros-*` 代替 Consumer 设备 UUID。
3. **建立 SDK 连接**：SDK 完成签票、P2P Direct 和 WANX 统一身份交换，应用只调用 `host.connection.connect({deviceId})`。
4. **核验盒子权限**：连接后读取原生 `/api/auth/me`。设备访问权不自动产生 WANX 管理权限；应用中心和系统操作仍由盒子服务端逐次校验。
5. **切盒或断开**：关闭原会话和数据流，再进入另一台盒子的独立会话。权限撤销或连接失效会退回本机盒子页。

平台账号与盒子本地账号不是同一组凭据。需要关联已有本地管理员时，在可选关联表单提供该盒子的原账号；SDK 的 `linkExisting` 同时验证平台身份与本地凭据，不自动提升角色。本机现有 `finewood` 是 WANX 本地账号，不能当作平台手机号。

主进程保管 SDK Host、签名密钥、JWT 和原生连接，页面只获得公开状态及本机随机会话标识。现有 HTTP、SSE、上传下载和七类 WebSocket 通过本机网关调用 SDK 冻结的操作表。网关拒绝未知接口、跨源调用、服务器凭据覆盖和过期会话；保持原生错误状态及流式响应。

## 正式网络发行配置

发行方在 `wanx-desktop/deployment.json` 配置批准的主机名单，结构见 [deployment.example.json](../wanx-desktop/deployment.example.json)。Consumer 默认是 SDK 文档中的 `https://boss.nexusaos.qitus.cn/prod-api`，不能追加 `app-api`。Gateway 和 ICE 名单必须来自公司批准的配置，不能从设备票据动态学习或使用通配信任。标准电脑端使用 SDK 已定义的 `omnia-desktop` 连接身份。

目前源码没有该生产主机配置，平台/P2P 入口因此禁用。SDK 主进程链路已实现，模拟验证不能替代正式账号、Core、签票与真实盒子验收。新建产品仍需要独立登记连接身份。

## 兼容入口与浏览器

电脑端保留已有可信 HTTPS 服务的兼容接入，通过 SDK HTTP 适配器和盒子本地账号登录；仅本机开发可使用回环 HTTP。地址不能含账号、路径、查询参数或片段。服务开启外部验证时，需要服务端原验证流程提供的证明，兼容入口不绕过该验证。

浏览器直接打开盒子的 HTTPS 地址，使用的是服务端 Web 控制台。纯浏览器不能运行当前 SDK 的 Node/Go P2P 宿主；如需独立浏览器电脑端，需要另行提供正式 HTTPS 网关。旧 `desktop/src/` Go/Wails 远程网页壳与 `wanx-admin-desktop/` 原型保留作历史参考，均不代表本次独立电脑端入口。

## 应用中心

持有 `applications_manage` 或 `applications_develop` 才显示应用中心。前者管理全部产品，后者只管理自己创建的产品；服务端逐次验证权限。使用设备访问权或普通用户账号不能绕过管理权限。

1. 创建应用：填写产品标识、名称，选择对话、记忆、知识、上传、语音能力。模板 JSON 支持 `name`、`description`、`default_model`、`system_prompt`、`welcome_message`。
2. 配置资源：例如要求 `{"chatModel":{"kind":"model","required":true}}`，在盒子部署中绑定 `{"chatModel":"openai/gpt-4o"}`。所需模型、存储、插件等先在原 WANX 配置页面登记；凭据仍在原有安全设置中。
3. 检查并启用：服务端确认资源引用存在。停用立即撤销产品访问，不删除用户实例；模板变更只影响新建实例。
4. 用户访问：输入已有 WANX 用户 ID，开通或撤销产品访问。用户自身 Agent、记忆和对话仍由 WANX 原生模块管理。
5. 登记客户端版本：先在外部构建、托管安装包，再填写 HTTPS 下载地址、SHA-256、系统架构和最低 WANX/SDK 版本。推荐版本按操作系统与架构分别管理，客户端自己检查兼容性并提示安装。
6. 开发与导出：导出清单，在另一盒子导入后默认停用。选择下方 SDK 包并输入交付 SHA-256，生成 TypeScript / React / Electron 工程 ZIP。在外部工具实现业务与界面，然后登记安装包版本。

应用管理只返回产品、授权及版本元数据，不提供私人记忆、聊天正文或用户工作区浏览。电脑端草稿保存在应用用户数据目录的 `product-drafts.json`，按盒子身份、WANX 用户 ID 和产品隔离，读写前重验管理权限，不受本机网关端口变化影响。包含凭据的 JSON 不允许保存或导出。操作系统维护权限仍属于系统级信任边界。

当前新建私人实例会应用模板及模型绑定。存储、技能、插件等其他资源绑定完成存在性校验并保存为部署记录，尚未自动装配到每个用户实例；这些资源继续通过原 WANX 设置维护。

SDK 包：[centaurai-wanx-0.1.0-alpha.3.tgz](../dashboard/vendor/centaurai-wanx-0.1.0-alpha.3.tgz)。SHA-256：`c7f0bf3a2a2ab3b466a10fc56097fa2bbac44d44dc7aa35736554d206a6249ed`。

## 构建与检查

```sh
cd dashboard
npm ci
cd ../wanx-desktop
npm ci
npm run build
npm test
npm start
npm run package:mac
# Windows 发布主机：npm run package:windows
```

`npm run build` 构建独立 `dist-ui/` 并保存依赖许可证通知。Electron 包解包 SDK 原生可执行文件目录。服务端按仓库要求运行 `make all` 和 `make build-frontend`，服务端 Web 资源与电脑端分别构建。界面验收脚本是 `wanx-desktop/tests/check-electron-ui.mjs`，使用 `WANX_TEST_ELECTRON` 指向未封装的 Electron 运行时，`WANX_TEST_PLAYWRIGHT` 指向本机 Playwright 包；脚本仅使用合成账号与本机模拟服务。

## 当前交付边界

已完成电脑端架构、SDK Host 接入及模拟服务流程验证，不能等同真实盒子验收。批准的 Gateway／ICE 发行配置仍缺失；真实账号、签票、统一身份、跨网络 P2P、桌面采集控制、Windows 真机安装、正式系统签名需单独验收。macOS 开发预览包使用本机临时签名。

这是公司私有产品；基础框架和第三方组件保留其原许可证说明。详细结果见 [电脑端验证记录](verification/wanx-computer-client/README.md) 和 [此前产品管理验证](verification/wanx-admin-v1/README.md)。
