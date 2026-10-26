"""Owner-scoped assistant conversations, source preferences and answer versions."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from octop.infra.agents.assistant_knowledge import KnowledgeReader
from octop.infra.agents.assistant_profile import AssistantProfiles
from octop.infra.agents.assistant_space import SpaceGrantStore
from octop.infra.agents.threads.fork import load_checkpoint_messages, write_checkpoint_messages
from octop.infra.agents.workspace.dir import resolve_workspace_host_path
from octop.infra.db.repos.assistant_conversations import (
    AssistantConversationRepo,
    ConversationConflict,
)
from octop.infra.gateway.hitl.coordinator import pending_hitl_payload
from octop.infra.gateway.process.message_keys import INBOUND_ATTACHMENTS_KEY
from octop.infra.gateway.threads import ThreadRegistry
from octop.infra.history.service import HistoryArchive


class ConversationError(Exception):
    def __init__(self, code: str, status: int = 409):
        self.code, self.status = code, status
        super().__init__(code)


def empty_context() -> dict[str, Any]:
    return {"space": {"enabled": False}, "knowledge": {"enabled": False, "warehouses": []}}


class AssistantConversations:
    def __init__(self, server: Any):
        self.server = server
        self.repo = AssistantConversationRepo(server.services.db)
        self.locks: dict[str, asyncio.Lock] = {}

    @asynccontextmanager
    async def grant_scope(
        self,
        user: Any,
        tid: str | None,
        kind: str,
        enabled: bool,
        selection: Any = None,
        data_scope: str | None = None,
    ) -> AsyncIterator[None]:
        cid = self.repo.root(tid) if tid else ""
        async with self.locks.setdefault(cid, asyncio.Lock()):
            if tid:
                try:
                    state = self.state(user, tid)
                except ConversationError as exc:
                    if kind == "knowledge":
                        raise ConversationError("ASSISTANT_KNOWLEDGE_DENIED", 403) from exc
                    raise
                saved = self.repo.get(state["id"])
                if saved and enabled:
                    selected = saved["context"].get(kind, {})
                    if not selected.get("enabled"):
                        raise ConversationError(
                            "SPACE_ACCESS_DENIED"
                            if kind == "space"
                            else "ASSISTANT_KNOWLEDGE_DENIED",
                            403,
                        )
                    expected = (
                        selected.get("selection")
                        if kind == "space"
                        else [w["id"] for w in selected.get("warehouses", [])]
                    )
                    if (
                        selection is not None
                        and selection != expected
                        or kind == "knowledge"
                        and data_scope != selected.get("data_scope")
                    ):
                        raise ConversationError("ASSISTANT_CONVERSATION_CONFLICT", 409)
            yield

    def owned(self, user: Any, tid: str) -> Any:
        profile = AssistantProfiles(self.server)._existing(user.id)
        row = self.server.app_runtime.gateway.thread_registry.get_thread(tid)
        if (
            user.application_id != "wanx"
            or getattr(user, "disabled", False)
            or profile is None
            or row is None
            or row.user_id != user.id
            or row.agent_id != profile.agent_id
        ):
            raise ConversationError("ASSISTANT_CONVERSATION_NOT_FOUND", 404)
        return row

    def state(self, user: Any, identity: str) -> dict[str, Any]:
        row = self.owned(user, identity)
        cid = self.repo.root(identity)
        self.owned(user, cid)
        return self.repo.get(cid) or {
            "id": cid,
            "agent_id": row.agent_id,
            "user_id": user.id,
            "active_thread_id": cid,
            "context": empty_context(),
            "revision": 0,
            "versions": [
                {
                    "thread_id": cid,
                    "kind": "original",
                    "parent_thread_id": None,
                    "target_message_id": None,
                }
            ],
        }

    def busy(self, user: Any, state: dict[str, Any]) -> bool:
        gateway = self.server.app_runtime.gateway
        return any(
            gateway.ws_hub.is_turn_active(v["thread_id"])
            or pending_hitl_payload(
                gateway.processor.hitl_coordinator.store,
                thread_id=v["thread_id"],
                agent_id=state["agent_id"],
                user_id=user.id,
            )
            for v in state["versions"]
        )

    async def validate_context(
        self, user: Any, context: dict[str, Any], *, strict: bool
    ) -> tuple[dict[str, Any], list[dict[str, str]]]:
        value = json.loads(json.dumps(context))
        errors = []
        space = value.get("space", {})
        if space.get("enabled"):
            try:
                checked = await asyncio.to_thread(
                    SpaceGrantStore(self.server.paths.root, user.id).validate,
                    space.get("selection", {}),
                    user.locale or "zh",
                )
                value["space"] = {"enabled": True, **checked}
            except Exception as exc:
                if strict:
                    raise ConversationError(
                        getattr(exc, "code", "SPACE_ACCESS_DENIED"), 403
                    ) from exc
                errors.append(
                    {
                        "source": "space",
                        "name": space.get("label", "万象空间"),
                        "code": getattr(exc, "code", "SPACE_ACCESS_DENIED"),
                    }
                )
        knowledge = value.get("knowledge", {})
        if knowledge.get("enabled"):
            reader = KnowledgeReader(
                self.server.paths.root,
                self.server.services.db,
                user.id,
                application_id="wanx",
                data_scope=knowledge.get("data_scope", "team"),
            )
            if not knowledge.get("warehouses"):
                raise ConversationError("ASSISTANT_KNOWLEDGE_DENIED", 422)
            warehouses = []
            for warehouse in knowledge.get("warehouses", []):
                wid = warehouse["id"]
                try:
                    warehouses.append(await reader.detail(wid))
                except Exception as exc:
                    if strict:
                        raise ConversationError(
                            getattr(exc, "code", "ASSISTANT_KNOWLEDGE_DENIED"), 403
                        ) from exc
                    warehouses.append(warehouse)
                    errors.append(
                        {
                            "source": "knowledge",
                            "id": wid,
                            "name": warehouse.get("name", wid),
                            "code": getattr(exc, "code", "ASSISTANT_KNOWLEDGE_UNAVAILABLE"),
                        }
                    )
            value["knowledge"] = {**knowledge, "warehouses": warehouses}
        return value, errors

    @staticmethod
    def public(state: dict[str, Any], errors: list[dict[str, str]] | None = None) -> dict[str, Any]:
        return {
            key: state[key] for key in ("id", "active_thread_id", "context", "revision", "versions")
        } | {"validation_errors": errors or []}

    async def get(self, user: Any, identity: str) -> dict[str, Any]:
        state = await asyncio.to_thread(self.state, user, identity)
        state["context"], errors = await self.validate_context(user, state["context"], strict=False)
        return self.public(state, errors)

    async def opened(self, user: Any, identity: str) -> dict[str, Any]:
        value = await self.get(user, identity)
        await asyncio.to_thread(
            self.server.services.user_repo.set_preference,
            user.id,
            "wanx_assistant_recent_conversation",
            value["id"],
        )
        return value

    async def listing(self, user: Any) -> dict[str, Any]:
        profile = await asyncio.to_thread(AssistantProfiles(self.server)._existing, user.id)
        if user.application_id != "wanx" or profile is None:
            raise ConversationError("ASSISTANT_CONVERSATION_NOT_FOUND", 404)
        rows = await asyncio.to_thread(
            self.server.app_runtime.gateway.thread_registry.list_threads,
            agent_id=profile.agent_id,
            user_id=user.id,
            limit=10000,
        )
        groups: dict[str, list[Any]] = {}
        for row in rows:
            groups.setdefault(self.repo.root(row.thread_id), []).append(row)
        items = []
        for cid, versions in groups.items():
            original = next((r for r in versions if r.thread_id == cid), None)
            if original is None:
                continue
            state = self.repo.get(cid)
            items.append(
                {
                    "thread_id": cid,
                    "active_thread_id": state["active_thread_id"] if state else cid,
                    "title": original.title,
                    "last_active": max(r.last_active for r in versions),
                    "created_at": original.created_at,
                    "model_ref": original.model_ref,
                }
            )
        account = await asyncio.to_thread(self.server.services.user_repo.get, user.id)
        preferences = json.loads(account.preferences_json or "{}") if account else {}
        recent = preferences.get("wanx_assistant_recent_conversation")
        return {
            "recent_conversation_id": recent
            if any(r["thread_id"] == recent for r in items)
            else None,
            "items": sorted(
                items,
                key=lambda r: (r["last_active"] or r["created_at"], r["thread_id"]),
                reverse=True,
            ),
        }

    async def revoke(self, user: Any, state: dict[str, Any], kind: str) -> None:
        # Revoking the stored capability itself also stops already-connected MCPs.
        store = SpaceGrantStore(self.server.paths.root, user.id)
        store.directory = (
            self.server.paths.root / ".wanx-assistant" / (kind + "-grants") / str(user.id)
        )
        tids = {v["thread_id"] for v in state["versions"]}
        for file in store.directory.glob("*.json"):
            try:
                grant = await asyncio.to_thread(store.get, file.stem, active=False)
                if grant.get("thread_id") in tids and grant.get("enabled"):
                    await asyncio.to_thread(store.revoke, file.stem)
            except (OSError, ValueError):
                continue

    async def patch(
        self,
        user: Any,
        identity: str,
        revision: int,
        context: dict[str, Any] | None,
        active: str | None,
    ) -> dict[str, Any]:
        cid = self.repo.root(identity)
        async with self.locks.setdefault(cid, asyncio.Lock()):
            state = await asyncio.to_thread(self.state, user, identity)
            if revision != state["revision"]:
                raise ConversationError("ASSISTANT_CONVERSATION_CONFLICT")
            if active and active not in {v["thread_id"] for v in state["versions"]}:
                raise ConversationError("ASSISTANT_CONVERSATION_NOT_FOUND", 404)
            if self.busy(user, state) and (
                active
                or context is not None
                and any(
                    context.get(k, {}).get("enabled") and context.get(k) != state["context"].get(k)
                    for k in ("space", "knowledge")
                )
            ):
                raise ConversationError("ASSISTANT_TURN_ACTIVE")
            if context is not None:
                normalized = dict(context)
                for kind in ("space", "knowledge"):
                    if context.get(kind) != state["context"].get(kind):
                        partial = empty_context()
                        partial[kind] = context.get(kind, {"enabled": False})
                        checked, _ = await self.validate_context(user, partial, strict=True)
                        normalized[kind] = checked[kind]
                context = normalized
            try:
                saved = await asyncio.to_thread(
                    self.repo.save,
                    cid,
                    user.id,
                    state["agent_id"],
                    revision,
                    context=context,
                    active=active,
                )
            except ConversationConflict as exc:
                raise ConversationError("ASSISTANT_CONVERSATION_CONFLICT") from exc
            if context is not None:
                for kind in ("space", "knowledge"):
                    if not context.get(kind, {}).get("enabled") or context.get(kind) != state[
                        "context"
                    ].get(kind):
                        await self.revoke(user, state, kind)
            return self.public(saved)

    async def messages(self, aid: str, tid: str) -> list[Any]:
        from langchain_core.messages import messages_from_dict

        from octop.infra.history.legacy import checkpoint_wires

        harness = self.server.app_runtime.agent_registry.get_agent(aid)
        archive = getattr(self.server.app_runtime, "history_archive", None)
        if isinstance(archive, HistoryArchive) and archive.store.segments(tid):

            async def legacy(anchor: dict[str, Any]) -> list[Any]:
                return await checkpoint_wires(harness, tid, anchor)

            return messages_from_dict(await archive.all_messages(tid, legacy))
        return await load_checkpoint_messages(harness, tid)

    def prepared_content(self, aid: str, message: Any, text: str | None) -> list[dict[str, Any]]:
        from octop.infra.agents.threads.fork import _message_text

        original = _message_text(message)
        prompt = text if text is not None else original
        files = getattr(message, "additional_kwargs", {}).get(INBOUND_ATTACHMENTS_KEY, [])
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}] if prompt else []
        registry = self.server.app_runtime.agent_registry
        cfg = registry.get_config(aid)
        root = Path(registry.resolve_workspace_dir(aid)).resolve()
        for file in files:
            raw = str(file.get("workspace_path") or "")
            host = resolve_workspace_host_path(raw, cfg) if raw else root
            if not raw or not host.is_relative_to(root) or not host.is_file():
                raise ConversationError("ASSISTANT_ATTACHMENT_EXPIRED", 409)
            mime, filename = (
                str(file.get("media_type") or "application/octet-stream"),
                str(file.get("filename") or host.name),
            )
            if mime.startswith("image/") and file.get("url"):
                content.append(
                    {
                        "type": "image",
                        "source": {"type": "url", "url": file["url"], "media_type": mime},
                        "workspace_path": raw,
                        "filename": filename,
                    }
                )
            else:
                content.append(
                    {
                        "type": "file",
                        "filename": filename,
                        "media_type": mime,
                        "workspace_path": raw,
                    }
                )
        # Content-only attachments in older checkpoints must also be revalidated.
        raw_content = getattr(message, "content", [])
        if (
            not files
            and isinstance(raw_content, list)
            and any(
                isinstance(b, dict) and b.get("type") in {"image", "image_url", "file"}
                for b in raw_content
            )
        ):
            raise ConversationError("ASSISTANT_ATTACHMENT_EXPIRED", 409)
        if not content:
            raise ConversationError("ASSISTANT_INVALID_INPUT", 422)
        return content

    async def version(self, user: Any, identity: str, body: dict[str, Any]) -> dict[str, Any]:
        from langchain_core.messages import message_to_dict

        from octop.infra.agents.threads.fork import _is_assistant_message, _msg_id
        from octop.infra.history.projection import message_inputs

        cid = self.repo.root(identity)
        async with self.locks.setdefault(cid, asyncio.Lock()):
            state = await asyncio.to_thread(self.state, user, identity)
            if state["revision"] != body["revision"]:
                raise ConversationError("ASSISTANT_CONVERSATION_CONFLICT")
            if self.busy(user, state):
                raise ConversationError("ASSISTANT_TURN_ACTIVE")
            source = body["source_thread_id"]
            if source != state["active_thread_id"]:
                raise ConversationError("ASSISTANT_CONVERSATION_CONFLICT")
            messages = await self.messages(state["agent_id"], source)
            index = next(
                (i for i, m in enumerate(messages) if _msg_id(m) == body["message_id"]), -1
            )
            if index < 0:
                raise ConversationError("ASSISTANT_MESSAGE_NOT_FOUND", 404)

            def is_user(message: Any) -> bool:
                return getattr(message, "type", "") in {"human", "user"}

            if body["kind"] == "regenerate":
                if not _is_assistant_message(messages[index]):
                    raise ConversationError("ASSISTANT_MESSAGE_NOT_FOUND", 404)
                index = next((i for i in range(index - 1, -1, -1) if is_user(messages[i])), -1)
            if index < 0 or not is_user(messages[index]):
                raise ConversationError("ASSISTANT_MESSAGE_NOT_FOUND", 404)
            content = await asyncio.to_thread(
                self.prepared_content,
                state["agent_id"],
                messages[index],
                body.get("text") if body["kind"] == "edit" else None,
            )
            prefix = messages[:index]
            registry = self.server.app_runtime.gateway.thread_registry
            source_row = self.owned(user, source)
            tid = registry.create_thread(
                agent_id=state["agent_id"],
                user_id=user.id,
                channel_type=ThreadRegistry.CHANNEL_DASHBOARD,
                session_key=ThreadRegistry.dashboard_key(
                    agent_id=state["agent_id"], user_id=user.id
                ),
                title=None,
                last_active=0,
            )
            archive = getattr(self.server.app_runtime, "history_archive", None)
            try:
                await write_checkpoint_messages(
                    self.server.app_runtime.agent_registry.get_agent(state["agent_id"]),
                    thread_id=tid,
                    messages=prefix,
                )
                turn = (
                    archive.begin(state["agent_id"], tid)
                    if isinstance(archive, HistoryArchive)
                    else None
                )
                if turn is not None and isinstance(archive, HistoryArchive):
                    await asyncio.to_thread(
                        archive.save_messages, turn, [message_to_dict(m) for m in prefix]
                    )
                    await asyncio.to_thread(archive.finish, turn["id"], "complete")
                else:
                    self.server.services.thread_message_repo.append_if_ready(
                        tid, message_inputs(prefix)
                    )
                registry.update_composer(tid, model_ref=source_row.model_ref)
                saved = self.repo.save(
                    cid,
                    user.id,
                    state["agent_id"],
                    body["revision"],
                    active=tid,
                    version={
                        "thread_id": tid,
                        "parent_thread_id": source,
                        "target_message_id": body["message_id"],
                        "kind": body["kind"],
                    },
                )
            except Exception:
                if isinstance(archive, HistoryArchive):
                    await asyncio.to_thread(archive.remove_thread, tid)
                registry.delete_thread(tid)
                raise
            return {**self.public(saved), "prepared_content": content}
