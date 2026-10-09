# 万象管理员 V1

> 2026-10-01 定位调整：本目录保留为此前的独立管理员原型。当前产品是 `wanx-desktop/` 中的万象电脑端，复用 WANX 功能页面，通过 SDK 连接盒子，盒子连接与应用中心为两个同级入口。当前使用入口与交付边界见 [WANX 电脑端说明](../docs/wanx-client.md)。以下内容仅描述旧原型。

万象管理员是独立 Electron 桌面应用，面向盒子管理员与产品开发团队。它通过 `centaurai-wanx` SDK 调用盒子中的 WANX，维护系统配置、登记产品、配置盒子部署、管理客户端版本与用户访问。知君等产品面向最终使用者，用户实例及其记忆由 WANX 原生模块保存。

本应用自有代码为公司私有产品，`UNLICENSED`；第三方组件保留原有许可证。

## 六个工作区

| 工作区 | 当前实现 |
|---|---|
| 盒子总览 | 本机盒子目录、多盒逐盒选择、登录权限校验、服务端版本及能力诊断 |
| 系统配置 | 模型提供方、存储后端、MCP 连接器、技能包、插件、安全策略；使用真实 SDK 接口保存与测试 |
| 远程桌面 | JPEG 画布查看、明确进入控制、鼠标/键盘输入、组件安装/卸载日志、Linux 分辨率维护 |
| 产品中心 | 产品定义、资源部署、启用/停用、版本登记/推荐、用户开通/停用、清单导入导出、按盒子/用户/产品隔离的本机定义草稿 |
| 开发工作区 | 选择产品和 SDK tarball，生成 TypeScript / React / Electron 工程 |
| 账号与审计 | 用户创建、角色及附加权限、账号启停、角色创建、管理操作记录 |

配置表单中的 JSON 使用 WANX 原有配置字段。已保存密钥不回传界面，密钥输入只用于当前写请求。产品能力目前为 `chat`、`memory`、`knowledge`、`upload`、`voice`；系统管理员对平台技能、插件和连接器的维护权限，不会自动赋予最终产品调用这些功能的权限。

## 连接与权限

- 当前可用连接为主进程 SDK 可信 HTTPS 适配；HTTP 仅允许 `localhost` / `127.0.0.1` / `[::1]` 开发服务。服务地址必须为根地址，不包含路径、查询或 URL 凭据；HTTPS 使用系统信任链，不提供跳过证书验证。
- 正式的万象管理员 P2P 应用连接身份尚未登记。远程设备可以保存到目录，但连接入口明确关闭，不冒用 SDK 的 `omnia-desktop` 身份。
- 使用 WANX 现有账号登录 `wanx` 管理作用域。服务器已启用验证码时，当前登录窗口支持输入经服务器验证码流程取得的证明；集成验证码交互界面是后续适配项。
- 产品维护权限为 `applications_manage`，产品开发权限为 `applications_develop`。后端对开发者施加本人产品的限制，系统管理员可管理产品元数据。其他模块使用现有 WANX 权限键。
- 桌面分别校验 `desktop`（查看）、`desktop_control`（输入）、`desktop_manage`（安装/卸载/分辨率）。默认查看模式，必须明确进入控制。
- 凭据保存在 Electron 主进程内存，不进入 renderer IPC 返回值、localStorage、盒子目录或工程。断开释放主进程客户端、socket 和数据流；切盒时旧请求结果被丢弃。IPC 携带当前会话 ID，旧会话不能执行新盒子的操作。
- 每个管理请求刷新服务端账号和权限；15 秒主动检查连接，单次管理 HTTP 请求设 15 秒上限。断线、认证失败或权限撤销后重新登录。
- renderer 只能使用固定管理动作，不拥有任意 API、私有聊天、记忆正文或 workspace 读取入口。远程桌面本身具有操作盒子系统的能力，应只授予可信维护人员。

服务器负责所有权限、所有权、产品隔离、用户资料及运行状态；SDK 的应用策略是额外的客户端限制，不能代替服务端授权。

## 构建与运行

需要 Node.js 22+。SDK 基线为当前工程 `output/codeup-centaurai-wanx-sdk/sdks/centaurai-wanx` 的 `0.1.0-alpha.2`，应用构建会把所需 Node 端 SDK 打入主进程，原生 P2P 二进制不参与当前管理员打包。

```bash
cd output/codeup-centaurai-wanx-sdk/sdks/centaurai-wanx
npm install
npm run build
cd ../../../../wanx-admin-desktop
npm install
npm run build
npm run test
npm start
```

当前共享工作区开发时复用 `../dashboard/node_modules`。这只是本机节省磁盘的方式；独立 checkout 应正常执行 `npm install`。`npm run test` 会启动本机合成 HTTP 服务，受限环境需要允许回环监听。

标准发行配置：

```bash
npm run package:mac
npm run package:windows
```

macOS 配置 arm64 / x64，Windows 配置 x64 / arm64 NSIS。各目标应在对应构建与签名环境运行。开发阶段也提供缓存封装路径，只使用已下载的 Electron 37.10.3 darwin-arm64 zip：

```bash
npm run build
node tools/package-mac-cache.mjs /absolute/path/electron-v37.10.3-darwin-arm64.zip
```

输出 `release/mac-arm64/万象管理员.app`，包含编译后的 renderer、主进程和 preload，无需工作区依赖。缓存封装只做 ad-hoc 签名，不能当作已公证的对外安装包。脚本拒绝覆盖已存在的应用输出。

## 产品与版本流程

1. 在产品中心创建定义或导入 `schema_version: 1` 清单；知君使用 `zhijun` 标识。
2. 在盒子部署中绑定模型/资源，检查配置并启用。
3. 创建 WANX 账号，为对应用户开通产品访问；停用访问保留私人档案。
4. 生成 SDK 工程，选择 SDK `.tgz` 包；生成器将它复制到工程 `vendor`，不包含生产凭据和用户内容。
5. 在外部工具实现应用并构建安装包，托管文件、计算 SHA-256。
6. 登记 macOS / Windows 版本、架构、下载地址和兼容要求，设置推荐版本。终端应用选择兼容版本，提示用户自行下载安装。

产品清单导入是两步操作：产品定义先保存，部署配置再保存；第二步失败会明确报告已保存定义、部署未导入，允许修正后重试。跨盒复用通过清单完成，不引入中央产品服务。产品定义更新不覆盖已有私人 Agent 实例。

## 验证范围

`npm run build` 已通过 TypeScript、Vite renderer、Electron main/preload bundle；`npm run test` 当前 17 项测试覆盖真实 SDK 对合成 HTTP 服务的登录与产品全链，以及权限拒绝、凭据脱敏、P2P 禁用、切盒中的旧请求隔离、产品/配置选择慢响应隔离、桌面模式与权限、断开禁止写入、MCP 密钥保留、IPC 主 frame 校验和本机草稿隔离。

目前没有真实盒子。合成测试不能证明真实签票、统一身份、跨网络 P2P、真实远程桌面或 Windows 安装运行已验收。正式交付仍需要真实账号、登记后的管理员连接身份、盒子环境，以及 macOS / Windows 真机测试与发行签名。

WANX 服务升级、停机恢复、盒子系统恢复需要独立维护通道；当前不提供这些操作入口。
