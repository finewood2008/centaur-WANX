"""Private, synchronous journal of pending binding evidence; never an authority store.

The caller coordinates one boot ID across workers. A different boot invalidates
all pending evidence and fences older connections. No runtime route uses this
module. Callers integrating with asyncio must move its I/O off the event loop.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import sqlite3
import stat
import threading
from contextlib import contextmanager
from pathlib import Path

from .local_trust_protocol import (
    BindingProtocolError,
    decode_cancel_payload,
    request_digest,
    validate_box_context,
    validate_request_context,
    verify_cancel_proof,
    verify_request_proof,
)

_MAX_INTEGER = 9007199254740991
_CHALLENGE_TTL = 300
_MAX_CHALLENGES = 128
_MAX_PENDING = 128
_MAX_REQUESTS = 4096
_DATABASE_NAME = "binding-requests.sqlite3"


def _fail(code: str) -> None:
    raise BindingProtocolError(code)


def _check_time(now: int) -> None:
    if type(now) is not int or not 0 < now <= _MAX_INTEGER - _CHALLENGE_TTL:
        _fail("LOCAL_BINDING_INVALID")


def _private_database(directory: Path) -> Path:
    # Windows requires a reviewed native ACL implementation, not chmod's
    # misleading POSIX mode bits. This journal is not a deployed runtime yet.
    if os.name != "posix":
        _fail("LOCAL_BINDING_STORE_UNSUPPORTED_PLATFORM")
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = directory.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) & 0o077
    ):
        _fail("LOCAL_BINDING_STORE_PATH_INVALID")
    path = directory / _DATABASE_NAME
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    except OSError as error:
        raise BindingProtocolError("LOCAL_BINDING_STORE_PATH_INVALID") from error
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600
        ):
            _fail("LOCAL_BINDING_STORE_PATH_INVALID")
    finally:
        os.close(fd)
    # Never let SQLite open an attacker-supplied journal/sidecar symlink.
    for suffix in ("-journal", "-wal", "-shm"):
        sidecar = path.with_name(path.name + suffix)
        try:
            info = sidecar.lstat()
        except FileNotFoundError:
            continue
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & 0o077
        ):
            _fail("LOCAL_BINDING_STORE_PATH_INVALID")
    return path


class BindingRequestStore:
    """An evidence journal exposing no approval, binding or session operation."""

    def __init__(self, directory: str | Path, *, boot_id: str):
        if not isinstance(boot_id, str) or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", boot_id
        ):
            _fail("LOCAL_BINDING_INVALID")
        self._boot_id = boot_id
        self._lock = threading.RLock()
        self._closed = False
        path = _private_database(Path(directory))
        self._db = sqlite3.connect(path, timeout=5, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        try:
            self._db.execute("PRAGMA journal_mode = DELETE")
            self._db.execute("PRAGMA synchronous = FULL")
            self._db.execute("BEGIN IMMEDIATE")
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS boot (singleton INTEGER PRIMARY KEY CHECK(singleton=1), boot_id TEXT NOT NULL, last_seen_now INTEGER NOT NULL)"
            )
            self._db.execute("CREATE TABLE IF NOT EXISTS retired_boots (boot_id TEXT PRIMARY KEY)")
            self._db.execute("""CREATE TABLE IF NOT EXISTS challenges (
                challenge TEXT PRIMARY KEY, boot_id TEXT NOT NULL, context_json TEXT NOT NULL,
                issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
                consumed_request_id TEXT, invalidated INTEGER NOT NULL DEFAULT 0 CHECK(invalidated IN (0,1))
            )""")
            self._db.execute("""CREATE TABLE IF NOT EXISTS requests (
                request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, request_json TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('pending','cancelled','expired')),
                expires_at INTEGER NOT NULL
            )""")
            previous = self._db.execute("SELECT boot_id FROM boot WHERE singleton=1").fetchone()
            if previous is None:
                self._db.execute("INSERT INTO boot VALUES (1, ?, 0)", (boot_id,))
            elif previous["boot_id"] != boot_id:
                if self._db.execute(
                    "SELECT 1 FROM retired_boots WHERE boot_id=?", (boot_id,)
                ).fetchone():
                    _fail("LOCAL_BINDING_BOOT_MISMATCH")
                self._db.execute("UPDATE requests SET state='expired' WHERE state='pending'")
                self._db.execute(
                    "UPDATE challenges SET invalidated=1 WHERE consumed_request_id IS NULL"
                )
                self._db.execute("INSERT INTO retired_boots VALUES (?)", (previous["boot_id"],))
                self._db.execute(
                    "UPDATE boot SET boot_id=?, last_seen_now=0 WHERE singleton=1", (boot_id,)
                )
            self._db.commit()
        except BaseException:
            self._db.rollback()
            self._db.close()
            raise

    @contextmanager
    def _transaction(self, now: int):
        # RLock protects one connection. SQLite's write transaction, not the
        # process lock, serializes independent workers and prevents TOCTOU.
        with self._lock:
            if self._closed:
                _fail("LOCAL_BINDING_STORE_CLOSED")
            self._db.execute("BEGIN IMMEDIATE")
            try:
                boot = self._db.execute(
                    "SELECT boot_id, last_seen_now FROM boot WHERE singleton=1"
                ).fetchone()
                if boot is None or boot["boot_id"] != self._boot_id:
                    _fail("LOCAL_BINDING_BOOT_MISMATCH")
                if now < boot["last_seen_now"]:
                    _fail("LOCAL_BINDING_CLOCK_ROLLBACK")
                self._db.execute("UPDATE boot SET last_seen_now=? WHERE singleton=1", (now,))
                self._expire(now)
                self._db.execute("SAVEPOINT evidence_operation")
                try:
                    yield
                except BindingProtocolError:
                    # Expected rejections retain clock/expiry maintenance, but
                    # never partial evidence writes. Unexpected I/O/database
                    # failures roll back the entire transaction below.
                    self._db.execute("ROLLBACK TO evidence_operation")
                    self._db.execute("RELEASE evidence_operation")
                    self._db.commit()
                    raise
                self._db.execute("RELEASE evidence_operation")
                self._db.commit()
            except BaseException:
                self._db.rollback()
                raise

    def _expire(self, now: int) -> None:
        self._db.execute(
            "UPDATE requests SET state='expired' WHERE state='pending' AND expires_at<=?", (now,)
        )
        # Request IDs are permanent replay tombstones. Only expired challenges
        # can be removed: freshness prevents accepting their proofs again.
        self._db.execute("DELETE FROM challenges WHERE expires_at<=?", (now,))

    @staticmethod
    def _receipt(row) -> dict:
        return {
            "requestId": row["request_id"],
            "requestDigest": row["digest"],
            "state": row["state"],
            "expiresAt": row["expires_at"],
        }

    def issue_challenge(self, context: dict, now: int) -> dict:
        _check_time(now)
        with self._transaction(now):
            validate_box_context(context)
            context_json = json.dumps(context, sort_keys=True, separators=(",", ":"))
            if self._db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] >= _MAX_REQUESTS:
                _fail("LOCAL_BINDING_REQUEST_CAPACITY")
            count = self._db.execute(
                "SELECT COUNT(*) FROM challenges WHERE consumed_request_id IS NULL AND invalidated=0 AND boot_id=?",
                (self._boot_id,),
            ).fetchone()[0]
            if count >= _MAX_CHALLENGES:
                _fail("LOCAL_BINDING_CHALLENGE_CAPACITY")
            challenge = secrets.token_urlsafe(32)
            self._db.execute(
                "INSERT INTO challenges (challenge, boot_id, context_json, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)",
                (challenge, self._boot_id, context_json, now, now + _CHALLENGE_TTL),
            )
            return {"challenge": challenge, "issuedAt": now, "expiresAt": now + _CHALLENGE_TTL}

    def submit(self, jws: str, now: int) -> dict:
        _check_time(now)
        with self._transaction(now):
            request = verify_request_proof(jws)
            digest = request_digest(request)
            previous = self._db.execute(
                "SELECT * FROM requests WHERE request_id=?", (request["requestId"],)
            ).fetchone()
            if previous is not None:
                if previous["digest"] != digest:
                    _fail("LOCAL_BINDING_REQUEST_CONFLICT")
                return self._receipt(previous)
            challenge = self._db.execute(
                "SELECT * FROM challenges WHERE challenge=?", (request["challenge"],)
            ).fetchone()
            if (
                challenge is None
                or challenge["invalidated"]
                or challenge["boot_id"] != self._boot_id
            ):
                _fail("LOCAL_BINDING_CHALLENGE_INVALID")
            if challenge["consumed_request_id"] is not None:
                _fail("LOCAL_BINDING_CHALLENGE_USED")
            context = json.loads(challenge["context_json"])
            context["challenge"] = request["challenge"]
            validate_request_context(request, context, now)
            if (
                not challenge["issued_at"]
                <= request["issuedAt"]
                < request["expiresAt"]
                <= challenge["expires_at"]
            ):
                _fail("LOCAL_BINDING_CHALLENGE_INVALID")
            pending, retained = self._db.execute(
                "SELECT COUNT(CASE WHEN state='pending' THEN 1 END), COUNT(*) FROM requests"
            ).fetchone()
            if pending >= _MAX_PENDING or retained >= _MAX_REQUESTS:
                _fail("LOCAL_BINDING_REQUEST_CAPACITY")
            self._db.execute(
                "INSERT INTO requests VALUES (?, ?, ?, 'pending', ?)",
                (
                    request["requestId"],
                    digest,
                    json.dumps(request, sort_keys=True, separators=(",", ":")),
                    request["expiresAt"],
                ),
            )
            self._db.execute(
                "UPDATE challenges SET consumed_request_id=? WHERE challenge=?",
                (request["requestId"], request["challenge"]),
            )
            row = self._db.execute(
                "SELECT * FROM requests WHERE request_id=?", (request["requestId"],)
            ).fetchone()
            return self._receipt(row)

    def cancel(self, jws: str, now: int) -> dict:
        _check_time(now)
        with self._transaction(now):
            locator = decode_cancel_payload(jws)
            row = self._db.execute(
                "SELECT * FROM requests WHERE request_id=?", (locator["requestId"],)
            ).fetchone()
            if row is None:
                _fail("LOCAL_BINDING_REQUEST_NOT_FOUND")
            # The unverified payload locates a key only, never authorizes an
            # operation or discloses a saved receipt before signature checking.
            verify_cancel_proof(jws, json.loads(row["request_json"]), now)
            self._db.execute(
                "UPDATE requests SET state='cancelled' WHERE request_id=? AND state='pending'",
                (locator["requestId"],),
            )
            row = self._db.execute(
                "SELECT * FROM requests WHERE request_id=?", (locator["requestId"],)
            ).fetchone()
            return self._receipt(row)

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._db.close()
                self._closed = True
