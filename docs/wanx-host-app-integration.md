# WANX Host 应用接入

`wanx-client` 负责账号、网络、盒子连接、应用安装和启动。Electron 应用保持独立进程；业务接口、数据库及专家运行在盒子上。应用主进程通过本地 HTTP 网关复用 Host 已建立的连接，不持有盒端 JWT、网络密钥或真实盒端地址。

```text
应用 renderer → 应用本地业务服务 → Host SDK / 标准 HTTP 客户端
    → 127.0.0.1 临时网关 → 已绑定盒子的鉴权与网络隧道 → 盒端 /api
```

## 安装与启动

首页通过在线应用市场安装和更新签名 `.wanxapp` 包，目录、候选和下载授权使用平台 API；详见 [应用市场开发与发布](wanx-application-market.md)。本地 ZIP／目录安装作为开发入口保留，须在未打包客户端设置 `WANX_ALLOW_DEVELOPMENT_INSTALL=1` 后通过控制 IPC 使用，正常页面不展示。开发 ZIP 根目录包含 `application.manifest.json`，也可多包一层目录。manifest 采用 `protocolVersion: 1`、`runtime: "electron"`，无需声明 `capabilities`；旧 manifest 中的该字段会被忽略。manifest 版本与传输协议独立。

支持两种交付形式：

| `launchMode` | ZIP 内容 | `entrypoint` | 运行时 |
|---|---|---|---|
| `shared`（省略时默认） | `package.json`、主进程代码、页面构建产物和全部生产依赖 | 如 `shell/main.cjs` | 复用万象内置 Electron，独立子进程 |
| `bundled` | 完整 Electron `.app` 或 Windows/Linux 解压版应用目录 | 如 `MyApp.app/Contents/MacOS/MyApp`、`MyApp/MyApp.exe` | 直接启动包内可执行程序 |

共享运行时示例：

```json
{
  "applicationId": "com.example.myapp",
  "name": "我的应用",
  "version": "1.0.0",
  "protocolVersion": 1,
  "runtime": "electron",
  "launchMode": "shared",
  "entrypoint": "shell/main.cjs"
}
```

独立运行时示例（macOS Apple Silicon）：

```json
{
  "applicationId": "com.example.myapp",
  "name": "我的应用",
  "version": "1.0.0",
  "protocolVersion": 1,
  "runtime": "electron",
  "launchMode": "bundled",
  "platform": "darwin",
  "arch": "arm64",
  "entrypoint": "MyApp.app/Contents/MacOS/MyApp"
}
```

独立包必须声明 `platform`（`darwin` / `win32` / `linux`）和 `arch`（`arm64` / `x64`；macOS 也支持 `universal`）；共享包可选声明，例如包含平台原生依赖时。安装和启动均拒绝不匹配的系统或架构。Windows 示例使用 `platform: "win32"`、`arch: "x64"`、`entrypoint: "MyApp/MyApp.exe"`。ZIP 内应包含完整解压版运行文件，不能只放安装向导 `.exe`、`.msi` 或 `.dmg`。

独立应用在主进程最前面调用 SDK 的 Electron 生命周期接入（需 SDK `0.2.0`）：

```js
const {attachElectronHost} = require('@centaurai/wanx-host-sdk/electron');
attachElectronHost(); // 在单实例锁和创建窗口前调用；非万象启动时返回 false
const {fromEnvironment} = require('@centaurai/wanx-host-sdk');
const host = fromEnvironment(); // 后续业务通过 host.context/request/openStream 接入
```

该接入设置万象提供的独立用户数据目录，在窗口首次加载成功后报告启动完成，并处理重复打开时的窗口唤起。未接入的独立应用会因无法报告就绪而启动超时；现有共享运行时应用由万象自动处理这些事件，无需调用此 helper。业务会话失效仍需按下文处理。

压缩包最大 2 GiB，解压内容最大 4 GiB、最多 100,000 个条目。解压保留 Unix 执行权限和 macOS 包内相对符号链接；Windows 包不要包含符号链接。拒绝越界路径、外部链接、重复路径、损坏内容和伪造的安装记录。校验失败会清理临时文件，不覆盖已安装版本；新包版本号必须符合 SemVer（例如 `1.2.3`，支持预发布与构建标记）；拒绝同版和低版安装，构建标记不提高版本优先级。同一应用仅展示一个当前版本，新包完整准备并提交后更新当前版本记录。旧版仍在运行时保持原进程和目录，下次打开才确认旧进程退出并启动新版；新版首次成功启动后清理已不用的旧目录；市场包保留上一份签名安装供用户显式回退。首次启动失败保留新版为当前版本并允许重试，不自动回退共享用户数据。

历史安装没有当前版本记录时，选择最高可比较版本；含无法比较的旧标签或相同优先级的不同构建时，应用卡片要求用户选择并保存结果，选择前保留文件且不自动启动。旧标签迁移到规范版本也需明确选择，不猜测二者高低。

开发包按 `applicationId/version`、市场包按 `applicationId/artifactId` 保存完整目录，共用当前版本解析与 launch 生命周期。启动前必须登录、主网就绪并连接盒子，且盒端 `/api/auth/me` 成功。每次 launch 创建独立 HTTP listener 和随机 token；多个应用不会共享应用凭证。应用重复打开复用有效进程；准备中的并发打开合并。切换盒子或当前版本后，先回收旧 launch 再启动。停止覆盖安装记录读取、会话准备和等待窗口阶段，取消后的迟到会话也会关闭。停止先撤销凭证，再等待主进程退出：5 秒未退出则强制终止，再等 2 秒仍不能确认退出时报错并保留跟踪；停止期间的打开合并等待，回收失败不能创建替代进程。Host 退出禁止新的启动并等待在途操作回收，重复点击退出不能绕过等待；应用回收失败则提示并允许重试退出。

新版通道环境变量：

| 变量 | 含义 |
|---|---|
| `WANX_HOST_TRANSPORT` | 固定 `http-v1` |
| `WANX_HOST_BASE_URL` | `http://127.0.0.1:<随机端口>`，没有 `/api` 后缀 |
| `WANX_HOST_TOKEN` | 本次 launch 的本地凭证 |
| `WANX_HOST_CLIENT_APPLICATION_ID` | manifest 中的应用 ID |
| `WANX_HOST_LAUNCH_ID` | 每次启动的新会话 ID |
| `WANX_HOST_USER_DATA_DIR` | 独立运行时应用的数据目录，由 Electron helper 在启动早期设置 |

应用 Host 通道仅使用 `http-v1`，不再提供 `WANX_HOST_SOCKET` 或旧应用 Host NDJSON。应用启动的 ready / failed / activate 子进程 IPC、控制页面 IPC 和网络 sidecar 的私有 NDJSON 保留。旧 Host 启动新版知君会报协议不支持，不能降级到 LAN。令牌只在应用主进程使用，不传入 URL、renderer、磁盘、日志或打包配置。

## HTTP 协议与轻量 SDK

SDK 源码在 `wanx-client/host-sdk/`，包名 `@centaurai/wanx-host-sdk`。运行 `npm pack ./wanx-client/host-sdk --pack-destination <交付目录>` 生成 tgz，应用以生产依赖安装；当前未上传公共 registry。它只负责传输和生命周期，不包装专家、记忆、对话等业务 API。

```js
const {fromEnvironment} = require('@centaurai/wanx-host-sdk');
const host = fromEnvironment();
if (host) {
  host.onSessionInvalidated(() => clearSessionAndCloseChats());
  const context = await host.context(); // 初始化，包括失效事件通道
  const response = await host.request('/api/agents');
  const agents = await response.json();
}
```

业务 HTTP 方法、`/api/...` 路径、JSON、multipart 字节、响应状态和业务数据保持原协议。SDK 返回标准 `Response`，SSE 增量读取；WebSocket 用 `openStream('/api/agents/{id}/chat/ws')` 返回连接中的 `ws`，立即安装 `open/message/error/close` 处理器。支持取消请求；不会自动重放写操作或跟随重定向。上传上限 32 MiB，multipart 的编码与 boundary 由调用方保持。

不使用 SDK 也可在主进程用 `baseURL + /api/...` 和 `Authorization: Bearer <WANX_HOST_TOKEN>`。`GET /__wanx/context` 读取启动时绑定的用户及盒子；`GET /__wanx/events` 是 SSE，提供 `connection`（ready/recovering）和 `invalidated` 事件。当前 HTTP 网关不按应用 capability 限制访问，持有效启动凭证的应用可使用已有上下文、HTTP/SSE 和聊天 WS 通道；业务权限仍由盒端按当前用户校验。

网关只绑定 loopback，校验 Host、拒绝浏览器 Origin 和跨站请求，不提供 CORS。只允许盒端 `/api/` 和当前聊天 WS 路径；应用不能指定其他目标、提交 URL token 或注入盒端认证头。Host 使用既有盒端会话替换认证，并移除 cookie、access-token、redirect 等敏感响应头。它是可信桌面应用的接入通道，并非对任意本机恶意进程的操作系统沙箱。

## 连接生命周期

| 情况 | 网关 / SDK | 应用行为 |
|---|---|---|
| 网络临时恢复 | 保留盒子 lease，新请求报 `NETWORK_NOT_READY` / HTTP 503 | 显示连接中，由业务决定何时重试，不自动重发写请求 |
| 切换盒子、断开、关闭网络、退出账号 | 撤销旧 launch，取消 HTTP/SSE/WS，通知失效 | 清空当前身份与业务会话，回万象重新打开 |
| 盒端会话过期或返回 401 | `HOST_SESSION_EXPIRED` / HTTP 401，撤销整个 launch | 同上 |
| Host 退出或事件通道中断 | SDK 将会话标记失效并停止请求 | 同上 |
| 应用退出 | launcher 关闭启动会话，回收 HTTP listener、token 和流 | 无凭证持久化 |

网关错误用 `X-Wanx-Error` 标识，SDK 转为带 `code` 的 Error；其余业务响应仍是 `Response`。安全隔离由 Host 强制执行，应用不处理通知也无法继续访问。重连同一台盒子也不能恢复旧 launch；不能把旧请求自动转给新盒子。

Host 的启动会话由 `wanx-client/app-host/session.mjs` 管理，公开 `launchId`、`environment`、`assertLive()` 和 `close()`。自然失效只撤销权限、取消操作并通知 SDK，保留本地监听器，使后续持原凭证的请求收到 `401 HOST_SESSION_EXPIRED`；launcher 最终调用 `close()` 时先同步撤销，再异步关闭本地监听器、流和心跳。会话不负责结束应用进程或关闭共享盒子连接，关闭完成也不意味着盒端已执行的远端操作被撤回。SDK 自身的 `close()` 只清理客户端资源，不撤销 Host 会话。

## 知君接入

`desktop/shell/host-client.cjs` 直接导出 SDK，业务层继续使用 `request()` / `openStream()`。`runtime.cjs` 启动时获取 context，无任何 Host 环境时继续 Web/LAN。`server/app.mjs` 在失效时清理 Host 会话、关闭聊天并返回状态；页面清除旧内容并提示回万象重新打开。失效后的 Host 应用不会显示 LAN 登录入口。

知君本次应用版本为 `0.4.4`。根目录 manifest 入口为 `desktop/shell/main.cjs`；发行目录 `desktop/` 的入口为 `shell/main.cjs`。准备发行目录：

```sh
# 知君仓库
npm ci
npm --prefix desktop ci
npm run build
node tools/prepare-desktop.mjs
```

将准备好的 `desktop/` 完整目录安装到新版万象后启动；不要只发布 manifest 或源码入口。根目录开发安装仍需已构建 `desktop/server`、`desktop/renderer` 和依赖。旧安装目录不会被此次源码修改自动更新；重启新版 Host 后安装 `0.4.4`。

应用市场已经接入 Consumer 目录、候选、下载授权、Ed25519 发行验签和下载完整性检查；升级只在下次打开时切换。退出或切换账号取消下载授权，Host 退出同时取消下载并等待安装与应用回收。底座自身自动更新尚未实现。正式独立应用的签名、公证由应用发布方完成；万象不重签应用。

## Seam 验证

```sh
# 万象仓库
node --test wanx-client/tests/*seam.test.mjs wanx-client/tests/setup-preload.test.mjs
node --test --test-name-pattern='application connection seam' wanx-client/tests/platform-client.test.mjs
# macOS 可选：验证共享/独立运行时 × ZIP/目录四种组合，检查可见窗口、API、再次激活与会话撤销
WANX_ELECTRON_APP="$PWD/wanx-client/node_modules/electron/dist/Electron.app" node --test wanx-client/tests/bundled-electron-seam.test.mjs
# 可设置 WANX_ELECTRON_EVIDENCE_DIR 保存窗口截图和 results.json；WANX_PACKAGED_EXECUTABLE 可指定打包后的万象可执行文件。
# 可选跨仓库：知君已完成 desktop 准备；以 Node 替代 Electron 窗口运行真实应用子进程
WANX_ZHIJUN_ROOT=/path/to/centuarai-wanx-zhijun node --test wanx-client/tests/zhijun-host-seam.test.mjs
# 知君仓库
node --test desktop/tests/host-client.test.cjs desktop/tests/host-runtime-seam.test.cjs desktop/tests/direct-runtime.test.cjs tests/connections.test.mjs
npx vitest run src/host-session-seam.test.tsx
```

覆盖真实 loopback HTTP 和 WebSocket、SDK、安装/启动环境、JSON/二进制/multipart、SSE、首帧、取消、撤销竞态、网络恢复、切换/退出/过期、新会话凭证，以及 Web/LAN 登录和恢复。盒子业务由测试 fixture 提供，不依赖 102 或线上账户。
