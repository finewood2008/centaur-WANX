# TB09 支付责任与切换预演合同

日期：2026-10-21。依据：[实施方案](credit-implementation-plan.md) §8、T04/T05/T25/T26/T30–T32；前置：[迁移合同](credit-migration-contract.md)、[注册补发合同](credit-registration-batch-contract.md)。本条交付本地责任盘点 API、支付恢复与隔离预演，不执行生产切换。

## 支付查询、关单与恢复

恢复器继续使用原 `purchase_intent_id`、`order_id`、`merchant_order_no` 和 `CreditWork`；网络超时、租约过期或切换面值都不能生成新订单。关单任务先查询渠道：只有明确 `pending` 才调用 close；`paid` 进入原单履约，`closed` 使用原终态，`unknown` 保持原任务待核对。关单返回 paid 仍按原冻结 USD 金额入账，未知关单结果允许后续已验证回调或查询继续确认。

本条没有修改渠道适配器的验签、商户、应用、人民币金额及币种核验，也不把本地过期当作渠道关单成功。原有“渠道确认的 unpaid_deadline 已过，之后 trade_not_found”的严格终态证据规则保留；它不同于没有该证明的普通 unknown。

每次 create/query/close 在网络 I/O 前先提交 `CreditWork.kind=payment_observation`，返回后记录结果与结束时刻。观察记录包含原 work_id、尝试次数、账号、订单号、渠道、商户、应用、分金额、动作、时间、返回状态及付款证据引用。超时或异常记 unknown 和稳定错误码；进程在请求后直接退出时留下未完成观察，查询视图显示 `OUTCOME_UNCONFIRMED`。未完成记录不伪造最终状态。

已验证付款的完整业务字段保存在内部 `verified_payment`，公开报告只返回必要摘要和证据引用，不返回付款码或原始渠道报文。原付款事务失败后，新的恢复器可读取该付款事实，再经过 `CreditOrders.apply_channel_result` 的订单关联、金额、商户及币种校验；不能绕过校验直接给另一订单入账。另一订单的错误观察不作为本单的缓存付款，也不阻止后续重新查询正确结果。付款回调仍使用原有付款记录与幂等约束。

`result_hash` 是规范化 `PaymentOutcome`（含空字段）的本地 SHA-256 摘要，不是渠道签名或第三方付款证明；付款证据引用另存。创建观察记录失败时不发出渠道请求；记录结果失败时原工作按租约恢复，未知结果仍需查询。观察表与恢复任务表复用，但 kind 不同，观察记录不被执行器领取。

## 不可变预演报告

| HTTP | 权限 | 行为 |
| --- | --- | --- |
| `POST /nexus/qeetoken/cutovers/preview` | `credits:reconcile` | 读取指定账号的本地一致快照，保存报告；不访问支付渠道，不关单、不迁移、不发放 |
| `GET /nexus/qeetoken/cutovers/{report_id}` | `credits:read` | 返回生成时的原报告；查看当前事实需另建预演操作 |

POST 使用现有严格 CreditRequest 协议：`schema_version="1"`、`operation_id`、`report_id`、`account_ids`、非空 `reason`，`Idempotency-Key` 必须对应 operation_id。账号范围为 1～100 个、排序去重的显式 ID。额外字段、查询参数及 `execute` 均被拒绝。

在账号顺序锁与同一事务内读取盘点、订单、原工作、支付观察、迁移阶段、钱包同步序号、注册资格与批次。同一管理员同一 operation 的相同请求返回原报告；更改范围或内容、复用报告 ID 均冲突。报告存入 `CreditWork.kind=cutover_preview`，不会排入付款或迁移执行队列。金额保持 atoms 十进制字符串，原订单金额与当前展示面值分别表达。

`report_hash` 覆盖完整规范化报告（不包含 report_hash 自身），可用现有 `digest` 对 HTTP `data` 重新计算；旧报告不随之后的付款、迁移或补发更新。报告 ID 仅是审计身份，不是资产、充值或注册领取身份。

### 逐账号下一步

按表中顺序判定，先处理未完成责任，再推进后续步骤：

| next_action | 含义 |
| --- | --- |
| `account_missing` | 指定账号不存在 |
| `resolve_payment` | 有未确认支付；先沿原单查询/核对 |
| `review_accounting` | 原账务未解、快照无法解释或未迁移旧欠额/在途责任 |
| `review_registration` | 缺少持久注册领取资格核对 |
| `resume_migration` | 已有未完成迁移阶段；恢复原任务 |
| `migrate_assets` | 历史剩余资产尚未承接；另走原迁移预演、审批和执行 |
| `review_sources_and_display` | 已有远端 USD 或新账号应核对来源及展示，不能重复加期初 |
| `fulfill_original_orders` | 期初完成后履约尚未到账的已付原单 |
| `sync_events` | 原有同步/迁移门控未满足；追平原事件 |
| `approve_registration` | 历史明确未领且其余门控通过；另走 TB08 显式审批 |
| `recover_registration` | 原赠送尚未完成；核对或恢复原资格 |
| `ready` | 报告生成时本地责任检查已通过 |

`ready` 不是未来执行授权，也不能证明远端之后没有新事件。预演不冻结线上交易，不替代实际维护窗口、实时核对或 TB07/TB08 执行前门控。实际执行仍由原服务重新校验；报告中 ready 的账号也可能在后续重新受阻。

## 窗口顺序与向前恢复

1. 按已批准的切换范围限制会竞争的新购买/扣费写入，保留回调和原任务恢复。TB09 未代替运营设置维护窗口或修改生产开关。
2. 查询旧订单；仅明确未付的尝试关闭。未知支付阻断迁移，实付保留原承诺。
3. 区分已经入账而尚未消费的剩余资产与“已支付、待到账”的订单义务。后者不能先混入迁移期初再履约。
4. 剩余旧资产按 TB07 原资产身份迁移一次；已有远端 USD 走来源核对与展示切换，不增加余额。丢响应恢复原 migration job/event，不新建资产。
5. 期初/展示完成后按原订单快照入账待履约旧单，追平事件。未结清订单阻断旧账号注册补发。
6. 原注册资格确认未领并获 TB08 授权后，按原 eligibility/event 发放固定 5 USD；批次不是领取身份。
7. 新建报告复核来源、原责任、同步及展示，结合实际窗口检查决定是否开放新规则。原旧 DTO 可恢复已存在意图，但不能新建旧规则订单。

新预演报告不是新财务操作；重启后复用原工作/资格/迁移操作。发生未知或冲突时向前核对，不能删除已成功事件再重发，不能回写旧余额覆盖权威 USD。

## 部署与验收边界

依赖 TB01–TB08 的显式 schema 与服务版本，Admin 复用已有 CreditWork JSON/唯一约束，无新增 SQL。QeeToken 本条只扩展测试夹具；WANX 本条只扩展真实响应驱动的 renderer 验证，没有 UI 产品源码改动或新增 bundle。

隔离预演覆盖两种付款/关单时序、SQL 事务失败、响应丢失、租约恢复、重复回调、迁移及补发门控。跨服务使用实际 Go HTTP/PostgreSQL、Admin MySQL/HTTP 与 WANX renderer；付款渠道和历史证据是合成样本，没有真实收款或 LLM 调用。完整原始报告见 [预演样本](credit-cutover-rehearsal-sample.json)，命令、计数与审查见 [TB09 验收记录](archive/credit-tracer-tasks-20261021.md#tb09-支付查询关单竞争与切换预演验收记录)。

生产渠道签名/通知实测、Windows 真机、完整上线与恢复手册、采购价格核算和正式切换仍属于 TB10/P6，不能由本地 ready 报告代替。
