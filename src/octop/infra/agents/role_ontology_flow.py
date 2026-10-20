"""Preparation and explicit owner declarations, scoped to one private role workspace."""

from __future__ import annotations

import asyncio
import re
from datetime import UTC, datetime
from typing import Any

from octop.infra.agents.ontology_admission import admitted, pending
from octop.infra.agents.ontology_runtime import OntologyCoordinator
from octop.infra.agents.ontology_types import Kind, PersonalOntology
from octop.infra.agents.personal_ontology import (
    _digest,
    _lock,
    _owned,
    _owned_sources,
    _personal_text,
    _read,
    _save,
    generate_personal_ontology,
)
from octop.infra.agents.zhijun_profile import primary


def fact_reason(
    memory: Any, atom: dict[str, Any], uid: int, doc: PersonalOntology, eligible: dict[str, Any]
) -> str:
    candidate = memory.get_candidate(atom.get("candidate_id")) if memory else None
    event = memory.get_raw(candidate.quote_event_id) if candidate else None
    text = _personal_text(event, uid)
    quote = atom.get("verbatim_quote") or ""
    if not text:
        return "不是可核对的本人原话（可能来自 AI 回复或其他来源），不用于形成理解。"
    if not quote or quote not in text or len(quote) > 800:
        return "无法在本人原话中核对这条引用，暂不用于理解。"
    if atom["id"] in doc.fact_confirmations and not doc.fact_confirmations[atom["id"]].get(
        "atom_hash"
    ):
        return "你已撤回事实确认，不再用于自动整理。"
    if atom["id"] not in eligible:
        return "来源重复、已停用或属于引导表述，保留在记忆中，不重复归纳。"
    if any(admitted(c) and any(e.atom_id == atom["id"] for e in c.evidence) for c in doc.claims):
        return "已作为你确认的理解依据。"
    if any(pending(c) and any(e.atom_id == atom["id"] for e in c.evidence) for c in doc.claims):
        return "已整理为新理解，等你确认理解及其依据。"
    if doc.preparation.outcome in {"no_new_candidates", "candidates_ready"}:
        return "本轮未形成新的长期理解；作为背景记忆保留，避免重复或过度推断。"
    return "可用于自动整理；明确自述可单条成为新理解，推断需多组独立经历。"


async def flow_status(registry: Any, uid: int, doc: PersonalOntology) -> dict[str, Any]:
    row = _owned(registry, uid)
    harness = registry.get_agent(row.agent_id)
    sources, coverage, _ = await _owned_sources(
        harness.workspace, harness._memory_runtime.memory, uid
    )
    count = sum(pending(c) for c in doc.claims)
    outcome = doc.preparation.outcome
    reasons = {
        "idle": "开启后会自动从知君的记忆整理新理解，由你核对并确认。",
        "queued": "已安排整理，新的理解会出现在待确认中。",
        "running": "正在核对来源、整理新理解，不会替你确认。",
        "memory_paused": "知君已关闭记忆，自动整理暂停；重新开启记忆后会继续。",
        "no_sources": "还没有可核对的本人原话；AI 回复、附件引文和已撤回来源不会作为本人证据。",
        "no_new_candidates": "本轮没有新的理解：可能是背景事实、与已有理解重复，或尚不足以归纳长期倾向。",
        "candidates_ready": "新理解已准备好，请核对表述和依据，再决定是否确认。",
        "model_timeout": "模型整理超时，已有内容未改变；可继续聊天，稍后自动重试，也可手动重试。",
        "model_unavailable": "模型暂时未完成整理，已有内容已保留，可重试。",
        "invalid_response": "模型返回的理解或引用未通过校验，未写入新理解，可重试。",
        "stale": "整理期间内容有变化，将基于新版本重新整理。",
    }
    return {
        "enabled": doc.preparation.enabled,
        "status": outcome,
        "message": reasons.get(outcome, reasons["model_unavailable"]),
        "recorded": coverage.total_atoms,
        "eligible": len(sources),
        "excluded": max(0, coverage.total_atoms - len(sources)),
        "independent_events": coverage.independent_events,
        "pending": count,
        "admitted": sum(admitted(c) for c in doc.claims),
        "checked_at": doc.preparation.checked_at,
        "new_candidates": doc.preparation.new_candidates,
    }


async def request_preparation(registry: Any, uid: int, aid: str, *, retry: bool = False) -> None:
    from octop.infra.agents.role_ontology import agent_scope

    with agent_scope(registry, uid, aid):
        if not primary(registry.get_row(aid)):
            return
        workspace = registry.get_agent(aid).workspace
        async with _lock(registry, aid):
            doc = await _read(workspace)
            if not doc.preparation.enabled:
                doc.preparation.enabled = True
                doc.preparation.outcome = "queued"
                await _save(workspace, doc)
        coordinator = registry.ontology
        job = coordinator.jobs.get(aid)
        if job is None or job.done():
            coordinator.jobs[aid] = asyncio.create_task(
                prepare_role(registry, uid, aid, retry=retry)
            )


async def prepare_role(registry: Any, uid: int, aid: str, *, retry: bool = False) -> None:
    from octop.infra.agents.role_ontology import agent_scope

    with agent_scope(registry, uid, aid):
        if not primary(registry.get_row(aid)):
            return
        harness = registry.get_agent(aid)
        doc = await _read(harness.workspace)
        if not doc.preparation.enabled or registry.is_agent_active(aid):
            return
        row = registry.get_row(aid)
        config: dict[str, Any] = getattr(registry, "_agent_config_dict", lambda _: {})(row)
        if config.get("memory", {}).get("memory_enabled") is False:
            if doc.preparation.outcome != "memory_paused":
                async with _lock(registry, aid):
                    doc = await _read(harness.workspace)
                    doc.preparation.outcome = "memory_paused"
                    await _save(harness.workspace, doc)
            return
        gate = _lock(registry, "prepare:" + aid)
        if gate.locked():
            return
        async with gate:
            try:
                sources, _, fingerprint = await _owned_sources(
                    harness.workspace, harness._memory_runtime.memory, uid
                )
                fingerprint = "role-flow-v1:" + fingerprint
                last = doc.preparation
                # Do not re-spend tokens for unchanged material; recover interrupted jobs.
                if not retry and last.fingerprint == fingerprint:
                    if last.outcome in {"no_sources", "no_new_candidates", "candidates_ready"}:
                        return
                    if (
                        last.checked_at
                        and (
                            datetime.now(UTC) - datetime.fromisoformat(last.checked_at)
                        ).total_seconds()
                        < 300
                    ):
                        return
                async with _lock(registry, aid):
                    doc = await _read(harness.workspace)
                    doc.preparation.fingerprint = fingerprint
                    doc.preparation.outcome = "running" if sources else "no_sources"
                    doc.preparation.checked_at = datetime.now(UTC).isoformat()
                    doc.preparation.new_candidates = 0
                    await _save(harness.workspace, doc)
                if not sources:
                    return
                before = {c.id for c in doc.claims}
                result = await generate_personal_ontology(
                    registry, uid, doc.revision, incremental=True
                )
                async with _lock(registry, aid):
                    latest = await _read(harness.workspace)
                    added = sum(c.id not in before and pending(c) for c in latest.claims)
                    outcome = (
                        ("candidates_ready" if added else "no_new_candidates")
                        if result.status == "ready"
                        else result.reason
                        or {"insufficient": "no_sources", "stale": "stale"}.get(
                            result.status, "model_unavailable"
                        )
                    )
                    latest.preparation.outcome = outcome
                    latest.preparation.new_candidates = added
                    latest.preparation.checked_at = datetime.now(UTC).isoformat()
                    # Retry version races on the next tick, rather than mark processed.
                    if outcome == "stale" or latest.coverage.has_more:
                        latest.preparation.fingerprint = ""
                    await _save(harness.workspace, latest)
            except asyncio.CancelledError:
                raise
            except Exception:
                async with _lock(registry, aid):
                    latest = await _read(harness.workspace)
                    latest.preparation.outcome = "model_unavailable"
                    latest.preparation.checked_at = datetime.now(UTC).isoformat()
                    await _save(harness.workspace, latest)


# Deliberately conservative: a bare "yes/put this in ontology" has no bound target.
# Neither assistant output, attachments, quotes nor hypothetical text grants consent.
def explicit_declaration(text: str) -> str | None:
    if len(text) > 1200 or re.search(
        r'^(?:请)?(?:分析|翻译|转述|解释|测试|演示)|[？?“”「」"`]|假设|假如|例如|比如|他说|她说|别人说|不要.{0,12}(本体|记住)|别.{0,8}(本体|记住)|不.{0,5}(确认|纳入|加入)|[\r\n]|\[(?:上传资料|Uploaded material)\]',
        text,
    ):
        return None
    text = re.sub(r"^知君[，,：:\s]+", "", text.strip())
    patterns = [
        r"(?:请)?(?:把|将)?(?:这条|这点|这项|这句话|以下内容)?(?:可以)?(?:纳入|加入|放进|记入|进入|进)本体[：:,，\s]*(.+)",
        r"(.+?)[，,。；;\s]*(?:请)?(?:把|将)?(?:这条|这点|这项|这句话)?(?:可以)?(?:纳入|加入|放进|记入|进入|进)本体[。！!\s]*",
        r"(?:请)?记住[：:,，\s]+(.+)",
    ]
    for pattern in patterns:
        match = re.fullmatch(pattern, text.strip())
        if not match:
            continue
        statement = re.sub(r"^(?:我确认|我明确确认|我确定)[：:,，\s]*", "", match[1]).strip(
            " ，,。；;：:"
        )
        if (
            4 <= len(statement) <= 400
            and re.search(r"我|本人", statement)
            and not re.search(r"本体|记住|确认一下|是否|能否", statement)
        ):
            transient = re.search(
                r"今天|此刻|刚刚|这会儿|现在很|今晚|昨天|我(?:很|有点|觉得)?(?:难受|失落|疲惫|累|烦|难过|焦虑|开心)",
                statement,
            )
            enduring = re.search(r"原则|底线|一直|长期|经常|希望你|不要对我", statement)
            if transient and not enduring:
                return None
            return statement
    return None


async def capture_declaration(
    registry: Any, uid: int, aid: str, tid: str, turn_id: str, text: str
) -> dict[str, Any] | None:
    """Called with server-bound current HumanMessage, never client-supplied ownership."""
    from octop.infra.agents.role_ontology import RoleCommand, command

    if _owned(registry, uid).agent_id != aid:
        from octop.infra.errors import ErrorCode, OctopError

        raise OctopError.localized(ErrorCode.NOT_FOUND)
    statement = explicit_declaration(text)
    if not statement:
        if re.search(r"本体|记住", text):
            return {
                "status": "needs_review",
                "message": "我会先听你说。若要确认一项长期理解，请完整说出表述，或核对下方的新理解；短期感受不会自动成为长期理解。",
            }
        return None
    kind: Kind
    if re.search(r"希望你|请你|听我说|听我讲", statement):
        kind = "response"
    elif re.search(r"核心|在乎|重视|优先", statement):
        kind = "value"
    elif re.search(r"我是|我的身份|我的定位", statement):
        kind = "identity"
    elif re.search(r"希望|想成为|目标|重点.*做", statement):
        kind = "aspiration"
    elif re.search(r"回应|听我|追问|建议", statement):
        kind = "response"
    else:
        kind = "principle"
    request_id = "chat:" + _digest([aid, uid, tid, turn_id, text])
    gate = _lock(registry, "declaration:" + aid)
    async with gate:
        workspace = registry.get_agent(aid).workspace
        doc = await _read(workspace)
        receipt = doc.core_operations.get(request_id)
        if receipt:
            claim = next((c for c in doc.claims if c.id == receipt["id"]), None)
            return {
                "status": "admitted" if claim and admitted(claim) else "changed",
                "statement": statement,
                "id": receipt["id"],
            }
        same = next((c for c in doc.claims if admitted(c) and c.statement == statement), None)
        if same:
            return {"status": "admitted", "statement": statement, "id": same.id}
        result = await command(
            registry,
            uid,
            "new",
            RoleCommand(
                action="add_admit",
                request_id=request_id,
                expected_version=doc.revision,
                statement=statement,
                kind=kind,
            ),
            declaration={"turn_id": turn_id, "thread_id": tid, "text": text},
        )
        if result["status"] != "ready":
            return {
                "status": "needs_review",
                "message": "内容刚刚发生变化，本次没有写入，请重新确认。",
            }
        return {"status": "admitted", "statement": statement, "id": result["changed_id"]}


class RoleOntologyCoordinator(OntologyCoordinator):
    """Keep the existing worker lifecycle and legacy profile processing unchanged."""

    async def tick(self) -> None:
        await super().tick()
        for row in self.registry.list_rows():
            if not primary(row) or not row.enabled:
                continue
            job = self.jobs.get(row.agent_id)
            if job is None or job.done():
                self.jobs[row.agent_id] = asyncio.create_task(
                    prepare_role(self.registry, row.user_id, row.agent_id)
                )
