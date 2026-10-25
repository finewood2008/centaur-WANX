"""Credential-bound logical disks. Never substitute a folder in personal space.

The registry lock fences key changes through each underlying file transaction.
Company disks share a namespace but retain connection-level write authority.
"""

from __future__ import annotations

import base64
import binascii
import json
import time
from typing import Any

from .agent_hub import READS, WRITES, AgentHub, checksum
from .service import SpaceError, validate_name

CATEGORIES = {
    "memory": "记忆与上下文",
    "conversations": "对话记录",
    "files": "文件资料",
    "artifacts": "构建物",
}


class McpDrives(AgentHub):
    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        with self.db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS space_mcp_drives (
                agent TEXT PRIMARY KEY, space_id TEXT UNIQUE NOT NULL,
                root TEXT UNIQUE NOT NULL, directories TEXT NOT NULL,
                paused INTEGER NOT NULL DEFAULT 0
            )""")

    def provision(self, aid: str) -> None:
        # IDs derive from the server-issued identity, making recovery across the
        # two SQLite files idempotent. IDs are locators, never authorization.
        with self.db() as db:
            agent = self.agent(db, aid)
            sid = checksum("mcp-disk:" + aid)[:32]
            root = checksum("mcp-root:" + aid)[:32]
            dirs = {k: checksum(aid + ":" + k)[:32] for k in CATEGORIES}
            store = self.storage(agent["destination"])
            with store._db() as files:
                files.execute(
                    "INSERT OR IGNORE INTO spaces VALUES(?,?,?,?,NULL)",
                    (sid, agent["name"], root, time.time()),
                )
                for entry, parent, name in [(root, "", agent["name"])] + [
                    (dirs[k], root, name) for k, name in CATEGORIES.items()
                ]:
                    files.execute(
                        "INSERT OR IGNORE INTO entries(id,parent,name,kind,modified,space_id) VALUES(?,?,?,'folder',?,?)",
                        (entry, parent, store._name(files, parent, name, entry), time.time(), sid),
                    )
                    row = store._entry(files, entry)
                    if (row["space_id"], row["parent"], row["kind"]) != (sid, parent, "folder"):
                        raise SpaceError("MCP_DRIVE_INVALID", 409)
                if store._space(files, sid)["root"] != root:
                    raise SpaceError("MCP_DRIVE_INVALID", 409)
            db.execute(
                "INSERT OR IGNORE INTO space_mcp_drives(agent,space_id,root,directories) VALUES(?,?,?,?)",
                (aid, sid, root, json.dumps(dirs)),
            )

    def drive(self, db: Any, aid: str, *, write: bool = False) -> dict[str, Any]:
        agent = self.agent(db, aid, owner=False)
        row = db.execute("SELECT * FROM space_mcp_drives WHERE agent=?", (aid,)).fetchone()
        if row is None:
            raise SpaceError("MCP_DRIVE_NOT_READY", 409)
        writable = agent["actor"] == self.actor or (
            self.admin and agent["destination"] == "company"
        )
        if write and not writable:
            raise SpaceError("MCP_DRIVE_READ_ONLY", 403)
        return {
            "id": row["space_id"],
            "space_id": row["space_id"],
            "root": row["root"],
            "name": agent["name"],
            "connection_id": aid,
            "domain": agent["destination"],
            "member": agent["member"],
            "owner": agent["actor"],
            "writable": writable,
            "manageable": writable,
            "directories": json.loads(row["directories"]),
            "paused": bool(row["paused"]),
            "kind": "agent-drive",
            "trashed": None,
        }

    def drives(self) -> list[dict[str, Any]]:
        with self.db() as db:
            ids = [
                r[0]
                for r in db.execute(
                    "SELECT a.id FROM agents a JOIN space_mcp_drives d ON d.agent=a.id "
                    "WHERE a.actor=? OR a.destination='company' ORDER BY a.created,a.id",
                    (self.actor,),
                )
            ]
            result = [self.drive(db, aid) for aid in ids]
            for item in result:
                store = self.storage(item["domain"])
                disk = next(s for s in store.spaces() if s["id"] == item["id"])
                item.update({k: disk[k] for k in ("bytes", "pending_bytes", "storage")})
            return result

    def manage_drive(self, aid: str, action: str, name: str = "") -> dict[str, Any]:
        with self.db() as db:
            d = self.drive(db, aid, write=True)
            if action in {"pause", "resume"}:
                db.execute(
                    "UPDATE space_mcp_drives SET paused=? WHERE agent=?",
                    (int(action == "pause"), aid),
                )
            elif action == "rename":
                name = validate_name(name)
                store = self.storage(d["domain"])
                with store._db() as files:
                    files.execute("UPDATE spaces SET name=? WHERE id=?", (name, d["id"]))
                    files.execute(
                        "UPDATE entries SET name=? WHERE id=?",
                        (store._name(files, "", name, d["root"]), d["root"]),
                    )
                db.execute("UPDATE agents SET name=? WHERE id=?", (name, aid))
            else:
                raise SpaceError("SPACE_ACTION_INVALID")
            return {"ok": True, "space_id": d["id"]}

    def drive_operation(self, db: Any, aid: str, body: dict[str, Any]) -> Any:
        d = self.drive(db, aid, write=body["action"] in WRITES)
        action = body["action"]
        if action not in READS | WRITES:
            raise SpaceError("AGENT_READ_ONLY", 403)
        target = body.get("target", "")
        parent = body.get("parent")
        if action == "mkdir" and parent is not None:
            if target and target != parent:
                raise SpaceError("SPACE_INVALID_DESTINATION")
            target = parent
        target = target or (d["directories"]["files"] if action == "begin-write" else d["root"])
        try:
            raw = base64.b64decode(body.get("data", ""), validate=True)
        except (ValueError, binascii.Error) as error:
            raise SpaceError("AGENT_INPUT_INVALID") from error
        store = self.storage(d["domain"])
        with store._db() as files:
            result = store._execute(
                files,
                aid + ":disk",
                d["root"],
                action,
                target,
                parent,
                body.get("name", ""),
                body.get("expected"),
                body.get("upload_id", ""),
                body.get("size", 0),
                body.get("offset", 0),
                body.get("length", 200),
                body.get("digest", ""),
                raw,
            )
            store._record(files, aid + ":disk", action, target, self.member, "ok")
            if action == "read":
                content, info = result
                return {
                    "data": base64.b64encode(content).decode(),
                    "encoding": "base64",
                    "size": len(content),
                    "version": info["version"],
                    "digest": info["digest"],
                    "chunkDigest": checksum(content),
                }
            return result

    def drive_files(self, aid: str, action: str, p: dict[str, Any]) -> Any:
        """Private management facade using the existing versioned file engine.

        Every call rechecks the human's identity. Registry and file locks remain
        held through commit, so read-only callers cannot finish an old upload.
        """
        reads = {"list", "stat", "read", "upload-status"}
        writes = {
            "mkdir",
            "move",
            "trash",
            "restore",
            "purge",
            "previous",
            "upload-create",
            "upload-chunk",
            "upload-complete",
            "upload-cancel",
        }
        if action not in reads | writes:
            raise SpaceError("SPACE_ACTION_INVALID")
        with self.db() as db:
            d = self.drive(db, aid, write=action in writes)
            store = self.storage(d["domain"])
            with store._db() as files:
                item = p.get("id", "")
                parent = p.get("parent") or d["root"]
                if action.startswith("upload-") and action != "upload-create":
                    upload = store.upload_status(item)
                    store._within(files, d["root"], upload["parent"])
                elif action in {"list", "mkdir", "upload-create"}:
                    store._within(files, d["root"], parent)
                else:
                    # Recovery operations need to inspect a trashed entry too.
                    row = files.execute(
                        "SELECT * FROM entries WHERE id=? AND space_id=?", (item, d["id"])
                    ).fetchone()
                    if row is None:
                        raise SpaceError("SPACE_NOT_FOUND", 404)
                    if action in writes and item in [d["root"], *d["directories"].values()]:
                        raise SpaceError("SPACE_MANAGED_ROOT", 403)
                if action == "list":
                    return store.listing(parent, p.get("trash", False), d["id"])
                if action == "stat":
                    return store.metadata(item)
                if action == "read":
                    raw, info = store.read_chunk(
                        item, p.get("offset", 0), p.get("length", 1024 * 1024)
                    )
                    return {
                        "data": base64.b64encode(raw).decode(),
                        "info": info,
                        "chunkDigest": checksum(raw),
                    }
                if action == "mkdir":
                    return store.mkdir(parent, p["name"], d["id"])
                if action == "move":
                    store._within(files, d["root"], parent)
                    return store.move(item, parent, p["name"])
                if action == "trash":
                    store.trash(item)
                    return {"ok": True}
                if action == "restore":
                    return store.restore(item)
                if action == "purge":
                    store.purge(item)
                    return {"ok": True}
                if action == "previous":
                    return store.restore_version(item, p["expected"])
                if action == "upload-create":
                    return store.upload_create(parent, p["name"], p["size"], item, d["id"])
                if action == "upload-status":
                    return upload
                if action == "upload-chunk":
                    try:
                        raw = base64.b64decode(p["data"], validate=True)
                    except (ValueError, binascii.Error) as error:
                        raise SpaceError("SPACE_CHUNK_INVALID") from error
                    return store.upload_chunk(
                        item, p["offset"], raw, p["digest"]
                    )
                if action == "upload-complete":
                    return store.upload_complete(item, p["digest"])
                store.upload_cancel(item)
                return {"ok": True}
