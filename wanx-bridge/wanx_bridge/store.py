"""Bridge-owned SQLite replay and authorization state. No upstream DB access."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import stat
import threading
import time
from pathlib import Path
from typing import Any

from .config import BridgeAuthError

CONTEXT_FIELDS = (
    "sub",
    "client_id",
    "device_id",
    "network_session_id",
    "ownership_epoch",
    "authorization_version",
    "account_auth_version",
    "client_session_version",
    "membership_id",
    "membership_version",
    "role",
)
MAX_CHALLENGES = 4096
MAX_IDENTITY_CHALLENGES = 8
MAX_LEASE_IDENTITIES = 10000
MAX_ACTIVE_TOKENS = 10000
MAX_RETIRED_CONTEXTS = 10000


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


class Store:
    def __init__(self, directory: Path) -> None:
        directory = Path(directory)
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directory.is_symlink():
            raise BridgeAuthError("BOX_PLATFORM_STATE_INVALID", 503)
        os.chmod(directory, 0o700)
        self.path = directory / "auth.sqlite3"
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                metadata = os.fstat(fd)
                if not stat.S_ISREG(metadata.st_mode) or (
                    os.name == "posix" and metadata.st_uid != os.getuid()
                ):
                    raise BridgeAuthError("BOX_PLATFORM_STATE_INVALID", 503)
                if os.name == "posix":
                    os.fchmod(fd, 0o600)
            finally:
                os.close(fd)
        except OSError as exc:
            raise BridgeAuthError("BOX_PLATFORM_STATE_INVALID", 503) from exc
        self.db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.lock = threading.RLock()
        # DELETE journal avoids leaving WAL files with different permission modes.
        self.db.executescript("""
            PRAGMA journal_mode=DELETE;
            PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, proof TEXT NOT NULL, exp INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, context TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS retired (sid TEXT PRIMARY KEY, expires_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, lease_key TEXT NOT NULL, exp REAL NOT NULL);
        """)
        if "expires_at" not in {row[1] for row in self.db.execute("PRAGMA table_info(retired)")}:
            self.db.execute("ALTER TABLE retired ADD COLUMN expires_at REAL NOT NULL DEFAULT 0")
            self.db.execute("UPDATE retired SET expires_at=?", (time.time() + 120,))

    def _collect(self) -> None:
        now = time.time()
        self.db.execute("DELETE FROM challenges WHERE exp <= ?", (now,))
        self.db.execute("DELETE FROM tokens WHERE exp <= ?", (now,))
        self.db.execute("DELETE FROM retired WHERE expires_at <= ?", (now,))

    def challenge(self, proof: dict[str, Any]) -> None:
        with self.lock:
            self._collect()
            if self.db.execute("SELECT COUNT(*) FROM challenges").fetchone()[0] >= MAX_CHALLENGES:
                raise BridgeAuthError("BOX_PLATFORM_BUSY", 429)
            count = self.db.execute(
                "SELECT COUNT(*) FROM challenges WHERE json_extract(proof,'$.sub')=? AND json_extract(proof,'$.client_id')=?",
                (proof["sub"], proof["client_id"]),
            ).fetchone()[0]
            if count >= MAX_IDENTITY_CHALLENGES:
                raise BridgeAuthError("BOX_PLATFORM_BUSY", 429)
            self.db.execute(
                "INSERT INTO challenges VALUES (?, ?, ?)",
                (proof["challenge_id"], json.dumps(proof), proof["exp"]),
            )

    def _validate(
        self, claims: dict[str, Any]
    ) -> tuple[str, str, list[tuple[str, dict[str, Any]]]]:
        key = digest({k: claims[k] for k in ("sub", "client_id", "device_id")})
        sid = digest({k: claims[k] for k in CONTEXT_FIELDS})
        if self.db.execute("SELECT 1 FROM retired WHERE sid=?", (sid,)).fetchone():
            raise BridgeAuthError()
        invalidate = []
        for old_key, raw in self.db.execute("SELECT key,context FROM leases"):
            old = json.loads(raw)
            if old["device_id"] != claims["device_id"]:
                continue
            if claims["ownership_epoch"] < old["ownership_epoch"]:
                raise BridgeAuthError()
            changed = claims["ownership_epoch"] > old["ownership_epoch"]
            if old["sub"] == claims["sub"]:
                for field in ("account_auth_version", "authorization_version"):
                    if claims[field] < old[field]:
                        raise BridgeAuthError()
                    changed = changed or claims[field] > old[field]
                if claims["membership_id"] == old["membership_id"]:
                    if claims["membership_version"] < old["membership_version"]:
                        raise BridgeAuthError()
                    changed = changed or claims["membership_version"] > old["membership_version"]
                for field in ("membership_id", "role"):
                    if claims[field] != old[field]:
                        # Authority changes require a monotonic version change. An
                        # issue timestamp alone must not resurrect a retired role
                        # through another client identity.
                        if not changed:
                            raise BridgeAuthError()
                        changed = True
                if old_key == key:
                    if (
                        claims["client_session_version"] < old["client_session_version"]
                        or claims["iat"] < old["iat"]
                    ):
                        raise BridgeAuthError()
                    if old["sid"] != sid:
                        if (
                            claims["iat"] == old["iat"]
                            and not changed
                            and claims["client_session_version"] == old["client_session_version"]
                        ):
                            raise BridgeAuthError()
                        changed = True
            if changed:
                invalidate.append((old_key, old))
        return key, sid, invalidate

    def consume(self, claims: dict[str, Any]) -> None:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                row = self.db.execute(
                    "DELETE FROM challenges WHERE id=? RETURNING proof,exp",
                    (claims["challenge_id"],),
                ).fetchone()
                # Commit even invalid context consumes the challenge once.
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise
            if row is None or row[1] <= time.time():
                raise BridgeAuthError()
            proof = json.loads(row[0])
            if any(
                claims[k] != proof[k]
                for k in (
                    "sub",
                    "client_id",
                    "device_id",
                    "network_session_id",
                    "challenge_id",
                    "nonce",
                )
            ):
                raise BridgeAuthError()
            self._prepare(claims)

    def _prepare(self, claims: dict[str, Any]) -> None:
        """Fence stale authority before the adapter can mutate an upstream role."""
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._collect()
            key, sid, invalidate = self._validate(claims)
            previous = self.db.execute("SELECT context FROM leases WHERE key=?", (key,)).fetchone()
            if (
                previous is None
                and self.db.execute("SELECT COUNT(*) FROM leases").fetchone()[0]
                >= MAX_LEASE_IDENTITIES
            ):
                raise BridgeAuthError("BOX_PLATFORM_CAPACITY", 503)
            if (
                self.db.execute("SELECT COUNT(*) FROM retired").fetchone()[0] + len(invalidate)
                > MAX_RETIRED_CONTEXTS
            ):
                raise BridgeAuthError("BOX_PLATFORM_BUSY", 429)
            for old_key, old in invalidate:
                self.db.execute(
                    "INSERT OR REPLACE INTO retired VALUES (?,?)", (old["sid"], time.time() + 120)
                )
                old["lease_exp"] = 0
                self.db.execute(
                    "UPDATE leases SET context=? WHERE key=?", (json.dumps(old), old_key)
                )
            previous_context = json.loads(previous[0]) if previous else None
            # Failed login still keeps the new version watermark, but never grants
            # a lease. A normal same-authority renewal preserves ongoing streams.
            current = {
                **{k: claims[k] for k in CONTEXT_FIELDS},
                "sid": sid,
                "iat": claims["iat"],
                "lease_exp": previous_context["lease_exp"]
                if previous_context and previous_context["sid"] == sid
                else 0,
            }
            self.db.execute(
                "INSERT OR REPLACE INTO leases VALUES (?,?)", (key, json.dumps(current))
            )
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def activate(
        self, claims: dict[str, Any], token_hash: str, token_exp: float
    ) -> tuple[str, str]:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self._collect()
                key, sid, invalidate = self._validate(claims)
                existing = self.db.execute("SELECT 1 FROM leases WHERE key=?", (key,)).fetchone()
                if (
                    not existing
                    and self.db.execute("SELECT COUNT(*) FROM leases").fetchone()[0]
                    >= MAX_LEASE_IDENTITIES
                ):
                    # Keep authorization watermarks indefinitely. Eviction would
                    # allow old account/client versions to become valid again.
                    raise BridgeAuthError("BOX_PLATFORM_CAPACITY", 503)
                if (
                    self.db.execute("SELECT COUNT(*) FROM tokens").fetchone()[0]
                    >= MAX_ACTIVE_TOKENS
                    or self.db.execute("SELECT COUNT(*) FROM retired").fetchone()[0]
                    + len(invalidate)
                    > MAX_RETIRED_CONTEXTS
                ):
                    raise BridgeAuthError("BOX_PLATFORM_BUSY", 429)
                for old_key, old in invalidate:
                    # Grants expire in <=60 seconds. Keep retired context hashes
                    # twice that long, then reclaim them; version watermarks stay.
                    self.db.execute(
                        "INSERT OR REPLACE INTO retired VALUES (?,?)",
                        (old["sid"], time.time() + 120),
                    )
                    # Keep authorization watermarks so delayed grants cannot restore them.
                    old["lease_exp"] = 0
                    self.db.execute(
                        "UPDATE leases SET context=? WHERE key=?", (json.dumps(old), old_key)
                    )
                previous = self.db.execute(
                    "SELECT context FROM leases WHERE key=?", (key,)
                ).fetchone()
                lease_exp = claims["lease_exp"]
                if previous:
                    old = json.loads(previous[0])
                    if old["sid"] == sid:
                        lease_exp = max(lease_exp, old["lease_exp"])
                current = {
                    **{k: claims[k] for k in CONTEXT_FIELDS},
                    "sid": sid,
                    "iat": claims["iat"],
                    "lease_exp": lease_exp,
                }
                self.db.execute(
                    "INSERT OR REPLACE INTO leases VALUES (?,?)", (key, json.dumps(current))
                )
                self.db.execute("DELETE FROM tokens WHERE exp<=?", (time.time(),))
                self.db.execute("INSERT INTO tokens VALUES (?,?,?)", (token_hash, key, token_exp))
                self.db.execute("COMMIT")
                return key, sid
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def assert_live(self, key: str, sid: str) -> None:
        with self.lock:
            row = self.db.execute("SELECT context FROM leases WHERE key=?", (key,)).fetchone()
            if not row:
                raise BridgeAuthError()
            current = json.loads(row[0])
            if current["sid"] != sid or current["lease_exp"] <= time.time():
                raise BridgeAuthError("BOX_PLATFORM_SESSION_EXPIRED")

    def close(self) -> None:
        with self.lock:
            self.db.close()
