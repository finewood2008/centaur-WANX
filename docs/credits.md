# WANX 积分文档与客户端接入

更新：2026-10-21。本文是三端积分文档统一入口。

最终业务规则见[WANX 积分业务规则（定稿）](credit-business-rules.md)，本期业务决策已全部确认，具体上线日期在实现并验收通过后、上线前确定。已确定的目标规则为“1 元购买 100 积分，100 积分对应 1 USD 计费余额”；模型毛利率目标为 30%，通过 QeeToken 模型定价与消费倍率控制，充值比例不变。目标客户端余额、消费及详情等只展示积分，不展示 USD、Token 用量或相关计价与换算比例，充值支付金额仍显示人民币；内部计费与对账继续保留原始单位。当前分支已完成 TB01–TB09 的开发和隔离验收及 TB10 本地交付，生产放行结论仍为 **NO-GO**，未执行生产迁移、赠送或统一切换；v2 五档和 10～1000 整数元自定义充值已按显式合同实现，发布操作保持新购买停用，仍须单独启用。完整证据见 [tracer 记录](credit-tracer-tasks.md)。

WANX 接入 Admin 的积分购买与余额 API，支持支付宝、微信 Native 扫码支付。Admin 管理商品、订单、付款核验、恢复任务和余额投影，QeeToken 管理托管消费余额与扣款。支付业务规则见 [Admin 积分总览](../../nexusaos-admin/docs/credits.md)，字段及状态以 [Admin 支付 API 契约](../../nexusaos-admin/docs/contracts/credits-payment-api.md)为准，配置与回调见 [Admin 支付运维](../../nexusaos-admin/admin-backend/deploy/README-credits-payment.md)。

注册开户、盒子凭据、充值和余额/消费同步已在当前分支实现并完成隔离联调，未执行生产发布。职责与规则见 [系统说明](../../nexusaos-admin/docs/qeetoken-credit-system.md)，字段以 [实际 API](../../nexusaos-admin/docs/contracts/qeetoken-credit-api.md)为准。原始模型 key 只经设备认证链路交给 Bridge，不进入 renderer。

## 文档导航

| 要查的内容 | 维护位置 |
| --- | --- |
| 最终业务决策、面值、赠送及迁移政策 | [业务规则](credit-business-rules.md) |
| 当前 TB 状态、最新验证及专题合同索引 | [任务状态](credit-tracer-tasks.md) |
| T01–T32 覆盖、证据时点与外部发布门槛 | [发布验收矩阵](credit-release-acceptance.md) |
| 部署运行时、schema、切换顺序及向前恢复 | [上线手册](credit-release-runbook.md)；Admin 线上为 Python 3.10，WANX/Bridge 另按自身运行时要求 |
| 30% 模型毛利核算与待填的实际成本证据 | [价格核算](credit-pricing-rehearsal.md) |
| Admin 支付/消费/管理字段 | [支付 API](../../nexusaos-admin/docs/contracts/credits-payment-api.md)、[QeeToken API](../../nexusaos-admin/docs/contracts/qeetoken-credit-api.md) |
| 设计背景与逐阶段命令/审查 | [原始实施方案](credit-implementation-plan.md)、[历史验收归档](archive/credit-tracer-tasks-20261021.md) |

业务规则、合同、验收矩阵和运行手册各自维护一个事实来源；历史设计和验收日志不作为当前操作指令。跨仓相对链接要求三个仓库位于同一父目录。

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

积分页展示当前账号余额和购买入口；弹框先选择商品，再选择支付渠道，点击确定后才创建订单并进入二维码支付页。确认前选择/更换商品和渠道只更新本地状态，取消不产生订单；自定义金额另需服务端报价。新购买提交 catalog 返回的商品 ID、版本和渠道，不自行计算价格或到账积分。版本冲突时刷新商品，由用户重新选择。自定义金额先向服务端获取报价，再确认购买；五档及自定义请求均显式携带 v2 能力。发布、兼容和原生入口限制见 [TB06 充值合同](credit-recharge-contract.md)。

用户点击确定后、发送建单请求前，将稳定的 `purchase_intent_id` 和所选商品/渠道保存到当前账号的本地存储。写入失败不发送购买请求；网络中断或重启后恢复同一意图。活动订单查询用于找回服务端订单，不能靠生成新意图绕开原单。收起弹框不取消订单，取消通过 Admin 的关单 API，结果未知时继续查询。

支付二维码在客户端本地生成，到期撤下。页面分别展示等待付款、已付款待到账、已到账、关闭中和核对状态；本地倒计时、扫码或关闭弹框均不作为付款/关单证据。余额刷新失败仅重试查询。已完成订单可确认完成或关闭，再返回商品选择；未完成责任继续按原单恢复。

退出或切号时清空页面状态，响应通过账号代次检查，避免旧账号数据覆盖新账号。购买意图按账号隔离保留以便下次恢复。托管钱包显示统一积分消费和同步状态；充值历史继续通过订单查询。个人资料与快捷面板见[客户端资料说明](wanx-client-profile.md)。

## 构建与验证

```sh
npm ci --prefix wanx-client
npm run build:renderer --prefix wanx-client
npm test --prefix wanx-client
WANX_TEST_ELECTRON=1 node --test wanx-client/tests/credit-wallet-electron.test.mjs
```

提交页面源码和对应 `wallet.bundle.js`，保证发行包使用相同实现。传输、IPC、账号隔离、订单恢复与页面测试位于 `wanx-client/tests/credit-wallet*.test.mjs`。Admin 的跨仓测试调用 [客户端测试适配器](../wanx-client/tests/support/credit-admin-client.mjs)；它仅用于隔离测试，不配置真实支付凭据。

## 托管余额与设备凭据

新版托管钱包读取 `/wallet/v2` 与 `/usage/v2`，采用明确的 `usd-credit-100-v2` 展示规则。主数字、消费、订单当前展示及快捷面板统一两位小数；真实非零但不足 0.01 的金额显示余额、消耗或欠费提示，不抹成零。页面不展示 USD、Token 用量或换算比例。未建立账号展示基准时为 pending；断页、离线或旧响应保留最后确认值并显示 stale。账号基准、旧合同兼容及部署顺序见 [TB05 展示合同](credit-display-contract.md)。

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
