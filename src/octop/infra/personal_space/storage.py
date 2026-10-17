"""Verified relocation of service-owned space objects; never imports host folders."""

from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import uuid
from pathlib import Path
from typing import Any

from .service import CHUNK_SIZE, SpaceError, _safe_file


def safe_directory(directory: Path) -> None:
    if not directory.is_dir() or any(p.is_symlink() for p in (directory, *directory.parents)):
        raise SpaceError("SPACE_STORAGE_UNAVAILABLE", 409)


def directory_for(service: Any, db: sqlite3.Connection, space_id: str) -> Path:
    row = db.execute("SELECT directory FROM space_storage WHERE space_id=?", (space_id,)).fetchone()
    return Path(row[0]) if row else Path(service.objects)


def bind_object(service: Any, db: sqlite3.Connection, blob: str, space_id: str) -> None:
    directory = directory_for(service, db, space_id)
    safe_directory(directory)
    db.execute("INSERT OR REPLACE INTO object_locations VALUES(?,?)", (blob, str(directory)))


def info(service: Any, db: sqlite3.Connection, space_id: str) -> dict[str, Any]:
    row = db.execute("SELECT * FROM space_storage WHERE space_id=?", (space_id,)).fetchone()
    directory = directory_for(service, db, space_id)
    result: dict[str, Any] = {
        "path": row["base"] if row else "",
        "directory": str(directory),
        "available": False,
    }
    try:
        safe_directory(directory)
        disk = shutil.disk_usage(directory)
        result.update(available=True, free=disk.free, total=disk.total, used=disk.used)
    except (OSError, SpaceError):
        pass
    return result


def destination(service: Any, db: sqlite3.Connection, space_id: str, base: str) -> Path:
    if not base:
        return Path(service.objects)
    selected = Path(base)
    if not selected.is_absolute() or not selected.is_dir():
        raise SpaceError("SPACE_STORAGE_PATH_INVALID")
    # Resolve a user-selected volume once; managed descendants must never be links.
    selected = selected.resolve(strict=True)
    if (
        selected == Path(selected.anchor)
        or selected == service.root
        or selected.is_relative_to(service.root)
    ):
        raise SpaceError("SPACE_STORAGE_PATH_INVALID")
    namespace = db.execute("SELECT value FROM space_storage_meta WHERE key='namespace'").fetchone()[
        0
    ]
    directory = selected
    for component in (".wanx-space", namespace, space_id):
        directory = directory / component
        directory.mkdir(exist_ok=True, mode=0o700)
        safe_directory(directory)
    return directory


def digest(path: Path) -> str:
    _safe_file(path)
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def relocate(
    service: Any,
    db: sqlite3.Connection,
    blobs: set[str],
    directory: Path,
    required: dict[str, tuple[int, str]],
) -> tuple[list[Path], list[Path]]:
    """Copy and verify before changing mappings inside the caller's transaction."""
    safe_directory(directory)
    originals: list[Path] = []
    created: list[Path] = []
    staging: Path | None = None
    try:
        for blob in sorted(blobs):
            for partial in (False, True):
                source = service._object(blob, partial)
                target = directory / source.name
                if source == target:
                    continue
                if not source.exists():
                    if not partial and blob in required:
                        raise SpaceError("SPACE_STORAGE_SOURCE_MISSING", 409)
                    continue
                _safe_file(source)
                checksum = digest(source)
                if not partial and blob in required:
                    size, expected = required[blob]
                    if source.stat().st_size != size or (expected and checksum != expected):
                        raise SpaceError("SPACE_CHUNK_INVALID", 409)
                if target.exists() or target.is_symlink():
                    if digest(target) != checksum:
                        raise SpaceError("SPACE_STORAGE_TARGET_CONFLICT", 409)
                else:
                    if source.stat().st_size > shutil.disk_usage(directory).free:
                        raise SpaceError("SPACE_DISK_FULL", 507)
                    staging = directory / (".migrating-" + uuid.uuid4().hex)
                    with source.open("rb") as reader, staging.open("xb") as writer:
                        shutil.copyfileobj(reader, writer, CHUNK_SIZE)
                        writer.flush()
                        os.fsync(writer.fileno())
                    if digest(staging) != checksum:
                        raise SpaceError("SPACE_CHUNK_INVALID", 409)
                    # Publish without replacing anything an interrupted run left behind.
                    os.link(staging, target)
                    created.append(target)
                    staging.unlink()
                    staging = None
                originals.append(source)
            db.execute(
                "INSERT OR REPLACE INTO object_locations VALUES(?,?)", (blob, str(directory))
            )
        if os.name == "posix":
            fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        return originals, created
    except BaseException:
        if staging:
            staging.unlink(missing_ok=True)
        for path in created:
            path.unlink(missing_ok=True)
        raise


def cleanup(service: Any, paths: list[Path]) -> int:
    remaining = 0
    with service._db() as db:
        for path in paths:
            try:
                blob = path.stem
                referenced = db.execute(
                    "SELECT 1 FROM entries WHERE COALESCE(blob,id)=? OR previous_blob=? UNION SELECT 1 FROM uploads WHERE id=? AND state='pending'",
                    (blob, blob, blob),
                ).fetchone()
                # A second migration may have moved this object back after our commit.
                if referenced and service._object(blob, path.suffix == ".part") == path:
                    continue
                _safe_file(path, missing=True)
                path.unlink(missing_ok=True)
            except (OSError, SpaceError):
                remaining += 1
    return remaining


def set_storage(service: Any, space_id: str, base: str) -> dict[str, Any]:
    originals: list[Path] = []
    created: list[Path] = []
    try:
        with service._db() as db:
            service._space(db, space_id)
            directory = destination(service, db, space_id, base)
            required: dict[str, tuple[int, str]] = {}
            for row in db.execute(
                "SELECT * FROM entries WHERE space_id=? AND kind='file'", (space_id,)
            ):
                required[row["blob"] or row["id"]] = (row["size"], row["digest"] or "")
                if row["previous_blob"]:
                    required[row["previous_blob"]] = (
                        row["previous_size"],
                        row["previous_digest"] or "",
                    )
            blobs = set(required)
            blobs.update(
                r[0]
                for r in db.execute(
                    "SELECT id FROM uploads WHERE space_id=? AND state='pending'", (space_id,)
                )
            )
            originals, created = relocate(service, db, blobs, directory, required)
            if base:
                db.execute(
                    "INSERT OR REPLACE INTO space_storage VALUES(?,?,?)",
                    (space_id, str(Path(base).resolve()), str(directory)),
                )
            else:
                db.execute("DELETE FROM space_storage WHERE space_id=?", (space_id,))
            result = info(service, db, space_id)
    except BaseException:
        cleanup(service, created)
        raise
    # The index is committed before retiring old copies. Failure here never rolls back data.
    result["cleanup_pending"] = cleanup(service, originals)
    result["migrated_objects"] = len(required)
    return result
