"""Restricted backup jobs on the existing ledger connection and transaction.

The OS adapter owns fixed paths, application consistency and durable files. This
module owns authorization, immutable plan identity, worker permits and CAS. It
never opens business data, accepts a caller pathname, or stores an archive DEK.
"""

from __future__ import annotations

import hashlib
import json

from . import local_ledger_protocol as protocol
from . import local_management_protocol as wire
from . import local_trust_protocol as evidence

WORKER_TYPE = "centuarai-local-worker-operation+jws"
SOURCE_TYPE = "centuarai-business-backup+jws"
RESTORE_KEY_TYPE = "centuarai-local-restore-key+jws"
PHASES = {
    "backup.create": (
        "queued",
        "validating",
        "quiescing",
        "snapshotting",
        "encrypting",
        "staged",
        "publishing",
        "complete",
    ),
    "backup.restore": (
        "queued",
        "validating",
        "awaiting_key",
        "quiescing",
        "staged",
        "applying",
        "data_verified",
        "publishing",
        "complete",
    ),
}


def need(value, code="LOCAL_TRUST_OPERATION_DENIED"):
    evidence._require(value, code)


def source_payload(value):
    evidence._fields(
        value,
        {
            "schemaVersion",
            "purpose",
            "boxId",
            "boxKeyThumbprint",
            "backupId",
            "headerSha256",
            "ciphertextSha256",
            "ciphertextBytes",
            "manifestSha256",
            "scopeDigest",
            "createdAt",
        },
    )
    need(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and value["purpose"] == "centuarai.business-backup",
        "LOCAL_BINDING_INVALID",
    )
    evidence._token(value["boxId"])
    for field in (
        "boxKeyThumbprint",
        "backupId",
        "headerSha256",
        "ciphertextSha256",
        "manifestSha256",
        "scopeDigest",
    ):
        evidence._digest(value[field])
    evidence._integer(value["ciphertextBytes"])
    evidence._integer(value["createdAt"])


def header_schema(value):
    evidence._fields(
        value,
        {
            "schemaVersion",
            "format",
            "backupId",
            "sourceBoxId",
            "sourceBoxKeyThumbprint",
            "sourceOwnershipEpoch",
            "principalId",
            "principalSecurityVersion",
            "recoveryId",
            "recoveryVersion",
            "sourceRecoverySigningKey",
            "recipientKeyThumbprint",
            "createdAt",
            "scopeProfile",
            "scopeDigest",
            "wrapAlgorithm",
            "wrappedDataKey",
            "cipher",
            "noncePrefix",
            "chunkSize",
            "chunkCount",
            "plaintextBytes",
            "manifestBytes",
            "manifestSha256",
        },
    )
    need(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and value["format"] == "centuarai-business-backup-v1"
        and value["wrapAlgorithm"] == "RSA-OAEP-256"
        and value["cipher"] == "A256GCM"
        and type(value["chunkSize"]) is int
        and value["chunkSize"] == 1048576,
        "LOCAL_BINDING_INVALID",
    )
    for field in (
        "backupId",
        "sourceBoxKeyThumbprint",
        "recoveryId",
        "recipientKeyThumbprint",
        "scopeDigest",
        "manifestSha256",
    ):
        evidence._digest(value[field])
    for field in ("sourceBoxId", "principalId", "scopeProfile"):
        evidence._token(value[field])
    for field in (
        "sourceOwnershipEpoch",
        "principalSecurityVersion",
        "recoveryVersion",
        "createdAt",
        "chunkCount",
        "plaintextBytes",
        "manifestBytes",
    ):
        evidence._integer(value[field])
    evidence._public_key(value["sourceRecoverySigningKey"])
    evidence._decode(value["wrappedDataKey"], 384)
    evidence._decode(value["noncePrefix"], 4)
    need(
        value["plaintextBytes"] <= 2**40
        and value["manifestBytes"] <= min(value["plaintextBytes"], 16 * 1024 * 1024)
        and value["chunkCount"]
        == (value["plaintextBytes"] + value["chunkSize"] - 1) // value["chunkSize"],
        "LOCAL_BINDING_INVALID",
    )


def validate_plan(value, mutation):
    evidence._fields(
        value,
        {
            "schemaVersion",
            "backupId",
            "scopeDigest",
            "sourceBoxKey",
            "sourceHeader",
            "sourceProof",
            "plan",
        },
    )
    need(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and type(value["plan"]) is dict,
        "LOCAL_BINDING_INVALID",
    )
    evidence._digest(value["backupId"])
    evidence._digest(value["scopeDigest"])
    need(len(wire.canonical(value)) <= 65536, "LOCAL_TRUST_CAPACITY")
    args = mutation["args"]
    if mutation["action"] == "backup.create":
        need(
            all(value[field] is None for field in ("sourceBoxKey", "sourceHeader", "sourceProof")),
            "LOCAL_BINDING_INVALID",
        )
    else:
        key = value["sourceBoxKey"]
        header = value["sourceHeader"]
        header_schema(header)
        signed = wire._decode(value["sourceProof"], SOURCE_TYPE, source_payload)
        evidence._verify(value["sourceProof"], evidence._public_key(key))
        need(
            evidence.public_key_thumbprint(key)
            == args["sourceBoxKeyThumbprint"]
            == header["sourceBoxKeyThumbprint"]
            == signed["boxKeyThumbprint"]
            and header["sourceBoxId"] == signed["boxId"]
            and value["backupId"] == args["backupId"] == header["backupId"] == signed["backupId"]
            and wire.digest(header) == signed["headerSha256"]
            and signed["manifestSha256"] == args["manifestSha256"] == header["manifestSha256"]
            and signed["scopeDigest"] == header["scopeDigest"]
            and signed["createdAt"] == header["createdAt"],
            "LOCAL_BINDING_CONTEXT_MISMATCH",
        )


def permit_schema(value):
    evidence._fields(
        value,
        {
            "schemaVersion",
            "purpose",
            "boxId",
            "boxKeyThumbprint",
            "operationId",
            "action",
            "operationDigest",
            "principalId",
            "ownershipEpoch",
            "principalSecurityVersion",
            "policyVersion",
            "scopeDigest",
            "issuedAt",
            "expiresAt",
        },
    )
    need(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and value["purpose"] == "centuarai.local-worker.operation"
        and value["action"] in ("backup.create", "backup.restore", "ownership.transfer.erase"),
        "LOCAL_BINDING_INVALID",
    )
    for field in ("boxId", "principalId"):
        evidence._token(value[field])
    for field in ("boxKeyThumbprint", "operationId", "operationDigest", "scopeDigest"):
        evidence._digest(value[field])
    for field in ("ownershipEpoch", "principalSecurityVersion", "policyVersion"):
        evidence._integer(value[field])
    evidence._window(value)
    need(value["expiresAt"] <= value["issuedAt"] + 60, "LOCAL_BINDING_INVALID")


def restore_key_schema(value):
    evidence._fields(
        value,
        {
            "schemaVersion",
            "purpose",
            "boxId",
            "boxKeyThumbprint",
            "ownershipEpoch",
            "principalSecurityVersion",
            "operationId",
            "archiveSha256",
            "dataKeySha256",
            "nonce",
            "issuedAt",
            "expiresAt",
            "actor",
        },
    )
    need(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and value["purpose"] == "centuarai.local-restore.key",
        "LOCAL_BINDING_INVALID",
    )
    evidence._token(value["boxId"])
    for field in ("boxKeyThumbprint", "operationId", "archiveSha256", "dataKeySha256", "nonce"):
        evidence._digest(value[field])
    for field in ("ownershipEpoch", "principalSecurityVersion"):
        evidence._integer(value[field])
    protocol.actor(value["actor"])
    need(value["actor"]["kind"] == "binding", "LOCAL_BINDING_INVALID")
    evidence._window(value)
    need(value["expiresAt"] <= value["issuedAt"] + 60, "LOCAL_BINDING_INVALID")


def verify_worker_permit_readonly(db, bundle, proof, now):
    """Shared current-authority check for the fixed privileged OS executor.

    Caller verifies private files and opens SQLite mode=ro with BEGIN. This
    function performs reads only and never constructs an Authority or writer.
    The executor separately matches its fixed action/phase/resource profile.
    """
    from .local_ledger_engine import authority_actor, clone, principal, read_snapshot, transition

    evidence._integer(now)
    need(db.in_transaction, "LOCAL_TRUST_STATE_INVALID")
    need(db.execute("PRAGMA user_version").fetchone()[0] == 2, "LOCAL_TRUST_STATE_INVALID")
    meta = json.loads(db.execute("SELECT value FROM metadata WHERE singleton=1").fetchone()[0])
    need(
        meta["bundleDigest"] == wire.digest(bundle)
        and meta["dataPlanePolicy"] == "local-trust-required"
        and now >= meta["lastSeenNow"],
        "LOCAL_TRUST_STATE_INVALID",
    )
    permit = wire._decode(proof, WORKER_TYPE, permit_schema)
    evidence._verify(proof, evidence._public_key(bundle["boxKey"]))
    need(
        permit["boxId"] == meta["boxId"] == bundle["boxId"]
        and permit["boxKeyThumbprint"]
        == meta["boxKeyThumbprint"]
        == evidence.public_key_thumbprint(bundle["boxKey"])
        and permit["ownershipEpoch"] == meta["ownershipEpoch"]
        and permit["policyVersion"] == meta["policyVersion"]
        and permit["issuedAt"] <= now < permit["expiresAt"],
        "LOCAL_TRUST_OPERATION_DENIED",
    )
    stored = db.execute(
        "SELECT state,value FROM mutation_requests WHERE request_id=?", (permit["operationId"],)
    ).fetchone()
    need(stored is not None and stored[0] == "committed", "LOCAL_TRUST_OPERATION_DENIED")
    saved = json.loads(stored[1])
    mutation = saved["mutation"]
    need(
        saved["state"] == "committed"
        and wire.digest(mutation) == permit["operationDigest"]
        and mutation["actor"]["principalId"] == permit["principalId"],
        "LOCAL_TRUST_OPERATION_DENIED",
    )
    signed = protocol.verify_response(
        saved["ack"], bundle["boxKey"], box_id=bundle["boxId"], kind="mutation-ack"
    )["body"]
    need(
        signed["requestId"] == permit["operationId"]
        and signed["mutationDigest"] == permit["operationDigest"],
        "LOCAL_TRUST_STATE_INVALID",
    )
    snapshot = read_snapshot(db, meta)
    if permit["action"] == "ownership.transfer.erase":
        record = meta.get("transferPermit")
        need(
            record is not None
            and record["proof"] == proof
            and record["bootId"] == meta["bootId"]
            and record["requestId"] == permit["operationId"]
            and mutation["action"] == "ownership.transfer-prepare"
            and snapshot["ownership"]["state"] in ("transfer_frozen", "erase_pending")
            and record["transferId"]
            == mutation["args"]["transferId"]
            == snapshot["ownership"]["pendingTransferId"]
            and permit["scopeDigest"] == mutation["args"]["scopeManifestDigest"],
            "LOCAL_TRUST_OPERATION_DENIED",
        )
        active = clone(snapshot)
        active["ownership"]["state"] = "owned"
        actor = authority_actor(active, mutation["actor"], now)
        need(
            "ownership.transfer" in actor["capabilities"]
            and actor["principalId"] == active["ownership"]["ownerPrincipalId"]
        )
        status = {"state": snapshot["ownership"]["state"], "transferId": record["transferId"]}
        plan = saved["transferPlan"]
    else:
        row = db.execute(
            "SELECT value FROM local_operations WHERE operation_id=?", (permit["operationId"],)
        ).fetchone()
        need(row is not None, "LOCAL_TRUST_OPERATION_DENIED")
        job = json.loads(row[0])
        need(
            job["permit"] == proof
            and job["permitBootId"] == meta["bootId"]
            and job["status"]["state"] == "running"
            and job["status"]["mutationDigest"] == permit["operationDigest"]
            and job["status"]["action"] == mutation["action"] == permit["action"]
            and job["plan"]["scopeDigest"] == permit["scopeDigest"],
            "LOCAL_TRUST_OPERATION_DENIED",
        )
        transition(snapshot, mutation, now, meta["rosterVersion"] + 1)
        validate_plan(job["plan"], mutation)
        status, plan = job["status"], job["plan"]
    member = principal(snapshot, permit["principalId"])
    need(
        member is not None
        and member["principalSecurityVersion"] == permit["principalSecurityVersion"],
        "LOCAL_TRUST_OPERATION_DENIED",
    )
    return {
        "permit": permit,
        "status": status,
        "plan": plan,
        "mutation": mutation,
        "ownership": snapshot["ownership"],
    }


def operation_status(value):
    evidence._fields(
        value,
        {
            "operationId",
            "requestId",
            "action",
            "mutationDigest",
            "attempt",
            "stateVersion",
            "state",
            "phase",
            "errorCode",
            "recoveryRequired",
            "result",
            "updatedAt",
        },
    )
    for field in ("operationId", "requestId", "mutationDigest"):
        evidence._digest(value[field])
    need(
        value["operationId"] == value["requestId"] and value["action"] in PHASES,
        "LOCAL_BINDING_INVALID",
    )
    for field in ("attempt", "stateVersion", "updatedAt"):
        evidence._integer(value[field])
    need(
        value["state"] in ("queued", "running", "completed", "failed", "cancelled")
        and type(value["recoveryRequired"]) is bool,
        "LOCAL_BINDING_INVALID",
    )
    if value["errorCode"] is not None:
        evidence._token(value["errorCode"])
    need(
        value["phase"]
        in set(PHASES[value["action"]]) | {"failed_safe", "recovery_required", "cancelled"},
        "LOCAL_BINDING_INVALID",
    )
    if value["state"] == "completed":
        need(
            value["phase"] == "complete"
            and value["errorCode"] is None
            and value["recoveryRequired"] is False,
            "LOCAL_BINDING_INVALID",
        )
        result = value["result"]
        if value["action"] == "backup.create":
            fields = {
                "type",
                "operationId",
                "backupId",
                "archiveSha256",
                "manifestSha256",
                "scopeProfile",
                "resourceIds",
                "recoveryId",
                "recoveryVersion",
                "recipientKeyThumbprint",
                "targetId",
                "bytes",
                "completedAt",
                "targetDurable",
            }
            need(
                result.get("type") == "backup-created" and result.get("targetDurable") is True,
                "LOCAL_BINDING_INVALID",
            )
        else:
            fields = {
                "type",
                "operationId",
                "backupId",
                "archiveSha256",
                "manifestSha256",
                "targetBoxId",
                "targetDescriptorDigest",
                "scopeProfile",
                "resourceIds",
                "ownerMapping",
                "verifiedFiles",
                "verifiedBytes",
                "completedAt",
                "securityStateUnchanged",
                "integrationsActivated",
            }
            need(
                result.get("type") == "data-restore-completed"
                and result.get("securityStateUnchanged") is True
                and result.get("integrationsActivated") is False,
                "LOCAL_BINDING_INVALID",
            )
        evidence._fields(result, fields)
        need(result["operationId"] == value["operationId"], "LOCAL_BINDING_INVALID")
        for field in fields:
            item = result[field]
            if field in ("recoveryVersion", "completedAt", "bytes"):
                evidence._integer(item)
            elif field in ("verifiedFiles", "verifiedBytes"):
                protocol._counter(item)
            elif field in ("targetId", "targetBoxId", "scopeProfile", "type"):
                evidence._token(item)
            elif field == "resourceIds":
                protocol._tokens(item)
            elif field in ("targetDurable", "securityStateUnchanged", "integrationsActivated"):
                need(type(item) is bool, "LOCAL_BINDING_INVALID")
            elif field == "ownerMapping":
                need(type(item) is list and bool(item), "LOCAL_BINDING_INVALID")
                for mapping in item:
                    evidence._fields(
                        mapping, {"sourcePrincipalId", "targetPrincipalId", "resourceIds"}
                    )
                    evidence._token(mapping["sourcePrincipalId"])
                    evidence._token(mapping["targetPrincipalId"])
                    protocol._tokens(mapping["resourceIds"])
            else:
                evidence._digest(item)
    else:
        need(value["result"] is None, "LOCAL_BINDING_INVALID")
    if value["state"] == "failed":
        need(
            value["errorCode"] is not None
            and (value["phase"], value["recoveryRequired"])
            in (("failed_safe", False), ("recovery_required", True)),
            "LOCAL_BINDING_INVALID",
        )
    elif value["state"] == "cancelled":
        need(
            value["phase"] == "cancelled" and value["recoveryRequired"] is False,
            "LOCAL_BINDING_INVALID",
        )
    else:
        need(
            value["errorCode"] is None and value["recoveryRequired"] is False,
            "LOCAL_BINDING_INVALID",
        )


class LedgerOperations:
    def __init__(self, ledger):
        self.ledger = ledger
        self.owner = ledger.owner
        self.db = ledger.db
        self.provider = None

    def reservation_state(self, request_id):
        """Private bounded metadata read for OS reservation/journal cleanup."""
        evidence._digest(request_id)
        with self.owner._lock:
            need(not self.owner._closed, "LOCAL_TRUST_CLOSED")
            need(self.owner._meta()["bootId"] == self.owner._boot_id, "LOCAL_TRUST_BOOT_MISMATCH")
            row = self.db.execute(
                "SELECT value FROM local_operations WHERE operation_id=?", (request_id,)
            ).fetchone()
            return json.loads(row[0])["status"] if row is not None else None

    def verify_history(self, meta):
        for row in self.db.execute("SELECT operation_id,value FROM local_operations"):
            job = json.loads(row["value"])
            evidence._fields(
                job,
                {
                    "status",
                    "plan",
                    "authorizationEventDigest",
                    "operationSequence",
                    "operationEventDigest",
                    "signedStatus",
                    "permit",
                    "permitBootId",
                    "sourceProof",
                },
            )
            status = job["status"]
            operation_status(status)
            need(row["operation_id"] == status["operationId"], "LOCAL_TRUST_STATE_INVALID")
            saved = self.ledger._mutation(status["requestId"])
            need(
                saved is not None
                and saved["state"] == "committed"
                and saved["operationPlan"] == job["plan"]
                and saved["mutation"]["action"] == status["action"]
                and wire.digest(saved["mutation"]) == status["mutationDigest"],
                "LOCAL_TRUST_STATE_INVALID",
            )
            validate_plan(job["plan"], saved["mutation"])
            authorization_ack = protocol.verify_response(
                saved["ack"], self.owner.bundle["boxKey"], box_id=meta["boxId"], kind="mutation-ack"
            )["body"]
            need(
                authorization_ack["eventDigest"] == job["authorizationEventDigest"],
                "LOCAL_TRUST_STATE_INVALID",
            )
            previous, previous_status, sequence = wire.digest([]), None, 0
            for event_row in self.db.execute(
                "SELECT * FROM operation_events WHERE operation_id=? ORDER BY sequence",
                (row["operation_id"],),
            ):
                event = json.loads(event_row["value"])
                evidence._fields(
                    event,
                    {
                        "schemaVersion",
                        "operationId",
                        "operationSequence",
                        "eventType",
                        "previousOperationEventDigest",
                        "authorizationEventDigest",
                        "attempt",
                        "stateVersion",
                        "recordedAt",
                        "body",
                    },
                )
                current = event["body"]
                operation_status(current)
                need(
                    type(event["schemaVersion"]) is int
                    and event["schemaVersion"] == 2
                    and event["operationSequence"] == event_row["sequence"] == sequence + 1
                    and event["operationId"] == row["operation_id"] == current["operationId"]
                    and event["previousOperationEventDigest"] == previous
                    and event["authorizationEventDigest"] == job["authorizationEventDigest"]
                    and event["attempt"] == current["attempt"]
                    and event["stateVersion"] == current["stateVersion"]
                    and event["recordedAt"] == current["updatedAt"] <= meta["lastSeenNow"]
                    and current["mutationDigest"] == status["mutationDigest"]
                    and current["action"] == status["action"],
                    "LOCAL_TRUST_STATE_INVALID",
                )
                if previous_status is None:
                    need(
                        current["state"] == "queued"
                        and current["phase"] == "queued"
                        and current["stateVersion"] == current["attempt"] == 1
                        and event["eventType"] == "operation.phase-changed"
                        and current["updatedAt"] == authorization_ack["committedAt"],
                        "LOCAL_TRUST_STATE_INVALID",
                    )
                else:
                    need(
                        previous_status["state"] in ("queued", "running")
                        and current["stateVersion"] == previous_status["stateVersion"] + 1
                        and current["updatedAt"] >= previous_status["updatedAt"],
                        "LOCAL_TRUST_STATE_INVALID",
                    )
                    if event["eventType"] == "operation.started":
                        need(
                            current["state"] == "running"
                            and current["attempt"]
                            == previous_status["attempt"]
                            + (0 if previous_status["state"] == "queued" else 1)
                            and current["phase"]
                            == (
                                "validating"
                                if previous_status["state"] == "queued"
                                else previous_status["phase"]
                            ),
                            "LOCAL_TRUST_STATE_INVALID",
                        )
                    else:
                        need(
                            current["attempt"] == previous_status["attempt"],
                            "LOCAL_TRUST_STATE_INVALID",
                        )
                        stages = PHASES[current["action"]]
                        if current["state"] in ("running", "completed"):
                            need(
                                previous_status["phase"] in stages
                                and stages.index(previous_status["phase"]) + 1 < len(stages)
                                and current["phase"]
                                == stages[stages.index(previous_status["phase"]) + 1]
                                and event["eventType"]
                                == (
                                    "operation.completed"
                                    if current["state"] == "completed"
                                    else "operation.phase-changed"
                                ),
                                "LOCAL_TRUST_STATE_INVALID",
                            )
                        else:
                            need(
                                event["eventType"]
                                == (
                                    "operation.cancelled"
                                    if current["state"] == "cancelled"
                                    else "operation.failed"
                                ),
                                "LOCAL_TRUST_STATE_INVALID",
                            )
                previous, previous_status, sequence = (
                    wire.digest(event),
                    current,
                    event["operationSequence"],
                )
            need(
                previous_status == status
                and sequence == job["operationSequence"]
                and previous == job["operationEventDigest"],
                "LOCAL_TRUST_STATE_INVALID",
            )
            signed = protocol.verify_response(
                job["signedStatus"],
                self.owner.bundle["boxKey"],
                box_id=meta["boxId"],
                kind="operation-status",
            )
            need(
                signed["body"] == {"status": status, "operationEventDigest": previous},
                "LOCAL_TRUST_STATE_INVALID",
            )
            if job["permit"] is not None:
                permit = wire._decode(job["permit"], WORKER_TYPE, permit_schema)
                evidence._verify(job["permit"], evidence._public_key(self.owner.bundle["boxKey"]))
                need(
                    permit["operationId"] == status["operationId"]
                    and permit["operationDigest"] == status["mutationDigest"]
                    and permit["scopeDigest"] == job["plan"]["scopeDigest"]
                    and permit["boxId"] == meta["boxId"]
                    and permit["boxKeyThumbprint"] == meta["boxKeyThumbprint"],
                    "LOCAL_TRUST_STATE_INVALID",
                )
            if job["sourceProof"] is not None:
                source = wire._decode(job["sourceProof"], SOURCE_TYPE, source_payload)
                evidence._verify(
                    job["sourceProof"], evidence._public_key(self.owner.bundle["boxKey"])
                )
                need(
                    source["backupId"] == job["plan"]["backupId"]
                    and source["scopeDigest"] == job["plan"]["scopeDigest"],
                    "LOCAL_TRUST_STATE_INVALID",
                )
        committed = {
            row[0]
            for row in self.db.execute(
                "SELECT request_id FROM mutation_requests WHERE state='committed' AND json_extract(value,'$.mutation.action') IN ('backup.create','backup.restore')"
            )
        }
        jobs = {row[0] for row in self.db.execute("SELECT operation_id FROM local_operations")}
        need(committed == jobs, "LOCAL_TRUST_STATE_INVALID")

    def prepare_plan(self, mutation, snapshot, now, *, authorization_version=None):
        from .local_ledger_engine import (
            authority_actor,
            clone,
            effective_grants,
            grant_list,
            recovery,
        )

        need(self.provider is not None, "LOCAL_TRUST_OPERATION_UNAVAILABLE")
        row = authority_actor(snapshot, mutation["actor"], now)
        configuration = recovery(snapshot, row["principalId"])
        authorization = {
            "boxId": self.owner.bundle["boxId"],
            "boxKeyThumbprint": evidence.public_key_thumbprint(self.owner.bundle["boxKey"]),
            "principalId": row["principalId"],
            "bindingId": row["bindingId"],
            "authorizationVersion": snapshot["authorizationVersion"] + 1
            if authorization_version is None
            else authorization_version,
            "ownershipEpoch": snapshot["ownership"]["ownershipEpoch"],
            "principalSecurityVersion": next(
                item["principalSecurityVersion"]
                for item in snapshot["principals"]
                if item["principalId"] == row["principalId"]
            ),
            "policyVersion": snapshot["policyVersion"],
            "grants": grant_list(effective_grants(snapshot, row, now)),
            "recovery": clone(configuration),
        }
        plan = self.provider.prepare(clone(mutation), authorization, now)
        validate_plan(plan, mutation)
        return plan

    def _get(self, operation_id):
        evidence._digest(operation_id)
        row = self.db.execute(
            "SELECT value FROM local_operations WHERE operation_id=?", (operation_id,)
        ).fetchone()
        need(row is not None, "LOCAL_TRUST_OPERATION_UNKNOWN")
        return json.loads(row[0])

    def _save(self, job):
        self.db.execute(
            "INSERT INTO local_operations VALUES (?,?) ON CONFLICT(operation_id) DO UPDATE SET value=excluded.value",
            (job["status"]["operationId"], wire.canonical(job).decode("ascii")),
        )

    def _event(self, job, event_type, now):
        operation_status(job["status"])
        event = {
            "schemaVersion": 2,
            "operationId": job["status"]["operationId"],
            "operationSequence": job["operationSequence"] + 1,
            "eventType": event_type,
            "previousOperationEventDigest": job["operationEventDigest"],
            "authorizationEventDigest": job["authorizationEventDigest"],
            "attempt": job["status"]["attempt"],
            "stateVersion": job["status"]["stateVersion"],
            "recordedAt": now,
            "body": job["status"],
        }
        job["operationSequence"] = event["operationSequence"]
        job["operationEventDigest"] = wire.digest(event)
        job["signedStatus"] = protocol.sign_response(
            self.owner,
            "operation-status",
            {"status": job["status"], "operationEventDigest": job["operationEventDigest"]},
            now,
        )
        self.db.execute(
            "INSERT INTO operation_events VALUES (?,?,?)",
            (
                event["operationId"],
                event["operationSequence"],
                wire.canonical(event).decode("ascii"),
            ),
        )
        self._save(job)
        return job["signedStatus"]

    def create(self, mutation, plan, authorization_event_digest, now):
        status = {
            "operationId": mutation["requestId"],
            "requestId": mutation["requestId"],
            "action": mutation["action"],
            "mutationDigest": wire.digest(mutation),
            "attempt": 1,
            "stateVersion": 1,
            "state": "queued",
            "phase": "queued",
            "errorCode": None,
            "recoveryRequired": False,
            "result": None,
            "updatedAt": now,
        }
        job = {
            "status": status,
            "plan": plan,
            "authorizationEventDigest": authorization_event_digest,
            "operationSequence": 0,
            "operationEventDigest": wire.digest([]),
            "signedStatus": None,
            "permit": None,
            "permitBootId": None,
            "sourceProof": None,
        }
        self._event(job, "operation.phase-changed", now)

    def _current(self, job, meta, now):
        from .local_ledger_engine import transition

        saved = self.ledger._mutation(job["status"]["requestId"])
        need(
            saved is not None
            and saved["state"] == "committed"
            and wire.digest(saved["mutation"]) == job["status"]["mutationDigest"],
            "LOCAL_TRUST_STATE_INVALID",
        )
        # Re-evaluate current authority without applying the hypothetical result.
        transition(self.ledger.snapshot(meta), saved["mutation"], now, meta["rosterVersion"] + 1)
        validate_plan(job["plan"], saved["mutation"])
        need(self.provider is not None, "LOCAL_TRUST_OPERATION_UNAVAILABLE")
        ack = protocol.verify_response(
            saved["ack"], self.owner.bundle["boxKey"], box_id=meta["boxId"], kind="mutation-ack"
        )["body"]
        need(
            self.prepare_plan(
                saved["mutation"],
                self.ledger.snapshot(meta),
                now,
                authorization_version=ack["authorizationVersion"],
            )
            == job["plan"],
            "LOCAL_BINDING_CONTEXT_MISMATCH",
        )
        return saved["mutation"]

    def claim(self, operation_id, expected_attempt, expected_state_version, now):
        from .local_ledger_engine import clone, principal

        evidence._integer(expected_attempt)
        evidence._integer(expected_state_version)
        with self.owner._transaction(now) as meta:
            job = self._get(operation_id)
            status = job["status"]
            need(
                status["attempt"] == expected_attempt
                and status["stateVersion"] == expected_state_version,
                "LOCAL_TRUST_OPERATION_CONFLICT",
            )
            need(status["state"] in ("queued", "running"), "LOCAL_TRUST_OPERATION_TERMINAL")
            mutation = self._current(job, meta, now)
            if job["permit"] is not None:
                previous = wire._decode(job["permit"], WORKER_TYPE, permit_schema)
                need(
                    job["permitBootId"] != self.owner._boot_id or now >= previous["expiresAt"],
                    "LOCAL_TRUST_OPERATION_BUSY",
                )
                status["attempt"] += 1
            member = principal(self.ledger.snapshot(meta), mutation["actor"]["principalId"])
            payload = {
                "schemaVersion": 1,
                "purpose": "centuarai.local-worker.operation",
                "boxId": meta["boxId"],
                "boxKeyThumbprint": meta["boxKeyThumbprint"],
                "operationId": operation_id,
                "action": mutation["action"],
                "operationDigest": wire.digest(mutation),
                "principalId": member["principalId"],
                "ownershipEpoch": meta["ownershipEpoch"],
                "principalSecurityVersion": member["principalSecurityVersion"],
                "policyVersion": meta["policyVersion"],
                "scopeDigest": job["plan"]["scopeDigest"],
                "issuedAt": now,
                "expiresAt": now + 60,
            }
            job["permit"] = wire._sign(payload, self.owner._key, WORKER_TYPE, permit_schema)
            job["permitBootId"] = self.owner._boot_id
            status.update(
                state="running",
                phase="validating" if status["phase"] == "queued" else status["phase"],
                stateVersion=status["stateVersion"] + 1,
                updatedAt=now,
            )
            signed = self._event(job, "operation.started", now)
            return {"permit": job["permit"], "status": signed, "plan": clone(job["plan"])}

    def _authorized_permit(
        self, proof, expected_attempt, expected_state_version, meta, now, *, failure_only=False
    ):
        value = wire._decode(proof, WORKER_TYPE, permit_schema)
        evidence._verify(proof, evidence._public_key(self.owner.bundle["boxKey"]))
        job = self._get(value["operationId"])
        need(
            job["status"]["attempt"] == expected_attempt
            and job["status"]["stateVersion"] == expected_state_version
            and job["permit"] == proof
            and job["permitBootId"] == self.owner._boot_id,
            "LOCAL_TRUST_OPERATION_CONFLICT",
        )
        need(
            value["issuedAt"] <= now and (failure_only or now < value["expiresAt"]),
            "LOCAL_BINDING_EXPIRED",
        )
        if failure_only:
            saved = self.ledger._mutation(value["operationId"])
            need(saved is not None and saved["state"] == "committed", "LOCAL_TRUST_STATE_INVALID")
            mutation = saved["mutation"]
            need(self.provider is not None, "LOCAL_TRUST_OPERATION_UNAVAILABLE")
        else:
            mutation = self._current(job, meta, now)
            from .local_ledger_engine import principal

            member = principal(self.ledger.snapshot(meta), mutation["actor"]["principalId"])
            need(
                member is not None
                and member["principalSecurityVersion"] == value["principalSecurityVersion"]
                and value["principalId"] == member["principalId"]
                and value["boxId"] == meta["boxId"]
                and value["boxKeyThumbprint"] == meta["boxKeyThumbprint"]
                and value["scopeDigest"] == job["plan"]["scopeDigest"]
                and value["action"] == mutation["action"],
                "LOCAL_BINDING_CONTEXT_MISMATCH",
            )
        need(
            value["operationDigest"] == wire.digest(mutation)
            and value["ownershipEpoch"] == meta["ownershipEpoch"]
            and (failure_only or value["policyVersion"] == meta["policyVersion"]),
            "LOCAL_BINDING_CONTEXT_MISMATCH",
        )
        return job, mutation

    def transition(self, permit, evidence_value, expected_attempt, expected_state_version, now):
        evidence._fields(evidence_value, {"phase", "errorCode", "recoveryRequired", "result"})
        with self.owner._transaction(now) as meta:
            failure_only = (
                evidence_value["phase"] in ("failed_safe", "recovery_required")
                and evidence_value["result"] is None
            )
            job, mutation = self._authorized_permit(
                permit,
                expected_attempt,
                expected_state_version,
                meta,
                now,
                failure_only=failure_only,
            )
            status = job["status"]
            need(status["state"] == "running", "LOCAL_TRUST_OPERATION_TERMINAL")
            next_phase = evidence_value["phase"]
            stages = PHASES[status["action"]]
            if next_phase in ("failed_safe", "recovery_required", "cancelled"):
                state = "cancelled" if next_phase == "cancelled" else "failed"
                need(evidence_value["result"] is None)
            else:
                need(
                    status["phase"] in stages
                    and stages.index(status["phase"]) + 1 < len(stages)
                    and next_phase == stages[stages.index(status["phase"]) + 1],
                    "LOCAL_TRUST_OPERATION_PHASE_INVALID",
                )
                state = "completed" if next_phase == "complete" else "running"
            candidate = {
                **status,
                **evidence_value,
                "state": state,
                "stateVersion": status["stateVersion"] + 1,
                "updatedAt": now,
            }
            operation_status(candidate)
            self.provider.validate_phase(job["plan"], status.copy(), evidence_value.copy(), now)
            if state == "completed":
                result = candidate["result"]
                need(result["backupId"] == job["plan"]["backupId"] and result["completedAt"] == now)
                if mutation["action"] == "backup.create":
                    from .local_ledger_engine import recovery

                    current_recovery = recovery(
                        self.ledger.snapshot(meta), mutation["actor"]["principalId"]
                    )
                    need(
                        job["sourceProof"] is not None
                        and result["recoveryId"] == current_recovery["recoveryId"]
                        and result["recoveryVersion"] == mutation["args"]["expectedRecoveryVersion"]
                        and result["recipientKeyThumbprint"]
                        == mutation["args"]["recipientKeyThumbprint"]
                        and result["targetId"] == mutation["args"]["targetId"]
                    )
                else:
                    need(
                        result["archiveSha256"] == mutation["args"]["archiveSha256"]
                        and result["manifestSha256"] == mutation["args"]["manifestSha256"]
                        and result["targetDescriptorDigest"]
                        == mutation["args"]["targetDescriptorDigest"]
                    )
                need(
                    result["scopeProfile"] == mutation["args"]["scopeProfile"]
                    and result["resourceIds"] == mutation["args"]["resourceIds"]
                )
            job["status"] = candidate
            event_type = (
                "operation.completed"
                if state == "completed"
                else "operation.failed"
                if state == "failed"
                else "operation.cancelled"
                if state == "cancelled"
                else "operation.phase-changed"
            )
            return self._event(job, event_type, now)

    def list_runnable(self, limit, now):
        need(type(limit) is int and 1 <= limit <= 128, "LOCAL_BINDING_INVALID")
        with self.owner._transaction(now):
            result = []
            for row in self.db.execute(
                "SELECT value FROM local_operations WHERE json_extract(value,'$.status.state') IN ('queued','running') ORDER BY operation_id LIMIT ?",
                (limit,),
            ):
                job = json.loads(row[0])
                result.append(
                    {
                        "operationId": job["status"]["operationId"],
                        "attempt": job["status"]["attempt"],
                        "stateVersion": job["status"]["stateVersion"],
                        "state": job["status"]["state"],
                        "phase": job["status"]["phase"],
                        "permit": job["permit"],
                        "permitBootId": job["permitBootId"],
                    }
                )
            return result

    def report_interrupted(
        self, operation_id, evidence_value, expected_attempt, expected_state_version, now
    ):
        """Trusted current supervisor may record failure, never resume old authority."""
        evidence._fields(evidence_value, {"phase", "errorCode", "recoveryRequired", "result"})
        need(
            evidence_value["phase"] in ("failed_safe", "recovery_required")
            and evidence_value["result"] is None
        )
        with self.owner._transaction(now):
            job = self._get(operation_id)
            status = job["status"]
            need(
                status["state"] in ("queued", "running")
                and status["attempt"] == expected_attempt
                and status["stateVersion"] == expected_state_version,
                "LOCAL_TRUST_OPERATION_CONFLICT",
            )
            need(self.provider is not None, "LOCAL_TRUST_OPERATION_UNAVAILABLE")
            candidate = {
                **status,
                **evidence_value,
                "state": "failed",
                "stateVersion": status["stateVersion"] + 1,
                "updatedAt": now,
            }
            operation_status(candidate)
            self.provider.validate_phase(job["plan"], status.copy(), evidence_value.copy(), now)
            job["status"] = candidate
            return self._event(job, "operation.failed", now)

    def sign_source(self, permit, header, payload, expected_attempt, expected_state_version, now):
        from .local_ledger_engine import principal, recovery

        header_schema(header)
        source_payload(payload)
        with self.owner._transaction(now) as meta:
            job, mutation = self._authorized_permit(
                permit, expected_attempt, expected_state_version, meta, now
            )
            need(
                mutation["action"] == "backup.create"
                and job["status"]["state"] == "running"
                and job["status"]["phase"] in ("encrypting", "staged")
            )
            config = recovery(self.ledger.snapshot(meta), mutation["actor"]["principalId"])
            member = principal(self.ledger.snapshot(meta), mutation["actor"]["principalId"])
            need(
                header["backupId"] == payload["backupId"] == job["plan"]["backupId"]
                and header["scopeDigest"] == payload["scopeDigest"] == job["plan"]["scopeDigest"]
                and header["sourceBoxId"] == payload["boxId"] == meta["boxId"]
                and header["sourceBoxKeyThumbprint"]
                == payload["boxKeyThumbprint"]
                == meta["boxKeyThumbprint"]
                and header["sourceOwnershipEpoch"] == meta["ownershipEpoch"]
                and header["principalId"] == mutation["actor"]["principalId"]
                and header["principalSecurityVersion"] == member["principalSecurityVersion"]
                and header["recoveryId"] == config["recoveryId"]
                and header["recoveryVersion"] == config["version"]
                and header["sourceRecoverySigningKey"] == config["signingKey"]
                and header["recipientKeyThumbprint"] == wire.digest(config["backupKey"])
                and header["scopeProfile"] == mutation["args"]["scopeProfile"]
                and wire.digest(header) == payload["headerSha256"]
                and header["manifestSha256"] == payload["manifestSha256"]
                and payload["ciphertextBytes"]
                == header["plaintextBytes"] + 20 * header["chunkCount"]
                and header["createdAt"] == payload["createdAt"] <= now
            )
            self.provider.validate_source(
                job["plan"], job["status"].copy(), header.copy(), payload.copy(), now
            )
            signed = wire._sign(payload, self.owner._key, SOURCE_TYPE, source_payload)
            job["sourceProof"] = signed
            self._save(job)
            return signed

    def receive_restore_key(self, operation_id, archive_sha256, data_key, proof, now):
        from .local_ledger_engine import authority_actor, principal

        raw_key = evidence._decode(data_key, 32)
        value = wire._decode(proof, RESTORE_KEY_TYPE, restore_key_schema)
        with self.owner._transaction(now) as meta:
            job = self._get(operation_id)
            mutation = self._current(job, meta, now)
            need(
                mutation["action"] == "backup.restore"
                and job["status"]["state"] in ("queued", "running")
                and job["status"]["phase"] in ("queued", "validating", "awaiting_key"),
                "LOCAL_TRUST_OPERATION_DENIED",
            )
            need(
                value["actor"] == mutation["actor"]
                and value["operationId"] == operation_id
                and value["archiveSha256"] == archive_sha256 == mutation["args"]["archiveSha256"]
                and value["dataKeySha256"] == evidence._encode(hashlib.sha256(raw_key).digest()),
                "LOCAL_BINDING_CONTEXT_MISMATCH",
            )
            snapshot = self.ledger.snapshot(meta)
            actor = authority_actor(snapshot, value["actor"], now)
            evidence._verify(proof, evidence._public_key(actor["accessKey"]))
            member = principal(snapshot, actor["principalId"])
            need(
                value["principalSecurityVersion"] == member["principalSecurityVersion"]
                and all(
                    value[name] == meta[name]
                    for name in ("boxId", "boxKeyThumbprint", "ownershipEpoch")
                ),
                "LOCAL_BINDING_CONTEXT_MISMATCH",
            )
            need(
                callable(getattr(self.provider, "receive_restore_key", None)),
                "LOCAL_TRUST_OPERATION_UNAVAILABLE",
            )
            self.owner._consume_challenge(value, "read-v2", now, operation_id, meta, field="nonce")
            response = protocol.sign_response(
                self.owner,
                "restore-key-received",
                {"operationId": operation_id, "archiveSha256": archive_sha256, "receivedAt": now},
                now,
            )
            # Fixed trusted worker's bounded in-memory handoff only. Neither the
            # key nor proof enters any SQLite row, journal, event or response.
            provider = self.provider
            plan = json.loads(wire.canonical(job["plan"]))
            self.owner._after_commit(
                lambda: provider.receive_restore_key(plan, operation_id, raw_key, now)
            )
            return response
