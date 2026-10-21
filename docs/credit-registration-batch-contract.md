# TB08 旧账号注册赠送批量补发合同

依赖 [TB03 注册赠送](credit-registration-contract.md)、[TB07 旧资产迁移](credit-migration-contract.md)。本条交付受控批次 API、逐账号审计及恢复入口；没有执行生产补发。

## 从核实范围到原资格

批次只承载审批范围、操作者、原因和结果。账号沿用 TB03 历史核实保存的 `eligibility_id`，远端仍使用 `registration:<eligibility_id>`。不得把批次 ID、设备、登录或重试次数当作新领取身份；不使用运营活动兑换码或原生注册默认额度。

只有有原始领取核对凭证的 `history_unclaimed / waiting_migration` 资格可进入审批。`history_received`、缺少记录、新账号资格、已批准或已到账分别明确排除。其他历史赠送、余额数值及新表为空均不能证明注册是否领取。

预演和提交同时要求：已完成 v2 展示基准、已有迁移任务为 completed、无旧本地预占、无未核实付款或已付未履约责任、托管映射匹配、钱包完成同步且无在途或异常、来源已初始化并核实、来源与钱包同序号、本地余额与远端快照一致。预演使用 30 秒内的快照；负余额按 TB07 保留，不免欠。

提交在有序 Consumer 锁内重新计算预演摘要，防止范围或资格变化后继续批准。一个事务保存不可变 Batch 请求/预演/回执、Release 授权及原 Grant 的 queued 状态。Release 的 account_id 主键和 eligibility_id 唯一约束防止跨批次重复释放；事务失败不留下部分账号。

混合批次只释放明确 eligible 的子集，排除项及原因永久保存在原预演。全部排除时拒绝提交。被排除账号以后满足条件，必须重新核实并预演新批次；原批次重放不会扩张范围。

## API

前缀 `/nexus/qeetoken/registration-grants/batches`：

| 方法 | 权限 | 结果 |
| --- | --- | --- |
| POST `/preview` | credits:reconcile | 只读逐账号结论、eligible_count、总积分 atoms、preview_hash |
| POST 根路径 | credits:reconcile | 202；持久审批回执，未表示到账完成 |
| GET `/{batch_id}` | credits:read | 原范围/操作者/原因，逐账号资格、尝试、错误码、下次时间、到账事件及汇总状态 |

POST 均要求 `Idempotency-Key=operation_id`，禁止未知字段及查询参数。请求范围是排序去重的 1～100 个明确 Consumer ID，不接受金额或资格 ID。预演与提交使用相同内容，仅提交时填入返回的 preview_hash：

```json
{
  "schema_version": "1",
  "operation_id": "reviewed-history-20261020-01",
  "batch_id": "history-20261020-01",
  "account_ids": ["consumer-a", "consumer-b"],
  "reason": "已核对原领取凭证、旧资产迁移及订单责任",
  "preview_hash": null
}
```

同一 actor/operation、相同完整请求重放返回原回执，即使暂时停发也不丢失原审计。修改内容、复用 batch_id 或过期预演返回冲突；需重新读取并核实，不能盲目换操作 ID。报告的 `total_grant_credit_atoms` 是本批获准总额，实际到账数量看 credited_count 和每个原事件。

## 唯一执行、失败恢复与展示

复用 TB03 后台执行器，固定 `500000000 USD atoms = 5 USD = 500 新积分`，新账号和已批准历史资格一起领取到期任务。实际历史发放前再次同步并检查迁移/订单/来源门控。未经批准的历史资格不能通过人工恢复接口发钱，事件投影也必须查到匹配 Release。

远端响应丢失、进程重启或并发任务都重试原资格；到账以经过校验的不可变事件为准。QeeToken 原有账号和资格双重唯一约束、来源变更与回执事务不变，无新增远端 SQL。新增来源只进 grant 分量，不记充值收入或消费。

暂时故障进入 retry_wait，冲突进入 review_required。查询批次后核实错误，使用现有 `/nexus/qeetoken/jobs` 的 `action=registration_grant`、`account_id` 和原 `resource_id=eligibility_id` 恢复；已提交管理任务也可用 action=retry 指向原 job。操作要求 credits:reconcile 和非空原因，不新建资格或增加赠送额度。

管理页可按批次 ID 查询上述逐账号事实，并对 retry_wait/review_required 执行“恢复原赠送”；丢失管理提交响应时保留并重发原意图。用户钱包保留 `history_unclaimed` 来源，批准后按 queued/running/retry_wait/review_required/credited 显示明确的 500 新积分状态；未批准的 waiting_migration 不承诺到账，无领取按钮。

## 部署和边界

1. 先具备 TB03/TB07 的表、远端约束及服务；执行 Admin 显式 `sql/20261020_registration_grant_batches.sql`。只创建两张审计表，不登记资格、不发钱；启动仅检查，不自动 create_all。
2. 部署支持已批准历史状态的 WANX 源码及生成 bundle，再部署可读取授权并校验事件的 Admin 服务与管理页。
3. 正式窗口按 TB09/TB10 完成付款责任、历史核实、客户端兼容及演练后，才启用既有注册赠送开关并逐批预演/提交。开关不能撤销在途远端事务。
4. 前向恢复沿用批次、原资格和原管理任务，核对到账事件；禁止删授权/资格再补发。实际发放后不向不支持历史授权的旧投影版本回退。

隔离测试证据见 [TB08 验收记录](credit-tracer-tasks.md)。历史凭证真实性仍需业务核实；TB09 的支付查询/关单竞争、TB10 的完整窗口演练、Windows 真机及生产支付验收不在本条完成范围。
