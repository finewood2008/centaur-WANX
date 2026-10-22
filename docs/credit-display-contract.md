# TB05 钱包与消费展示合同

状态：2026-10-20 开发及隔离验收。按账号显式建立展示基准；部署代码不会自动切换任何账号。生产整体切换、旧资产迁移和 v2 新单仍分别属于后续任务。验收证据见 [tracer 记录](credit-tracer-tasks.md)。

## 单位与持久基准

QeeToken 仍以 `currency=USD,currency_scale=8` 记账，原余额、事件、来源分量及订单快照不变。新展示使用 `currency_rule_id=usd-credit-100-v2,credit_scale=6`，所以新 credit atoms 与原 USD atoms 数值相同；旧 `usd-credit-1-v1` 为 USD atoms 除以 100 向下取整。

例如 20 旧积分对应 20 USD；建立基准后显示 `2,000.00` 积分，仍为 20 USD。已有 5 USD 显示 `500.00` 积分，不能再入账或把 USD 乘 100。正负尾差保留在整数 atoms 中，仅显示时四舍五入。

Admin 显式迁移 `admin-backend/sql/20261020_qeetoken_display.sql` 创建 `nexus_qeetoken_display`。每账号只有一个基准，记录原/新余额、原远端序号、本地账本序号、操作者、原因、稳定操作 ID、请求摘要及不可变回执。`confirmed` 独立保存最后完整同步的余额、毛消费、序号、时间和待结算数。

建立基准与本地账户余额变更在同一事务提交；账户 revision 增加，账本序号不增加。没有伪造的充值、消费或收入流水，不调用 QeeToken 写接口。后续事件按该账号持久规则投影，历史 `CreditEntry` 不回写。

## 管理操作

前缀 `/nexus/qeetoken`，沿用管理认证、credits 信封和 no-store：

| 方法与路径 | 权限 | 行为 |
| --- | --- | --- |
| `POST /display/preview` | `credits:reconcile` | 锁定账号读取已确认状态，返回旧/新面值、金额、序号和 `preview_hash`；不更改余额 |
| `POST /display/commit` | `credits:reconcile` | 重验同一状态与摘要，原子提交基准和回执 |
| `GET /accounts/{account_id}/display` | `credits:read` | 返回原回执；未建立基准返回 404 |

POST 请求如下，`Idempotency-Key` 必须等于 `operation_id`；commit 须补上预演返回的 `preview_hash`：

```json
{
  "schema_version": "1",
  "operation_id": "stable-display-operation",
  "account_id": "consumer-id",
  "expected_sequence": "2",
  "expected_balance_atoms": "500000000",
  "reason": "已核对该账号来源与完整余额快照"
}
```

commit 的操作者来自登录态。相同操作者、操作 ID 与完全相同请求重试返回原回执；变更原因、账号、金额或摘要冲突。余额/序号变动须重新预演，不能复用过期摘要强行切换。响应丢失先读取原回执，或重放原请求。

准入条件：已迁入 QeeToken；无本地在途调用、远端待结算执行或同步错误；完整快照不超过 30 秒；来源与钱包同序号；原本地金额与旧规则一致；来源已核实且无 review 标记。历史未知来源不能切换。

TB03 的可证明新注册账号另有有限准入：资格为 `new_account`、赠送已 credited 且远端身份匹配、期初为零、无 unattributed，全部事件仅为注册赠送、充值、消费。存在其他调整或历史证据不完整时仍须核实来源，不把“没有历史记录”当作新账号证据。

## Consumer v2 读取

前缀仍为 `/app-api/v1/credits`，外层认证与 `schema_version=1` 信封不变，展示合同通过独立路径和 `view_version="2"` 明确区分。账号从 Consumer 身份解析，不接受跨账号查询。

| 接口 | 关键字段 |
| --- | --- |
| `GET /wallet/v2` | `view_version,account_id,currency_rule_id,credit_scale,balance_credit_atoms,spent_credit_atoms,correction_credit_atoms,net_spent_credit_atoms,remote_sequence,sync_state,pending_executions,synced_at,error_code,registration_grant` |
| `GET /usage/v2?limit=20&before_sequence=123` | `view_version,account_id,currency_rule_id,credit_scale,remote_sequence,items,next_before_sequence` |

金额及序号均为十进制字符串。消费项只有 `event_id,account_sequence,debit_credit_atoms,occurred_at,device_id,model`。两个响应均不暴露 USD、token 用量、价格或汇率字段。赠送状态复用 TB03 合同。

未建立基准时钱包为 pending，金额为 null，序号为 `"0"`；消费为空。不是零余额。已建立基准后，余额与累计消费只取 `confirmed`，关联消费的完整撤销计入 correction，净消费为毛消费减纠正；普通调整不混入纠正。消费列表按原始 USD 事件精确转换，切换前后统一为新面值，不使用旧已取整的 credit delta。

每个读取使用 repeatable-read 快照。事件分页中断时可持久化已处理事件，但不提前推进 `confirmed`；消费页也以其序号为上界。部分页清除当前同步时间，旧完整值显示 stale；重启继续分页，完整校验通过才一起刷新确认值。分页倒序，limit 为 1–100，游标为最后一个事件序号。

客户端先读取消费页再读取钱包，避免并行读取时消费比钱包更新而误判协议错误。旧序号不得覆盖较新值；pending 先于序号比较处理，保留已有余额并标 stale；刷新使旧分页请求失效。退出或切号清空状态，校验账号及请求代次。

## 旧合同与原订单

- `/balance`、`/wallet`、`/usage` 保持 v1 单位，不把新 atoms 冒充旧字段。部分同步仍明确 stale，时间为空不能报 500。
- 已切换账号的旧 `/entries`、`/summary` 返回 `UNSUPPORTED_SCHEMA`，防止历史 v1 与新 v2 本地流水混算。
- 旧管理 entries 查询若本页涉及已切换账号，也返回 `UNSUPPORTED_SCHEMA`，包括跨账号查询。管理人员改用 QeeToken 事件页：同时列出原始面值、原始积分变动、当前面值和当前积分变动，原 USD 及 token 用量仍可审计。账户和对账响应标明当前规则。
- 原订单沿用冻结面值与 USD 履约，重试保留订单/操作身份；`credit_display` 按持久基准明确展示当前额度，原字段不变。
- 基准切换后新购买意图返回 `CONTRACT_NOT_CONFIGURED`，商品目录不售卖；原购买意图恢复及原已支付订单履约继续。TB06 再实现 v2 商品、整数自定义及最低客户端能力门控。

## 客户端格式

全程十进制整数/BigInt 计算，不以浮点数处理余额。正常金额四舍五入到两位，负数按绝对值 half-up 后恢复符号，禁止 `-0.00`。

| 原始积分 | 展示 |
| --- | --- |
| 123.4 / 12.344 / 12.345 / -12.345 | 123.40 / 12.34 / 12.35 / -12.35 |
| 精确 0 | 0.00 |
| 0 < 余额 < 0.01 | 余额不足 0.01 积分 |
| 0 < 消费 < 0.01 | 消耗不足 0.01 积分 |
| -0.01 < 余额 < 0 | 欠费不足 0.01 积分 |
| 精确 ±0.01 | 0.01 / -0.01 |

主钱包、消费表格、累计消费、原订单当前展示及快捷面板采用一致规则。无悬浮层泄漏原精度/USD/token；人民币付款金额保留。

## 部署与恢复边界

1. 先按已有部署流程备份并应用 Admin 的来源、赠送以及本次展示 SQL。本次代码在 QeeToken 路径读取展示表，因此必须先建表，即使暂不切换任何账号。
2. 部署兼容的 Admin 和新版客户端；QeeToken 无 TB05 新生产协议或数据库迁移，继续保持原 USD 权威账。
3. 本次仅隔离环境预演。生产账号选择、来源证据、旧资产迁移、旧客户端门控和完整切换由 TB06–TB10 完成后执行。
4. 基准已提交后，恢复只能继续原规则与原操作，不删除基准、不重放远端金额、不回滚为不识别基准的旧代码。远端变化导致预演过期时重新核对；提交响应未知时查询回执。

本机 macOS Electron 与两种宽度已验证；Windows 真机、实际付款和生产上线不是本次验收结果。
