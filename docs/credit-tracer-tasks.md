# 积分 v2：实施状态与验收入口

更新：2026-10-21。统一入口：[积分文档](credits.md)；业务依据：[最终规则](credit-business-rules.md)。

**TB01–TB09 已开发并完成各自隔离验收；TB10 本地三端演练、macOS Electron、代表性核算和恢复手册已交付。生产结论仍为 NO-GO。** Windows、真实支付、实际采购及收费配置、真实历史资产与备份恢复、正式发布窗口的解除证据统一维护在[发布验收矩阵](credit-release-acceptance.md#发布门槛)。本状态不代表已上线、迁移或补发。

## 分支与基线

WANX、Admin、QeeToken 外层及 `sub2api` 均使用 `codex/credit-v2-tracer-20261020`，未提交或推送。起点没有本地 `develop`，沿用当时已包含依赖代码的 HEAD；原有未提交改动和子模块指针差异保留。起点提交见[原始记录](archive/credit-tracer-tasks-20261021.md#分支与基线)。

## Tracer bullet 交付

每条记录纵向输入、持久事实、恢复路径及可观察结果。下表是当前实现索引；原始设计编号 W/A/Q 和阶段依赖保留在[设计基线](credit-implementation-plan.md)及[历史任务图](archive/credit-tracer-tasks-20261021.md#任务图与验收门槛)。

| 任务 | 已交付纵向场景 | 合同或验收入口 |
| --- | --- | --- |
| TB00 | 订单、来源、赠送、消费、展示、充值、迁移、补发与切换合同已固化 | 本表各专题；[原订单合同](archive/credit-tracer-tasks-20261021.md#tb00-已固化的订单子合同) |
| TB01 | 原已支付订单 → 原冻结 USD → 唯一入账 → 原意图恢复 → 当前面值展示 | [支付 API](../../nexusaos-admin/docs/contracts/credits-payment-api.md)、[原验收](archive/credit-tracer-tasks-20261021.md#tb01-验证记录) |
| TB02 | 核实历史来源 → 同事务来源状态 → 初始化/纠错 → 总余额不变 | [来源合同](credit-source-contract.md) |
| TB03 | 注册/后台创建 → 唯一资格 → 开户恢复 → 500 积分一次赠送 → 事件投影 | [注册赠送合同](credit-registration-contract.md) |
| TB04 | 原生实际扣费 → 赠送优先分摊 → 不可变事件 → 消费投影及撤销 | [消费合同](credit-consumption-contract.md) |
| TB05 | 完整 USD 快照 → 账号展示基准 → v2 钱包/消费 → 精度及同步状态 | [展示合同](credit-display-contract.md) |
| TB06 | 五档/整数自定义报价 → 冻结订单 → 支付核验 → 唯一入账 → 积分展示 | [充值合同](credit-recharge-contract.md) |
| TB07 | 只读盘点 → 来源/领取核对 → 唯一期初或来源重分类 → 展示切换 → 原任务恢复 | [迁移合同](credit-migration-contract.md) |
| TB08 | 已迁移旧账号 → 原资格审批 → 批量排队 → 唯一赠送 → 逐账号审计/恢复 | [补发合同](credit-registration-batch-contract.md) |
| TB09 | 查询/关单竞争 → 原单履约 → 事件追平 → 迁移/补发门控 → 切换预演 | [切换合同](credit-cutover-contract.md)、[原始预演 JSON](credit-cutover-rehearsal-sample.json) |
| TB10 | 三端演练 → Electron/平台检查 → 代表性价格核算 → 发布与向前恢复 | [T01–T32 矩阵](credit-release-acceptance.md)、[核算](credit-pricing-rehearsal.md)、[手册](credit-release-runbook.md) |

TB00–TB09 的开发、测试命令、失败修复与审查结论全部保留在[阶段归档](archive/credit-tracer-tasks-20261021.md)。TB10 本地通过不关闭外部发布门槛；正式迁移、补发、配置启用和上线须按手册独立执行。

## 后续修订与最新验证

以下结果来自已完成的代码验收，本次文档收敛未重跑业务测试。不同测试范围与 skip 不相加为一个“全量通过”数字。

| 范围 | 最近验证结果 | 记录 |
| --- | --- | --- |
| WANX 购买流程 | 先选商品 → 选渠道 → 确定 → 二维码；确认前本地修改/取消不下单；确认后沿原单关闭和恢复 | [交互合同](credit-recharge-contract.md)、[开发及审查](archive/credit-tracer-tasks-20261021.md#购买交互优化先选商品再确认渠道) |
| WANX 测试与构建 | 页面 37 passed；Node 1461 passed / 19 skipped；macOS Electron 1 passed / 0 skipped；renderer 构建通过 | 同上；[最新界面证据](credit-release-acceptance.md#后续修订证据) |
| WANX `make all` | 4841 passed / 17 skipped；格式、lint、typecheck 通过 | 同上 |
| Admin Python 3.10 | 线上运行时要求；3.10.17 与 3.12 同组 7 文件均 174 passed / 2 live skipped；覆盖 Z、偏移、0～9 位小数秒和支付恢复，不代表全仓 3.10 通过 | [命令与范围](archive/credit-tracer-tasks-20261021.md#admin-python-310-时间兼容复核)、[发布要求](credit-release-runbook.md) |
| TB10 三端 | Lifecycle/Billing 跨服务两项通过，19 项 Python live 用例实际运行；Admin 广域 777 passed / 29 skipped，其中环境跳过项由独立联调补证 | [原验收](archive/credit-tracer-tasks-20261021.md#tb10-本地开发与隔离验收交付)、[机器证据](credit-release-evidence.json) |
| QeeToken | Go 全量、unit、vet 通过；代表性定价 67 个顶层测试通过；全量 lint 仍有 22 项既有问题 | 同上；不声明全仓静态检查绿色 |

TB10 JSON 和 `credit-release-evidence/` 截图保存当次源码/夹具事实，后续购买交互已有独立证据，原摘要不代表当前工作区。日志位置及具体执行命令见归档；原始证据文件保持不变。

## 文档维护约定

业务决定只维护在业务规则；接口字段与兼容行为维护在专题合同和各端 API；发布操作只维护在上线手册；T01–T32 和外部门槛只维护在验收矩阵。新一轮验证更新本页摘要并留具名记录，不继续把完整阶段日志追加到入口页。历史设计及归档不得作为当前部署指令。

## 文档收敛校验（2026-10-21）

本次仅调整文档：当前任务页收敛为摘要，三个仓库的阶段日志完整归档，更新 v2 面值、购买顺序、Python 3.10 要求和部署索引。校验通过：21 份文档的 427 个本地链接及 17 个锚点、三份归档正文保真、9 个 JSON/PNG 原始证据 SHA-256 未变，三个仓库 `git diff --check` 通过。另核对外部入链并保留原生产配置锚点。未修改业务代码；未重跑 `make all` 或业务测试，上表结果均为先前实际执行记录。
