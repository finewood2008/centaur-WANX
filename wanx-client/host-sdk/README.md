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

`request(path, {method, headers, body, signal})` 返回标准 `Response`，保留 JSON 对象、字符串、Buffer/Uint8Array 调用，并支持 Node `Readable`（如文件流）和 Web `ReadableStream<Uint8Array>` 请求体。SDK 和 Host 按背压流式转发，不设置 HTTP 请求体的固定大小上限；文件大小由盒端业务接口校验，盒端 413 的状态码和响应体原样返回。multipart 由调用方编码为流或 Buffer，并设置匹配的 `Content-Type` boundary。

```js
const {createReadStream} = require('node:fs');
const controller = new AbortController();
const response = await host.request('/api/your-upload-endpoint', {
  method: 'POST',
  headers: {'content-type': 'application/octet-stream'},
  body: createReadStream('/path/to/large-file.bin'),
  signal: controller.signal,
});
// 上例适用于接收原始字节的接口；multipart 接口需使用相应编码流。
```

流只消费一次。调用 `controller.abort()`、关闭 SDK、会话失效或盒端提前拒绝时，SDK 会销毁 Node 源流或取消 Web 源流，并停止上传，不自动重放请求或跟随重定向。流式上传期间默认 15 秒为连接空闲超时，持续传输不受总上传时长限制；上传完成后默认等待响应头最多 15 秒。收到响应头后，响应流（包括 SSE）不受该期限限制。已有非流请求的响应头超时保持不变。`openStream(path)` 返回连接中的 `ws` 对象，调用方立即订阅 `open/message/close/error`；目前允许 `/api/agents/{id}/chat/ws`。

Host 注入 `WANX_HOST_TRANSPORT=http-v1`、`WANX_HOST_BASE_URL=http://127.0.0.1:<临时端口>`、`WANX_HOST_TOKEN`。令牌只用于本地网关，每次启动重新生成，只存在主进程内存。不可传给 renderer、持久化、记录日志或拼进 URL。SDK 在存在不完整或旧版 Host 环境时明确报错，不降级到 LAN。

请求方法、业务路径和返回数据保持盒端原协议。网关换用盒端凭证；应用无法取得盒端 access token。SDK 只对网关自有 `X-Wanx-Error` 转为带 `code` 的 Error：`NETWORK_NOT_READY` 可在网络恢复后由业务决定重试；`HOST_SESSION_EXPIRED` 必须停止操作、清理应用内会话，回万象重新打开应用。切换盒子、断开、退出账号、盒端会话失效以及 Host 退出都会终止当前 launch；不会切到另一台盒子，不会自动重放写请求。

结束进程时调用 `host.close()`。默认监听只在 `context()` 后启动；不使用 SDK 的客户端仍受网关的实时撤销保护。

## 自带 Electron 的独立应用

万象支持包含完整 Electron 运行时的 ZIP 应用包。manifest 设置 `launchMode: "bundled"`，声明 `platform`、`arch`，`entrypoint` 指向包内可执行程序；安装包仍需包含根级 `application.manifest.json`。

SDK `0.2.0` 提供独立应用的启动接入，在主进程入口最前面、获取单实例锁和创建窗口之前调用：

```js
const {attachElectronHost} = require('@centaurai/wanx-host-sdk/electron');
attachElectronHost();
const {fromEnvironment} = require('@centaurai/wanx-host-sdk');
const host = fromEnvironment();
```

helper 在万象启动时设置独立数据目录，窗口加载成功后报告就绪，并处理重复打开时的窗口唤起；未接入会触发万象的 30 秒启动超时。非万象启动时返回 `false`，保留应用自身的启动流程。业务请求和失效通知仍由 `host` 处理。`launchMode: "shared"` 或未声明模式的应用使用万象内置 Electron，已有启动包装自动完成窗口生命周期处理，无需调用此 helper。

打包：在本目录运行 `npm pack`，将生成的 tgz 作为应用的生产依赖安装。当前包用于本地交付，尚未上传 npm registry。

## v3 资源绑定

应用发行清单明确声明 `compatibility.resourceDependencies` 后，Host 在打开应用前准备全部必需资源，并将本账号、本盒子、当前制品的真实绑定放入 `context().resourceBindings`。不要按专家名称自行选择或创建实例。

```js
const expert = await host.resolveResourceBinding('expert', 'zhijun-personal-companion');
// expert.instanceId is verified by the box preparation flow.
const response = await host.requestExpert('zhijun-personal-companion', '/threads');
```

`resolveResourceBinding` 每次检查当前 Host 会话；缺少精准绑定会抛出 `APPLICATION_RESOURCE_NOT_BOUND`。技能包绑定包含 `packageId`。旧 schema1/2 应用的 `context/request/openStream` 行为不变；它们不会自动改用新实例。
