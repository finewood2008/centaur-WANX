# TB07 旧资产迁移与来源重分类合同

日期：2026-10-20。依据：[实施方案](credit-implementation-plan.md)、[tracer 记录](credit-tracer-tasks.md)。本轮交付开发与隔离验收，不执行生产资产迁移。

## 三种资产路径

| 账号事实 | 操作 | 金额与来源 |
| --- | --- | --- |
| 尚未迁移的真实旧积分 | 核实领取历史、订单和原资产 → preview → asset_migration job | 未消费未迁移部分按 1 旧积分 = 1 USD = 100 新积分；购买与赠送合并为一笔期初 |
| 已有 QeeToken USD 或非零事件序号 | 同步 → 来源初始化／重分类 → TB05 展示预演与提交 | 远端金额不变；来源事件金额为 0；尾差、负数和原事件完整保留 |
| 已冻结的旧版 migrating 钱包 | 恢复原 migration 操作 → 核实来源 → 展示切换 | 保持旧请求、source 和金额；不能给原请求追加新字段重算哈希 |

现有 USD 不能再次按旧积分迁入。无资产的零余额账号不制造金额为零的期初：同步零余额，使用真实的零余额核对证据初始化来源，再执行 TB05 展示切换。来源证据不足、未决支付或旧在途结算不能强行清零。

## 只读盘点及预演

管理鉴权与 schema_version=1 信封沿用原合同。可先分页 `GET /nexus/qeetoken/accounts`，再按账号保存下列 JSON 结果作为批次盘点。读取接口只查询已持久事实，不自动同步远端，因此需结合最后同步时间和切换窗口核对。

| 接口 | 权限 | 行为 |
| --- | --- | --- |
| `GET /nexus/qeetoken/migrations/accounts/{account_id}` | credits:read | 返回 legacy_unmigrated、existing_remote、migration_in_progress、migrated 或 blocked；包含旧余额、远端余额/序号、领取认定、已到账与待履约订单、阻断原因、job_id/stage |
| `POST /nexus/qeetoken/migrations/preview` | credits:reconcile | 严格校验已核实资产、剩余量、订单和领取记录，返回单笔 USD 及来源分量、盘点快照和 preview_hash；不开户、不发钱、不占用资产 |
| `POST /nexus/qeetoken/migrations/jobs` | credits:reconcile | 校验同一预演并冻结账号计划、资产占用及管理任务，返回 202；排队成功不等于迁移完成 |
| `GET /nexus/qeetoken/jobs[/{job_id}]` | 原管理查询权限 | 批次、操作者、原因、attempts、错误和原结果；恢复仍走原管理 retry 操作 |

POST 的 `Idempotency-Key` 必须等于 operation_id。额外字段、重复／额外查询参数、非字符串金额、浮点、负数以及超出 int64 的总额拒绝。完成展示转换后 inventory.legacy_credit_atoms 为 null，不把新面值伪装成旧积分。

一个 15 旧积分购买余额 + 5 旧积分早期赠额的预演请求：

```json
{
  "schema_version": "1",
  "operation_id": "migration-review-alice",
  "action": "asset_migration",
  "account_id": "alice",
  "batch_id": "reviewed-batch",
  "reason": "核实原发放、消费、订单和领取记录",
  "evidence_id": "reconciliation-alice",
  "expected_legacy_credit_atoms": "15000000",
  "assets": [
    {
      "asset_id": "early:gift-1", "origin": "early_credits", "source": "grant",
      "evidence_id": "gift-ledger-1", "issued_credit_atoms": "8000000",
      "consumed_credit_atoms": "3000000", "migrated_credit_atoms": "0"
    },
    {
      "asset_id": "ledger:alice:remaining", "origin": "admin_ledger", "source": "purchased",
      "evidence_id": "paid-ledger-alice", "issued_credit_atoms": "20000000",
      "consumed_credit_atoms": "5000000", "migrated_credit_atoms": "0"
    }
  ]
}
```

提交 jobs 时使用相同请求并追加 preview_hash。预演输出 purchased_usd_atoms=1500000000、grant_usd_atoms=500000000、opening_usd_atoms=2000000000；当前展示为 2000 积分。

所有资产量均为原旧积分 atoms（精度 6）。remaining=issued−consumed−migrated，必须大于零；admin_ledger 的剩余量之和必须精确等于冻结的本地旧余额。early_credits 只包含未进入 Admin 余额、未被 QeeToken 承接的真实早期资产，不能重复引用本地余额。shadow／预计消耗／人民币钱包不是允许的 origin。

原资产 ID 必须跨批次、跨来源使用同一个规范身份，并按字典序唯一排列。引用充值订单时须提供 order_id，asset_id 必须为 `order:<order_id>`，来源必须是本账号 paid+credited 的购买资产，剩余量不得超过原 grant；已支付未到账订单留在独立责任清单，不计入期初。证据登记不自动从未知历史推算消费分量，运营应保留对应的原始凭证与核对表，不能为重复资产换别名。

注册领取认定单独复用 TB03 history 接口：history_received／history_unclaimed 才可进入旧资产预演。一般活动赠额不等于已领注册赠送；未领历史资格仍停留 waiting_migration，本轮不补发。

## 单笔期初与恢复

提交事务锁定 Consumer，保存原 request、before、操作者、batch_id 和资产唯一占用，并将账号切至 qeetoken 写入路径，防止旧扣费／旧入账在计划冻结后改动余额。新任务未提交的正旧余额不再被后台 enroll 自动搬走。

持久阶段为 prepared → opening → completed。opening 前保存完整总额与分量；远端固定操作及 source 为 `migration:<account_id>`，batch_id 不参与财务身份。QeeToken 必须同时满足余额 0 与序号 0，严格校验分量之和，余额、来源、事件、资产 claim 和操作回执同事务提交。相同 source/内容重放原事件；改分量、证据或资产列表冲突；同一资产跨账号也只能承接一次。

Admin 拉取连续事件确认远端期初后，在同一个账号锁事务中重新预演并提交 TB05 展示基准及 migration.result。中断后若尚未提交展示，会按最新已确认快照重新预演；如果存在旧 display_pending 检查点及合法的新消费，也不会永久卡住。已有展示回执始终重放原命令，不改财务计划。成功返回的 result 是原完成时回执，后续余额查询以当前钱包为准。

HTTP 超时、远端已成功但响应丢失、本地事务回滚和 worker 重启，均继续原 job、operation、source 和资产引用。管理任务保留 attempts、last_error 与 next_attempt_at；review_required 时核对原因并 retry 原任务，不修改原金额或创建替代批次。已占用的资产不会因失败自动释放，避免双入账。未解决的计划事实冲突保留人工核对，不能通过删除任务／claims 绕过去重。

迁移未 completed 时原 paid pending 订单暂停履约；完成后按原冻结 USD 恢复。paid credited 订单绝不重发；其真实剩余资产可以在期初中承接。旧版已持久化 migrating 钱包仍按原冻结操作恢复。

## 已有 USD 的证据重分类

复用 `POST /nexus/qeetoken/sources/preview` 与 `/sources/jobs`，QeeSourceCommand.action 新支持 `source_reclassification`，asset_kind 仍为 qeetoken_balance。原 source_initialization 保持一次性初始化语义；重分类要求已有初始化，并携带 reason、evidence_id、asset_ids、expected_balance_atoms、expected_sequence 及四个完整来源分量。

Admin 原任务固定转发 `POST /api/integrations/wanx/v1/accounts/{account_id}/source-reclassifications`，operation_id=`source-reclass:<job_id>`、source_id=`reclass:<job_id>`。远端金额不变，仅递增账号事件序号并写独立零金额事件。旧事件、旧 claim 证据不重写；同账号已占用的资产可用于重新核对，跨账号引用仍冲突。新证据仍须守住总量等式及原余额／序号 CAS；消费后过期的全量来源预演拒绝，不能静默覆盖。

未知部分 unattributed_atoms 非零时仍需核对；重分类确认全部来源后 review_required=false。已核实的 adjustment（包括负欠额）可保留原值并通过核对，不会免欠或增加充值收入。Admin 校验来源快照、零金额和序号后，才允许 TB05 展示切换；不增加财务流水或消费累计。

## 发布与执行边界

1. 备份与原始证据核对；按照方案第 8 节安排受控窗口，先处理未决支付及旧在途结算，保留已支付责任。
2. 先执行 Admin 显式 SQL `admin-backend/sql/20261020_qeetoken_migration.sql`；启动只检查表，不调用 create_all，不扫描发钱。
3. 部署支持 migration evidence／source_reclassification 的 Admin；QeeToken 应用追加迁移 `162_wanx_reviewed_migration.sql` 并部署新 handler。159–161 的已发布内容保持不变。完成前不提交新操作。
4. 保存只读盘点 → 登记领取及来源证据 → 每账号预演 → 保存预演 hash 后提交原任务 → 查原任务及连续事件 → 核对展示 → 恢复 paid pending 原单。已有远端余额走零金额来源与展示路径。
5. 对照原资产、原订单、单笔期初、来源合计、序号、USD 与当前积分完成验账。批量旧账号注册补发留 TB08；支付关单竞争及全窗口演练留 TB09/TB10。

发生问题向前恢复；不删除原事件、claims、展示基准或迁移计划，不回退到旧换算代码。此文没有授权生产写入或启用新充值。客户端继续使用 TB05 的 v2 钱包／消费接口，迁移本身不增加客户端金额换算。
