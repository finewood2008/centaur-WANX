"""Explicit, offline v1 admission-history verification and atomic v2 migration."""

from __future__ import annotations

import json
import secrets
from types import SimpleNamespace

from . import local_ledger_protocol as protocol
from . import local_management_protocol as wire
from . import local_trust_protocol as evidence
from .local_resource_catalog import resolve_resource, validate_resource_grants

V2_TABLES = (
    "CREATE TABLE ledger_origin (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL)",
    "CREATE TABLE principals (principal_id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE bindings_v2 (binding_id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE resource_grants (grant_id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE recovery_configurations (recovery_id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE signing_key_history (thumbprint TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE ledger_events (seq INTEGER PRIMARY KEY, digest TEXT NOT NULL UNIQUE, value TEXT NOT NULL, ack TEXT NOT NULL, checkpoint TEXT NOT NULL)",
    "CREATE TABLE mutation_requests (request_id TEXT PRIMARY KEY, state TEXT NOT NULL, value TEXT NOT NULL)",
    "CREATE TABLE local_operations (operation_id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE operation_events (operation_id TEXT NOT NULL, sequence INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(operation_id,sequence))",
)


def _need(condition):
    evidence._require(condition, "LOCAL_TRUST_MIGRATION_EVIDENCE_INVALID")


def _decoded(raw):
    return evidence._parse(raw.encode("ascii"))


def capture_v1(db):
    required = {
        "metadata",
        "retired_boots",
        "bindings",
        "keys",
        "challenges",
        "requests",
        "events",
    }
    actual = {
        row[0]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    }
    _need(actual == required)
    expected_columns = {
        "metadata": ("singleton", "value"),
        "retired_boots": ("boot_id",),
        "bindings": ("binding_id", "client_id", "value"),
        "keys": ("thumbprint", "binding_id", "purpose"),
        "challenges": (
            "nonce",
            "kind",
            "context",
            "issued_at",
            "expires_at",
            "boot_id",
            "consumed",
        ),
        "requests": (
            "request_id",
            "kind",
            "digest",
            "value",
            "request_jws",
            "state",
            "expires_at",
            "ack",
            "approval",
            "approval_key",
            "receipt",
        ),
        "events": ("seq", "previous_digest", "value", "digest", "ack"),
    }
    for table, columns in expected_columns.items():
        info = db.execute("PRAGMA table_info(" + table + ")").fetchall()
        _need(
            tuple(row[1] for row in info) == columns
            and info[0][5] == 1
            and all(row[5] == 0 for row in info[1:])
        )
    _need(not db.execute("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger')").fetchone())
    _need(
        {row[1] for row in db.execute("PRAGMA table_info(requests)")}
        == {
            "request_id",
            "kind",
            "digest",
            "value",
            "request_jws",
            "state",
            "expires_at",
            "ack",
            "approval",
            "approval_key",
            "receipt",
        }
    )
    return {
        name: [dict(row) for row in db.execute("SELECT * FROM " + name + " ORDER BY 1")]
        for name in sorted(required)
    }


def verify_v1(archive, bundle):
    """No invented manager signature: v1 discarded it; the signed box commit anchors it."""
    _need(len(archive["metadata"]) == 1 and archive["metadata"][0]["singleton"] == 1)
    meta = _decoded(archive["metadata"][0]["value"])
    evidence._fields(
        meta,
        {
            "bundleDigest",
            "boxId",
            "boxKeyThumbprint",
            "ownershipEpoch",
            "provisioningId",
            "initialGrants",
            "claimSecretSha256",
            "rosterVersion",
            "rosterDigest",
            "policyVersion",
            "principalId",
            "recoveryConfigured",
            "lastSeenNow",
            "bootId",
            "eventDigest",
        },
    )
    evidence._integer(meta["ownershipEpoch"])
    evidence._integer(meta["policyVersion"])
    protocol._counter(meta["rosterVersion"])
    if meta["bootId"] is not None:
        evidence._token(meta["bootId"])
    if meta["principalId"] is not None:
        evidence._token(meta["principalId"])
    _need(
        meta["bundleDigest"] == wire.digest(bundle)
        and meta["boxId"] == bundle["boxId"]
        and meta["boxKeyThumbprint"] == evidence.public_key_thumbprint(bundle["boxKey"])
        and meta["ownershipEpoch"] == bundle["ownershipEpoch"]
        and meta["provisioningId"] == bundle["provisioningId"]
        and meta["initialGrants"] == bundle["grants"]
        and meta["policyVersion"] == 1
        and meta["recoveryConfigured"] is False
    )
    evidence._integer(meta["lastSeenNow"])
    validate_resource_grants(meta["initialGrants"])
    requests = {row["request_id"]: row for row in archive["requests"]}
    _need(len(requests) == len(archive["requests"]))
    previous = wire.digest([])
    roster = []
    rows_by_binding = {}
    root = None
    used_keys, used_clients = set(), set()
    used_requests = set()
    for sequence, event_row in enumerate(archive["events"], 1):
        event = _decoded(event_row["value"])
        evidence._fields(
            event,
            {
                "schemaVersion",
                "purpose",
                "sequence",
                "previousDigest",
                "requestId",
                "requestDigest",
                "binding",
                "grants",
                "rosterDigest",
                "committedAt",
            },
        )
        _need(
            type(event["schemaVersion"]) is int
            and event["schemaVersion"] == 1
            and event["purpose"] == "centuarai.local-management.binding-commit"
            and event_row["seq"] == event["sequence"] == sequence
            and event["previousDigest"] == previous
            and event_row["previous_digest"] == previous
            and event_row["digest"] == wire.digest(event)
        )
        evidence._integer(event["committedAt"])
        _need(event["committedAt"] <= meta["lastSeenNow"])
        row = requests.get(event["requestId"])
        _need(
            row is not None
            and row["state"] == "approved"
            and row["digest"] == event["requestDigest"]
            and row["request_id"] not in used_requests
            and row["ack"] == event_row["ack"]
        )
        if sequence == 1:
            _need(row["kind"] == "root")
            request = wire._decode(row["request_jws"], wire.ROOT_ACCESS, wire.validate_first_root)
            evidence._verify(row["request_jws"], evidence._public_key(request["accessKey"]))
            _need(
                wire.first_root_digest(request) == row["digest"]
                and request["provisioningId"] == bundle["provisioningId"]
                and request["grants"] == bundle["grants"]
                and row["approval"] is None
                and row["approval_key"] is None
            )
        else:
            _need(row["kind"] == "use" and root is not None)
            request = evidence.verify_request_proof(row["request_jws"])
            _need(
                evidence.request_digest(request) == row["digest"]
                and request["rosterVersion"] == sequence - 1
                and request["rosterDigest"]
                == wire.digest(sorted(roster, key=lambda item: item["bindingId"]))
                and request["policyVersion"] == meta["policyVersion"]
            )
            approval = _decoded(row["approval"])
            evidence._approval(approval)
            _need(
                approval["requestDigest"] == row["digest"]
                and approval["approverBindingId"] == root["bindingId"]
                and approval["approvalKeyVersion"] == root["approvalKeyVersion"]
                and _decoded(row["approval_key"]) == root["approvalKey"]
                and root["establishedAt"] <= request["issuedAt"]
                and root["establishedVersion"] <= request["rosterVersion"]
                and request["issuedAt"]
                <= approval["approvedAt"]
                <= event["committedAt"]
                < approval["expiresAt"]
                <= request["expiresAt"]
            )
            allowed = {
                grant["resourceId"]: set(grant["actions"]) for grant in root["delegableGrants"]
            }
            _need(
                all(
                    set(grant["actions"]) <= allowed.get(grant["resourceId"], set())
                    for grant in request["grants"]
                )
            )
            for field in ("expiresAt", "delegationExpiresAt"):
                limit = root[field]
                _need(
                    limit is None
                    or event["committedAt"] < limit
                    and request["grantExpiresAt"] is not None
                    and request["grantExpiresAt"] <= limit
                )
        _need(
            request == _decoded(row["value"])
            and row["expires_at"] == request["expiresAt"]
            and request["requestId"] == row["request_id"]
            and request["boxId"] == meta["boxId"]
            and request["boxKeyThumbprint"] == meta["boxKeyThumbprint"]
            and request["ownershipEpoch"] == meta["ownershipEpoch"]
            and request["principalId"] == meta["principalId"]
            and request["issuedAt"] <= event["committedAt"] < request["expiresAt"]
            and event["grants"] == request["grants"]
        )
        validate_resource_grants(request["grants"])
        binding = event["binding"]
        expected = {
            "bindingId": binding["bindingId"],
            "principalId": request["principalId"],
            "clientId": request["clientId"],
            "role": "manage" if sequence == 1 else "use",
            "status": "active",
            "accessKey": request["accessKey"],
            "approvalKey": request["approvalKey"] if sequence == 1 else None,
            "approvalKeyVersion": 1 if sequence == 1 else None,
            "canApproveUseDevices": sequence == 1,
            "delegableGrants": request["grants"] if sequence == 1 else [],
            "expiresAt": request["grantExpiresAt"],
            "delegationExpiresAt": None,
            "establishedAt": event["committedAt"],
            "establishedVersion": sequence,
        }
        _need(
            binding == expected
            and binding["bindingId"] not in rows_by_binding
            and binding["clientId"] not in used_clients
        )
        for field in ("accessKey", "approvalKey"):
            if binding[field] is not None:
                thumb = evidence.public_key_thumbprint(binding[field])
                _need(thumb not in used_keys)
                used_keys.add(thumb)
        used_clients.add(binding["clientId"])
        used_requests.add(row["request_id"])
        rows_by_binding[binding["bindingId"]] = row
        roster.append(binding)
        if sequence == 1:
            root = binding
        digest = wire.digest(sorted(roster, key=lambda item: item["bindingId"]))
        _need(event["rosterDigest"] == digest)
        ack = wire.verify_response(
            row["ack"], bundle["boxKey"], box_id=bundle["boxId"], kind="binding-ack"
        )
        expected_ack = {
            "requestId": row["request_id"],
            "requestDigest": row["digest"],
            "bindingId": binding["bindingId"],
            "principalId": binding["principalId"],
            "clientId": binding["clientId"],
            "role": binding["role"],
            "accessKeyThumbprint": evidence.public_key_thumbprint(binding["accessKey"]),
            "ownershipEpoch": meta["ownershipEpoch"],
            "rosterVersion": sequence,
            "rosterDigest": digest,
            "policyVersion": meta["policyVersion"],
            "committedAt": event["committedAt"],
            "recoveryConfigured": False,
        }
        _need(ack["body"] == expected_ack and ack["issuedAt"] == event["committedAt"])
        previous = event_row["digest"]
    _need(
        meta["rosterVersion"] == len(roster)
        and meta["eventDigest"] == previous
        and meta["rosterDigest"] == wire.digest(sorted(roster, key=lambda item: item["bindingId"]))
    )
    actual_bindings = {
        _decoded(row["value"])["bindingId"]: _decoded(row["value"]) for row in archive["bindings"]
    }
    _need(
        actual_bindings == {item["bindingId"]: item for item in roster}
        and all(
            row["binding_id"] == _decoded(row["value"])["bindingId"]
            and row["client_id"] == _decoded(row["value"])["clientId"]
            for row in archive["bindings"]
        )
    )
    expected_index = {
        (evidence.public_key_thumbprint(item[field]), item["bindingId"], field)
        for item in roster
        for field in ("accessKey", "approvalKey")
        if item[field] is not None
    }
    _need(
        {(row["thumbprint"], row["binding_id"], row["purpose"]) for row in archive["keys"]}
        == expected_index
    )
    if root is None:
        _need(
            meta["principalId"] is None
            and meta["claimSecretSha256"] == bundle["claimSecretSha256"]
            and not requests
        )
    else:
        _need(meta["claimSecretSha256"] is None and meta["principalId"] == root["principalId"])
    for row in archive["requests"]:
        _need(row["state"] in ("pending", "approved", "cancelled", "expired"))
        if row["kind"] == "root":
            _need(row["request_id"] in used_requests)
            continue
        _need(row["kind"] == "use")
        request = evidence.verify_request_proof(row["request_jws"])
        _need(
            request == _decoded(row["value"]) and evidence.request_digest(request) == row["digest"]
        )
        receipt = wire.verify_response(
            row["receipt"], bundle["boxKey"], box_id=bundle["boxId"], kind="request-receipt"
        )
        _need(
            receipt["body"]
            == {
                "requestId": row["request_id"],
                "requestDigest": row["digest"],
                "state": "pending",
                "expiresAt": request["expiresAt"],
            }
            and request["issuedAt"] <= receipt["issuedAt"] < request["expiresAt"]
        )
        _need(row["state"] != "approved" or row["request_id"] in used_requests)
    return meta, sorted(roster, key=lambda item: item["bindingId"]), rows_by_binding


def make_grant(binding, request, resource, *, principal=False, sources=()):
    resolved = resolve_resource(binding["principalId"], resource["resourceId"])
    grant_id = "grant:" + wire.digest(
        {
            "bindingId": binding["bindingId"],
            "resourceId": resource["resourceId"],
            "principal": principal,
        }
    )
    delegated = resource["actions"] if principal or binding["role"] == "manage" else []
    return {
        "grantId": grant_id,
        "ownershipEpoch": request["ownershipEpoch"],
        "principalId": binding["principalId"],
        "bindingId": None if principal else binding["bindingId"],
        "resourceId": resource["resourceId"],
        "resourceScope": resolved["scope"],
        "resourceNamespaceId": resolved["namespaceId"],
        "actions": resource["actions"],
        "delegableActions": delegated,
        "expiresAt": binding["expiresAt"],
        "delegationExpiresAt": binding["delegationExpiresAt"],
        "status": "active",
        "sourceGrantIds": sorted(sources),
        "sourceBindingId": None
        if principal or binding["role"] == "manage"
        else _decoded(request["approval"])["approverBindingId"],
        "createdSequence": binding["establishedVersion"],
        "revision": 1,
    }


def build_v2_origin(archive, bundle):
    meta, roster, requests = verify_v1(archive, bundle)
    principals, bindings, grants, key_history = [], [], [], []
    root = next((row for row in roster if row["role"] == "manage"), None)
    if root:
        principals.append(
            {
                "principalId": root["principalId"],
                "ownershipEpoch": meta["ownershipEpoch"],
                "status": "active",
                "principalSecurityVersion": 1,
                "createdSequence": 1,
                "recoveryVersion": 0,
            }
        )
    parent_grants = {}
    for binding in sorted(roster, key=lambda row: row["establishedVersion"]):
        row = requests[binding["bindingId"]]
        request = _decoded(row["value"])
        parent = None if row["kind"] == "root" else _decoded(row["approval"])["approverBindingId"]
        extended = {
            **binding,
            "bindingRevision": 1,
            "ownershipEpoch": meta["ownershipEpoch"],
            "capabilities": ["device.approve_use"] if binding["canApproveUseDevices"] else [],
            "createdByBindingId": parent,
            "createdByRecoveryId": None,
            "sourceRequestId": row["request_id"],
            "sourceEventSequence": binding["establishedVersion"],
        }
        bindings.append(extended)
        for field in ("accessKey", "approvalKey"):
            if binding[field] is not None:
                key_history.append(
                    {
                        "thumbprint": evidence.public_key_thumbprint(binding[field]),
                        "purpose": field,
                        "firstSequence": binding["establishedVersion"],
                        "retiredAtSequence": None,
                    }
                )
        for resource in request["grants"]:
            if parent is None:
                grants.append(make_grant(binding, request, resource, principal=True))
            source_ids = () if parent is None else (parent_grants[resource["resourceId"]],)
            grant = make_grant(
                binding, {**request, "approval": row["approval"]}, resource, sources=source_ids
            )
            grants.append(grant)
            if parent is None:
                parent_grants[resource["resourceId"]] = grant["grantId"]
    ownership = {
        "boxId": meta["boxId"],
        "boxKeyThumbprint": meta["boxKeyThumbprint"],
        "ownershipEpoch": meta["ownershipEpoch"],
        "state": "owned" if root else "unclaimed_ready",
        "ownerPrincipalId": meta["principalId"],
        "originalOwnerBindingId": root["bindingId"] if root else None,
        "extendedOwnerPolicyActivated": False,
        "provisioningId": meta["provisioningId"],
        "pendingTransferId": None,
    }
    snapshot = {
        "schemaVersion": 2,
        "ownership": ownership,
        "policyVersion": meta["policyVersion"],
        "authorizationVersion": 1,
        "dataPlanePolicy": "local-trust-required",
        "principals": principals,
        "bindings": sorted(bindings, key=lambda row: row["bindingId"]),
        "grants": sorted(grants, key=lambda row: row["grantId"]),
        "recoveryConfigurations": [],
        "keyHistory": sorted(key_history, key=lambda row: (row["purpose"], row["thumbprint"])),
    }
    return meta, snapshot


def public_archive_digest(archive):
    redacted = json.loads(json.dumps(archive))
    meta = _decoded(redacted["metadata"][0]["value"])
    verifier = meta.pop("claimSecretSha256")
    meta["credentialCommitment"] = wire.digest(
        {
            "purpose": "centuarai.local-ledger.source-credential",
            "provisioningId": meta["provisioningId"],
            "ownershipEpoch": meta["ownershipEpoch"],
            "verifierDigest": wire.digest(verifier),
        }
    )
    redacted["metadata"][0]["value"] = wire.canonical(meta).decode("ascii")
    return wire.digest(redacted)


def persist_snapshot(db, snapshot):
    for table, column, values, field in (
        ("principals", "principal_id", snapshot["principals"], "principalId"),
        ("bindings_v2", "binding_id", snapshot["bindings"], "bindingId"),
        ("resource_grants", "grant_id", snapshot["grants"], "grantId"),
        (
            "recovery_configurations",
            "recovery_id",
            snapshot["recoveryConfigurations"],
            "recoveryId",
        ),
        ("signing_key_history", "thumbprint", snapshot["keyHistory"], "thumbprint"),
    ):
        for value in values:
            db.execute(
                f"INSERT INTO {table} ({column},value) VALUES (?,?) ON CONFLICT({column}) DO UPDATE SET value=excluded.value",
                (value[field], wire.canonical(value).decode("ascii")),
            )
    # Retained compatibility rows are projections, never a second authority.
    db.execute("DELETE FROM bindings")
    db.execute("DELETE FROM keys")
    for value in snapshot["bindings"]:
        projection = {key: value[key] for key in evidence._BINDING_FIELDS}
        db.execute(
            "INSERT INTO bindings VALUES (?,?,?)",
            (value["bindingId"], value["clientId"], wire.canonical(projection).decode("ascii")),
        )
        for purpose in ("accessKey", "approvalKey"):
            if value[purpose] is not None:
                db.execute(
                    "INSERT INTO keys VALUES (?,?,?)",
                    (evidence.public_key_thumbprint(value[purpose]), value["bindingId"], purpose),
                )


def migrate_authority_v2(directory, *, now):
    """Offline, explicit migration. A forward-only floor survives failed migration.

    Calling this is not a factory/reset proof. It can only transform a complete,
    independently provisioned and sealed v1 ledger. Runtime never calls it.
    """
    import fcntl
    import os
    import stat

    from .local_authority_store import SEAL, _directory, _materials, _new, _open, _read, _time

    _time(now)
    directory = _directory(directory)
    bundle, key = _materials(directory)
    _need(
        evidence._parse(_read(directory, SEAL))
        == {"schemaVersion": 1, "bundleDigest": wire.digest(bundle)}
    )
    descriptor = {
        "schemaVersion": 2,
        "boxId": bundle["boxId"],
        "boxKeyThumbprint": evidence.public_key_thumbprint(bundle["boxKey"]),
        "policy": "local-trust-required",
    }
    fd = os.open(
        directory / "management-runtime.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    db = None
    try:
        info = os.fstat(fd)
        _need(
            stat.S_ISREG(info.st_mode)
            and info.st_nlink == 1
            and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o600
        )
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise evidence.BindingProtocolError("LOCAL_TRUST_RUNTIME_ACTIVE") from exc
        floor = directory / "local-trust-required.json"
        if floor.exists() or floor.is_symlink():
            _need(evidence._parse(_read(directory, floor.name)) == descriptor)
        else:
            _new(directory, floor.name, wire.canonical(descriptor))
        db = _open(directory)
        db.execute("BEGIN IMMEDIATE")
        _need(db.execute("PRAGMA user_version").fetchone()[0] == 0)
        _need(db.execute("PRAGMA integrity_check").fetchone()[0] == "ok")
        archive = capture_v1(db)
        meta, snapshot = build_v2_origin(archive, bundle)
        _need(now >= meta["lastSeenNow"])
        from .local_ledger_engine import validate_read_capacity

        validate_read_capacity(
            snapshot,
            {
                name: meta[name]
                for name in (
                    "boxId",
                    "boxKeyThumbprint",
                    "ownershipEpoch",
                    "rosterVersion",
                    "rosterDigest",
                    "policyVersion",
                )
            },
            now,
        )
        source = {
            name: meta[name]
            for name in ("ownershipEpoch", "rosterVersion", "rosterDigest", "eventDigest")
        }
        schema = [
            dict(row)
            for row in db.execute(
                "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name"
            )
        ]
        anchor = {
            "fromSchema": 1,
            "toSchema": 2,
            "bootstrapBundleDigest": wire.digest(bundle),
            "sourceSchemaDigest": wire.digest(schema),
            "sourceCheckpoint": source,
            "sourceEvidenceDigest": public_archive_digest(archive),
            "sourceClockHighWater": meta["lastSeenNow"],
        }
        sequence = meta["rosterVersion"] + 1
        event = {
            "schemaVersion": 2,
            "eventId": "event:" + secrets.token_urlsafe(32),
            "sequence": sequence,
            "eventType": "schema.migrated",
            "previousEventDigest": meta["eventDigest"],
            "ownershipEpoch": meta["ownershipEpoch"],
            "requestId": None,
            "mutationDigest": None,
            "actor": None,
            "effectsDigest": None,
            "authorizationVersion": 1,
            "policyVersion": meta["policyVersion"],
            "committedAt": now,
            "rosterDigest": wire.digest(snapshot),
            "body": anchor,
        }
        event_digest = wire.digest(event)
        for sql in V2_TABLES:
            db.execute(sql)
        for table in ("ledger_events", "operation_events"):
            db.execute(
                f"CREATE TRIGGER {table}_no_update BEFORE UPDATE ON {table} BEGIN SELECT RAISE(ABORT,'immutable history'); END"
            )
            db.execute(
                f"CREATE TRIGGER {table}_no_delete BEFORE DELETE ON {table} BEGIN SELECT RAISE(ABORT,'immutable history'); END"
            )
        origin = {"archive": archive, "sourceSchema": schema, "anchor": anchor}
        db.execute(
            "INSERT INTO ledger_origin VALUES (1,?)", (wire.canonical(origin).decode("ascii"),)
        )
        db.execute(
            "CREATE TRIGGER ledger_origin_no_update BEFORE UPDATE ON ledger_origin BEGIN SELECT RAISE(ABORT,'immutable origin'); END"
        )
        db.execute(
            "CREATE TRIGGER ledger_origin_no_delete BEFORE DELETE ON ledger_origin BEGIN SELECT RAISE(ABORT,'immutable origin'); END"
        )
        persist_snapshot(db, snapshot)
        if meta["bootId"] is not None:
            db.execute("INSERT OR IGNORE INTO retired_boots VALUES (?)", (meta["bootId"],))
        meta.update(
            {
                "schemaVersion": 2,
                "bootId": "migration:" + secrets.token_urlsafe(24),
                "lastSeenNow": now,
                "rosterVersion": sequence,
                "rosterDigest": event["rosterDigest"],
                "eventDigest": event_digest,
                "authorizationVersion": 1,
                "ownership": snapshot["ownership"],
                "dataPlanePolicy": "local-trust-required",
            }
        )
        owner = SimpleNamespace(bundle=bundle, _key=key)
        ack = protocol.sign_response(
            owner,
            "migration-ack",
            {
                "fromSchema": 1,
                "toSchema": 2,
                "sourceCheckpoint": source,
                "context": {name: meta[name] for name in evidence._BOX_FIELDS},
                "eventDigest": event_digest,
                "authorizationVersion": 1,
            },
            now,
        )
        db.execute(
            "INSERT INTO ledger_events VALUES (?,?,?,?,?)",
            (sequence, event_digest, wire.canonical(event).decode("ascii"), ack, ack),
        )
        db.execute(
            "UPDATE metadata SET value=? WHERE singleton=1", (wire.canonical(meta).decode("ascii"),)
        )
        db.execute("UPDATE requests SET state='expired' WHERE state='pending'")
        db.execute("DELETE FROM challenges")
        db.execute("PRAGMA user_version=2")
        db.commit()
        return ack
    except BaseException:
        if db is not None:
            db.rollback()
        raise
    finally:
        if db is not None:
            db.close()
        os.close(fd)
