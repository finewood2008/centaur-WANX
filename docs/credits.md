# WANX 积分客户端接入

WANX 接入 Admin 的积分购买与余额 API，支持支付宝、微信 Native 扫码支付。Admin 管理商品、订单、付款核验、恢复任务和余额投影，QeeToken 管理托管消费余额与扣款。支付业务规则见 [Admin 积分总览](../../nexusaos-admin/docs/credits.md)，字段及状态以 [Admin 支付 API 契约](../../nexusaos-admin/docs/contracts/credits-payment-api.md)为准，配置与回调见 [Admin 支付运维](../../nexusaos-admin/admin-backend/deploy/README-credits-payment.md)。

注册开户、盒子凭据、充值和余额/消费同步已在当前分支实现并完成隔离联调，未执行生产发布。职责与规则见 [系统说明](../../nexusaos-admin/docs/qeetoken-credit-system.md)，字段以 [实际 API](../../nexusaos-admin/docs/contracts/qeetoken-credit-api.md)为准。原始模型 key 只经设备认证链路交给 Bridge，不进入 renderer。

## 接入路径

| 位置 | 职责 |
| --- | --- |
| [账号传输](../wanx-client/account/index.mjs) | 使用 Consumer 会话和签名发送 `/app-api/v1/credits` 请求，刷新会话，校验响应信封 |
| [钱包适配器](../wanx-client/account/credit-wallet.mjs) | 构造商品、余额、订单请求，保留错误码及请求 ID，精确处理 atoms |
| [主进程 IPC](../wanx-client/shell/control.mjs) | 校验管理窗口来源与登录状态，将受限请求交给钱包适配器 |
| [页面](../wanx-client/local-ui/renderer/wallet-view.mjs) | 余额、渠道与商品选择、付款码、订单状态及购买恢复 |
| [渲染入口](../wanx-client/local-ui/renderer/wallet-entry.mjs) | 将二维码库和页面打包到本地资源，不把付款材料发送给外部二维码服务 |

账号登录和积分购买共用 Consumer 服务，默认地址为 `https://boss.nexusaos.qitus.cn/prod-api`，切换环境使用 `WANX_CONSUMER_URL`。`WANX_CREDITS_URL` 和 `credits-service.json` 属于旧独立积分服务，不用于 Admin 钱包购买。支付商户私钥、API v3 Key 和渠道调用只在 Admin；客户端不需要公众号 AppSecret。

不通过盒端 Octop API 确认付款或增减积分，也不依赖盒子在线。Consumer 鉴权与 Octop API 鉴权分别维护。

## 页面与恢复

积分页展示当前账号余额和购买入口；弹框先选择商品或自定义金额、选择支付渠道，再点击“立即支付”。打开弹框、选择商品、输入金额和切换渠道都不下单，也不写入购买意图。后台余额刷新不阻止选择；确认付款前必须完成活动订单恢复。

商品购买提交 catalog 返回的商品 ID、版本和渠道，价格及到账积分以服务端商品为准。自定义充值使用 `catalog.custom_recharge` 的能力、版本和金额范围，按 **1 元兑换 100 积分**预览；金额最多两位小数，转成整数分后提交 `custom_amount_fen` 和 `custom_recharge_version`，不发送客户端计算的积分。服务端计算并冻结到账积分；旧 `amount_fen` 档位保持原契约。版本冲突时刷新商品，由用户重新选择。部署时先更新支持此契约的 Admin，再更新客户端；旧服务未提供该能力时显示“自定义充值暂不可用”。

点击“立即支付”后，先将稳定的 `purchase_intent_id` 和所选商品或自定义金额、版本及渠道保存到当前账号的本地存储。写入失败不发送购买请求；网络中断或重启后恢复同一意图。活动订单查询用于找回服务端订单，不能靠生成新意图绕开原单。收起弹框不取消订单，取消通过 Admin 的关单 API。Admin 持久化明确的取消请求并释放该订单对购买入口的占用后，返回 `purchase_released: true`；客户端仅在旧单未支付、未进入到账或核对流程时清除旧购买意图，恢复金额和渠道选择。重新点击“立即支付”才创建新意图。旧单仍可能处于 `close_pending`，由 Admin 继续关闭和核对，晚到的真实付款仍按原订单幂等入账；允许重选不表示原付款码已经失效。

取消响应丢失时保留原 `close_intent_id` 并重试。旧版 Admin 未返回释放标志时，客户端继续等待明确关闭，不自行解除购买限制。上线需先更新 Admin，再更新客户端；服务端会在重放既有消费者取消意图时释放仍被旧单占用的入口，同时保留其他待到账和核对中的购买限制。

付款材料由 Admin 创建；支付渠道可用时，“立即支付”的创建响应直接带回 `payment_action`，客户端本地编码二维码并到期撤下。网关暂不可用时保留 `creating` 订单，由恢复器继续处理；订单处于 `creating` 时每秒只查询当前订单，普通订单状态仍每 5 秒刷新，原付款材料未变化时复用二维码图像。页面分别展示等待付款、已付款待到账、已到账、关闭中和核对状态；本地倒计时、扫码或关闭弹框均不作为付款/关单证据。余额刷新失败仅重试查询。已完成订单保持可见，直到用户选择再次购买。

退出或切号时清空页面状态，响应通过账号代次检查，避免旧账号数据覆盖新账号。购买意图按账号隔离保留以便下次恢复。托管钱包显示原始消费和同步状态；充值历史继续通过订单查询。个人资料与快捷面板见[客户端资料说明](wanx-client-profile.md)。

## 构建与验证

```sh
npm ci --prefix wanx-client
npm run build:renderer --prefix wanx-client
npm test --prefix wanx-client
WANX_TEST_ELECTRON=1 node --test wanx-client/tests/credit-wallet-electron.test.mjs
```

提交页面源码和对应 `wallet.bundle.js`，保证发行包使用相同实现。传输、IPC、账号隔离、订单恢复与页面测试位于 `wanx-client/tests/credit-wallet*.test.mjs`。Admin 的跨仓测试调用 [客户端测试适配器](../wanx-client/tests/support/credit-admin-client.mjs)；它仅用于隔离测试，不配置真实支付凭据。

## 托管余额与设备凭据

QeeToken 托管账号固定 **1 USD = 1 积分**。钱包详情主数字保留六位积分精度，消费显示八位 USD 实际金额；导航与快捷面板保留两位小数摘要。客户端查询 Admin 的余额投影与同步状态，不直接访问 QeeToken 账户管理接口；pending 不显示零余额，stale 保留最后确认值。

一个 Consumer 可拥有多个盒子并共享余额，每个绑定有独立 key；转移不转移余额和历史消费。Bridge 须显式设置 `WANX_MODEL_PROVIDERS_PROTOCOL_VERSION=3`（代码默认仍为 v2），安装后 applied ACK。Admin 的 allowedModels 为空，Bridge 直接读取 QeeToken 模型目录。部署与迁移统一见 [Admin 上线手册](../../nexusaos-admin/docs/qeetoken-independent-deployment.md)。

客户端“盒子”页提供控制台认领码和所有权转移入口。认领使用 `POST /app-api/device-console-claims/redeem`，UUID v4 的 clientAttemptId 与 Idempotency-Key 相同，重试保留原意图；须启用 Admin 的 `NEXUSAOS_DEVICE_CONSOLE_CLAIM_ENABLED`。未联网设备仍走原蓝牙流程，转移交互见 [所有权转移](wanx-box-ownership-transfer.md)。

## 本地配置与验证范围

复制 `wanx-client/.env.example` 为 `.env.local`，只填写本地地址和 CA 公有证书：

```dotenv
WANX_CONSUMER_URL=https://admin.localtest.me
NODE_EXTRA_CA_CERTS="/absolute/path/to/rootCA.pem"
```

运行 `npm --prefix wanx-client run start:local`。此入口只允许本地 HTTPS，清除继承的账户端点和 Node TLS 绕过变量，强制使用 `.local/user-data` 独立账号目录；普通启动与发行版不自动读取该文件。Git 忽略 `.env.local/.env.*.local/.local`，Electron 与 Docker 排除本地配置。Vite 发布构建发现通用或当前模式 local 覆盖文件时会停止，发布须从干净 checkout/CI 构建。

本地已从 Electron 界面完成两账号注册、认领两盒、查看余额/消费、发起及接收转移，并核对旧 key 拒绝。客户端、Admin、QeeToken 与数据库是真实进程；短信、支付、模型上游和盒端设备为模拟。物理盒子 BLE/P2P、真实支付与付费上游未验收。服务启停、测试数据和复现命令统一见 [本地联调说明](../../nexusaos-admin/admin-backend/deploy/qeetoken-local/README.md)。
