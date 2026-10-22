# TB03 注册赠送合同

状态：开发合同，未启用生产赠送。依赖 [TB02 来源合同](credit-source-contract.md)，验收记录见 [tracer tasks](credit-tracer-tasks.md)。本轮仅交付新账号自动发放与历史领取证据登记；旧账号实际迁移/批量补发仍为 TB07/TB08。

## 资格与事务

Admin 显式执行 `20261020_qeetoken_registration_grant.sql`，新增 `nexus_qeetoken_registration_grant`。`account_id` 主键保证一个 Consumer 终身一份资格，`eligibility_id`、非空 `evidence_id`、非空 `event_id` 分别唯一。资格不以设备、操作 ID、批次或重试次数为身份。历史登记另有 `(actor_id, operation_id)` 唯一约束：同一管理员操作不能换账号或证据重用，并发冲突也只保留一份原登记。

启用 `NEXUSAOS_QEETOKEN_REGISTRATION_GRANTS_ENABLED=true` 后，以下实际新建 Consumer 的事务同时保存 `new_account` 资格和 `queued` 意图：短信首次注册、密码注册、后台创建。注册事务失败时资格一起回滚。注册提交成功后，远端超时不能回滚账号；后台循环独立发放，无需登录、充值、绑定盒子或点击领取。

已有账号登录、补设密码、开户 ensure、设备绑定不生成资格。开关默认为关闭，同时控制新资格写入与后台发放；关闭期间创建的账号日后不得被登录逻辑误判为新注册，须进入 TB07/TB08 的历史核实流程。启用时必须同时启用托管开户和 QeeToken billing；否则服务启动失败。开关不是取消已提交的远端事件，也不能作为中断在途发放的事务屏障。

## 入账与恢复

继续调用 `POST /api/integrations/wanx/v1/accounts/{remote_id}/balance-operations`，请求如下（ID 为示意）：

```json
{
  "schema_version": "1",
  "operation_id": "registration:<eligibility_uuid>",
  "kind": "registration_grant",
  "source_id": "registration:<eligibility_uuid>",
  "eligibility_id": "<eligibility_uuid>",
  "grant_rule_id": "registration-500-v1",
  "delta_atoms": "500000000"
}
```

固定 `500000000 USD atoms = 5 USD = 500 新积分`。Admin 生成金额，QeeToken API 和数据库 trigger 双重校验；客户端与管理修复入口均不能指定赠送金额。零余额开户不变，不使用 QeeToken 原生注册默认额度。

QeeToken migration `160_wanx_registration_grant.sql` 在 159 来源账基础上新增：每个托管 user 只能存在一笔 `registration_grant`、每个 `eligibility_id` 只能用于一个账号。相同意图或新 operation ID 的原内容重试返回原事件；换资格、source、规则、金额不能再次领取。余额、来源、序号、不可变事件和操作回执同事务提交；回执写入失败全部回滚。已有充值请求新增字段为 `omitempty`，旧回执摘要不变。

来源变化严格为 `grant_atoms +500000000`，购买/未核实/调整分量均不增加。来源历史初始化标志继续沿用 TB02：新账号未执行历史初始化时 `initialized=false, review_required=true`，即使该笔赠送来源明确。TB05/TB07 必须明确区分“新账号来源已知”和“历史初始化已完成”，不能通过本次赠送暗中把核对标志置为完成。

Admin 发放先完成开户与原期初同步，再冻结 remote ID，发送原资格对应的操作。后台最多领取 8 个到期任务，租约 3 分钟，单次执行超时 120 秒；暂时不可用在 30 秒后重试，身份/事件冲突转 `review_required`。进程退出后到期租约可恢复。远端响应不是本地到账凭证：只有按序校验并投影原事件后，资格才变为 `credited`。

投影同时校验账号、资格、source、规则、金额和来源差值；任何不匹配使整页事务回滚。账本类型明确为 `registration_grant`，不计充值收入或消费；Consumer/Admin 流水及类型过滤支持此值。

## 查询与人工核对

- Consumer `/app-api/v1/credits/wallet` 追加可空 `registration_grant`，包含资格 ID、来源、状态、规则、原事件 ID、尝试次数、错误码和更新时间。新账号赠送附 `credit_display={currency_rule_id:"usd-credit-100-v2",credit_scale:6,grant_credit_atoms:"500000000"}`；历史记录为 null，不能声称历史一定领了本次额度。
- WANX 校验赠送状态和明确面值后显示待到账/处理中/重试/待核对/已到账。无领取按钮、不提交赠送。当前钱包余额仍按 v1 展示；本字段明确写“新积分”，总额统一切换留 TB05。
- `GET /nexus/qeetoken/accounts/{account_id}/registration-grant` 需要 `credits:read`，额外返回原证据、远端身份和恢复时间。
- `POST /nexus/qeetoken/jobs` 的 `action=registration_grant` 需要现有 `credits:reconcile` 权限；`resource_id` 必须是该账号已有的 `new_account` 资格 ID。任务保存操作者、理由和原状态，并调用同一个执行器；通用 `retry` 也恢复原资格，不生成新领取身份。
- `POST /nexus/qeetoken/registration-grants/history` 需要 `credits:reconcile` 和 `Idempotency-Key=operation_id`；提交 `account_id/evidence_id/finding/reason`，不接受金额。证据需由有权限的核对者从原系统核实，接口保存证据引用与审计事实，不能自动证明外部凭证真实性。

`finding=registration_received` 保存 `historical_received` 并排除再次发放；`registration_unclaimed` 保存 `waiting_migration`，本轮不会发钱。相同请求重放返回原资格，改变判定或跨账号复用证据拒绝。没有记录表示未知；不能因新表为空、余额恰好为 5 USD 或普通活动赠送金额相同就自动判为未领或已领。TB08 必须在迁移已确认后复用这个账号唯一资格与发放执行器，不能按补发批次新建资格。

## 部署顺序与边界

1. 保持注册赠送开关关闭；备份并审核现有业务数据。
2. 先执行 Admin 显式 SQL，再部署能读取/投影新赠送事件的 Admin。新增读取依赖该表，即使开关关闭也要先迁移。
3. QeeToken 先有 158/159，再执行 160 并部署支持新 kind 的代码。迁移只建立约束/函数，不赠钱、不导入资格。
4. 完成后续 TB04–TB10、历史核实、统一切换与发布验收后，按正式发布安排启用。不能只改面值常量或仅开启本开关就认定本计划上线完成。

本轮仅操作可丢弃测试数据库。未在业务库执行迁移、历史登记、实际赠送或补发；未提交或推送代码。


## TB08 扩展（2026-10-20）

历史未领资格的迁移、审批、批量排队及逐账号恢复已由 [TB08 补发合同](credit-registration-batch-contract.md) 实现。以上“本轮”描述保留 TB03 的原验收范围；当前 history_unclaimed 只有保存批次授权后才能进入 queued 等发放状态，附固定 500 新积分展示。人工 registration_grant 恢复同样允许已批准的历史原资格；未经批准的 waiting_migration 不会发放。钱包总额已由 TB05 使用 v2。验收结果见总任务表 TB08。
