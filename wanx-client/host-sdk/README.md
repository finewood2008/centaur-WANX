# @centaurai/wanx-host-sdk

供 Electron **主进程**使用的轻量传输 SDK，不含业务 API、NetBird 或应用商店逻辑。

```js
const {fromEnvironment} = require('@centaurai/wanx-host-sdk');
const host = fromEnvironment(); // 无 Host 环境时返回 null，继续原 Web/LAN 模式
if (host) {
  host.onSessionInvalidated(() => clearLocalSessionAndCloseChats());
  const context = await host.context(); // 必须先初始化；同时建立会话失效通知
  const response = await host.request('/api/agents');
  const agents = await response.json();
}
```

`request(path, {method, headers, body, signal})` 返回标准 `Response`，支持 JSON 对象、字符串、Buffer/Uint8Array 和增量 SSE。multipart 调用方编码为 Buffer 并保留 boundary。不会自动重放请求或跟随重定向；15 秒默认超时仅约束响应头，SSE 不受此期限限制。`openStream(path)` 返回连接中的 `ws` 对象，调用方立即订阅 `open/message/close/error`；目前允许 `/api/agents/{id}/chat/ws`。

Host 注入 `WANX_HOST_TRANSPORT=http-v1`、`WANX_HOST_BASE_URL=http://127.0.0.1:<临时端口>`、`WANX_HOST_TOKEN`。令牌只用于本地网关，每次启动重新生成，只存在主进程内存。不可传给 renderer、持久化、记录日志或拼进 URL。SDK 在存在不完整或旧版 Host 环境时明确报错，不降级到 LAN。

请求方法、业务路径和返回数据保持盒端原协议。网关换用盒端凭证；应用无法取得盒端 access token。SDK 只对网关自有 `X-Wanx-Error` 转为带 `code` 的 Error：`NETWORK_NOT_READY` 可在网络恢复后由业务决定重试；`HOST_SESSION_EXPIRED` 必须停止操作、清理应用内会话，回万象重新打开应用。切换盒子、断开、退出账号、盒端会话失效以及 Host 退出都会终止当前 launch；不会切到另一台盒子，不会自动重放写请求。

结束进程时调用 `host.close()`。默认监听只在 `context()` 后启动；不使用 SDK 的客户端仍受网关的实时撤销保护。

打包：在本目录运行 `npm pack`，将生成的 tgz 作为应用的生产依赖安装。当前包用于本地交付，尚未上传 npm registry。
