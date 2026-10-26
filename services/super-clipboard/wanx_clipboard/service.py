"""Account/box clipboard with immutable content and restartable space uploads."""

from __future__ import annotations

import hashlib
import io
import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from . import note
from .upstream import CHUNK_SIZE, PREFIX, WanxAPI, valid_id, validate_name
from .upstream import BusinessError as SpaceError

TEXT_LIMIT = 1024 * 1024
FILE_LIMIT = 20 * TEXT_LIMIT
CLIPBOARD_LIMIT = 1024 * TEXT_LIMIT
RETENTION = 30 * 86400
IMAGE_MIMES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


def image_mime(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in {b"GIF87a", b"GIF89a"}:
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


PUBLIC = (
    "id",
    "kind",
    "name",
    "original_name",
    "mime",
    "size",
    "digest",
    "device",
    "created",
    "saved",
    "expires",
    "pinned",
    "trashed",
    "version",
    "state",
    "preview",
)


def initialize(db: sqlite3.Connection) -> None:
    db.executescript("""
        CREATE TABLE IF NOT EXISTS clipboard_items (
            id TEXT PRIMARY KEY, batch TEXT NOT NULL, kind TEXT NOT NULL,
            name TEXT NOT NULL, original_name TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL, size INTEGER NOT NULL,
            digest TEXT NOT NULL, device TEXT NOT NULL, created REAL NOT NULL,
            saved REAL, expires REAL, pinned INTEGER NOT NULL DEFAULT 0,
            trashed REAL, version INTEGER NOT NULL DEFAULT 1,
            state TEXT NOT NULL DEFAULT 'pending', preview TEXT NOT NULL DEFAULT '',
            text_search TEXT NOT NULL DEFAULT '', offset INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS clipboard_batches (
            id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, items TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS clipboard_meta (id INTEGER PRIMARY KEY, revision INTEGER);
        INSERT OR IGNORE INTO clipboard_meta VALUES(1,0);
        CREATE TABLE IF NOT EXISTS clipboard_audit (
            at REAL NOT NULL, identity_hash TEXT NOT NULL, action TEXT NOT NULL,
            target TEXT NOT NULL, result TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS clipboard_exports (
            id TEXT PRIMARY KEY, item TEXT NOT NULL, parent TEXT NOT NULL,
            space TEXT NOT NULL, expected INTEGER NOT NULL
        );
    """)
    note.initialize(db)
    if "original_name" not in {r["name"] for r in db.execute("PRAGMA table_info(clipboard_items)")}:
        db.execute("ALTER TABLE clipboard_items ADD COLUMN original_name TEXT NOT NULL DEFAULT ''")
    db.execute("UPDATE clipboard_items SET original_name=name WHERE original_name=''")


class ClipboardService:
    """One request's owner-bound HTTP adapter and independent metadata DB."""

    def __init__(self, home: Path, owner: str, api: WanxAPI, locks: dict):
        self.api = api
        self.api.require_live()
        key = hashlib.sha256(owner.encode()).hexdigest()
        self.directory = home / key
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.lock = locks.setdefault(key, threading.RLock())
        self.connection = None
        with self._db() as db:
            initialize(db)
        os.chmod(self.directory / "clipboard.sqlite3", 0o600)

    @contextmanager
    def _db(self):
        with self.lock:
            self.api.require_live()
            if self.connection is not None:
                yield self.connection
                return
            db = sqlite3.connect(self.directory / "clipboard.sqlite3", timeout=60)
            db.row_factory = sqlite3.Row
            self.connection = db
            try:
                db.execute("BEGIN IMMEDIATE")
                yield db
                # Blocking upstream calls may outlive a revocation. Do not publish
                # their result into the local manifest after authority is lost.
                self.api.require_live()
                db.commit()
            except BaseException:
                db.rollback()
                raise
            finally:
                self.connection = None
                db.close()

    def note_get(self, since=None):
        return note.SharedNote(self).get(since)

    def note_save(self, expected, operation, blocks, action="save"):
        return note.SharedNote(self).save(expected, operation, blocks, action)

    def _object(self, item_id):
        return valid_id(item_id)

    def _ensure_upload(self, item):
        parent = self.api.folder()
        return self.api.upload(item["id"], parent, item["original_name"], item["size"])

    def upload_status(self, item_id):
        with self._db() as db:
            self._clip_item(db, item_id, trash=True)
            try:
                result = self.api.request(PREFIX + "/uploads/" + item_id)
            except SpaceError as exc:
                if exc.status != 404:
                    raise
                result = {"offset": 0}
            db.execute(
                "UPDATE clipboard_items SET offset=? WHERE id=?", (result["offset"], item_id)
            )
            return result

    def _open(self, item_id):
        meta = self.api.metadata(item_id)
        with self._db() as db:
            item = self._clip_item(db, item_id, trash=True)
            if (
                meta["size"] != item["size"]
                or meta["digest"] != item["digest"]
                or meta["space_id"] != "personal"
            ):
                raise SpaceError("CLIPBOARD_CONTENT_CHANGED", 409)
        content = b"".join(
            self.api.read(item_id, offset, min(CHUNK_SIZE, meta["size"] - offset))
            for offset in range(0, meta["size"], CHUNK_SIZE)
        )
        if len(content) != meta["size"] or hashlib.sha256(content).hexdigest() != meta["digest"]:
            raise SpaceError("SPACE_CHUNK_INVALID", 409)
        return io.BytesIO(content)

    def _clip_recycle_file(self, item_id):
        try:
            self.api.request(PREFIX + "/files/" + item_id, "DELETE")
        except SpaceError as exc:
            if exc.status != 404:
                raise

    def _clip_cancel_file(self, item_id):
        try:
            self.api.request(PREFIX + "/uploads/" + item_id, "DELETE")
            self.api.metadata(item_id)
        except SpaceError as exc:
            if exc.status == 404:
                return
            raise
        # A complete core receipt may exist after the business reply was lost.
        self._clip_recycle_file(item_id)
        self.api.request(PREFIX + "/trash/" + item_id, "DELETE")

    def audit(self, token: str, action: str, target: str, result: str) -> None:
        with self._db() as db:
            db.execute(
                "INSERT INTO clipboard_audit VALUES(?,?,?,?,?)",
                (time.time(), hashlib.sha256(token.encode()).hexdigest(), action, target, result),
            )

    def _clip_changed(self, db: sqlite3.Connection) -> None:
        db.execute("UPDATE clipboard_meta SET revision=revision+1 WHERE id=1")

    def _clip_expire(self, db: sqlite3.Connection) -> None:
        result = db.execute(
            "UPDATE clipboard_items SET trashed=?,version=version+1 WHERE state='ready' "
            "AND trashed IS NULL AND pinned=0 AND expires<=?",
            (time.time(), time.time()),
        )
        if result.rowcount:
            self._clip_changed(db)

    def _clip_item(self, db: sqlite3.Connection, item_id: str, *, trash: bool = False) -> Any:
        self._clip_expire(db)
        row = db.execute("SELECT * FROM clipboard_items WHERE id=?", (item_id,)).fetchone()
        if row is None or (not trash and row["trashed"] is not None):
            raise SpaceError("CLIPBOARD_NOT_FOUND", 404)
        return row

    def _clip_public(self, db: sqlite3.Connection, row: Any) -> dict[str, Any]:
        result = {k: row[k] for k in PUBLIC}
        result["pinned"] = bool(row["pinned"])
        if row["state"] == "pending":
            result["offset"] = self.upload_status(row["id"])["offset"]
        return result

    def clipboard_usage(self, db: sqlite3.Connection) -> dict[str, int]:
        reserved = db.execute("SELECT COALESCE(SUM(size),0) FROM clipboard_items").fetchone()[0]
        used = db.execute(
            "SELECT COALESCE(SUM(CASE WHEN state='ready' THEN size ELSE offset END),0) FROM clipboard_items"
        ).fetchone()[0]
        note_bytes = note.usage(db)
        return {
            "used": used + note_bytes,
            "reserved": reserved + note_bytes,
            "limit": CLIPBOARD_LIMIT,
        }

    def clipboard_list(
        self,
        kind: str = "all",
        query: str = "",
        offset: int = 0,
        trash: bool = False,
        since: int | None = None,
    ) -> dict[str, Any]:
        if kind not in {"all", "text", "image", "file"} or offset < 0 or len(query) > 200:
            raise SpaceError("CLIPBOARD_INVALID")
        with self._db() as db:
            self._clip_expire(db)
            revision = db.execute("SELECT revision FROM clipboard_meta WHERE id=1").fetchone()[0]
            result: dict[str, Any] = {"revision": revision, "usage": self.clipboard_usage(db)}
            if since == revision:
                return result | {"unchanged": True}
            clauses = ["state='ready'", "trashed IS NOT NULL" if trash else "trashed IS NULL"]
            args: list[Any] = []
            if kind != "all":
                clauses.append("kind=?")
                args.append(kind)
            if query:
                clauses.append(
                    "(instr(lower(name),lower(?))>0 OR instr(lower(original_name),lower(?))>0 OR instr(lower(text_search),lower(?))>0)"
                )
                args.extend([query, query, query])
            rows = db.execute(
                "SELECT * FROM clipboard_items WHERE "
                + " AND ".join(clauses)
                + " ORDER BY pinned DESC,saved DESC,id LIMIT 51 OFFSET ?",
                (*args, offset),
            ).fetchall()
            return result | {
                "items": [self._clip_public(db, r) for r in rows[:50]],
                "next_offset": offset + 50 if len(rows) > 50 else None,
            }

    def clipboard_batch(self, batch: str, items: list[dict[str, Any]]) -> dict[str, Any]:
        self._object(batch)
        if not 1 <= len(items) <= 20 or len({i["id"] for i in items}) != len(items):
            raise SpaceError("CLIPBOARD_LIMIT", 413)
        for item in items:
            self._object(item["id"])
            validate_name(item["name"])
            if item["kind"] not in {"text", "image"}:
                raise SpaceError("CLIPBOARD_IMAGES_ONLY")
            if item["kind"] == "image" and not item["size"]:
                raise SpaceError("CLIPBOARD_IMAGES_ONLY")
            if item["mime"] not in (IMAGE_MIMES if item["kind"] == "image" else {"text/plain"}):
                raise SpaceError("CLIPBOARD_IMAGES_ONLY")
            if not 0 <= item["size"] <= (TEXT_LIMIT if item["kind"] == "text" else FILE_LIMIT):
                raise SpaceError("CLIPBOARD_LIMIT", 413)
            if len(item["device"]) > 100 or len(item["mime"]) > 100:
                raise SpaceError("CLIPBOARD_INVALID")
            if len(item["digest"]) != 64 or any(
                c not in "0123456789abcdef" for c in item["digest"]
            ):
                raise SpaceError("SPACE_CHUNK_INVALID")
        fingerprint = hashlib.sha256(json.dumps(items, sort_keys=True).encode()).hexdigest()
        with self._db() as db:
            previous = db.execute("SELECT * FROM clipboard_batches WHERE id=?", (batch,)).fetchone()
            if previous:
                if previous["fingerprint"] != fingerprint:
                    raise SpaceError("CLIPBOARD_BATCH_CONFLICT", 409)
                ids = json.loads(previous["items"])
            else:
                if (
                    self.clipboard_usage(db)["reserved"] + sum(i["size"] for i in items)
                    > CLIPBOARD_LIMIT
                ):
                    raise SpaceError("CLIPBOARD_QUOTA", 413)
                for item in items:
                    if db.execute(
                        "SELECT 1 FROM clipboard_items WHERE id=?", (item["id"],)
                    ).fetchone():
                        raise SpaceError("CLIPBOARD_BATCH_CONFLICT", 409)
                    # Reserve all metadata in one transaction, before opening any WANX upload.
                    try:
                        self.api.metadata(item["id"])
                    except SpaceError as exc:
                        if exc.status != 404:
                            raise
                    else:
                        raise SpaceError("CLIPBOARD_BATCH_CONFLICT", 409)
                    db.execute(
                        "INSERT INTO clipboard_items(id,batch,kind,name,original_name,mime,size,digest,device,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (
                            item["id"],
                            batch,
                            item["kind"],
                            item["name"],
                            item["name"],
                            item["mime"],
                            item["size"],
                            item["digest"],
                            item["device"],
                            time.time(),
                        ),
                    )
                ids = [i["id"] for i in items]
                db.execute(
                    "INSERT INTO clipboard_batches VALUES(?,?,?)",
                    (batch, fingerprint, json.dumps(ids)),
                )
            return {
                "items": [
                    self._clip_public(db, self._clip_item(db, i, trash=True))
                    for i in ids
                    if db.execute("SELECT 1 FROM clipboard_items WHERE id=?", (i,)).fetchone()
                ],
                "usage": self.clipboard_usage(db),
            }

    def clipboard_stat(self, item_id: str) -> dict[str, Any]:
        with self._db() as db:
            return self._clip_public(db, self._clip_item(db, item_id))

    def clipboard_chunk(
        self, item_id: str, offset: int, data: bytes, digest: str
    ) -> dict[str, Any]:
        with self._db() as db:
            item = self._clip_item(db, item_id)
            if item["state"] != "pending":
                raise SpaceError("CLIPBOARD_ALREADY_SAVED", 409)
            if hashlib.sha256(data).hexdigest() != digest:
                raise SpaceError("SPACE_CHUNK_INVALID", 409)
            if item["kind"] == "image" and offset == 0 and image_mime(data) != item["mime"]:
                raise SpaceError("CLIPBOARD_IMAGES_ONLY")
            self._ensure_upload(item)
            result = self.api.request(
                PREFIX + f"/uploads/{item_id}?offset={offset}", "PUT", data=data
            )
            db.execute(
                "UPDATE clipboard_items SET offset=? WHERE id=?", (result["offset"], item_id)
            )
            return result

    def clipboard_complete(self, item_id: str, digest: str) -> dict[str, Any]:
        with self._db() as db:
            item = self._clip_item(db, item_id)
            if item["digest"] != digest:
                raise SpaceError("SPACE_CHUNK_INVALID", 409)
            if item["state"] == "ready":
                return self._clip_public(db, item)
            # The existing upload commit verifies the complete hash and fsyncs before publication.
            self._ensure_upload(item)
            self.api.request(
                PREFIX + f"/uploads/{item_id}/complete", "POST", body={"digest": digest}
            )
            text = ""
            if item["kind"] == "text":
                try:
                    with self._open(item_id) as handle:
                        text = handle.read(TEXT_LIMIT + 1).decode("utf-8")
                except UnicodeError as exc:
                    raise SpaceError("CLIPBOARD_INVALID") from exc
            db.execute(
                "UPDATE clipboard_items SET state='ready',saved=?,expires=?,preview=?,text_search=? WHERE id=?",
                (time.time(), time.time() + RETENTION, text[:300], text, item_id),
            )
            self._clip_changed(db)
            return self._clip_public(db, self._clip_item(db, item_id))

    def clipboard_read(
        self,
        item_id: str,
        offset: int = 0,
        length: int = TEXT_LIMIT,
        expected: int | None = None,
    ) -> tuple[bytes, dict[str, Any]]:
        with self._db() as db:
            row = self._clip_item(db, item_id)
            if row["state"] != "ready":
                raise SpaceError("CLIPBOARD_NOT_READY", 409)
            if expected is not None and expected != row["version"]:
                raise SpaceError("SPACE_VERSION_CONFLICT", 409)
            if offset < 0 or not 1 <= length <= CHUNK_SIZE or offset > row["size"]:
                raise SpaceError("CLIPBOARD_INVALID")
            before = self.api.metadata(item_id)
            if (
                before["digest"] != row["digest"]
                or before["size"] != row["size"]
                or before["space_id"] != "personal"
            ):
                raise SpaceError("CLIPBOARD_CONTENT_CHANGED", 409)
            data = self.api.read(item_id, offset, max(1, min(length, row["size"] - offset)))
            after = self.api.metadata(item_id)
            if (
                after["digest"] != row["digest"]
                or after["version"] != before["version"]
                or after["space_id"] != "personal"
            ):
                raise SpaceError("CLIPBOARD_CONTENT_CHANGED", 409)
            return data, self._clip_public(db, row)

    def clipboard_manage(
        self,
        action: str,
        targets: list[dict[str, Any]],
        name: str = "",
    ) -> dict[str, Any]:
        if (
            action not in {"pin", "unpin", "rename", "trash", "restore", "purge", "cancel"}
            or not 1 <= len(targets) <= 50
            or len({t["id"] for t in targets}) != len(targets)
        ):
            raise SpaceError("CLIPBOARD_INVALID")
        with self._db() as db:
            rows = [self._clip_item(db, t["id"], trash=True) for t in targets]
            if any(r["version"] != t["expected"] for r, t in zip(rows, targets, strict=True)):
                raise SpaceError("SPACE_VERSION_CONFLICT", 409)
            if any(
                db.execute("SELECT 1 FROM clipboard_note_assets WHERE id=?", (r["id"],)).fetchone()
                for r in rows
            ):
                raise SpaceError("CLIPBOARD_NOTE_REFERENCED", 409)
            for row in rows:
                item_id = row["id"]
                if action == "cancel":
                    if row["state"] != "pending":
                        raise SpaceError("CLIPBOARD_ALREADY_SAVED", 409)
                    self._clip_cancel_file(item_id)
                    db.execute("DELETE FROM clipboard_items WHERE id=?", (item_id,))
                elif action == "purge":
                    if row["trashed"] is None:
                        raise SpaceError("SPACE_NOT_IN_TRASH")
                    self._clip_recycle_file(item_id)
                    try:
                        self.api.request(PREFIX + "/trash/" + item_id, "DELETE")
                    except SpaceError as exc:
                        if exc.status != 404:
                            raise
                    db.execute("DELETE FROM clipboard_items WHERE id=?", (item_id,))
                else:
                    if row["state"] != "ready" or (
                        action != "restore" and row["trashed"] is not None
                    ):
                        raise SpaceError("CLIPBOARD_NOT_READY", 409)
                    if action == "rename":
                        db.execute(
                            "UPDATE clipboard_items SET name=? WHERE id=?",
                            (validate_name(name), item_id),
                        )
                    elif action in {"pin", "unpin"}:
                        db.execute(
                            "UPDATE clipboard_items SET pinned=?,expires=? WHERE id=?",
                            (
                                int(action == "pin"),
                                None if action == "pin" else time.time() + RETENTION,
                                item_id,
                            ),
                        )
                    elif action == "trash":
                        db.execute(
                            "UPDATE clipboard_items SET trashed=? WHERE id=?",
                            (time.time(), item_id),
                        )
                    else:
                        if row["trashed"] is None:
                            raise SpaceError("SPACE_NOT_IN_TRASH")
                        db.execute(
                            "UPDATE clipboard_items SET trashed=NULL,pinned=0,expires=? WHERE id=?",
                            (time.time() + RETENTION, item_id),
                        )
                    db.execute(
                        "UPDATE clipboard_items SET version=version+1 WHERE id=?", (item_id,)
                    )
            self._clip_changed(db)
        return {"ok": True}

    def clipboard_export(
        self, item_id: str, expected: int, export_id: str, parent: str, space_id: str
    ) -> dict:
        if self.api.local_data and space_id != "personal":
            raise SpaceError("LOCAL_DATA_SCOPE_DENIED", 403)
        valid_id(export_id)
        with self._db() as db:
            row = self._clip_item(db, item_id)
            if row["state"] != "ready" or row["version"] != expected:
                raise SpaceError("SPACE_VERSION_CONFLICT", 409)
            previous = db.execute(
                "SELECT * FROM clipboard_exports WHERE id=?", (export_id,)
            ).fetchone()
            identity = (item_id, parent, space_id, expected)
            if (
                previous
                and tuple(previous[k] for k in ("item", "parent", "space", "expected")) != identity
            ):
                raise SpaceError("CLIPBOARD_BATCH_CONFLICT", 409)
            if not previous:
                if db.execute("SELECT 1 FROM clipboard_items WHERE id=?", (export_id,)).fetchone():
                    raise SpaceError("CLIPBOARD_BATCH_CONFLICT", 409)
                try:
                    self.api.metadata(export_id)
                except SpaceError as exc:
                    if exc.status != 404:
                        raise
                else:
                    raise SpaceError("CLIPBOARD_BATCH_CONFLICT", 409)
                db.execute(
                    "INSERT INTO clipboard_exports VALUES(?,?,?,?,?)", (export_id, *identity)
                )
        with self._db() as db:
            row = self._clip_item(db, item_id)
            if row["version"] != expected:
                raise SpaceError("SPACE_VERSION_CONFLICT", 409)
            upload = self.api.upload(export_id, parent, row["original_name"], row["size"], space_id)
            if upload["state"] != "complete":
                with self._open(item_id) as handle:
                    offset = upload["offset"]
                    handle.seek(offset)
                    while data := handle.read(CHUNK_SIZE):
                        result = self.api.request(
                            PREFIX + f"/uploads/{export_id}?offset={offset}", "PUT", data=data
                        )
                        offset = result["offset"]
            result = self.api.request(
                PREFIX + f"/uploads/{export_id}/complete", "POST", body={"digest": row["digest"]}
            )
            return result
