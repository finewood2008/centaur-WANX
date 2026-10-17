"""Account-owned capabilities, checked inside the same transaction as file operations."""

from __future__ import annotations

import contextlib
import hashlib
import secrets
import sqlite3
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any, cast

from .service import CHUNK_SIZE, PersonalSpace, SpaceError

PUBLIC = (
    "id",
    "parent",
    "name",
    "kind",
    "size",
    "modified",
    "trashed",
    "digest",
    "version",
    "previous_size",
)


def public(row: Any, root: str = "") -> dict[str, Any]:
    result = {key: row[key] for key in PUBLIC}
    if result["id"] == root:
        result["parent"] = ""
    return result


class SpaceLinks(PersonalSpace):
    # Instances are request-local. Nested calls use one BEGIN IMMEDIATE so a
    # concurrent move/revocation cannot race the ancestry check and the mutation.
    def __init__(self, root: Path, user_id: int) -> None:
        self.transaction: sqlite3.Connection | None = None
        super().__init__(root, user_id)
        with self._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS agent_links (
                    id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
                    root TEXT NOT NULL, created REAL NOT NULL, expires REAL,
                    revoked REAL, last_used REAL
                );
                CREATE TABLE IF NOT EXISTS agent_uploads (
                    id TEXT PRIMARY KEY, link TEXT NOT NULL, target TEXT NOT NULL,
                    expected INTEGER, result TEXT
                );
                CREATE TABLE IF NOT EXISTS agent_audit (
                    id INTEGER PRIMARY KEY, time REAL NOT NULL, link TEXT NOT NULL,
                    action TEXT NOT NULL, target TEXT NOT NULL, agent TEXT NOT NULL,
                    result TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS retired_blobs (id TEXT PRIMARY KEY);
            """)

    @contextlib.contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        if self.transaction is not None:
            yield self.transaction
            return
        with super()._db() as db:
            self.transaction = db
            try:
                yield db
            finally:
                self.transaction = None

    def create_link(self, root: str, expires: float | None = None) -> dict[str, Any]:
        with self._db() as db:
            self._entry(db, root)
            if expires is not None and expires <= time.time():
                raise SpaceError("SPACE_LINK_EXPIRED", 410)
            token, link = secrets.token_urlsafe(32), uuid.uuid4().hex
            db.execute(
                "INSERT INTO agent_links(id,token_hash,root,created,expires) VALUES(?,?,?,?,?)",
                (link, hashlib.sha256(token.encode()).hexdigest(), root, time.time(), expires),
            )
            return {"id": link, "token": token, "root": root, "expires": expires}

    def links(self) -> list[dict[str, Any]]:
        with self._db() as db:
            return [
                dict(row)
                for row in db.execute(
                    "SELECT l.id,l.root,l.created,l.expires,l.revoked,l.last_used,e.name,e.kind "
                    "FROM agent_links l LEFT JOIN entries e ON l.root=e.id ORDER BY l.created DESC"
                )
            ]

    def revoke(self, link: str) -> None:
        with self._db() as db:
            db.execute("UPDATE agent_links SET revoked=? WHERE id=?", (time.time(), link))
            for row in db.execute(
                "SELECT id FROM agent_uploads WHERE link=? AND result IS NULL", (link,)
            ).fetchall():
                self.upload_cancel(row["id"])

    def audit(self, link: str) -> list[dict[str, Any]]:
        with self._db() as db:
            return [
                dict(row)
                for row in db.execute(
                    "SELECT * FROM agent_audit WHERE link=? ORDER BY id DESC LIMIT 100", (link,)
                )
            ]

    def _authorized(self, db: sqlite3.Connection, token: str) -> sqlite3.Row:
        row = db.execute(
            "SELECT * FROM agent_links WHERE token_hash=?",
            (hashlib.sha256(token.encode()).hexdigest(),),
        ).fetchone()
        if row is None or row["revoked"]:
            raise SpaceError("SPACE_LINK_REVOKED", 403)
        if row["expires"] is not None and row["expires"] <= time.time():
            raise SpaceError("SPACE_LINK_EXPIRED", 410)
        self._entry(db, row["root"])
        return cast(sqlite3.Row, row)

    def _within(
        self, db: sqlite3.Connection, root: str, target: str, *, trash: bool = False
    ) -> sqlite3.Row:
        row = self._entry(db, target, trash=trash)
        cursor = row
        while True:
            if cursor["id"] == root:
                return row
            if not cursor["parent"]:
                raise SpaceError("SPACE_LINK_SCOPE", 403)
            cursor = self._entry(db, cursor["parent"])

    def _version(self, row: Any, expected: int | None) -> None:
        if expected is None or row["version"] != expected:
            raise SpaceError("SPACE_VERSION_CONFLICT", 409)

    def _collect(self, db: sqlite3.Connection) -> None:
        for row in db.execute("SELECT id FROM retired_blobs").fetchall():
            blob = row["id"]
            if not db.execute(
                "SELECT 1 FROM entries WHERE COALESCE(blob,id)=? OR previous_blob=?", (blob, blob)
            ).fetchone():
                self._object(blob).unlink(missing_ok=True)
                db.execute("DELETE FROM retired_blobs WHERE id=?", (blob,))

    def execute(
        self,
        token: str,
        action: str,
        *,
        target: str = "",
        parent: str | None = None,
        name: str = "",
        expected: int | None = None,
        upload_id: str = "",
        size: int = 0,
        offset: int = 0,
        length: int = CHUNK_SIZE,
        digest: str = "",
        data: bytes = b"",
        agent: str = "",
    ) -> Any:
        link_id = ""
        try:
            with self._db() as db:
                link = self._authorized(db, token)
                link_id, root = link["id"], link["root"]
                target = target or root
                self._collect(db)
                result = self._execute(
                    db,
                    link_id,
                    root,
                    action,
                    target,
                    parent,
                    name,
                    expected,
                    upload_id,
                    size,
                    offset,
                    length,
                    digest,
                    data,
                )
                db.execute("UPDATE agent_links SET last_used=? WHERE id=?", (time.time(), link_id))
                self._record(db, link_id, action, target, agent, "ok")
            with self._db() as db:
                self._collect(db)
            return result
        except SpaceError as exc:
            if link_id:
                with self._db() as db:
                    self._record(db, link_id, action, target, agent, exc.code)
            raise

    def _record(
        self, db: sqlite3.Connection, link: str, action: str, target: str, agent: str, result: str
    ) -> None:
        db.execute(
            "INSERT INTO agent_audit(time,link,action,target,agent,result) VALUES(?,?,?,?,?,?)",
            (time.time(), link, action[:40], target[:32], agent[:80], result),
        )
        db.execute(
            "DELETE FROM agent_audit WHERE id NOT IN (SELECT id FROM agent_audit ORDER BY id DESC LIMIT 10000)"
        )

    def _execute(
        self,
        db: sqlite3.Connection,
        link: str,
        root: str,
        action: str,
        target: str,
        parent: str | None,
        name: str,
        expected: int | None,
        upload_id: str,
        size: int,
        offset: int,
        length: int,
        digest: str,
        data: bytes,
    ) -> Any:
        row = self._within(db, root, target, trash=action == "restore")
        if action in {"describe", "stat"}:
            return public(row, root)
        if action == "list":
            self._folder(db, target)
            if offset < 0 or not 1 <= length <= 200:
                raise SpaceError("SPACE_INVALID_RANGE")
            rows = db.execute(
                "SELECT * FROM entries WHERE parent=? AND trashed IS NULL ORDER BY kind DESC,name COLLATE NOCASE,id LIMIT ? OFFSET ?",
                (target, length + 1, offset),
            ).fetchall()
            return {
                "items": [public(r, root) for r in rows[:length]],
                "next": offset + length if len(rows) > length else None,
            }
        if action == "read":
            if expected is not None:
                self._version(row, expected)
            content, info = self.read_chunk(target, offset, length)
            return content, public(info, root)
        if action == "mkdir":
            self._folder(db, target)
            return public(self.mkdir(target, name), root)
        if action in {"move", "trash", "restore", "restore-version"}:
            self._version(row, expected)
            if action == "move":
                destination = row["parent"] if parent is None else parent
                if destination != row["parent"]:
                    self._within(db, root, destination)
                return public(self.move(target, destination, name), root)
            if action == "trash":
                self.trash(target)
                return {"ok": True}
            if action == "restore":
                self._within(db, root, row["parent"])
                return public(self.restore(target), root)
            return public(self.restore_version(target, expected or 0), root)
        if action == "begin-write":
            existing = db.execute("SELECT * FROM agent_uploads WHERE id=?", (upload_id,)).fetchone()
            if existing:
                if (existing["link"], existing["target"], existing["expected"]) != (
                    link,
                    target,
                    expected,
                ):
                    raise SpaceError("SPACE_UPLOAD_CONFLICT", 409)
                status = self.upload_status(upload_id)
                if status["size"] != size or (name and status["name"] != name):
                    raise SpaceError("SPACE_UPLOAD_CONFLICT", 409)
                return {**status, "parent": "" if target == root else status["parent"]}
            if (
                db.execute("SELECT 1 FROM uploads WHERE id=?", (upload_id,)).fetchone()
                or db.execute("SELECT 1 FROM entries WHERE id=?", (upload_id,)).fetchone()
            ):
                raise SpaceError("SPACE_UPLOAD_CONFLICT", 409)
            overwrite = row["kind"] == "file"
            if overwrite:
                self._version(row, expected)
            result = self.upload_create(
                row["parent"] if overwrite else target,
                row["name"] if overwrite else name,
                size,
                upload_id,
            )
            db.execute(
                "INSERT INTO agent_uploads(id,link,target,expected) VALUES(?,?,?,?)",
                (upload_id, link, target, expected if overwrite else None),
            )
            return {**result, "parent": "" if target == root else result["parent"]}
        if action in {"write-chunk", "commit-write", "write-status", "cancel-write"}:
            upload = db.execute(
                "SELECT * FROM agent_uploads WHERE id=? AND link=?", (upload_id, link)
            ).fetchone()
            if upload is None:
                raise SpaceError("SPACE_LINK_SCOPE", 403)
            row = self._within(db, root, upload["target"])
            if action == "cancel-write":
                self.upload_cancel(upload_id)
                return {"ok": True}
            if action == "write-status":
                status = self.upload_status(upload_id)
                return {**status, "parent": "" if upload["target"] == root else status["parent"]}
            if upload["result"]:
                return public(self._within(db, root, upload["result"]), root)
            if upload["expected"] is not None:
                self._version(row, upload["expected"])
            if action == "write-chunk":
                return self.upload_chunk(upload_id, offset, data, digest)
            # All checks and publication share one transaction. New blobs are
            # immutable; rollback leaves the previous entry pointer untouched.
            staged = self.upload_complete(upload_id, digest)
            result_id = staged["id"]
            if upload["expected"] is not None:
                result_id = row["id"]
                if row["previous_blob"]:
                    db.execute(
                        "INSERT OR IGNORE INTO retired_blobs VALUES(?)", (row["previous_blob"],)
                    )
                db.execute("DELETE FROM entries WHERE id=?", (upload_id,))
                db.execute(
                    "UPDATE entries SET blob=?,size=?,digest=?,previous_blob=?,previous_size=?,previous_digest=?,version=version+1,modified=? WHERE id=?",
                    (
                        upload_id,
                        staged["size"],
                        staged["digest"],
                        row["blob"] or result_id,
                        row["size"],
                        row["digest"],
                        time.time(),
                        result_id,
                    ),
                )
            db.execute("UPDATE agent_uploads SET result=? WHERE id=?", (result_id, upload_id))
            return public(self._entry(db, result_id), root)
        raise SpaceError("SPACE_ACTION_INVALID")
