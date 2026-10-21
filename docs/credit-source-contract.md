# TB02：已有 USD 的来源初始化合同

日期：2026-10-20。参见[实施方案](credit-implementation-plan.md)、[验收记录](credit-tracer-tasks.md)。本合同只覆盖已有 QeeToken USD 来源账，不启用 v2 面值、注册赠送或旧资产搬迁。

## 来源恒等式

每个映射账号在同一 account sequence 上满足：

```text
purchased_atoms + grant_atoms + unattributed_atoms + adjustment_atoms = balance_atoms
```

全部是 USD 八位 atoms。来源快照 `version="1"`，四个分量均为规范十进制整数字符串。购买、赠送非负；未核实、调整可为负，以保留原负余额及欠额。`source_delta` 是逐项 after−before 的规范字符串；两个合法 int64 分量之差可以超过 int64，Admin 用精确整数差校验，不截断。

- `purchased_atoms`：经支付事件或历史证据明确的购买额度。不是按当前价格倒推的人民币收入。
- `grant_atoms`：有来源证据的历史赠送剩余额度。本任务不新增注册赠送。
- `unattributed_atoms`：缺少足够证据的余额；升级时不能推定为全购买或全赠送。
- `adjustment_atoms`：原生未关联调整、无法恢复原分摊的旧事件纠错，以及已知消费产生的欠额。它不是充值收入。
- `initialized`：是否执行过该账号的一次性历史来源初始化。
- `review_required`：是否仍需核对；与 initialized 独立。未知分量非零、未初始化或未关联原生调整必须保留核对责任。已明确的消费欠额不会自动伪装成未知收入。

159 迁移不回填历史事件、不改历史余额。尚无来源行的账号读取为：全部原余额（含负值）在 unattributed，initialized=false，review_required=true。第一个新事件才在原余额行锁内持久化来源。既有充值操作回执仍按原 hash/原事件恢复。

## 权威事务与事件

新增 QeeToken `159_wanx_balance_sources.sql`，不编辑已应用的 158：

- `wanx_balance_sources` 保存当前来源；`wanx_source_claims.asset_id` 全局唯一，记录证据 ID 和账号，防止同一个旧资产用不同批次再次承接。
- 所有映射账号的 `users.balance` 更新仍经原 AFTER UPDATE 触发器，在同一事务内更新来源、账号序号和不可变事件。未映射原生账号保持原行为。
- 新充值增加购买来源；原 `migration_opening` 缺少来源证据时进入 unattributed，不能猜测。
- 实际消费使用原生 `BalanceCost`，赠送优先，其次购买、可用未核实余额，剩余进入调整/欠额；不增加第二笔总余额扣减，不改变价格、去重或预占策略。
- 无关联的原生余额增加、减少、set、退款/补偿等落入调整并待核对，原总账机制继续执行。
- 有明确 `wanx.balance_context.reversal_of_event_id` 的完整消费撤销，验证同账号、原 usage_debit、相反金额，逐项恢复原 source_delta；同原事件只能撤销一次。旧事件无分摊字段时归调整并待核对。恢复未知来源时重新标记 review_required，包含撤销发生在初始化之后的情况。
- 现有原生操作没有原事件引用时**不会自动推断**是某次消费的撤销。本轮实现上述事务上下文合同及验证；原生管理 UI 没有新增“选择原消费事件”入口，也不支持部分/多次冲正。

每个新事件的 metadata 追加 `sources_before`、`sources_after`、`source_delta`；快照返回同一 repeatable-read 切面的 `sources`。原事件原样保留，不能用今天的分量回写旧事件。

## 零金额初始化

服务间接口：`POST /api/integrations/wanx/v1/accounts/{account_id}/source-initializations`，沿用 Bearer 服务鉴权和 Idempotency-Key。

请求包括 schema_version、operation_id、source_id、evidence_id、排序且唯一的 asset_ids（1–100 项）、expected_balance_atoms、expected_sequence、四个来源分量。金额均为字符串。初始化接口拒绝 delta_atoms/kind/设备凭据等无关字段。

同一余额行锁内：

1. 以账号查原初始化。相同内容（允许换 transport operation_id）返回原事件；更换 source、证据、分量等内容冲突。
2. 比较原余额和原序号，证据过期即拒绝，不采用最新余额自动重算。
3. 领取逐项稳定 asset_id；重复引用冲突，整体回滚。
4. 四分量合计必须等于原余额；更新余额为自身，生成 `source_initialization` 零金额事件，仅序号前进。
5. 来源、资产引用、事件、序号和操作回执一起提交；任何后续失败全部回滚。

每个账号只允许一次初始化，不能换批次/source 再执行。证据 ID 是核实记录引用；asset_id 必须来自原系统稳定资产身份，不能临时生成别名来替换同一资产。系统保证相同身份去重，不替代管理员核实证据真实性。

## Admin 投影及管理路径

显式 SQL：`admin-backend/sql/20261020_qeetoken_sources.sql`。新增 `nexus_qeetoken_source`，来源快照与原 Wallet 的 sequence 一致。

投影在原 `apply_page` 事务内验证版本、规范整数、总和、逐项差值、前后快照、账户序号及最终来源快照。旧事件没有来源字段可原样重放；一旦建立来源投影，缺失或降级字段不能静默接受。未知版本、冲突、缺页或金额不一致保持失败和恢复责任，整页回滚。

`source_initialization` 不创建 CreditEntry，不增加 ledger_sequence/revision，不计入充值收入或消费累计；只记录远端零金额事件和来源快照。当前积分展示仍按 v1 投影，不执行 T07 的展示基准切换。

管理接口：

- `POST /nexus/qeetoken/sources/preview`：需要 credits:reconcile；读取已就绪投影，返回固定余额/序号、拟议来源和 preview_hash。无远端调用、开户、任务创建或余额写入。
- `POST /nexus/qeetoken/sources/jobs`：需要同权限、原预演摘要、稳定 operation_id、原因、证据和逐项资产身份。只接受 asset_kind=qeetoken_balance，拒绝 shadow、人民币钱包及未迁移 legacy 资产。摘要绑定请求和原账号状态。
- 任务复用现有 job 审计、租约、retry_wait/review_required、人工 retry 原任务机制。远端提交后响应丢失，继续使用原 job 身份和原请求；不能改金额或换任务隐瞒冲突。
- 账号查询追加 sources；事件查询支持 source_initialization，并白名单返回来源差值、快照、证据和冲正引用。

历史证据只有部分可核实时，剩余金额保留 unattributed 并 review_required=true。一次性初始化不是“核实完成”的标志。**本轮没有再次重分类接口**：剩余未知来源后续核实，需要 TB07 增补独立、带证据的重分类事件，不能重复初始化或制造余额变化。TB05/TB07 必须以核对完成为切换门槛。

## 发布顺序与范围

先执行 Admin 显式 SQL 并部署兼容新旧事件的 Admin，再部署 QeeToken 159 和新服务；检查来源投影追平后，才进行只读预演。实际执行初始化需要经营侧核实证据并另行安排，不在本轮开发中执行。

不执行生产迁移/补发/面值切换，不迁 shadow 或人民币钱包，不改变模型价格，不关闭原生充值。TB03 注册赠送、TB04 完整消费验收、TB05 展示切换、TB07 legacy 搬迁及未知来源重分类仍按任务表推进。
