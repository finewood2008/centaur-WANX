"""Box-owned local management ledger. No cloud authority or data-plane session API.

Only the offline provisioner calls initialize_authority. Runtime construction
requires an existing, sealed database; missing state is never a fresh device.
"""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
import stat
import threading
from contextlib import contextmanager
from pathlib import Path

from . import local_management_protocol as wire
from . import local_trust_protocol as evidence
from .local_resource_catalog import validate_resource_grants
from .local_trust_protocol import BindingProtocolError

DATABASE = "local-authority.sqlite3"
BUNDLE = "private-bundle.json"
KEY = "box-signing-key.pem"
SEAL = "authority-initialized.json"
_CAPACITY = 4096
_TERMINAL_RETENTION = 3600


def _need(condition, code="LOCAL_TRUST_STATE_INVALID"):
    if not condition:
        raise BindingProtocolError(code)


def _directory(directory) -> Path:
    _need(os.name == "posix", "LOCAL_TRUST_UNSUPPORTED_PLATFORM")
    path = Path(os.path.abspath(directory))
    try:
        for entry in (path, *path.parents):
            info = entry.lstat()
            _need(stat.S_ISDIR(info.st_mode), "LOCAL_TRUST_PATH_INVALID")
        info = path.lstat()
        _need(
            info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
            "LOCAL_TRUST_PATH_INVALID",
        )
    except OSError as exc:
        raise BindingProtocolError("LOCAL_TRUST_PATH_INVALID") from exc
    return path


def _read(directory: Path, name: str) -> bytes:
    try:
        fd = os.open(directory / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            _need(
                stat.S_ISREG(info.st_mode)
                and info.st_nlink == 1
                and info.st_uid == os.getuid()
                and stat.S_IMODE(info.st_mode) == 0o600
                and info.st_size <= 65536,
                "LOCAL_TRUST_PATH_INVALID",
            )
            with os.fdopen(fd, "rb", closefd=False) as stream:
                return stream.read(65537)
        finally:
            os.close(fd)
    except OSError as exc:
        raise BindingProtocolError("LOCAL_TRUST_STATE_MISSING") from exc


def _new(directory: Path, name: str, value: bytes) -> None:
    try:
        fd = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError as exc:
        raise BindingProtocolError("LOCAL_TRUST_ALREADY_INITIALIZED") from exc


def _materials(directory: Path):
    bundle = evidence._parse(_read(directory, BUNDLE).rstrip(b"\n"))
    wire.validate_bundle(bundle)
    key = evidence._private_key(_read(directory, KEY))
    _need(wire.public_jwk(key) == bundle["boxKey"], "LOCAL_TRUST_KEY_MISMATCH")
    return bundle, key


def _open(directory: Path):
    # Validate inode/sidecars before SQLite; the directory is private to this
    # service uid and runtime never creates a missing database.
    _read(directory, SEAL)
    for name in (DATABASE, DATABASE + "-journal", DATABASE + "-wal", DATABASE + "-shm"):
        path = directory / name
        if name != DATABASE and not path.exists() and not path.is_symlink():
            continue
        try:
            info = path.lstat()
            _need(
                stat.S_ISREG(info.st_mode)
                and info.st_nlink == 1
                and info.st_uid == os.getuid()
                and stat.S_IMODE(info.st_mode) == 0o600,
                "LOCAL_TRUST_PATH_INVALID",
            )
        except OSError as exc:
            raise BindingProtocolError("LOCAL_TRUST_STATE_MISSING") from exc
    db = sqlite3.connect(
        (directory / DATABASE).as_uri() + "?mode=rw",
        uri=True,
        isolation_level=None,
        check_same_thread=False,
        timeout=5,
    )
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=DELETE")
    db.execute("PRAGMA synchronous=FULL")
    return db


def _json(value):
    return wire.canonical(value).decode("ascii")


def _time(now):
    evidence._integer(now)
    evidence._require(now <= evidence.SAFE_INTEGER - 300)


def _challenge_indexes(db):
    # Additive query indexes only, after identity/checkpoint validation on open.
    # They never initialize missing security tables or change authorization.
    db.execute("CREATE INDEX IF NOT EXISTS challenges_kind ON challenges(kind)")
    db.execute("CREATE INDEX IF NOT EXISTS challenges_expires ON challenges(expires_at)")
    db.execute(
        "CREATE INDEX IF NOT EXISTS challenges_client_nonce ON challenges(kind,json_extract(context,'$.clientNonceDigest'))"
    )


def initialize_authority(directory, *, now: int) -> None:
    """Offline create-only import of an OS-verified private provisioning bundle.

    This does not establish factory eligibility itself. The OS provisioner owns
    those checks and must finish this step before exposing the staging directory.
    The seal is written first, so interrupted initialization never becomes an
    implicit runtime retry or a new identity following accidental DB deletion.
    """
    _time(now)
    directory = _directory(directory)
    bundle, _ = _materials(directory)
    _need(
        not (directory / DATABASE).exists() and not (directory / SEAL).exists(),
        "LOCAL_TRUST_ALREADY_INITIALIZED",
    )
    _new(directory, SEAL, wire.canonical({"schemaVersion": 1, "bundleDigest": wire.digest(bundle)}))
    _new(directory, DATABASE, b"")
    db = _open(directory)
    try:
        db.executescript("""
            BEGIN IMMEDIATE;
            CREATE TABLE metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL);
            CREATE TABLE retired_boots (boot_id TEXT PRIMARY KEY);
            CREATE TABLE bindings (binding_id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
            CREATE TABLE keys (thumbprint TEXT PRIMARY KEY, binding_id TEXT NOT NULL, purpose TEXT NOT NULL);
            CREATE TABLE challenges (nonce TEXT PRIMARY KEY, kind TEXT NOT NULL, context TEXT NOT NULL,
                issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, boot_id TEXT NOT NULL, consumed TEXT);
            CREATE TABLE requests (request_id TEXT PRIMARY KEY, kind TEXT NOT NULL, digest TEXT NOT NULL,
                value TEXT NOT NULL, request_jws TEXT NOT NULL, state TEXT NOT NULL
                CHECK(state IN ('pending','approved','cancelled','expired')), expires_at INTEGER NOT NULL,
                ack TEXT, approval TEXT, approval_key TEXT, receipt TEXT);
            CREATE TABLE events (seq INTEGER PRIMARY KEY, previous_digest TEXT NOT NULL,
                value TEXT NOT NULL, digest TEXT NOT NULL UNIQUE, ack TEXT NOT NULL);
        """)
        metadata = {
            "bundleDigest": wire.digest(bundle),
            "boxId": bundle["boxId"],
            "boxKeyThumbprint": evidence.public_key_thumbprint(bundle["boxKey"]),
            "ownershipEpoch": bundle["ownershipEpoch"],
            "provisioningId": bundle["provisioningId"],
            "initialGrants": bundle["grants"],
            "claimSecretSha256": bundle["claimSecretSha256"],
            "rosterVersion": 0,
            "rosterDigest": wire.digest([]),
            "policyVersion": 1,
            "principalId": None,
            "recoveryConfigured": False,
            "lastSeenNow": now,
            "bootId": None,
            "eventDigest": wire.digest([]),
        }
        db.execute("INSERT INTO metadata VALUES (1, ?)", (_json(metadata),))
        _challenge_indexes(db)
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


class LocalTrustAuthority:
    """Synchronous authority; callers must use their bounded worker executor."""

    def __init__(self, directory, *, boot_id: str):
        evidence._token(boot_id)
        self.directory = _directory(directory)
        self.bundle, self._key = _materials(self.directory)
        seal = evidence._parse(_read(self.directory, SEAL))
        _need(seal == {"schemaVersion": 1, "bundleDigest": wire.digest(self.bundle)})
        self._boot_id = boot_id
        self._lock = threading.RLock()
        self._closed = False
        self._commit_callbacks = None
        self._commit_observer = None
        self._team_identity_policy = None
        self._db = _open(self.directory)
        self._ledger = None
        try:
            self._db.execute("BEGIN IMMEDIATE")
            _need(self._db.execute("PRAGMA integrity_check").fetchone()[0] == "ok")
            _need("receipt" in {row[1] for row in self._db.execute("PRAGMA table_info(requests)")})
            meta = self._meta()
            _need(meta["bundleDigest"] == wire.digest(self.bundle))
            schema = self._db.execute("PRAGMA user_version").fetchone()[0]
            _need(schema in (0, 2), "LOCAL_TRUST_SCHEMA_UNSUPPORTED")
            if schema == 0:
                floor = self.directory / "local-trust-required.json"
                _need(
                    not floor.exists() and not floor.is_symlink(), "LOCAL_TRUST_MIGRATION_REQUIRED"
                )
            if schema == 2:
                from .local_ledger_engine import LedgerV2

                self._ledger = LedgerV2(self)
                self._ledger.validate_startup(meta)
            _need(
                meta["boxId"] == self.bundle["boxId"]
                and meta["boxKeyThumbprint"]
                == evidence.public_key_thumbprint(self.bundle["boxKey"])
            )
            if self._ledger is None:
                _need(
                    meta["ownershipEpoch"] == self.bundle["ownershipEpoch"]
                    and meta["provisioningId"] == self.bundle["provisioningId"]
                    and meta["initialGrants"] == self.bundle["grants"]
                    and meta["recoveryConfigured"] is False
                )
                self._verify_checkpoint(meta)
            _challenge_indexes(self._db)
            if meta["bootId"] != boot_id:
                _need(
                    not self._db.execute(
                        "SELECT 1 FROM retired_boots WHERE boot_id=?", (boot_id,)
                    ).fetchone(),
                    "LOCAL_TRUST_BOOT_MISMATCH",
                )
                if meta["bootId"] is not None:
                    self._db.execute("INSERT INTO retired_boots VALUES (?)", (meta["bootId"],))
                self._db.execute(
                    "DELETE FROM challenges WHERE kind NOT LIKE 'read-v2-auth:%' AND kind NOT LIKE 'mutation-v2-auth:%'"
                )
                self._db.execute("UPDATE requests SET state='expired' WHERE state='pending'")
                if self._ledger is not None:
                    self._ledger.maintenance(meta["lastSeenNow"], restart=True)
                meta["bootId"] = boot_id
                self._save_meta(meta)
            self._db.commit()
        except BaseException:
            self._db.rollback()
            self._db.close()
            raise

    def _meta(self):
        row = self._db.execute("SELECT value FROM metadata WHERE singleton=1").fetchone()
        _need(row is not None)
        return json.loads(row["value"])

    def _save_meta(self, meta):
        self._db.execute("UPDATE metadata SET value=? WHERE singleton=1", (_json(meta),))

    def _bindings(self):
        return [
            json.loads(row[0])
            for row in self._db.execute("SELECT value FROM bindings ORDER BY binding_id")
        ]

    def _context(self, meta):
        return {key: meta[key] for key in evidence._BOX_FIELDS}

    def _state(self, meta):
        _need(meta["principalId"] is not None, "LOCAL_TRUST_NOT_OWNED")
        return {**self._context(meta), "bindings": self._bindings()}

    def _verify_checkpoint(self, meta):
        bindings = self._bindings()
        _need(wire.digest(bindings) == meta["rosterDigest"])
        expected_keys = {
            (evidence.public_key_thumbprint(binding[field]), binding["bindingId"], field)
            for binding in bindings
            for field in ("accessKey", "approvalKey")
            if binding[field] is not None
        }
        actual_keys = {
            tuple(row)
            for row in self._db.execute("SELECT thumbprint, binding_id, purpose FROM keys")
        }
        _need(expected_keys == actual_keys)
        _need(all(binding["principalId"] == meta["principalId"] for binding in bindings))
        previous = wire.digest([])
        events = self._db.execute("SELECT * FROM events ORDER BY seq").fetchall()
        _need(len(events) == meta["rosterVersion"])
        for seq, row in enumerate(events, 1):
            event = json.loads(row["value"])
            _need(
                row["seq"] == seq
                and row["previous_digest"] == previous
                and event["previousDigest"] == previous
                and wire.digest(event) == row["digest"]
            )
            ack = wire.verify_response(
                row["ack"], self.bundle["boxKey"], box_id=meta["boxId"], kind="binding-ack"
            )
            _need(
                ack["body"]["rosterVersion"] == seq
                and ack["body"]["rosterDigest"] == event["rosterDigest"]
            )
            previous = row["digest"]
        _need(previous == meta["eventDigest"])
        if events:
            _need(
                event["rosterDigest"] == meta["rosterDigest"] and meta["claimSecretSha256"] is None
            )
            evidence._roster({**self._context(meta), "bindings": bindings})
        else:
            _need(
                meta["principalId"] is None
                and not bindings
                and meta["claimSecretSha256"] == self.bundle["claimSecretSha256"]
            )

    @contextmanager
    def _transaction(self, now):
        _time(now)
        with self._lock:
            _need(not self._closed, "LOCAL_TRUST_CLOSED")
            self._db.execute("BEGIN IMMEDIATE")
            callbacks = []
            self._commit_callbacks = callbacks
            try:
                meta = self._meta()
                _need(meta["bootId"] == self._boot_id, "LOCAL_TRUST_BOOT_MISMATCH")
                _need(now >= meta["lastSeenNow"], "LOCAL_TRUST_CLOCK_ROLLBACK")
                meta["lastSeenNow"] = now
                self._save_meta(meta)
                self._db.execute(
                    "UPDATE requests SET state='expired' WHERE state='pending' AND expires_at<=?",
                    (now,),
                )
                self._db.execute(
                    "DELETE FROM requests WHERE state IN ('cancelled','expired') AND expires_at<=?",
                    (now - _TERMINAL_RETENTION,),
                )
                # Absence and already-consumed both deny replay. Immutable
                # operation evidence lives in requests/events, not this nonce
                # issuance table; consumed nonces must not exhaust live slots.
                self._db.execute("DELETE FROM challenges WHERE expires_at<=?", (now,))
                self._db.execute(
                    "DELETE FROM challenges WHERE kind IN ('root','use','read','read-v2','mutation-v2') AND consumed IS NOT NULL"
                )
                if self._ledger is not None:
                    self._ledger.maintenance(now)
                self._db.execute("SAVEPOINT operation")
                try:
                    yield meta
                except BindingProtocolError:
                    self._db.execute("ROLLBACK TO operation")
                    self._db.execute("RELEASE operation")
                    self._db.commit()
                    raise
                self._db.execute("RELEASE operation")
                self._db.commit()
                self._commit_callbacks = None
                for callback in callbacks:
                    callback()
            except BaseException:
                self._db.rollback()
                raise
            finally:
                self._commit_callbacks = None

    def _after_commit(self, callback):
        _need(self._commit_callbacks is not None and callable(callback))
        self._commit_callbacks.append(callback)

    def _signed(self, meta, kind, body, now):
        return wire.sign_response(meta["boxId"], self._key, kind, body, now)

    def _challenge(self, meta, kind, now, ttl=300):
        _need(
            self._db.execute("SELECT COUNT(*) FROM challenges WHERE kind=?", (kind,)).fetchone()[0]
            < 128,
            "LOCAL_TRUST_CAPACITY",
        )
        nonce = secrets.token_urlsafe(32)
        context = self._context(meta)
        self._db.execute(
            "INSERT INTO challenges VALUES (?, ?, ?, ?, ?, ?, NULL)",
            (nonce, kind, _json(context), now, now + ttl, self._boot_id),
        )
        return nonce

    def _consume_challenge(self, value, kind, now, request_id, meta, field="challenge"):
        challenge = self._db.execute(
            "SELECT * FROM challenges WHERE nonce=?", (value[field],)
        ).fetchone()
        authorized_kind = (
            kind + "-auth:" + wire.digest(value["actor"])
            if kind in ("read-v2", "mutation-v2") and "actor" in value
            else None
        )
        _need(
            challenge is not None
            and challenge["kind"] in (kind, authorized_kind)
            and challenge["boot_id"] == self._boot_id
            and challenge["consumed"] is None,
            "LOCAL_TRUST_CHALLENGE_INVALID",
        )
        _need(
            challenge["issued_at"]
            <= value["issuedAt"]
            <= now
            < value["expiresAt"]
            <= challenge["expires_at"],
            "LOCAL_BINDING_EXPIRED",
        )
        context = json.loads(challenge["context"])
        if challenge["kind"] == authorized_kind:
            evidence._fields(
                context,
                {"context", "clientNonceDigest", "proofDigest"}
                | ({"action"} if kind == "mutation-v2" else set()),
            )
            if kind == "mutation-v2":
                _need(context["action"] == value["action"], "LOCAL_TRUST_CHALLENGE_INVALID")
            context = context["context"]
        _need(context == self._context(meta), "LOCAL_BINDING_CONTEXT_MISMATCH")
        self._db.execute(
            "UPDATE challenges SET consumed=? WHERE nonce=?", (request_id, value[field])
        )

    def first_root_challenge(self, now: int) -> str:
        with self._transaction(now) as meta:
            _need(
                meta["principalId"] is None and meta["claimSecretSha256"] is not None,
                "LOCAL_TRUST_ALREADY_OWNED",
            )
            nonce = self._challenge(meta, "root", now)
            body = {
                "provisioningId": meta["provisioningId"],
                "ownershipEpoch": meta["ownershipEpoch"],
                "challenge": nonce,
                "issuedAt": now,
                "expiresAt": now + 300,
                "grants": meta["initialGrants"],
            }
            return self._signed(meta, "first-root-challenge", body, now)

    def _existing(self, request_id):
        return self._db.execute(
            "SELECT * FROM requests WHERE request_id=?", (request_id,)
        ).fetchone()

    def _saved_request(self, row):
        # Never commit or disclose an unsigned JSON mirror that differs from
        # the exact applicant proof kept by the same ledger transaction.
        value = evidence.verify_request_proof(row["request_jws"])
        _need(
            value == json.loads(row["value"])
            and evidence.request_digest(value) == row["digest"]
            and value["requestId"] == row["request_id"]
        )
        return value

    def _capacity(self):
        _need(
            self._db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] < _CAPACITY,
            "LOCAL_TRUST_CAPACITY",
        )

    def commit_first_root(
        self, access_proof: str, approval_proof: str, secret_proof: str, now: int
    ) -> str:
        with self._transaction(now) as meta:
            value = wire.verify_first_root_proofs(access_proof, approval_proof, secret_proof)
            digest = wire.first_root_digest(value)
            existing = self._existing(value["requestId"])
            if existing is not None:
                _need(
                    existing["kind"] == "root" and existing["digest"] == digest,
                    "LOCAL_TRUST_REQUEST_CONFLICT",
                )
                _need(existing["state"] == "approved" and existing["ack"] is not None)
                return existing["ack"]
            _need(
                meta["principalId"] is None and meta["claimSecretSha256"] is not None,
                "LOCAL_TRUST_ALREADY_OWNED",
            )
            wire.verify_first_root_proofs(
                access_proof,
                approval_proof,
                secret_proof,
                evidence._decode(meta["claimSecretSha256"], 32),
            )
            _need(
                all(
                    value[key] == meta[key]
                    for key in ("boxId", "boxKeyThumbprint", "ownershipEpoch", "provisioningId")
                )
                and value["grants"] == meta["initialGrants"],
                "LOCAL_BINDING_CONTEXT_MISMATCH",
            )
            self._consume_challenge(value, "root", now, value["requestId"], meta)
            self._capacity()
            meta["principalId"] = value["principalId"]
            meta["claimSecretSha256"] = None
            self._db.execute(
                "INSERT INTO requests VALUES (?, 'root', ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL)",
                (value["requestId"], digest, _json(value), access_proof, value["expiresAt"]),
            )
            return self._commit_binding(meta, value, digest, "manage", now)

    def _commit_binding(self, meta, request, digest, role, now, approval=None, approval_key=None):
        _need(meta["rosterVersion"] < evidence.SAFE_INTEGER, "LOCAL_TRUST_CAPACITY")
        version = meta["rosterVersion"] + 1
        binding_id = "binding:" + secrets.token_hex(16)
        binding = {
            "bindingId": binding_id,
            "principalId": request["principalId"],
            "clientId": request["clientId"],
            "role": role,
            "status": "active",
            "accessKey": request["accessKey"],
            "approvalKey": request["approvalKey"] if role == "manage" else None,
            "approvalKeyVersion": 1 if role == "manage" else None,
            "canApproveUseDevices": role == "manage",
            "delegableGrants": request["grants"] if role == "manage" else [],
            "expiresAt": request["grantExpiresAt"],
            "delegationExpiresAt": None,
            "establishedAt": now,
            "establishedVersion": version,
        }
        self._assert_unused(request)
        self._db.execute(
            "INSERT INTO bindings VALUES (?, ?, ?)",
            (binding_id, request["clientId"], _json(binding)),
        )
        for purpose in ("accessKey", "approvalKey"):
            if binding[purpose] is not None:
                self._db.execute(
                    "INSERT INTO keys VALUES (?, ?, ?)",
                    (evidence.public_key_thumbprint(binding[purpose]), binding_id, purpose),
                )
        meta["rosterVersion"] = version
        meta["rosterDigest"] = wire.digest(self._bindings())
        # Refuse a commit that would make the strictly bounded state response
        # unreadable; do not discover oversized rosters after granting authority.
        self._signed(
            meta,
            "state",
            {
                "context": self._context(meta),
                "bindings": self._bindings(),
                "recoveryConfigured": False,
            },
            now,
        )
        body = {
            "requestId": request["requestId"],
            "requestDigest": digest,
            "bindingId": binding_id,
            "principalId": request["principalId"],
            "clientId": request["clientId"],
            "role": role,
            "accessKeyThumbprint": evidence.public_key_thumbprint(request["accessKey"]),
            "ownershipEpoch": meta["ownershipEpoch"],
            "rosterVersion": version,
            "rosterDigest": meta["rosterDigest"],
            "policyVersion": meta["policyVersion"],
            "committedAt": now,
            "recoveryConfigured": False,
        }
        ack = self._signed(meta, "binding-ack", body, now)
        event = {
            "schemaVersion": 1,
            "purpose": "centuarai.local-management.binding-commit",
            "sequence": version,
            "previousDigest": meta["eventDigest"],
            "requestId": request["requestId"],
            "requestDigest": digest,
            "binding": binding,
            "grants": request["grants"],
            "rosterDigest": meta["rosterDigest"],
            "committedAt": now,
        }
        event_digest = wire.digest(event)
        self._db.execute(
            "INSERT INTO events VALUES (?, ?, ?, ?, ?)",
            (version, meta["eventDigest"], _json(event), event_digest, ack),
        )
        meta["eventDigest"] = event_digest
        self._save_meta(meta)
        self._db.execute(
            "UPDATE requests SET state='approved', ack=?, approval=?, approval_key=? WHERE request_id=?",
            (
                ack,
                _json(approval) if approval else None,
                _json(approval_key) if approval_key else None,
                request["requestId"],
            ),
        )
        self._observe_commit()
        return ack

    def _assert_unused(self, request):
        _need(
            not self._db.execute(
                "SELECT 1 FROM bindings WHERE client_id=?", (request["clientId"],)
            ).fetchone(),
            "LOCAL_BINDING_CLIENT_REUSE",
        )
        for field in ("accessKey", "approvalKey"):
            if request[field] is not None:
                thumb = evidence.public_key_thumbprint(request[field])
                _need(
                    not self._db.execute(
                        "SELECT 1 FROM keys WHERE thumbprint=?", (thumb,)
                    ).fetchone(),
                    "LOCAL_BINDING_KEY_REUSE",
                )

    def auth_challenge(self, now: int) -> str:
        with self._transaction(now) as meta:
            _need(meta["principalId"] is not None, "LOCAL_TRUST_NOT_OWNED")
            nonce = self._challenge(meta, "read", now, 60)
            return self._signed(
                meta,
                "auth-challenge",
                {
                    "nonce": nonce,
                    "issuedAt": now,
                    "expiresAt": now + 60,
                    "ownershipEpoch": meta["ownershipEpoch"],
                },
                now,
            )

    def _manager(self, meta, client_id, now):
        row = self._db.execute(
            "SELECT value FROM bindings WHERE client_id=?", (client_id,)
        ).fetchone()
        if row is None:
            return None
        binding = json.loads(row[0])
        if (
            binding["principalId"] != meta["principalId"]
            or binding["role"] != "manage"
            or binding["status"] != "active"
            or binding["expiresAt"] is not None
            and now >= binding["expiresAt"]
        ):
            return None
        return binding

    def _read_authenticated(self, proof, operation, meta, now):
        locator = wire.decode_read_proof(proof)
        _need(locator["operation"] == operation, "LOCAL_TRUST_READ_DENIED")
        manager = self._manager(meta, locator["clientId"], now)
        row = self._existing(locator["requestId"]) if operation == "request" else None
        if row is not None and row["kind"] != "use":
            row = None  # Root receipt recovery uses the dual-proof exact commit retry.
        saved = self._saved_request(row) if row is not None else None
        allowed_manager = manager is not None and (
            operation == "state"
            or saved is not None
            and saved["principalId"] == manager["principalId"]
        )
        own_request = saved is not None and saved["clientId"] == locator["clientId"]
        _need(allowed_manager or own_request, "LOCAL_TRUST_READ_DENIED")
        key = manager["accessKey"] if allowed_manager else saved["accessKey"]
        try:
            wire.verify_read_proof(proof, key)
            _need(
                all(
                    locator[field] == meta[field]
                    for field in ("boxId", "boxKeyThumbprint", "ownershipEpoch")
                ),
                "LOCAL_TRUST_READ_DENIED",
            )
            self._consume_challenge(
                locator, "read", now, "read:" + secrets.token_hex(16), meta, "nonce"
            )
        except BindingProtocolError as exc:
            raise BindingProtocolError("LOCAL_TRUST_READ_DENIED") from exc
        return row

    def read_state(self, proof: str, now: int) -> str:
        with self._transaction(now) as meta:
            self._read_authenticated(proof, "state", meta, now)
            return self._signed(
                meta,
                "state",
                {
                    "context": self._context(meta),
                    "bindings": self._bindings(),
                    "recoveryConfigured": False,
                },
                now,
            )

    def read_request(self, proof: str, now: int) -> str:
        with self._transaction(now) as meta:
            row = self._read_authenticated(proof, "request", meta, now)
            return self._signed(
                meta,
                "request",
                {
                    "requestId": row["request_id"],
                    "requestDigest": row["digest"],
                    "state": row["state"],
                    "requestJws": row["request_jws"],
                    "ack": row["ack"],
                },
                now,
            )

    def request_challenge(self, now: int) -> str:
        with self._transaction(now) as meta:
            self._state(meta)
            nonce = self._challenge(meta, "use", now)
            return self._signed(
                meta,
                "binding-challenge",
                {
                    "context": self._context(meta),
                    "challenge": nonce,
                    "issuedAt": now,
                    "expiresAt": now + 300,
                },
                now,
            )

    def _receipt(self, meta, row, now):
        return self._signed(
            meta,
            "request-receipt",
            {
                "requestId": row["request_id"],
                "requestDigest": row["digest"],
                "state": row["state"],
                "expiresAt": row["expires_at"],
            },
            now,
        )

    def submit_request(self, request_proof: str, now: int) -> str:
        with self._transaction(now) as meta:
            value = evidence.verify_request_proof(request_proof)
            digest = evidence.request_digest(value)
            existing = self._existing(value["requestId"])
            if existing is not None:
                _need(
                    existing["kind"] == "use" and existing["digest"] == digest,
                    "LOCAL_TRUST_REQUEST_CONFLICT",
                )
                self._saved_request(existing)
                # An old proposal is not a fresh read credential. Return only
                # the immutable original receipt; current state requires nonce
                # authentication through read_request.
                _need(existing["receipt"] is not None)
                return existing["receipt"]
            state = self._state(meta)
            _need(value["principalId"] == meta["principalId"], "LOCAL_TRUST_REQUEST_DENIED")
            evidence.validate_request_context(
                value, {**self._context(meta), "challenge": value["challenge"]}, now
            )
            self._assert_unused(value)
            self._consume_challenge(value, "use", now, value["requestId"], meta)
            self._capacity()
            _need(
                self._db.execute("SELECT COUNT(*) FROM requests WHERE state='pending'").fetchone()[
                    0
                ]
                < 128,
                "LOCAL_TRUST_CAPACITY",
            )
            # Requesting does not grant authority; scope is checked again against
            # the actual current approver inside approve_request's transaction.
            evidence._roster(state)
            self._db.execute(
                "INSERT INTO requests VALUES (?, 'use', ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL)",
                (value["requestId"], digest, _json(value), request_proof, value["expiresAt"]),
            )
            receipt = self._receipt(meta, self._existing(value["requestId"]), now)
            self._db.execute(
                "UPDATE requests SET receipt=? WHERE request_id=?", (receipt, value["requestId"])
            )
            return receipt

    def approve_request(self, request_id: str, approval_proof: str, now: int) -> str:
        with self._transaction(now) as meta:
            evidence._digest(request_id)
            row = self._existing(request_id)
            _need(row is not None and row["kind"] == "use", "LOCAL_TRUST_REQUEST_DENIED")
            request = self._saved_request(row)
            if row["state"] == "approved":
                wire.verify_saved_approval(
                    approval_proof, json.loads(row["approval"]), json.loads(row["approval_key"])
                )
                return row["ack"]
            _need(row["state"] == "pending", "LOCAL_TRUST_REQUEST_TERMINAL")
            state = self._state(meta)
            approval = evidence.verify_approval_signature(
                approval_proof, row["request_jws"], state, now
            )
            approver = next(
                binding
                for binding in state["bindings"]
                if binding["bindingId"] == approval["approverBindingId"]
            )
            return self._commit_binding(
                meta, request, row["digest"], "use", now, approval, approver["approvalKey"]
            )

    def cancel_request(self, cancel_proof: str, now: int) -> str:
        with self._transaction(now) as meta:
            locator = evidence.decode_cancel_payload(cancel_proof)
            row = self._existing(locator["requestId"])
            _need(row is not None and row["kind"] == "use", "LOCAL_TRUST_REQUEST_DENIED")
            evidence.verify_cancel_proof(cancel_proof, self._saved_request(row), now)
            self._db.execute(
                "UPDATE requests SET state='cancelled' WHERE request_id=? AND state='pending'",
                (locator["requestId"],),
            )
            return self._receipt(meta, self._existing(locator["requestId"]), now)

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._db.close()
                self._closed = True

    def get_authorization(self, binding_id: str, now: int) -> dict:
        """Read current actual grants for the in-process data runtime only.

        This does not create a session or accept a caller's identity projection.
        The management-v1 case derives actual grants from its retained signed
        admission request; v2 replaces this branch with its explicit grant graph.
        """
        with self._transaction(now) as meta:
            evidence._token(binding_id)
            row = self._db.execute(
                "SELECT value FROM bindings WHERE binding_id=?", (binding_id,)
            ).fetchone()
            _need(row is not None and meta["principalId"] is not None, "LOCAL_TRUST_ACCESS_DENIED")
            binding = json.loads(row[0])
            _need(
                binding["status"] == "active" and binding["principalId"] == meta["principalId"],
                "LOCAL_TRUST_ACCESS_DENIED",
            )
            deadlines = [binding["expiresAt"]]
            source = None
            for request in self._db.execute("SELECT * FROM requests WHERE state='approved'"):
                payload = json.loads(request["value"])
                if payload["clientId"] == binding["clientId"]:
                    source = request
                    break
            _need(source is not None, "LOCAL_TRUST_ACCESS_DENIED")
            if source["kind"] == "use":
                payload = self._saved_request(source)
                approval = json.loads(source["approval"])
                parent_row = self._db.execute(
                    "SELECT value FROM bindings WHERE binding_id=?",
                    (approval["approverBindingId"],),
                ).fetchone()
                _need(parent_row is not None, "LOCAL_TRUST_ACCESS_DENIED")
                parent = json.loads(parent_row[0])
                _need(
                    parent["status"] == "active"
                    and parent["role"] == "manage"
                    and parent["principalId"] == binding["principalId"],
                    "LOCAL_TRUST_ACCESS_DENIED",
                )
                deadlines.extend((parent["expiresAt"], parent["delegationExpiresAt"]))
            else:
                payload = wire._decode(
                    source["request_jws"], wire.ROOT_ACCESS, wire.validate_first_root
                )
                evidence._verify(source["request_jws"], evidence._public_key(payload["accessKey"]))
                _need(
                    payload == json.loads(source["value"])
                    and wire.first_root_digest(payload) == source["digest"],
                    "LOCAL_TRUST_STATE_INVALID",
                )
            _need(
                payload["ownershipEpoch"] == meta["ownershipEpoch"]
                and payload["principalId"] == binding["principalId"]
                and payload["clientId"] == binding["clientId"]
                and payload["accessKey"] == binding["accessKey"],
                "LOCAL_TRUST_ACCESS_DENIED",
            )
            validate_resource_grants(payload["grants"])
            deadlines.append(payload["grantExpiresAt"])
            finite = [deadline for deadline in deadlines if deadline is not None]
            expiry = min(finite) if finite else None
            _need(expiry is None or now < expiry, "LOCAL_TRUST_ACCESS_DENIED")
            return {
                **self._context(meta),
                "authorizationVersion": meta["rosterVersion"],
                "bindingId": binding_id,
                "bindingRevision": 1,
                "principalId": binding["principalId"],
                "principalSecurityVersion": 1,
                "clientId": binding["clientId"],
                "accessKey": payload["accessKey"],
                "status": "active",
                "principalStatus": "active",
                "ownershipState": "owned",
                "grants": payload["grants"],
                "expiresAt": expiry,
            }

    def _v2(self):
        _need(self._ledger is not None, "LOCAL_TRUST_CLIENT_UPGRADE_REQUIRED")
        return self._ledger

    def mutation_challenge(self, actor, action, now):
        return self._v2().mutation_challenge(actor, action, now)

    def prepare_mutation(self, prepare_proof, now):
        return self._v2().prepare_mutation(prepare_proof, now)

    def commit_mutation(
        self,
        mutation_proof,
        target_access_proof,
        target_approval_proof,
        recovery_material_proof,
        source_recovery_proof,
        now,
    ):
        return self._v2().commit_mutation(
            mutation_proof,
            target_access_proof,
            target_approval_proof,
            recovery_material_proof,
            source_recovery_proof,
            now,
        )

    def auth_challenge_v2(self, now):
        return self._v2().auth_challenge_v2(now)

    def authenticated_challenge_v2(self, proof, now):
        return self._v2().authenticated_challenge_v2(proof, now)

    def authenticated_mutation_challenge_v2(self, proof, now):
        return self._v2().authenticated_mutation_challenge_v2(proof, now)

    def read_v2(self, proof, now):
        return self._v2().read_v2(proof, now)

    def configure_team_identity(self, policy):
        from .local_team_protocol import validate_policy

        if policy is not None:
            validate_policy(policy)
        with self._lock:
            _need(not self._closed, "LOCAL_TRUST_CLOSED")
            meta = self._meta()
            _need(
                "team" not in meta or meta["team"]["cloudPolicy"] == policy,
                "LOCAL_TRUST_IDENTITY_POLICY_REQUIRED",
            )
            self._team_identity_policy = (
                json.loads(wire.canonical(policy)) if policy is not None else None
            )

    def team_policy(self, now):
        from .local_team_service import TeamService

        return TeamService(self).policy(now)

    def submit_team_request(self, request_proof, approval_proof, cloud_proof, now):
        from .local_team_service import TeamService

        return TeamService(self).submit(request_proof, approval_proof, cloud_proof, now)

    def read_team_request(self, proof, now):
        from .local_team_service import TeamService

        return TeamService(self).read_request(proof, now)

    def consent_team_request(self, request_id, target_access_proof, target_approval_proof, now):
        from .local_team_service import TeamService

        return TeamService(self).consent(
            request_id, target_access_proof, target_approval_proof, now
        )

    def get_team_authorization(self, binding_id, now):
        from .local_ledger_engine import binding, binding_valid
        from .local_team_ledger import team_authorization

        with self._transaction(now) as meta:
            snapshot = self._v2().snapshot(meta)
            row = binding(snapshot, binding_id)
            _need(binding_valid(snapshot, row, now), "LOCAL_TRUST_ACCESS_DENIED")
            return team_authorization(snapshot, row, now)

    def get_team_members(self, binding_id, now):
        from .local_ledger_engine import binding, live, principal
        from .local_team_ledger import team_authorization

        with self._transaction(now) as meta:
            snapshot = self._v2().snapshot(meta)
            row = binding(snapshot, binding_id)
            _need(row is not None, "LOCAL_TRUST_ACCESS_DENIED")
            auth = team_authorization(snapshot, row, now)
            _need(
                auth is not None
                and bool(set(auth["permissions"]) & {"members.read", "applications.manage"}),
                "LOCAL_TRUST_ACCESS_DENIED",
            )
            return [
                {key: member[key] for key in ("membershipId", "principalId", "status", "revision")}
                for member in snapshot["team"]["members"]
                if member["status"] == "active"
                and live(member["expiresAt"], now)
                and principal(snapshot, member["principalId"])["status"] == "active"
            ]

    def consume_team_migration(self, request_id, plan_digest, now):
        from .local_team_migration import consume

        return consume(self, request_id, plan_digest, now)

    def install_effect_provider(self, provider, *, generation):
        evidence._digest(generation)
        _need(provider is None or callable(provider), "LOCAL_BINDING_INVALID")
        with self._lock:
            self._v2().effect_provider = provider
            self._v2().effect_generation = generation

    def get_effect_commit(self, request_id):
        return self._v2().get_effect_commit(request_id)

    def get_effect_evidence(self, request_id):
        """Private bounded cache read for the trusted OS erasure barrier."""
        with self._lock:
            ledger = self._v2()
            committed = ledger.get_effect_commit(request_id)
            expected = {
                name: committed[name]
                for name in (
                    "operationId",
                    "targetScope",
                    "authorizationVersion",
                    "committedAtMs",
                    "deadlineMs",
                )
            }
            observed = (
                ledger.effect_provider(request_id, json.loads(_json(expected)))
                if ledger.effect_provider
                else None
            )
            if observed is None:
                return None
            from .local_data_protocol import validate_response

            _need(
                type(observed) is dict
                and all(observed.get(name) == value for name, value in expected.items()),
                "LOCAL_TRUST_STATE_INVALID",
            )
            meta = self._meta()
            validate_response(
                {
                    "schemaVersion": 1,
                    "purpose": "centuarai.local-data.response",
                    "boxId": meta["boxId"],
                    "boxKeyThumbprint": meta["boxKeyThumbprint"],
                    "kind": "effect",
                    "issuedAtMs": observed.get("observedAtMs"),
                    "body": observed,
                }
            )
            _need(
                observed["gateway"]["generation"] == ledger.effect_generation,
                "LOCAL_TRUST_STATE_INVALID",
            )
            return json.loads(_json(observed))

    def install_commit_observer(self, callback):
        _need(callback is None or callable(callback), "LOCAL_BINDING_INVALID")
        with self._lock:
            self._commit_observer = callback

    def _observe_commit(self, request_id=None):
        callback = self._commit_observer
        if callback is not None:

            def publish():
                callback(self.get_effect_commit(request_id) if request_id is not None else None)

            self._after_commit(publish)

    def configure_operation_provider(self, provider):
        _need(
            provider is not None
            and all(
                callable(getattr(provider, name, None))
                for name in ("prepare", "validate_phase", "validate_source")
            ),
            "LOCAL_BINDING_INVALID",
        )
        with self._lock:
            self._v2().operations.provider = provider

    def claim_operation(self, operation_id, expected_attempt, expected_state_version, now):
        return self._v2().operations.claim(
            operation_id, expected_attempt, expected_state_version, now
        )

    def operation_transition(
        self, permit, evidence_value, expected_attempt, expected_state_version, now
    ):
        return self._v2().operations.transition(
            permit, evidence_value, expected_attempt, expected_state_version, now
        )

    def sign_backup_source(
        self, permit, header, source_payload, expected_attempt, expected_state_version, now
    ):
        return self._v2().operations.sign_source(
            permit, header, source_payload, expected_attempt, expected_state_version, now
        )

    def list_runnable_operations(self, limit, now):
        return self._v2().operations.list_runnable(limit, now)

    def operation_reservation_state(self, request_id):
        return self._v2().operations.reservation_state(request_id)

    def check_operation_current(self, permit, expected_attempt, expected_state_version, now):
        with self.operation_publication_guard(
            permit, expected_attempt, expected_state_version, now
        ) as checked:
            return checked

    @contextmanager
    def operation_publication_guard(self, permit, expected_attempt, expected_state_version, now):
        """Serialize only a small final publish/COMMIT with authority mutations.

        The caller must finish copying, hashing, SQL preparation and constraint
        checks beforehand. The SQLite write reservation also fences another
        authority connection; this is not merely a process-local mutex.
        """
        evidence._integer(expected_attempt)
        evidence._integer(expected_state_version)
        with self._transaction(now) as meta:
            job, mutation = self._v2().operations._authorized_permit(
                permit, expected_attempt, expected_state_version, meta, now
            )
            _need(job["status"]["state"] == "running", "LOCAL_TRUST_OPERATION_TERMINAL")
            yield json.loads(
                _json({"status": job["status"], "mutation": mutation, "plan": job["plan"]})
            )

    def receive_restore_key(self, operation_id, archive_sha256, data_key, proof, now):
        return self._v2().operations.receive_restore_key(
            operation_id, archive_sha256, data_key, proof, now
        )

    def report_interrupted_operation(
        self, operation_id, evidence_value, expected_attempt, expected_state_version, now
    ):
        return self._v2().operations.report_interrupted(
            operation_id, evidence_value, expected_attempt, expected_state_version, now
        )

    def backup_io(self, operation, body, proof, now):
        from .local_backup_io import backup_io

        return backup_io(self._v2(), operation, body, proof, now)

    def backup_io_preflight(self, operation, body, proof, now):
        from .local_backup_io import backup_io

        return backup_io(self._v2(), operation, body, proof, now, preflight=True)

    def run_backup_io_preflight(self, operation, body, checked):
        """Private bounded-executor I/O phase; caller releases runtime execution lock."""
        from .local_backup_io import request_body

        _need(operation in ("source.finalize", "transfer.plan"), "LOCAL_BINDING_INVALID")
        request_body(operation, body)
        evidence._fields(checked, {"authorization", "checkedAt"})
        provider = self._v2().operations.provider
        _need(
            provider is not None and callable(getattr(provider, "preflight_backup_io", None)),
            "LOCAL_TRUST_OPERATION_UNAVAILABLE",
        )
        provider.preflight_backup_io(
            operation,
            json.loads(_json(body)),
            json.loads(_json(checked["authorization"])),
            checked["checkedAt"],
        )

    def configure_transfer_provider(self, provider):
        _need(
            provider is not None
            and all(
                callable(getattr(provider, name, None))
                for name in ("prepare", "verify_started", "verify_completed")
            ),
            "LOCAL_BINDING_INVALID",
        )
        with self._lock:
            self._v2().transfer.provider = provider

    def mark_erase_started(self, transfer_id, verified_reset_plan, now):
        return self._v2().transfer.mark_started(transfer_id, verified_reset_plan, now)

    def transfer_worker_permit(self, transfer_id, now):
        return self._v2().transfer.worker_permit(transfer_id, now)

    def complete_verified_redelivery(
        self, transfer_id, verified_erase_evidence, prepared_delivery, now
    ):
        return self._v2().transfer.complete(
            transfer_id, verified_erase_evidence, prepared_delivery, now
        )


def _versioned(name):
    """Keep the v1 implementation explicit while selecting the same v2 writer."""
    original = getattr(LocalTrustAuthority, name)

    def selected(self, *args, **kwargs):
        if self._ledger is not None:
            method = getattr(self._ledger, name, None)
            _need(method is not None, "LOCAL_TRUST_CLIENT_UPGRADE_REQUIRED")
            return method(*args, **kwargs)
        return original(self, *args, **kwargs)

    selected.__name__ = name
    setattr(LocalTrustAuthority, name, selected)


for _operation in (
    "first_root_challenge",
    "commit_first_root",
    "auth_challenge",
    "read_state",
    "read_request",
    "request_challenge",
    "submit_request",
    "approve_request",
    "cancel_request",
    "get_authorization",
):
    _versioned(_operation)


def migrate_authority_v2(directory, *, now):
    from .local_ledger_migration import migrate_authority_v2 as migrate

    return migrate(directory, now=now)
