"""Owner-bound understanding reminders and explicit WeChat topic activation."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from octop.i18n import tr
from octop.infra.errors import OctopError
from octop.infra.utils.locale import resolve_user_locale
from octop.infra.utils.ulid import new_ulid


def _gateway(registry: Any, gateway: Any = None) -> Any:
    return gateway or getattr(getattr(registry, "ontology", None), "gateway", None)


def _now() -> datetime:
    return datetime.now(UTC)


def _time(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value))
        return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed
    except (TypeError, ValueError):
        return None


def _binding(gateway: Any, row: Any, session: Any) -> dict[str, str] | None:
    """Check the persisted route against the current QR-confirmed credentials."""
    if (
        gateway is None
        or session.agent_id != row.agent_id
        or session.user_id != row.user_id
        or session.channel_type != "weixin"
        or session.channel_chat_type == "group"
        or not session.channel_id
    ):
        return None
    channel = gateway.get_channel(session.channel_id)
    if (
        channel is None
        or channel.agent_id != row.agent_id
        or channel.user_id != row.user_id
        or channel.kind != "weixin"
        or not channel.enabled
    ):
        return None
    try:
        config = json.loads(channel.config_json)
    except (TypeError, ValueError):
        return None
    if not isinstance(config, dict):
        return None
    owner = str(config.get("owner_weixin_user_id") or "")
    meta = session.channel_metadata or {}
    account = str(meta.get("account_id") or "")
    accounts = config.get("accounts") or []
    if (
        not owner
        or session.channel_subject_id != owner
        or str(meta.get("from_user_id") or meta.get("ilink_user_id") or "") != owner
        or not account
        or not any(isinstance(a, dict) and a.get("account_id") == account for a in accounts)
    ):
        return None
    return {
        "channel_id": str(session.channel_id),
        "session_key": str(session.session_key),
        "account_id": account,
        "subject_id": owner,
    }


def _same_binding(delivery: dict[str, Any], binding: dict[str, str]) -> bool:
    return all(delivery.get(key) == value for key, value in binding.items())


def _allowed(
    state: Any,
    care: Any,
    now: datetime,
    timezone: str,
    *,
    reminder: bool,
    last_care_at: int | None = None,
) -> bool:
    local = now.astimezone(ZoneInfo(timezone))
    clock = local.strftime("%H:%M")
    start, end = care.active_hours_start, care.active_hours_end
    active = start <= clock < end if start < end else clock >= start or clock < end
    if not care.enabled or not active:
        return False
    if last_care_at is not None and now - datetime.fromtimestamp(last_care_at, UTC) < timedelta(
        hours=care.min_interval_hours
    ):
        return False
    for delivery in state.weixin_deliveries:
        if delivery.get("status") not in {"sending", "submitted", "unknown"}:
            continue
        attempted = _time(delivery.get("attempted_at"))
        if attempted is None:
            continue
        if now - attempted < timedelta(hours=care.min_interval_hours):
            return False
        if (
            reminder
            and delivery.get("kind", "invitation") == "invitation"
            and attempted.astimezone(ZoneInfo(timezone)).date() == local.date()
        ):
            return False
    return True


async def _finish(registry: Any, row: Any, delivery_id: str, status: str, **values: Any) -> None:
    from octop.infra.agents.knowledge_understanding import _lock, _read_state, _save_state

    workspace = registry.get_agent(row.agent_id).workspace
    async with _lock(registry, "understanding:" + row.agent_id):
        state = await _read_state(workspace)
        delivery = next((d for d in state.weixin_deliveries if d.get("id") == delivery_id), None)
        if delivery:
            delivery.update(status=status, **values)
            await _save_state(workspace, state)


async def deliver_understanding_invitation(
    registry: Any, row: Any, doc: Any, *, gateway: Any = None
) -> None:
    """Submit one already-generated invitation; never run a model or fabricate a turn."""
    from octop.infra.agents.knowledge_understanding import (
        _lock,
        _read_state,
        _save_state,
        resolve_invitation,
    )

    gateway = _gateway(registry, gateway)
    if gateway is None or getattr(row, "application_id", "wanx") != "zhijun":
        return
    repos = getattr(registry, "_repos", None)
    if repos is None:
        return
    sessions = repos.session_repo.list_by_agent(row.agent_id, limit=200)
    target = next((s for s in sessions if _binding(gateway, row, s)), None)
    if target is None:
        return
    binding = _binding(gateway, row, target)
    assert binding is not None
    workspace = registry.get_agent(row.agent_id).workspace
    now = _now()
    timezone = registry.octop_config.default_timezone
    care = repos.proactive_care_config_repo.get(row.agent_id)
    async with _lock(registry, "understanding:" + row.agent_id):
        state = await _read_state(workspace)
        changed = False
        for previous in state.weixin_deliveries:
            attempted = _time(previous.get("attempted_at"))
            if (
                previous.get("status") == "sending"
                and attempted is not None
                and now - attempted > timedelta(minutes=2)
            ):
                # A crash after dispatch has an unknown outcome. Do not auto-repeat it.
                previous["status"] = "unknown"
                changed = True
        if changed:
            await _save_state(workspace, state)
        if (
            not state.enabled
            or not state.weixin_reminders
            or not _allowed(
                state,
                care,
                now,
                timezone,
                reminder=True,
                last_care_at=repos.care_push_repo.latest_push_at(row.agent_id),
            )
        ):
            return
        for previous in state.weixin_deliveries:
            expires = _time(previous.get("expires_at"))
            if (
                _same_binding(previous, binding)
                and previous.get("kind", "invitation") == "invitation"
                and previous.get("status") in {"pending", "sending", "submitted", "unknown"}
                and expires is not None
                and expires > now
                and not previous.get("activated_at")
            ):
                return
        delivered = {
            d.get("invitation_id")
            for d in state.weixin_deliveries
            if not (
                d.get("status") == "failed"
                and d.get("error") == "source_unavailable"
                and not d.get("attempted_at")
            )
        }
        invitation = next(
            (
                i
                for i in state.invitations
                if i.status == "pending" and i.source_available and i.id not in delivered
            ),
            None,
        )
        if invitation is None:
            return
        record: dict[str, Any] = {
            "id": new_ulid(),
            "kind": "invitation",
            "invitation_id": invitation.id,
            "status": "pending",
            "activation_phrase": invitation.activation_phrase,
            "created_at": now.isoformat(),
            "expires_at": (now + timedelta(days=7)).isoformat(),
            **binding,
        }
        state.weixin_deliveries.append(record)
        await _save_state(workspace, state)

    async def submit() -> None:
        fresh = gateway.require_session(row.agent_id, target.session_key)
        if _binding(gateway, row, fresh) != binding:
            await _finish(registry, row, record["id"], "failed", error="binding_changed")
            return
        try:
            verified = await resolve_invitation(registry, row.user_id, record["invitation_id"])
        except OctopError:
            await _finish(registry, row, record["id"], "failed", error="source_unavailable")
            return
        if verified["status"] != "pending":
            await _finish(registry, row, record["id"], "failed", error="invitation_not_pending")
            return
        locale = resolve_user_locale(
            user_repo=repos.user_repo, user_id=row.user_id, channel_type="weixin"
        )
        # Material-derived invitations are not owner-approved notification summaries.
        # Their title/question may themselves reveal diary or inner-life content.
        text = tr("proactive_care.zhijun_knock", locale)
        async with _lock(registry, "understanding:" + row.agent_id):
            current = await _read_state(workspace)
            care_now = repos.proactive_care_config_repo.get(row.agent_id)
            if (
                not current.enabled
                or not current.weixin_reminders
                or not _allowed(
                    current,
                    care_now,
                    _now(),
                    timezone,
                    reminder=True,
                    last_care_at=repos.care_push_repo.latest_push_at(row.agent_id),
                )
            ):
                delivery = next(d for d in current.weixin_deliveries if d["id"] == record["id"])
                delivery.update(status="failed", error="disabled_or_cooldown")
                await _save_state(workspace, current)
                return
            delivery = next(d for d in current.weixin_deliveries if d["id"] == record["id"])
            delivery.update(status="sending", attempted_at=_now().isoformat())
            await _save_state(workspace, current)
        try:
            if (
                _binding(gateway, row, gateway.require_session(row.agent_id, target.session_key))
                != binding
            ):
                await _finish(registry, row, record["id"], "failed", error="binding_changed")
                return
            await gateway.push_session_text(fresh, text)
        except Exception:
            await _finish(registry, row, record["id"], "unknown", error="submission_uncertain")
            return
        await _finish(registry, row, record["id"], "submitted", submitted_at=_now().isoformat())

    try:
        await gateway.run_in_session(row.agent_id, target.session_key, submit)
    except Exception:
        fresh_state = await _read_state(workspace)
        failed = next(d for d in fresh_state.weixin_deliveries if d["id"] == record["id"])
        uncertain = bool(failed.get("attempted_at"))
        await _finish(
            registry,
            row,
            record["id"],
            "unknown" if uncertain else "failed",
            error="submission_uncertain" if uncertain else "session_unavailable",
        )


def _explicit_activation(text: str, phrase: str) -> bool:
    stripped = text.strip()
    if stripped == phrase:
        return True
    return any(stripped.startswith(phrase + separator) for separator in ("：", ":", "\n"))


def _end_binding(text: str) -> bool:
    return bool(
        re.match(
            r"^(?:这(?:个|件事|项理解|份资料)[，, ]*)?(?:我(?:现在)?|我们)?"
            r"(?:先不聊|暂时不聊|不想聊|先不展开|暂不展开|先放下|换个话题|聊别的|先聊到这|今天先到这)",
            text.strip(),
        )
    )


async def resolve_weixin_invitation(
    registry: Any,
    uid: int,
    *,
    channel_id: str,
    session_key: str,
    text: str,
    account_id: str,
    subject_id: str,
    gateway: Any = None,
) -> dict[str, Any] | None:
    """Explicitly activate a topic, or restore its verified conversation background."""
    from octop.infra.agents.knowledge_understanding import (
        _owned,
        _read_state,
        activate_invitation,
        resolve_invitation,
    )

    gateway = _gateway(registry, gateway)
    if gateway is None or getattr(registry, "_repos", None) is None:
        return None
    row = _owned(registry, uid)
    session = registry._repos.session_repo.get(session_key)
    if session is None:
        return None
    binding = _binding(gateway, row, session)
    expected = {
        "channel_id": channel_id,
        "session_key": session_key,
        "account_id": account_id,
        "subject_id": subject_id,
    }
    if binding != expected:
        return None
    workspace = registry.get_agent(row.agent_id).workspace
    state = await _read_state(workspace)
    if not state.enabled:
        return None
    eligible = [
        d
        for d in state.weixin_deliveries
        if _same_binding(d, binding)
        and d.get("status") in {"submitted", "unknown"}
        and (_time(d.get("expires_at")) or datetime.min.replace(tzinfo=UTC)) > _now()
    ]
    active = [
        d
        for d in eligible
        if d.get("activated_at")
        and not d.get("binding_cleared_at")
        and d.get("activated_thread_id") == session.thread_id
    ]
    if _end_binding(text):
        for delivery in active:
            await _finish(
                registry,
                row,
                delivery["id"],
                delivery["status"],
                binding_cleared_at=_now().isoformat(),
            )
        return None
    candidates = [
        d for d in eligible if _explicit_activation(text, str(d.get("activation_phrase") or ""))
    ]
    explicit = bool(candidates)
    if not explicit:
        candidates = active
    if len(candidates) != 1:
        return None
    candidate = candidates[0]
    try:
        invitation = await resolve_invitation(registry, uid, str(candidate["invitation_id"]))
        if explicit:
            invitation = await activate_invitation(registry, uid, invitation["id"])
        elif invitation["status"] != "active":
            return None
    except OctopError:
        return None
    if explicit:
        await _finish(
            registry,
            row,
            candidate["id"],
            candidate["status"],
            activated_at=_now().isoformat(),
            activated_thread_id=session.thread_id,
            binding_cleared_at=None,
        )
    return invitation


async def reserve_care_push(registry: Any, agent_id: str) -> str | None:
    """Reserve the shared minimum interval before generating an existing care message."""
    from octop.infra.agents.knowledge_understanding import _lock, _read_state, _save_state

    row = registry.get_row(agent_id)
    workspace = registry.get_agent(agent_id).workspace
    async with _lock(registry, "understanding:" + agent_id):
        state = await _read_state(workspace)
        care = registry._repos.proactive_care_config_repo.get(agent_id)
        now = _now()
        if not _allowed(
            state,
            care,
            now,
            registry.octop_config.default_timezone,
            reminder=False,
            last_care_at=registry._repos.care_push_repo.latest_push_at(agent_id),
        ):
            return None
        delivery_id = new_ulid()
        state.weixin_deliveries.append(
            {
                "id": delivery_id,
                "kind": "care",
                "status": "sending",
                "attempted_at": now.isoformat(),
            }
        )
        await _save_state(workspace, state)
        assert row is not None
        return delivery_id


async def finish_care_push(registry: Any, agent_id: str, delivery_id: str, status: str) -> None:
    row = registry.get_row(agent_id)
    await _finish(registry, row, delivery_id, status)
