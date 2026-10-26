"""Clipboard child operations checked inside the personal-space transaction."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from functools import wraps
from pathlib import Path
from typing import Any

from .service import SpaceError
from .workspaces import Workspaces


def _scoped(name: str) -> Any:
    """Keep boundary validation and the actual existing operation in one TX."""
    original = getattr(Workspaces, name)

    @wraps(original)
    def operation(self: ClipboardSpace, *args: Any, **kwargs: Any) -> Any:
        self.live()
        with self._db() as db:
            self._check_scope(db, name, args, kwargs)
            result = original(self, *args, **kwargs)
            self.live()
            return result

    return operation


class ClipboardSpace(Workspaces):
    def __init__(
        self,
        root: Path,
        user_id: int,
        *,
        clipboard_scope: Mapping[str, Any],
        live: Callable[[], None],
    ) -> None:
        self.clipboard_scope = dict(clipboard_scope)
        self.live = live
        super().__init__(root, user_id)
        with self._db() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS local_clipboard_exports (upload_id TEXT PRIMARY KEY, parent TEXT NOT NULL)"
            )

    @staticmethod
    def _deny() -> None:
        raise SpaceError("SPACE_LINK_SCOPE", 403)

    def _within_clipboard(self, db: Any, identifier: str) -> None:
        root = db.execute(
            "SELECT folder FROM app_folders WHERE application='wanx.clipboard'"
        ).fetchone()
        if root is None or not identifier:
            self._deny()
        seen: set[str] = set()
        while identifier:
            if identifier in seen or len(seen) >= 256:
                self._deny()
            seen.add(identifier)
            row = db.execute(
                "SELECT parent,space_id,trashed FROM entries WHERE id=?", (identifier,)
            ).fetchone()
            if row is None or row["space_id"] != "personal" or row["trashed"] is not None:
                self._deny()
            if identifier == root["folder"]:
                return
            identifier = row["parent"]
        self._deny()

    def _check_scope(
        self, db: Any, name: str, args: tuple[Any, ...], kwargs: dict[str, Any]
    ) -> None:
        scope = self.clipboard_scope
        export_id, target = scope["exportId"], scope["parent"]
        if name == "app_folder":
            if args != ("wanx.clipboard", "超级剪贴板"):
                self._deny()
            return
        if name == "agent_execute":
            # Existing capability engine checks active connection/task policy.
            # Only status of its own root is inspected, never caller-picked files.
            if len(args) < 2 or args[1] not in {"access", "stat"} or len(args) > 2 and args[2]:
                self._deny()
            if any(
                kwargs.get(key)
                for key in (
                    "target",
                    "parent",
                    "name",
                    "upload_id",
                    "data",
                    "grant_id",
                    "request_id",
                    "operation_id",
                    "title",
                    "categories",
                    "progress",
                )
            ):
                self._deny()
            if args[1] == "stat" and (
                not kwargs.get("task_id") or kwargs.get("policy_revision") is None
            ):
                self._deny()
            return
        if name == "upload_create":
            parent, _, _, upload_id, *space = args
            if space and space != ["personal"]:
                self._deny()
            if upload_id == export_id:
                if parent != target:
                    self._deny()
                if target and self._entry(db, target)["space_id"] != "personal":
                    self._deny()
                entry = db.execute("SELECT 1 FROM entries WHERE id=?", (upload_id,)).fetchone()
                existing = db.execute("SELECT 1 FROM uploads WHERE id=?", (upload_id,)).fetchone()
                admitted = db.execute(
                    "SELECT parent FROM local_clipboard_exports WHERE upload_id=?", (upload_id,)
                ).fetchone()
                if entry or existing and (admitted is None or admitted["parent"] != target):
                    self._deny()
                db.execute(
                    "INSERT OR IGNORE INTO local_clipboard_exports VALUES (?,?)",
                    (upload_id, target),
                )
            else:
                self._within_clipboard(db, parent)
                if db.execute("SELECT 1 FROM entries WHERE id=?", (upload_id,)).fetchone():
                    self._within_clipboard(db, upload_id)
            return
        if name.startswith("upload_"):
            identifier = args[0]
            row = db.execute(
                "SELECT parent,space_id FROM uploads WHERE id=?", (identifier,)
            ).fetchone()
            if row is None:
                raise SpaceError("SPACE_NOT_FOUND", 404)
            if identifier == export_id:
                admitted = db.execute(
                    "SELECT parent FROM local_clipboard_exports WHERE upload_id=?", (identifier,)
                ).fetchone()
                if (
                    admitted is None
                    or admitted["parent"] != target
                    or row["parent"] != target
                    or row["space_id"] != "personal"
                ):
                    self._deny()
            else:
                self._within_clipboard(db, row["parent"])
            return
        identifier = args[0]
        # Preflight proves absence, never discloses an existing personal item.
        if (
            name == "metadata"
            and db.execute("SELECT 1 FROM entries WHERE id=?", (identifier,)).fetchone() is None
        ):
            return
        self._within_clipboard(db, identifier)
        if name == "move":
            self._within_clipboard(db, args[1])

    app_folder = _scoped("app_folder")
    agent_execute = _scoped("agent_execute")
    upload_create = _scoped("upload_create")
    upload_status = _scoped("upload_status")
    upload_chunk = _scoped("upload_chunk")
    upload_complete = _scoped("upload_complete")
    upload_cancel = _scoped("upload_cancel")
    metadata = _scoped("metadata")
    read_chunk = _scoped("read_chunk")
    trash = _scoped("trash")
    move = _scoped("move")
    restore_version = _scoped("restore_version")
