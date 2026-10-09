"""Reviewed digital selves: publication-only inference, never the private harness."""

from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import UTC, datetime
from typing import Any, Literal, NoReturn
from zoneinfo import ZoneInfo

from langchain_core.messages import HumanMessage, SystemMessage

from octop.i18n import tr
from octop.infra.agents.application import application_id
from octop.infra.agents.digital_self_types import (
    AccessCommand,
    DiscoveryPage,
    HistoryCommand,
    HistoryPage,
    PreviewTurn,
    PublishedEntry,
    RelationshipFact,
    SelfAccess,
    SelfCard,
    SelfCommand,
    SelfDraft,
    SelfEntry,
    SelfPublication,
    SelfReply,
    SelfSource,
    SelfState,
    SourcePage,
    VisitorHistory,
    VisitorMessage,
    VisitorRequest,
    VisitorTurn,
)
from octop.infra.agents.knowledge_understanding import _knowledge, _model
from octop.infra.agents.personal_ontology import read_personal_ontology
from octop.infra.agents.zhijun import get_profile
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.llm_text import ainvoke_text
from octop.infra.utils.ulid import new_ulid

_STATE = "zhijun/digital-self/state.json"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()


def _error(reason: str) -> NoReturn:
    raise OctopError.localized(ErrorCode[f"DIGITAL_SELF_{reason.upper()}"])


def _revision(actual: str, expected: str) -> None:
    if actual != expected:
        raise OctopError.localized(ErrorCode.DIGITAL_SELF_CONFLICT)


def _lock(registry: Any, key: str) -> asyncio.Lock:
    if not hasattr(registry, "_digital_self_locks"):
        registry._digital_self_locks = {}
    return registry._digital_self_locks.setdefault(key, asyncio.Lock())  # type: ignore[no-any-return]


def _owned(registry: Any, uid: int) -> Any:
    row = get_profile(registry, uid)
    if row is None or row.user_id != uid or application_id(row) != "zhijun":
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    return row


def _workspace(registry: Any, row: Any) -> Any:
    workspace = registry.workspace_for_agent(row.agent_id)
    if workspace is None:
        _error("offline")
    return workspace


async def _load(workspace: Any) -> SelfState:
    text = await workspace.aread_text(_STATE)
    return SelfState.model_validate_json(text) if text else SelfState()


async def _write(workspace: Any, path: str, value: Any) -> None:
    text = value.model_dump_json()
    await workspace.aupload_bytes(path, text.encode())
    if await workspace.aread_text(path) != text:
        _error("write_unknown")


async def _save(workspace: Any, state: SelfState) -> SelfState:
    state.id = state.id or new_ulid()
    state.revision = new_ulid()
    await _write(workspace, _STATE, state)
    return await _load(workspace)


async def read_self(registry: Any, uid: int) -> SelfState:
    return await _load(_workspace(registry, _owned(registry, uid)))


async def source_page(
    registry: Any,
    uid: int,
    kind: Literal["ontology", "memory", "episode", "knowledge"],
    offset: int = 0,
    kb_id: str = "",
    document_id: str = "",
    start: int = 0,
) -> SourcePage:
    row = _owned(registry, uid)
    harness = registry.get_agent(row.agent_id)
    if kind == "ontology":
        doc = await read_personal_ontology(registry, uid)
        claims = [c for c in doc.claims if c.state in {"confirmed", "draft"} and c.evidence_valid]
        return SourcePage(
            items=[
                SelfSource(
                    kind="ontology",
                    id=c.id,
                    version=c.version,
                    title=c.title,
                    text=f"{c.statement}\n适用情境：{c.conditions}\n例外：{c.exceptions}\n时间：{c.time_scope}",
                    needs_review=c.state != "confirmed" and c.source_kind != "self_report",
                )
                for c in claims[offset : offset + 20]
            ],
            has_more=len(claims) > offset + 20,
        )
    if kind in {"memory", "episode"}:
        from octop_memory.application.dashboard_data import list_atoms, list_episodes

        memory = harness._memory_runtime.memory
        if memory is None:
            _error("source_unavailable")
        page = await asyncio.to_thread(
            list_atoms if kind == "memory" else list_episodes,
            memory,
            {"offset": offset, "limit": 20, "include_deprecated": False},
        )
        items = []
        for item in page["items"]:
            text = str(item.get("assertion") or item.get("summary") or "")
            quote = str(item.get("verbatim_quote") or "")
            if quote and quote != text:
                text += "\n原话：" + quote
            if not text:
                continue
            items.append(
                SelfSource(
                    kind="memory" if kind == "memory" else "episode",
                    id=item["id"],
                    version=_hash(item),
                    title=text[:100],
                    text=text[:6000],
                    needs_review=True,
                )
            )
        return SourcePage(items=items, has_more=page["has_more"])
    service = _knowledge(registry)
    bases = await asyncio.to_thread(service.list_visible_bases, actor_user_id=uid)
    owned = [b for b in bases if b.owner_user_id == uid]
    libraries = [{"id": b.id, "name": b.name} for b in owned]
    if not kb_id:
        return SourcePage(items=[], libraries=libraries)
    if kb_id not in {b.id for b in owned}:
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    if document_id:
        page_text = await asyncio.to_thread(
            service.read_document_text_page,
            kb_id,
            document_id,
            actor_user_id=uid,
            start=start,
            limit=6000,
        )
        if not page_text.get("text") or page_text.get("status") != "ready":
            _error("source_unavailable")
        return SourcePage(
            items=[
                SelfSource(
                    kind="knowledge",
                    id=f"{kb_id}:{document_id}:{start}",
                    version=page_text["source_version"],
                    title=f"{page_text['filename']} · {start}–{page_text['end']}",
                    text=page_text["text"],
                    needs_review=True,
                    total_chars=page_text["total_chars"],
                    next_start=page_text["end"] if page_text["has_more"] else None,
                )
            ],
            libraries=libraries,
        )
    documents = await asyncio.to_thread(service.list_documents, kb_id, actor_user_id=uid)
    files = [d for d in documents if not d.is_dir]
    items = []
    for document in files[offset : offset + 20]:
        if document.status != "ready":
            continue
        page_text = await asyncio.to_thread(
            service.read_document_text_page,
            kb_id,
            document.id,
            actor_user_id=uid,
            start=0,
            limit=6000,
        )
        if page_text.get("text") and page_text.get("status") == "ready":
            items.append(
                SelfSource(
                    kind="knowledge",
                    id=f"{kb_id}:{document.id}:0",
                    version=page_text["source_version"],
                    title=document.filename,
                    text=page_text["text"],
                    needs_review=True,
                    total_chars=page_text["total_chars"],
                    next_start=page_text["end"] if page_text["has_more"] else None,
                )
            )
    return SourcePage(items=items, has_more=len(files) > offset + 20, libraries=libraries)


async def _source_valid(registry: Any, uid: int, source: SelfSource) -> bool:
    if source.kind == "statement":
        return False
    try:
        if source.kind == "knowledge":
            kb, document, start = source.id.split(":")
            page = await source_page(
                registry, uid, "knowledge", kb_id=kb, document_id=document, start=int(start)
            )
            items = page.items
        else:
            items = []
            offset = 0
            while True:
                page = await source_page(registry, uid, source.kind, offset)
                items.extend(page.items)
                if any(s.id == source.id for s in page.items) or not page.has_more:
                    break
                offset += 20
        return any(
            s.id == source.id
            and s.version == source.version
            and s.text == source.text
            and s.needs_review == source.needs_review
            for s in items
        )
    except (ValueError, LookupError, OctopError):
        return False


async def _check_sources(registry: Any, uid: int, draft: SelfDraft) -> None:
    if len({e.id for e in draft.entries}) != len(draft.entries):
        _error("invalid_draft")
    if any(len(t) > 60 for t in [*draft.topics, *draft.questions]):
        _error("invalid_draft")
    for entry in draft.entries:
        if (
            entry.recognized
            and entry.source
            and entry.source.kind == "ontology"
            and entry.source.needs_review
            and entry.text == entry.source.text
        ):
            _error("invalid_draft")
        if entry.source and not await _source_valid(registry, uid, entry.source):
            _error("source_unavailable")


async def _infer(registry: Any, row: Any, prompt: str, data: Any) -> str:
    harness = registry.get_agent(row.agent_id)
    # Model factory only: no harness invoke, memory tools, private prompts or callbacks.
    llm = harness.model_factory.get(harness.config.pick_default_model_ref())
    return await ainvoke_text(
        llm,
        [SystemMessage(content=prompt), HumanMessage(content=json.dumps(data, ensure_ascii=False))],
        timeout=90,
    )


async def update_self(registry: Any, uid: int, command: SelfCommand) -> SelfState:
    row = _owned(registry, uid)
    workspace = _workspace(registry, row)
    async with _lock(registry, "state:" + row.agent_id):
        state = await _load(workspace)
        _revision(state.revision, command.revision)
        draft = command.draft or state.draft
        if command.action in {"save", "generate", "publish"}:
            await _check_sources(registry, uid, draft)
        if command.action == "generate":
            if not draft.entries:
                _error("invalid_draft")
            raw = await _infer(
                registry,
                row,
                tr("digital_self.draft_prompt", "zh"),
                {"draft": draft.model_dump(), "schema": SelfDraft.model_json_schema()},
            )
            generated = SelfDraft.model_validate_json(raw)
            # Model edits expression, never access policy, source membership or recognition.
            if len(generated.entries) != len(draft.entries) or {
                e.id for e in generated.entries
            } != {e.id for e in draft.entries}:
                _error("invalid_draft")
            source_by_id = {e.id: e for e in draft.entries}
            for entry in generated.entries:
                entry.source = source_by_id[entry.id].source
                entry.recognized = False
            generated.access = draft.access
            generated.visitor_daily_limit = draft.visitor_daily_limit
            generated.daily_limit = draft.daily_limit
            draft = generated
            await _check_sources(registry, uid, draft)
        if command.action in {"save", "generate", "publish"}:
            state.draft = draft
        if command.action == "publish":
            if (
                not draft.name
                or not draft.bio
                or not draft.entries
                or not all(e.recognized for e in draft.entries)
            ):
                _error("invalid_draft")
            state.publication = SelfPublication(
                version=new_ulid(), published_at=_now(), draft=draft.model_copy(deep=True)
            )
            state.status = "published"
        elif command.action == "pause":
            state.status = "paused"
        elif command.action == "unpublish":
            state.status = "unpublished"
            state.publication = None
        return await _save(workspace, state)


async def _rows(registry: Any) -> list[Any]:
    return [
        r
        for r in await asyncio.to_thread(registry._repos.agent_repo.list_all, include_disabled=True)
        if application_id(r) == "zhijun"
    ]


async def _locate(
    registry: Any, self_id: str, *, visitor: bool = True
) -> tuple[Any, Any, SelfState]:
    if not self_id:
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    for row in await _rows(registry):
        try:
            workspace = _workspace(registry, row)
            state = await _load(workspace)
        except (OSError, ValueError, OctopError):
            continue
        if state.id == self_id and (not visitor or state.publication is not None):
            return row, workspace, state
    raise OctopError.localized(ErrorCode.NOT_FOUND)


def _approved(state: SelfState, uid: int) -> bool:
    visit = next((v for v in state.visitors if v.visitor_id == uid), None)
    if visit and visit.status in {"rejected", "revoked"}:
        return False
    return bool(
        state.publication
        and (state.publication.draft.access == "open" or (visit and visit.status == "approved"))
    )


def _card(registry: Any, row: Any, state: SelfState, uid: int) -> SelfCard:
    assert state.publication
    public = state.publication
    visit = next((v for v in state.visitors if v.visitor_id == uid), None)
    model = {"name": row.default_model or "", "local": False}
    online = state.status == "published" and row.last_state == "running" and row.enabled
    if online:
        try:
            model = _model(registry.get_agent(row.agent_id))
        except (OctopError, ValueError):
            online = False
    return SelfCard(
        id=state.id,
        name=public.draft.name,
        bio=public.draft.bio,
        topics=public.draft.topics,
        questions=public.draft.questions,
        works=[e.title for e in public.draft.entries],
        updated_at=public.published_at,
        version=public.version,
        online=online,
        access=public.draft.access,
        access_status="approved" if _approved(state, uid) else visit.status if visit else "none",
        model=str(model["name"]),
        model_local=bool(model["local"]),
        contact_status=visit.contact_status if visit else "none",
    )


async def discover(registry: Any, uid: int, query: str, offset: int, limit: int) -> DiscoveryPage:
    cards = []
    unavailable = 0
    for row in await _rows(registry):
        if row.user_id == uid:
            continue
        try:
            state = await _load(_workspace(registry, row))
        except (OSError, ValueError, OctopError):
            unavailable += 1
            continue
        if state.publication is None or state.status == "unpublished":
            continue
        card = _card(registry, row, state, uid)
        if (
            not query
            or query.casefold() in " ".join([card.name, card.bio, *card.topics]).casefold()
        ):
            cards.append(card)
    cards.sort(key=lambda c: (not c.online, c.name, c.id))
    return DiscoveryPage(
        items=cards[offset : offset + limit],
        total=len(cards),
        has_more=len(cards) > offset + limit,
        unavailable_profiles=unavailable,
    )


async def public_card(registry: Any, uid: int, self_id: str) -> SelfCard:
    row, _, state = await _locate(registry, self_id)
    return _card(registry, row, state, uid)


async def request_access(
    registry: Any, uid: int, self_id: str, request: VisitorRequest
) -> SelfCard:
    row, workspace, _ = await _locate(registry, self_id)
    if uid == row.user_id:
        _error("use_preview")
    async with _lock(registry, "state:" + row.agent_id):
        state = await _load(workspace)
        if not state.publication:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        visit = next((v for v in state.visitors if v.visitor_id == uid), None)
        if visit is None:
            visit = SelfAccess(
                visitor_id=uid,
                status="approved" if state.publication.draft.access == "open" else "pending",
            )
            state.visitors.append(visit)
        if visit.status in {"revoked", "rejected"}:
            _error("access_denied")
        if request.contact and request.contact != visit.contact:
            visit.contact_status = "pending"
        if request.note:
            visit.note = request.note
        if request.contact:
            visit.contact = request.contact
        visit.updated_at = _now()
        state = await _save(workspace, state)
        return _card(registry, row, state, uid)


async def review_access(registry: Any, uid: int, command: AccessCommand) -> SelfState:
    row = _owned(registry, uid)
    workspace = _workspace(registry, row)
    async with _lock(registry, "state:" + row.agent_id):
        state = await _load(workspace)
        _revision(state.revision, command.revision)
        visit = next((v for v in state.visitors if v.visitor_id == command.visitor_id), None)
        if visit is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        if command.action in {"contact_accept", "contact_decline"}:
            visit.contact_status = "accepted" if command.action == "contact_accept" else "declined"
        else:
            visit.status = {"approve": "approved", "reject": "rejected", "revoke": "revoked"}[
                command.action
            ]  # type: ignore[assignment]
        visit.updated_at = _now()
        return await _save(workspace, state)


def _history_path(uid: int) -> str:
    return f"zhijun/digital-self/visitors/{uid}.json"


async def _history(workspace: Any, uid: int) -> VisitorHistory:
    text = await workspace.aread_text(_history_path(uid))
    return VisitorHistory.model_validate_json(text) if text else VisitorHistory()


async def history_page(
    registry: Any, uid: int, self_id: str, offset: int, limit: int, *, visitor_id: int | None = None
) -> HistoryPage:
    row, workspace, _ = await _locate(registry, self_id, visitor=False)
    if visitor_id is not None and row.user_id != uid:
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    target = uid if visitor_id is None else visitor_id
    history = await _history(workspace, target)
    live = _lock(registry, "turn:" + row.agent_id).locked()
    return HistoryPage(
        revision=history.revision,
        messages=history.messages[offset : offset + limit],
        memory=history.memory,
        total=len(history.messages),
        has_more=len(history.messages) > offset + limit,
        pending_request=history.pending_request,
        pending_text=history.pending_text,
        pending_status="unknown"
        if history.pending_status == "running" and not live
        else history.pending_status,
    )


async def clear_history(
    registry: Any, uid: int, self_id: str, command: HistoryCommand
) -> HistoryPage:
    row, workspace, _ = await _locate(registry, self_id, visitor=False)
    async with _lock(registry, "state:" + row.agent_id):
        history = await _history(workspace, uid)
        _revision(history.revision, command.revision)
        if _lock(registry, "turn:" + row.agent_id).locked():
            _error("busy")
        if command.action == "dismiss_pending":
            history.pending_request = None
            history.pending_status = None
            history.pending_text = ""
        elif command.action == "clear":
            history = VisitorHistory()
        else:
            history.memory = []
            # Forgetting also excludes earlier messages from future context.
            history.messages = []
            history.pending_request = None
            history.pending_status = None
            history.pending_text = ""
        history.revision = new_ulid()
        await _write(workspace, _history_path(uid), history)
    return await history_page(registry, uid, self_id, max(0, len(history.messages) - 40), 40)


async def _reply(
    registry: Any,
    row: Any,
    draft: SelfDraft,
    entries: list[SelfEntry],
    text: str,
    history: VisitorHistory,
    publication_version: str = "",
) -> SelfReply:
    terms = {text[i : i + 2] for i in range(max(0, len(text) - 1))}
    ranked = sorted(entries, key=lambda e: sum(t in e.title + e.text for t in terms), reverse=True)
    selected = ranked[:8]
    related = sorted(history.memory, key=lambda f: sum(t in f.quote for t in terms), reverse=True)[
        :8
    ]
    visitor_memory = list({f.quote: f for f in [*related, *history.memory[-8:]]}.values())
    raw = await _infer(
        registry,
        row,
        tr("digital_self.reply_prompt", "zh"),
        {
            "name": draft.name,
            "style": draft.style,
            "boundaries": draft.boundaries,
            "sources": [{"id": e.id, "title": e.title, "text": e.text[:3000]} for e in selected],
            "visitor_memory": [f.model_dump() for f in visitor_memory],
            "recent": [
                {"role": m.role, "text": m.text[:1500], "assisted": m.assisted}
                for m in history.messages[-12:]
                if m.role == "user" or m.publication_version == publication_version
            ],
            "question": text,
            "schema": SelfReply.model_json_schema(),
        },
    )
    reply = SelfReply.model_validate_json(raw)
    if not set(reply.sources).issubset({e.id for e in selected}) or any(
        len(o) > 300 for o in reply.options
    ):
        _error("invalid_reply")
    reply.context_sources = [e.id for e in selected]
    return reply


async def preview_self(registry: Any, uid: int, body: PreviewTurn) -> SelfReply:
    row = _owned(registry, uid)
    state = await read_self(registry, uid)
    _revision(state.revision, body.revision)
    await _check_sources(registry, uid, state.draft)
    if not state.draft.entries:
        _error("invalid_draft")
    return await _reply(
        registry, row, state.draft, state.draft.entries, body.text, VisitorHistory()
    )


async def visitor_turn(registry: Any, uid: int, self_id: str, body: VisitorTurn) -> HistoryPage:
    row, workspace, _ = await _locate(registry, self_id)
    if uid == row.user_id:
        _error("use_preview")
    if not body.acknowledge_owner_visibility:
        _error("disclosure_required")
    turn_lock = _lock(registry, "turn:" + row.agent_id)
    if turn_lock.locked():
        _error("busy")
    async with turn_lock:
        async with _lock(registry, "state:" + row.agent_id):
            state = await _load(workspace)
            history = await _history(workspace, uid)
            if any(m.request_id == body.request_id for m in history.messages):
                previous = next(
                    m
                    for m in history.messages
                    if m.request_id == body.request_id and m.role == "user"
                )
                if previous.text != body.text:
                    _error("conflict")
                return await history_page(
                    registry, uid, self_id, max(0, len(history.messages) - 40), 40
                )
            if history.pending_request:
                _error("request_unknown")
            if (
                not state.publication
                or state.status != "published"
                or row.last_state != "running"
                or not row.enabled
            ):
                _error("offline")
            if not _approved(state, uid):
                _error("access_denied")
            _revision(history.revision, body.revision)
            _revision(state.publication.version, body.publication_version)
            public = state.publication
            suggested = {
                o for m in history.messages[-2:] if m.role == "assistant" for o in m.options
            }
            assisted = (
                body.assisted or body.text in suggested or body.text in public.draft.questions
            )
            entries = [
                e
                for e in public.draft.entries
                if not e.source or await _source_valid(registry, row.user_id, e.source)
            ]
            if not entries:
                _error("source_unavailable")
            zone = ZoneInfo(registry._config.default_timezone)
            day = datetime.now(zone).date().isoformat()
            visitor_key = f"{day}:{uid}"
            if (
                state.usage.get(day, 0) >= public.draft.daily_limit
                or state.usage.get(visitor_key, 0) >= public.draft.visitor_daily_limit
            ):
                _error("quota")
            state.usage = {k: v for k, v in state.usage.items() if k.startswith(day)}
            state.usage[day] = state.usage.get(day, 0) + 1
            state.usage[visitor_key] = state.usage.get(visitor_key, 0) + 1
            if not any(v.visitor_id == uid for v in state.visitors):
                state.visitors.append(
                    SelfAccess(visitor_id=uid, status="approved", updated_at=_now())
                )
            await _save(workspace, state)
            history.pending_request, history.pending_text, history.pending_at = (
                body.request_id,
                body.text,
                _now(),
            )
            history.pending_status = "running"
            history.revision = new_ulid()
            await _write(workspace, _history_path(uid), history)
        try:
            reply = await _reply(
                registry, row, public.draft, entries, body.text, history, public.version
            )
            async with _lock(registry, "state:" + row.agent_id):
                latest = await _load(workspace)
                if (
                    not latest.publication
                    or latest.status != "published"
                    or not _approved(latest, uid)
                    or latest.publication.version != public.version
                ):
                    _error("changed")
                for entry in entries:
                    if (
                        entry.id in reply.context_sources
                        and entry.source
                        and not await _source_valid(registry, row.user_id, entry.source)
                    ):
                        _error("source_unavailable")
                message = VisitorMessage(
                    id=new_ulid(),
                    role="user",
                    text=body.text,
                    at=_now(),
                    publication_version=public.version,
                    request_id=body.request_id,
                    assisted=assisted,
                )
                history.messages.extend(
                    [
                        message,
                        VisitorMessage(
                            id=new_ulid(),
                            role="assistant",
                            text=reply.answer,
                            at=_now(),
                            publication_version=public.version,
                            sources=reply.sources,
                            context_sources=reply.context_sources,
                            options=reply.options,
                            request_id=body.request_id,
                        ),
                    ]
                )
                if not assisted:
                    for fact in reply.memory:
                        quote, text = fact.get("quote", ""), fact.get("text", "")
                        if 0 < len(quote) <= 300 and quote in body.text and 0 < len(text) <= 300:
                            history.memory.append(
                                RelationshipFact(text=quote, quote=quote, message_id=message.id)
                            )
                    history.memory = list({f.text: f for f in history.memory}.values())
                history.pending_request = None
                history.pending_status = None
                history.pending_text = ""
                history.revision = new_ulid()
                await _write(workspace, _history_path(uid), history)
        except BaseException as exc:
            # A failed readback after commit must not turn a saved answer into a
            # second failed/pending message. Recover only the persisted request.
            persisted = await _history(workspace, uid)
            if not any(m.request_id == body.request_id for m in persisted.messages):
                persisted.pending_status = (
                    "unknown" if isinstance(exc, asyncio.CancelledError) else "failed"
                )
                await _write(workspace, _history_path(uid), persisted)
            raise

    return await history_page(registry, uid, self_id, max(0, len(history.messages) - 40), 40)


async def published_entry(
    registry: Any, uid: int, self_id: str, entry_id: str, expected_version: str = ""
) -> PublishedEntry:
    row, _, state = await _locate(registry, self_id)
    if state.status != "published" or not _approved(state, uid):
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    assert state.publication
    if expected_version and state.publication.version != expected_version:
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    entry = next((e for e in state.publication.draft.entries if e.id == entry_id), None)
    if entry is None or (
        entry.source and not await _source_valid(registry, row.user_id, entry.source)
    ):
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    return PublishedEntry(
        id=entry.id,
        title=entry.title,
        text=entry.text,
        publication_version=state.publication.version,
    )
