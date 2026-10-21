# TB06 新商品、自定义充值与旧客户端合同

日期：2026-10-20。依据：[实施方案](credit-implementation-plan.md)、[tracer 验收](credit-tracer-tasks.md)。本合同已经编码并在隔离环境验证；不表示生产已启用。

## 金额与版本

| 支付金额 | 到账积分 | amount_fen | grant_credit_atoms |
| --- | --- | --- | --- |
| 10 元 | 1000 | 1000 | `1000000000` |
| 50 元 | 5000 | 5000 | `5000000000` |
| 100 元 | 10000 | 10000 | `10000000000` |
| 200 元 | 20000 | 20000 | `20000000000` |
| 500 元 | 50000 | 50000 | `50000000000` |

自定义金额为 10～1000 整数元，含端点；传输为整数分，1000～100000 且整除 100。9、1001、10.50 元及布尔、浮点、字符串金额均拒绝。没有优惠或加赠。商品规则 `wanx-recharge-100-v2` 与面值规则 `usd-credit-100-v2` 分开；积分精度为 6，内部 USD 精度仍为 8。新订单 `grant_credit_atoms=amount_fen×1000000`，冻结的 `qeetoken_delta_atoms` 数值与它相同；仅服务端计算。

## Consumer 接口

继续使用 Consumer 鉴权、签名及 `schema_version=1` 信封。v2 读取通过新路径和 `view_version=2` 标识，不改变旧路径含义。

| 接口 | 合同 |
| --- | --- |
| `GET /app-api/v1/credits/catalog/v2` | 五档 products、payment_channels、recharge_enabled、timezone；`currency_rule_id=usd-credit-100-v2`、points_per_yuan=100、`custom_amount={min_fen:1000,max_fen:100000,step_fen:100}`。停用或账号未完成展示基准时不允许购买 |
| `GET /app-api/v1/credits/quote/v2?amount_fen=1100` | 返回 `view_version=2`、currency_rule_id、credit_scale、rule_id、amount_fen=1100、grant_credit_atoms=`1100000000`；重复或额外查询字段拒绝 |
| `POST /app-api/v1/credits/orders` | 原路径，新增可选 `currency_rule_id=usd-credit-100-v2` 购买能力标识；五档传 product_id + product_version，自定义传 amount_fen。两种输入互斥，禁止客户端提交到账积分 |

自定义请求示例（Header `Idempotency-Key` 必须与 purchase_intent_id 相同）：

```json
{
  "schema_version": "1",
  "purchase_intent_id": "stable-client-intent",
  "currency_rule_id": "usd-credit-100-v2",
  "amount_fen": 1100,
  "payment_channel": "alipay"
}
```

报价是只读预览，不锁定可售状态；下单再次检查账号展示基准、已发布规则、启停、活动订单及渠道。五档同时检查商品版本。订单保存支付金额、积分、规则、渠道商户和 USD 冻结快照，付款后按该快照履约，不能从当前商品反算。

客户端先选商品（自定义金额先获取服务端报价），再进入支付方式确认页。选择商品、返回更换商品和切换渠道均只修改本地选择，不建单或关单。点击“确定支付”时先持久保存原意图、金额/商品版本、渠道和能力标识，再发起一次建单并显示独立的二维码支付视图；不保存或提交客户端计算的到账积分。重启重发完全相同的原请求。输入金额修改会清除报价；付款处理中隐藏商品和渠道选择，避免改动原购买意图。

确认前“取消”直接退出，不产生支付责任。二维码页“取消支付”请求关闭原订单，只有明确关闭后才能重新选择；未知结果和付款竞争继续恢复原单。右上角关闭或 Escape 只收起支付弹框，不等同取消支付。

## 旧客户端与原单恢复

最低支持能力采用明确的 v2 合同标识，不猜测 User-Agent 或客户端版本号。已建立 v2 展示基准或已发布 v2 充值规则时，缺少 currency_rule_id 的**新**请求返回 `UNSUPPORTED_SCHEMA`，不能创建旧三档新订单。v2 请求若账号或发布规则未准备好，则返回 `QEETOKEN_MIGRATION_PENDING`。旧 catalog 始终保持原 20 积分/元字段语义，但上述账号/规则下 recharge_enabled=false、upgrade_required=true；新版客户端显示升级提示。

旧 DTO 的缺省新增字段不计入原业务哈希。相同账号与 purchase_intent_id 的既有订单在版本、启停、商品检查之前返回原单；原 hash 冲突仍拒绝。原支付核验、查询、关单、回调及恢复继续履行原 USD 责任。新版客户端仅在无 order_id、无活动本地订单且收到明确拒绝建单错误时清除意图；网络/认证错误和未知结果继续保留。

已发行旧二进制能否显示具体升级文案取决于其错误呈现能力；服务端拒绝不依赖它是否识别提示。正式分发的最低安装版本和旧二进制现场升级体验须在 TB10 发布演练中确认。本轮验证了旧 DTO 与持久旧意图兼容，未宣称执行所有历史安装包。

## 管理发布与恢复

`POST /nexus/credits/config/recharge-v2` 需 `credits:config`、Idempotency-Key，以及 `schema_version/operation_id/expected_revision/reason`；没有可传金额、积分或规则的字段。QeeToken billing 必须启用。操作在配置行锁内递增 revision、记录审计与幂等回执，生成五档及固定新规则，**总是将 recharge_enabled 置 false**。原状态已 published 时同时插入新不可变规则；草稿在随后首次启用时发布。原规则、订单、回执保留。

发布原操作的重放返回原结果；新的重复发布被拒绝。即使仍为草稿，v2 规则也不能被旧 initial 接口覆盖。v2 商品只允许编辑名称、上架状态；金额、积分、五档身份固定。管理订单表区分原单冻结积分与带规则 ID 的当前面值积分，不能将原始字段当新积分汇总。

部署/启用顺序：

1. 确认 TB02–TB05 迁移及兼容服务已部署，支付配置已通过原渠道验收；保持新充值关闭。TB06 无新增 SQL，也不修改现有 SQL。
2. 发布具有 v2 钱包、报价与恢复能力的客户端。按 TB05 完成账号来源核实和展示基准；不允许通过新充值接口绕过基准门槛。
3. 读取当前配置 revision，使用持久 operation_id 和原因执行 recharge-v2；核对五档、停用状态与审计。丢失响应恢复同一操作。
4. 单独通过原 availability 操作启用新充值，仍需部署材料验证。只有账号基准和发布规则均就绪的新客户端可下单。
5. 异常时关闭新购买并继续原订单核验/恢复；不得删除已发布规则、展示基准或已冻结订单以回退。

这里是操作合同，本次开发没有执行生产发布命令或实际充值。

## QeeToken 原生入口

以 `wanx_accounts.user_id` 持久映射识别 WANX，不以邮箱、前端按钮或用户自报身份判断。原生 PaymentService.CreateOrder 及配置、套餐、渠道、checkout、limits 的用户 handler 检查映射；用户兑换码入口 RedeemByUser 同样检查，统一 403 `WANX_RECHARGE_REQUIRED`。查映射失败时拒绝新购买。

非 WANX 用户继续原生流程。已有订单查询、回调、核验及内部履约 Redeem 不调用新购买门控，避免既有收款责任悬空。WANX 不新增退款或补偿接口；已有原生纠错不受影响。历史原生购买造成的未知来源仍由来源账规则标记待核对，不伪装为正常 Admin 充值。
