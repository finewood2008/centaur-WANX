"""Box-hosted HTTP capabilities, independent of WANX sessions and MCP keys."""

from __future__ import annotations

import base64
import hmac
import os
import re
import secrets
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .agent_hub import READS, WRITES
from .mcp_drives import McpDrives
from .service import CHUNK_SIZE, SpaceError, _safe_file


class SpaceShares(McpDrives):
    def __init__(
        self,
        home: Path,
        actor: int,
        member: str,
        *,
        admin: bool = False,
        resolve_user: Callable[[int], Any],
    ):
        super().__init__(home, actor, member, admin=admin)
        self.resolve_user = resolve_user
        with self.db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS http_shares (
                id TEXT PRIMARY KEY, actor INTEGER NOT NULL, domain TEXT NOT NULL,
                space_id TEXT NOT NULL, root TEXT NOT NULL, permission TEXT NOT NULL,
                created REAL NOT NULL, expires REAL, revoked REAL, last_used REAL, root_epoch INTEGER NOT NULL)""")
            db.execute("""CREATE TABLE IF NOT EXISTS http_share_dismissals (
                share TEXT PRIMARY KEY, dismissed REAL NOT NULL)""")
            keyfile = self.directory / "share-signing.key"
            _safe_file(keyfile, missing=True)
            try:
                fd = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                pass
            else:
                with os.fdopen(fd, "wb") as out:
                    out.write(secrets.token_bytes(32))
                    out.flush()
                    os.fsync(out.fileno())
            self.secret = keyfile.read_bytes()
            if len(self.secret) != 32:
                raise SpaceError("SPACE_UNSAFE_STORAGE", 409)

    def token(self, sid: str) -> str:
        signature = hmac.digest(self.secret, ("wanx-space-share:" + sid).encode(), "sha256")
        return sid + "." + base64.urlsafe_b64encode(signature).decode().rstrip("=")

    def _creator(self, row: Any) -> SpaceShares:
        user = self.resolve_user(row["actor"])
        if user is None:
            raise SpaceError("SPACE_SHARE_UNAVAILABLE", 403)
        # A request-local authority observes current roles, not the creation-time role.
        authority = object.__new__(SpaceShares)
        authority.__dict__ = {
            **self.__dict__,
            "actor": user.id,
            "member": user.display_name or user.username,
            "admin": user.role == "admin",
            "_stores": {},
        }
        return authority

    def _resource(self, db: Any, row: Any, *, write: bool = False) -> tuple[Any, Any]:
        row = dict(row)
        authority = self._creator(row)
        store = authority.storage(row["domain"])
        with store._db() as files:
            resource = store._entry(files, row["root"])
            epoch = files.execute(
                "SELECT epoch FROM space_share_epochs WHERE id=?", (row["root"],)
            ).fetchone()
            if "root_epoch" in row and row["root_epoch"] != (epoch[0] if epoch else 0):
                raise SpaceError("SPACE_SHARE_UNAVAILABLE", 403)
            if resource["space_id"] != row["space_id"]:
                raise SpaceError("SPACE_SHARE_UNAVAILABLE", 403)
        disk = db.execute(
            "SELECT agent FROM space_mcp_drives WHERE space_id=?", (row["space_id"],)
        ).fetchone()
        if disk:
            authority.drive(db, disk[0], write=write)
        elif row["space_id"] != "personal":
            raise SpaceError("SPACE_SHARE_UNAVAILABLE", 403)
        elif row["domain"] == "company" and write and not authority.admin:
            raise SpaceError("SPACE_SHARE_READ_ONLY", 403)
        return store, resource

    def _view(self, db: Any, row: Any, *, credential: bool = False) -> dict[str, Any]:
        result = dict(row)
        try:
            _, resource = self._resource(db, row)
            result.update(name=resource["name"], kind=resource["kind"])
            result["state"] = (
                "revoked"
                if row["revoked"]
                else "expired"
                if row["expires"] and row["expires"] <= time.time()
                else "active"
            )
        except SpaceError:
            result.update(name="原资源不可用", state="unavailable")
        if credential:
            result["path"] = "/space-links/" + self.token(row["id"])
        return result

    def create_share(
        self, sid: str, domain: str, root: str, space_id: str, permission: str, days: int
    ) -> dict[str, Any]:
        if (
            not re.fullmatch(r"[a-f0-9]{32}", sid)
            or permission not in {"read", "write"}
            or days not in {0, 7, 30}
        ):
            raise SpaceError("SPACE_SHARE_INPUT_INVALID")
        with self.db() as db:
            existing = db.execute("SELECT * FROM http_shares WHERE id=?", (sid,)).fetchone()
            if existing:
                if (
                    existing["actor"],
                    existing["domain"],
                    existing["root"],
                    existing["space_id"],
                    existing["permission"],
                ) != (self.actor, domain, root, space_id, permission):
                    raise SpaceError("SPACE_UPLOAD_CONFLICT", 409)
                if (
                    round(existing["expires"] - existing["created"]) if existing["expires"] else 0
                ) != days * 86400:
                    raise SpaceError("SPACE_UPLOAD_CONFLICT", 409)
                return self._view(db, existing, credential=True)
            row = {"actor": self.actor, "domain": domain, "root": root, "space_id": space_id}
            store, _ = self._resource(db, row, write=permission == "write")
            with store._db() as files:
                epoch = files.execute(
                    "SELECT epoch FROM space_share_epochs WHERE id=?", (root,)
                ).fetchone()
            now = time.time()
            db.execute(
                "INSERT INTO http_shares VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?)",
                (
                    sid,
                    self.actor,
                    domain,
                    space_id,
                    root,
                    permission,
                    now,
                    now + days * 86400 if days else None,
                    epoch[0] if epoch else 0,
                ),
            )
            return self._view(
                db,
                db.execute("SELECT * FROM http_shares WHERE id=?", (sid,)).fetchone(),
                credential=True,
            )

    def list_shares(self) -> list[dict[str, Any]]:
        with self.db() as db:
            return [
                self._view(db, row)
                for row in db.execute(
                    "SELECT s.* FROM http_shares s LEFT JOIN http_share_dismissals d ON d.share=s.id "
                    "WHERE s.actor=? AND d.share IS NULL ORDER BY s.created DESC",
                    (self.actor,),
                )
            ]

    def dismiss_share(self, sid: str) -> dict[str, Any]:
        """Remove an inactive item from management, retaining its revocation tombstone."""
        with self.db() as db:
            row = db.execute(
                "SELECT * FROM http_shares WHERE id=? AND actor=?", (sid, self.actor)
            ).fetchone()
            if row is None:
                raise SpaceError("SPACE_NOT_FOUND", 404)
            if self._view(db, row)["state"] == "active":
                raise SpaceError("SPACE_SHARE_ACTIVE", 409)
            now = time.time()
            db.execute("UPDATE http_shares SET revoked=COALESCE(revoked,?) WHERE id=?", (now, sid))
            db.execute(
                "INSERT OR IGNORE INTO http_share_dismissals(share,dismissed) VALUES(?,?)",
                (sid, now),
            )
            return {"ok": True}

    def manage_share(self, sid: str, *, revoke: bool = False) -> dict[str, Any]:
        with self.db() as db:
            row = db.execute(
                "SELECT * FROM http_shares WHERE id=? AND actor=?", (sid, self.actor)
            ).fetchone()
            if row is None:
                raise SpaceError("SPACE_NOT_FOUND", 404)
            if revoke:
                db.execute(
                    "UPDATE http_shares SET revoked=COALESCE(revoked,?) WHERE id=?",
                    (time.time(), sid),
                )
                return {"ok": True}
            return self._view(db, row, credential=True)

    def access(self, token: str, body: dict[str, Any]) -> Any:
        if not re.fullmatch(r"[a-f0-9]{32}\.[A-Za-z0-9_-]{43}", token) or not hmac.compare_digest(
            self.token(token[:32]), token
        ):
            raise SpaceError("SPACE_SHARE_UNAVAILABLE", 403)
        with self.db() as db:
            row = db.execute("SELECT * FROM http_shares WHERE id=?", (token[:32],)).fetchone()
            if row is None or row["revoked"]:
                raise SpaceError("SPACE_SHARE_UNAVAILABLE", 403)
            if row["expires"] is not None and row["expires"] <= time.time():
                raise SpaceError("SPACE_SHARE_EXPIRED", 410)
            action = body.get("action", "describe")
            if action not in READS | WRITES:
                raise SpaceError("SPACE_SHARE_OPERATION_DENIED", 403)
            write = action in WRITES
            if write and row["permission"] != "write":
                raise SpaceError("SPACE_SHARE_READ_ONLY", 403)
            store, _ = self._resource(db, row, write=write)
            target = body.get("target", "")
            if action == "mkdir" and body.get("parent") is not None:
                if target and target != body["parent"]:
                    raise SpaceError("SPACE_INVALID_DESTINATION")
                target = body["parent"]
            target = target or row["root"]
            try:
                raw = base64.b64decode(body.get("data", ""), validate=True)
            except ValueError as error:
                raise SpaceError("SPACE_SHARE_INPUT_INVALID") from error
            if len(raw) > CHUNK_SIZE:
                raise SpaceError("SPACE_CHUNK_INVALID")
            with store._db() as files:
                # Scope and resource disk are checked again under the mutation lock.
                root = store._entry(files, row["root"])
                epoch = files.execute(
                    "SELECT epoch FROM space_share_epochs WHERE id=?", (row["root"],)
                ).fetchone()
                if row["root_epoch"] != (epoch[0] if epoch else 0):
                    raise SpaceError("SPACE_SHARE_UNAVAILABLE", 403)
                if root["space_id"] != row["space_id"]:
                    raise SpaceError("SPACE_SHARE_UNAVAILABLE", 403)
                store._within(files, row["root"], target)
                result = store._execute(
                    files,
                    "share:" + row["id"],
                    row["root"],
                    action,
                    target,
                    body.get("parent"),
                    body.get("name", ""),
                    body.get("expected"),
                    body.get("upload_id", ""),
                    body.get("size", 0),
                    body.get("offset", 0),
                    body.get("length", CHUNK_SIZE if action == "read" else 200),
                    body.get("digest", ""),
                    raw,
                )
                # Recheck account/role on commit, including after slow upload operations.
                user = self.resolve_user(row["actor"])
                if user is None or (
                    write
                    and row["domain"] == "company"
                    and row["space_id"] == "personal"
                    and user.role != "admin"
                ):
                    raise SpaceError("SPACE_SHARE_UNAVAILABLE", 403)
            db.execute("UPDATE http_shares SET last_used=? WHERE id=?", (time.time(), row["id"]))
            if action == "describe":
                return {
                    "resource": result,
                    "permission": row["permission"],
                    "expires": row["expires"],
                    "protocol": "wanx-space-http-v1",
                    "chunk_size": CHUNK_SIZE,
                    "operations": sorted(
                        READS | (WRITES if row["permission"] == "write" else set())
                    ),
                    "instructions": "GET ?format=json&action=list&target=<id> 浏览；GET ?action=read&target=<id>&offset=0&length=1048576 下载分片。POST JSON 到本链接执行回写：begin-write(target=文件夹ID,name,size,upload_id=32位随机hex；更新文件时target=文件ID,expected=当前version)，write-chunk(upload_id,offset,data=base64,digest=分片SHA256)，commit-write(upload_id,digest=全文件SHA256)。每步保留同一target；上传失败可write-status/cancel-write；版本冲突须重新核对。不支持删除、移动。",
                }
            return result
