"""Owner-declared destination policy and an allowlisted notification projection."""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from octop.i18n import tr
from octop.infra.agents.disclosure import ORDINARY, classify
from octop.infra.agents.personal_ontology import _digest, _lock, _owned
from octop.infra.errors import ErrorCode, OctopError

Purpose = Literal["work", "private"]
_PATH = "zhijun/notification-channels.json"


class ChannelPurpose(BaseModel):
    model_config = ConfigDict(extra="forbid")
    channel_id: str
    purpose: Purpose = "work"


class ChannelPolicy(ChannelPurpose):
    declared: bool = False


def _fingerprint(channel: Any) -> str:
    return _digest({"id": channel.channel_id, "config": json.loads(channel.config_json)})


async def _read(workspace: Any) -> dict[str, Any]:
    text = await workspace.aread_text(_PATH)
    return json.loads(text) if text else {}


async def read_channel_policies(registry: Any, uid: int, gateway: Any) -> list[ChannelPolicy]:
    row = _owned(registry, uid)
    saved = await _read(registry.get_agent(row.agent_id).workspace)
    return [_policy(channel, saved) for channel in gateway.list_channels(row.agent_id)]


def _policy(channel: Any, saved: dict[str, Any]) -> ChannelPolicy:
    record = saved.get(channel.channel_id, {})
    current = record.get("binding") == _fingerprint(channel)
    return ChannelPolicy(
        channel_id=channel.channel_id,
        purpose="private" if current and record.get("purpose") == "private" else "work",
        declared=current,
    )


async def set_channel_purpose(
    registry: Any, uid: int, gateway: Any, body: ChannelPurpose
) -> ChannelPolicy:
    row = _owned(registry, uid)
    channel = gateway.get_channel(body.channel_id)
    if channel is None or (channel.agent_id, channel.user_id) != (row.agent_id, uid):
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    workspace = registry.get_agent(row.agent_id).workspace
    async with _lock(registry, "notification-channels:" + row.agent_id):
        saved = await _read(workspace)
        saved[channel.channel_id] = {"purpose": body.purpose, "binding": _fingerprint(channel)}
        await workspace.aupload_bytes(_PATH, json.dumps(saved).encode())
        if await _read(workspace) != saved:
            raise RuntimeError("channel_purpose_write_not_verified")
    return _policy(channel, saved)


async def purpose_for_session(registry: Any, row: Any, gateway: Any, session: Any) -> Purpose:
    if (
        session.agent_id != row.agent_id
        or session.user_id != row.user_id
        or session.channel_chat_type == "group"
        or (session.channel_metadata or {}).get("is_group")
        or (session.channel_metadata or {}).get("chat_type") == "group"
        or not session.channel_id
    ):
        return "work"
    channel = gateway.get_channel(session.channel_id)
    if channel is None or (channel.agent_id, channel.user_id) != (row.agent_id, row.user_id):
        return "work"
    saved = await _read(registry.get_agent(row.agent_id).workspace)
    return _policy(channel, saved).purpose


def notification_text(
    *,
    purpose: Purpose,
    kind: str,
    source_class: str,
    sensitive: bool,
    approved_summary: str,
    locale: str,
) -> str:
    """No diary, conversation, ontology or model-generated body enters this interface."""
    if (
        purpose != "private"
        or kind not in {"decision", "agreement", "question"}
        or source_class != "owner_entry"
        or sensitive
        or not approved_summary.strip()
        or classify(approved_summary) != ORDINARY
    ):
        return tr("proactive_care.zhijun_knock", locale)
    return tr("proactive_care.zhijun_revisit", locale, summary=approved_summary.strip())
