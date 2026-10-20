# Current private companion decisions and reviews

The current WANX primary-companion contract is `/api/agents/{agent_id}/ontology/decisions`, with read-only list, explicit `propose`, and versioned/idempotent owner commands for confirm, review, reschedule and archive. It is separate from the legacy `/api/zhijun/decisions` and preserves that decision book untouched.

## Data

`PersonalOntology.decisions` and `decision_operations` default empty; no automatic scan, import, DB migration or old-role merge. A confirmed decision stores owner text, rationale, concerns, expectation, optional date, source thread/hash and immutable snapshots of explicitly selected admitted understandings. Reviews append immutable entries; the original fields do not change. State/date changes retain history. Archive stops local due prompts while retaining records.

Review-derived understanding is a pending self-report with a `decision_review` evidence reference to the exact recorded review and a support/change relation to the selected current understanding. Changes/exception resolution uses the existing explicit owner flow. Each read validates the review and all prior material/native evidence; recording a review is not admission. Support does not automatically change confidence or the original principle.

## Runtime and boundaries

- Private primary owner only, no admin bypass or client-supplied owner/expert/prompt override.
- Uses harness workspace and the existing per-agent ontology lock, verified persistence and durable request receipt. Stale record/source/understanding rejects rather than overwrites.
- Busy-agent reservation prevents saving or generating across an active reply. Release occurs even on error.
- Proposal explicitly requested by owner: server history, latest 30 messages, complete owner turns up to 12000 characters. Model receives no assistant text, other thread or existing understanding. Every nonempty field must be a contiguous owner excerpt; semantic commitment/attribution still requires owner review.
- Generation never persists a draft or executes decisions. Confirmation revalidates source hash and linked understanding versions.
- Local due dates follow `default_timezone`; no new scheduler, WeChat binding, notification channel, outbound message or care permission.
- Original chats, knowledge files, native memory and legacy role stores are not mutated.

## Validation

New unit tests in `tests/unit/agents/test_companion_decisions.py`; isolated HTTP test in `tests/integration/test_companion_decisions.py`. Coverage includes actual source/owner boundaries, failed and ambiguous writes, repeat requests, stale views, pending-only review effects, original snapshot preservation and combined material/review evidence validity. HTTP tests inspect OpenAPI summaries, descriptions and schemas.

Real-model acceptance uses eight synthetic scenarios twice: explicit choice, uncertainty, hypothetical, third party, fiction, refusal to record, changed decision and prompt injection. Final 16/16 expected results; original personal data unchanged across the run. An initial assertion wrongly required an explicit reason to be blank in the changed-decision case; corrected the evaluator and reran all cases without changing the production prompt.

Local client server/UI/desktop suites passed 129/109/22, and build passed. Full backend regression and native UI observations are recorded in the local delivery receipt; this is not publication.

最终本地验收：后端 `make all` 4,817 通过、17 跳过；类型检查 648 源文件通过。已实际打开本机知君并检查新入口及空白草稿表单，真实账号零新增决定。升级前备份 262 文件与 17 个数据库，重启后仅登录审计/启动时间变化，个人内容保留。本次仅交付 CodeUp 开发分支，不发布。
