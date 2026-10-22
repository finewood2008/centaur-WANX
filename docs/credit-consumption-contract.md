# TB04 赠送优先消费合同

状态：开发及隔离环境验收完成。依赖 [来源合同](credit-source-contract.md) 与 [注册赠送合同](credit-registration-contract.md)，证据见 [tracer tasks](credit-tracer-tasks.md)。本任务不切换钱包面值，不调整模型价格或人民币充值规则。

## 权威扣费与来源

模型调用仍由 QeeToken 原生定价和 `UsageBillingRepository.Apply` 产生实际 `BalanceCost`。Admin 只读取不可变事件、校验来源并投影，不再计价或扣费。托管账号使用原生其他 API Key 也沿同一账号余额入账；没有绑定设备的原生请求不伪造 device_id。

来源变化与原余额更新、账号序号、事件和请求去重处于同一事务。既有 159/160 trigger 按 `grant → purchased → 正的 unattributed → adjustment` 分摊实际消费。四分量之和始终等于实际 USD 总余额；额度不足时剩余扣费进入有符号 adjustment，保留已准入请求的真实欠额。Admin 在投影边界校验该优先级、前后快照连续性、金额守恒和核对状态，不仅检查四分量总和。

例如赠送 100 新积分、购买 1000 新积分，消费 150 新积分对应的 1.5 USD 后，赠送为 0、购买为 950 新积分。模型费用依然来自原生价格，不以积分余额反推模型价格。并发消费通过原余额行锁串行分摊；同一请求重放不新增事件。提交阶段失败时扣费、来源、序号、事件和去重全部回滚，原请求可恢复。

## 撤销、原生调整与去重

原生 `balance_adjustment` 可在事务上下文中携带 `reversal_of_event_id`，引用同账号此前的 `usage_debit`。当前只支持完整撤销，金额必须等于原消费的相反数，恢复原事件的各来源分量。原消费事件不被修改或删除，不能凭一个新 source_id 再撤销一次。没有来源字段的 pre159 原消费撤销只记入 adjustment 并保留待核对，不猜测历史赠送/购买分摊。

未关联消费的原生调整仅改变 adjustment，且 `review_required=true`；它不被当成充值收入或消费。来源初始化和历史核对仍按 TB02/TB07 合同处理。

新增 `161_wanx_reversal_identity.sql` 将原撤销唯一索引的 JSON 文本身份改成 PostgreSQL UUID 身份；大写、花括号和不带连字符的同一个 UUID 不能绕过唯一约束。Admin 同样归一化查重，拒绝 Python UUID 解析器额外接受但远端合同不支持的 URN。事件原始 metadata 不被重写。

161 在迁移框架事务内先替换索引。如历史已有同义 UUID 重复撤销或非法 UUID，迁移失败并回滚，原索引、余额与事件保留。不得为了通过迁移删除或重写不可变财务事实；须先核对并形成专门的数据修复方案。新数据库按 158 → 159 → 160 → 161 顺序安装。

## Admin 查询与旧精度

管理事件 DTO 追加可空 `sources_before`，与已有 `source_delta`、`sources_after`、`reversal_of_event_id` 一起支持追溯。无来源的历史事件继续返回 null；白名单不暴露 Key 或其他密钥。管理路由仍需 `credits:read`，按账号、序号分页。

远端事件 kind 保持 `balance_adjustment`，本地关联撤销账本类型为 `correction`；未关联调整仍为 `balance_adjustment`。总余额账本继续按原 v1 累计余额取整差投影。完整撤销汇总按**原消费投影金额**抵消，避免消费和撤销间发生原生尾差调整后净消费残留 1 个 credit atom；不修改原事件或余额差账本。按时间过滤时冲正归入冲正发生时间，保留既有区间统计语义。

例如 USD atoms `100 → 消费 1 → 99 → 普通调整 +1 → 100 → 撤销 +1 → 101`：余额账本消费为 -1 个旧 credit atom，撤销的余额差为 0；summary 为 gross=1、correction=1、net=0，总余额仍为 101 USD atoms / 1 旧 credit atom。summary 只对持久 `billing_backend=qeetoken` 账号关联事件表；legacy 和未建账账号不依赖可选 QeeToken 表。

`wallet.spent_usd_atoms` 保持累计毛消费，撤销不会抹除原消费；净消费查询使用 summary。余额、消费及汇总的统一 v2 面值/精度和客户端呈现留 TB05，不通过一个常量提前激活。注册赠送及其消费不会生成充值收入，历史订单继续使用冻结 USD，不按当前人民币价格折算。

## 欠额与恢复

已准入的原生请求完成结算可能使总余额为负。新托管模型请求仍使用既有 `balance > 0` 准入：负值和零均拒绝，充值不足清偿欠额或只充到零也不能重新准入；总余额变正后恢复。充值仍进入 purchased，历史欠额仍在 adjustment，不重写旧消费来“清零”负分量。

本地验收通过测试专用 HTTP 入口模拟已准入请求返回的 provider usage，实际执行原生价格、记账 repository、PostgreSQL trigger，以及 Admin/MySQL 投影、Consumer 和管理 HTTP 查询。测试专用入口仅存在于 `_test.go`，未增加生产消费/退款 API。

先部署可校验、读取上述事件的 Admin，再按发布流程升级 QeeToken 161。当前仍须完成 TB05–TB10 和发布门槛；本次未连接业务库、执行生产迁移或修改线上开关，未提交或推送。
