# @centaurai/wanx-host-sdk

供 Electron **主进程**使用的传输 SDK，提供会话生命周期与万象网盘接口，不含 NetBird 或应用商店逻辑。

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

## 万象网盘（SDK 0.3.0）

`host.drive` 读写当前登录账号在当前盒子上的文件，与万象客户端“网盘”页面使用同一份存储。首版所有万象托管应用默认共享读写权限，无需声明 capability、授权弹窗或独立登录。安装其他账号的应用不会得到其他账号的文件；切换账号或盒子后原会话失效。盒端需要已部署 `/api/personal-space`；旧盒子的 `drive.overview()` 返回 `SPACE_UPGRADE_REQUIRED`。

```js
const {createReadStream, createWriteStream} = require('node:fs');
const {stat} = require('node:fs/promises');
const {Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');

const {items} = await host.drive.list();
const folder = await host.drive.mkdir({name: '项目资料'});
const report = await host.drive.upload({
  parent: folder.id, name: '分析结果.md', data: '# 分析结果\n…',
});
// 其他万象应用和网盘页面可以立即列出、读取 report.id。
await pipeline(Readable.from(host.drive.read(report.id)), createWriteStream('/chosen/report.md'));

// 大文件使用字节流；SDK 按 4 MiB 分块，校验每块和完整文件。
const localPath = '/chosen/material.pdf';
await host.drive.upload({
  parent: folder.id, name: 'material.pdf', size: (await stat(localPath)).size,
  data: createReadStream(localPath, {highWaterMark: 4 * 1024 * 1024}),
  onProgress: ({offset, size}) => updateProgress(offset, size),
});
```

接口包括 `overview/list/stat/mkdir/move/trash/restore/purge`、`upload/read`，以及断点接口 `createUpload/uploadStatus/writeChunk/completeUpload/cancelUpload`。应用可以直接使用 `host.request('/api/personal-space/...')`，旧 SDK 也无需升级即可通过 HTTP 使用网盘；网盘辅助方法需 SDK 0.3.0。

`upload` 支持 UTF-8 字符串、Uint8Array 和 AsyncIterable 字节流。流必须声明总 `size`；续传时传相同 `uploadId`，数据源仍从头提供，SDK 核对完整摘要并跳过已落盘字节。失败的 Error 带 `uploadId`，可在同一账号、同一盒子的新会话中显式续传；SDK 不会自动重放。用户取消旧传输时调用 `cancelUpload`。同名文件保留两份，不覆盖原文件。上传和续传期间应保持源文件不变。

`read` 返回字节流，消费完毕才完成整文件校验；写本机文件时应先写临时文件，完整校验成功后再替换目标。网盘请求响应头超时为 60 秒，整文件提交为 120 秒。通用 `request` 可以通过 `timeoutMs` 单独调整，SSE 的读取不受响应头超时限制。

网盘中的文件不会自动进入专家上下文或知识库。应用需要主动读取所需文件；文件存于盒子不代表应用调用外部模型时内容仍在本地，应用自己的模型发送流程应向用户说明。

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
