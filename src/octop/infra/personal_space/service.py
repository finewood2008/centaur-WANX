"""User-owned files with opaque object ids and restartable, bounded uploads.

Logical folders exist only in SQLite. No user-provided name becomes an OS path.
The service directory must live on the deployment's persistent OCTOP_HOME volume.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import re
import shutil
import sqlite3
import stat
import time
import uuid
from collections.abc import Iterator
from contextvars import ContextVar
from pathlib import Path
from typing import Any, BinaryIO, cast

import psutil

CHUNK_SIZE = 4 * 1024 * 1024
_ID = re.compile(r"^[0-9a-f]{32}$")


class SpaceError(Exception):
    def __init__(self, code: str, status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


def validate_name(value: str) -> str:
    value = value.strip()
    if (
        not value
        or value in {".", ".."}
        or len(value.encode("utf-8")) > 240
        or any(ord(c) < 32 or c in '/\\:*?"<>|' for c in value)
        or value.endswith(".")
    ):
        raise SpaceError("SPACE_INVALID_NAME")
    return value


def _safe_file(path: Path, *, missing: bool = False) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        if missing:
            return
        raise SpaceError("SPACE_NOT_FOUND", 404) from None
    # SQLite can unlink a journal while lstat is resolving its directory entry.
    # Recheck only an unlinked regular file, never a link or another unsafe type.
    if missing and stat.S_ISREG(info.st_mode) and info.st_nlink == 0:
        try:
            info = path.lstat()
        except FileNotFoundError:
            return
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise SpaceError("SPACE_UNSAFE_STORAGE", 409)


class PersonalSpace:
    def __init__(self, root: Path, user_id: int, *, namespace: str | None = None) -> None:
        self._active_db: ContextVar[sqlite3.Connection | None] = ContextVar(
            "space_db", default=None
        )
        if not isinstance(user_id, int) or user_id <= 0:
            raise SpaceError("SPACE_FORBIDDEN", 403)
        # Only the private company-space composition root supplies this value.
        # It is a storage domain, never a synthetic user or a request path.
        if namespace not in (None, "company"):
            raise SpaceError("SPACE_FORBIDDEN", 403)
        # All descendants are service-owned, not selected by a request.
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if root.is_symlink():
            raise SpaceError("SPACE_UNSAFE_STORAGE", 409)
        # The configured deployment root is trusted; macOS /var and /tmp are
        # system symlinks. User-controlled descendants still reject links.
        self.root = root.resolve() / (namespace or str(user_id))
        self.objects = self.root / "objects"
        for directory in (self.root, self.objects):
            directory.mkdir(exist_ok=True, mode=0o700)
            if directory.is_symlink() or not directory.is_dir():
                raise SpaceError("SPACE_UNSAFE_STORAGE", 409)
        self.database = self.root / "index.sqlite3"
        _safe_file(self.database, missing=True)
        with self._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS space_share_epochs (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS entries (
                    id TEXT PRIMARY KEY, parent TEXT NOT NULL, name TEXT NOT NULL,
                    kind TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
                    modified REAL NOT NULL, trashed REAL, digest TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS active_name
                    ON entries(parent, name COLLATE NOCASE) WHERE trashed IS NULL;
                CREATE TABLE IF NOT EXISTS uploads (
                    id TEXT PRIMARY KEY, parent TEXT NOT NULL, name TEXT NOT NULL,
                    size INTEGER NOT NULL, offset INTEGER NOT NULL DEFAULT 0,
                    state TEXT NOT NULL DEFAULT 'pending', modified REAL NOT NULL
                );
            """)

        with self._db() as db:
            columns = {row["name"] for row in db.execute("PRAGMA table_info(entries)")}
            for column, definition in {
                "space_id": "TEXT NOT NULL DEFAULT 'personal'",
                "version": "INTEGER NOT NULL DEFAULT 1",
                "blob": "TEXT",
                "previous_blob": "TEXT",
                "previous_size": "INTEGER NOT NULL DEFAULT 0",
                "previous_digest": "TEXT",
            }.items():
                if column not in columns:
                    db.execute(f"ALTER TABLE entries ADD COLUMN {column} {definition}")

        with self._db() as db:
            if "space_id" not in {r["name"] for r in db.execute("PRAGMA table_info(uploads)")}:
                db.execute(
                    "ALTER TABLE uploads ADD COLUMN space_id TEXT NOT NULL DEFAULT 'personal'"
                )
            db.execute(
                "CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, created REAL NOT NULL, trashed REAL)"
            )
            db.execute(
                "INSERT OR IGNORE INTO spaces VALUES('personal','我的空间','',?,NULL)",
                (time.time(),),
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS space_storage (space_id TEXT PRIMARY KEY, base TEXT NOT NULL, directory TEXT NOT NULL)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS object_locations (id TEXT PRIMARY KEY, directory TEXT NOT NULL)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS space_storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            db.execute(
                "INSERT OR IGNORE INTO space_storage_meta VALUES('namespace',?)",
                (uuid.uuid4().hex,),
            )

    def _space(self, db: sqlite3.Connection, space_id: str) -> sqlite3.Row:
        row = db.execute(
            "SELECT * FROM spaces WHERE id=? AND trashed IS NULL", (space_id,)
        ).fetchone()
        if row is None:
            raise SpaceError("SPACE_NOT_FOUND", 404)
        return cast(sqlite3.Row, row)

    def _parent(self, db: sqlite3.Connection, parent: str, space_id: str = "personal") -> str:
        return parent or str(self._space(db, space_id)["root"])

    def _space_for(self, db: sqlite3.Connection, parent: str) -> str:
        return str(self._entry(db, parent)["space_id"]) if parent else "personal"

    def _ordinary(self, db: sqlite3.Connection, item_id: str) -> None:
        if db.execute("SELECT 1 FROM spaces WHERE root=? AND root!=''", (item_id,)).fetchone():
            raise SpaceError("SPACE_MANAGED_ROOT", 403)

    @contextlib.contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        active = self._active_db.get()
        if active is not None:
            yield active
            return
        _safe_file(self.database, missing=True)
        for suffix in ("-journal", "-wal", "-shm"):
            _safe_file(Path(str(self.database) + suffix), missing=True)
        db = sqlite3.connect(self.database, timeout=10)
        db.row_factory = sqlite3.Row
        token = self._active_db.set(db)
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            self._active_db.reset(token)
            db.close()

    def _object(self, item_id: str, partial: bool = False) -> Path:
        if not _ID.fullmatch(item_id):
            raise SpaceError("SPACE_NOT_FOUND", 404)
        from .storage import safe_directory

        with self._db() as db:
            row = db.execute(
                "SELECT directory FROM object_locations WHERE id=?", (item_id,)
            ).fetchone()
            directory = Path(row[0]) if row else self.objects
            safe_directory(directory)
            return directory / (item_id + (".part" if partial else ".blob"))

    @contextlib.contextmanager
    def _open(
        self, item_id: str, *, partial: bool = False, write: bool = False
    ) -> Iterator[BinaryIO]:
        path = self._object(item_id, partial)
        _safe_file(path, missing=write)
        flags = (os.O_RDWR | os.O_CREAT if write else os.O_RDONLY) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags | getattr(os, "O_BINARY", 0), 0o600)
        with os.fdopen(fd, "r+b" if write else "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise SpaceError("SPACE_UNSAFE_STORAGE", 409)
            yield handle

    def _entry(self, db: sqlite3.Connection, item_id: str, *, trash: bool = False) -> sqlite3.Row:
        row = db.execute("SELECT * FROM entries WHERE id=?", (item_id,)).fetchone()
        if row is None:
            raise SpaceError("SPACE_NOT_FOUND", 404)
        if not trash:
            self._space(db, row["space_id"])
            ancestor = row
            while ancestor:
                if ancestor["trashed"] is not None:
                    raise SpaceError("SPACE_NOT_FOUND", 404)
                parent = ancestor["parent"]
                ancestor = (
                    db.execute("SELECT * FROM entries WHERE id=?", (parent,)).fetchone()
                    if parent
                    else None
                )
                if parent and ancestor is None:
                    raise SpaceError("SPACE_NOT_FOUND", 404)
        return cast(sqlite3.Row, row)

    def _folder(self, db: sqlite3.Connection, item_id: str) -> None:
        if item_id and self._entry(db, item_id)["kind"] != "folder":
            raise SpaceError("SPACE_NOT_FOLDER")

    def _name(self, db: sqlite3.Connection, parent: str, name: str, exclude: str = "") -> str:
        name = validate_name(name)
        candidate = name
        index = 1
        stem, suffix = os.path.splitext(name)
        while db.execute(
            "SELECT 1 FROM entries WHERE parent=? AND name=? COLLATE NOCASE AND trashed IS NULL AND id!=?",
            (parent, candidate, exclude),
        ).fetchone():
            candidate = f"{stem} ({index}){suffix}"
            index += 1
        return candidate

    def listing(
        self, parent: str = "", trash: bool = False, space_id: str = "personal"
    ) -> dict[str, Any]:
        with self._db() as db:
            parent = self._parent(db, parent, space_id)
            space_id = self._space_for(db, parent)
            self._folder(db, parent)
            root = self._space(db, space_id)["root"]
            rows = db.execute(
                "SELECT * FROM entries WHERE space_id=? AND id!=? AND "
                + (
                    "trashed IS NOT NULL ORDER BY trashed DESC"
                    if trash
                    else "parent=? AND trashed IS NULL ORDER BY kind DESC,name COLLATE NOCASE"
                ),
                (space_id, root) if trash else (space_id, root, parent),
            ).fetchall()
            crumbs: list[dict[str, str]] = []
            cursor = parent
            while cursor and cursor != root:
                row = self._entry(db, cursor)
                crumbs.insert(0, {"id": row["id"], "name": row["name"]})
                cursor = row["parent"]
            return {
                "items": [dict(row) for row in rows],
                "breadcrumbs": crumbs,
                "parent": parent,
                "space_id": space_id,
                "root": root,
            }

    def mkdir(self, parent: str, name: str, space_id: str = "personal") -> dict[str, Any]:
        with self._db() as db:
            parent = self._parent(db, parent, space_id)
            self._folder(db, parent)
            item_id = uuid.uuid4().hex
            db.execute(
                "INSERT INTO entries(id,parent,name,kind,modified,space_id) VALUES(?,?,?,'folder',?,?)",
                (
                    item_id,
                    parent,
                    self._name(db, parent, name),
                    time.time(),
                    self._space_for(db, parent),
                ),
            )
            return dict(self._entry(db, item_id))

    def move(self, item_id: str, parent: str, name: str) -> dict[str, Any]:
        with self._db() as db:
            row = self._entry(db, item_id)
            self._ordinary(db, item_id)
            self._folder(db, parent)
            if row["space_id"] != self._space_for(db, parent):
                raise SpaceError("SPACE_CROSS_SPACE_CONFIRM_REQUIRED", 409)
            cursor = parent
            while cursor:
                if cursor == item_id:
                    raise SpaceError("SPACE_INVALID_DESTINATION")
                cursor = self._entry(db, cursor)["parent"]
            db.execute(
                "UPDATE entries SET parent=?,name=?,modified=?,version=version+1 WHERE id=?",
                (parent, self._name(db, parent, name, item_id), time.time(), item_id),
            )
            return dict(self._entry(db, row["id"]))

    def _invalidate_share_roots(self, db: sqlite3.Connection, item_id: str) -> None:
        # A restored or returned resource must not revive a previously invalid HTTP share.
        db.execute(
            """WITH RECURSIVE tree(id) AS (
            SELECT ? UNION ALL SELECT e.id FROM entries e JOIN tree t ON e.parent=t.id)
            INSERT INTO space_share_epochs SELECT id,1 FROM tree WHERE 1
            ON CONFLICT(id) DO UPDATE SET epoch=epoch+1""",
            (item_id,),
        )

    def trash(self, item_id: str) -> None:
        with self._db() as db:
            self._entry(db, item_id)
            self._ordinary(db, item_id)
            self._invalidate_share_roots(db, item_id)
            db.execute(
                "UPDATE entries SET trashed=?,version=version+1 WHERE id=?", (time.time(), item_id)
            )

    def restore(self, item_id: str) -> dict[str, Any]:
        with self._db() as db:
            row = self._entry(db, item_id, trash=True)
            self._ordinary(db, item_id)
            self._space(db, row["space_id"])
            if row["trashed"] is None:
                raise SpaceError("SPACE_NOT_IN_TRASH")
            parent = row["parent"]
            try:
                self._folder(db, parent)
            except SpaceError:
                parent = str(self._space(db, row["space_id"])["root"])
            db.execute(
                "UPDATE entries SET parent=?,name=?,trashed=NULL,version=version+1 WHERE id=?",
                (parent, self._name(db, parent, row["name"], item_id), item_id),
            )
            return dict(self._entry(db, item_id))

    def purge(self, item_id: str) -> None:
        with self._db() as db:
            row = self._entry(db, item_id, trash=True)
            self._ordinary(db, item_id)
            self._space(db, row["space_id"])
            if row["trashed"] is None:
                raise SpaceError("SPACE_NOT_IN_TRASH")
            ids = [item_id]
            for current in ids:
                ids.extend(
                    r[0] for r in db.execute("SELECT id FROM entries WHERE parent=?", (current,))
                )
            for current in reversed(ids):
                # Objects have opaque names; deleting a link cannot follow its target.
                record = self._entry(db, current, trash=True)
                for blob in {record["blob"] or current, record["previous_blob"]} - {None}:
                    self._object(blob).unlink(missing_ok=True)
                    db.execute("DELETE FROM object_locations WHERE id=?", (blob,))
                db.execute("DELETE FROM entries WHERE id=?", (current,))

    def upload_create(
        self, parent: str, name: str, size: int, upload_id: str, space_id: str = "personal"
    ) -> dict[str, Any]:
        self._object(upload_id)
        name = validate_name(name)
        if size < 0 or size > 2**53 - 1:
            raise SpaceError("SPACE_INVALID_SIZE")
        with self._db() as db:
            parent = self._parent(db, parent, space_id)
            existing = db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
            if existing:
                if (existing["parent"], existing["name"], existing["size"]) != (parent, name, size):
                    raise SpaceError("SPACE_UPLOAD_CONFLICT", 409)
                return dict(existing)
            self._folder(db, parent)
            from .storage import bind_object

            bind_object(self, db, upload_id, self._space_for(db, parent))
            if size > shutil.disk_usage(self._object(upload_id).parent).free:
                raise SpaceError("SPACE_DISK_FULL", 507)
            db.execute(
                "INSERT INTO uploads(id,parent,name,size,modified,space_id) VALUES(?,?,?,?,?,?)",
                (upload_id, parent, name, size, time.time(), self._space_for(db, parent)),
            )
            return dict(db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone())

    def upload_status(self, upload_id: str) -> dict[str, Any]:
        with self._db() as db:
            row = db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
            if row is None:
                raise SpaceError("SPACE_NOT_FOUND", 404)
            return dict(row)

    def upload_chunk(self, upload_id: str, offset: int, data: bytes, digest: str) -> dict[str, Any]:
        if len(data) > CHUNK_SIZE or not data or hashlib.sha256(data).hexdigest() != digest:
            raise SpaceError("SPACE_CHUNK_INVALID")
        with self._db() as db:
            row = db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
            if row is None:
                raise SpaceError("SPACE_NOT_FOUND", 404)
            if row["state"] != "pending" or offset != row["offset"]:
                raise SpaceError("SPACE_UPLOAD_OFFSET", 409)
            self._folder(db, row["parent"])
            if self._space_for(db, row["parent"]) != row["space_id"]:
                raise SpaceError("SPACE_CONTEXT_CHANGED", 409)
            if offset + len(data) > row["size"]:
                raise SpaceError("SPACE_INVALID_SIZE")
            if len(data) > shutil.disk_usage(self._object(upload_id).parent).free:
                raise SpaceError("SPACE_DISK_FULL", 507)
            with self._open(upload_id, partial=True, write=True) as handle:
                if os.fstat(handle.fileno()).st_size < offset:
                    raise SpaceError("SPACE_UPLOAD_DAMAGED", 409)
                handle.truncate(offset)  # Recover an uncommitted chunk after a crash.
                handle.seek(offset)
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            db.execute(
                "UPDATE uploads SET offset=?,modified=? WHERE id=?",
                (offset + len(data), time.time(), upload_id),
            )
            return {"offset": offset + len(data)}

    def upload_complete(self, upload_id: str, expected_digest: str) -> dict[str, Any]:
        with self._db() as db:
            row = db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
            if row is None:
                raise SpaceError("SPACE_NOT_FOUND", 404)
            if row["state"] == "complete":
                return dict(self._entry(db, upload_id, trash=True))
            if row["offset"] != row["size"]:
                raise SpaceError("SPACE_UPLOAD_INCOMPLETE", 409)
            self._folder(db, row["parent"])
            if self._space_for(db, row["parent"]) != row["space_id"]:
                raise SpaceError("SPACE_CONTEXT_CHANGED", 409)
            final = self._object(upload_id)
            partial = self._object(upload_id, True)
            # A crash between rename and transaction commit leaves the final object.
            if not final.exists():
                with self._open(upload_id, partial=True, write=True) as handle:
                    if os.fstat(handle.fileno()).st_size != row["size"]:
                        raise SpaceError("SPACE_UPLOAD_DAMAGED", 409)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(partial, final)
                if os.name == "posix":
                    # Publish the directory entry durably before SQLite commits it.
                    fd = os.open(final.parent, os.O_RDONLY)
                    try:
                        os.fsync(fd)
                    finally:
                        os.close(fd)
            with self._open(upload_id) as handle:
                if os.fstat(handle.fileno()).st_size != row["size"]:
                    raise SpaceError("SPACE_UPLOAD_DAMAGED", 409)
                checksum = hashlib.sha256()
                while chunk := handle.read(CHUNK_SIZE):
                    checksum.update(chunk)
                digest = checksum.hexdigest()
                if digest != expected_digest:
                    raise SpaceError("SPACE_CHUNK_INVALID", 409)
            db.execute(
                "INSERT INTO entries(id,parent,name,kind,size,modified,digest,space_id) VALUES(?,?,?,'file',?,?,?,?)",
                (
                    upload_id,
                    row["parent"],
                    self._name(db, row["parent"], row["name"]),
                    row["size"],
                    time.time(),
                    digest,
                    row["space_id"],
                ),
            )
            db.execute("UPDATE uploads SET state='complete' WHERE id=?", (upload_id,))
            return dict(self._entry(db, upload_id))

    def upload_cancel(self, upload_id: str) -> None:
        with self._db() as db:
            row = db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
            if row and row["state"] == "pending":
                self._object(upload_id, True).unlink(missing_ok=True)
                self._object(upload_id).unlink(missing_ok=True)
                db.execute("DELETE FROM object_locations WHERE id=?", (upload_id,))
                db.execute("DELETE FROM uploads WHERE id=?", (upload_id,))

    def metadata(self, item_id: str) -> dict[str, Any]:
        with self._db() as db:
            return dict(self._entry(db, item_id))

    def read_chunk(self, item_id: str, offset: int, length: int) -> tuple[bytes, dict[str, Any]]:
        if offset < 0 or not 1 <= length <= CHUNK_SIZE:
            raise SpaceError("SPACE_INVALID_RANGE")
        with self._db() as db:
            row = self._entry(db, item_id)
            if row["kind"] != "file":
                raise SpaceError("SPACE_NOT_FILE")
            with self._open(row["blob"] or item_id) as handle:
                handle.seek(offset)
                return handle.read(length), dict(row)

    def restore_version(self, item_id: str, expected: int) -> dict[str, Any]:
        with self._db() as db:
            row = self._entry(db, item_id)
            if row["version"] != expected:
                raise SpaceError("SPACE_VERSION_CONFLICT", 409)
            if not row["previous_blob"]:
                raise SpaceError("SPACE_PREVIOUS_VERSION_MISSING", 404)
            db.execute(
                "UPDATE entries SET blob=?,size=?,digest=?,previous_blob=?,previous_size=?,previous_digest=?,version=version+1,modified=? WHERE id=?",
                (
                    row["previous_blob"],
                    row["previous_size"],
                    row["previous_digest"],
                    row["blob"] or item_id,
                    row["size"],
                    row["digest"],
                    time.time(),
                    item_id,
                ),
            )
            return dict(self._entry(db, item_id))

    def overview(self) -> dict[str, Any]:
        with self._db() as db:
            used = db.execute(
                "SELECT COALESCE(SUM(size + previous_size),0) FROM entries WHERE kind='file'"
            ).fetchone()[0]
            pending = db.execute(
                "SELECT COALESCE(SUM(offset),0) FROM uploads WHERE state='pending'"
            ).fetchone()[0]
            sync_bytes = 0
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='space_sync_records'").fetchone():
                sync_bytes = db.execute(
                    "SELECT COALESCE(SUM(size),0) FROM space_sync_records"
                ).fetchone()[0]
        disk = shutil.disk_usage(self.objects)
        # Container measurements are not advertised as whole-box memory.
        container = (
            Path("/.dockerenv").exists()
            or Path("/run/.containerenv").exists()
            or os.environ.get("OCTOP_IN_CONTAINER") == "1"
        )
        memory: dict[str, Any] | None = None
        cpu: dict[str, Any] | None = None
        if not container:
            with contextlib.suppress(OSError, NotImplementedError, psutil.Error):
                vm = psutil.virtual_memory()
                memory = {
                    "scope": "host",
                    "total": vm.total,
                    "used": vm.total - vm.available,
                    "percent": vm.percent,
                }
            with contextlib.suppress(OSError, NotImplementedError, psutil.Error):
                cpu = {"scope": "host", "percent": psutil.cpu_percent(interval=0.1)}
        return {
            "protocolVersion": 1,
            "chunkSize": CHUNK_SIZE,
            "collectedAt": time.time(),
            "filesBytes": used,
            "syncBytes": sync_bytes,
            "pendingBytes": pending,
            "volume": {
                "scope": "personal-files-volume",
                "total": disk.total,
                "used": disk.used,
                "free": disk.free,
            },
            "memory": memory,
            "cpu": cpu,
            "container": container,
        }
