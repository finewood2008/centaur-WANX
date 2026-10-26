"""Explicit assistant knowledge scopes; Starlink remains the knowledge owner."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from octop.i18n import tr
from octop.infra.agents.assistant_space import SpaceGrantStore
from octop.infra.db.pool import DatabasePool
from octop.infra.db.repos.assistant_knowledge import KnowledgeAccessConflict, KnowledgeAccessRepo
from octop.infra.db.repos.users import UserRepo
from octop.infra.personal_space.service import SpaceError
from octop.infra.semantica.client import SemanticaClient, SemanticaError

WAREHOUSE = re.compile(r"^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$")
EVIDENCE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class KnowledgeError(SemanticaError):
    pass


class KnowledgeSources:
    """Private source metadata; no document bodies or access credentials."""

    def __init__(self, home: Path, user_id: int):
        self.root = home / ".wanx-assistant" / "knowledge-sources" / str(user_id)

    def directory(self, thread_id: str) -> Path:
        if not EVIDENCE.fullmatch(thread_id):
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
        return self.root / thread_id

    def save(self, thread_id: str, sources: list[dict[str, Any]]) -> None:
        directory = self.directory(thread_id)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        for source in sources:
            identity = hashlib.sha256(
                (source["warehouse_id"] + ":" + source["evidence_id"]).encode()
            ).hexdigest()
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=directory, delete=False
            ) as file:
                json.dump(source, file, ensure_ascii=False)
                temporary = Path(file.name)
            os.replace(temporary, directory / (identity + ".json"))

    def list(self, thread_id: str) -> list[dict[str, Any]]:
        files = sorted(
            self.directory(thread_id).glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True
        )[:500]
        return [json.loads(p.read_text(encoding="utf-8")) for p in files]


class KnowledgeGrantStore(SpaceGrantStore):
    def __init__(self, home: Path, user_id: int):
        super().__init__(home, user_id)
        self.directory = home / ".wanx-assistant" / "knowledge-grants" / str(user_id)

    def get(self, grant_id: str, *, active: bool = True) -> dict[str, Any]:
        try:
            return super().get(grant_id, active=active)
        except SpaceError as exc:
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_EXPIRED", 403) from exc


class KnowledgeReader:
    def __init__(
        self,
        home: Path,
        db: DatabasePool,
        user_id: int,
        grant_id: str | None = None,
        application_id: str = "wanx",
        data_scope: str | None = None,
    ):
        self.home, self.db, self.user_id, self.grant_id = home, db, user_id, grant_id
        self.application_id = application_id
        self.data_scope = data_scope
        self.repo = KnowledgeAccessRepo(db)
        self.store = KnowledgeGrantStore(home, user_id)

    def identity(self) -> tuple[Any, SemanticaClient]:
        user = UserRepo(self.db).get(self.user_id)
        if not user or user.disabled or self.application_id != "wanx":
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
        scope = self.data_scope or "team"
        if self.grant_id:
            scope = self.store.get(self.grant_id).get("data_scope", "team")
            if self.data_scope and scope != self.data_scope:
                raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
        if scope not in {"personal", "team"}:
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
        client = SemanticaClient.from_file(
            self.home / "semantica.json", user.id, "wanx", team=scope == "team"
        )
        if client.team:
            client.organization_permissions = ["read"]
        return user, client

    def check(self, warehouse: str | None = None) -> tuple[Any, SemanticaClient]:
        user, client = self.identity()
        if self.grant_id:
            grant = self.store.get(self.grant_id)
            if grant["box_id"] != client.config["box_id"]:
                raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
            if warehouse and warehouse not in grant["warehouses"]:
                raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
        if warehouse and (
            not WAREHOUSE.fullmatch(warehouse)
            or client.team
            and user.role != "admin"
            and not self.repo.allowed(str(client.config["box_id"]), warehouse, user.id)
        ):
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
        return user, client

    async def detail(self, warehouse: str) -> dict[str, Any]:
        _, client = await asyncio.to_thread(self.check, warehouse)
        value = await client.request("GET", "/warehouses/" + warehouse)
        await asyncio.to_thread(self.check, warehouse)
        if value.get("id") != warehouse or value.get("state", "active") != "active":
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_UNAVAILABLE", 409)
        return {"id": warehouse, "name": value["name"]}

    async def catalog(self) -> list[dict[str, Any]]:
        user, client = await asyncio.to_thread(self.identity)
        if not client.team or user.role == "admin":
            listing = await client.request("GET", "/warehouses")
            ids = [
                row["id"]
                for row in listing.get("items", [])
                if row.get("state", "active") == "active"
            ]
        else:
            ids = await asyncio.to_thread(
                self.repo.warehouses, str(client.config["box_id"]), user.id
            )
        output = []
        for wid in ids:
            try:
                output.append({**await self.detail(wid), "available": True})
            except SemanticaError as exc:
                if not client.team or user.role == "admin":
                    raise
                output.append({"id": wid, "name": wid, "available": False, "code": exc.code})
        return output

    async def access(self, warehouse: str, update: dict[str, Any] | None = None) -> dict[str, Any]:
        user, client = await asyncio.to_thread(self.identity)
        if not client.team or user.role != "admin":
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
        detail = await self.detail(warehouse)
        user, fresh_client = await asyncio.to_thread(self.identity)
        if user.role != "admin" or fresh_client.config["box_id"] != client.config["box_id"]:
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
        members = await asyncio.to_thread(UserRepo(self.db).list, include_disabled=True)
        members = list(members)
        if update is not None:
            selected = sorted(set(update["members"])) if update["audience"] == "selected" else []
            if update["audience"] == "selected" and (
                not selected or set(selected) - {m.id for m in members if not m.disabled}
            ):
                raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 422)
            try:
                rule = await asyncio.to_thread(
                    self.repo.set,
                    str(client.config["box_id"]),
                    warehouse,
                    user.id,
                    update["audience"],
                    selected,
                    update["revision"],
                )
            except KnowledgeAccessConflict as exc:
                raise KnowledgeError("ASSISTANT_KNOWLEDGE_CONFLICT", 409) from exc
        else:
            rule = await asyncio.to_thread(self.repo.get, str(client.config["box_id"]), warehouse)
        return {
            "warehouse": detail,
            **rule,
            "users": [
                {
                    "role": m.role,
                    "id": m.id,
                    "name": m.display_name or m.username,
                    "disabled": bool(m.disabled),
                }
                for m in members
            ],
        }

    async def read(
        self,
        operation: str,
        warehouse: str,
        *,
        query: str = "",
        evidence_id: str = "",
        limit: int = 10,
        offset: int = 0,
    ) -> dict[str, Any]:
        if operation not in {"warehouse", "documents", "graph", "search", "evidence"}:
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
        if not 1 <= limit <= 200 or offset < 0 or len(query) > 2000:
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 422)
        detail = await self.detail(warehouse)
        _, client = await asyncio.to_thread(self.check, warehouse)
        prefix = "/warehouses/" + warehouse
        if operation == "warehouse":
            result: Any = detail
        elif operation == "search":
            if not query.strip():
                raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 422)
            result = await client.request(
                "POST", prefix + "/search", payload={"query": query, "limit": min(limit, 50)}
            )
        elif operation == "evidence":
            if not EVIDENCE.fullmatch(evidence_id):
                raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 422)
            result = await client.request("GET", prefix + "/evidence/" + evidence_id)
        else:
            result = await client.request(
                "GET",
                prefix + "/" + operation,
                query={
                    "limit": str(limit),
                    **({"offset": str(offset)} if operation == "documents" else {}),
                },
            )
        await asyncio.to_thread(self.check, warehouse)
        sources = []
        for row in result.get("items", []) if isinstance(result, dict) else []:
            identity = row.get("evidence_id") or row.get("id")
            if operation == "search" and isinstance(identity, str) and EVIDENCE.fullmatch(identity):
                sources.append(
                    {
                        "warehouse_id": warehouse,
                        "warehouse_name": detail["name"],
                        "evidence_id": identity,
                        "document_id": row.get("document_id"),
                        "document_name": row.get("document_name")
                        or row.get("original_name")
                        or row.get("document_id")
                        or identity,
                        "locator": row.get("locator"),
                    }
                )
        if sources and self.grant_id:
            grant = await asyncio.to_thread(self.store.get, self.grant_id)
            if grant.get("thread_id"):
                await asyncio.to_thread(
                    KnowledgeSources(self.home, self.user_id).save, grant["thread_id"], sources
                )
            await asyncio.to_thread(self.check, warehouse)
        return {"warehouse": detail, "result": result, "assistant_knowledge_sources": sources}

    async def selected(self, operation: str, warehouse: str = "", **kwargs: Any) -> dict[str, Any]:
        await asyncio.to_thread(self.check)
        if not self.grant_id:
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
        grant = await asyncio.to_thread(self.store.get, self.grant_id)
        ids = [warehouse] if warehouse else grant["warehouses"]
        output, failures = [], []
        for wid in ids:
            try:
                output.append(await self.read(operation, wid, **kwargs))
            except SemanticaError as exc:
                failures.append({"warehouse_id": wid, "code": exc.code})
        await asyncio.to_thread(self.check)
        return {
            "warehouses": output,
            "unavailable": failures,
            "assistant_knowledge_sources": [
                s for row in output for s in row["assistant_knowledge_sources"]
            ],
        }


class AssistantKnowledgeGrants:
    def __init__(self, server: Any):
        self.server = server
        self.locks: dict[int, asyncio.Lock] = {}

    async def update(
        self,
        user: Any,
        *,
        enabled: bool,
        grant_id: str | None,
        warehouses: list[str] | None,
        thread_id: str | None,
        data_scope: str = "team",
    ) -> dict[str, Any]:
        from octop.infra.agents.assistant_profile import AssistantProfiles
        from octop.infra.connectors.service import ConnectorService

        if user.application_id != "wanx":
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
        async with self.locks.setdefault(user.id, asyncio.Lock()):
            reader = KnowledgeReader(
                self.server.paths.root, self.server.services.db, user.id, data_scope=data_scope
            )
            _, client = await asyncio.to_thread(reader.identity)
            profile = await asyncio.to_thread(AssistantProfiles(self.server)._existing, user.id)
            if not profile:
                raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
            if thread_id:
                row = await asyncio.to_thread(
                    self.server.app_runtime.gateway.thread_registry.get_thread, thread_id
                )
                if not row or row.user_id != user.id or row.agent_id != profile.agent_id:
                    raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
            store = reader.store
            connectors = ConnectorService(
                repo=self.server.services.repos.connector_repo,
                secret_repo=self.server.services.secret_repo,
                settings_repo=self.server.services.settings_repo,
                config=self.server.services.config,
            )
            servers = await asyncio.to_thread(connectors.get_custom_servers, user.id)
            if grant_id:
                grant = await asyncio.to_thread(store.get, grant_id, active=False)
                if grant.get("data_scope", "team") != data_scope:
                    raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
            if grant_id and (not enabled or warehouses is not None):
                await asyncio.to_thread(store.revoke, grant_id)
                servers.pop("wanx_knowledge_" + grant_id, None)
                await asyncio.to_thread(connectors.put_custom_servers, user.id, servers)
            if not enabled:
                return {"enabled": False}
            if warehouses is not None:
                ids = list(dict.fromkeys(warehouses))
                if not ids or len(ids) > 100:
                    raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 422)
                details = [await reader.detail(wid) for wid in ids]
                data = {
                    "id": uuid.uuid4().hex,
                    "user_id": user.id,
                    "enabled": True,
                    "expires": time.time() + 7200,
                    "thread_id": thread_id,
                    "box_id": client.config["box_id"],
                    "data_scope": data_scope,
                    "warehouses": ids,
                }
                name = "wanx_knowledge_" + data["id"]
                await asyncio.to_thread(store.save, data)
                servers[name] = {
                    "transport": "stdio",
                    "command": sys.executable,
                    "args": [
                        "-P",
                        "-m",
                        "octop.infra.agents.assistant_knowledge_mcp",
                        "--home",
                        str(self.server.paths.root),
                        "--user-id",
                        str(user.id),
                        "--grant-id",
                        data["id"],
                        "--locale",
                        user.locale or "zh",
                    ],
                    "env": {"PYTHONPATH": str(Path(__file__).resolve().parents[3])},
                    "enabled": True,
                    "display_name": tr("assistant.knowledge_name", user.locale)
                    + " · "
                    + data["id"][:6],
                }
                try:
                    await asyncio.to_thread(connectors.put_custom_servers, user.id, servers)
                except Exception:
                    await asyncio.to_thread(store.revoke, data["id"])
                    raise
            elif grant_id:
                reader.grant_id = grant_id
                await asyncio.to_thread(reader.check)
                data = await asyncio.to_thread(store.get, grant_id)
                if data.get("thread_id") and thread_id and data["thread_id"] != thread_id:
                    raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
                details = [await reader.detail(wid) for wid in data["warehouses"]]
                name = "wanx_knowledge_" + grant_id
                if not servers.get(name, {}).get("enabled"):
                    raise KnowledgeError("ASSISTANT_KNOWLEDGE_EXPIRED", 403)
                data["thread_id"] = thread_id or data.get("thread_id")
                data["expires"] = time.time() + 7200
                await asyncio.to_thread(store.save, data)
            else:
                raise KnowledgeError("ASSISTANT_KNOWLEDGE_EXPIRED", 403)
            return {
                "enabled": True,
                "grant_id": data["id"],
                "mcp_server": name,
                "warehouses": details,
            }
