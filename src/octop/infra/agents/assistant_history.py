"""Owner-scoped assistant history organization, without editing source messages."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from octop.infra.agents.assistant_profile import AssistantProfiles
from octop.infra.errors import ErrorCode, OctopError

PREFERENCE_KEY = "wanx_assistant_history_v1"


class AssistantHistory:
    def __init__(self, server: Any) -> None:
        self.server = server

    def _agent(self, user: Any) -> Any:
        if user.application_id != "wanx":
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        row = AssistantProfiles(self.server)._existing(user.id)
        if row is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        return row

    @staticmethod
    def _response(data: Any, agent_id: str) -> dict[str, Any]:
        data = data if isinstance(data, dict) else {}
        prefix = f"thread:{agent_id}:"
        return {
            "revision": data.get("revision", 0),
            "entries": {
                ("thread:" + key[len(prefix) :] if key.startswith(prefix) else key): value
                for key, value in data.get("entries", {}).items()
                if key.startswith(prefix) or key.startswith("legacy:")
            },
        }

    async def get(self, user: Any) -> dict[str, Any]:
        def read() -> dict[str, Any]:
            agent = self._agent(user)
            row = self.server.services.user_repo.get(user.id)
            data = json.loads(row.preferences_json or "{}").get(PREFERENCE_KEY)
            return self._response(data, agent.agent_id)

        return await asyncio.to_thread(read)

    async def update(
        self, user: Any, operation: str, items: list[dict[str, str]], title: str | None
    ) -> dict[str, Any]:
        def write() -> dict[str, Any]:
            agent = self._agent(user)
            keys = []
            if operation == "rename" and (len(items) != 1 or not (title or "").strip()):
                raise OctopError.localized(ErrorCode.SLASH_BAD_ARGS)
            for item in items:
                kind, identity = item["kind"], item["id"]
                if kind == "thread":
                    row = self.server.app_runtime.gateway.thread_registry.get_thread(identity)
                    if not row or row.agent_id != agent.agent_id or row.user_id != user.id:
                        raise OctopError.localized(ErrorCode.NOT_FOUND)
                    if operation in {"archive", "trash"} and (
                        self.server.app_runtime.gateway.ws_hub.is_turn_active(identity)
                    ):
                        raise OctopError.localized(
                            ErrorCode.SLASH_BAD_ARGS,
                            details={"reason": "ASSISTANT_TURN_ACTIVE"},
                        )
                    keys.append(f"thread:{agent.agent_id}:{identity}")
                else:
                    if not self.server.services.repos.dialogue_repo.get(
                        (user.id, "dialogue"), identity
                    ):
                        raise OctopError.localized(ErrorCode.NOT_FOUND)
                    keys.append(f"legacy:{identity}")

            def mutate(raw: Any) -> dict[str, Any]:
                data: dict[str, Any] = dict(raw) if isinstance(raw, dict) else {}
                stored_entries = data.get("entries")
                entries: dict[str, Any] = (
                    dict(stored_entries) if isinstance(stored_entries, dict) else {}
                )
                data["entries"] = entries
                changed = False
                for key in keys:
                    before = entries.get(key, {})
                    entry = dict(before)
                    if operation == "rename":
                        entry["title"] = " ".join((title or "").split())
                    elif operation in {"pin", "unpin"}:
                        entry["pinned"] = operation == "pin"
                    elif operation in {"archive", "unarchive"}:
                        entry["status"] = "archived" if operation == "archive" else "active"
                        entry.pop("deleted_at", None)
                    elif operation == "trash" and entry.get("status") != "trash":
                        entry["previous_status"] = entry.get("status", "active")
                        entry["status"] = "trash"
                        entry["deleted_at"] = int(time.time())
                        entry["deleted_at_ms"] = int(time.time() * 1000)
                    elif operation == "restore" and entry.get("status") == "trash":
                        entry["status"] = entry.pop("previous_status", "active")
                        entry.pop("deleted_at", None)
                    if entry != before:
                        entry["updated_at"] = int(time.time())
                        entries[key] = entry
                        changed = True
                if len(entries) > 10000:
                    raise OctopError.localized(ErrorCode.SLASH_BAD_ARGS)
                data["revision"] = int(data.get("revision", 0)) + int(changed)
                return data

            data = self.server.services.user_repo.mutate_preference_json(
                user.id, PREFERENCE_KEY, mutate
            )
            return self._response(data, agent.agent_id)

        return await asyncio.to_thread(write)


async def rotate_trashed_channel(
    registry: Any,
    user_repo: Any,
    *,
    agent_id: str,
    user_id: int,
    session_key: str,
    channel_type: str,
) -> None:
    """A new IM turn must not disappear into a deleted assistant conversation."""
    if channel_type in {"dashboard", "cli"}:
        return
    user = user_repo.get(user_id)
    raw = getattr(user, "preferences_json", None)
    try:
        preferences = json.loads(raw) if isinstance(raw, str) and raw else {}
    except ValueError:
        return
    if not isinstance(preferences, dict):
        return
    if preferences.get("wanx_assistant_agent_id") != agent_id:
        return
    tid = registry.get_bound_thread_id(session_key)
    row = registry.get_thread(tid) if tid else None
    if not row or row.agent_id != agent_id or row.user_id != user_id:
        return
    entry = (
        preferences.get(PREFERENCE_KEY, {}).get("entries", {}).get(f"thread:{agent_id}:{tid}", {})
    )
    if entry.get("status") != "trash":
        return
    successor = registry.get_thread(entry.get("channel_successor", ""))
    if successor and (successor.agent_id, successor.user_id) == (agent_id, user_id):
        await registry.rebind(
            session_key=session_key, thread_id=successor.thread_id, agent_id=agent_id
        )
    elif row.last_active <= int(entry.get("deleted_at", 0)):
        # Post-deletion turns from older clients are recovered separately before rebinding.
        await registry.reset_by_session_key(session_key)
