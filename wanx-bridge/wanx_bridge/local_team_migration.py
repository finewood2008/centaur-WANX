"""Read-only migration permits and root-only, single-authority consumption."""

from __future__ import annotations

import http.client
import json
import os
import socket
import stat
from pathlib import Path

from . import local_ledger_protocol as protocol
from . import local_management_protocol as wire
from . import local_trust_protocol as evidence
from .local_trust_config import strict_object

JOURNAL_ROOT = Path("/var/lib/centauros/local-trust-migration")
BROKER_SOCKET = "/run/centuarai-local-trust/native-gate.sock"
JOURNAL_FIELDS = {
    "schemaVersion",
    "boxId",
    "ownershipEpoch",
    "principalId",
    "targetNamespace",
    "planDigest",
    "requestId",
    "phase",
    "published",
    "staged",
}


def need(value):
    evidence._require(value, "LOCAL_TRUST_MIGRATION_DENIED")


def verify_team_migration_permit_readonly(db, bundle, request_id, plan_digest, now):
    """Caller holds the business stop-write guard and a coherent DB read transaction."""
    return _verify_permit(db, bundle, request_id, plan_digest, now, completion_only=False)


def _verify_permit(db, bundle, request_id, plan_digest, now, *, completion_only):
    from .local_ledger_engine import binding, binding_valid, read_snapshot, verify_proofs
    from .local_team_ledger import member_for

    evidence._digest(request_id)
    evidence._digest(plan_digest)
    evidence._integer(now)
    need(db.execute("PRAGMA user_version").fetchone()[0] == 2)
    meta = json.loads(db.execute("SELECT value FROM metadata WHERE singleton=1").fetchone()[0])
    row = db.execute(
        "SELECT state,value FROM mutation_requests WHERE request_id=?", (request_id,)
    ).fetchone()
    need(row is not None and row[0] == "committed")
    saved = json.loads(row[1])
    mutation = saved["mutation"]
    need(mutation["action"] == "team.migration-authorize")
    args = mutation["args"]
    need(
        args["planDigest"] == plan_digest
        and request_id not in meta.get("teamMigrationReceipts", {})
    )
    ack = protocol.verify_response(
        saved["ack"], bundle["boxKey"], box_id=bundle["boxId"], kind="mutation-ack"
    )["body"]
    need(
        ack["requestId"] == request_id
        and ack["action"] == mutation["action"]
        and ack["mutationDigest"] == wire.digest(mutation)
    )
    need(
        all(
            meta[field] == ack[field]
            for field in (
                "ownershipEpoch",
                "rosterVersion",
                "rosterDigest",
                "authorizationVersion",
                "eventDigest",
            )
        )
    )
    need(
        meta["boxId"] == bundle["boxId"]
        and meta["boxKeyThumbprint"] == evidence.public_key_thumbprint(bundle["boxKey"])
    )
    need(meta["lastSeenNow"] <= now and mutation["issuedAt"] <= now)
    need(completion_only or now < args["expiresAt"])
    snapshot = read_snapshot(db, meta)
    need(wire.digest(snapshot) == meta["rosterDigest"])
    member = member_for(snapshot, args["principalId"])
    target = binding(snapshot, args["targetBindingId"])
    need(
        member is not None
        and member["status"] == "active"
        and member["membershipId"] == args["membershipId"]
    )
    need(
        target is not None
        and target["principalId"] == member["principalId"]
        and binding_valid(snapshot, target, now, delegation=True)
    )
    verify_proofs(snapshot, mutation, saved["proofs"], now)
    permit = {
        "schemaVersion": 1,
        "boxId": meta["boxId"],
        "boxKeyThumbprint": meta["boxKeyThumbprint"],
        "ownershipEpoch": meta["ownershipEpoch"],
        "requestId": request_id,
        **args,
        "membershipRevision": member["revision"],
        "authorizationVersion": meta["authorizationVersion"],
    }
    return permit


def _journal(plan_digest, *, root=Path("/"), owner_uid=0):
    evidence._digest(plan_digest)
    directory = root / str(JOURNAL_ROOT).lstrip("/") / plan_digest
    parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for name in directory.parts[1:]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
            info = os.fstat(parent)
            need(info.st_uid in (0, owner_uid) and not info.st_mode & 0o022)
        info = os.fstat(parent)
        need(info.st_uid == owner_uid and stat.S_IMODE(info.st_mode) == 0o700)
        descriptor = os.open(
            "journal.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent
        )
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            need(
                stat.S_ISREG(info.st_mode)
                and info.st_uid == owner_uid
                and stat.S_IMODE(info.st_mode) == 0o600
                and info.st_nlink == 1
                and info.st_size <= 65536
            )
            raw = stream.read(65537)
            need(len(raw) <= 65536)
        value = strict_object(raw)
        evidence._fields(value, JOURNAL_FIELDS)
        need(
            value["schemaVersion"] == 1
            and value["phase"] == "complete"
            and value["planDigest"] == plan_digest
        )
        need(type(value["published"]) is list and type(value["staged"]) is dict)
        return value
    except (OSError, ValueError, UnicodeError):
        need(False)
    finally:
        os.close(parent)


def consume(owner, request_id, plan_digest, now):
    evidence._digest(request_id)
    evidence._digest(plan_digest)
    with owner._transaction(now) as meta:
        existing = meta.get("teamMigrationReceipts", {}).get(request_id)
        if existing is not None:
            receipt = protocol.verify_response(
                existing,
                owner.bundle["boxKey"],
                box_id=owner.bundle["boxId"],
                kind="migration-consumed",
            )["body"]
            need(receipt["planDigest"] == plan_digest and receipt["requestId"] == request_id)
            return existing
        # An already published root journal can be acknowledged after permit TTL;
        # this never authorizes new publication. All current ledger identities,
        # keys and the exact unchanged checkpoint must still verify.
        journal = _journal(plan_digest)
        permit = _verify_permit(
            owner._db, owner.bundle, request_id, plan_digest, now, completion_only=True
        )
        need(
            all(
                journal[field] == permit[field]
                for field in (
                    "boxId",
                    "ownershipEpoch",
                    "principalId",
                    "targetNamespace",
                    "planDigest",
                    "requestId",
                )
            )
        )
        body = {
            "requestId": request_id,
            "planDigest": plan_digest,
            "principalId": permit["principalId"],
            "membershipId": permit["membershipId"],
            "ownershipEpoch": permit["ownershipEpoch"],
            "consumedAt": now,
        }
        receipt = protocol.sign_response(owner, "migration-consumed", body, now)
        meta.setdefault("teamMigrationReceipts", {})[request_id] = receipt
        owner._save_meta(meta)
        return receipt


def consume_over_broker(request_id, plan_digest, bundle, *, root=Path("/")):
    """Fixed local root IPC only; no server, path or bearer supplied by callers."""
    evidence._digest(request_id)
    evidence._digest(plan_digest)
    need(os.geteuid() == 0)

    class UnixHTTP(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(self.timeout)
            self.sock.connect(str(Path(root) / BROKER_SOCKET.lstrip("/")))

    connection = UnixHTTP("localhost", timeout=5)
    try:
        raw = wire.canonical({"requestId": request_id, "planDigest": plan_digest})
        connection.request(
            "POST",
            "/v1/team-migration/consume",
            body=raw,
            headers={"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        need(
            response.status == 200
            and response.getheader("Content-Type", "").split(";", 1)[0] == "application/jose"
        )
        receipt = response.read(16385)
        need(len(receipt) <= 16384)
        value = protocol.verify_response(
            receipt.decode("ascii"),
            bundle["boxKey"],
            box_id=bundle["boxId"],
            kind="migration-consumed",
        )["body"]
        need(value["requestId"] == request_id and value["planDigest"] == plan_digest)
        return {"receipt": receipt.decode("ascii"), **value}
    finally:
        connection.close()
