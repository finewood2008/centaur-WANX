# 积分 v2 上线与向前恢复手册

版本：TB10，2026-10-21。适用 WANX、Admin、QeeToken/sub2api 的积分 v2 联合发布。本文是操作手册；本次只执行隔离验收，没有授权或执行生产切换。当前发布结论为 **NO-GO**：Windows 实际验收、真实支付/采购成本及生产存量核对等门槛尚未完成。详见 [验收矩阵](credit-release-acceptance.md)。

## 发布包与责任

| 责任 | 发布前必须归档 |
| --- | --- |
| 发布负责人 | 窗口时间（Asia/Shanghai）、范围、审批人、停止条件、三端版本及恢复负责人 |
| WANX | 源码 commit、客户端包哈希/签名、renderer 构建一致性、Windows/macOS 测试日志和截图 |
| Admin | 源码/镜像 digest、数据库脚本校验值、配置 revision、账号/订单/任务/资格清单及脱敏证据 |
| QeeToken | 外仓 commit **及 sub2api commit**、镜像 digest、schema_migrations 及校验值、模型路由/价卡/倍率快照 |
| 财务/运营 | 历史剩余资产与原领取凭证、支付渠道核对、[实际成本核算表](credit-pricing-rehearsal.md#上线前核算与月度复核表) |

当前代码留在 `codex/credit-v2-tracer-20261020`，尚未提交/推送；不能把外仓 gitlink 或旧镜像当作已包含子模块工作区改动。发行产物应来自经过审批的固定源码版本。

Admin 线上 Python 基线为 **3.10**。发布包必须包含 `utils/iso_time.py` 及对应调用点，外部时间解析覆盖 `Z`、时区偏移和 Go RFC3339Nano 可变小数秒；不能仅靠替换 `Z` 解决小数秒兼容问题。时间与恢复回归必须在 Python 3.10 实际运行，并与开发 3.12 对照；不要引入仅 3.11+ 可用的 `asyncio.timeout` 或 `datetime.UTC`。具体命令与约束见 [支付部署说明](../../nexusaos-admin/admin-backend/deploy/README-credits-payment.md)。此基线指 Admin 服务，不改变 WANX/Bridge 各自声明的运行时要求。

## 进入窗口前

1. 完成 T01–T32 对应环境证据。默认 skipped、macOS 上模拟 Windows 参数、静态审查或单次 HTTP 200 都不算 Windows/真实渠道验收。
2. 在隔离恢复目标验证备份可读取且账本关系完整。生产备份由现有数据库运维流程完成：Admin MySQL、QeeToken PostgreSQL、必要业务凭证和稳定加密配置分别留存；记录一致时点及校验值，保留恢复演练结果。不要将密码、付款码或服务 Token 写进验收 JSON。
3. 备份必须包含原订单与付款记录、CreditWork/观察、配置 revision、资产占用、迁移阶段、Grant/Release/Batch、QeeToken 余额/来源/事件/去重回执、账号映射及投影游标。它们是恢复事实，不是可清理的普通日志。
4. 逐一确认增量 schema。Admin 显式脚本按依赖安装：原 MVP core/control/permissions、QeeToken lifecycle/billing/admin，再 `20261020_qeetoken_sources.sql`、`20261020_qeetoken_registration_grant.sql`、`20261020_qeetoken_display.sql`、`20261020_qeetoken_migration.sql`、`20261020_registration_grant_batches.sql`。核对现有表与脚本，不盲目重跑已经应用的 DDL。QeeToken 由原生迁移器按顺序应用 157～162；不要改已应用文件的 checksum 或跳过失败版本。
5. 先部署支持双版本订单、来源、赠送和恢复能力的 QeeToken/Admin，再部署兼容客户端；能力部署不等于开放新写入。保留原配置、真实支付回调和恢复任务。
6. Admin 使用当前配置环境执行 `bash scripts/run.sh check-qeetoken --require-enabled`；该命令只核对配置，不代表远端 Token、DB schema 或业务迁移已验证。不要输出完整环境。详见 [独立部署说明](../../nexusaos-admin/docs/qeetoken-independent-deployment.md)。
7. 确认 QeeToken 的 WANX 持久映射和原生购买边界有效，普通非 WANX 账号仍可使用原生流程；已有支付回调责任不能随新购买门控停止。

本次没有生产备份恢复演练、生产凭证验证或数据库升级执行记录；这些是进入窗口的实证门槛。

## 维护窗口：先保留事实，再逐阶段推进

### 1. 限制新写入

读取 `GET /nexus/credits/config` 保存 revision。在管理员权限下通过 `PATCH /nexus/credits/availability` 的版本化命令关闭新充值（`recharge_enabled=false`）。每个管理命令保存完整请求、响应、操作者和原因；`Idempotency-Key` 与 operation_id 相同，重试保持请求不变，版本冲突先重新读取而非强改 revision。

迁移/补发暂不提交新任务；必要时关闭 `NEXUSAOS_QEETOKEN_REGISTRATION_GRANTS_ENABLED` 并按实际进程配置重启生效。已经在执行的任务仍应等待结果或租约恢复，不假定环境变量能撤回已发出的请求。

模型调用的受控暂停应在 QeeToken 原生入口/路由或维护流量控制层完成，并由新请求探测验证。**Admin legacy 的 admission_enabled 不是 QeeToken 原生准入开关**，不能依赖它冻结原生调用。已接受的调用、付款回调、原履约、事件同步必须继续处理。暂不清理未确认的调用或工作。

### 2. 查询支付责任并保存原始报告

以 1～100 个排序去重的显式账号建立 `POST /nexus/qeetoken/cutovers/preview` 报告，保存 report_id/hash；输入格式：

```json
{
  "schema_version": "1",
  "operation_id": "<本次只读盘点操作ID>",
  "report_id": "<本次报告ID>",
  "account_ids": ["<账号ID>"],
  "reason": "<切换窗口与核对原因>"
}
```

该 API 不查询渠道、不冻结交易、不执行迁移。另通过原订单/核对工作查询渠道并保存证据。明确未付才尝试关单；unknown 保持待核对，paid 按原快照保留义务。核对旧订单、活跃调用及未确认结算；未知责任存在时停止该账号推进，不能清空本地购买意图换新订单。

### 3. 固定资产、来源和领取资格

读取 `GET /nexus/qeetoken/migrations/accounts/{account_id}`；将“已到账旧单的真实未消费部分”与“已支付但未到账的原单”分开。资产按 canonical asset_id 去重，旧订单资产用 `order:<order_id>`。排除 shadow、预计消耗、人民币钱包和已经迁移部分。

历史注册记录经真实凭证核验，使用 `POST /nexus/qeetoken/registration-grants/history` 保存结论。其他历史赠送不是注册领取凭证；缺少领取证据保持 unknown。不能为了发放而把未知标成未领。

### 4. 承接期初或核实已有 USD

| 账号状态 | 原流程 | 放行依据 |
| --- | --- | --- |
| 未迁移、远端满足零余额/零序号 | `/migrations/preview` → 保存 preview_hash → `/migrations/jobs` | 原资产剩余合计与购买/赠送分量一致；原 job 完成，展示阶段完成 |
| 已有远端 USD | `/sources/preview` → `/sources/jobs`；必要时独立有证据重分类 → `/display/preview` → `/display/commit` | 来源核实、余额/序号匹配；总 USD 不增加 |
| migration_in_progress | 查询 `/jobs/{job_id}`，恢复原 job | 不另建 `migration:<account_id>` 或改原资产金额 |
| 未知/欠额/在途/冲突 | 保留阻塞报告和责任人 | 核实之后重新预演；不归零、免债或绕过门控 |

表中相对路径均以 `/nexus/qeetoken` 为前缀。迁移和补发的 preview_hash 格式依原 DTO，不能把 cutover report_hash 当作执行摘要。提交必须使用原预演完整请求，只追加返回的 preview_hash；并发事实变化导致冲突时重新核对。

### 5. 原订单履约与事件追平

期初完成后才恢复待到账旧单；已到账旧单只迁移剩余资产，不能重复履约原整单。管理恢复使用 `POST /nexus/qeetoken/jobs`，`action=fulfill`、resource_id 为原已验证订单。查原任务直到回执明确，核对 QeeToken 原事件和 Admin 同步序号。

若远端成功而响应丢失，保留原 order/source/operation，重试获取原回执；不凭本地超时再发一笔充值。分页追平至确认序号，读取同一时点余额与来源合计；没有追平前客户端应显示待到账或保留最后确认值。

### 6. 批量注册补发

调用 `/registration-grants/batches/preview`，保存范围、逐账号 decision 和 preview_hash；只有 eligible 才能在相同范围提交 `/registration-grants/batches`。随后查询 `GET /registration-grants/batches/{batch_id}`。批准排队不等于到账。

开启已审批范围所需的赠送执行器；新账号继续相同唯一资格队列。历史补发引用原 eligibility_id，批次只作审计分组。没有登录、没有盒子的合格旧账号也应执行。订单未解、来源未核实、同步未完成或阶段变化时让执行器继续阻断，不能人工强置 credited。

### 7. 对账、开放与观察

重新生成 cutover 报告；保留旧报告，核对每个账号阶段、订单义务、来源、事件序号和赠送结果。`ready` 只是生成时本地结论，仍需与远端最新快照及窗口期间新事实核对。

管理员用 `POST /nexus/credits/config/recharge-v2` 发布固定规则，发布后新购买仍关闭；核对五档与自定义 10～1000 整数元、无加赠、旧客户端只恢复原意图。按实际当前 revision 调用 availability 开放新充值；再恢复 QeeToken 原生正常请求。不要为了关闭维护窗口切回 legacy 扣款。

观察并归档：新增支付 unknown、paid_pending、迁移/补发 review_required、过期租约、同步延迟、来源合计差异、重复 source 及模型扣费偏差。任何金额/来源/幂等异常立即限制受影响的新入口，继续已确认事实的恢复与同步。

## 向前恢复决策表

| 现象 | 查询与恢复 | 禁止的捷径 |
| --- | --- | --- |
| 渠道查询/关单 unknown | 原订单、payment_observation、核对 case；原查询任务等租约后重试，接收已验证回调 | 以本地超时标记 closed，换 purchase_intent |
| paid 已确认，本地付款事务失败 | 原付款观察恢复经订单关联/金额/商户校验，再原履约 | 绕过验证直接 record_payment 或换订单 |
| 已付但远端充值丢响应 | 原订单 source 与原充值回执；恢复 fulfill | 新 source 再加钱 |
| 迁移远端完成，本地投影/展示失败 | 原 migration job/stage，`action=retry` 引用原 job_id，再追平事件 | 再发期初或删除资产占用 |
| 来源不明或重分类冲突 | 保存原 source/evidence，补核实证据再按原流程重试 | 用正数调整“补齐”余额 |
| 注册成功但赠送失败 | 原资格 audit 与 batch；`action=registration_grant` 引用原 eligibility_id | 重新注册/换批次制造第二次资格 |
| Admin 序号落后或离线 | `action=reconcile` 引用 account_id，从原游标续页 | 归零游标重放不幂等操作，拿旧投影覆盖远端 |
| 本地旧版客户端请求 | 保留原单恢复；拒绝旧 DTO 的新建意图，升级客户端 | 偷偷替换规则/金额 |
| 已产生 v2 事件后发现缺陷 | 限制受影响新入口，部署兼容修复，按原事实向前恢复 | 回退旧换算/legacy 扣款，删除事件后重发 |

统一恢复命令外形（以原 job 重试为例；其他 action 按上表选择 resource_id）：

```json
{
  "schema_version": "1",
  "operation_id": "<本次管理恢复操作ID>",
  "action": "retry",
  "account_id": "<原账号ID>",
  "resource_id": "<原job_id>",
  "reason": "<已核实的故障原因与证据>"
}
```

新的管理审计 operation_id 不改变原财务 source/event；同一管理请求超时后重放其原 operation_id。API 不接受任意金额。查询管理回执的权限可能限定原操作者，应保留执行人身份，不把 403 当任务未发生。

灾难恢复时先限制新写入，恢复备份至隔离目标，结合渠道账单、备份后事件和外部回执核对缺口再决定恢复方案；**备份不能抹去已核实支付**。没有完成该核对前不能开放旧备份上的收费或领取。

## 桌面与 Windows 验收入口

新增 `.github/workflows/wanx-credit-desktop.yml`：macOS/Windows 原生 runner，固定 Node 22、npm ci、验证 bundle 与源码一致，运行钱包/IPC/快捷面板测试，再显式启用 Electron，归档日志、平台信息和截图。未推送或触发远程 workflow，因此当前 Windows 状态仍是待运行。

Windows 源码检查可在已安装 Node 22 与依赖的 PowerShell 中执行：

```powershell
Set-Location wanx-client
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
npm run build:renderer
if ($LASTEXITCODE -ne 0) { throw "renderer build failed" }
git diff --exit-code -- local-ui/renderer/wallet.bundle.js local-ui/renderer/device-setup.bundle.js
if ($LASTEXITCODE -ne 0) { throw "shipped bundle differs" }
$env:WANX_TEST_ELECTRON = "1"
$env:WALLET_SCREENSHOT_DIR = Join-Path $PWD "credit-evidence/screenshots"
node --test tests/credit-wallet.test.mjs tests/credit-wallet-view.test.mjs tests/credit-wallet-ipc.test.mjs tests/panel-security.test.mjs tests/panel-renderer.test.mjs tests/credit-wallet-electron.test.mjs
if ($LASTEXITCODE -ne 0) { throw "credit desktop acceptance failed" }
```

必须看到 Electron 测试实际 pass、skip 为 0；保留平台/架构、commit、Electron 版本、截图与日志。还需对发行安装包在 Windows 普通用户环境验证：中文/空格目录安装、覆盖升级后原购买意图和账号仍可恢复、DPAPI/ACL、重启、卸载保留用户数据。现有 [Windows 安装手册](wanx-windows-installer.md) 与 `wanx-client/shell/smoke-win.ps1` 提供安装/升级入口；它不替代钱包检查，也不证明有实体盒子。

本次 macOS Electron 验证了真实 DOM、键盘焦点、付款状态、v2 自定义报价、支持的 760px 最小桌面宽度及组件 390px 压力布局。390px 不是完整桌面外壳支持宽度，消费表允许内部滚动；fixture 的临时 HTML 不加载品牌图片，不能把测试截图当发行包截图。
