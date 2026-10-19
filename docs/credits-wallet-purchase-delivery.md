# WANX 积分购买与双渠道支付

客户端积分页面使用 Admin 的账号积分账本，展示余额和“购买积分”入口。购买弹框按服务端目录展示商品；先选择支付宝或微信，再点击商品生成所选渠道的二维码。商品价格、版本和积分数由 Admin 冻结，客户端不会按付款金额自行计算到账积分。

## 支付和恢复

- 支付渠道来自目录的 `payment_channels`；兼容旧服务端时默认支付宝。微信采用 Native 扫码，不需要客户端提供公众号 AppSecret。
- 打开弹框或切换渠道不会创建订单。下单后冻结渠道；取消时等待 Admin 确认关单，才能重新购买或换渠道。
- 购买意图在发送请求前按账号持久化；重复点击、断线和重启继续恢复同一购买。收起弹框不取消订单，二维码到期后停止显示。
- 创建中、待扫码、已支付待到账、到账、关闭确认、到期核对和异常状态分别提示。支付及积分到账只以服务端事实为准。
- 账号切换清除旧视图并丢弃迟到响应。弹框内支持 Tab/Shift+Tab 焦点循环和 Escape 收起。
- 订单、流水及调用查询接口保留，但当前购买页面不展示或预取完整历史列表。

## 连接和安全边界

账号登录和积分购买使用相同的 Consumer 服务，默认地址为 `https://boss.nexusaos.qitus.cn/prod-api`；需要切换环境时设置 `WANX_CONSUMER_URL`。

积分请求路径为 `/app-api/v1/credits/*`，沿用 Consumer 签名、账号会话和独立 nonce，校验版本化响应。支付商户私钥、API v3 Key 和渠道 API 调用只在 Admin 服务端。renderer 仅通过可信管理窗口的受限 IPC 操作钱包，无法传入任意服务地址或凭证。

`WANX_CREDITS_URL` 与 `credits-service.json` 属于旧独立积分服务配置，不用于本次 Admin 钱包购买。已有其他兼容调用不在本次改动范围。

## 本地启动和验证

```sh
npm --prefix wanx-client ci
npm --prefix wanx-client run build:renderer
npm run start:client
```

自动化验证覆盖签名请求、响应契约、IPC、商品与渠道选择、幂等购买恢复、二维码到期、关单/付款竞争和账号隔离：

```sh
npm --prefix wanx-client test
cd wanx-client
WANX_TEST_ELECTRON=1 node --test tests/credit-wallet-electron.test.mjs
```

2026-10-19，用户确认：Admin 部署后，本地 WANX 客户端的微信和支付宝付款均测试成功。这是正常付款路径的人工验收记录；异常回调、网络故障和重启等场景由隔离测试覆盖，不代表逐一完成生产故障演练。
