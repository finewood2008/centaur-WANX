> 历史归档（2026-10-21）：保留各阶段开发、命令、计数及审查记录，文中的“当前”“下一条”仅指记录当时。当前实施状态见[任务状态](../credit-tracer-tasks.md)，不得按本文件的阶段状态执行上线。原始 JSON、截图及文件摘要未改写；`/tmp` 日志路径是当时的本机位置，不保证长期保留。

# 积分 v2：Tracer bullet 实施任务

日期：2026-10-20。依据：[业务规则](../credit-business-rules.md)、[实施方案](../credit-implementation-plan.md)。

每条 tracer bullet 是一个有输入、持久事实、恢复路径和可观察结果的纵向场景。W/A/Q 编号仍引用实施方案；不将“某端代码写完”当作跨端验收通过。代码开发和正式业务切换分开。

## 分支与基线

三个项目统一新建 `codex/credit-v2-tracer-20261020`。本地没有 `develop` 引用，沿用已包含本方案依赖代码的当前 HEAD；未提交或推送。

| 仓库 | 起点分支 | 起点提交 |
| --- | --- | --- |
| WANX | `codex/restore-custom-providers` | `cc28a58e7a59fb7228c3f45be5b19ef990fabaff` |
| Admin | `codex/restore-custom-providers` | `0d7e36787fac5ea3b754e9fa5302914f99c1a049` |
| QeeToken 外层 | `codex/qeetoken-account-device-lifecycle` | `cd4a00dff5ad80d20ca8c7004b666a1107592e3c` |
| QeeToken `sub2api` 子模块 | `codex/sync-sub2api-github-20261020` | `fb9480c5bbbc52d442ebab5e50d87632c3e82787` |

WANX 原有未提交的 `docs/credits.md`、业务规则及实施方案保留。QeeToken 外层原先已有子模块指针差异，不能把这部分差异误记为本轮开发。

## 任务图与验收门槛

| 任务 | 纵向场景与实际交付 | 涉及范围 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| TB00 | 固化面值、原订单与展示合同，用代表性旧数据解释每条路径；逐条补齐赠送、来源、迁移合同 | P0；W1/A1/A4/Q1 | 无 | T05/T06/T11/T24 的共同样本；当前仅订单子合同已编码 |
| TB01 | 原已支付订单 → 原冻结 USD 入账 → 同序号投影 → 原购买意图恢复 → 明确版本的到账显示；远端成功响应丢失仍只入账一次 | W3/W5/W7；A1/A2/A7/A9；Q2/Q4 既有接口 | TB00 订单合同 | T04/T05/T03 的旧单子场景；本轮实施 |
| TB02 | 核实的历史来源 → 同事务来源状态 → 原生调整/纠错 → 不增加总余额的来源初始化；未知来源保持待核对 | A6/A7/A8；Q2/Q3/Q4 | TB00 来源合同 | T07/T16/T19/T22/T23；真实数据库事务与回滚 |
| TB03 | 自行注册/后台创建 → 持久资格 → 开户恢复 → 500 积分唯一赠送 → 事件投影；离线不回滚注册 | A5/A6/A7；Q1/Q2/Q4；W6 | TB02 | T09–T12；同账号改 source/批次也不能重复领取 |
| TB04 | 赠送+购买余额 → 原生实际扣费 → 赠送优先分摊 → 不可变事件 → Admin 查询；覆盖原生 key、并发、纠错及欠额 | A7；Q3/Q4；W6 | TB02/TB03 | T14–T17/T19；分摊与实际扣费同事务 |
| TB05 | 已确认 USD 快照 → 账号级展示基准切换 → v2 钱包/消费分页 → 客户端精度与状态；历史原事实不改 | A1/A4/A6/A7/A8；W4/W5/W6/W7 | TB01/TB04 | T06–T08/T27–T30；尾差、负值、切号、乱序、旧页混合 |
| TB06 | 选择五档/整数自定义 → 服务端校验并冻结 → 支付核验 → v2 入账 → 当前积分展示；旧客户端新下单门控 | A2/A3/A4/A9；W1/W2/W3；Q5 | TB05 | T01–T04/T20/T21/T31；原生非 WANX 充值正常 |
| TB07 | 只读盘点 → 来源及领取证据核对 → 单笔旧期初 → 投影切换 → 断点恢复；已有 USD 不加钱 | A6/A8；Q1/Q2/Q4；管理查询 | TB02/TB05 | T06/T07/T22–T24/T26/T32；购买+赠送分量合计、来源去重；补齐未知来源核实后的独立重分类事件，核对完成才可切换 |
| TB08 | 已迁移旧账号 → 唯一资格确认 → 原赠送执行器批量补发 → 失败原任务重排 → 管理查询与审计 | A5/A6/A8；Q2；W6 | TB03/TB07 | T10–T13/T32；不依赖登录/盒子，不以批次为领取身份 |
| TB09 | 支付查询/关单竞争 → 原单履约 → 追平事件 → 迁移/补发门控 → 重启恢复；形成切换预演报告 | A8/A9；Q2/Q4；W3/W6 | TB06/TB07/TB08 | T04/T05/T25/T26/T30–T32；未知支付不误关、原意图不换 ID |
| TB10 | 三端完整演练 → Electron/Windows 检查 → 代表性价格核算记录 → 上线与向前恢复手册 | P4/P5；全部相关端 | TB09 | T01–T32 留证，尤其 T18/T27；本地模拟不等于生产支付验收 |

TB01 是 P0 后先做的兼容准备，不提前启用 v2 新单或新面值。其后的任务仍遵守权威来源账、Admin 编排、UI、演练的依赖。P6 正式切换和实际迁移/补发不属于本轮开发执行。

## TB00 已固化的订单子合同

- 面值标识：`usd-credit-1-v1` 为原始面值，`usd-credit-100-v2` 为新面值。原充值商品 `rule_id` 与面值 ID 是不同概念。
- QeeToken 入账协议继续使用原 `recharge:<order_id>` 操作身份、`source_id=<order_id>`、USD atoms 十进制字符串；不增加第二笔换面值入账。
- 有远端快照时使用原 `currency_rule_id` 校验原 `grant_atoms` 和 `qeetoken_delta_atoms` 的一致性，不依赖当前活动规则。未知版本、非规范整数、内容不一致或溢出均不重新解释为新额度。
- 没有远端快照时，只承认已知 v1 形状：明确旧面值 ID，或旧 `credit_scale=6` 且带商品快照/`points_per_yuan='20'` 的历史订单。不以当前商品重算。
- Consumer `OrderView` **追加** `credit_display={currency_rule_id,credit_scale,grant_credit_atoms}`。原 `grant_credit_atoms`、`rule_id` 和数据库快照不变。旧服务没有该字段时兼容原 v1 展示；新客户端不得自行乘当前比例。未知展示版本保留本地购买意图并报协议错误。
- 展示快照无法解释时 `credit_display=null`，原订单查询/关闭仍可用；客户端显示待核对、保留原意图、隐藏付款码，不把 null 当作旧服务缺字段而展示旧单位。
- TB01 当时保持 v1 面值；TB05 已加入按账号持久展示基准，未进行生产切换，不得通过修改一个全局常量激活 v2。

代表性订单：原 `grant_atoms=20000000`（20 旧积分）、原 USD 冻结值 `2000000000`；入账仍为 20 USD。v2 展示为 `2000000000` credit atoms，即 `2,000.00` 积分。新 v2 订单样本的 `1000000000` credit atoms 则仅对应 `1000000000` USD atoms，不能再乘 100。

钱包/消费响应及展示基准已由 [TB05 展示合同](../credit-display-contract.md) 固化；旧资产迁移合同与隔离验收已在 TB07 补齐，不能把本节视为上线切换完成。TB02 的来源子合同见 [credit-source-contract.md](../credit-source-contract.md)，TB03 注册赠送子合同见 [credit-registration-contract.md](../credit-registration-contract.md)。

## TB01 验证记录

状态：**TB01–TB09 已实现并完成各自隔离环境验收；TB10 本地开发、三端隔离联调、macOS Electron、核算与恢复文档已交付，Windows 和实际采购/收费、支付、生产恢复证据仍待验收，发布结论 NO-GO。** TB00 已固化订单、来源、赠送、消费、展示、新充值、旧资产迁移、批量补发及支付责任/切换预演子合同。本记录不代表生产支付验收或统一切换完成。

测试使用新建、标记为 disposable 的 `wanx-credit-v2-mysql-20261020` / `wanx-credit-v2-postgres-20261020` 容器，不连接现有业务库。测试结束后移除本轮容器。

| 检查 | 结果 |
| --- | --- |
| WANX `make all` | 通过：4841 passed，17 skipped；Ruff、mypy 与格式检查通过。未改 Octop 后端或 dashboard |
| WANX `npm run build:renderer --prefix wanx-client` | 通过；`wallet.bundle.js` 由脚本生成 |
| WANX `npm test --prefix wanx-client` | 1449 passed，19 skipped，0 failed；skip 是默认未启用的可选环境场景，不算已验收 |
| WANX `WANX_TEST_ELECTRON=1 node --test wanx-client/tests/credit-wallet-electron.test.mjs` | 1 passed，0 skipped；本机 macOS Electron，未做 Windows 真机验收 |
| Admin 下述相关回归 | 75 passed，2 skipped；两个 live relay 项在下述跨服务测试单独运行并通过 |
| Admin 修改文件 Ruff、审查中的 mypy | 通过 |
| QeeToken `go test ./...`（含独立 PostgreSQL 环境） | 通过；WANX 事务测试实际执行 |
| QeeToken `TestWanxCrossServiceBilling` | 通过；原支付消费、新旧单恢复、完整 Consumer journey 各 1 passed，均未 skip |
| QeeToken 全量 lint | **未通过**：补装 CI 指定系列的 golangci-lint v2.9.0，使用 CI 的 Go 1.26.4 后报告 22 项既有问题（depguard 1、errcheck 15、staticcheck 6） |
| QeeToken `golangci-lint run --new-from-rev=HEAD ./...`（Go 1.26.4） | 通过：0 issues；本轮新增仅跨服务测试调用，未扩大修复无关基线问题 |
| 三个代码仓库 `git diff --check` | 通过 |

Admin 命令（`admin-backend` 目录，隔离容器变量已设置）：

```sh
uv run --python .venv/bin/python pytest \
  tests/module_nexus/test_credit_denomination.py \
  tests/module_nexus/test_credit_products.py \
  tests/module_nexus/test_credit_orders.py \
  tests/module_nexus/test_credit_payment_recovery.py \
  tests/module_nexus/test_qeetoken_accounting.py \
  tests/module_nexus/test_qeetoken_cutover.py \
  tests/module_nexus/test_qeetoken_compatibility.py \
  tests/module_nexus/test_qeetoken_admin.py -q --tb=short
```

跨服务命令在 QeeToken `sub2api/backend` 目录执行：

```sh
# 先为本次新建的隔离环境设置：
# CREDITS_TEST_CONTAINER：带 wanx.credits.disposable=true 标签的一次性 MySQL 8 容器
# WANX_TEST_POSTGRES_DSN：回环地址、一次性 lifecycle_test 库（端口由 docker port 查询）
# WANX_TEST_ADMIN_ROOT：Admin/admin-backend 的绝对路径
# WANX_TEST_BRIDGE_ROOT：WANX/wanx-bridge 的绝对路径
go test ./internal/handler -run '^TestWanxCrossServiceBilling$' -v -count=1
```

该测试经真实 Go HTTP/PostgreSQL 入账，丢失成功响应后由 Admin 原任务重试，再经真实 Consumer 订单路由（ASGI，测试身份覆盖）返回 JSON；WANX 实际解码与 renderer 恢复原订单。支付事实为测试模拟，不涉及真实人民币付款。最后一次运行证据：

```json
{
  "tracer": "TB01",
  "order_id": "5eadb579-0d51-42ed-9c73-2ff06fe0889a",
  "operation_id": "recharge:5eadb579-0d51-42ed-9c73-2ff06fe0889a",
  "event_id": "faa3f4f1-5212-4cc0-bbce-6f6789a423bd",
  "remote_sequence": "1",
  "before_usd_atoms": "0",
  "after_usd_atoms": "2000000000",
  "original_grant_credit_atoms": "20000000",
  "credit_display": {
    "currency_rule_id": "usd-credit-100-v2",
    "credit_scale": 6,
    "grant_credit_atoms": "2000000000"
  },
  "client_verified": "old order: 20 original credits -> 2000.00 displayed credits; original intent recovered"
}
```

错误回归已先观察失败再修复：原实现切换活动面值后履约报 `IDEMPOTENCY_CONFLICT`；原 renderer 错把原 20 旧积分显示为 20.00；首次实现的严格展示转换又阻断损坏订单查询/关闭，现改为明确不可用展示并保留恢复责任。未知字符串/非字符串版本、矛盾冻结额度、整数格式、溢出和关闭恢复均有测试。

审查按 `code-review` 技能分开进行：Standards 轴发现的订单可查询性回归已修复，最终 0 项；Spec 轴发现的非字符串版本异常已修复，最终 0 项。Go 补充审查无发现。QeeToken 全量 lint 的基线问题仍是交付门槛缺口，未以差异检查代替全量通过。

## TB02 开发与验收记录

实施日期：2026-10-20，沿用三个项目及子模块的 `codex/credit-v2-tracer-20261020`。合同见 [TB02 来源初始化](../credit-source-contract.md)。本任务在 Admin/QeeToken 交付，WANX 沿用 TB01 客户端，不增加展示切换。

| Tracer bullet | 开发结果 | 验证结果 |
| --- | --- | --- |
| TB02.1 已有 USD → 核实证据 → 来源初始化 → 原事件恢复 | 159 来源/资产引用表、账号唯一初始化、余额和序号 CAS、零金额事件、同事务回执 | 真实 PostgreSQL：来源总和、尾差/负值、8 路并发重试、换 source 冲突、跨账号重复资产、过期证据、回执失败全事务回滚；158→159 原事件和旧充值回执不变 |
| TB02.2 原生余额事件 → 来源变化 → 明确纠错/未知待核对 | 购买/赠送/未核实/调整四分量，赠送优先消费，原生无关联调整保留核对；完整关联撤销恢复原分摊 | 真实扣费 repository：并发 native key、重复结算、总扣费 120 atoms、余额从 100 到 -20；完整撤销、重复撤销拒绝、跨初始化恢复未知来源及 pre159 无分摊纠错 |
| TB02.3 管理预演 → 持久任务 → 远端响应丢失 → 按序投影/审计 | 有权限且只读的预演、摘要校验、冻结证据和原状态、原任务恢复、来源投影与查询 | 真实 Go HTTP/PostgreSQL → Admin/MySQL：第 1 次远端提交后丢响应，第 2 次恢复；原充值事件原样、只有 1 个来源事件、总 USD 不变、财务流水仍只有原充值；错误页全部回滚 |

TDD 先观察两条行为失败：Go 来源初始化返回 WANX_INVALID_REQUEST；Admin 拒绝合法 source_initialization。实现后通过。审查又补齐跨初始化纠错和超 int64 来源差值回归；未仅用实现镜像断言。

验收映射与边界：T07 只覆盖不改已有 USD、序号不倒退、尾差/负值保留，展示基准切换留 TB05；T16 覆盖原生扣费、余额调整及关联完整撤销的事务合同，原生 UI 没有新增引用选择器；T19 确认初始化/赠送来源不计收入或消费，不将所有历史余额套当前购入价；T22 在本任务拒绝 shadow/人民币/未迁移来源，实际 legacy 搬迁留 TB07；T23 覆盖同资产身份跨账号/批次去重及任务重跑。不得把这些子场景记为 T01–T32 全量验收完成。

来源初始化可以保留未知分量，此时 initialized=true 但 review_required=true。当前没有二次重分类入口；TB07 必须补独立带证据事件，不能重放初始化。核实未完成的账户不得进入后续切换。

测试环境是本轮新建、带 `wanx.credits.disposable=true` 标签的 `wanx-tb02-postgres`（独立 schema）与 `wanx-tb02-mysql`。所有数据库写入发生在隔离测试环境；未连接业务库。结束后移除这两个容器。

### 验证结果

| 检查 | 结果 |
| --- | --- |
| WANX `make all` | 4841 passed、17 skipped，Ruff/mypy/格式检查通过 |
| Admin 相关回归（命令见下） | 88 passed、3 skipped；3 个 live 测试由跨服务 Go fixture 实际执行 |
| Admin 修改文件 Ruff / 格式检查 | 通过 |
| Admin 新服务与 DTO `mypy --no-incremental --follow-imports=silent --ignore-missing-imports` | 3 files 通过；不代表整个依赖图类型检查通过 |
| QeeToken `go test ./...` + 隔离 PostgreSQL | 通过 |
| QeeToken `TestWanxCrossServiceBilling` | 旧支付消费、TB01、TB02 和完整 Consumer journey 全部通过，无 live skip |
| QeeToken 全量 golangci-lint（Go 1.26.4 / v2.9.0） | 22 项基线问题仍未通过：depguard 1、errcheck 15、staticcheck 6 |
| QeeToken `golangci-lint run --new-from-rev=HEAD ./...` | 0 issues |
| 规范/Python/security、Go/PostgreSQL、Spec 审查 | 已修复发现，最终均 0 项未解决；审查与测试结果分别留证 |

Admin 可复现命令（设定一次性 MySQL 容器后，在 admin-backend 执行）：

```sh
CREDITS_TEST_CONTAINER=wanx-tb02-mysql uv run --python .venv/bin/python pytest \
  tests/module_nexus/test_qeetoken_sources.py \
  tests/module_nexus/test_credit_denomination.py \
  tests/module_nexus/test_credit_products.py \
  tests/module_nexus/test_credit_orders.py \
  tests/module_nexus/test_credit_payment_recovery.py \
  tests/module_nexus/test_qeetoken_accounting.py \
  tests/module_nexus/test_qeetoken_cutover.py \
  tests/module_nexus/test_qeetoken_compatibility.py \
  tests/module_nexus/test_qeetoken_admin.py -q --tb=short
```

跨服务环境变量和命令沿用 TB01 的隔离配置，新增 `test_qeetoken_sources.py -k live_relay_sources` 由 Go fixture 自动执行。输出中的 TB02 JSON 留下原余额、结果余额、远端事件 ID、任务 ID、尝试次数、来源快照及序号。

发布前仍须解决 QeeToken 的全量 lint 基线门槛，并按来源合同规定的 Admin → QeeToken 顺序部署。Admin 包含导入依赖图的 mypy 检查也未全绿（既有依赖类型/ORM 声明问题）；定向检查不能代替全项目通过。本轮未提交或推送，未执行生产迁移、赠送或切换。

最后一次跨服务验收的持久身份和原金额（仅测试数据）：

```json
{
  "tracer": "TB02",
  "job_id": "59b865e0-aa97-41e8-a9d9-0a0042c8cdef",
  "attempts": 2,
  "event_id": "2ee48d2d-5f19-47b7-8e69-e030579523f8",
  "before_usd_atoms": "100000000000",
  "after_usd_atoms": "100000000000",
  "remote_sequence": "2",
  "sources": {
    "adjustment_atoms": "0",
    "grant_atoms": "0",
    "initialized": true,
    "purchased_atoms": "100000000000",
    "review_required": false,
    "unattributed_atoms": "0",
    "version": "1"
  }
}
```


## TB03 开发与验收记录

实施日期：2026-10-20。三个项目及 QeeToken 子模块沿用 `codex/credit-v2-tracer-20261020`，完整协议见 [注册赠送合同](../credit-registration-contract.md)。完成新注册赠送纵向链路；尚未启用生产开关，也未执行历史批量补发或统一面值切换。

| Tracer bullet | 开发结果 | 验证结果 |
| --- | --- | --- |
| TB03.1 自行注册/后台创建 → 本地事务资格 → 后台开户 → 唯一赠送 | 新资格与账号同事务，失败一起回滚；后台租约独立恢复，固定 500 新积分/5 USD；零余额开户不变 | 短信、密码、后台创建、客户端身份冲突回滚；既有账号登录/补密码/ensure 不新增资格。自行注册和后台创建均完成真实 Go HTTP + PostgreSQL → Admin/MySQL → WANX renderer 全链路，无充值或设备 |
| TB03.2 原赠送 → 响应丢失 → 重启/并发/管理修复 → 同一原事件 | user/资格双重唯一约束、源账 grant 分量；按序校验投影后才标已到账；独立赠送账本类型及钱包状态 | 8 路并发只一个事件；错金额/规则/跨账号资格/换 source 均拒绝；回执失败回滚。远端已提交后丢响应，第 2 次恢复原事件；错误资格/规则/source 页整体回滚；管理任务引用原资格，不再入账；Consumer 流水及类型筛选 200 |
| TB03.3 历史领取证据 → 权限登记 → 账号/证据/操作去重 → 排除或等待迁移 | 查询原资格和证据；登记已领为 historical_received、未领为 waiting_migration；不依据空表或相同金额推断 | 无 reconcile 权限拒绝、缺 Idempotency-Key 拒绝、原请求重放、换判定/复用证据冲突；并发两个账号重用同一管理员操作仅一份成功。普通历史赠送不自动生成注册资格，已领/待迁移均不触发发钱 |

验收范围：T09 新注册与后台创建已通过；T10/T11 覆盖本轮新资格、开户重试、并发与响应丢失，批次实际重跑和旧资格发放保留到 TB08；T12 覆盖真实证据登记、历史已领排除及其他赠送不能自动认定。T13 旧账号无登录批量补发尚未实施。W6 追加明确版本的赠送状态，不增加领取入口；总余额仍是 v1，TB05 负责统一改为新面值。当前来源 initialized/review_required 沿用 TB02 的历史核对语义，不能将赠送到账当作来源历史核对已完成。

TDD 已观察并修复：原 Go API 不接受 registration_grant、注册无持久资格、客户端缺少赠送状态、历史操作换账号原先返回 200（现 409）。审查发现赠送账本 kind 未纳入读取 DTO/筛选枚举，已补齐并通过真实 Consumer 路由回归。MySQL DATETIME 秒级舍入可能让刚写入的到期时间略晚于即时 tick；验收按下一调度周期推进到期时间，避免依赖运行速度。

### 验证结果

| 检查 | 结果 |
| --- | --- |
| WANX `make all` | 4841 passed、17 skipped；Ruff、mypy 与格式通过 |
| WANX `npm run build:renderer` / `npm test` | 构建通过；1450 passed、19 skipped、0 failed |
| WANX `WANX_TEST_ELECTRON=1 node --test wanx-client/tests/credit-wallet-electron.test.mjs` | 1 passed、0 skipped；本机 macOS，不代表 Windows 真机验收 |
| Admin 相关回归（下列命令） | 108 passed、5 skipped；5 个 live 参数用例均由 Go fixture 实际执行通过 |
| Admin 新增赠送模块 mypy（follow-imports=silent） | 2 files 通过；整个 Admin 依赖图的既有类型问题未作为已解决 |
| Admin 修改/新增文件 Ruff | 除原认证文件既有 F821 外通过；新增赠送模块与 DTO、SQL 对应模型、测试格式通过 |
| QeeToken `go test ./...` + 隔离 PostgreSQL | 通过 |
| QeeToken `TestWanxCrossServiceBilling` | 旧支付消费、TB01、TB02、TB03 自行注册/后台创建以及完整 Consumer journey 均通过，无 live skip |
| QeeToken 全量 golangci-lint（Go 1.26.4 / v2.9.0） | 22 项既有问题：depguard 1、errcheck 15、staticcheck 6；未全绿 |
| QeeToken `golangci-lint run --new-from-rev=HEAD ./...` | 0 issues |
| Standards/Python/security、Go/SQL、Spec 审查 | 已修复发现，复审 0 项未解决 |

Admin 全量修改文件检查中的既有问题为 `nexus_consumer_auth_service.py` 的 `list_devices` 内 `RemoteOpsStreamService` 未定义（当前行 697，HEAD 原行 693）。已用 `git show HEAD:admin-backend/module_nexus/service/nexus_consumer_auth_service.py` 输入同一 Ruff 配置复现，不属于本轮注册钩子；未扩大范围修改。上述基线问题意味着不能宣称三端全量发布门槛全绿。

测试使用本轮新建、带 `wanx.credits.disposable=true` 标签的 `wanx-tb03-postgres` 和 `wanx-tb03-mysql`，无宿主目录绑定，只有本轮自动创建的数据卷；只在这些一次性环境迁移/入账。验收完成后移除这两个容器及自动数据卷。没有业务库 SQL、真实赠送、生产切换、提交或推送。

可复现的 Admin 回归命令（`admin-backend` 中执行，需准备一次性 MySQL）：

```sh
CREDITS_TEST_CONTAINER=wanx-tb03-mysql uv run --python .venv/bin/python pytest \
  tests/module_nexus/test_registration_grants.py \
  tests/module_nexus/test_qeetoken_sources.py \
  tests/module_nexus/test_credit_denomination.py \
  tests/module_nexus/test_credit_products.py \
  tests/module_nexus/test_credit_orders.py \
  tests/module_nexus/test_credit_payment_recovery.py \
  tests/module_nexus/test_qeetoken_accounting.py \
  tests/module_nexus/test_qeetoken_cutover.py \
  tests/module_nexus/test_qeetoken_compatibility.py \
  tests/module_nexus/test_qeetoken_admin.py \
  tests/module_nexus/test_qeetoken_authority.py \
  tests/module_nexus/test_consumer_user_admin.py -q --tb=short
```

跨服务命令在 `nexusaos-qeetoken/sub2api/backend` 中执行。`WANX_TEST_POSTGRES_DSN` 指向独立测试 PostgreSQL；Go fixture 创建独立 schema 并自动拉起真实 HTTP 服务，再顺序调用 Admin pytest 与 WANX renderer。

```sh
WANX_TEST_POSTGRES_DSN='postgres://postgres@127.0.0.1:<disposable-port>/lifecycle_test?sslmode=disable' \
CREDITS_TEST_CONTAINER=wanx-tb03-mysql \
WANX_TEST_ADMIN_ROOT=/Users/lynn/Documents/centaurai/projects/nexusaos-admin/admin-backend \
WANX_TEST_BRIDGE_ROOT=/Users/lynn/Documents/centaurai/projects/centaur-WANX/wanx-bridge \
go test ./internal/handler -run '^TestWanxCrossServiceBilling$' -count=1 -v
```

最后一次两条跨服务赠送验收的身份与金额（均为测试数据）：

```json
[
  {
    "tracer": "TB03",
    "origin": "self_registration",
    "account_id": "27fc51c6-15ed-40ab-a776-6c1783d1f059",
    "remote_id": "5",
    "eligibility_id": "d4497eb8-fe6d-4cae-a22c-fe4aba056269",
    "event_id": "ee2dabf4-b0c2-4d58-a613-110de51f8ab6",
    "attempts": 2,
    "before_usd_atoms": "0",
    "after_usd_atoms": "500000000",
    "sources": {
      "adjustment_atoms": "0",
      "grant_atoms": "500000000",
      "initialized": false,
      "purchased_atoms": "0",
      "review_required": true,
      "unattributed_atoms": "0",
      "version": "1"
    },
    "client_verified": "registration credited: 500.00 new credits; USD balance 5.00000000; no claim action"
  },
  {
    "tracer": "TB03",
    "origin": "admin_creation",
    "account_id": "a6aec51b-3596-4305-86a4-b6cd259b8d8b",
    "remote_id": "6",
    "eligibility_id": "ce1310ce-e617-4ee7-b384-fcff5dee47e5",
    "event_id": "25848335-a61a-4774-9572-73f6ba0c336c",
    "attempts": 2,
    "before_usd_atoms": "0",
    "after_usd_atoms": "500000000",
    "sources": {
      "adjustment_atoms": "0",
      "grant_atoms": "500000000",
      "initialized": false,
      "purchased_atoms": "0",
      "review_required": true,
      "unattributed_atoms": "0",
      "version": "1"
    },
    "client_verified": "registration credited: 500.00 new credits; USD balance 5.00000000; no claim action"
  }
]
```


## TB04 开发与验收记录

实施日期：2026-10-20，沿用三个项目和子模块的 `codex/credit-v2-tracer-20261020`。完整 [消费合同](../credit-consumption-contract.md) 定义原生扣费、来源恢复、净消费与旧精度边界。本轮复用原生实际扣费及 159/160 来源事务，新增 Admin 边界校验、查询追溯和 161 UUID 唯一索引；WANX 客户端统一面值与消费呈现仍由 TB05 交付。

| Tracer bullet | 开发结果 | 验证结果 |
| --- | --- | --- |
| TB04.1 赠送+购买 → 原生 Key 实际扣费 → 来源事件 → 管理查询 | 赠送优先；Admin 校验来源优先级及连续快照，查询追加 sources_before；不二次扣款 | PostgreSQL：赠送 100、购买 1000 新积分，消费 150 后赠送 0、购买 950。实际定价 HTTP 链路：赠送余 2 USD、购买 10 USD，消费 3 USD 后购买余 9 USD；原生其他 Key 无伪造设备；分页和账号隔离通过 |
| TB04.2 并发/重放/提交失败 → 原请求恢复 → 单份账本 | 原余额行锁和请求去重负责原子分摊；Admin 断线后按原事件追平 | 两个并发 0.75 USD 分别使用赠送 0.75、赠送 0.25+购买 0.5；重复结算不再扣费；deferred trigger 强制 COMMIT 失败后金额/来源/序号/去重回滚，同请求恢复成功；跨服务远端已扣、本地离线后同步两次无重复 |
| TB04.3 原消费 → 完整撤销 → 原来源及净消费 → 唯一身份 | 完整金额和原来源校验；本地 correction 汇总抵消原消费投影；161 按 UUID 身份去重 | 部分/错误来源/重复撤销拒绝；大写花括号同义 UUID 换 source 仍拒绝；URN 拒绝；1 USD atom 穿插调整的全额撤销净消费为零；旧账本缺可选事件表仍可查；历史重复使 161 事务失败且旧索引/金额/序号保留 |
| TB04.4 在途欠额 → 充值 → 总余额准入 | 延续原生真实欠额、既有 balance > 0 guard；充值不改历史欠额 | 从 12 USD 消费 15 USD 得 -3；充值 1 得 -2、再充 2 得 0，均 403；再充 1 得 +1 后请求成功，实际扣 5100 atoms，最终 99994900 USD atoms；四来源之和相等 |

T14/T15 的来源分摊、并发、幂等与回滚已通过；T16 包含原生其他 Key、关联完整撤销、未关联调整和 pre159 原消费（后二者沿用 TB02 回归）；T17 验证托管模型入口欠额和零余额拦截、充值恢复。T19 确认赠送及冲正不生成充值，实际只有四笔已验证测试订单的充值事件，均按冻结 USD 入账，不把赠送套人民币价格。原生 UI 未新增撤销选择器；测试专用消费/撤销入口只编译到 `_test.go`。

TDD 已先观察并修复：购买优先但金额守恒的伪来源页原先被接受；错误来源撤销原先被接受；原文本 UUID 索引可重复撤销；关联撤销未进入净消费；旧精度穿插调整产生 1 atom 净消费残留；URN 校验与查重范围不一致。规范复审发现可选 QeeToken 表依赖回归，已按持久计费后端门控并补真实缺表测试。Standards、Spec 与 Go 审查发现均已修复；最终复审无未解决项。

### 验证结果

| 检查 | 结果 |
| --- | --- |
| WANX `make all` | 4841 passed、17 skipped；格式、Ruff、mypy 通过；本次未改客户端代码 |
| Admin 下列相关回归 | 107 passed、6 skipped；6 个 live 参数用例由 Go fixture 单独实际执行通过 |
| Admin 本次 6 个文件 Ruff / format check | 通过 |
| Admin 本次 4 个服务/DTO mypy（follow-imports=silent） | 通过；不代表整个既有依赖图全绿 |
| QeeToken `go test ./...` + 隔离 PostgreSQL | 通过，含 161 历史冲突回滚测试 |
| `TestWanxCrossServiceBilling` | 通过：旧支付消费、TB01、TB02、TB03 两种注册、TB04、完整 Consumer journey 均实际执行 |
| QeeToken 差异 golangci-lint（Go 1.26.4 / v2.9.0） | 0 issues |
| QeeToken 全量 golangci-lint | 仍有 22 项既有问题：depguard 1、errcheck 15、staticcheck 6；不宣称全量 lint 通过 |
| 四个 Git checkout `git diff --check` | 通过；未提交、推送或改变分支 |

可复现 Admin 命令（admin-backend，先设置带 disposable 标签的一次性 MySQL 容器）：

```sh
CREDITS_TEST_CONTAINER=wanx-tb04-mysql uv run --python .venv/bin/python pytest \
  tests/module_nexus/test_qeetoken_consumption_sources.py \
  tests/module_nexus/test_credit_queries.py \
  tests/module_nexus/test_registration_grants.py \
  tests/module_nexus/test_qeetoken_sources.py \
  tests/module_nexus/test_credit_denomination.py \
  tests/module_nexus/test_credit_products.py \
  tests/module_nexus/test_credit_orders.py \
  tests/module_nexus/test_credit_payment_recovery.py \
  tests/module_nexus/test_qeetoken_accounting.py \
  tests/module_nexus/test_qeetoken_cutover.py \
  tests/module_nexus/test_qeetoken_compatibility.py \
  tests/module_nexus/test_qeetoken_admin.py -q --tb=short
```

跨服务沿用 TB01 环境变量（WANX_TEST_BRIDGE_ROOT 指向 WANX/wanx-bridge），执行 `go test ./internal/handler -run '^TestWanxCrossServiceBilling$' -v -count=1`。本次仅创建 `wanx-tb04-postgres` 和 `wanx-tb04-mysql`，无主机数据挂载；结束后移除本轮容器及匿名卷。支付回调和 provider usage 是测试输入，实际运行 Go HTTP/定价/记账/PostgreSQL、Admin/MySQL 和 Consumer/管理 HTTP 路由；未触及业务库或实际付款。

仍有发布门槛：QeeToken 全量 lint 基线问题、Admin 既有认证 F821/全依赖图类型问题、Windows 真机及整体切换演练。下一条 TB05 实施统一钱包/消费面值与客户端展示；不得把本次来源和消费验收当成统一 v2 上线。

最后一次跨服务运行证据（均为隔离测试身份；summary 的 as_of 使用测试时钟）：

```json
{
  "tracer": "TB04",
  "original_event_id": "a458e282-3041-4b12-aeaa-0e4492e000de",
  "reversal_event_id": "f06ee3bb-a054-471e-92d0-807357470a09",
  "consumption_source_delta": {
    "adjustment_atoms": "0",
    "grant_atoms": "-200000000",
    "purchased_atoms": "-100000000",
    "unattributed_atoms": "0"
  },
  "reversal_source_delta": {
    "grant_atoms": "200000000",
    "purchased_atoms": "100000000",
    "adjustment_atoms": "0",
    "unattributed_atoms": "0"
  },
  "summary_at_sequence_5": {
    "as_of": "2026-10-18T02:00:00.000000Z",
    "ledger_sequence": 5,
    "gross_consumed_credit_atoms": "6000000",
    "correction_credit_atoms": "3000000",
    "net_consumed_credit_atoms": "3000000",
    "pending_call_count": 0,
    "settled_call_count": 0
  },
  "final_balance_usd_atoms": "99994900",
  "final_sources": {
    "adjustment_atoms": "-300000000",
    "grant_atoms": "0",
    "initialized": false,
    "purchased_atoms": "399994900",
    "review_required": true,
    "unattributed_atoms": "0",
    "version": "1"
  },
  "final_sequence": "10",
  "negative_zero_blocked": true,
  "positive_admitted": true
}
```

## TB05 验证记录（2026-10-20）

状态：开发、测试及隔离验收完成。三个项目（含 QeeToken 子模块）继续使用 `codex/credit-v2-tracer-20261020`，保留 TB01–TB04 未提交改动。完整字段和部署规则见 [展示合同](../credit-display-contract.md)。

### 纵向任务

| Tracer bullet | 实现 → 验证 | 结果 |
| --- | --- | --- |
| TB05.1 已确认 USD → 本地展示基准 → 回执 | 真实 MySQL 中原子写入基准、余额和回执；不写远端金额，不改历史事件或账本序号 | 20 旧积分/20 USD 显示 2000 新积分；已有 5 USD 显示 500；正负尾差精确保留；回执插入失败回滚、四并发重复提交仅一份回执、跨账号/异内容操作冲突 |
| TB05.2 原 USD 消费 → 同一 v2 分页与累计 | 切换前后事件按原 USD 精确转换；完整快照作为钱包和消费页共同上界 | 历史原本地取整值不回写；新投影按账号规则继续；中断半页不提前显示，重启续页后刷新；旧 wallet 仍保留原单位、有效确认时间和序号 |
| TB05.3 Consumer HTTP → 主钱包/快捷面板 | 明确 wallet/v2、usage/v2；BigInt half-up 两位；微小金额按余额/消耗/欠费说明 | pending 不当零；stale/较旧响应不覆盖；seq=0 pending 使旧值 stale；跨账号页拒绝；刷新丢弃旧分页请求；无 USD/Token 展示 |
| TB05.4 原订单 → 原 USD 履约 → 当前积分显示 | 真实 Go HTTP/PostgreSQL → Admin/MySQL → Consumer HTTP → 生产 renderer | 原已支付订单重复履约只增加一次 10 USD；新旧消费各显示 0.03，累计 0.06；最终余额显示 1499.94；原单显示 1000.00 |
| TB05.5 管理与兼容出口 | 管理事件明确原/当前面值，reconcile 采用持久因子；旧合同不混单位 | 旧 balance/wallet/usage 保持 v1；已切换账号的旧 summary/entries 拒绝，含旧管理跨账号混合页；原意图可恢复，新购买在 TB06 前停用 |

T06 的已有余额与旧 20 积分样本已实际通过本地基准提交验证；新充值 10 元的 v2 商品仍属 TB06。T07/T08 覆盖负值、尾差、历史混合页、序号延续与断点恢复，完整旧资产迁移属于 TB07。T27–T30 的积分展示、精度、微小数、状态及账号隔离通过；Windows 真机和生产整体切换仍属于后续验收。

先失败后修复的证据包括：半页提前显示未确认余额、管理旧流水混单位、并发独立快照被误判错误、seq=0 pending 被序号比较挡住，以及清除同步时间导致旧钱包 500。最终补齐确认快照、顺序读取、旧接口单位和空值合同。Standards 审查及 Spec 审查最终均无未关闭发现。

### 验证命令与结果

| 检查 | 结果 |
| --- | --- |
| WANX `make all` | 4841 passed、17 skipped；格式、Ruff、mypy 通过 |
| `npm run build:renderer --prefix wanx-client` | 通过，工作区中的 bundle 由源码生成 |
| `npm test --prefix wanx-client` | 1456 passed、19 skipped、0 failed |
| `WANX_TEST_ELECTRON=1 node --test wanx-client/tests/credit-wallet-electron.test.mjs` | 1 passed、0 skipped；真实 macOS Electron，钱包两种宽度、消费滚动表、时区与支付恢复通过 |
| Admin 下列相关回归 | 116 passed、7 skipped；7 个 live 参数用例由 Go fixture 另行实际执行 |
| Admin 最终断页/查询/兼容聚焦回归 | 31 passed、2 skipped；随后完整相关回归包含新增 20 USD/5 USD 两个样本 |
| Admin 本次 13 个 Python 文件 Ruff / format check | 通过；未整文件格式化旧认证代码 |
| Admin 5 个服务/DTO mypy（`--follow-imports=silent --ignore-missing-imports`） | 通过；未忽略缺失 stubs 时 ruamel 报 4 个 import-untyped；不代表既有全依赖图类型检查全绿 |
| Admin 前端 `npm test` / `npm run build:prod` | 428 passed、1 skipped、0 failed；生产构建通过 |
| QeeToken `go test ./...`（含隔离 PostgreSQL） | 通过 |
| `TestWanxCrossServiceBilling` | 通过：原支付消费、TB01–TB05、两种注册和完整 Consumer journey 均实际执行 |
| Go 1.26.4 / golangci-lint v2.9.0 差异检查 | `--new-from-rev=HEAD`：0 issues |
| QeeToken 全量 golangci-lint | 仍为 22 项既有问题：depguard 1、errcheck 15、staticcheck 6 |
| 四个 checkout `git diff --check` | 通过；未提交或推送 |

Admin（`admin-backend`）：

```sh
CREDITS_TEST_CONTAINER=wanx-tb05-mysql uv run --python .venv/bin/python pytest \
  tests/module_nexus/test_qeetoken_display.py \
  tests/module_nexus/test_qeetoken_consumption_sources.py \
  tests/module_nexus/test_credit_queries.py \
  tests/module_nexus/test_registration_grants.py \
  tests/module_nexus/test_qeetoken_sources.py \
  tests/module_nexus/test_credit_denomination.py \
  tests/module_nexus/test_credit_products.py \
  tests/module_nexus/test_credit_orders.py \
  tests/module_nexus/test_credit_payment_recovery.py \
  tests/module_nexus/test_qeetoken_accounting.py \
  tests/module_nexus/test_qeetoken_cutover.py \
  tests/module_nexus/test_qeetoken_compatibility.py \
  tests/module_nexus/test_qeetoken_admin.py -q --tb=short
```

跨服务在 `nexusaos-qeetoken/sub2api/backend` 执行，沿用 TB01 的环境变量：`WANX_TEST_ADMIN_ROOT` 指向 Admin backend，`WANX_TEST_BRIDGE_ROOT` 指向 WANX/wanx-bridge，`WANX_TEST_POSTGRES_DSN` 指向本次隔离 PostgreSQL，`CREDITS_TEST_CONTAINER=wanx-tb05-mysql`。命令为 `GOTOOLCHAIN=go1.26.4 go test ./internal/handler -run '^TestWanxCrossServiceBilling$' -v -count=1`。

### 实际跨服务证据

```json
{
  "operation_id": "live-display",
  "old_currency_rule_id": "usd-credit-1-v1",
  "currency_rule_id": "usd-credit-100-v2",
  "old_credit_atoms": "4999700",
  "baseline_credit_atoms": "499970000",
  "baseline_usd_atoms": "499970000",
  "baseline_remote_sequence": "2",
  "final_remote_sequence": "4",
  "final_usd_atoms": "1499939700",
  "wallet_balance_credit_atoms": "1499939700",
  "gross_consumed_credit_atoms": "60300",
  "correction_credit_atoms": "0",
  "net_consumed_credit_atoms": "60300",
  "renderer": "余额 1499.94；新旧消费各 0.03；累计 0.06；原订单 1000.00；无 USD/Token"
}
```

该场景先真实赠送 5 USD，原生消费 100 tokens（30000 USD atoms），建立展示基准；再恢复原已支付的 10 USD 订单，原生消费 101 tokens（30300 USD atoms）。切换前后远端事件不变，只有原订单履约与实际消费增加事件；所有金额均为测试输入和隔离库事实，不是实际付款或付费模型调用。

只使用本轮 `wanx-tb05-postgres`、`wanx-tb05-mysql` 两个 disposable 容器，无主机数据挂载；验收后移除容器和匿名卷。截图留在本机 `/tmp/wanx-tb05-screens`，宽/窄钱包均已检查；测试夹具的品牌图片未加载，不作为新产品改动。

发布门槛仍包括 QeeToken 全量 lint 基线、Admin 既有认证 F821/全依赖图类型问题、Windows 真机及整体切换演练。Admin 必须先执行新增展示 SQL；已提交基准只能向前恢复，不能删除基准或回退到不识别它的旧代码。TB06 将实施新商品、自定义充值和最低客户端能力门控；本记录不授权生产迁移或上线。

## TB06 验证记录（2026-10-20）

状态：开发、测试、代码审查和隔离验收完成。三个项目及 QeeToken 子模块继续使用 `codex/credit-v2-tracer-20261020`，保留 TB01–TB05 工作区改动，未提交或推送。完整接口、发布与兼容规则见 [充值合同](../credit-recharge-contract.md)。

### 纵向任务

| Tracer bullet | 实现 → 验证 | 结果 |
| --- | --- | --- |
| TB06.1 发布规则 → 五档目录 → 服务端报价 | 独立管理权限、审计/版本/幂等发布；始终停用，旧已发布规则保留；旧 initial 不能覆盖 v2 草稿；固定金额与积分不可改 | T01/T02：五档准确；10/11/1000 元合法；9/1001/10.50 元、混合字段和客户端伪造积分拒绝 |
| TB06.2 商品/自定义 → 冻结订单 → 支付核验 → 唯一到账 | 真实 Consumer HTTP/MySQL → QeeToken HTTP/PostgreSQL → Admin 投影；五档加三个自定义样本各充值一次 | T01/T02/T04：共 8 笔，金额和积分逐笔一致，无加赠 |
| TB06.3 响应丢失 → 原任务恢复 → 当前积分 | 首笔远端已成功但响应丢失，付款后下架商品，再用新服务实例恢复两次；所有订单重放原意图 | T03/T04：原冻结金额不变，事件只有 8 笔充值；客户端最终余额 188600.00 |
| TB06.4 版本/并发/账号隔离 → 安全重试 | 同意图四路并发、旧商品版本、改变原意图渠道、他人订单/报价、新旧 catalog 严格 DTO | T03：同意图仅一单，错误版本/冲突参数拒绝，跨账号读取 404 |
| TB06.5 旧能力新请求 → 拒绝；既有旧意图 → 恢复 | 原单查找在新门控前；旧 DTO 缺省新增字段不进入旧哈希；未建单旧意图被明确拒绝后释放，未知结果继续保留 | T31：不暗中创建旧规则新单，TB01/TB05 原单兼容跨服务再次通过 |
| TB06.6 原生新购买门控 → 旧责任保留 | 实际持久映射查询；配置/套餐/渠道/checkout/limits/下单/用户兑换七个 HTTP handler 拒绝托管账号；普通账号配置仍 enabled；托管旧支付核验完成入账 | T20/T21：新购买 403，非 WANX 门控放行；旧履约只到账一次，没有新增退款/补偿入口 |
| TB06.7 真 UI → 自定义报价 → 持久购买 | Electron 实际点击、输入、再次点击、轮询、Tab/ShiftTab、报价、确认、二维码及锁定输入；宽/窄截图检查 | 自定义 11 元显示 1100.00 积分；窄屏两列金额不溢出；不显示 USD/Token；断网重启重发完全相同意图 |

### 开发与审查证据

测试先复现缺失的发布接口、自定义报价路径、原生购买门控及用户兑换门控，再实现通过。双轴审查发现输入点击误触发和旧未建单意图反复重试，均已补回归修复；另补 v2 草稿防重置、并发同意图与旧规则保留。静态类型检查发现新旧目录固定比例的继承冲突，改为公共字段加两个独立版本，并增加交叉比例拒绝测试。

- Standards：复审及最后 UI/文档复核通过，0 未解决发现。
- Spec：复审及最后 DTO/合同复核通过，0 未解决发现；最初提出的旧哈希疑问经 serializer 与纯函数核验撤回。
- Go：生产门控和最终 handler/旧支付责任测试复核通过，0 未解决发现。

### 实际校验

| 检查 | 结果 |
| --- | --- |
| WANX `make all`（format-all/lint/typecheck/test） | 4841 passed、17 skipped；格式、Ruff、mypy 通过 |
| WANX `npm test --prefix wanx-client` | 1459 passed、19 skipped；可选 Electron/设备类用例默认跳过 |
| `npm run build:renderer --prefix wanx-client` | 通过，已更新 wallet.bundle.js |
| Electron 显式运行 `credit-wallet-electron.test.mjs` | 1 passed、0 skipped；含新五档/自定义真实 DOM 流程 |
| Admin 充值、配置、HTTP、旧单恢复、赠送、来源、展示及兼容回归 | **146 passed、8 skipped**；live 用例另由 Go fixture 提供服务地址运行 |
| 真实 `TestWanxCrossServiceBilling` | PASS；含既有生命周期/账务/来源/赠送/消费/展示及本次 8 笔新充值，约 20 秒 |
| Admin UI `npm test` / `npm run build:prod` | 429 passed、1 个可选 Electron 用例 skipped；生产构建通过 |
| Admin 本轮 10 个 Python 文件 Ruff | 通过；7 个生产文件限定导入图 mypy 通过 |
| Admin controller 附加类型检查 | `list_entries` 动态 Pydantic model 的既有 ModelMetaclass 错误仍在；与 TB06 前快照相同，未计为本轮已解决 |
| QeeToken `go test ./...`，配置隔离 PostgreSQL | 通过；带 `-tags unit` 的 service/handler/routes 三包另行通过 |
| QeeToken golangci-lint 全量 / 相对 TB06 前快照差异 | 全量仍 22 项既有问题（depguard 1、errcheck 15、staticcheck 6）；本轮差异 **0 issues** |
| 四个 checkout `git diff --check` | 通过 |

Admin 回归命令在 `nexusaos-admin/admin-backend` 执行：

```sh
CREDITS_TEST_CONTAINER=wanx-tb06-mysql uv run --python .venv/bin/python pytest \
  tests/module_nexus/test_credit_recharge_v2.py \
  tests/module_nexus/test_qeetoken_display.py \
  tests/module_nexus/test_qeetoken_consumption_sources.py \
  tests/module_nexus/test_credit_queries.py \
  tests/module_nexus/test_registration_grants.py \
  tests/module_nexus/test_qeetoken_sources.py \
  tests/module_nexus/test_credit_denomination.py \
  tests/module_nexus/test_credit_products.py \
  tests/module_nexus/test_credit_orders.py \
  tests/module_nexus/test_credit_payment_recovery.py \
  tests/module_nexus/test_qeetoken_accounting.py \
  tests/module_nexus/test_qeetoken_cutover.py \
  tests/module_nexus/test_qeetoken_compatibility.py \
  tests/module_nexus/test_qeetoken_admin.py \
  tests/module_nexus/test_credit_configuration.py \
  tests/module_nexus/test_credit_http.py -q --tb=short
```

QeeToken 在 `sub2api/backend` 使用 `GOTOOLCHAIN=go1.26.4`。跨服务命令 `go test ./internal/handler -run '^TestWanxCrossServiceBilling$' -v -count=1`，环境 `WANX_TEST_ADMIN_ROOT` 指向 Admin backend，`WANX_TEST_BRIDGE_ROOT` 指向 WANX/wanx-bridge，`WANX_TEST_POSTGRES_DSN` 指向本轮 disposable 的 localhost/lifecycle_test，`CREDITS_TEST_CONTAINER=wanx-tb06-mysql`。原生测试为 `go test -tags unit ./internal/service ./internal/handler ./internal/server/routes`；七入口用例是 HTTP handler 级测试，使用已认证 subject，未声称覆盖原生 router/JWT 全链路。

### 跨服务实际结果

```json
{
  "amounts_fen": [1000, 5000, 10000, 20000, 50000, 1000, 1100, 100000],
  "grants": ["1000000000", "5000000000", "10000000000", "20000000000", "50000000000", "1000000000", "1100000000", "100000000000"],
  "final_usd_atoms": "188600000000",
  "sequence": "9",
  "recharges": 8,
  "lost_response_recovered": true,
  "client_verified": "five tiers; server quote 11 yuan = 1100.00 credits; completed order recovered; final 188600.00; no USD/token"
}
```

场景先实际登记注册资格并入账 5 USD（500 积分），建立 v2 展示基准，然后执行 8 单共 1881 元、188100 积分；最终 188600 积分与远端 1886 USD 对齐。支付核验事实来自隔离支付端口，模型上游不调用；数据库、Admin、QeeToken HTTP、投影以及读取实际响应的生产 renderer 均真实运行。不能将该结果描述为真实支付宝/微信收款。

宽/窄截图位于本机 `/tmp/wanx-tb06-screens/recharge-v2.png`、`recharge-v2-narrow.png`、`recharge-v2-narrow-quote.png`，已目视检查。测试只使用标记为 disposable、无主机挂载的 `wanx-tb06-mysql` 与 `wanx-tb06-postgres`；验收后删除两个容器及匿名卷。

本条无新增 SQL，管理发布命令仅在隔离测试库运行；没有启用生产规则、充值、赠送或迁移。旧安装包升级体验、Windows 真机、真实渠道支付、完整切换与发布基线清理仍留在 TB09/TB10；现有全量 Go lint、Admin 认证 F821/全依赖类型基线未宣称全绿。下一条 TB07 负责旧资产盘点、证据核对和迁移恢复。

## TB07 验证记录（2026-10-20）

状态：**开发、测试和本地隔离验收完成**。合同：[credit-migration-contract.md](../credit-migration-contract.md)。继续使用四个 checkout 的 `codex/credit-v2-tracer-20261020` 分支；未提交、推送、连接生产库或迁移实际用户资产。没有改 WANX 客户端源码或生成 bundle；继续使用 TB05 的 v2 钱包接口。

### 纵向任务及结果

| Bullet | 输入 → 持久事实 → 恢复／输出 | 对应验收与证据 |
| --- | --- | --- |
| TB07.1 盘点 → 登记历史 → 只读预演 | 本地余额、已到账／待履约订单、历史领取认定、远端快照 → 分类和 blocker 清单 → preview_hash | T22/T26：未核实领取、未知支付、在途／异常拒绝；preview 不开户／入账；shadow/RMB/非剩余资产 DTO 拒绝 |
| TB07.2 证据 → 唯一资产 → 单笔期初 | 15 旧积分购买剩余 + 5 旧积分早期赠送 → 冻结 batch/actor/reason/asset manifest → 单笔 20 USD → 2000 新积分 | T06/T22/T24：购买 1500000000 + 赠送 500000000 USD atoms，总额 2000000000；序号 1，没有额外补贴或注册赠送 |
| TB07.3 原订单 → 剩余资产及独立责任 | 历史 paid+credited 订单仅剩 15 旧积分 → 纳入期初；paid pending 订单暂停 → completed 后履约原 USD | T26/T32：已到账订单再 fulfill 不入账；未到账旧单只追加一笔原冻结 1000 USD，重试不重复，最终序号 2 |
| TB07.4 原资产身份 → 并发／失败 → 重放 | MySQL 与 PostgreSQL 各自唯一 asset_id；账号锁和固定 migration:<account> → 事务回滚／原操作恢复 | T23/T24：跨账号、跨批次引用拒绝；并发仅一账号占用；receipt 写失败时金额、来源、序号、claim 全回滚；修改同 source 的来源分量冲突 |
| TB07.5 已有 USD → 证据重分类 → 仅切展示 | 来源初始化仍未知 → 新证据 source_reclassification 零金额事件 → TB05 本地基准 | T06/T07：5 USD 显示 500 积分；500000003 与 -99999997 USD atoms 原样保留；旧事件完全相同，只追加两笔零金额来源事件 |
| TB07.6 断点 → 原 job 恢复 → 同序号展示 | 远端已成功响应丢失；保存 display_pending 后新消费；投影证据不匹配 → 持久原计划和原回执 | T32：两次 attempt 完成；失效但未提交的预演在 Consumer 锁内刷新，与展示／完成结果同事务提交；错误证据不推进投影；既有回执不重写 |
| TB07.7 管理任务 → 查询／恢复 → 审计 | 严格 HTTP/权限、batch_id、来源事件筛选及任务状态 → retry 引用原 job | 管理 Electron 实际渲染旧资产迁移批次并点击恢复，提交 action=retry、resource_id=原任务；原订单恢复继续通过 |
| TB07.8 旧版持久状态 → 升级 → 原回执 | 161 schema 下创建旧无证据期初 → 应用 162 → 原 operation/source 重放 | 不变更旧请求哈希、事件和金额；新证据不能覆盖旧期初；已有余额或已有序号不能另做期初 |

已支付订单测试使用隔离 fixture 的核验支付事实。旧余额、历史消费和来源凭证是明确构造的代表性数据，并未声称完成生产存量证据核查。RMB/shadow 的拒绝在请求边界验证，迁移代码不读写人民币钱包。

### TDD 与独立审查

按既定接缝完成红绿循环：真实 PostgreSQL 期初来源断言从 0 → 正确分量；未实现 reclassify_sources 从拒绝 → 独立零金额事件；Admin 盘点／任务缺失从失败 → 可执行；保存展示命令后的新消费从永久 CALL_STATE_CONFLICT → 恢复到 1900000000 atoms；错误 evidence_id 原先未拒绝 → 投影回滚。未以只返回 HTTP 200 替代金额、事件、序号和去重断言。

Standards 与 Spec 分别审查 TB07 前快照的增量，均发现并复核关闭展示预演过期导致永久卡住的问题；最终均 0 未解决发现。Go 审查通过；按反馈补成真实 161→162 持久回执升级测试，而不是只在新 schema 上模拟旧请求。静态审查不计作真实数据库执行证据。

### 实际检查

| 检查 | 结果 |
| --- | --- |
| WANX `make all` | **4841 passed、17 skipped**；格式、Ruff、mypy 通过 |
| WANX `npm test --prefix wanx-client` | 1459 passed、19 skipped；可选环境跳过未计入本条验收 |
| Admin 新迁移 + 既有充值／订单／来源／赠送／消费／展示／HTTP 回归 | **158 passed、12 skipped**；12 个 live 参数场景由后续真实跨服务 fixture 单独实际执行 |
| `TestWanxCrossServiceBilling`（最终代码） | **PASS**；TB07 新增 4 个真实 HTTP/PostgreSQL/MySQL 场景全部执行，无 skip；TB01–TB06 和原 Consumer journey 一并通过 |
| QeeToken 真实 PostgreSQL 迁移事务与升级定向测试 | PASS；5 个顶层用例，另含余额／序号前置条件的 3 个子用例 |
| QeeToken `go test ./...`（隔离 PostgreSQL） | PASS；另行 `go test -tags unit ./internal/service ./internal/handler ./internal/server/routes` PASS |
| Admin 14 个本次 Python 文件 Ruff / format check | 通过 |
| Admin 9 个生产服务／DTO 的限定导入图 mypy | 通过；`--follow-imports=silent --ignore-missing-imports` |
| Admin 映射模型 mypy 单独核查 | 仍有 3 个既有 DeclarativeBase/ClassVar 错误；TB07 前快照同样在 15/25/43 行复现，新增模型不增加错误 |
| Admin UI `npm test` / `npm run build:prod` | 429 passed、1 个可选 Electron 默认 skipped；生产构建通过 |
| 显式启用 `qeetokenUi.test.mjs` Electron | **1 passed、0 skipped**；迁移批次、原任务重试、旧付款恢复及宽窄布局 |
| QeeToken 全量 golangci-lint / TB07 差异检查 | 全量既有 22 项（depguard 1、errcheck 15、staticcheck 6）；本次修复新增测试断言检查后，TB07 差异 **0 issues** |
| HTTP/OpenAPI | 实际 ASGI 权限拒绝、额外参数拒绝、Idempotency-Key、预演/提交/任务查询通过；新路由具有 summary 与明确 DTO |
| 四个 checkout `git diff --check` | 通过 |

Admin 回归命令（目录 `nexusaos-admin/admin-backend`）：

```sh
CREDITS_TEST_CONTAINER=wanx-tb07-mysql uv run --python .venv/bin/python pytest \
  tests/module_nexus/test_qeetoken_migration.py \
  tests/module_nexus/test_credit_recharge_v2.py \
  tests/module_nexus/test_qeetoken_display.py \
  tests/module_nexus/test_qeetoken_consumption_sources.py \
  tests/module_nexus/test_credit_queries.py \
  tests/module_nexus/test_registration_grants.py \
  tests/module_nexus/test_qeetoken_sources.py \
  tests/module_nexus/test_credit_denomination.py \
  tests/module_nexus/test_credit_products.py \
  tests/module_nexus/test_credit_orders.py \
  tests/module_nexus/test_credit_payment_recovery.py \
  tests/module_nexus/test_qeetoken_accounting.py \
  tests/module_nexus/test_qeetoken_cutover.py \
  tests/module_nexus/test_qeetoken_compatibility.py \
  tests/module_nexus/test_qeetoken_admin.py \
  tests/module_nexus/test_credit_configuration.py \
  tests/module_nexus/test_credit_http.py -q --tb=short
```

QeeToken 目录 `nexusaos-qeetoken/sub2api/backend`，`GOTOOLCHAIN=go1.26.4`。跨服务运行 `go test ./internal/handler -run '^TestWanxCrossServiceBilling$' -v -count=1`；配置 `WANX_TEST_ADMIN_ROOT`、`WANX_TEST_BRIDGE_ROOT`、`CREDITS_TEST_CONTAINER=wanx-tb07-mysql` 和本轮 disposable localhost/lifecycle_test 的 `WANX_TEST_POSTGRES_DSN`。Go fixture 创建独立 schema，并顺序运行 Admin 测试，避免多个进程重建同一 MySQL fixture。

定向升级／事务：`go test ./internal/wanx -run 'Test(ReviewedOpening|Reclassification|LegacyMigration)' -count=1 -v`。管理 UI 真正启用 Electron：设置 `QEETOKEN_TEST_ELECTRON` 为本机 Electron 可执行文件路径，再运行 `node --test tests/qeetokenUi.test.mjs`。没有 Windows 真机结果。

本轮新建的 `wanx-tb07-mysql`、`wanx-tb07-postgres` 均带 disposable 标签，无主机目录绑定；完成测试后已移除容器及其一次性卷。未触及已有业务数据库。

### 最终联调事实

```json
{
  "tracer": "TB07-old-assets",
  "job_id": "65061536-3ffc-4e6c-9046-77f878e358e0",
  "attempts": 2,
  "opening_event_id": "8397c532-29f6-42d0-9129-60b552d391dc",
  "opening_usd_atoms": "2000000000",
  "purchased_usd_atoms": "1500000000",
  "grant_usd_atoms": "500000000",
  "opening_sequence": "1",
  "display_credit_atoms": "2000000000",
  "paid_pending_order": "5c9ce91c-37a5-46fc-8ab9-45195bf2ac8f",
  "after_original_order_usd_atoms": "102000000000",
  "final_sequence": "2"
}
```

| 已有余额场景 | 原／最终 USD atoms | 最终 credit atoms | 重分类 event_id | 最终序号 |
| --- | --- | --- | --- | --- |
| 5 USD | 500000000 / 500000000 | 500000000 | 0ab64603-b826-4f16-b345-108911033ceb | 3 |
| 正尾差 | 500000003 / 500000003 | 500000003 | d4578dd4-04bf-4a7f-8553-e58ed6b57d7e | 3 |
| 真实原生消费后的欠额 | -99999997 / -99999997 | -99999997 | a0e2a2ee-930c-44db-866b-8e213d10e01c | 4 |

三例均先来源初始化再按新证据重分类；零金额事件不改原事件，不增加充值或消费统计。欠额仍记 adjustment=-99999997，核实来源不免欠。

### 发布与剩余范围

新增 Admin SQL `20261020_qeetoken_migration.sql`、QeeToken 追加 `162_wanx_reviewed_migration.sql`；不改 159–161。兼容服务、显式 schema、受控窗口及逐账号执行顺序详见合同。Admin 启动只检查表，不自动执行迁移；批次是审计维度，唯一财务身份来自原账号和原资产。

原有全量发布门槛仍包括 QeeToken lint 基线、Admin 既有认证 F821／完整依赖图类型问题、Windows 真机、真实支付和整体切换演练。本轮进一步明确记录模型文件的既有 3 项类型错误，不宣称这些基线已解决。TB08 负责历史未领账号批量注册补发；TB09/TB10 负责关单竞争和完整窗口演练。本条不授权生产迁移、上线或新增补偿。

## TB08 验证记录（2026-10-20）

状态：**开发、测试和本地隔离验收完成**。合同：[credit-registration-batch-contract.md](../credit-registration-batch-contract.md)。四个 checkout 继续使用 `codex/credit-v2-tracer-20261020`，保留 TB01–TB07 工作；未提交、推送或连接生产库。

### 纵向任务与结果

| Bullet | 输入 → 持久事实 → 恢复／输出 | 验收证据 |
| --- | --- | --- |
| TB08.1 显式范围 → 资格核对 → 只读预演 | 1～100 个排序去重账号；原注册领取证据、迁移/订单/来源/同步门控 → 每账号 decision 和 preview_hash | T12：已领取、未知、未迁移、新账号均分别排除；其他历史赠送 5 USD 不被当作注册已领 |
| TB08.2 审批 → 唯一授权 → 原资格排队 | Consumer 顺序锁内重新核对 → 同事务保存 Batch/Release 与原 Grant queued | T10/T13：三次并发同提交返回同回执，修改原因拒绝；新批次不能重复释放，原批次重放不扩大范围 |
| TB08.3 未登录旧账号 → 原执行器 → 唯一赠送 | history_unclaimed 原 eligibility_id 与新账号任务并发 → 固定 5 USD/500 新积分 → 原事件投影 | T10/T12/T13：旧账号未登录、无 AppClient；未领取者仅新增一笔注册赠送；历史已领/未知者不发；不记充值收入 |
| TB08.4 丢响应／人工核对 → 原任务恢复 → 逐账号结果 | 原资格排队，远端成功丢回复或事件冲突 → retry_wait/review_required；过期 running 租约及管理 job 竞争恢复 | T11/T32：重建执行器、重复批准、并发 deliver 仍是原事件；补发后余额 25 USD、序号 2 |
| TB08.5 批次查询 → 管理恢复 → 审计 | 原范围、管理员、原因、历史凭证、资格、尝试、错误、下次时间及事件 → 恢复原资格 | Electron 真实点击批次查询和“恢复原赠送”，请求指向 original-eligibility；原迁移任务/付款恢复继续通过；权限与严格 HTTP 参数检查通过 |
| TB08.6 实际钱包 → WANX 校验 → 用户展示 | history_unclaimed 保留资格来源，批准状态附固定 500 新积分 → 实际 v2 响应进入生产 renderer | 显示余额 2500.00、注册赠送已到账 500.00，无 USD/token/领取入口；未批准 waiting_migration 不承诺赠送 |
| TB08.7 审批后状态变化 → 再次门控 | 审批后迁移阶段回到 display_pending → 原发放再次校验 | 拒绝发放、无新增事件，原资格保留；批次审批不能绕过发放前检查 |

### 红绿循环与独立审查

预演模块缺失、submit 缺失、历史资格执行后仍 queued、HTTP 路由 404、WANX 拒绝已批准 history_unclaimed 状态，分别经过失败断言后实现并通过。测试核对固定金额、来源、原资格、原事件和序号，不只验证 200 响应。

真实联调夹具最初复用了 TB07 的 migration:alice，远端正确拒绝幂等冲突；为 TB08 两种故障场景分配独立账号与资产标识后通过。全量回归发现即时 tick 可能早于 MySQL DATETIME 四舍五入后的到期时刻，测试改为明确推进至到期周期；未为通过测试修改生产调度。

Standards 与 Spec 分别基于 `/tmp/wanx-tb08-before` 的本轮增量完成核心与最终审查，均 **0 个未解决发现**；Go 增量审查与 `go vet ./...` 通过。静态审查不替代数据库执行。新增审计 SQL、执行授权、错误恢复、客户端状态及管理 UI 均纳入审查。

### 实际检查

| 检查 | 结果 |
| --- | --- |
| WANX `make all` | **4841 passed、17 skipped**；格式、Ruff、mypy 通过 |
| WANX `npm test --prefix wanx-client` | **1460 passed、19 skipped**；新增历史状态测试通过 |
| WANX `npm run build:renderer --prefix wanx-client` | 通过，已更新源码对应 `wallet.bundle.js` |
| WANX `WANX_TEST_ELECTRON=1 node --test wanx-client/tests/credit-wallet-electron.test.mjs` | **1 passed、0 skipped** |
| Admin 批次 + TB01–TB07 积分回归 | **174 passed、14 skipped**；14 个 live 参数场景由真实跨服务 fixture 实际执行 |
| `TestWanxCrossServiceBilling` | **PASS**；TB08 两个新故障参数无 skip，TB01–TB07 与原 Consumer journey 一并通过 |
| Admin 本次 11 个 Python 文件 Ruff / format check | 通过 |
| Admin 6 个服务／DTO 限定导入图 mypy | 通过，`--follow-imports=silent --ignore-missing-imports`；不是完整仓库类型通过声明 |
| Admin UI `npm test` / `npm run build:prod` | **429 passed、1 个可选 Electron 默认 skipped**；生产构建通过 |
| Admin 显式 Electron `qeetokenUi.test.mjs` | **1 passed、0 skipped**；批次状态、原资格恢复、旧任务恢复、订单恢复及宽窄布局 |
| QeeToken `go test ./...`，隔离 PostgreSQL | PASS |
| QeeToken `go test -tags unit ./internal/service ./internal/handler ./internal/server/routes` | PASS |
| QeeToken 全量 golangci-lint / TB08 差异 | 仍为既有 **22 项**（depguard 1、errcheck 15、staticcheck 6）；TB08 差异 **0 issues** |
| HTTP/OpenAPI | ASGI 403、额外字段/查询参数/缺少幂等头 422，预演、202 回执重放、逐账号报告通过；docs 可访问且路由有 summary/DTO |
| 四个 checkout `git diff --check` | 通过 |

Admin 回归为 TB07 所列 17 个文件再加 `tests/module_nexus/test_registration_batches.py`，使用 `CREDITS_TEST_CONTAINER=wanx-tb08-mysql uv run --python .venv/bin/python pytest ... -q --tb=short`。新增文件包含 **16 个本地场景和 2 个 live 参数场景**。

跨服务命令在 `nexusaos-qeetoken/sub2api/backend` 执行：

```sh
GOTOOLCHAIN=go1.26.4 \
CREDITS_TEST_CONTAINER=wanx-tb08-mysql \
WANX_TEST_ADMIN_ROOT=/Users/lynn/Documents/centaurai/projects/nexusaos-admin/admin-backend \
WANX_TEST_BRIDGE_ROOT=/Users/lynn/Documents/centaurai/projects/centaur-WANX/wanx-bridge \
WANX_TEST_POSTGRES_DSN='postgres://postgres@127.0.0.1:58710/lifecycle_test?sslmode=disable' \
go test ./internal/handler -run '^TestWanxCrossServiceBilling$' -count=1 -v
```

DSN 仅对应本次临时容器，不是部署配置。Go 为本次运行建立独立 schema，依次执行各 Admin pytest 子进程以避免 MySQL 夹具并发重建。临时日志 `/tmp/tb08-cross.log`、`/tmp/tb08-admin-regression.log`、`/tmp/tb08-wanx-all.log` 供本机复核；长期验收事实记录如下。

### 实际联调事实

| 故障场景 | 原 eligibility_id | 唯一注册 event_id | 最终 USD atoms / 序号 |
| --- | --- | --- | --- |
| 远端成功后丢响应、过期租约与人工恢复竞争 | 5daa4d94-b19f-4438-98b7-5faa0b01a3a4 | e20d4c2b-17a1-48bd-a2f6-8d05d49232fa | 2500000000 / 2 |
| 冲突进入人工核对后恢复原资格 | ab59628a-9b0d-40dc-af49-5e8e62cecf8f | f05726d6-0583-4b62-8af8-58b82df5407d | 2500000000 / 2 |

两种隔离参数场景各自批次名为 `historical-20261020`，MySQL 按场景重建，远端账号分别为 a-tb08-lost_response 与 a-tb08-review_required 对应的独立托管账号。预演五账号范围，各批准一个旧账号：原期初 20 USD（购买 15 + 非注册历史赠送 5），补发后 25 USD（购买 15 + 赠送 10）；与其并发的新账号得到独立一笔 5 USD。批次重复提交、另建批次预演、并发原资格执行均未增加第二笔注册赠送。生产 WANX renderer 读取真实 Admin HTTP 钱包，输出 `balance 2500.00 credits`、`registration credited: 500.00 new credits`，无领取动作。

本条使用合成的历史凭证和旧余额，不代替真实存量核查；没有真实收款或 LLM 调用。QeeToken 本轮无生产代码或 schema 变更，新增 Admin SQL 仅建立审批审计表。现有 Admin 认证 F821、完整依赖图/映射模型类型问题和全量 Go lint 基线沿用前条记录，未纳入本条清理范围。TB09/TB10 继续支付查询/关单竞争、完整切换、Windows 真机和生产支付验收。

测试结束后已检查 `wanx-tb08-mysql` 与 `wanx-tb08-postgres` 均带 `wanx.credits.disposable=true` 且没有主机目录绑定，并移除这两个容器及其匿名卷；未操作其他数据库。生产开关保持原状，未提交或推送。

## TB09 支付查询关单竞争与切换预演验收记录

日期：2026-10-20～21。状态：**开发、隔离测试和切换预演完成**。完整约束见 [TB09 合同](../credit-cutover-contract.md)，两种时序的阻塞/最终原始报告及事件 ID 见 [JSON 验收样本](../credit-cutover-rehearsal-sample.json)。

本条沿用三个项目四个 checkout 的 `codex/credit-v2-tracer-20261020`，在前条成果上继续实施。按 `/tmp/wanx-tb09-before` 固定快照审查本条增量，保留原有未提交工作。Admin 新增支付观察、预演服务与 DTO、两个管理 API；WANX 新增实际 HTTP 响应驱动的 renderer 验证，QeeToken 扩展真实跨服务测试入口；后两者无本条生产逻辑变更。复用现有 CreditWork，无新增 SQL。

### Tracer bullets

| Bullet | 输入 → 持久事实 → 恢复／输出 | 验收证据 |
| --- | --- | --- |
| TB09.1 未知查询 → 原关单责任 → 保持核对 | 原 close task 先 query；仅 pending 调 close，unknown 保留原单/意图 | T25/T31：unknown 没有 close 调用；后续付款仍在同订单履约 |
| TB09.2 渠道动作 → 持久观察 → 可复核证据 | I/O 前保存尝试，结束保存状态、摘要与原付款引用；中断保持未确认 | T25/T32：create/query/close 均关联原 work/order；超时 HTTP 摘要可复算 |
| TB09.3 已验证付款 → 本地事务失败 → 原单恢复 | 付款观察独立持久化；重启沿原单重新校验再入账 | T04/T32：注入 payment INSERT 后异常、下一次渠道 unknown 仍唯一到账；错单观察拒绝且不毒化后续正确查询 |
| TB09.4 显式范围 → 不可变预演 → 逐账号下一步 | 管理员/原因/范围/订单/迁移/赠送/钱包序号形成报告 | T25/T32：同操作重放同报告，改范围冲突；新报告反映新事实，原报告不变；无财务副作用 |
| TB09.5 支付关单竞争 → 原冻结义务 → 迁移门控 | 两个时序：close 返回 paid；close unknown 后重复已验证通知到达 | T04/T05/T25：未知付款阻断迁移；确认后原旧单 20 USD 不混入期初；旧 DTO 只恢复原意图 |
| TB09.6 剩余期初 → 原单履约 → 注册补发 | 已到账旧单只迁移剩余购买 15 USD，另有历史赠送 5 USD；期初完成后待付义务入 20 USD，最后原资格赠送 5 USD | T26/T32：迁移及充值丢响应后重建执行器；未到账订单阻断补发；最终只有 3 个事件、45 USD |
| TB09.7 真实 HTTP → WANX 恢复 → 正确展示 | 支付成功待到账时保留 2000.00 余额与原意图；最终序号 3 后显示 4500.00，原单显示 2000.00、注册赠送 500.00 | T04/T30/T31：不提前成功、不显示未知零、不新建/关闭订单、不触发领取；到账后清除原意图 |

TB07/TB08 原有执行门控继续生效，没有另造一套报告授权。`next_action=ready` 仅指报告生成时的本地事实；实际窗口、远端最新事实及执行前再次校验不能由该标记代替。

### 红绿循环与审查

unknown 仍调用 close、观察模块缺失、预演服务缺失、付款事务失败后无法恢复、HTTP 路由 404，均先由行为测试失败，再完成实现通过。基于 SQLAlchemy 真实 MySQL 执行故障的恢复测试不是仅检查函数调用次数。

独立审查指出两处问题并完成修复：

1. 重放已验证付款若直接调用 record_payment 可能绕过与当前 work 的订单关联。现在走原 apply_channel_result 校验；另一订单的付款观察被排除，回归覆盖拒绝错单及之后正确付款恢复。
2. 异常观察只存稀疏结果，HTTP 补齐空字段后内层摘要不一致。现在存储前统一 PaymentOutcome；实际 HTTP 测试同时复算单条观察摘要和完整报告摘要。红灯见 `/tmp/tb09-observation-hash-red.log`，修复后支付回归通过。

Standards 与 Spec 分别审查本条增量，最终均 **0 个未解决发现**；Go 测试入口另行审查通过。核心、恢复、安全边界、真实链路及最终规范化改动均纳入复核。静态审查不代替数据库和渠道验收。

### 实际检查

| 检查 | 结果 |
| --- | --- |
| WANX `make all` | **4841 passed、17 skipped**；格式、Ruff、mypy 通过 |
| WANX `npm test --prefix wanx-client` | **1460 passed、19 skipped** |
| WANX `WANX_TEST_ELECTRON=1 node --test wanx-client/tests/credit-wallet-electron.test.mjs` | **1 passed、0 skipped**，本机 macOS |
| Admin 下列 26 文件积分/支付回归 | **281 passed、16 skipped**；16 个 live 参数由跨服务夹具另行实际执行 |
| 最终摘要修复后 TB09 + payment_recovery + Alipay + WeChat | **79 passed、2 skipped**；2 个 TB09 live 参数随后真实跨服务复跑 |
| `TestWanxCrossServiceBilling` | **PASS**；TB09 两参数无 skip，TB01–TB08 与原 Consumer journey 同时通过 |
| Admin 本次 6 个 Python 文件 Ruff / format check | 通过 |
| Admin 4 个服务/DTO 限定导入图 mypy | 通过；不是完整仓库类型通过声明 |
| QeeToken `go test ./...`，隔离 PostgreSQL | PASS |
| QeeToken `go test -tags unit ./internal/service ./internal/handler ./internal/server/routes` | PASS |
| QeeToken `go vet ./...` | PASS |
| QeeToken 全量 golangci-lint / TB09 差异 | 仍为既有 **22 项**（depguard 1、errcheck 15、staticcheck 6）；按固定快照检查新增 7 行，**0 issues** |
| HTTP/OpenAPI | 读/核对权限、缺少幂等头、额外字段/参数、报告重放/查询和 hash 核验通过；docs 可访问，summary/DTO 存在 |
| 四个 checkout `git diff --check` | 通过 |

本条没有 UI 产品源码变化，未重新构建已有 bundle 或 Admin UI；跨端展示直接使用实际生产 renderer 和真实 HTTP JSON。默认可选 skip 不被当作已验收，实际数据库及 macOS Electron 的独立运行单列如上。

Admin 回归命令在 `admin-backend` 运行：

```sh
CREDITS_TEST_CONTAINER=wanx-tb09-mysql uv run --python .venv/bin/python pytest \
  tests/module_nexus/test_credit_cutover_rehearsal.py \
  tests/module_nexus/test_registration_batches.py \
  tests/module_nexus/test_qeetoken_migration.py \
  tests/module_nexus/test_credit_recharge_v2.py \
  tests/module_nexus/test_qeetoken_display.py \
  tests/module_nexus/test_qeetoken_consumption_sources.py \
  tests/module_nexus/test_credit_queries.py \
  tests/module_nexus/test_registration_grants.py \
  tests/module_nexus/test_qeetoken_sources.py \
  tests/module_nexus/test_credit_denomination.py \
  tests/module_nexus/test_credit_products.py \
  tests/module_nexus/test_credit_orders.py \
  tests/module_nexus/test_credit_payment_recovery.py \
  tests/module_nexus/test_qeetoken_accounting.py \
  tests/module_nexus/test_qeetoken_cutover.py \
  tests/module_nexus/test_qeetoken_compatibility.py \
  tests/module_nexus/test_qeetoken_admin.py \
  tests/module_nexus/test_credit_configuration.py \
  tests/module_nexus/test_credit_http.py \
  tests/module_nexus/test_credit_case_operations.py \
  tests/module_nexus/test_credit_payment_boundaries.py \
  tests/module_nexus/test_credit_alipay.py \
  tests/module_nexus/test_credit_admin_queries.py \
  tests/module_nexus/test_credit_wechat.py \
  tests/module_nexus/test_credit_admin_http.py \
  tests/module_nexus/test_credit_alipay_http.py -q --tb=short
```

新增 TB09 文件包含 6 个本地测试与 2 个 live 参数。跨服务命令在 `nexusaos-qeetoken/sub2api/backend` 运行：

```sh
GOTOOLCHAIN=go1.26.4 \
CREDITS_TEST_CONTAINER=wanx-tb09-mysql \
WANX_TEST_ADMIN_ROOT=/Users/lynn/Documents/centaurai/projects/nexusaos-admin/admin-backend \
WANX_TEST_BRIDGE_ROOT=/Users/lynn/Documents/centaurai/projects/centaur-WANX/wanx-bridge \
WANX_TEST_POSTGRES_DSN='postgres://postgres@127.0.0.1:61260/lifecycle_test?sslmode=disable' \
go test ./internal/handler -run '^TestWanxCrossServiceBilling$' -count=1 -v
```

DSN 仅对应本次 disposable PostgreSQL，Go 建立独立 schema；MySQL 为本次 disposable 容器，各 pytest 按顺序运行。临时日志 `/tmp/tb09-cross.log`、`/tmp/tb09-admin-regression.log`、`/tmp/tb09-final-payment.log`、`/tmp/tb09-wanx-all.log` 可供本机复核；长期报告归档在本目录 JSON。

### 预演事实与剩余发布边界

两种场景分别使用 `tb09-close_race` 和 `tb09-late_callback` 账号及独立远端/资产身份。最终均只有 `migration_opening`、`recharge`、`registration_grant` 三个事件，序号 **3**、余额 **4500000000 USD atoms（45 USD）**，其中购买 **35 USD**、赠送 **10 USD**。已到账旧单不重复入账，原未到账旧单只入一次 20 USD，已完成迁移与赠送重复恢复不新增事件。

迁移远端成功丢响应时报告提示恢复迁移；迁移完成但原单未到账时提示履约原单；原单确认后才允许批准历史注册资格；补发并同步后最终报告 ready。两个原始阻塞报告均保持不变，最终完整报告 hash 可重算。renderer 在待到账阶段保留已确认余额 2000.00，完成后显示 4500.00 与注册赠送 500.00。

最终联调后归档 **2 种场景、4 份不可变报告、20 条已完成观察**，使用 RFC 8785 规范化重新计算全部报告和观察 SHA-256，与返回摘要完全一致。

实际数据库/HTTP/renderer 链路已跑通，支付渠道、旧资产及领取证据为合成夹具。本条未进行真实收款、LLM 调用、生产开关切换、实际迁移或补发。现有 Admin 认证 F821、完整依赖图/映射模型类型问题及 Go 全量 lint 基线继续作为既有发布门槛保留；Windows 真机、真实支付通知、采购价格核算和完整上线/恢复手册由 TB10 继续。未提交或推送。

测试结束后核对 `wanx-tb09-mysql`、`wanx-tb09-postgres` 均带 `wanx.credits.disposable=true` 且无主机目录绑定，已移除这两个临时容器及匿名卷。未操作其他数据库。

## TB10 本地开发与隔离验收交付

日期：2026-10-21。沿用四个 checkout 的 `codex/credit-v2-tracer-20261020`，保留 TB01–TB09 和其他同时存在的工作；未提交、推送或部署。**用户确认没有 Windows 验收环境或采购成本资料，因此本条本地交付完成，外部验收仍未完成，生产 NO-GO。**

### 纵向拆分与实际结果

| Tracer bullet | 输入 → 持久事实 → 恢复 → 可观察结果 |
| --- | --- |
| TB10.1 | 新账号资格 → 5 USD 注册赠送 → 10 元订单唯一入 10 USD → 原生合成定价与四次真实扣费 → 来源事件和 HTTP/renderer 最终 975 积分 |
| TB10.2 | 远端消费提交 → 本地同步异常保留已确认 1500 积分 → 按原游标追平至 975 → 重放原赠送、订单和消费均不重复记账 |
| TB10.3 | renderer 构建 → macOS Electron 真实 DOM/付款状态/焦点/报价 → 760px 最小桌面检查与截图 → Windows/macOS CI 入口保存版本、日志和截图 |
| TB10.4 | 成本 0.07 元合成样本 → 目标收入 0.10 元/10 积分 → 明确收费倍率与成本统计区别 → T01–T32 验收矩阵和上线/向前恢复手册 |

TB10.1/2 使用真实一次性 MySQL/PostgreSQL、Go 业务计价/扣费、Admin 服务/ASGI 和 WANX 生产 renderer。支付与上游调用是合成夹具，部分 HTTP 身份为测试 override，不是生产渠道验收。新 Go 定价入口只存在于 `_test.go`；本条没有增加生产 API、业务规则或 schema。

初始赠送 5 USD、购买 10 USD；扣费 4.95、0.10、0.10、0.10 USD 后，总余额及购买来源均为 9.75 USD，赠送为零。跨来源的第一笔 0.10 USD 消费各扣赠送/购买 0.05 USD，不能把赠送消费计作购买收入。原生序号为 6，共六个唯一事件。实际 HTTP JSON 经客户端合同解析和生产 renderer 显示 975.00，消费为 495.00 与三笔 10.00，无 USD/token 泄露。

### 红绿循环与独立审查

先加入 Admin 完整场景，真实跨服务运行在缺少测试定价入口时返回 404（`/tmp/tb10-cross-red.log`）；补齐调用原生计价和扣费的测试入口、真实 HTTP 到 renderer 的核验后，两项跨服务测试通过。同步故障验证保留已确认值，恢复和重复执行验证余额、事件数与序号。

扩大 Admin 回归发现旧多进程用例仍预期 query unknown 可直接关单，与 TB09 规则冲突。更新该测试验证 unknown 保留 `close_pending` 并阻止新购买，迟到建单明确 pending 后才关闭，迟到响应不能重新打开旧单；两个时序均通过。未放宽生产关单条件。

Standards：**0 个未解决发现**。Spec：**0 个未解决发现**。Go 增量审查及 vet 通过。审查指出的 E6 分页措辞已改为按原游标追平，分页断点由 TB05 覆盖；合成价卡不能证明生产配置实际选中了相同费率。最终机器证据与日志、源码、截图逐项一致。

### 长期留证与发布边界

- [T01–T32 验收矩阵](../credit-release-acceptance.md)：逐条对应测试及仍缺少的现场证据。
- [代表性价格核算](../credit-pricing-rehearsal.md)：合成汇率/成本、三种计价、实际配置核验及月度复核字段。
- [上线与向前恢复手册](../credit-release-runbook.md)：依赖与部署次序、开关、旧单/迁移/补发原 ID、停止条件和恢复责任。
- [机器证据](../credit-release-evidence.json)：原始报告、事件 ID、来源差额、序号、版本和 SHA-256；[截图目录](../credit-release-evidence/)。

最终日志归档的 4 份不可变报告和 20 条支付观察摘要已用 RFC 8785 重算通过；9 个源码/构建文件、4 张图片及跨服务日志 SHA-256 均核验一致。HEAD 只记录基线，JSON 明确标注未提交变更，不能将它当作已发布版本。

本机 Electron 为 macOS arm64 / 37.10.3；390px 仅为组件压力检查，产品桌面最小宽度 760px 单独断言根页面不横向溢出。截图来自临时 HTML 夹具，未加载产品品牌图片，不是安装包截图。新增 workflow 尚未在 Windows 执行；手册同时列出源码运行和发行包升级/原意图恢复步骤。

正式放行仍需 Windows 实机/安装包、真实采购与最终收费配置、真实支付、真实历史资产/领取核对、隔离备份恢复和正式窗口审批。既有 Admin 认证/完整类型图问题及 Go 全量 lint 基线仍是发布门槛。现有持久 lab 的 v1 smoke 没有执行，也没有通过修改其数据冒充 v2 验收。

### 实际验证命令与结果

| 检查 | 实际结果 |
| --- | --- |
| WANX `make all` | **4841 passed、17 skipped**；格式、Ruff、mypy 通过 |
| WANX `npm test --prefix wanx-client` | **1460 passed、19 skipped**；可选设备/安装包/跨进程测试不因此视作验收 |
| renderer `npm run build:renderer` | 通过；wallet/device bundle 与 TB10 前快照一致 |
| CI 选择的钱包合同、view、IPC、panel-security、panel-renderer 五文件 | **113 passed、0 skipped** |
| 显式启用 WANX Electron 钱包测试 | **1 passed、0 skipped**，本机 macOS；包括 760px 根页面断言 |
| Admin frontend `npm test` | **429 passed、1 skipped**；可选 Electron 下行另跑 |
| Admin frontend 显式 Electron `tests/qeetokenUi.test.mjs` | **1 passed、0 skipped**，本机 macOS |
| Admin frontend production build | 通过 |
| Admin 积分、赠送、QeeToken 与 preflight/local_guard 扩大回归 | **777 passed、29 skipped**；下文说明独立环境补跑 |
| 更新后的多进程关单两时序 | **2 passed、30 deselected**，之后纳入扩大回归 |
| 两个修改的 Admin Python 测试 Ruff / format / 限定 mypy | 通过；mypy 为两文件检查，不声明全仓类型通过 |
| Go `TestWanxCrossService(Lifecycle\|Billing)` | 两项均 PASS；顺序调用的 **19 项 Python live 用例通过**，TB10 无 skip |
| Go `go test ./...`，显式隔离 PostgreSQL DSN | PASS；跨服务专用环境由上一行补跑 |
| Go `go test -tags unit ./internal/service ./internal/handler ./internal/server/routes` | PASS |
| 原生价格/倍率/账号统计七类定向测试 | **67 个顶层测试 PASS**；使用 unit 标签和 `-count=1` |
| Go `go vet ./...` | PASS |
| Go 全量 golangci-lint / TB10 差异 | **22 项既有问题**（depguard 1、errcheck 15、staticcheck 6）；本轮变更行 **0 新增问题** |
| 四个 checkout `git diff --check` / 新 helper 语法 / 证据摘要 | 通过 |

Admin 扩大回归命令：

```sh
CREDITS_TEST_CONTAINER=wanx-tb10-mysql uv run --python .venv/bin/python pytest \
  tests/module_nexus/test_credit_*.py \
  tests/module_nexus/test_registration_*.py \
  tests/module_nexus/test_qeetoken_*.py \
  tests/test_qeetoken_preflight.py tests/test_qeetoken_local_guard.py -q -rs --tb=short
```

Go 完整联调在 `nexusaos-qeetoken/sub2api/backend` 运行：

```sh
GOTOOLCHAIN=go1.26.4 \
CREDITS_TEST_CONTAINER=wanx-tb10-mysql \
WANX_TEST_ADMIN_ROOT=/Users/lynn/Documents/centaurai/projects/nexusaos-admin/admin-backend \
WANX_TEST_BRIDGE_ROOT=/Users/lynn/Documents/centaurai/projects/centaur-WANX/wanx-bridge \
WANX_TEST_POSTGRES_DSN='postgres://postgres@127.0.0.1:60057/lifecycle_test?sslmode=disable' \
go test ./internal/handler -run '^TestWanxCrossService(Lifecycle|Billing)$' -count=1 -v
```

这里的容器和 DSN 仅为本次可销毁数据库，MySQL 测试顺序运行，不并行重建同一库。独立测试日志保留于本机 `/tmp/tb10-cross.log`、`/tmp/tb10-admin-regression-final.log`、`/tmp/tb10-wanx-all.log`、`/tmp/tb10-client-all.log`、`/tmp/tb10-electron.log`、`/tmp/tb10-admin-electron.log`；长期事实以本目录 JSON、矩阵和截图为准。

WANX 默认 17 个 Python skip 和 19 个 Node skip 包括其他 live/设备/安装包场景，不笼统声明已补齐。本次积分钱包的可选 Electron 明确单独执行；Windows 签名/安装包等仍在外部待验收范围。

Admin 的 29 个默认 skip 中，19 个需要 Go 服务的用例由上述专用联调执行；另 10 个需要显式 WANX 路径。补跑后者所在三个文件，共 **16 passed、0 skipped**：

```sh
CREDITS_TEST_CONTAINER=wanx-tb10-mysql \
WANX_CREDITS_REPO=/Users/lynn/Documents/centaurai/projects/centaur-WANX \
WANX_TEST_BRIDGE_ROOT=/Users/lynn/Documents/centaurai/projects/centaur-WANX/wanx-bridge \
uv run --python .venv/bin/python pytest \
  tests/module_nexus/test_credit_legacy_isolation.py \
  tests/module_nexus/test_credit_wanx_flow.py \
  tests/module_nexus/test_qeetoken_custom_providers.py -q -rs --tb=short
```

补跑暴露五参数旧测试仍要求当前 UI 展示 v1 三档。更新为验证未切换账号的 v2 目录禁售且无商品、UI 不展示旧档位；先持久化原旧单，再用当前客户端真实签名请求恢复同一意图并核对原订单 ID。付款恢复、消费结算、幂等、账号隔离及唯一渠道建单断言全部保留，v2 新购买由 TB06/TB10 专项验证。该第三个 Python 文件 Ruff/format、限定 mypy 和独立审查通过；日志 `/tmp/tb10-admin-extra-contracts.log`。未改变生产购买门控。

本轮期间 Admin 还存在其他工作的时间兼容性等改动；已保留，不归入 TB10 实现。机器证据列出的文件摘要用于限定本轮关键验收入口，不能声称对所有并行改动完成评审。

所有测试结束后已核对 `wanx-tb10-mysql`、`wanx-tb10-postgres` 的 `wanx.credits.disposable=true` 标签及无主机绑定目录，移除两容器与匿名卷；未操作其他数据库。

## 购买交互优化：先选商品，再确认渠道

日期：2026-10-21。用户反馈点击商品立即建单，切换支付渠道需要关单再建单，等待较长。本轮仅修改 WANX 钱包交互、样式、生成 bundle 及相关测试，不改 Admin/QeeToken 支付合同。

纵向场景：选择商品（自定义先取报价）→ 本地渠道选择/更换商品 → 点击确定后持久原意图并建单 → 独立二维码视图 → 取消沿原关单任务恢复。商品和渠道选择没有网络请求，不持久购买意图；确认前取消无支付副作用。确认后隐藏可修改商品/渠道的控件，保持原订单幂等、重复点击防护、丢响应恢复、切号隔离及付款码过期规则。右上角关闭与 Escape 仅收起；“取消支付”才请求关单，明确关闭后允许重新选择。

TDD 先验证确认前不产生订单，再验证“商品 → 渠道”两步视图，均先红后绿。自定义金额修改使原报价失效，不能直接按旧报价提交。保留支付胜过关单、未知关单禁止换单、未到账保留原责任等既有回归。

| 验证 | 结果 |
| --- | --- |
| `node --test wanx-client/tests/credit-wallet-view.test.mjs` | **37 passed、0 skipped** |
| `npm test --prefix wanx-client` | **1461 passed、19 skipped**；既有设备/环境可选用例仍不作通过声明 |
| `npm run build:renderer --prefix wanx-client` | 通过，wallet bundle 已更新 |
| `WANX_TEST_ELECTRON=1 node --test wanx-client/tests/credit-wallet-electron.test.mjs` | **1 passed、0 skipped**；macOS 原生 DOM、实际点击、焦点、取消/恢复、自定义金额及窄布局通过 |
| `make all` | **4841 passed、17 skipped**；格式、lint、typecheck 通过 |
| Standards / Spec 独立审查 | 各 **0 个未解决发现** |
| `git diff --check` | 通过 |

[渠道确认页](../credit-checkout-evidence/checkout-confirmation.png)、[窄组件确认页](../credit-checkout-evidence/checkout-confirmation-narrow.png)、[二维码支付页](../credit-checkout-evidence/purchase.png) 来自本次 macOS 合成数据夹具，不是真实支付或安装包证据；390px 仅组件检查，桌面最小支持宽度仍为 760px。原 TB10 JSON/截图保留历史事实，本次界面取证以此节为准，旧文件摘要不代表最新源码。

本机日志：`/tmp/checkout-unit.log`、`/tmp/checkout-node.log`、`/tmp/checkout-electron.log`、`/tmp/checkout-make-all.log`。未提交、推送或操作真实支付；Windows 等外部发布门槛保持待验收。

## Admin Python 3.10 时间兼容复核

日期：2026-10-21。用户再次确认线上 Admin 使用 Python 3.10。现有工作区已包含 `utils.iso_time.parse_iso_datetime` 和调用点修复；本次未重复修改业务代码，已将运行时要求补入上线手册。

使用 **Python 3.10.17** 和开发 **3.12** 顺序执行同一组测试：`test_time_compatibility.py`、`test_qeetoken_timestamps.py`、`test_credit_cutover_rehearsal.py`、`test_credit_payment_recovery.py`、`test_credit_orders.py`、`test_credit_wechat.py`、`test_credit_alipay.py`。两次均为 **174 passed、2 skipped**；跳过项是 TB09 需要独立 Go HTTP/PostgreSQL fixture 的两个 live 场景，不属于本次 Python 版本验证。

实际覆盖 `Z`/正负时区偏移、Go 0～9 位小数秒、协议层非法格式拒绝、纳秒截断到微秒、不改变时刻的 UTC 转换、支付后同步及超时恢复。支付观察重放与关单 deadline 的两处直接解析只读取系统自身 `timespec='microseconds'` 规范化写入值，相关恢复测试在 3.10 通过。不能把该结果称为全仓 Python 3.10 验收。

命令在 `nexusaos-admin/admin-backend` 运行，使用独立可销毁 MySQL `wanx-time310-verify`：

```sh
CREDITS_TEST_CONTAINER=wanx-time310-verify \
uv run --no-project --python /tmp/wanx-qee-timestamp-py310/bin/python pytest \
  tests/module_nexus/test_time_compatibility.py \
  tests/module_nexus/test_qeetoken_timestamps.py \
  tests/module_nexus/test_credit_cutover_rehearsal.py \
  tests/module_nexus/test_credit_payment_recovery.py \
  tests/module_nexus/test_credit_orders.py \
  tests/module_nexus/test_credit_wechat.py \
  tests/module_nexus/test_credit_alipay.py -q -rs --tb=short
```

3.12 对照使用 `uv run --python .venv/bin/python pytest` 和相同文件。日志为 `/tmp/credit-time310-verify.log`、`/tmp/credit-time312-verify.log`。未操作线上服务或业务数据。

测试结束后核对 disposable 标签及无主机目录绑定，已清理本次 MySQL 容器和匿名卷。
