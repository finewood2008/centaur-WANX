"""Process-safe immutable package cache maintenance; never touches Octop data.

Lock order is prepare.lock -> cache.lock. Runtime preparation already holds the
former and only takes the latter when downloading. Cleanup runs separately and
skips a busy prepare.lock, so it cannot remove a package being installed.
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import os
import re
import stat
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from .config import BridgeAuthError
from .resources_contract import fail, version

CACHE_MAX_BYTES = 1024 * 1024 * 1024
CACHE_MIN_FREE_BYTES = 256 * 1024 * 1024
CACHE_RETENTION_SECONDS = 30 * 24 * 60 * 60
_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_STATE_LIMIT = 16 * 1024 * 1024


async def cache_io(operation: Callable[..., Any], *args: Any) -> Any:
    """Finish filesystem work before releasing a lock, even on cancellation."""
    task = asyncio.create_task(asyncio.to_thread(operation, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError as cancelled:
        # A second cancellation must not cancel the worker Task while its thread
        # still writes. Keep shielding until completion before a caller can drop
        # prepare.lock/cache.lock; preserve a failed write as the cancellation's
        # cause so it is consumed and remains diagnosable.
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except BaseException:
                break
        try:
            task.result()
        except BaseException as operation_error:
            raise cancelled from operation_error
        raise cancelled


@asynccontextmanager
async def cache_lock(
    directory: Path, *, prepare: bool = False, timeout: float = 180
) -> AsyncIterator[bool]:
    """Take a separate file description lock; preparation locks never wait."""
    if directory.is_symlink() or not directory.is_dir():
        raise fail("RESOURCE_LOCAL_STATE_INVALID", 503)
    try:
        fd = os.open(
            directory / ("prepare.lock" if prepare else "cache.lock"),
            os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
    except OSError as exc:
        raise fail("RESOURCE_LOCAL_STATE_INVALID", 503) from exc
    acquired = False
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise fail("RESOURCE_LOCAL_STATE_INVALID", 503)
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except BlockingIOError:
                if prepare:
                    break
                if time.monotonic() >= deadline:
                    raise fail("RESOURCE_CACHE_BUSY", 503) from None
                await asyncio.sleep(0.05)
        yield acquired
    finally:
        if acquired:
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _json(path: Path) -> dict[str, Any]:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, child in pairs:
            if key in value:
                raise ValueError("duplicate state field")
            value[key] = child
        return value

    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > _STATE_LIMIT:
            raise ValueError("invalid state file")
        value = json.load(stream, object_pairs_hook=unique)
    if not isinstance(value, dict) or type(value.get("schemaVersion")) is not int:
        raise ValueError("unknown state format")
    if value["schemaVersion"] != 1:
        raise ValueError("unknown state version")
    return value


def _entries(directory: Path) -> list[Path]:
    if directory.is_symlink():
        raise ValueError("linked state directory")
    if not directory.exists():
        return []
    if not directory.is_dir():
        raise ValueError("invalid state directory")
    result = list(directory.iterdir())
    if any(path.is_symlink() or not path.is_file() for path in result):
        raise ValueError("unknown or linked state entry")
    return result


def _state_files(directory: Path) -> list[Path]:
    result = _entries(directory)
    if any(not _DIGEST.fullmatch(path.stem) or path.suffix != ".json" for path in result):
        raise ValueError("unknown state file")
    return result


def cache_bytes(directory: Path) -> int:
    """Validate cache directories before reads and count all retained package bytes."""
    _entries(directory / "envelopes")
    return sum(path.stat().st_size for path in _entries(directory / "packages"))


def _references(directory: Path, verify: Callable[[Any], dict[str, Any]]) -> set[str]:
    referenced: set[str] = set()

    def collect(value: Any) -> None:
        # Dependency snapshots and older records may contain additional hashes.
        # Keeping extra immutable bytes is safer than guessing which are unused.
        if isinstance(value, str) and _DIGEST.fullmatch(value):
            referenced.add(value)
        elif isinstance(value, dict):
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    def envelope(value: Any, *, pin: bool = True) -> str:
        digest = verify(value)["package"]["sha256"]
        if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
            raise ValueError("invalid envelope digest")
        if pin:
            referenced.add(digest)
        return digest

    def record(value: Any) -> None:
        if (
            not isinstance(value, dict)
            or not isinstance(value.get("digest"), str)
            or not _DIGEST.fullmatch(value["digest"])
            or value.get("status") not in {"preparing", "ready"}
        ):
            raise ValueError("unknown resource record")
        version(value.get("version"))
        if value["status"] == "ready" and "envelope" not in value:
            raise ValueError("unverified ready resource")
        if "envelope" in value and envelope(value["envelope"]) != value["digest"]:
            raise ValueError("inconsistent resource record")
        if "dependencyResources" in value:
            if not isinstance(value["dependencyResources"], dict):
                raise ValueError("unknown dependency snapshots")
            for dependency in value["dependencyResources"].values():
                record(dependency)
        collect(value)

    # Candidate ledgers pin the previous and newly prepared bindings until an
    # explicit future retention protocol can prove that no client selects them.
    # Merely having a newer candidate does not authorize deleting the old bytes.
    for path in _state_files(directory / "bindings") + _state_files(directory / "binding-sets"):
        value = _json(path)
        candidate = path.parent.name == "binding-sets"
        if (
            set(value)
            - (
                {"schemaVersion", "scope", "resources", "pendingResources"}
                | ({"bindingSetStatus"} if candidate else set())
            )
            or not isinstance(value.get("scope"), dict)
            or not isinstance(value.get("resources"), dict)
            or not isinstance(value.get("pendingResources", {}), dict)
            or (candidate and value.get("bindingSetStatus") not in {"preparing", "ready"})
        ):
            raise ValueError("unknown binding ledger")
        for group in (value["resources"], value.get("pendingResources", {})):
            for item in group.values():
                record(item)

    instances = directory / "instances"
    if instances.is_symlink():
        raise ValueError("linked instance indexes")
    if instances.exists():
        if not instances.is_dir() or any(
            path.name not in {"skills", "experts"} or path.is_symlink() or not path.is_dir()
            for path in instances.iterdir()
        ):
            raise ValueError("unknown instance index")
    for kind in ("skills", "experts"):
        for path in _state_files(instances / kind):
            value = _json(path)
            if set(value) != {"schemaVersion", "identity", "record"} or not isinstance(
                value["identity"], dict
            ):
                raise ValueError("unknown shared instance ledger")
            record(value["record"])

    for path in _state_files(directory / "resolutions"):
        value = _json(path)
        if set(value) != {
            "schemaVersion",
            "applicationId",
            "artifactId",
            "backendProductId",
            "requirements",
            "resources",
        } | ({"releaseAccess"} if "releaseAccess" in value else set()):
            raise ValueError("unknown resolution ledger")
        if not isinstance(value["resources"], list):
            raise ValueError("unknown resolution resources")
        for item in value["resources"]:
            # Historical artifact resolutions are not installed bindings. Keeping
            # them forever would pin every past release after an application update.
            # Installed records and recent cache use protect bytes actually in use.
            envelope(item, pin=False)

    catalog = directory / "catalog.json"
    if catalog.exists() or catalog.is_symlink():
        value = _json(catalog)
        if set(value) != {"schemaVersion", "items"} or not isinstance(value["items"], list):
            raise ValueError("unknown catalog")
        for item in value["items"]:
            envelope(item)
    return referenced


def _collect(
    directory: Path,
    verify: Callable[[Any], dict[str, Any]],
    now: float,
    retention: float,
) -> dict[str, Any]:
    try:
        referenced = _references(directory, verify)
        candidates: dict[str, list[tuple[Path, os.stat_result]]] = {}
        for name in ("packages", "envelopes"):
            for path in _entries(directory / name):
                if path.suffix != ".json" or not _DIGEST.fullmatch(path.stem):
                    # Only exact, content-addressed cache files are ever removed.
                    continue
                info = path.lstat()
                if info.st_nlink != 1:
                    raise ValueError("linked cache entry")
                candidates.setdefault(path.stem, []).append((path, info))
        removable = [
            files
            for digest, files in candidates.items()
            if digest not in referenced
            and all(info.st_mtime <= now - retention for _, info in files)
        ]
    except (BridgeAuthError, OSError, ValueError, TypeError, KeyError, RecursionError):
        # Finish every validation before deleting even one byte. A newer writer's
        # state or damaged ledger must never be interpreted as "nothing in use".
        return {
            "status": "skipped",
            "code": "RESOURCE_CACHE_STATE_UNVERIFIED",
            "removed": 0,
            "reclaimedBytes": 0,
        }
    removed = reclaimed = 0
    for files in removable:
        for path, info in files:
            current = path.lstat()
            if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) != (
                info.st_dev,
                info.st_ino,
            ):
                raise fail("RESOURCE_LOCAL_STATE_INVALID", 503)
            path.unlink()
            reclaimed += info.st_size
        removed += 1
    return {"status": "ok", "removed": removed, "reclaimedBytes": reclaimed}


async def cleanup_cache(
    directory: Path,
    verify: Callable[[Any], dict[str, Any]],
    *,
    now: float | None = None,
    retention: float = CACHE_RETENTION_SECONDS,
) -> dict[str, Any]:
    """Delete only old unreferenced immutable cache bytes, with conservative roots."""
    if retention < 0:
        raise ValueError("negative cache retention")
    async with cache_lock(directory, prepare=True) as acquired:
        if not acquired:
            return {
                "status": "skipped",
                "code": "RESOURCE_PREPARATION_BUSY",
                "removed": 0,
                "reclaimedBytes": 0,
            }
        async with cache_lock(directory):
            return await cache_io(
                _collect, directory, verify, time.time() if now is None else now, retention
            )
