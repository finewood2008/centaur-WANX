# TB10 三端发布验收矩阵

日期：2026-10-21。**本地开发与隔离验收完成情况按下表留证；生产放行结论为 NO-GO。** 用户确认没有可用 Windows 环境和采购成本资料。Windows 源码/安装包实际运行、真实支付通知、实际模型采购/收费配置、生产存量与备份恢复记录尚未具备，不能将本地模拟结果升级为生产通过。

交付：[上线与向前恢复手册](credit-release-runbook.md)、[价格核算](credit-pricing-rehearsal.md)、[TB10 机器证据](credit-release-evidence.json)、[当前任务状态](credit-tracer-tasks.md)、[阶段原始记录](archive/credit-tracer-tasks-20261021.md)。三端已有工作保留在原实施分支，未提交或推送。

## 证据入口

| 代号 | TB10 执行边界（后续修订另列） |
| --- | --- |
| E1 | Go `TestWanxCrossServiceLifecycle` + `TestWanxCrossServiceBilling`：一次性真实 PostgreSQL/MySQL、Go HTTP、Admin 服务/ASGI、WANX renderer；依次运行 TB01–TB10 live 场景和原 Consumer 注册/盒子归属 journey |
| E2 | Admin `test_credit_*.py`、`test_registration_*.py`、`test_qeetoken_*.py` 与配置/本地保护检查；单独记录本地回归与缺少 live 环境的 skip |
| E3 | QeeToken 全量 Go、unit 标签、原生计价/用户倍率选择/账号统计定价定向测试、真实 PostgreSQL 事务 |
| E4 | WANX 全部 Node 测试；钱包协议、展示、IPC、快捷面板与安全检查 |
| E5 | macOS 原生 Electron 37.10.3：生产 bundle/DOM、付款状态与焦点、自定义报价、消费、760px 桌面与窄组件；Admin 管理恢复界面单独 Electron 运行 |
| E6 | `test_credit_release_rehearsal.py` → 原生合成价卡/扣费 → 来源事件 → 同步中断恢复 → 真实 HTTP → `release-display.mjs`；事件与最终余额归档 JSON |
| E7 | 新增 Windows/macOS workflow；仅完成文件与跨平台入口检查，Windows 尚未运行 |

E1 是真实业务服务与数据库的测试夹具组合：HTTP 身份部分使用测试 override，渠道付款和上游 usage 为模拟；不是生产进程、真实支付、实体盒子或完整真实渠道验收。旧 `qeetoken-local/smoke.py` 仍有 v1 商品/断言，本次未对现有 lab 执行它。

## T01–T32

下表“本地通过”只指列出的隔离/代码边界；支付相关条目仍须补实际渠道证据，界面相关条目仍须补 Windows 结果。

| 编号 | 本地事实与入口 | 状态/未覆盖部分 |
| --- | --- | --- |
| T01 | E1/E2 `test_credit_recharge_v2`：五档全额、原事件与客户端显示 | 本地通过；真实收款待验收 |
| T02 | 同文件：10/11/1000、非法小数/越界/混传/伪造额度；Electron 自定义 11 元 | 本地通过 |
| T03 | 原冻结订单、重复意图、配置版本变化、账号切换；wallet 与 recovery tests | 本地通过；发行包升级/Windows 待验收 |
| T04 | TB01/TB06/TB09 丢响应/本地事务故障/重复通知，Electron paid_pending | 本地通过；真实通知待验收 |
| T05 | TB09 原 20 旧积分订单保留 20 USD，展示 2000 积分 | 本地通过 |
| T06 | TB06 新 10 元=10 USD；TB07 旧 20 期初、已有 5 USD不加钱 | 本地通过 |
| T07 | `test_qeetoken_display`/migration 的旧投影、尾差、负值与序号 | 本地通过 |
| T08 | display/queries + wallet-view：混合历史分页、原事实解释 | 本地通过 |
| T09 | registration_grants + Consumer journey：自行/后台创建、无首充、离线不回滚注册 | 本地通过；生产消息/开户环境待验收 |
| T10 | TB03/TB08 唯一资格，重复执行/并发不重复赠送 | 本地通过 |
| T11 | 注册/迁移 response lost、同 source 异内容冲突；PostgreSQL 事务约束 | 本地通过 |
| T12 | TB07/TB08 原领取证据区分“已领、未领、未知、其他历史赠送” | 合成历史样本通过；真实存量核对待完成 |
| T13 | TB08 无登录历史账号与新账号队列并发 | 本地通过 |
| T14 | TB04 赠送优先；E6 跨来源 0.10 USD 各扣 0.05 | 本地通过 |
| T15 | 原生并发、重放、回滚；E6 相同 request_id 不再扣费 | 本地通过 |
| T16 | 原生其他 key、完整撤销、来源重分类和余额调整；无第二笔扣费 | 本地通过 |
| T17 | 原生准入负值、充值抵欠、非正余额拒绝；wallet 微小欠额 | 本地通过 |
| T18 | E6 合成输入输出/缓存/按次各 0.01×10=0.10 USD；E3 用户覆盖/分组回退与统计代码测试 | **代表性核算通过；实际价卡/倍率选择、采购账单待管理员验收** |
| T19 | TB04/TB08/E6 来源事件：赠送不生成充值，混合消费购买收入仅 0.05 元 | 本地通过；历史资产真实购买价格待核实 |
| T20 | native recharge WANX/非 WANX 门控、旧回调责任相关 Go 测试 | 本地通过；部署配置待核验 |
| T21 | 无新增 WANX 退款/补偿入口；原生纠错测试 | 本地通过 |
| T22 | TB07 只承接真实剩余资产，排除 shadow/人民币/预计消耗 | 合成样本通过；实际资产审计待完成 |
| T23 | TB07 资产唯一占用、重复来源、迁移重跑 | 本地通过 |
| T24 | TB07 单期初购买/赠送合计、零余额/零序号限制 | 本地通过 |
| T25 | TB09 query unknown 不 close、close paid、close unknown+晚回调、持久观察 | 本地通过；渠道现场竞争待验收 |
| T26 | TB09 已到账 20 旧积分只承接剩余 15，待付 20独立履约 | 本地通过 |
| T27 | E4/E5/E6 主钱包、订单、消费、tooltip/快捷面板不露 USD/token；后台保留原核算数据 | macOS/DOM 通过；**Windows待运行** |
| T28 | wallet-view 正负两位半入、原 atoms 保留 | 本地通过 |
| T29 | 真零、正负微小数/0.01边界、无 -0.00 | 本地通过 |
| T30 | stale/乱序/断页/切号；E6 同步失败保留1500、恢复为975 | 本地通过 |
| T31 | TB06/TB09 旧 DTO 新意图拒绝，原意图继续恢复 | 本地通过；实际旧安装包升级待验收 |
| T32 | TB07–TB09 原任务重建/租约/丢响应，E6 同步中断后按原游标追平、无重复钱；分页断点另见TB05 | 本地通过；生产备份恢复/多节点窗口待验收 |

## 本轮新增纵向场景

1. **TB10.1 合成定价 → 新消费 → 真实分账与显示。** 新账号赠送 5 USD、新 10 元订单入 10 USD；实际计算并扣除 4.95、0.10、0.10、0.10 USD。赠送最终 0，购买及总余额均 9.75 USD；renderer 显示 975.00。共六个事件、序号 6，原充值与赠送重放不增加事件。
2. **TB10.2 投影离线 → 保留确认值 → 向前追平。** 远端四笔消费已经提交，本地同步异常时钱包仍为最后确认 1500 积分；恢复同步后一次追平至 975，不再扣费。
3. **TB10.3 发布 bundle → 原生 Electron → 跨平台入口。** 构建核对、实际 DOM/焦点/付款状态及最小支持宽度通过；Windows workflow 显式启用 Electron、保存平台/提交/日志/截图。没有 Windows 结果时不放行。
4. **TB10.4 核算与恢复责任 → 可操作手册。** T18 合成核算与真实成本栏分开；列明旧单、资产、来源、同步、补发每阶段 API/ID、失败恢复与停止条件。恢复不换财务身份、不回退 legacy，不将 cutover ready 当执行授权。

## 后续修订证据

2026-10-21 在 TB10 后完成以下验证。原 TB10 JSON 的源码摘要、报告和截图保持原样，不代表后续修改后的工作区；下列记录补充交互及运行时证据，不将合成支付或 macOS 结果升级为生产通过。

| 修订 | 已验证范围 | 证据 |
| --- | --- | --- |
| 购买交互 | 商品 → 渠道 → 确定 → 二维码；确认前无建单，取消及原单恢复；页面 37 passed，Node 1461 passed / 19 skipped，macOS Electron 1 passed / 0 skipped，renderer 构建通过；`make all` 4841 passed / 17 skipped | [原始命令与审查](archive/credit-tracer-tasks-20261021.md#购买交互优化先选商品再确认渠道)；[确认页](credit-checkout-evidence/checkout-confirmation.png)、[窄组件](credit-checkout-evidence/checkout-confirmation-narrow.png)、[二维码页](credit-checkout-evidence/purchase.png) |
| Admin Python 3.10 | 3.10.17 与 3.12 同组 7 文件均 174 passed / 2 skipped；覆盖 Z、正负偏移、0～9 位小数秒、UTC 转换及支付恢复；2 项依赖独立 Go fixture，不算本轮通过 | [命令与范围](archive/credit-tracer-tasks-20261021.md#admin-python-310-时间兼容复核)；部署要求见[上线手册](credit-release-runbook.md) |

上述 Python 结果不是全仓 3.10 验收。交互截图来自 macOS 合成数据夹具，390px 为组件压力检查，最小桌面宽度仍为 760px。

## 桌面图像证据

以下图片来自 TB10 当次 macOS 测试 fixture；购买交互最新画面见上节。临时 HTML 不加载产品品牌图片，截图不是发行安装包截图；390px 仅检查组件滚动，支持的最小桌面宽度为 760px。

- [760px 最小桌面钱包](credit-release-evidence/wallet-minimum-desktop.png)
- [v2 五档与自定义充值](credit-release-evidence/recharge-v2.png)
- [窄组件自定义 11 元报价](credit-release-evidence/recharge-v2-narrow-quote.png)
- [Admin 原订单恢复页面](credit-release-evidence/admin-narrow.png)

## 发布门槛

| 门槛 | 当前状态 | 解除证据 |
| --- | --- | --- |
| Windows源码与发行包 | 无可用环境；CI 未运行 | Windows原生日志/截图、commit、安装/升级/原意图恢复报告 |
| 真实支付 | 本地模拟 | 两渠道真实通知/查询/关单、重复/延迟通知及对账结果 |
| 真实采购与最终收费配置 | 用户无资料；本次合成 | [核算表](credit-pricing-rehearsal.md#上线前核算与月度复核表)及代表性实际调用 |
| 真实历史资产/领取与备份恢复 | 未执行 | 经审批范围、原证据、异常账号表、隔离恢复核验与演练结果 |
| 既有仓库质量问题 | Go全量lint保留22项、Admin旧认证/完整类型图问题 | 修复或按项目发布流程明确处置，不能称全仓静态检查绿色 |
| 正式窗口与版本发布 | 未提交/推送/部署 | 固定三端及子模块版本、审批窗口、回执和恢复负责人 |

本条交付可复跑的验收入口、实际本地证据和操作手册；上述缺口不靠默认 skip、模拟值或文档勾选关闭。
