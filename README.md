# 万象电脑客户端

2026-10-08 已生成本机 macOS arm64 开发预览，见 [本次构建结果](verification/构建结果.md)。

万象 = WANX = 定制 UI 的 Octop。本工程复用已有 WANX 界面，独立运行在 macOS / Windows，连接盒子中的服务端。

产品范围为完整 WANX UI 功能加标准 SDK 客户端能力，见 [客户端范围](CLIENT_SCOPE.md)。当前开发预览的构建通过不代表上述全部功能已经接通和验收。

## 组成

- `dashboard/`：现有 WANX React 界面与原生记忆页面。
- `wanx-desktop/`：Electron 桌面壳、本机页面网关、系统安全存储及打包配置。
- `packages/wanx-client-adapter/`：本客户端私有业务接口适配层，保留现有 `centaurai-wanx` 导入名，直接使用标准 Go SDK 的公开接口。不是新的对外标准 SDK。
- `standard-sdk/`：用户指定 Codeup 仓库，锁定 `master` 提交 `6ff9bfa02f4df9df650a25e7378891d74dbd0b8b`。标准 SDK 源码不修改，使用 Go SDK 0.2.0 与其交付的 Core 0.1.1。
- `verification/`：来源、构建与检查记录。

## 开发

需要 Node.js 22 或更新、Go 1.24 或更新、Python 3。SDK 私库可使用本机已配置的 HTTPS 认证。

```sh
git clone --depth 1 --filter=blob:none --sparse https://codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/nexusaos/nexusaos-centuarai-conn-sdks.git standard-sdk
git -C standard-sdk sparse-checkout set go release/go-connectivity-sdk-0.2.0
git -C standard-sdk checkout 6ff9bfa02f4df9df650a25e7378891d74dbd0b8b
npm --prefix packages/wanx-client-adapter install
npm --prefix dashboard install
npm --prefix wanx-desktop install
npm run build
npm test
npm start
```

主进程保存平台登录、签名钥匙和盒子会话。页面只获得展示状态及本机随机会话标识。客户端随安装包交付自身 UI，盒子继续承担模型、Agent、记忆、任务、权限与业务数据。

## 连接与当前限制

平台账号登录 → 授权设备目录 → 选择盒子 → 标准 SDK 建立 Direct P2P → Octop 原生统一身份 → WANX 功能页面。正式连接需发行方提供批准的 `wanx-desktop/deployment.json`，结构见同目录 `deployment.example.json`。本机预览配置沿用 SDK 文档中的平台 Base URL 及 `gateway.remote.qeeshu.com` Gateway / ICE 主机；尚未核实真实万象部署。缺少配置时入口保持禁用。

兼容接入可通过可信 HTTPS 与盒子本地账号连接；回环 HTTP 只供本机开发。

标准 `omniaauth.OpenMessageStream` 通过 `Authorization: Bearer` 请求头认证，检查过的旧 WANX 服务端 WebSocket 接口只接受 query/start-frame token。服务端需要兼容请求头后才能验证 P2P 聊天、终端、通知和远程画面。客户端不提取标准 SDK 内部 token，也不修改 SDK 来注入地址参数。标准托管身份禁止通用认证路径（`/api/auth/me` 除外）；切换/退出通过宿主生命周期处理，本地密码操作需由兼容接入或明确的服务端接口提供。

SDK 普通请求整体上限为 2 MiB，尚无上传流。大附件须后续使用已批准的分块上传合同，不能因保留 UI 就宣称支持。

## 打包

`npm run package:mac` 生成 macOS 开发目录包；`npm run package:windows` 生成 Windows NSIS 安装包。每个发行目标都需先构建对应原生宿主（`python3 packages/wanx-client-adapter/tools/build_native.py darwin-arm64 darwin-x64 win32-x64 win32-arm64`，在适配层目录运行时使用 `tools/build_native.py`）。macOS 正式签名、公证、Windows 真机安装及真实盒子网络验收分别完成后才可发行。

公司私有客户端；原框架及第三方许可证保留。验证以本工程实际记录为准，历史材料不等于本次验收。
