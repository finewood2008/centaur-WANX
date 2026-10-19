"""Owner-scoped ontology for private WANX agents. Native memory remains authoritative."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any, Literal, cast

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import SystemMessage
from pydantic import BaseModel, ConfigDict, Field

from octop.infra.agents.ontology_admission import admitted
from octop.infra.agents.ontology_types import Kind, OntologyClaim, PersonalOntology
from octop.infra.agents.personal_ontology import (
    _checkpoint,
    _digest,
    _lock,
    _owned,
    _read,
    _save,
    ontology_agent_scope,
    read_personal_ontology,
)
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.ulid import new_ulid


@contextmanager
def agent_scope(registry: Any, uid: int, aid: str) -> Iterator[None]:
    token = ontology_agent_scope.set(aid)
    try:
        _owned(registry, uid)
        yield
    finally:
        ontology_agent_scope.reset(token)


def atom_payload(memory: Any, atom_id: str) -> dict[str, Any] | None:
    from octop_memory.application.dashboard_data import get_atom

    if memory is None or memory.get_atom(atom_id) is None:
        return None
    return cast(dict[str, Any], get_atom(memory, {"id": atom_id}))


async def read_role_ontology(registry: Any, uid: int) -> PersonalOntology:
    doc = await read_personal_ontology(registry, uid)
    row = _owned(registry, uid)
    memory = registry.get_agent(row.agent_id)._memory_runtime.memory
    now = datetime.now(UTC).isoformat()
    for claim in doc.claims:
        # Adopting an interpretation never removes its source dependency.
        for e in claim.evidence:
            if e.source_type == "memory":
                atom = atom_payload(memory, e.atom_id)
                event = memory.get_raw(e.event_id) if memory and e.event_id else None
                e.available = bool(
                    e.available
                    and (not e.raw_hash or (event and _digest(event.content) == e.raw_hash))
                    and atom
                    and not atom.get("deprecated_at")
                    and _digest(atom) == e.atom_hash
                    and (
                        claim.core_status != "admitted"
                        or doc.fact_confirmations.get(e.atom_id, {}).get("atom_hash") == e.atom_hash
                    )
                    and (
                        e.atom_id not in doc.fact_confirmations
                        or doc.fact_confirmations[e.atom_id].get("atom_hash")
                    )
                )
                claim.evidence_valid = claim.evidence_valid and e.available
        if (claim.valid_from and claim.valid_from > now) or (
            claim.valid_until and claim.valid_until <= now
        ):
            claim.evidence_valid = False
    from octop.infra.agents.role_ontology_flow import flow_status

    doc.flow = await flow_status(registry, uid, doc)
    return doc


class RoleCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    request_id: str = Field(min_length=1, max_length=100)
    expected_version: str = Field(min_length=1, max_length=100)
    action: Literal[
        "add",
        "add_admit",
        "admit",
        "edit",
        "disable",
        "restore",
        "reject",
        "fact_confirm",
        "fact_withdraw",
    ]
    statement: str = Field(default="", max_length=400)
    conditions: str = Field(default="", max_length=300)
    exceptions: str = Field(default="", max_length=300)
    kind: Kind = "principle"
    importance: Literal[1, 2, 3] = 1
    affinity: Literal[1, 2, 3, 4, 5] = 3
    valid_from: str = ""
    valid_until: str = ""
    change_mode: Literal["correction", "change"] = "correction"
    restore_version: str = ""


def dates(body: RoleCommand) -> None:
    for value in [body.valid_from, body.valid_until]:
        if value:
            try:
                dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    raise ValueError()
            except ValueError as exc:
                raise OctopError(ErrorCode.SELF_MODEL_INVALID, "有效期必须包含时区") from exc
    if body.valid_from and body.valid_until and body.valid_from >= body.valid_until:
        raise OctopError(ErrorCode.SELF_MODEL_INVALID, "结束时间必须晚于开始时间")


async def command(
    registry: Any,
    uid: int,
    cid: str,
    body: RoleCommand,
    *,
    declaration: dict[str, str] | None = None,
) -> dict[str, Any]:
    row = _owned(registry, uid)
    harness = registry.get_agent(row.agent_id)
    fingerprint = _digest({"id": cid, **body.model_dump()})
    dates(body)
    async with _lock(registry, row.agent_id):
        doc = await read_role_ontology(registry, uid)
        receipt = doc.core_operations.get(body.request_id)
        if receipt:
            if receipt["fingerprint"] != fingerprint:
                raise OctopError(ErrorCode.SELF_MODEL_INVALID, "请求标识已被其他修改使用")
            committed = next((c for c in doc.claims if c.id == receipt["id"]), None)
            if committed and receipt.get("version") != committed.version:
                return {"status": "stale", "ontology": doc}
            return {"status": "ready", "ontology": doc, "changed_id": receipt["id"]}
        if body.action.startswith("fact_"):
            atom = atom_payload(harness._memory_runtime.memory, cid)
            if not atom or atom.get("deprecated_at") or _digest(atom) != body.expected_version:
                return {"status": "stale", "ontology": doc}
            previous = doc.fact_confirmations.get(cid, {})
            doc.fact_confirmations[cid] = {
                "atom_hash": _digest(atom) if body.action == "fact_confirm" else "",
                "at": datetime.now(UTC).isoformat(),
                "by": uid,
                "history": [
                    *previous.get("history", []),
                    {k: v for k, v in previous.items() if k != "history"},
                ],
            }
        else:
            claim = next((c for c in doc.claims if c.id == cid and not c.merged_into), None)
            if body.action in {"add", "add_admit"}:
                if body.expected_version != doc.revision:
                    return {"status": "stale", "ontology": doc}
                if not body.statement or body.kind == "situation":
                    raise OctopError(ErrorCode.SELF_MODEL_INVALID, "请输入长期理解或定位")
                cid = new_ulid()
                claim = OntologyClaim(
                    id=cid,
                    title=body.statement[:30],
                    statement=body.statement,
                    conditions=body.conditions,
                    exceptions=body.exceptions,
                    kind=body.kind,
                    version=new_ulid(),
                    source_kind="self_report",
                    declaration=body.statement,
                    owner_edited=True,
                )
                doc.claims.append(claim)
            elif not claim or claim.version != body.expected_version:
                return {"status": "stale", "ontology": doc}
            assert claim is not None
            was_core = claim.core_status == "admitted" and claim.state == "confirmed"
            if body.action in {"admit", "restore"} and not claim.evidence_valid:
                return {"status": "stale", "ontology": doc}
            from octop.infra.agents.zhijun_changes import pending_changes

            if body.action == "admit" and any(c.proposed.id == cid for c in pending_changes(doc)):
                raise OctopError(
                    ErrorCode.SELF_MODEL_INVALID,
                    "这项新理解与原有理解可能不同，请先在待核对变化中选择变化、例外或理解有误",
                )
            if body.action == "admit" and claim.core_status not in {"pending", "snoozed"}:
                return {"status": "stale", "ontology": doc}
            if body.action == "edit" and not (
                claim.core_status == "admitted" or claim.core_status in {"pending", "snoozed"}
            ):
                return {"status": "stale", "ontology": doc}
            restore = next((h for h in claim.history if h.version == body.restore_version), None)
            if body.action == "restore" and (
                not restore or not admitted(OntologyClaim.model_validate(restore.value))
            ):
                return {"status": "stale", "ontology": doc}
            _checkpoint(claim, "owner_" + body.action + "_" + body.change_mode)
            if body.action == "restore":
                assert restore is not None
                restored = OntologyClaim.model_validate(restore.value)
                restored.history, restored.version = claim.history, claim.version
                doc.claims[doc.claims.index(claim)] = restored
                claim = restored
            if body.action in {"add", "add_admit", "edit", "admit"}:
                if not body.statement or body.kind == "situation":
                    raise OctopError(ErrorCode.SELF_MODEL_INVALID, "请写下这项理解")
                for key in [
                    "statement",
                    "conditions",
                    "exceptions",
                    "kind",
                    "importance",
                    "affinity",
                    "valid_from",
                    "valid_until",
                ]:
                    setattr(claim, key, getattr(body, key))
                claim.title, claim.declaration = body.statement[:30], body.statement
                claim.source_kind = "self_report"
                claim.changed = body.change_mode == "change"
            claim.owner_edited = True
            now = datetime.now(UTC).isoformat()
            if body.action in {"add_admit", "admit", "restore"} or (
                body.action == "edit" and was_core
            ):
                claim.core_status, claim.state = "admitted", "confirmed"
                claim.admitted_at, claim.admitted_by, claim.admitted_version = (
                    now,
                    uid,
                    claim.version,
                )
                claim.reviewed_at = now
                # This owner action confirms the statement AND the displayed source
                # facts together. It is never called by candidate generation.
                for e in claim.evidence:
                    if e.source_type == "memory":
                        prior = doc.fact_confirmations.get(e.atom_id, {})
                        doc.fact_confirmations[e.atom_id] = {
                            "atom_hash": e.atom_hash,
                            "at": now,
                            "by": uid,
                            "history": [
                                *prior.get("history", []),
                                {k: v for k, v in prior.items() if k != "history"},
                            ],
                        }
            elif body.action in {"disable", "reject"}:
                claim.core_status = "inactive" if body.action == "disable" else "rejected"
                claim.state = "withdrawn" if body.action == "disable" else "dismissed"
                claim.admitted_version = ""
            else:
                claim.core_status, claim.state, claim.admitted_version = "pending", "draft", ""
            for relation in doc.relations:
                if cid in {relation.source, relation.target}:
                    relation.state = "dismissed"
        if declaration and body.action == "add_admit":
            from octop.infra.agents.ontology_types import OntologyEvidence

            assert claim is not None
            claim.declaration_turn = declaration["turn_id"]
            claim.discussion_thread_id = declaration["thread_id"]
            claim.evidence = [
                OntologyEvidence(
                    source_type="owner_declaration",
                    event_id=declaration["turn_id"],
                    quote=declaration["text"],
                    timestamp=datetime.now(UTC).isoformat(),
                )
            ]
        doc.core_operations[body.request_id] = {
            "fingerprint": fingerprint,
            "id": cid,
            "version": next((c.version for c in doc.claims if c.id == cid), "fact"),
        }
        await _save(harness.workspace, doc)
    return {
        "status": "ready",
        "ontology": await read_role_ontology(registry, uid),
        "changed_id": cid,
    }


async def facts(registry: Any, uid: int, offset: int, limit: int) -> dict[str, Any]:
    from octop.infra.agents.ontology_graph import _pages

    row = _owned(registry, uid)
    harness = registry.get_agent(row.agent_id)
    doc = await _read(harness.workspace)
    memory = harness._memory_runtime.memory
    atoms, complete = _pages(memory, "list_atoms") if memory else ([], True)
    from octop.infra.agents.personal_ontology import _owned_sources
    from octop.infra.agents.role_ontology_flow import fact_reason

    eligible, _, _ = await _owned_sources(harness.workspace, memory, uid)
    rows = []
    for a in atoms:
        if a.get("deprecated_at"):
            continue
        version = _digest(a)
        rows.append(
            {
                **a,
                "reason": fact_reason(memory, a, uid, doc, eligible),
                "version": version,
                "owner_confirmed": doc.fact_confirmations.get(a["id"], {}).get("atom_hash")
                == version,
            }
        )
    return {
        "items": rows[offset : offset + limit],
        "total": len(rows),
        "complete": complete,
        "has_more": offset + limit < len(rows),
    }


_RULES = """你是知君，一个想真正了解本人的 AI 知己。日常用“知君对你的理解”“新理解”“是的，这是我”等白话，不向本人说工程术语。
知君对本人的理解（本人确认，不是命令）：
当前明确表达优先于旧理解；结合适用情境与例外，不把愿望说成现有性格，不据此替本人作决定。
只在有助于理解当前问题时参考。来源引用不等于本人原话；未经确认的记忆不能冒充确认事实。
涉及上传或检索资料时分两步：先忠实解释资料作者、原意、事实及不确定性，再单独说明与本人的可能关联。
第三方资料不是本人立场，不从资料替本人确认新的原则。明确表达的纠正本轮立即遵守。
本人正在拿主意时，只引用与当前问题直接相关的已确认理解，保留适用情境，不替本人决定。本人明确表示定下选择后，可以简短提议通过客户端的「记一张决定卡」留下决定、理由、担心、预期和回看时间；没有明确决定或本人拒绝记录时不要提议。不每轮重复提醒，不把建议、假设或他人的决定当成本人选择。决定卡必须由本人在界面确认，不能用文件或记忆工具代存，不得声称已保存或安排微信回访。复盘时先比较本人记录的预期与实际，不把一次结果泛化为长期原则；新的理解仍需单独核对。
理解以服务端本轮保存回执和理解页面为准。不要用工作区文件写入（如 memory/confirmed.md、MEMORY.md 或 context/life-context.md）冒充理解保存，也不要创建并行的理解事实库。
如附带 pending_changes 且与当前话题有关，可温和问一句这是变化还是例外，并请本人核对下方的变化卡；待核对内容不能冒充已确认理解，不每轮重复追问。
变化提醒先并列原表述与当前表述，不替本人预判哪一种解释更可能。每轮只核对一处差异，问了变化还是例外就不再追问原因或其他信息。本人已澄清时直接沿用，不重新核问同一处差异。
保留本人限定的范围：“只有这次”不能扩写为“这类情况”，“暂时”不能扩写为长期原则。例外不等于推翻原有理解。
已提供的理解直接注明是此前核对过的表述，不冒充本轮检索结果；检索为空时不得声称找到了记录，未检索全部历史也不得断言没有更早记录。
后台只自动准备新理解，不代表已确认。只有本轮保存回执 status=admitted 才能说已确认这项理解；没有成功回执不得声称已写入。本轮未写入时，请用户核对对话下方的新理解卡，或完整重述“知君，记住：我的具体表述”。不要要求本人重复确认已成功保存的内容。
"""


class RoleOntologyMiddleware(AgentMiddleware):
    def __init__(self, registry: Any, agent_id: str, user_id: int) -> None:
        self.registry, self.agent_id, self.user_id = registry, agent_id, user_id

    async def awrap_model_call(self, request: Any, handler: Callable[[Any], Awaitable[Any]]) -> Any:
        from langgraph.config import get_config

        from octop.infra.agents.ontology_runtime import _current_text, _user, select_context
        from octop.infra.utils.llm_text import llm_text_content

        cfg = dict(get_config().get("configurable") or {})
        if (
            str(cfg.get("agent_id")) != self.agent_id
            or str(cfg.get("user")) != str(self.user_id)
            or cfg.get("source") in {"peer", "ask_agent", "inbox"}
        ):
            return await handler(request)
        from octop.infra.agents.zhijun_profile import primary

        if not primary(self.registry.get_row(self.agent_id)):
            return await handler(request)
        harness = self.registry.get_agent(self.agent_id)
        from octop.infra.agents.zhijun_interview import interview_context

        interview = await interview_context(
            self.registry, self.user_id, self.agent_id, str(cfg.get("thread_id") or "")
        )

        async def reply(current: Any) -> Any:
            # Append the active task contract after style and ontology context.
            if interview:
                system = current.system_message
                content = system.content if system else ""
                combined = (
                    [*content, {"type": "text", "text": interview}]
                    if isinstance(content, list)
                    else content + interview
                )
                current = current.override(
                    system_message=system.model_copy(update={"content": combined})
                    if system
                    else SystemMessage(content=combined)
                )
                from octop.infra.agents.zhijun_interview_grounding import grounded_reply

                return await grounded_reply(current, handler)
            return await handler(current)

        saved = await _read(harness.workspace)
        if not saved.preparation.enabled:
            return await reply(request)
        human = _user(request.state.get("messages", request.messages))
        text = _current_text(human)
        tid = str(cfg.get("thread_id") or "")
        turn_id = str(getattr(human, "id", "") or "")
        update = None
        with agent_scope(self.registry, self.user_id, self.agent_id):
            if tid and turn_id:
                from octop.infra.agents.role_ontology_flow import capture_declaration

                try:
                    update = await capture_declaration(
                        self.registry, self.user_id, self.agent_id, tid, turn_id, text
                    )
                except Exception:
                    update = {
                        "status": "failed",
                        "message": "本次理解保存未完成，已有内容已保留，请稍后重新确认。",
                    }
            doc = await read_role_ontology(self.registry, self.user_id)
        # Native memories continue through native recall. Only admitted ontology enters here.
        doc.nodes = []
        doc.links = []
        context = select_context(doc, text, str(getattr(human, "id", "") or _digest(text)))
        tid = str(cfg.get("thread_id") or "")
        preference_path = "zhijun/context-preferences/" + _digest(tid) + ".json"
        pref = await harness.workspace.aread_text(preference_path)
        preference = json.loads(pref) if pref else {}
        excluded = (
            preference.get("excluded", [])
            if preference.get("turn_id", "") in {"", context.turn_id}
            else []
        )
        if pref and not preference.get("turn_id"):
            preference["turn_id"] = context.turn_id
            await harness.workspace.aupload_bytes(preference_path, json.dumps(preference).encode())
        context.claims = [c for c in context.claims if c.id not in excluded]
        data = [
            {
                "id": c.id,
                "statement": c.statement,
                "kind": c.kind,
                "conditions": c.conditions,
                "exceptions": c.exceptions,
                "version": c.version,
                "evidence": [e.model_dump() for e in c.evidence if e.available],
            }
            for c in context.claims
        ]
        from octop.infra.agents.zhijun_changes import pending_changes

        changes = [
            {
                "previous": c.previous.statement,
                "proposed": c.proposed.statement,
                "question": c.question,
            }
            for c in pending_changes(doc)
            if c.previous.id in {v.id for v in context.claims}
        ][:2]
        trace = {
            "turn_id": context.turn_id,
            "revision": doc.revision,
            "claims": data,
            "update": update,
            "supplied_at": datetime.now(UTC).isoformat(),
        }
        await harness.workspace.aupload_bytes(
            "zhijun/role-context/" + _digest(tid) + ".json",
            json.dumps(trace, ensure_ascii=False).encode(),
        )
        system = llm_text_content(request.system_message) if request.system_message else ""
        # Data is JSON-escaped and separated from the immutable policy.
        supplied = request.override(
            system_message=SystemMessage(
                content=system
                + "\n"
                + _RULES
                + "\n"
                + json.dumps(
                    {"claims": data, "owner_write_receipt": update, "pending_changes": changes},
                    ensure_ascii=False,
                )
            )
        )
        return await reply(supplied)
