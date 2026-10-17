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
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise SpaceError("SPACE_UNSAFE_STORAGE", 409)


class PersonalSpace:
    def __init__(self, root: Path, user_id: int) -> None:
        if not isinstance(user_id, int) or user_id <= 0:
            raise SpaceError("SPACE_FORBIDDEN", 403)
        # All descendants are service-owned, not selected by a request.
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if root.is_symlink():
            raise SpaceError("SPACE_UNSAFE_STORAGE", 409)
        # The configured deployment root is trusted; macOS /var and /tmp are
        # system symlinks. User-controlled descendants still reject links.
        self.root = root.resolve() / str(user_id)
        self.objects = self.root / "objects"
        for directory in (self.root, self.objects):
            directory.mkdir(exist_ok=True, mode=0o700)
            if directory.is_symlink() or not directory.is_dir():
                raise SpaceError("SPACE_UNSAFE_STORAGE", 409)
        self.database = self.root / "index.sqlite3"
        _safe_file(self.database, missing=True)
        with self._db() as db:
            db.executescript("""
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
                "version": "INTEGER NOT NULL DEFAULT 1",
                "blob": "TEXT",
                "previous_blob": "TEXT",
                "previous_size": "INTEGER NOT NULL DEFAULT 0",
                "previous_digest": "TEXT",
            }.items():
                if column not in columns:
                    db.execute(f"ALTER TABLE entries ADD COLUMN {column} {definition}")

    @contextlib.contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        _safe_file(self.database, missing=True)
        for suffix in ("-journal", "-wal", "-shm"):
            _safe_file(Path(str(self.database) + suffix), missing=True)
        db = sqlite3.connect(self.database, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def _object(self, item_id: str, partial: bool = False) -> Path:
        if not _ID.fullmatch(item_id):
            raise SpaceError("SPACE_NOT_FOUND", 404)
        return self.objects / (item_id + (".part" if partial else ".blob"))

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

    def listing(self, parent: str = "", trash: bool = False) -> dict[str, Any]:
        with self._db() as db:
            self._folder(db, parent)
            rows = db.execute(
                "SELECT * FROM entries WHERE trashed IS NOT NULL ORDER BY trashed DESC"
                if trash
                else "SELECT * FROM entries WHERE parent=? AND trashed IS NULL ORDER BY kind DESC,name COLLATE NOCASE",
                () if trash else (parent,),
            ).fetchall()
            crumbs: list[dict[str, str]] = []
            cursor = parent
            while cursor:
                row = self._entry(db, cursor)
                crumbs.insert(0, {"id": row["id"], "name": row["name"]})
                cursor = row["parent"]
            return {"items": [dict(row) for row in rows], "breadcrumbs": crumbs, "parent": parent}

    def mkdir(self, parent: str, name: str) -> dict[str, Any]:
        with self._db() as db:
            self._folder(db, parent)
            item_id = uuid.uuid4().hex
            db.execute(
                "INSERT INTO entries(id,parent,name,kind,modified) VALUES(?,?,?,'folder',?)",
                (item_id, parent, self._name(db, parent, name), time.time()),
            )
            return dict(self._entry(db, item_id))

    def move(self, item_id: str, parent: str, name: str) -> dict[str, Any]:
        with self._db() as db:
            row = self._entry(db, item_id)
            self._folder(db, parent)
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

    def trash(self, item_id: str) -> None:
        with self._db() as db:
            self._entry(db, item_id)
            db.execute(
                "UPDATE entries SET trashed=?,version=version+1 WHERE id=?", (time.time(), item_id)
            )

    def restore(self, item_id: str) -> dict[str, Any]:
        with self._db() as db:
            row = self._entry(db, item_id, trash=True)
            if row["trashed"] is None:
                raise SpaceError("SPACE_NOT_IN_TRASH")
            parent = row["parent"]
            try:
                self._folder(db, parent)
            except SpaceError:
                parent = ""
            db.execute(
                "UPDATE entries SET parent=?,name=?,trashed=NULL,version=version+1 WHERE id=?",
                (parent, self._name(db, parent, row["name"], item_id), item_id),
            )
            return dict(self._entry(db, item_id))

    def purge(self, item_id: str) -> None:
        with self._db() as db:
            row = self._entry(db, item_id, trash=True)
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
                for blob in {current, record["blob"], record["previous_blob"]} - {None}:
                    self._object(blob).unlink(missing_ok=True)
                db.execute("DELETE FROM entries WHERE id=?", (current,))

    def upload_create(self, parent: str, name: str, size: int, upload_id: str) -> dict[str, Any]:
        self._object(upload_id)
        name = validate_name(name)
        if size < 0 or size > 2**53 - 1:
            raise SpaceError("SPACE_INVALID_SIZE")
        with self._db() as db:
            existing = db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
            if existing:
                if (existing["parent"], existing["name"], existing["size"]) != (parent, name, size):
                    raise SpaceError("SPACE_UPLOAD_CONFLICT", 409)
                return dict(existing)
            self._folder(db, parent)
            if size > shutil.disk_usage(self.objects).free:
                raise SpaceError("SPACE_DISK_FULL", 507)
            db.execute(
                "INSERT INTO uploads(id,parent,name,size,modified) VALUES(?,?,?,?,?)",
                (upload_id, parent, name, size, time.time()),
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
            if offset + len(data) > row["size"]:
                raise SpaceError("SPACE_INVALID_SIZE")
            if len(data) > shutil.disk_usage(self.objects).free:
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
                    fd = os.open(self.objects, os.O_RDONLY)
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
                "INSERT INTO entries(id,parent,name,kind,size,modified,digest) VALUES(?,?,?,'file',?,?,?)",
                (
                    upload_id,
                    row["parent"],
                    self._name(db, row["parent"], row["name"]),
                    row["size"],
                    time.time(),
                    digest,
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
