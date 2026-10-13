# 万象盒子所有权转移

此功能用于把已经认领的盒子交给指定客户账号，保留盒子上的业务数据。它不清空文件、聊天记录、模型或应用数据，也不把这些数据复制到另一台盒子。需要清空后重新认领时，使用 centuarai-os 的受控盒子清除流程。

相关文档：[清除并释放操作指南](../../centuarai-os/docs/box-handover.md)（相邻工程）、[P2P 部署与交接验收](wanx-auto-p2p-deployment.md)。转移所有权不等于把数据迁移到另一台盒子；跨盒数据搬迁不在本功能范围内。

## 原所有者

1. 更新并登录万象，打开「设置 → 我的盒子」。
2. 在自己拥有的盒子上点击「转移所有权」。共享给你的盒子不会显示该入口。
3. 填写客户用于登录万象的手机号。点击「发送验证码」，验证码发到你当前登录账号的手机号。
4. 填写验证码，确认盒内数据可以保留给客户，勾选同意后发送转移邀请。
5. 请客户在 24 小时内登录自己的万象账号并接受。仅发送邀请时，你仍是原所有者；为了避免混用，本机当前连接的该盒子会断开。

## 客户接受

1. 客户注册或登录上述手机号的万象账号。
2. 打开「设置 → 我的盒子」，在「所有权转移」中刷新待处理记录。
3. 点击「接受转移」，再次确认接收盒子及其保留的数据。
4. 平台提交所有权变更后，等待盒子同步新授权。刷新盒子列表，待授权和网络就绪后连接。

完成后原所有者及旧分享授权应撤销。接收成功后若列表刷新失败，界面会明确提示“所有权已接受，盒子列表暂未刷新”，不要重复发起转移。未保留数据的旧版邀请不能从新万象客户端接受，避免误认为已执行清除。

## 发布依赖与边界

- 需要配套 Admin 的 Consumer 所有权转移及授权撤销实现；盒端需支持当前授权快照确认协议。只有平台返回提交结果、盒端确认授权和网络权限就绪后，才能实际使用。
- 万象使用当前 Consumer 登录、设备签名和刷新机制，不要求用户额外登录网络管理后台。
- API 固定为 `GET /app-api/ownership/transfers`、`POST /app-api/devices/{deviceId}/ownership/transfer` 和 `POST /app-api/ownership/transfers/{transferId}/accept`。
- 发起请求的 `ownerPhone` 在主进程从当前登录记录取得，界面不能指定；`retainData` 必须为 `true`。界面不接触账号 token 或签名私钥。
- 账号切换、注销会取消旧操作，旧结果不会写回新账号界面。远程盒子页面、子 frame、快捷面板没有所有权管理 IPC 权限。
- 自动验证只使用模拟账号和盒子，没有执行真实转移或生产数据清除。发布后需用测试盒子、两个测试账号验证旧客户端断权及客户访问。

## 本地验证

在 `wanx-client` 下执行：

```sh
node --test tests/ownership-transfer.test.mjs tests/shell-auth.test.mjs tests/renderer-seam.test.mjs tests/platform-client.test.mjs
```

macOS 上可运行真实 Electron 表单验证（模拟 HTTP，不连接平台）：

```sh
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron tests/support/electron-ownership-transfer.mjs
```

覆盖所有者和客户两端、签名请求、拒绝非所有者、账号切换隔离、验证码按钮重复点击、网络状态刷新时保留表单、明确接受确认、更新后的盒子目录。完整客户端测试中 `host-http-seam.test.mjs` 的超大上传测试有既存传输关闭竞态，可能得到 `ECONNRESET/EPIPE` 而非预期业务错误；应单独复验并记录，不能将其算成转移流程通过。
