"""Explicit owner decisions and outcome reviews over the platform workspace."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from octop.infra.agents.disclosure import CRISIS, ORDINARY, classify
from octop.infra.agents.notification_policy import notification_text, purpose_for_session
from octop.infra.agents.personal_ontology import _lock, _owned
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.locale import normalize_locale
from octop.infra.utils.ulid import new_ulid

_PATH = "zhijun/decision-book.json"


class DecisionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    revision: str
    kind: Literal["decision", "agreement", "question"] = "decision"
    description: str = Field(min_length=1, max_length=2000)
    expectation: str = Field(min_length=1, max_length=1000)
    revisit_at: AwareDatetime
    private: bool = True
    push_summary: str = Field(default="", max_length=160)


class DecisionRecord(BaseModel):
    id: str
    kind: Literal["decision", "agreement", "question"]
    description: str
    expectation: str
    revisit_at: AwareDatetime
    created_at: str
    source_class: str = "owner_entry"
    sensitive: bool = True
    push_summary: str = ""
    state: Literal["open", "reviewed", "cancelled"] = "open"
    outcome: str = ""
    reflection: str = ""
    reviewed_at: str | None = None
    reminder_status: Literal["none", "sending", "submitted", "unknown"] = "none"


class DecisionBook(BaseModel):
    revision: str = "empty"
    entries: list[DecisionRecord] = Field(default_factory=list)


class DecisionReview(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    revision: str
    action: Literal["review", "cancel"] = "review"
    outcome: str = Field(default="", max_length=2000)
    reflection: str = Field(default="", max_length=2000)


async def _read(workspace: Any) -> DecisionBook:
    text = await workspace.aread_text(_PATH)
    return DecisionBook.model_validate_json(text) if text else DecisionBook()


async def _save(workspace: Any, book: DecisionBook) -> None:
    book.revision = new_ulid()
    await workspace.aupload_bytes(_PATH, book.model_dump_json().encode())
    if await _read(workspace) != book:
        raise RuntimeError("decision_book_write_not_verified")


def _revision(book: DecisionBook, revision: str) -> None:
    if book.revision != revision:
        raise OctopError.localized(ErrorCode.ZHIJUN_UNDERSTANDING_CONFLICT)


async def read_decisions(registry: Any, uid: int) -> DecisionBook:
    row = _owned(registry, uid)
    return await _read(registry.get_agent(row.agent_id).workspace)


async def create_decision(registry: Any, uid: int, body: DecisionCreate) -> DecisionBook:
    row = _owned(registry, uid)
    workspace = registry.get_agent(row.agent_id).workspace
    disclosure = classify(body.description + "\n" + body.expectation + "\n" + body.push_summary)
    if disclosure == CRISIS:
        raise OctopError.localized(ErrorCode.FORBIDDEN)
    async with _lock(registry, "decisions:" + row.agent_id):
        book = await _read(workspace)
        _revision(book, body.revision)
        book.entries.append(
            DecisionRecord(
                id=new_ulid(),
                kind=body.kind,
                description=body.description,
                expectation=body.expectation,
                revisit_at=body.revisit_at,
                created_at=datetime.now(UTC).isoformat(),
                sensitive=body.private or disclosure != ORDINARY,
                push_summary=body.push_summary,
            )
        )
        await _save(workspace, book)
        return book


async def review_decision(
    registry: Any, uid: int, decision_id: str, body: DecisionReview
) -> DecisionBook:
    row = _owned(registry, uid)
    workspace = registry.get_agent(row.agent_id).workspace
    if classify(body.outcome + "\n" + body.reflection) == CRISIS:
        raise OctopError.localized(ErrorCode.FORBIDDEN)
    async with _lock(registry, "decisions:" + row.agent_id):
        book = await _read(workspace)
        _revision(book, body.revision)
        entry = next((e for e in book.entries if e.id == decision_id), None)
        if entry is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        if entry.state != "open" or (body.action == "review" and not body.outcome):
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        entry.state = "cancelled" if body.action == "cancel" else "reviewed"
        entry.outcome, entry.reflection = body.outcome, body.reflection
        entry.reviewed_at = datetime.now(UTC).isoformat()
        await _save(workspace, book)
        return book


async def deliver_due_decision(registry: Any, row: Any, gateway: Any, session_key: str) -> bool:
    """Send the oldest due review once, under the shared opt-in/cooldown gate."""
    from octop.infra.agents.understanding_weixin import finish_care_push, reserve_care_push

    workspace = registry.get_agent(row.agent_id).workspace
    async with _lock(registry, "decisions:" + row.agent_id):
        book = await _read(workspace)
        due = sorted(
            (
                e
                for e in book.entries
                if e.state == "open"
                and e.reminder_status == "none"
                and e.revisit_at <= datetime.now(UTC)
            ),
            key=lambda e: e.revisit_at,
        )
        if not due:
            return False
        reservation = await reserve_care_push(registry, row.agent_id)
        if reservation is None:
            return True
        entry = due[0]
        entry.reminder_status = "sending"
        await _save(workspace, book)

    status: Literal["none", "submitted", "unknown"] = "none"

    async def submit() -> None:
        nonlocal status
        async with _lock(registry, "decisions:" + row.agent_id):
            fresh = await _read(workspace)
            current = next(e for e in fresh.entries if e.id == entry.id)
            if current.state != "open":
                return
            from octop.infra.proactive.scheduler import is_in_active_hours

            care = registry._repos.proactive_care_config_repo.get(row.agent_id)
            if not care.enabled or not is_in_active_hours(
                datetime.now(UTC),
                active_hours_start=care.active_hours_start,
                active_hours_end=care.active_hours_end,
                timezone_name=registry.octop_config.default_timezone,
            ):
                return
            session = gateway.require_session(row.agent_id, session_key)
            purpose = await purpose_for_session(registry, row, gateway, session)
            locale = normalize_locale(
                getattr(registry.get_agent(row.agent_id).config, "locale", None)
            )
            text = notification_text(
                purpose=purpose,
                kind=current.kind,
                source_class=current.source_class,
                sensitive=current.sensitive,
                approved_summary=current.push_summary,
                locale=locale,
            )
            status = "unknown"
            await gateway.push_session_text(session, text)
            status = "submitted"

    try:
        await gateway.run_in_session(row.agent_id, session_key, submit)
    finally:
        # Leave a durable 'sending' marker if saving the outcome fails: never auto-repeat.
        async with _lock(registry, "decisions:" + row.agent_id):
            book = await _read(workspace)
            entry = next(e for e in book.entries if e.id == entry.id)
            entry.reminder_status = status
            await _save(workspace, book)
        await finish_care_push(
            registry, row.agent_id, reservation, "failed" if status == "none" else status
        )
    return True
