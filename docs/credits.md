# WANX 积分客户端接入

WANX 接入 Admin 的积分购买与余额 API，支持支付宝、微信 Native 扫码支付。Admin 管理商品、订单、付款核验、恢复任务和权威账本。支付业务规则见 [Admin 积分总览](../../nexusaos-admin/docs/credits.md)，字段及状态以 [Admin 支付 API 契约](../../nexusaos-admin/docs/contracts/credits-payment-api.md)为准，配置与回调见 [Admin 支付运维](../../nexusaos-admin/admin-backend/deploy/README-credits-payment.md)。

积分消费和 Provider 关联尚未开始设计；客户端已有历史查询适配器不构成后续消费方案。

## 接入路径

| 位置 | 职责 |
| --- | --- |
| [账号传输](../wanx-client/account/index.mjs) | 使用 Consumer 会话和签名发送 `/app-api/v1/credits` 请求，刷新会话，校验响应信封 |
| [钱包适配器](../wanx-client/account/credit-wallet.mjs) | 构造商品、余额、订单请求，保留错误码及请求 ID，精确处理 atoms |
| [主进程 IPC](../wanx-client/shell/control.mjs) | 校验管理窗口来源与登录状态，将受限请求交给钱包适配器 |
| [页面](../wanx-client/local-ui/renderer/wallet-view.mjs) | 余额、渠道与商品选择、付款码、订单状态及购买恢复 |
| [渲染入口](../wanx-client/local-ui/renderer/wallet-entry.mjs) | 将二维码库和页面打包到本地资源，不把付款材料发送给外部二维码服务 |

不通过盒端 Octop API 确认付款或增减积分，也不依赖盒子在线。Consumer 鉴权与 Octop API 鉴权分别维护。

## 页面与恢复

积分页展示当前账号余额和购买入口；弹框先选渠道再选商品。打开弹框、切换渠道不下单。新购买提交 catalog 返回的商品 ID、版本和渠道，不自行计算价格或到账积分。版本冲突时刷新商品，由用户重新选择。

购买前将稳定的 `purchase_intent_id` 和所选商品/渠道保存到当前账号的本地存储。写入失败不发送购买请求；网络中断或重启后恢复同一意图。活动订单查询用于找回服务端订单，不能靠生成新意图绕开原单。收起弹框不取消订单，取消通过 Admin 的关单 API，结果未知时继续查询。

支付二维码在客户端本地生成，到期撤下。页面分别展示等待付款、已付款待到账、已到账、关闭中和核对状态；本地倒计时、扫码或关闭弹框均不作为付款/关单证据。余额刷新失败仅重试查询。已完成订单保持可见，直到用户选择再次购买。

退出或切号时清空页面状态，响应通过账号代次检查，避免旧账号数据覆盖新账号。购买意图按账号隔离保留以便下次恢复。当前页面不展示历史订单、积分流水、模型调用或消费统计。个人资料与快捷面板见[客户端资料说明](wanx-client-profile.md)。

## 构建与验证

```sh
npm ci --prefix wanx-client
npm run build:renderer --prefix wanx-client
npm test --prefix wanx-client
WANX_TEST_ELECTRON=1 node --test wanx-client/tests/credit-wallet-electron.test.mjs
```

提交页面源码和对应 `wallet.bundle.js`，保证发行包使用相同实现。传输、IPC、账号隔离、订单恢复与页面测试位于 `wanx-client/tests/credit-wallet*.test.mjs`。Admin 的跨仓测试调用 [客户端测试适配器](../wanx-client/tests/support/credit-admin-client.mjs)；它仅用于隔离测试，不配置真实支付凭据。
