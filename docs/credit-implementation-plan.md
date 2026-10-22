# WANX × Admin × QeeToken 积分实施方案

日期：2026-10-20。依据：[最终业务规则 v1.0](credit-business-rules.md)。

**本文件保留 2026-10-20 开发前的设计基线，不是当前实施状态或部署指令。** TB01–TB10 后续实现与最新验证见[任务状态](credit-tracer-tasks.md)，最终字段以其中链接的专题合同及 API 为准；放行依据见[验收矩阵](credit-release-acceptance.md)，实际执行顺序见[上线手册](credit-release-runbook.md)。下文“现有”“尚未”“建议”均指方案制定时，业务决策不重新打开。

## 1 结论与三端边界

主要改动集中在 **Admin 的面值版本、订单履约、迁移与赠送编排**，以及 **QeeToken 的赠送入账和消费来源分摊**。WANX 客户端负责新充值交互、协议适配与积分展示。QeeToken 原有 USD 总余额、模型计价、正余额准入和允许在途欠费的规则继续保留。

| 端 | 必须交付 | 保持现有边界 |
| --- | --- | --- |
| WANX 客户端 | 固定四档及整数自定义充值；新钱包协议；余额、消费、详情只显示积分；两位小数及微小值文案；新旧订单恢复 | 不自行决定到账额度，不直接入账，不判断注册赠送资格，不另算模型费用 |
| Admin 后端与管理端 | 新面值投影；订单冻结与旧单履约；赠送资格及持久发放任务；来源追踪；旧资产盘点、迁移和补发编排；管理查询及对账 | QeeToken 是消费余额权威；不另建模型定价入口，不增加退款或人工补偿功能 |
| QeeToken | 明确的注册赠送入账；单次发放去重；迁移来源承接；同事务记录赠送优先消费归属；事件与余额一致；WANX 原生充值限制 | USD 账本单位、原计费结果、原纠错机制及欠费准入不重写；其他原生用户不受 WANX 限制影响 |
| 管理员与上线执行 | 按实际采购成本核算 30% 模型毛利并手调价格/倍率；数据盘点；切换核对；迁移后补发 | 不创建自动调价，不假设官方美元价格可直接乘固定倍率；本次不执行任何配置操作 |

现有订单恢复、支付核验、数据库事务、事件序号和管理恢复任务应扩展复用，不另建一套支付或消费账本。

## 2 源码核查发现与关键依赖

以下是开发前发现，用于解释改造原因；链接源码已随实施更新，不能据本表判断当前缺陷或能力。

| 发现 | 已核查位置 | 对实施的影响 |
| --- | --- | --- |
| Admin 的 `RULE_ID` 为 `usd-credit-1-v1`，`remote_amount()` 固定乘 100，充值与期初迁移共用；投影按 USD atoms 除 100 | [nexus_qeetoken_accounting.py](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_qeetoken_accounting.py) | 不能全局改一个乘数。新充值、旧积分迁移、旧订单履约必须分开处理 |
| 下单冻结远端额度和规则 ID，但 `fulfill()` 与事件应用仍用当前转换函数核对 | [订单服务](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_credit_order_service.py)、[记账服务](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_qeetoken_accounting.py) | 旧已支付订单会因新常量冲突或错误重算，必须按原快照履约和验证 |
| 客户端严格检查旧规则 ID、`usd_per_credit='1'`，使用 USD 数值渲染消费，展示 Token 和美元详情 | [wallet-view.mjs](../wanx-client/local-ui/renderer/wallet-view.mjs) | 仅隐藏文本不足以完成升级；需要同时修改协议验证和数据使用 |
| 原子整数格式化已支持两位四舍五入，但主钱包走 `exactPoints()`，微小值返回 `<0.01` | [credit-wallet.mjs](../wanx-client/account/credit-wallet.mjs)、[wallet-view.mjs](../wanx-client/local-ui/renderer/wallet-view.mjs) | 复用 BigInt 格式化，统一各展示入口和上下文文案，无需新造浮点计算 |
| 自定义 `amount_fen` 目前只接受旧三档；商品模式下仍要求 product | [订单 DTO](../../nexusaos-admin/admin-backend/module_nexus/entity/vo/nexus_credit_vo.py)、[订单服务](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_credit_order_service.py)、[客户端请求](../wanx-client/account/credit-wallet.mjs) | 自定义充值是三端请求合同与 UI 的扩展，不能仅添加一个输入框 |
| `accounts/ensure` 创建零余额用户，原生注册赠额不会自动发给托管用户 | [lifecycle.go](../../nexusaos-qeetoken/sub2api/backend/internal/wanx/lifecycle.go) | 保留零余额开户；新增独立赠送事件，不能将开户初始余额直接改成 5 |
| `balance-operations` 仅允许 `recharge`、`migration_opening`；触发器和 Admin 事件白名单也限定类型 | [balance.go](../../nexusaos-qeetoken/sub2api/backend/internal/wanx/balance.go)、[158 余额事件迁移](../../nexusaos-qeetoken/sub2api/backend/migrations/158_wanx_balance_events.sql)、[Admin 应用事件](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_qeetoken_accounting.py) | 新赠送类型必须同时覆盖请求、事务、数据库事件、投影和查询，不能伪装成充值 |
| QeeToken 现有消费事务有去重键和余额事件上下文；原生其他 key 对托管账号的消费也会产生事件 | [usage_billing_repo.go](../../nexusaos-qeetoken/sub2api/backend/internal/repository/usage_billing_repo.go)、[wanx_billing.go](../../nexusaos-qeetoken/sub2api/backend/internal/repository/wanx_billing.go) | 消费来源分摊应在权威账本事务中完成，不能依赖 Admin 异步同步时另算扣款 |
| Admin 自行注册与后台创建已有持久开户排队及提交后通知 | [认证服务](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_consumer_auth_service.py)、[后台用户创建](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_consumer_user_service.py)、[开户编排](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_qeetoken_service.py) | 可挂接赠送意图；远端超时不能把成功注册变成失败，也不能让登录成为赠送触发条件 |
| Admin 当前 `sync()` 会调用 `enroll()`，后台循环自动执行；远端期初要求余额与序号为零 | [记账服务](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_qeetoken_accounting.py)、[balance.go](../../nexusaos-qeetoken/sub2api/backend/internal/wanx/balance.go) | 切换前要控制自动开户/迁移/履约/赠送任务的竞争，不能一边改投影一边让旧任务继续写入 |

## 3 先固定的跨端契约与数据不变量

### 3.1 四条换算路径必须区分

以下 `credit atoms` 为百万分之一积分，`USD atoms` 为亿分之一内部 USD。客户端不显示这些内部单位。

| 路径 | 目标计算 | 校验例子 |
| --- | --- | --- |
| 新充值 | 人民币分 × 1,000,000 = 新 credit atoms = USD atoms；规则要求人民币分为 100 的整数倍 | 10 元 = 1000 人民币分 → 1,000,000,000 atoms → 1000 新积分、10 USD |
| 注册赠送 | 固定 500,000,000 USD atoms，投影同数值的新 credit atoms | 500 积分 → 5 USD |
| 未迁移旧积分期初 | 旧 credit atoms × 100 = USD atoms；再按新口径同数值投影 | 20 旧积分 → 2,000,000,000 USD atoms → 20 USD、2000 新积分 |
| 已有 USD 余额/消费展示 | USD atoms 同数值转换为新 credit atoms，不写 QeeToken 余额 | 5 USD → 500 新积分；0.01 USD 消费 → 1 新积分 |

旧订单是第五种兼容输入：有冻结 `qeetoken_delta_atoms` 时按原快照处理；只有旧 `grant_atoms` 和旧规则时，按原规则解释。既不套新商品金额，也不再从当前 `RULE_ID` 推导原承诺。以订单 ID 维持原 `recharge:<order_id>` 和远端来源身份，不以版本升级生成新的充值意图。

现有 USD 余额可以为负或包含微小尾数，切换只改变积分投影，不清零尾差、不消除欠额。所有乘法需检查 int64/协议范围；客户端使用十进制字符串和 BigInt，不把 atoms 转为 JS Number。

### 3.2 钱包与订单版本

实施首阶段固化新面值标识（例如 `usd-credit-100-v2`，**名称为建议，尚未实现**），并区分：

- **原始事实**：原订单金额、原单位、原到账额度、原规则 ID，原 USD 事件及 sequence 不覆盖。
- **当前展示**：按新规则生成的余额、消费和到账积分字段，以及明确的展示规则版本。
- **业务来源**：订单、注册赠送、旧资产期初与原生纠错分别追踪，购买与赠送不混记。

建议 Consumer 的新钱包/消费响应只提供展示所需的精确积分、规则版本与同步信息；USD、Token 用量和内部比例保留在服务端和管理 API。具体采用响应版本还是新端点在开发首阶段固定，不能无版本删除旧严格 DTO 字段。客户端不得自行用当前比例解释没有版本的旧订单积分字段。

旧客户端硬编码 v1，且本身会显示 USD/Token。上线时必须有兼容客户端先行发布及最低能力检查；未升级客户端停止旧充值入口并提示升级，原支付查询和后台履约责任仍保留。不能为了兼容伪装 v1 返回 v2 数值，也不能仅依赖用户主动升级。

### 3.3 注册赠送协议

建议扩展现有入账协议，增加明确的注册赠送类型（如 `registration_grant`，名称待契约定稿），包含业务来源、固定金额、原领取记录或资格凭证引用。金额由 Admin 按规则生成并由服务端校验，不由客户端提交。

Admin 在本地事务中保存唯一领取资格/发放意图与恢复状态；远端事务提交成功后即为已入账，Admin 以原意图重试并同步原事件。数据库唯一约束至少覆盖“同一 Consumer 注册赠送资格”；QeeToken 同时约束该托管账号的注册赠送来源。不能让改 operation_id、改批次 ID 或换盒子绕过一次领取限制。

新账号、后台创建、旧账号批量补发走同一发放执行器；补发批次只组织任务，不能成为重复领取身份。历史已领取记录必须导入或关联，不能仅看新赠送表是否为空来决定资格。金额相同但来源不同的历史赠送不可未经核对就视为注册赠送。

### 3.4 来源分账与消费归属

实施方向：QeeToken 总余额仍是权威值，在其原有入账/扣费事务中维护赠送与购买来源，并将每笔消费的来源分摊写入不可变事件。Admin 只做有序投影，不再扣一次余额。

必须同时满足：

1. 实际总扣费不变；赠送分摊 + 购买/欠费分摊 = 本次实际扣费。赠送可用部分先扣，余款继续走现有扣费逻辑，允许原机制产生负总余额。
2. 并发调用不能都消费同一份赠额；总余额、来源状态、事件序号及消费去重同事务提交或回滚。
3. 原生余额调整与既有纠错仍有效；来源调整记录与原操作关联，撤回消费时恢复原分摊，不错误形成新充值收入。不能因增加分账就把现有合法余额调整路径禁掉。
4. 对历史余额进行来源初始化时，只建立来源状态，不再次给已有 QeeToken 余额加钱；证据不足的来源进入核对清单，不能默认全部购买或赠送。
5. 欠费、负向原生调整等情况保持总余额一致；来源账需明确表达欠额和调整，不得把负数强行截成零或把欠费计作已收充值收入。具体字段及上述边界算法在开发阶段形成设计与测试，不改变既定欠费政策。

历史迁移中的购买与赠送应在**同一笔期初操作**承接总额及来源分量；不能先发购买期初、再发赠送期初，因为现行远端第二笔会违反余额/序号为零的前置条件。来源分量之和必须等于期初总额，重试校验完整内容而非只比较总金额。

## 4 WANX 客户端改动清单

| 编号 | 文件/模块 | 改动内容 | 依赖与完成标准 |
| --- | --- | --- | --- |
| W1 | [account/credit-wallet.mjs](../wanx-client/account/credit-wallet.mjs) | 扩展明确的自定义金额请求与新合同验证，取消把任意 amount 请求当旧三档的分支；保留购买意图、账户隔离与十进制整数校验 | 依赖 Admin 新 catalog/订单协议；客户端只提交人民币金额或商品选择，不提交到账积分 |
| W2 | [wallet-view.mjs](../wanx-client/local-ui/renderer/wallet-view.mjs) | 四个固定档位 + 自定义金额选择；限制整数元 10～1000；错误提示、服务端报价、支付恢复与渠道选择 | 服务端仍为最终校验者；改变金额应形成新的已持久化购买意图，不覆盖在途订单 |
| W3 | 同上 `load/recover/createOrder` 流程 | 兼容原本地存储购买意图和旧订单状态；关闭旧未支付单后清理本地意图并允许按新规则购买 | 切换不删除已支付/结果未知订单，不为恢复生成新充值 ID |
| W4 | 同上 `validateWallet/validateUsage/remoteView` | 支持新响应版本；余额和消费均读取当前口径的 credit atoms；删去 USD、美元符号、Token 列、比例说明及 tooltip 中相关信息 | 0.01 USD 实际消费正确显示 1.00 积分，不能继续把八位 USD 字符串贴在积分列 |
| W5 | [credit-wallet.mjs](../wanx-client/account/credit-wallet.mjs)、[shell/control.mjs](../wanx-client/shell/control.mjs)、钱包 renderer | 复用 BigInt 四舍五入；统一主钱包、详情、快捷面板、订单到账文案；微小余额/消费/欠费按上下文分别显示 | 不把 `.exact` 六位精度作为用户显示；0.009999 先判微小值，负普通值保留负号 |
| W6 | 钱包同步/账号生命周期 | 保留 pending/stale、分页、事件序号与切号防串账；支持赠送/迁移结果的积分展示，不增加领取按钮 | 新账号不依赖登录后点击或绑定盒子才发放；UI 不重复触发赠送 |
| W7 | [wallet-entry.mjs](../wanx-client/local-ui/renderer/wallet-entry.mjs)、构建产物、现有钱包测试 | 后续改源码后重建 `wallet.bundle.js`，覆盖 macOS/Windows 可用的客户端行为与 Electron E2E | bundle 由脚本构建，不手改；[旧 credits.js](../wanx-client/local-ui/renderer/credits.js) 仅核对是否仍有可达旧入口，不将 shadow 数据接入真实钱包 |

无需因本次积分面值重写模型 Bridge 或设备凭据协议；回归多盒共享和转移场景即可。若发现可达的其他积分展示入口，按 W5 纳入，不能扩展成无关页面重构。

## 5 Admin 改动清单

### 5.1 后端与数据

| 编号 | 文件/模块 | 必须修改或新增的责任 |
| --- | --- | --- |
| A1 | [nexus_qeetoken_accounting.py](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_qeetoken_accounting.py) | 分离新充值换算、旧期初承接和原订单解释；新增当前规则版本投影；余额、消费、累计消费及管理查询一致，不覆盖原 USD 事件 |
| A2 | [nexus_credit_order_service.py](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_credit_order_service.py)、[nexus_credit_vo.py](../../nexusaos-admin/admin-backend/module_nexus/entity/vo/nexus_credit_vo.py) | 自定义人民币分必须在 1000～100000 且整除 100；固定四档由服务端目录提供；冻结金额、规则版本、额度与履约目标。履约和入账核对按冻结快照，不按当前常量重算 |
| A3 | [nexus_credit_configuration_service.py](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_credit_configuration_service.py)、商品配置 DTO、catalog | 发布无优惠/加赠的四档商品与自定义约束；避免旧兼容 20 分/元分支被新请求触发。约束非法价额组合，不能只依赖管理员手填正确 |
| A4 | [nexus_qeetoken_wallet_vo.py](../../nexusaos-admin/admin-backend/module_nexus/entity/vo/nexus_qeetoken_wallet_vo.py)、[Consumer 路由](../../nexusaos-admin/admin-backend/module_nexus/controller/nexus_consumer_credit_controller.py) | 版本化钱包、消费和订单展示协议；只交付用户展示需要的积分字段，原始 USD/Token 留管理查询；提供明确同步状态和当前面值标识 |
| A5 | [认证服务](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_consumer_auth_service.py)、[用户创建服务](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_consumer_user_service.py)、[开户编排](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_qeetoken_service.py) | 注册和后台创建提交时持久化一次领取意图；开户成功后异步发放，无首充/绑定条件；历史账号须经过迁移与领取记录核对。不能把所有 `ensure_account()`、登录或配对当新注册 |
| A6 | [QeeToken 数据模型](../../nexusaos-admin/admin-backend/module_nexus/entity/do/nexus_qeetoken_do.py)、[积分模型](../../nexusaos-admin/admin-backend/module_nexus/entity/do/nexus_credit_do.py)、后续 SQL 迁移 | 新增领取记录、来源分量、规则版本、切换基准、迁移批次/来源映射、执行状态及唯一约束；既有原始订单/事件保持可追溯。变更脚本不靠运行时 `create_all` 隐式完成 |
| A7 | 记账服务的 `_apply/apply_page/sync`、[传输](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_qeetoken_client.py) | 识别新赠送和来源事件；按 account sequence 完整校验、去重与投影；赠送不得通过“充值必须有关联已支付订单”分支，也不能当消费累加；未知版本或缺序列保留恢复责任 |
| A8 | 迁移编排、[管理任务](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_qeetoken_admin.py) | 生成只读盘点和预演结果，随后才可执行版本化迁移；区分已有远端余额、legacy 未迁移、早期来源、已迁移和异常账号；统一期初总额/分量；按账号断点恢复、批次重跑不重复发放 |
| A9 | [恢复服务](../../nexusaos-admin/admin-backend/module_nexus/service/nexus_credit_recovery_service.py)、订单服务、管理任务 | 切换关单先查渠道；实付继续原履约；超时/回调晚到不误取消、不丢履约；订单补单和期初迁移去重；禁止通过重新生成 source_id 消除冲突 |

**既有投影也需要迁移，不能仅改读取函数。** 当前 `apply_page()` 检查 `account.balance_atoms == remote_atoms // 100`，旧期初事件还强制 `credit_delta = 0`。切换至新面值后需在账号级锁/执行门控下，以最后已确认 USD 快照重建当前积分余额，并保存切换规则、旧积分快照和 remote sequence；这是本地展示基准变更，不是远端充值或新收入。新事件从已确认序号继续消费，禁止重置序号重新加全部历史事件。历史消费展示可由原始 USD 事件生成新投影，但保留旧 `credit_delta_atoms` 及其规则，不覆盖原事实。

尚未迁移旧积分的期初则保留旧积分 × 100 的 USD atoms 承接，同时将本地当前积分投影转换为新单位。需明确修改现行“期初 credit_delta=0”的假设及相关检查，不能让本地仍为 20 旧积分却拿它与 2000 新积分比较。

### 5.2 管理端页面与运维能力

涉及：[QeeTokenAdmin.vue](../../nexusaos-admin/admin-frontend/src/views/nexus/credits/QeeTokenAdmin.vue)、[credits/index.vue](../../nexusaos-admin/admin-frontend/src/views/nexus/credits/index.vue)、[qeetoken API](../../nexusaos-admin/admin-frontend/src/api/nexus/qeetoken.js)、[协议工具](../../nexusaos-admin/admin-frontend/src/utils/qeetokenProtocol.js)。

- 修正“1 USD = 1 积分”的管理说明和金额解释，按版本显示原始与当前额度；管理后台允许保留精确 USD/Token 对账信息，不与 WANX 客户端只展示积分混淆。
- 商品维护展示四档及自定义约束，不能将加赠商品误发布到首期规则。
- 增加赠送来源、领取状态、原事件凭证、迁移批次及失败原因的查询/导出；恢复动作仅重放原业务意图。可复用管理任务页，不新增任意金额赠送入口或模型调价入口。
- 新批量任务须有权限、原因、账号范围、批次与执行结果审计；支持先预演、后执行及原任务重试。实际脚本/页面形式在实现阶段选最小方案，不要求新建完整运营平台。

## 6 QeeToken 改动清单

| 编号 | 文件/模块 | 必须修改或核对的责任 |
| --- | --- | --- |
| Q1 | [wanx_handler.go](../../nexusaos-qeetoken/sub2api/backend/internal/handler/wanx_handler.go)、[lifecycle.go](../../nexusaos-qeetoken/sub2api/backend/internal/wanx/lifecycle.go)、[balance.go](../../nexusaos-qeetoken/sub2api/backend/internal/wanx/balance.go) | 扩展严格 DTO/入账分派以支持注册赠送和迁移来源分量；零余额开户保持；原生注册赠额不叠加；内部服务鉴权、账号 namespace 校验继续保留 |
| Q2 | `credit()` 与后续数据库迁移（参考 [158](../../nexusaos-qeetoken/sub2api/backend/migrations/158_wanx_balance_events.sql)） | 用户余额锁内完成单次赠送/期初操作；增加赠送资格唯一约束、来源分量和事件字段；响应丢失后相同意图返回原事件，异内容冲突；同账号第二个新 source 也不能再次领取注册赠额 |
| Q3 | [usage_billing_repo.go](../../nexusaos-qeetoken/sub2api/backend/internal/repository/usage_billing_repo.go)、[wanx_billing.go](../../nexusaos-qeetoken/sub2api/backend/internal/repository/wanx_billing.go)、余额事件触发器 | 在原消费去重与事务内完成赠送优先分摊；总扣费保持原 `BalanceCost`/实际计费结果；原生其他 key 消费、纠错和余额调整同样保持来源及总账一致；不新增预占 |
| Q4 | 事件分页、`Balance()`、数据库事件上下文 | 扩展事件类型白名单和来源元数据，返回可供 Admin 验证的分摊；快照、余额和事件序号一致；不得在原事件之外再写第二笔总余额变动 |
| Q5 | [原生支付路由](../../nexusaos-qeetoken/sub2api/backend/internal/server/routes/payment.go)、[payment_order.go](../../nexusaos-qeetoken/sub2api/backend/internal/service/payment_order.go) | 核对并补齐 WANX 托管用户原生充值的服务端限制，而非只隐藏前端。按托管映射识别用户，非 WANX 用户不受影响；原订单查询、回调与既有责任不被误关 |
| Q6 | 现有模型价卡、分组/用户倍率管理与成本统计 | 无需创建新计费引擎；管理员按实际采购价/账单核算 30% 目标，人工维护倍率并记录复核结果。核对原生 UI 输入单位与用户实际倍率，成本统计倍率不是收费倍率 |

数据库变更应使用仓库当时有效的迁移方式与版本号。不得直接修改已经应用的 `158` 文件指望线上重跑；如属未发布迁移的合并调整，也必须验证已存在本地数据库能正确升级。此处只列需求，不分配未经核查的迁移编号。

QeeToken 不需要因新积分展示把已有 USD 余额乘 100，也不需要修改全部原生模型价格的计价单位。前者会增加真实消费额度，后者会影响非 WANX 用户，均不是本规则要求。

## 7 实施顺序与交付门槛

开发顺序与上线执行顺序分开；新增能力可以先部署但不启用业务写入。最终以一次受控切换生效，不能让三个服务各自看到新版本就自动改变账本。

| 阶段 | 主责 | 交付内容 | 进入下一阶段的条件 |
| --- | --- | --- | --- |
| P0 契约与样本 | 三端协作，Admin 牵头 | 固化新面值标识、Consumer 响应、自定义下单、赠送与来源事件、旧单解释、来源分账及迁移基准；列出老客户端策略；准备脱敏代表性旧数据样本 | 三端能用同一套例子解释新充值、旧迁移、已有余额及原订单，不再共用无版本乘数 |
| P1 权威账本能力 | QeeToken | Q1–Q5：兼容扩展、赠送去重、迁移来源、消费分摊、原生充值边界；覆盖事务和故障重试 | 旧原生用户行为不变；新事件可以精确消费；并发不重复占用赠送 |
| P2 Admin 核心 | Admin | A1–A9：持久赠送、双版本订单履约、投影转换、整数自定义、迁移预演/恢复；后台查询同步调整 | 原订单/历史资产 fixtures 全部过关；远端成功本地失败可恢复；不开启正式赠送或迁移任务 |
| P3 客户端及管理 UI | WANX + Admin 前端 | W1–W7、管理查询/商品/任务适配；可在 P0 后用 mock 并行开发，但联调依赖 P1/P2 | 精度及内容检查、订单恢复、旧客户端门控通过；发行 bundle 与源码一致 |
| P4 三端集成与演练 | 三端协作 | 真实服务 + 隔离数据库 + 模拟支付/上游；混合旧数据切换预演；代表性倍率核算；整理切换和恢复清单 | 第 9 节清单全部有证据；必需集成测试实际执行而非 skip；不把本地模拟验收当生产支付验收 |
| P5 上线准备 | 运维 + 管理员 | 安排时间窗、备份、只读盘点、确认旧订单/调用/领取记录；发布兼容客户端与服务能力、核对商品和倍率 | 老客户端策略、数据来源及异常账号清单明确，完成验收后才可进入正式执行 |
| P6 统一切换 | Admin 编排，QeeToken 执行，WANX 展示 | 按第 8 节切换，最后批量补发并验账；启用新规则后按月复核定价 | 三端余额、事件和支付责任可对账；失败任务有持久恢复状态 |

本次仅交付 P0 的实施分析文档，契约/数据模型尚未编码定型，也未执行 P1–P6。

## 8 后续上线与迁移执行顺序

以下是未来执行清单，不是本次操作指令。须与原生期初约束、旧订单责任和后台自动任务共同演练。

1. **准备与限制新写入**：记录切换时间、规则版本、账号/订单清单、最后同步序号；备份数据库及必要业务凭证。暂停旧规则新下单、自动迁移与赠送等竞争写入，已有支付回调保留并持久记录。对会干扰迁移快照的模型调用和后台结算安排短时受控窗口，已接受调用仍需结算，不篡改长期准入政策。
2. **核对旧订单**：按支付渠道事实区分已到账、已支付未到账、未支付、结果未知。未支付旧单经渠道关单确认后关闭；实际已支付保留原快照和履约责任；未知结果进入核对，不清空本地意图后当新订单处理。
3. **固定旧余额与来源**：将已入账旧订单剩余余额计入资产盘点，将已支付未到账额度保留为独立待履约责任，不同时算入迁移期初。先清理会改变期初的在途结算，再核定购买/赠送来源和历史领取资格；预计消耗、旧人民币钱包排除。
4. **迁移/重建投影**：已有 QeeToken 余额只初始化来源与重建当前积分投影，不新增余额；未迁移账号以稳定 `migration:<account_id>` 单笔承接总额及来源分量，满足远端零余额/零序号条件。各账号记录完成状态后再推进，异常账号不可强行置零。
5. **完成原订单履约并追平事件**：未开户或未迁移账号的补单必须在其期初迁移后入账；其他账号按已有规则恢复。核对回调晚到、重复同步、事件分页和切换期间新事实。原则是“先核对订单、后迁移资产”，并非要求对尚待迁移账号提前执行补单破坏期初条件。
6. **批量注册补发**：在账号迁移完成且领取资格核实后执行原发放意图；500 积分只发一次；失败重排原任务，不以换批次 ID 重新领取。上线窗口新创建账号走相同队列，不与旧账号扫描重复。
7. **验账并开放新规则**：确认四档、自定义、客户端协议和模型倍率已一致；开放新下单和正常调用，继续履约/事件恢复。新账号发放无需盒子或登录操作。切换过程中不对用户展示混合单位。

异常恢复：以原操作 ID、原 source、原事件序号继续完成，不能修改金额后重放同一 ID，也不能换 ID 绕过去重。已经产生 v2 财务事件后，不回退旧换算代码或切回 legacy 扣款；优先暂停受影响入口并向前修复。备份不能用来抹去已核实的外部支付事实。

## 9 验收清单（实施后逐项留证）

下列全部未执行。每项应保留测试结果及相关订单/操作 ID、事件序号、前后余额或界面证据；不能仅以接口返回 200 作为验收。

| 编号 | 场景 | 预期结果 | 主责 |
| --- | --- | --- | --- |
| T01 | 四个固定档位逐档充值 | 50/100/200/500 元分别到账 5000/10000/20000/50000 积分，无加赠 | W/A |
| T02 | 自定义 10、11、1000 与 9、1001、10.50；伪造到账积分/混传 product 与金额 | 合法值成功，非法值在 Admin 被拒；1000 元到账 100000 积分 | W/A |
| T03 | 改商品版本、重复下单、切账号、断网重启 | 旧订单快照不变；重复意图返回原单；不同账号不串订单或余额 | W/A |
| T04 | 支付成功但远端超时、本地投影失败、重复回调与补单 | 订单只到账一次；后台恢复到 credited；用户看见待到账而非误报成功 | A/Q/W |
| T05 | 原旧单 grant 20 旧积分，切换后才确认已支付/补单 | 按原承诺入 20 USD、展示 2000 新积分，不按当前商品重算，不触发旧 RULE_ID 冲突 | A/Q/W |
| T06 | 新充值 10 元；期初 20 旧积分；已有 5 USD | 分别为 1000 新积分/10 USD、2000 新积分/20 USD、500 新积分且 USD 不变 | A/Q |
| T07 | 原投影 balance/sequence 已有值，含 USD 小尾差或负值 | 只转换当前本地展示基准；远端总余额/原事件不变，序号不倒退，不丢尾差或免欠 | A/Q |
| T08 | v1 原始消费与 v2 新消费混合分页 | 按各自原始事实生成新积分显示，排序/分页连续，不能将旧 credit_delta 当新单位 | A/W |
| T09 | 自行注册、后台创建，无首充且无盒子 | 均持久化同一次注册赠送资格，到账 500 积分；远端离线时注册不被回滚 | A/Q |
| T10 | 登录、开户重试、绑定多盒、并发注册任务与批次重跑 | 单账号注册赠送总计只入 5 USD/500 积分，不叠加原生注册赠额 | A/Q |
| T11 | 赠送远端成功后响应丢失；同 source 不同金额或不同迁移分量 | 同内容重试返回原事件；异内容冲突，不生成第二笔入账 | A/Q |
| T12 | 已领取历史注册赠送与仅有其他历史赠送的账号 | 根据真实领取记录判断资格；已领取者不补发，不把任意赠送误判为注册赠送 | A |
| T13 | 旧账号不登录，批量补发与新账号执行器并发 | 符合资格者自动到账一次；批次 ID 不影响领取唯一身份 | A/Q |
| T14 | 赠送 100、购买 1000，消费 150 | 赠送剩 0、购买剩 950；原总扣费不变；事件分摊合计 150 | Q/A |
| T15 | 两次并发消费争用最后一笔赠额，事务失败或消费重放 | 赠额不重复分摊；余额、来源、序号、去重一起提交/回滚 | Q |
| T16 | 原生 key 消费、原生纠错、余额调整 | 仍按既有总账机制执行，来源记录与总余额一致；不伪造充值收入或第二次扣费 | Q/A |
| T17 | 正余额准入后在途扣成负数；充值不足与足够清欠 | 负数如实保留；非正余额停止新调用；充值抵欠，仍非正时不恢复准入 | Q/A/W |
| T18 | 假设实际模型成本 0.07 元 | 管理员配置后的代表性付费调用收入目标 0.10 元/10 积分；核对最终倍率，不把成本统计倍率当收费 | Q/管理员 |
| T19 | 赠送和历史购入额度用于消费 | 不把赠送当充值收入，不对所有旧资产套用每 USD 收入 1 元；核算记录可追溯 | A/管理员 |
| T20 | WANX 账号直调原生充值与非 WANX 用户充值 | 前者被服务端限制，后者正常；原生既有订单回调责任不受误伤 | Q |
| T21 | 充值退款或额外人工补偿入口 | WANX 不新增这些入口；已有 QeeToken 纠错继续可用 | W/A/Q |
| T22 | 早期已发放真实旧积分、shadow 数据、人民币钱包混合 | 只迁真实未消费未迁移积分，购买/赠送来源保留；不改人民币钱包余额 | A/Q |
| T23 | 同一旧资产被多个来源记录引用，迁移重跑 | 能识别重复来源；只承接一次；无额外迁移补贴 | A/Q |
| T24 | 期初含购买和赠送两部分 | 单笔总期初与分量合计一致；不会第二次触发 migration_opening；赠送未抢先入账 | A/Q |
| T25 | 未支付旧单关单与支付竞争、未知结果、延迟回调 | 查询/关单证据完整；实付继续原履约，结果未知保持核对；不漏发、不重复发 | A/Q |
| T26 | 已支付已到账旧订单仍有未消费余额 | 不再重发订单，但未迁移剩余资产仍正确承接；不把整单原额重复计期初 | A |
| T27 | 主钱包、消费详情、tooltip、快捷面板及订单页面 | 只显示积分和应付人民币，无 USD、美元符号、Token 用量或比例；内部管理对账仍有原数据 | W/A |
| T28 | 123.4、12.344、12.345、-12.345 | 分别显示 123.40、12.34、12.35、-12.35；内部 atoms 不变 | W |
| T29 | 0、0.009999、-0.009999、正负 0.01 | 真零 0.00；微小余额/消费/欠费分别使用已定文案；正负 0.01 不使用“不足”，无 -0.00 | W |
| T30 | pending/stale、乱序返回、断点事件分页与账号切换 | 未知不显示零；保留最后确认值；不跳序号、不用旧账号响应覆盖新账号 | A/W |
| T31 | 旧客户端直发旧三档请求、新服务收到旧 DTO | 不偷偷创建旧规则新单；兼容策略明确；原意图与已支付旧单可继续核对履约 | W/A |
| T32 | 切换任务半途失败、服务重启后恢复 | 依据账号阶段和原操作恢复；已成功迁移/发放的不重复；失败记录可审计 | A/Q |

## 10 可复用测试与后续命令

本次不运行下列命令。开发完成后先做有针对性的测试，再跑各仓库要求的完整检查。数据库集成测试必须指向隔离测试库，不使用现有业务库；缺少环境导致的 skip 不能作为通过证据。

### WANX

现有入口：[钱包测试](../wanx-client/tests/credit-wallet.test.mjs)、[视图测试](../wanx-client/tests/credit-wallet-view.test.mjs)、[IPC 测试](../wanx-client/tests/credit-wallet-ipc.test.mjs)、[Electron 测试](../wanx-client/tests/credit-wallet-electron.test.mjs)。

在 `centaur-WANX` 根目录：

```sh
npm run build:renderer --prefix wanx-client
npm test --prefix wanx-client
WANX_TEST_ELECTRON=1 node --test wanx-client/tests/credit-wallet-electron.test.mjs
make all
```

`make all` 会执行格式化；仅在实际代码实施时按仓库要求运行并检查范围，不用于本次纯文档任务。Electron 命令需相应图形/运行环境，Windows 环境变量按平台方式设置。

### Admin

复用并扩展 `admin-backend/tests/module_nexus` 中的 `test_credit_products.py`、`test_credit_orders.py`、`test_credit_payment_recovery.py`、`test_qeetoken_accounting.py`、`test_qeetoken_cutover.py`、`test_qeetoken_compatibility.py`、`test_qeetoken_admin.py`；增加新赠送、来源分摊与版本切换 fixtures。

在 `nexusaos-admin/admin-backend` 的项目测试环境：

```sh
uv run pytest tests/module_nexus/test_credit_products.py tests/module_nexus/test_credit_orders.py tests/module_nexus/test_credit_payment_recovery.py tests/module_nexus/test_qeetoken_accounting.py tests/module_nexus/test_qeetoken_cutover.py tests/module_nexus/test_qeetoken_compatibility.py tests/module_nexus/test_qeetoken_admin.py -q
```

在 `nexusaos-admin/admin-frontend`：

```sh
npm test
npm run build:prod
```

不把局部测试替代该仓库实施时要求的其他全量检查。

### QeeToken 与跨端联调

在 `nexusaos-qeetoken/sub2api/backend`：

```sh
go test ./internal/wanx ./internal/repository ./internal/handler
go test ./internal/handler -run 'TestWanxCrossService(Lifecycle|Billing)' -v
make test
```

现有真实数据库及跨服务测试要求 `WANX_TEST_POSTGRES_DSN`，跨服务还要求 `WANX_TEST_ADMIN_ROOT`、`WANX_TEST_BRIDGE_ROOT`，并校验本机一次性 `lifecycle_test` 数据库。Admin 依赖环境需可用；未满足时测试会跳过，应记录为未验收。

复用 [本地三端联调环境](../../nexusaos-admin/admin-backend/deploy/qeetoken-local/README.md)，后续更新其旧面值/1 元测试商品及 smoke 断言后再运行。它使用模拟支付、短信、上游与盒子，不能替代真实支付通知、流式断连和生产采购价格核对。

## 11 交付物与本次检查边界

后续实施应交付：三端版本化契约；服务与数据迁移代码；客户端源码及生成 bundle；原生/管理配置执行清单；只读盘点与预演报告；逐账号迁移/补发恢复记录；T01–T32 验收证据及上线手册。

对应合同入口：[Consumer 支付 API](../../nexusaos-admin/docs/contracts/credits-payment-api.md)、[Admin–QeeToken 集成 API](../../nexusaos-admin/docs/contracts/qeetoken-credit-api.md)、[当前部署手册](../../nexusaos-admin/docs/qeetoken-independent-deployment.md)、[WANX 当前接入说明](credits.md)。这些文件描述当前实现，后续开发时再随真实接口同步；本次不将计划中的 API 写成已实现合同。

本次仅核查本地源码与文档，未确认线上配置、实际采购账单、存量余额来源或用户客户端版本分布。实施前对数据缺失与历史责任进行核对，属于执行前提，不是重新讨论已经确定的充值、赠送或迁移比例。
