"""Private OS verified-erasure transitions; no network or cloud entry point."""

from __future__ import annotations

import hashlib
import json

from . import local_ledger_protocol as protocol
from . import local_management_protocol as wire
from . import local_trust_protocol as evidence
from .local_ledger_migration import persist_snapshot


def need(value, code="LOCAL_TRUST_ERASE_EVIDENCE_INVALID"):
    evidence._require(value, code)


def validate_plan(value, mutation):
    evidence._fields(value, {"scopeManifestDigest", "resetPlanDigest"})
    evidence._digest(value["scopeManifestDigest"])
    evidence._digest(value["resetPlanDigest"])
    need(value["scopeManifestDigest"] == mutation["args"]["scopeManifestDigest"])


def provisioning(value, bundle):
    evidence._fields(
        value,
        {
            "provisioningId",
            "ownershipEpoch",
            "boxKeyThumbprint",
            "tlsSpkiSha256",
            "credentialCommitment",
        },
    )
    for field in ("provisioningId", "boxKeyThumbprint", "tlsSpkiSha256", "credentialCommitment"):
        evidence._digest(value[field])
    evidence._integer(value["ownershipEpoch"])
    need(
        value["boxKeyThumbprint"] == evidence.public_key_thumbprint(bundle["boxKey"])
        and value["tlsSpkiSha256"] == bundle["tlsSpkiSha256"]
    )


def credential_commitment(value, verifier):
    raw = evidence._decode(verifier, 32)
    return wire.digest(
        {
            "purpose": "centuarai.local-ledger.claim-verifier-commitment",
            "provisioningId": value["provisioningId"],
            "ownershipEpoch": value["ownershipEpoch"],
            "verifierDigest": evidence._encode(hashlib.sha256(raw).digest()),
        }
    )


def transition(snapshot, event_type, body, sequence, bundle):
    from .local_ledger_engine import clone, record_delta, retire_bindings

    before = snapshot
    snapshot = clone(snapshot)
    required = {"transferId", "resetEvidenceDigest", "scopeManifestDigest"}
    if event_type == "ownership.redelivery-ready":
        required |= {"preparedDeliveryDigest", "newProvisioning"}
    evidence._fields(body, required)
    for field in required - {"newProvisioning"}:
        evidence._digest(body[field])
    owner = snapshot["ownership"]
    need(owner["pendingTransferId"] == body["transferId"])
    if event_type == "ownership.erase-started":
        need(owner["state"] == "transfer_frozen")
        owner["state"] = "erase_pending"
    else:
        need(event_type == "ownership.redelivery-ready" and owner["state"] == "erase_pending")
        new = body["newProvisioning"]
        provisioning(new, bundle)
        need(
            new["ownershipEpoch"] == owner["ownershipEpoch"] + 1
            and new["provisioningId"] != owner["provisioningId"]
        )
        retired = {
            row["bindingId"]
            for row in snapshot["bindings"]
            if row["ownershipEpoch"] == owner["ownershipEpoch"]
        }
        retire_bindings(snapshot, retired, set(), sequence)
        for row in snapshot["principals"]:
            if row["ownershipEpoch"] == owner["ownershipEpoch"] and row["status"] != "revoked":
                row["status"] = "revoked"
                row["principalSecurityVersion"] += 1
        for row in snapshot["grants"]:
            if row["ownershipEpoch"] == owner["ownershipEpoch"] and row["status"] != "revoked":
                row["status"] = "revoked"
                row["revision"] += 1
        for row in snapshot["recoveryConfigurations"]:
            if row["status"] == "active":
                row["status"] = "retired"
                row["retiredAtSequence"] = sequence
        for row in snapshot["keyHistory"]:
            if row["retiredAtSequence"] is None:
                row["retiredAtSequence"] = sequence
        owner.update(
            ownershipEpoch=new["ownershipEpoch"],
            state="unclaimed_ready",
            ownerPrincipalId=None,
            originalOwnerBindingId=None,
            extendedOwnerPolicyActivated=False,
            provisioningId=new["provisioningId"],
            pendingTransferId=None,
        )
        # The old membership/ACL graph remains in the signed event history but
        # cannot survive the independently verified full-erase into a new epoch.
        snapshot.pop("team", None)
    snapshot["authorizationVersion"] += 1
    return snapshot, record_delta(before, snapshot, ())


class LedgerTransfer:
    def __init__(self, ledger):
        self.ledger, self.owner, self.db = ledger, ledger.owner, ledger.db
        self.provider = None

    @staticmethod
    def ownership_context(snapshot):
        owner = snapshot["ownership"].copy()
        owner["transferSummary"] = {
            "affectedPrincipals": sum(
                row["ownershipEpoch"] == owner["ownershipEpoch"] for row in snapshot["principals"]
            ),
            "affectedBindings": sum(
                row["ownershipEpoch"] == owner["ownershipEpoch"] for row in snapshot["bindings"]
            ),
        }
        return owner

    def prepare_plan(self, mutation, snapshot, now):
        from .local_ledger_engine import clone

        need(self.provider is not None, "LOCAL_TRUST_OPERATION_UNAVAILABLE")
        plan = self.provider.prepare(clone(mutation), self.ownership_context(snapshot), now)
        validate_plan(plan, mutation)
        return plan

    def _saved_transfer(self, transfer_id):
        evidence._digest(transfer_id)
        matches = self.db.execute(
            "SELECT value FROM mutation_requests WHERE state='committed' AND json_extract(value,'$.mutation.action')='ownership.transfer-prepare' AND json_extract(value,'$.mutation.args.transferId')=?",
            (transfer_id,),
        ).fetchall()
        need(len(matches) == 1, "LOCAL_TRUST_TRANSFER_UNKNOWN")
        saved = json.loads(matches[0][0])
        validate_plan(saved["transferPlan"], saved["mutation"])
        return saved

    def _existing(self, event_type, transfer_id):
        rows = self.db.execute(
            "SELECT * FROM ledger_events WHERE json_extract(value,'$.eventType')=? AND json_extract(value,'$.body.transferId')=?",
            (event_type, transfer_id),
        ).fetchall()
        need(len(rows) <= 1)
        return rows[0] if rows else None

    def read_status(self, saved):
        """Only archived facts, never the new owner's identity or claim material."""
        mutation = saved["mutation"]
        ack = protocol.verify_response(
            saved["ack"],
            self.owner.bundle["boxKey"],
            box_id=self.owner.bundle["boxId"],
            kind="mutation-ack",
        )["body"]
        context = {
            field: ack[field]
            for field in ("ownershipEpoch", "rosterVersion", "rosterDigest", "policyVersion")
        }
        context.update(
            boxId=self.owner.bundle["boxId"],
            boxKeyThumbprint=evidence.public_key_thumbprint(self.owner.bundle["boxKey"]),
        )
        result = {
            "requestId": mutation["requestId"],
            "transferId": mutation["args"]["transferId"],
            "state": "frozen",
            "sourceOwnershipEpoch": ack["ownershipEpoch"],
            "checkpoint": {
                "context": context,
                "eventDigest": ack["eventDigest"],
                "authorizationVersion": ack["authorizationVersion"],
            },
            "updatedAt": ack["committedAt"],
            "resetEvidenceDigest": None,
            "preparedDeliveryDigest": None,
        }
        for event_type, state in (
            ("ownership.erase-started", "erase_pending"),
            ("ownership.redelivery-ready", "redelivery_ready"),
        ):
            row = self._existing(event_type, result["transferId"])
            if row is None:
                continue
            event = json.loads(row["value"])
            checkpoint = protocol.verify_response(
                row["ack"],
                self.owner.bundle["boxKey"],
                box_id=self.owner.bundle["boxId"],
                kind="checkpoint",
            )["body"]
            need(
                checkpoint["eventDigest"] == row["digest"] == wire.digest(event),
                "LOCAL_TRUST_STATE_INVALID",
            )
            result.update(
                state=state,
                checkpoint=checkpoint,
                updatedAt=event["committedAt"],
                resetEvidenceDigest=event["body"]["resetEvidenceDigest"],
                preparedDeliveryDigest=event["body"].get("preparedDeliveryDigest"),
            )
        return result

    def worker_permit(self, transfer_id, now):
        from .local_ledger_engine import authority_actor, clone, principal
        from .local_ledger_operations import WORKER_TYPE, permit_schema

        with self.owner._transaction(now) as meta:
            saved = self._saved_transfer(transfer_id)
            need(
                meta["ownership"]["state"] in ("transfer_frozen", "erase_pending")
                and meta["ownership"]["pendingTransferId"] == transfer_id,
                "LOCAL_TRUST_TRANSFER_UNKNOWN",
            )
            snapshot = clone(self.ledger.snapshot(meta))
            snapshot["ownership"]["state"] = (
                "owned"  # Only check the previously frozen actor; grants stay frozen in storage.
            )
            actor = authority_actor(snapshot, saved["mutation"]["actor"], now)
            need(
                "ownership.transfer" in actor["capabilities"]
                and actor["principalId"] == snapshot["ownership"]["ownerPrincipalId"]
            )
            member = principal(snapshot, actor["principalId"])
            existing = meta.get("transferPermit")
            if (
                existing
                and existing["transferId"] == transfer_id
                and existing["bootId"] == self.owner._boot_id
            ):
                old = wire._decode(existing["proof"], WORKER_TYPE, permit_schema)
                if old["issuedAt"] <= now < old["expiresAt"]:
                    return existing["proof"]
            payload = {
                "schemaVersion": 1,
                "purpose": "centuarai.local-worker.operation",
                "boxId": meta["boxId"],
                "boxKeyThumbprint": meta["boxKeyThumbprint"],
                "operationId": saved["mutation"]["requestId"],
                "action": "ownership.transfer.erase",
                "operationDigest": wire.digest(saved["mutation"]),
                "principalId": actor["principalId"],
                "ownershipEpoch": meta["ownershipEpoch"],
                "principalSecurityVersion": member["principalSecurityVersion"],
                "policyVersion": meta["policyVersion"],
                "scopeDigest": saved["mutation"]["args"]["scopeManifestDigest"],
                "issuedAt": now,
                "expiresAt": now + 60,
            }
            proof = wire._sign(payload, self.owner._key, WORKER_TYPE, permit_schema)
            meta["transferPermit"] = {
                "transferId": transfer_id,
                "requestId": saved["mutation"]["requestId"],
                "bootId": self.owner._boot_id,
                "proof": proof,
            }
            self.owner._save_meta(meta)
            return proof

    def _commit(self, meta, event_type, body, now, *, verifier=None):
        after, delta = transition(
            self.ledger.snapshot(meta),
            event_type,
            body,
            meta["rosterVersion"] + 1,
            self.owner.bundle,
        )
        event = {
            "schemaVersion": 2,
            "eventId": "event:" + wire.digest({"eventType": event_type, "body": body}),
            "sequence": meta["rosterVersion"] + 1,
            "eventType": event_type,
            "previousEventDigest": meta["eventDigest"],
            "ownershipEpoch": after["ownership"]["ownershipEpoch"],
            "requestId": None,
            "mutationDigest": None,
            "actor": None,
            "effectsDigest": None,
            "authorizationVersion": after["authorizationVersion"],
            "policyVersion": after["policyVersion"],
            "committedAt": now,
            "rosterDigest": wire.digest(after),
            "body": {**body, "delta": delta},
        }
        digest = wire.digest(event)
        persist_snapshot(self.db, after)
        meta.update(
            ownership=after["ownership"],
            ownershipEpoch=after["ownership"]["ownershipEpoch"],
            principalId=after["ownership"]["ownerPrincipalId"],
            rosterVersion=event["sequence"],
            rosterDigest=event["rosterDigest"],
            eventDigest=digest,
            authorizationVersion=after["authorizationVersion"],
        )
        if "team" in after:
            meta["team"] = after["team"]
        else:
            meta.pop("team", None)
        if verifier is not None:
            meta.update(
                claimSecretSha256=verifier,
                provisioningId=body["newProvisioning"]["provisioningId"],
                currentProvisioning=body["newProvisioning"],
            )
            meta.pop("transferPermit", None)
        self.owner._save_meta(meta)
        ack = protocol.sign_response(
            self.owner,
            "checkpoint",
            {
                "context": self.owner._context(meta),
                "eventDigest": digest,
                "authorizationVersion": meta["authorizationVersion"],
            },
            now,
        )
        self.db.execute(
            "INSERT INTO ledger_events VALUES (?,?,?,?,?)",
            (event["sequence"], digest, wire.canonical(event).decode("ascii"), ack, ack),
        )
        self.db.execute("UPDATE requests SET state='expired' WHERE state='pending'")
        self.ledger.maintenance(now, restart=True)
        self.db.execute(
            "DELETE FROM challenges WHERE kind NOT LIKE 'read-v2-auth:%' AND kind NOT LIKE 'mutation-v2-auth:%'"
        )
        self.owner._observe_commit()
        return ack

    def mark_started(self, transfer_id, handle, now):
        with self.owner._transaction(now) as meta:
            need(self.provider is not None, "LOCAL_TRUST_OPERATION_UNAVAILABLE")
            saved = self._saved_transfer(transfer_id)
            result = self.provider.verify_started(
                self.ownership_context(self.ledger.snapshot(meta)),
                saved["mutation"],
                saved["transferPlan"],
                handle,
                now,
            )
            evidence._fields(result, {"resetEvidenceDigest", "scopeManifestDigest"})
            need(result["scopeManifestDigest"] == saved["mutation"]["args"]["scopeManifestDigest"])
            body = {"transferId": transfer_id, **result}
            existing = self._existing("ownership.erase-started", transfer_id)
            if existing:
                need(
                    {
                        key: value
                        for key, value in json.loads(existing["value"])["body"].items()
                        if key != "delta"
                    }
                    == body,
                    "LOCAL_TRUST_REQUEST_CONFLICT",
                )
                return existing["ack"]
            return self._commit(meta, "ownership.erase-started", body, now)

    def complete(self, transfer_id, erase_handle, delivery_handle, now):
        with self.owner._transaction(now) as meta:
            need(self.provider is not None, "LOCAL_TRUST_OPERATION_UNAVAILABLE")
            saved = self._saved_transfer(transfer_id)
            result = self.provider.verify_completed(
                self.ownership_context(self.ledger.snapshot(meta)),
                saved["mutation"],
                saved["transferPlan"],
                erase_handle,
                delivery_handle,
                now,
            )
            evidence._fields(
                result,
                {
                    "resetEvidenceDigest",
                    "scopeManifestDigest",
                    "preparedDeliveryDigest",
                    "newProvisioning",
                    "credentialVerifier",
                },
            )
            provisioning(result["newProvisioning"], self.owner.bundle)
            need(
                result["scopeManifestDigest"] == saved["mutation"]["args"]["scopeManifestDigest"]
                and credential_commitment(result["newProvisioning"], result["credentialVerifier"])
                == result["newProvisioning"]["credentialCommitment"]
            )
            body = {
                "transferId": transfer_id,
                **{key: value for key, value in result.items() if key != "credentialVerifier"},
            }
            existing = self._existing("ownership.redelivery-ready", transfer_id)
            if existing:
                need(
                    {
                        key: value
                        for key, value in json.loads(existing["value"])["body"].items()
                        if key != "delta"
                    }
                    == body,
                    "LOCAL_TRUST_REQUEST_CONFLICT",
                )
                return existing["ack"]
            need(
                not self.db.execute(
                    "SELECT 1 FROM ledger_events WHERE json_extract(value,'$.body.newProvisioning.provisioningId')=?",
                    (body["newProvisioning"]["provisioningId"],),
                ).fetchone(),
                "LOCAL_TRUST_REQUEST_CONFLICT",
            )
            return self._commit(
                meta, "ownership.redelivery-ready", body, now, verifier=result["credentialVerifier"]
            )
