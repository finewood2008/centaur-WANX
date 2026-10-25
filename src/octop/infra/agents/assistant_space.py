"""Explicit, revocable, owner-scoped space grants for assistant turns."""

from __future__ import annotations

import asyncio
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
from octop.infra.connectors.service import ConnectorService
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.personal_space.service import SpaceError
from octop.infra.personal_space.workspaces import Workspaces


class SpaceGrantStore:
    """System metadata, separate from user files and agent workspaces."""

    def __init__(self, home: Path, user_id: int) -> None:
        self.home, self.user_id = home, user_id
        self.directory = home / ".wanx-assistant" / "space-grants" / str(user_id)

    def _path(self, grant_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{32}", grant_id):
            raise SpaceError("SPACE_ACCESS_DENIED", 403)
        return self.directory / (grant_id + ".json")

    def save(self, data: dict[str, Any]) -> None:
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=self.directory, delete=False
        ) as file:
            json.dump(data, file, ensure_ascii=False)
            temporary = Path(file.name)
        os.replace(temporary, self._path(data["id"]))

    def get(self, grant_id: str, *, active: bool = True) -> dict[str, Any]:
        try:
            data = json.loads(self._path(grant_id).read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError) as exc:
            raise SpaceError("SPACE_ACCESS_DENIED", 403) from exc
        if not isinstance(data, dict):
            raise SpaceError("SPACE_ACCESS_DENIED", 403)
        if (
            data.get("user_id") != self.user_id
            or active
            and (not data.get("enabled") or data.get("expires", 0) <= time.time())
        ):
            raise SpaceError("SPACE_ACCESS_DENIED", 403)
        return dict(data)

    def validate(self, selection: dict[str, str], locale: str = "zh") -> dict[str, Any]:
        space = Workspaces(self.home / ".wanx-personal-space", self.user_id)
        mode = selection.get("mode")
        chosen: dict[str, str] = {"mode": str(mode)}
        if mode == "all":
            label = tr("assistant.scope_all", locale)
        elif mode in {"space", "folder"}:
            sid = selection.get("space_id", "personal")
            record = next(
                (row for row in space.spaces() if row["id"] == sid and row.get("trashed") is None),
                None,
            )
            if record is None:
                raise SpaceError("SPACE_NOT_FOUND", 404)
            chosen["space_id"] = sid
            label = record["name"]
            if mode == "folder":
                folder = space.metadata(selection.get("folder_id", ""))
                if folder["kind"] != "folder" or folder["space_id"] != sid:
                    raise SpaceError("SPACE_ACCESS_DENIED", 403)
                chosen["folder_id"] = folder["id"]
                label += " / " + folder["name"]
        else:
            raise SpaceError("SPACE_INVALID_RANGE")
        return {"selection": chosen, "label": label}

    def create(self, selection: dict[str, str], locale: str = "zh") -> dict[str, Any]:
        checked = self.validate(selection, locale)
        data = {
            "id": uuid.uuid4().hex,
            "user_id": self.user_id,
            "enabled": True,
            **checked,
            "thread_id": None,
            "expires": time.time() + 7200,
        }
        self.save(data)
        return data

    def revoke(self, grant_id: str) -> dict[str, Any]:
        data = self.get(grant_id, active=False)
        data["enabled"] = False
        self.save(data)
        return data


class AssistantSpaceGrants:
    def __init__(self, server: Any) -> None:
        self.server = server
        self.locks: dict[int, asyncio.Lock] = {}

    async def update(
        self,
        user: Any,
        *,
        enabled: bool,
        grant_id: str | None,
        selection: dict[str, str] | None,
        thread_id: str | None,
    ) -> dict[str, Any]:
        if user.application_id != "wanx":
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        async with self.locks.setdefault(user.id, asyncio.Lock()):
            return await asyncio.to_thread(
                self._update, user, enabled, grant_id, selection, thread_id
            )

    def _update(
        self,
        user: Any,
        enabled: bool,
        grant_id: str | None,
        selection: dict[str, str] | None,
        thread_id: str | None,
    ) -> dict[str, Any]:
        from octop.infra.agents.assistant_profile import AssistantProfiles

        profile = AssistantProfiles(self.server)._existing(user.id)
        if profile is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        if thread_id:
            row = self.server.app_runtime.gateway.thread_registry.get_thread(thread_id)
            if not row or row.user_id != user.id or row.agent_id != profile.agent_id:
                raise OctopError.localized(ErrorCode.NOT_FOUND)
        store = SpaceGrantStore(self.server.paths.root, user.id)
        connectors = ConnectorService(
            repo=self.server.services.repos.connector_repo,
            secret_repo=self.server.services.secret_repo,
            settings_repo=self.server.services.settings_repo,
            config=self.server.services.config,
        )
        servers = connectors.get_custom_servers(user.id)
        if grant_id and (not enabled or selection is not None):
            store.revoke(grant_id)
            servers.pop("wanx_space_" + grant_id, None)
            connectors.put_custom_servers(user.id, servers)
        if not enabled:
            return {"enabled": False}
        if selection is not None:
            data = store.create(selection, getattr(user, "locale", None) or "zh")
            name = "wanx_space_" + data["id"]
            servers[name] = {
                "transport": "stdio",
                "command": sys.executable,
                "args": [
                    "-P",
                    "-m",
                    "octop.infra.agents.assistant_space_mcp",
                    "--home",
                    str(self.server.paths.root),
                    "--user-id",
                    str(user.id),
                    "--grant-id",
                    data["id"],
                    "--locale",
                    getattr(user, "locale", None) or "zh",
                ],
                "env": {"PYTHONPATH": str(Path(__file__).resolve().parents[3])},
                "enabled": True,
                "display_name": tr(
                    "assistant.space_mcp_name", getattr(user, "locale", None) or "zh"
                )
                + " · "
                + data["id"][:6],
            }
            try:
                connectors.put_custom_servers(user.id, servers)
            except Exception:
                store.revoke(data["id"])
                raise
        elif grant_id:
            data = store.get(grant_id)
            name = "wanx_space_" + grant_id
            if not servers.get(name, {}).get("enabled", False):
                raise SpaceError("SPACE_ACCESS_DENIED", 403)
        else:
            raise SpaceError("SPACE_ACCESS_DENIED", 403)
        if data.get("thread_id") and thread_id and data["thread_id"] != thread_id:
            raise SpaceError("SPACE_ACCESS_DENIED", 403)
        if thread_id:
            data["thread_id"] = thread_id
        data["expires"] = time.time() + 7200
        store.save(data)
        return {
            "enabled": True,
            "grant_id": data["id"],
            "mcp_server": name,
            "selection": data["selection"],
            "label": data["label"],
        }
