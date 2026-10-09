# 知君记忆边界修复与平台接口缺口

范围：知君专属 profile 的关怀推送、回答召回和危机数据清理预览。沿用现有平台记忆库、网关与工作区；不修改或 fork 依赖包。以下区分已实现能力与尚未接通的接口，不代表已安装或部署。

## 已实现

- 关怀兜底和资料邀请发送 `proactive_care.zhijun_knock` 固定中英文模板，不读取情绪日记来生成通知，不调用生成模型。到期判断回访可在本人明确标为私人的当前渠道发送本人授权的摘要；心事、其他来源与工作/未标记渠道只敲门。详情见[判断回访与渠道授权](zhijun-decision-notifications-2026-10-02.md)。保留已有本人授权、活动时段、频率与投递状态逻辑；运输结果不确定时记录 `unknown`，避免自动重发。其他应用的关怀逻辑不变。
- 知君模型只看到 `zhijun_memory_recall` 一个召回工具。原生搜索、详情、经历和个人理解均在其后。关闭知君的原生自动召回注入；旧 checkpoint 的原生召回结果在送入模型时替换成要求重新召回的标记。对话原件与本人查阅 API 不改写。
- 同一 `recall_record` 规则用于工具召回、自动个人理解上下文、更新结果和表达选项上下文。原生自动晋升不算本人确认；即使本人认可模型理解，也标为 `confirmed_understanding`，不能冒充亲口原话。只有已确认的本人自述标为 `user_statement`。原文带说话者来源；助理原话仍是助理原话。
- 移植旧知君的纯本地 ordinary/heavy/crisis 分类，保留中文夸张用法用例。分类模块只判定，不做 IO；尚未接入捕获入口。
- `preview_crisis_cleanup` 只检查指定本人知君的原生 namespace，返回危机用户原话 ID、关联候选/事实/日记/摘要等数量与版本，不返回内容、不保存可恢复快照、不删除数据。`purge_ready=False` 明确说明清理尚不能执行。

## 已核实的平台缺口

当前 `uv.lock` 锁定 octop-harness 1.0.0、octop-memory 1.0.0。

1. Harness 的 `memory_capture_enabled`、`memory_extract_on_session_end`、`memory_recall_inject_enabled` 是整个 Agent 的开关。`MemoryMiddleware.after_model` 在约第 337 行安排捕获，约第 484 行的 `_submit_capture` 直接调用 `MemoryService.capture_turn`。没有公开的逐轮捕获/提取策略参数；用户中间件也不能可靠取消已经安排的后台写入。不能用“先写后删”冒充拦截，也不能通过关闭整个 Agent 记忆冒充只拦危机。
2. Harness 的 `MemoryRuntime` 构造 `MemoryService` 时没有传入专家专属抽取配置。即使向原生配置传入 `extraction.promote=False`，`MemoryService.extract` 的显式默认 `promote=True` 仍会传给 runtime。现有 Agent 配置没有单独关闭知君晋升的公开通道；本次不 monkey-patch 该方法。

因此“危机整轮零 RawEvent/Candidate/Atom/Episode”和“重话保存原话但本轮绝不抽取”的运行时验收尚未通过。本地分类测试不替代这项证明。

## 上游接口建议

为 Harness 增加同步、无模型调用的 `memory_turn_policy(context)`，在任何原生捕获写入、JSONL 副本和提取安排之前执行，返回以下策略：

| 策略 | 原话捕获 | 本轮与定时提取 | 后续轮次 |
| --- | --- | --- | --- |
| allow | 允许 | 允许 | 正常 |
| defer | 允许 | 不允许，不能被 idle/session-end 抽走 | 本人后续继续或明确要求记下才释放 |
| deny | 用户与助理整轮均不捕获 | 不允许 | 不得补写或补提取被拒绝轮次 |

同时提供宿主分配的 `turn_id`，让用户原话、助理回复与提取输入可靠关联。策略不能只是 after-model 提示词；同步/异步模型调用、结束会话、idle、interval、工具轮次、异常和恢复路径都必须执行同一决定。专家抽取选项应在 Harness 调用 `extract` 时显式传递 `promote`，而不是仅改一份底层默认配置。

上游接通后，使用固定的恶意提取输出验证：deny 整轮零原生写入；defer 原话可查但所有提取触发均不产生候选或日记，直到后续本人动作。测试同时覆盖后台捕获任务的竞态。

## 历史清理的剩余工作

先阻断未来危机捕获，再在停止该 profile 对话与抽取的窗口内对具体预览版本清理。原生候选、事实、日记、digest、实体页、树节点和审计内容需要按关联移除；已有个人理解、上下文轨迹、维护归档、JSONL、checkpoint 和已导出 Markdown 也可能持有副本，不能只删数据库的 raw 行。现有数据没有可靠的整轮 ID 时，助理回复的关联必须先核对。

清理只能留下不含原文、标题、人名或可恢复 snapshot 的 tombstone。当前预览不表示这些副本已全部发现或删除，也不表示已对真实用户历史执行过清理。

主动关怀的负面情绪加权保持原样，本次不调整。

## 初次记忆边界修复的验证记录

以下保留前一阶段的验证结果。后续判断回访修复已通过全量 `make all`（4,338 passed、17 skipped），见[最新实现与验证](zhijun-decision-notifications-2026-10-02.md)；逐轮危机捕获接口仍未接通。

- 相关单元测试（召回、危机分类/清理预览、profile、关怀、个人理解、维护与 i18n）：197 项通过。
- 附件捕获与跨会话召回集成，以及召回回归：合计 12 项通过。固定提取输出证明自动晋升的未认可助理建议在搜索与详情中均为 `unconfirmed/inference`，来源仍为 `assistant_message`。关怀测试证明不读日记、不调生成模型，网关正文只有固定模板。
- 本次 8 个领域模块的 mypy 检查通过；前端 `npx tsc -b` 与 `make build-frontend` 通过。
- 当时运行 `make all PYTEST_JOBS=4` 未全量通过：附件召回旧入口测试已修复并重新验证，另外 12 个数据库迁移/备份相关失败在单独复跑中仍出现，涉及 schema 预期 22 与当时的 23 不一致，以及旧库缺少 agents 表的修复路径。当时工作区另有团队模块类型/格式问题，该阶段没有扩大到这些正在修改的模块。
- 尚未部署、未执行真实历史清理、未提交或推送。
