"""Owner-managed spaces and credential-bound Agent access, sharing file transactions."""

from __future__ import annotations

import hashlib
import os
import secrets
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from .service import SpaceError, validate_name
from .storage import bind_object, cleanup, directory_for, info, relocate, set_storage
from .sync import SYNC_ACTIONS, SpaceSync, policy_value


class Workspaces(SpaceSync):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        with self._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS space_connections (
                    id TEXT PRIMARY KEY, profile TEXT NOT NULL UNIQUE,
                    token_hash TEXT NOT NULL, space_id TEXT NOT NULL,
                    name TEXT NOT NULL, state TEXT NOT NULL, created REAL NOT NULL,
                    last_used REAL
                );
                CREATE TABLE IF NOT EXISTS space_grants (
                    id TEXT PRIMARY KEY, connection TEXT NOT NULL, root TEXT NOT NULL,
                    space_id TEXT NOT NULL, revoked REAL, created REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS app_folders (
                    application TEXT PRIMARY KEY, folder TEXT NOT NULL
                );
            """)

    def spaces(self) -> list[dict[str, Any]]:
        with self._db() as db:
            result = []
            for row in db.execute("SELECT * FROM spaces ORDER BY created,id"):
                item = dict(row)
                item["storage"] = info(self, db, row["id"])
                item["bytes"] = db.execute(
                    "SELECT COALESCE(SUM(size+previous_size),0) FROM entries WHERE space_id=?",
                    (row["id"],),
                ).fetchone()[0]
                item["pending_bytes"] = db.execute(
                    "SELECT COALESCE(SUM(offset),0) FROM uploads WHERE space_id=? AND state='pending'",
                    (row["id"],),
                ).fetchone()[0]
                item["sync_bytes"] = db.execute(
                    "SELECT COALESCE(SUM(size),0) FROM space_sync_records WHERE space_id=?",
                    (row["id"],),
                ).fetchone()[0]
                item["bytes"] += item["sync_bytes"]
                item["connections"] = [
                    dict(c)
                    for c in db.execute(
                        "SELECT id,name,state,created,last_used FROM space_connections WHERE space_id=?",
                        (row["id"],),
                    )
                ]
                result.append(item)
            return result

    def storage_location(self, space_id: str, path: str) -> dict[str, Any]:
        return set_storage(self, space_id, path)

    def approve(
        self,
        profile: str,
        name: str,
        space_id: str = "",
        credential: str = "",
        sync_policy: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        name = validate_name(name)
        if sync_policy is not None:
            sync_policy = policy_value(sync_policy)
        if not profile or len(profile) > 100:
            raise SpaceError("SPACE_INVALID_PROFILE")
        with self._db() as db:
            previous = db.execute(
                "SELECT * FROM space_connections WHERE profile=?", (profile,)
            ).fetchone()
            if previous and previous["state"] != "disconnected":
                if (
                    credential
                    and previous["token_hash"] == hashlib.sha256(credential.encode()).hexdigest()
                ):
                    existing_space = self._space(db, previous["space_id"])
                    return {
                        "id": previous["id"],
                        "space_id": previous["space_id"],
                        "root": existing_space["root"],
                        "token": credential,
                    }
                raise SpaceError("SPACE_ALREADY_CONNECTED", 409)
            if space_id:
                space = self._space(db, space_id)
                if (
                    space_id == "personal"
                    or db.execute(
                        "SELECT 1 FROM space_connections WHERE space_id=? AND state!='disconnected'",
                        (space_id,),
                    ).fetchone()
                ):
                    raise SpaceError("SPACE_ALREADY_CONNECTED", 409)
            else:
                space_id, root = uuid.uuid4().hex, uuid.uuid4().hex
                db.execute(
                    "INSERT INTO spaces VALUES(?,?,?,?,NULL)", (space_id, name, root, time.time())
                )
                db.execute(
                    "INSERT INTO entries(id,parent,name,kind,modified,space_id) VALUES(?,'',?,'folder',?,?)",
                    (root, self._name(db, "", name), time.time(), space_id),
                )
                space = self._space(db, space_id)
            token, connection = (
                (credential or secrets.token_urlsafe(32)),
                previous["id"] if previous else uuid.uuid4().hex,
            )
            db.execute(
                "INSERT OR REPLACE INTO space_connections VALUES(?,?,?,?,?,'active',?,NULL)",
                (
                    connection,
                    profile,
                    hashlib.sha256(token.encode()).hexdigest(),
                    space_id,
                    name,
                    time.time(),
                ),
            )
            if sync_policy is not None:
                self.set_sync_policy(
                    connection, sync_policy, self.sync_policy(connection)["revision"]
                )
            return {"id": connection, "space_id": space_id, "root": space["root"], "token": token}

    def connection_action(self, connection: str, action: str) -> dict[str, Any]:
        with self._db() as db:
            row = db.execute("SELECT * FROM space_connections WHERE id=?", (connection,)).fetchone()
            if row is None:
                raise SpaceError("SPACE_NOT_FOUND", 404)
            if action == "disconnect":
                db.execute(
                    "UPDATE space_connections SET state='disconnected',token_hash='' WHERE id=?",
                    (connection,),
                )
                db.execute(
                    "UPDATE space_grants SET revoked=? WHERE connection=?",
                    (time.time(), connection),
                )
                for upload in db.execute(
                    "SELECT id FROM agent_uploads WHERE link LIKE ? AND result IS NULL",
                    (connection + ":%",),
                ).fetchall():
                    self.upload_cancel(upload["id"])
            elif action in {"pause", "resume"}:
                self._space(db, row["space_id"])
                if row["state"] == "disconnected":
                    raise SpaceError("SPACE_AGENT_DISCONNECTED", 403)
                db.execute(
                    "UPDATE space_connections SET state=? WHERE id=?",
                    ("paused" if action == "pause" else "active", connection),
                )
            else:
                raise SpaceError("SPACE_ACTION_INVALID")
            return {"ok": True}

    def manage_space(self, space_id: str, action: str, name: str = "") -> dict[str, Any]:
        if space_id == "personal":
            raise SpaceError("SPACE_MANAGED_ROOT", 403)
        with self._db() as db:
            row = db.execute("SELECT * FROM spaces WHERE id=?", (space_id,)).fetchone()
            if row is None:
                raise SpaceError("SPACE_NOT_FOUND", 404)
            if action == "rename":
                self._space(db, space_id)
                name = validate_name(name)
                db.execute("UPDATE spaces SET name=? WHERE id=?", (name, space_id))
                db.execute(
                    "UPDATE entries SET name=?,version=version+1 WHERE id=?",
                    (self._name(db, "", name, row["root"]), row["root"]),
                )
            elif action == "trash":
                for c in db.execute(
                    "SELECT id FROM space_connections WHERE space_id=?", (space_id,)
                ).fetchall():
                    self.connection_action(c["id"], "disconnect")
                db.execute("UPDATE spaces SET trashed=? WHERE id=?", (time.time(), space_id))
            elif action == "restore":
                db.execute("UPDATE spaces SET trashed=NULL WHERE id=?", (space_id,))
            else:
                raise SpaceError("SPACE_ACTION_INVALID")
            return {"ok": True}

    def grants(self, connection: str) -> list[dict[str, Any]]:
        with self._db() as db:
            return [
                dict(r)
                for r in db.execute(
                    "SELECT g.*,e.name,e.kind FROM space_grants g LEFT JOIN entries e ON e.id=g.root WHERE connection=? ORDER BY created",
                    (connection,),
                )
            ]

    def grant(self, connection: str, root: str) -> dict[str, Any]:
        with self._db() as db:
            if not db.execute(
                "SELECT 1 FROM space_connections WHERE id=? AND state!='disconnected'",
                (connection,),
            ).fetchone():
                raise SpaceError("SPACE_AGENT_DISCONNECTED", 403)
            row = self._entry(db, root)
            grant = uuid.uuid4().hex
            db.execute(
                "INSERT INTO space_grants VALUES(?,?,?,?,NULL,?)",
                (grant, connection, root, row["space_id"], time.time()),
            )
            return {"id": grant, "root": root}

    def revoke_grant(self, connection: str, grant: str) -> None:
        with self._db() as db:
            db.execute(
                "UPDATE space_grants SET revoked=? WHERE id=? AND connection=?",
                (time.time(), grant, connection),
            )
            for upload in db.execute(
                "SELECT id FROM agent_uploads WHERE link=? AND result IS NULL",
                (connection + ":" + grant,),
            ).fetchall():
                self.upload_cancel(upload["id"])

    def agent_execute(self, token: str, action: str, grant_id: str = "", **args: Any) -> Any:
        try:
            result = self._agent_execute(token, action, grant_id, **args)
        except SpaceError as error:
            with self._db() as db:
                connection = db.execute(
                    "SELECT id,name FROM space_connections WHERE token_hash=?",
                    (hashlib.sha256(token.encode()).hexdigest(),),
                ).fetchone()
                if connection:
                    self._record(
                        db,
                        connection["id"] + ":" + (grant_id or "own"),
                        action,
                        args.get("target", ""),
                        connection["name"],
                        error.code,
                    )
            raise
        with self._db() as db:
            self._collect(db)
        return result

    def _agent_execute(self, token: str, action: str, grant_id: str = "", **args: Any) -> Any:
        with self._db() as db:
            connection = db.execute(
                "SELECT * FROM space_connections WHERE token_hash=?",
                (hashlib.sha256(token.encode()).hexdigest(),),
            ).fetchone()
            if connection is None or connection["state"] == "disconnected":
                raise SpaceError("SPACE_AGENT_DISCONNECTED", 403)
            if connection["state"] != "active":
                raise SpaceError("SPACE_AGENT_PAUSED", 403)
            space = self._space(db, connection["space_id"])
            root = space["root"]
            if action == "access":
                return {
                    "space": dict(space),
                    "grants": [g for g in self.grants(connection["id"]) if not g["revoked"]],
                    "permissions": "read-write",
                    "sync": self.sync_policy(connection["id"]),
                }
            if action in SYNC_ACTIONS:
                if grant_id:
                    raise SpaceError("SPACE_LINK_SCOPE", 403)
                result = self._sync_execute(db, connection, action, **args)
                db.execute(
                    "UPDATE space_connections SET last_used=? WHERE id=?",
                    (time.time(), connection["id"]),
                )
                if action not in {"sync-status", "task-records"}:
                    self._record(
                        db,
                        connection["id"] + ":own",
                        action,
                        result["task_id"],
                        connection["name"],
                        "ok",
                    )
                return result
            if grant_id:
                grant = db.execute(
                    "SELECT * FROM space_grants WHERE id=? AND connection=? AND revoked IS NULL",
                    (grant_id, connection["id"]),
                ).fetchone()
                if grant is None or self._entry(db, grant["root"])["space_id"] != grant["space_id"]:
                    raise SpaceError("SPACE_LINK_SCOPE", 403)
                root = grant["root"]
            target = (
                self._creation_target(action, args.get("target") or "", args.get("parent")) or root
            )
            if target == space["root"] and action in {
                "move",
                "trash",
                "restore",
                "restore-version",
            }:
                raise SpaceError("SPACE_MANAGED_ROOT", 403)
            operation = connection["id"] + ":" + (grant_id or "own")
            defaults: dict[str, Any] = {
                "parent": None,
                "name": "",
                "expected": None,
                "upload_id": "",
                "size": 0,
                "offset": 0,
                "length": 200 if action == "list" else 4194304,
                "digest": "",
                "data": b"",
            }
            defaults.update({k: v for k, v in args.items() if k in defaults})
            args["grant_id"] = grant_id
            task = self._check_sync_file(db, connection, action, args)
            cached = self._sync_file_replay(db, connection, task, action, args)
            if cached is not None:
                # A saved response never extends a grant after a resource moves away.
                self._within(db, root, target, trash=action in {"trash", "restore"})
                if cached.get("id"):
                    self._within(db, root, cached["id"], trash=action in {"trash", "restore"})
                return cached
            try:
                # A savepoint keeps failure auditing without publishing a partial mutation.
                db.execute("SAVEPOINT agent_operation")
                result = self._execute(db, operation, root, action, target, **defaults)
                self._record_sync_file(db, connection, task, action, args, result)
                db.execute("RELEASE agent_operation")
            except SpaceError:
                db.execute("ROLLBACK TO agent_operation")
                db.execute("RELEASE agent_operation")
                raise
            db.execute(
                "UPDATE space_connections SET last_used=? WHERE id=?",
                (time.time(), connection["id"]),
            )
            self._record(db, operation, action, target, connection["name"], "ok")
            return result

    def connection_audit(self, connection: str) -> list[dict[str, Any]]:
        with self._db() as db:
            return [
                dict(r)
                for r in db.execute(
                    "SELECT * FROM agent_audit WHERE link LIKE ? ORDER BY id DESC LIMIT 100",
                    (connection + ":%",),
                )
            ]

    def transfer(
        self, item_id: str, parent: str, space_id: str, copy: bool = False
    ) -> dict[str, Any]:
        created: list[Path] = []
        originals: list[Path] = []
        try:
            with self._db() as db:
                item = self._entry(db, item_id)
                self._ordinary(db, item_id)
                parent = self._parent(db, parent, space_id)
                self._folder(db, parent)
                if self._space_for(db, parent) != space_id:
                    raise SpaceError("SPACE_CONTEXT_CHANGED", 409)
                cursor = parent
                while cursor:
                    if cursor == item_id:
                        raise SpaceError("SPACE_INVALID_DESTINATION")
                    cursor = self._entry(db, cursor)["parent"]
                ids = [item_id]
                for current in ids:
                    ids.extend(
                        r[0]
                        for r in db.execute("SELECT id FROM entries WHERE parent=?", (current,))
                    )
                if copy:
                    mapping = {i: uuid.uuid4().hex for i in ids}
                    for current in ids:
                        row = self._entry(db, current, trash=True)
                        new_id = mapping[current]
                        new_parent = parent if current == item_id else mapping[row["parent"]]
                        if row["kind"] == "file":
                            bind_object(self, db, new_id, space_id)
                            # Stream copy to a new immutable object; never share lifecycle ownership.
                            with (
                                self._open(row["blob"] or current) as source,
                                self._open(new_id, write=True) as dest,
                            ):
                                created.append(self._object(new_id))
                                shutil.copyfileobj(source, dest, 4194304)
                                dest.flush()
                                os.fsync(dest.fileno())
                        db.execute(
                            "INSERT INTO entries(id,parent,name,kind,size,modified,digest,space_id,trashed) VALUES(?,?,?,?,?,?,?,?,?)",
                            (
                                new_id,
                                new_parent,
                                self._name(db, new_parent, row["name"]),
                                row["kind"],
                                row["size"],
                                time.time(),
                                row["digest"],
                                space_id,
                                row["trashed"],
                            ),
                        )
                    result = dict(self._entry(db, mapping[item_id]))
                else:
                    required: dict[str, tuple[int, str]] = {}
                    for current in ids:
                        row = self._entry(db, current, trash=True)
                        if row["kind"] == "file":
                            required[row["blob"] or current] = (row["size"], row["digest"] or "")
                            if row["previous_blob"]:
                                required[row["previous_blob"]] = (
                                    row["previous_size"],
                                    row["previous_digest"] or "",
                                )
                    originals, created = relocate(
                        self, db, set(required), directory_for(self, db, space_id), required
                    )
                    db.execute(
                        "UPDATE entries SET parent=?,name=? WHERE id=?",
                        (parent, self._name(db, parent, item["name"], item_id), item_id),
                    )
                    for current in ids:
                        db.execute(
                            "UPDATE entries SET space_id=?,version=version+1,modified=? WHERE id=?",
                            (space_id, time.time(), current),
                        )
                        if item["space_id"] != space_id:
                            db.execute(
                                "UPDATE agent_links SET revoked=? WHERE root=?",
                                (time.time(), current),
                            )
                            db.execute(
                                "UPDATE space_grants SET revoked=? WHERE root=?",
                                (time.time(), current),
                            )
                    result = dict(self._entry(db, item_id))
        except BaseException:
            cleanup(self, created)
            raise
        cleanup(self, originals)
        return result

    def app_folder(self, application: str, name: str) -> dict[str, Any]:
        if not application or len(application) > 200:
            raise SpaceError("SPACE_INVALID_PROFILE")
        with self._db() as db:
            previous = db.execute(
                "SELECT folder FROM app_folders WHERE application=?", (application,)
            ).fetchone()
            if previous:
                try:
                    return dict(self._entry(db, previous["folder"]))
                except SpaceError:
                    pass
            container = db.execute(
                "SELECT id FROM entries WHERE parent='' AND space_id='personal' AND name='应用文件' AND kind='folder' AND trashed IS NULL"
            ).fetchone()
            parent = container["id"] if container else self.mkdir("", "应用文件")["id"]
            folder = self.mkdir(parent, validate_name(name or application))
            db.execute(
                "INSERT OR REPLACE INTO app_folders VALUES(?,?)", (application, folder["id"])
            )
            return folder
