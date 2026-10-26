import hashlib
import os
import sqlite3

import pytest
from test_local_authority_store import new_root, root_proofs
from test_local_ledger import NOW, activate, commit, prepare, read, verified
from test_local_ledger import ledger as _ledger
from test_local_ledger import provisioned as _provisioned

from wanx_bridge import local_authority_store as store
from wanx_bridge import local_ledger_operations as operations
from wanx_bridge import local_ledger_protocol as protocol
from wanx_bridge import local_ledger_transfer as transfer
from wanx_bridge import local_management_protocol as wire
from wanx_bridge import local_trust_protocol as evidence

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Private authority requires POSIX")


@pytest.fixture
def provisioned(tmp_path):
    return _provisioned.__wrapped__(tmp_path)


@pytest.fixture
def ledger(provisioned):
    yield from _ledger.__wrapped__(provisioned)


class SyntheticOS:
    """No real reset: explicit fixture handles stand in for OS signed receipts."""

    def __init__(self, bundle):
        self.bundle = bundle
        self.verifier = evidence._encode(hashlib.sha256(os.urandom(32)).digest())
        self.provisioning = {
            "provisioningId": evidence._encode(os.urandom(32)),
            "ownershipEpoch": 2,
            "boxKeyThumbprint": evidence.public_key_thumbprint(bundle["boxKey"]),
            "tlsSpkiSha256": bundle["tlsSpkiSha256"],
            "credentialCommitment": "",
        }
        self.provisioning["credentialCommitment"] = transfer.credential_commitment(
            self.provisioning, self.verifier
        )

    def prepare(self, mutation, ownership, now):
        return {
            "scopeManifestDigest": mutation["args"]["scopeManifestDigest"],
            "resetPlanDigest": wire.digest("fixture-reset-plan"),
        }

    def verify_started(self, ownership, mutation, plan, handle, now):
        evidence._require(handle == "fixture:valid-plan", "FIXTURE_OS_DENIED")
        return {
            "resetEvidenceDigest": wire.digest("fixture-started"),
            "scopeManifestDigest": plan["scopeManifestDigest"],
        }

    def verify_completed(self, ownership, mutation, plan, erase_handle, delivery_handle, now):
        evidence._require(
            erase_handle == "fixture:full-erase-data-empty"
            and delivery_handle == "fixture:durable-private-delivery",
            "FIXTURE_OS_DENIED",
        )
        return {
            "resetEvidenceDigest": wire.digest("fixture-complete"),
            "scopeManifestDigest": plan["scopeManifestDigest"],
            "preparedDeliveryDigest": wire.digest("fixture-delivery"),
            "newProvisioning": self.provisioning.copy(),
            "credentialVerifier": self.verifier,
        }


def transfer_args(ledger):
    return {
        "transferId": evidence._encode(os.urandom(32)),
        "dataDisposition": "erase-local",
        "expectedOwnerPrincipalId": ledger.root.payload["principalId"],
        "scopeManifestDigest": wire.digest("fixture-actual-scope"),
        "retainedIndependentBackups": True,
    }


def test_transfer_is_unavailable_without_independent_os_scope_provider(ledger):
    activate(ledger)
    with pytest.raises(evidence.BindingProtocolError, match="OPERATION_UNAVAILABLE"):
        prepare(ledger, "ownership.transfer-prepare", transfer_args(ledger), now=NOW + 11)


def test_freeze_verified_erase_delivery_and_new_root_share_one_ledger_and_key_history(ledger):
    activate(ledger)
    os_provider = SyntheticOS(ledger.provisioned.bundle)
    ledger.authority.configure_transfer_provider(os_provider)
    args = transfer_args(ledger)
    review = prepare(ledger, "ownership.transfer-prepare", args, now=NOW + 11)
    freeze_ack, proofs = commit(ledger, review, now=NOW + 11)
    assert verified(ledger, freeze_ack, "mutation-ack")["ownershipState"] == "transfer_frozen"
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.get_authorization(ledger.root.binding_id, NOW + 12)
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.first_root_challenge(NOW + 12)
    with pytest.raises(evidence.BindingProtocolError, match="FIXTURE_OS_DENIED"):
        ledger.authority.mark_erase_started(args["transferId"], "identity-only", NOW + 12)
    started = ledger.authority.mark_erase_started(
        args["transferId"], "fixture:valid-plan", NOW + 12
    )
    assert verified(ledger, started, "checkpoint")["context"]["ownershipEpoch"] == 1
    with pytest.raises(evidence.BindingProtocolError, match="FIXTURE_OS_DENIED"):
        ledger.authority.complete_verified_redelivery(
            args["transferId"], "fixture:full-erase-data-empty", "not-persisted", NOW + 13
        )
    ready = ledger.authority.complete_verified_redelivery(
        args["transferId"],
        "fixture:full-erase-data-empty",
        "fixture:durable-private-delivery",
        NOW + 13,
    )
    assert verified(ledger, ready, "checkpoint")["context"]["ownershipEpoch"] == 2
    assert ledger.authority.commit_mutation(*proofs, NOW + 13) == freeze_ack
    ledger.authority.close()
    ledger.authority = store.LocalTrustAuthority(
        ledger.provisioned.directory, boot_id="transfer:ready-restart"
    )
    ledger.authority.configure_transfer_provider(os_provider)
    assert (
        ledger.authority.complete_verified_redelivery(
            args["transferId"],
            "fixture:full-erase-data-empty",
            "fixture:durable-private-delivery",
            NOW + 14,
        )
        == ready
    )
    next_root = new_root(ledger.provisioned, ledger.authority, NOW + 15)
    next_root.payload["principalId"] = "principal:new-owner"
    wrong_old_secret = root_proofs(ledger.provisioned, next_root)
    with pytest.raises(evidence.BindingProtocolError, match="SIGNATURE_INVALID"):
        ledger.authority.commit_first_root(*wrong_old_secret, NOW + 15)
    right_secret = wire.sign_first_root_secret(
        next_root.payload, evidence._decode(os_provider.verifier, 32)
    )
    ack = ledger.authority.commit_first_root(
        wrong_old_secret[0], wrong_old_secret[1], right_secret, NOW + 15
    )
    assert (
        wire.verify_response(
            ack, ledger.provisioned.bundle["boxKey"], box_id="box:test", kind="binding-ack"
        )["body"]["ownershipEpoch"]
        == 2
    )
    ledger.authority.close()
    ledger.authority = store.LocalTrustAuthority(
        ledger.provisioned.directory, boot_id="transfer:new-owner-restart"
    )
    historical = read(ledger, "self-binding", now=NOW + 16)
    assert (
        historical["status"] == "revoked"
        and historical["bindingOwnershipEpoch"] == 1
        and historical["currentContext"]["ownershipEpoch"] == 2
    )
    assert ledger.authority.bundle["ownershipEpoch"] == 1
    assert ledger.authority._meta()["claimSecretSha256"] is None


def test_transfer_status_is_original_actor_fresh_audit_of_archived_events(ledger):
    activate(ledger)
    provider = SyntheticOS(ledger.provisioned.bundle)
    ledger.authority.configure_transfer_provider(provider)
    args = transfer_args(ledger)
    review = prepare(ledger, "ownership.transfer-prepare", args, now=NOW + 11)
    commit(ledger, review, now=NOW + 11)
    request_id = review["mutation"]["requestId"]
    frozen = read(ledger, "transfer-status", request_id=request_id, now=NOW + 12)
    assert frozen["state"] == "frozen" and frozen["resetEvidenceDigest"] is None
    assert frozen["checkpoint"]["context"]["ownershipEpoch"] == 1
    with pytest.raises(evidence.BindingProtocolError, match="READ_DENIED"):
        read(ledger, "transfer-status", request_id=request_id, device=ledger.use, now=NOW + 12)
    with pytest.raises(evidence.BindingProtocolError, match="READ_DENIED"):
        read(ledger, "transfer-status", request_id=wire.digest("unrelated"), now=NOW + 12)
    ledger.authority.mark_erase_started(args["transferId"], "fixture:valid-plan", NOW + 13)
    pending = read(ledger, "transfer-status", request_id=request_id, now=NOW + 13)
    assert pending["state"] == "erase_pending" and pending["resetEvidenceDigest"] is not None
    ledger.authority.complete_verified_redelivery(
        args["transferId"],
        "fixture:full-erase-data-empty",
        "fixture:durable-private-delivery",
        NOW + 14,
    )
    ready = read(ledger, "transfer-status", request_id=request_id, now=NOW + 15)
    assert ready["state"] == "redelivery_ready" and ready["preparedDeliveryDigest"] is not None
    assert (
        ready["sourceOwnershipEpoch"] == 1 and ready["checkpoint"]["context"]["ownershipEpoch"] == 2
    )
    assert ready["updatedAt"] == NOW + 14
    assert set(ready) == {
        "requestId",
        "transferId",
        "state",
        "sourceOwnershipEpoch",
        "checkpoint",
        "updatedAt",
        "resetEvidenceDigest",
        "preparedDeliveryDigest",
    }
    challenge = verified(ledger, ledger.authority.auth_challenge_v2(NOW + 15), "read-challenge")
    payload = {
        "schemaVersion": 2,
        "purpose": "centuarai.local-ledger.read",
        "boxId": "box:test",
        "boxKeyThumbprint": challenge["context"]["boxKeyThumbprint"],
        "ownershipEpoch": 2,
        "nonce": challenge["nonce"],
        "issuedAt": NOW + 15,
        "expiresAt": NOW + 60,
        "actor": review["mutation"]["actor"],
        "operation": "transfer-status",
        "requestId": request_id,
        "bindingId": None,
    }
    proof = protocol.sign_read(payload, ledger.root.access)
    ledger.authority.read_v2(proof, NOW + 15)
    with pytest.raises(evidence.BindingProtocolError, match="READ_DENIED"):
        ledger.authority.read_v2(proof, NOW + 15)
    ledger.authority.close()
    ledger.authority = store.LocalTrustAuthority(
        ledger.provisioned.directory, boot_id="transfer:status-restart"
    )
    assert read(ledger, "transfer-status", request_id=request_id, now=NOW + 16) == ready


def test_transfer_permit_is_readonly_verifiable_during_frozen_and_erase_pending(ledger):
    activate(ledger)
    provider = SyntheticOS(ledger.provisioned.bundle)
    ledger.authority.configure_transfer_provider(provider)
    args = transfer_args(ledger)
    review = prepare(ledger, "ownership.transfer-prepare", args, now=NOW + 11)
    commit(ledger, review, now=NOW + 11)
    proof = ledger.authority.transfer_worker_permit(args["transferId"], NOW + 12)
    db = sqlite3.connect(
        f"file:{ledger.provisioned.directory / 'local-authority.sqlite3'}?mode=ro", uri=True
    )
    db.row_factory = sqlite3.Row
    try:
        db.execute("BEGIN")
        checked = operations.verify_worker_permit_readonly(
            db, ledger.provisioned.bundle, proof, NOW + 12
        )
        assert checked["status"]["state"] == "transfer_frozen"
        db.rollback()
        ledger.authority.mark_erase_started(args["transferId"], "fixture:valid-plan", NOW + 13)
        assert ledger.authority.transfer_worker_permit(args["transferId"], NOW + 13) == proof
        db.execute("BEGIN")
        assert (
            operations.verify_worker_permit_readonly(
                db, ledger.provisioned.bundle, proof, NOW + 13
            )["status"]["state"]
            == "erase_pending"
        )
        db.rollback()
        ledger.authority.complete_verified_redelivery(
            args["transferId"],
            "fixture:full-erase-data-empty",
            "fixture:durable-private-delivery",
            NOW + 14,
        )
        db.execute("BEGIN")
        with pytest.raises(evidence.BindingProtocolError):
            operations.verify_worker_permit_readonly(db, ledger.provisioned.bundle, proof, NOW + 14)
    finally:
        db.close()


def test_wrong_credential_commitment_never_reopens_claim(ledger):
    activate(ledger)
    provider = SyntheticOS(ledger.provisioned.bundle)
    ledger.authority.configure_transfer_provider(provider)
    args = transfer_args(ledger)
    review = prepare(ledger, "ownership.transfer-prepare", args, now=NOW + 11)
    commit(ledger, review, now=NOW + 11)
    ledger.authority.mark_erase_started(args["transferId"], "fixture:valid-plan", NOW + 12)
    provider.verifier = evidence._encode(os.urandom(32))
    with pytest.raises(evidence.BindingProtocolError, match="ERASE_EVIDENCE_INVALID"):
        ledger.authority.complete_verified_redelivery(
            args["transferId"],
            "fixture:full-erase-data-empty",
            "fixture:durable-private-delivery",
            NOW + 13,
        )
    assert ledger.authority._meta()["ownership"]["state"] == "erase_pending"
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.first_root_challenge(NOW + 13)
