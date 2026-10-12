# WANX Host 应用接入

`wanx-client` 负责账号、网络、盒子连接、应用安装和启动。Electron 应用保持独立进程；业务接口、数据库及专家运行在盒子上。应用主进程通过本地 HTTP 网关复用 Host 已建立的连接，不持有盒端 JWT、网络密钥或真实盒端地址。

```text
应用 renderer → 应用本地业务服务 → Host SDK / 标准 HTTP 客户端
    → 127.0.0.1 临时网关 → 已绑定盒子的鉴权与网络隧道 → 盒端 /api
```

## 安装与启动

应用目录包含 `package.json`、`application.manifest.json`、Electron 入口、构建产物和生产依赖。manifest 仍采用 `protocolVersion: 1`，声明 `runtime: "electron"`、相对入口，以及 `identity.read`、`http.request`、`chat.stream` 等 capabilities。manifest 版本与传输协议独立。

Host 安装时按 `applicationId/version` 保存完整目录。启动前必须登录、主网就绪并连接盒子，且盒端 `/api/auth/me` 成功。每次 launch 创建独立 HTTP listener 和随机 token；多个应用不会共享应用凭证。应用重复打开可复用有效进程，切换盒子或版本后重新启动。

新版通道环境变量：

| 变量 | 含义 |
|---|---|
| `WANX_HOST_TRANSPORT` | 固定 `http-v1` |
| `WANX_HOST_BASE_URL` | `http://127.0.0.1:<随机端口>`，没有 `/api` 后缀 |
| `WANX_HOST_TOKEN` | 本次 launch 的本地凭证 |
| `WANX_HOST_CLIENT_APPLICATION_ID` | manifest 中的应用 ID |
| `WANX_HOST_LAUNCH_ID` | 每次启动的新会话 ID |

迁移期间 Host 同时保留 `WANX_HOST_SOCKET` 和旧 NDJSON IPC。新版知君只使用 `http-v1`；旧 Host 启动新版知君会报协议不支持，不能降级到 LAN。令牌只在应用主进程使用，不传入 URL、renderer、磁盘、日志或打包配置。

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

不使用 SDK 也可在主进程用 `baseURL + /api/...` 和 `Authorization: Bearer <WANX_HOST_TOKEN>`。`GET /__wanx/context` 读取启动时绑定的用户及盒子；`GET /__wanx/events` 是 SSE，提供 `connection`（ready/recovering）和 `invalidated` 事件。两个控制接口需要 `identity.read`，HTTP 需要 `http.request`，聊天 WS 需要 `chat.stream`。其他 manifest 能力目前为声明信息，不代表细粒度业务授权。

网关只绑定 loopback，校验 Host、拒绝浏览器 Origin 和跨站请求，不提供 CORS。只允许盒端 `/api/` 和当前聊天 WS 路径；应用不能指定其他目标、提交 URL token 或注入盒端认证头。Host 使用既有盒端会话替换认证，并移除 cookie、access-token、redirect 等敏感响应头。它是可信桌面应用的接入通道，并非对任意本机恶意进程的操作系统沙箱。

## 连接生命周期

| 情况 | 网关 / SDK | 应用行为 |
|---|---|---|
| 网络临时恢复 | 保留盒子 lease，新请求报 `NETWORK_NOT_READY` / HTTP 503 | 显示连接中，由业务决定何时重试，不自动重发写请求 |
| 切换盒子、断开、关闭网络、退出账号 | 撤销旧 launch，取消 HTTP/SSE/WS，通知失效 | 清空当前身份与业务会话，回万象重新打开 |
| 盒端会话过期或返回 401 | `HOST_SESSION_EXPIRED` / HTTP 401，撤销整个 launch | 同上 |
| Host 退出或事件通道中断 | SDK 将会话标记失效并停止请求 | 同上 |
| 应用退出 | launcher 回收网关、token 和旧 IPC | 无凭证持久化 |

网关错误用 `X-Wanx-Error` 标识，SDK 转为带 `code` 的 Error；其余业务响应仍是 `Response`。安全隔离由 Host 强制执行，应用不处理通知也无法继续访问。重连同一台盒子也不能恢复旧 launch；不能把旧请求自动转给新盒子。

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

当前仍是本地目录安装；应用上传、签名校验、远程下载、版本更新服务不在此次范围。

## Seam 验证

```sh
# 万象仓库
node --test wanx-client/tests/*seam.test.mjs wanx-client/tests/setup-preload.test.mjs
node --test --test-name-pattern='application connection seam' wanx-client/tests/platform-client.test.mjs
# 可选跨仓库：知君已完成 desktop 准备；以 Node 替代 Electron 窗口运行真实应用子进程
WANX_ZHIJUN_ROOT=/path/to/centuarai-wanx-zhijun node --test wanx-client/tests/zhijun-host-seam.test.mjs
# 知君仓库
node --test desktop/tests/host-client.test.cjs desktop/tests/host-runtime-seam.test.cjs desktop/tests/direct-runtime.test.cjs tests/connections.test.mjs
npx vitest run src/host-session-seam.test.tsx
```

覆盖真实 loopback HTTP 和 WebSocket、SDK、安装/启动环境、JSON/二进制/multipart、SSE、首帧、取消、撤销竞态、网络恢复、切换/退出/过期、新会话凭证，以及 Web/LAN 登录和恢复。盒子业务由测试 fixture 提供，不依赖 102 或线上账户。
