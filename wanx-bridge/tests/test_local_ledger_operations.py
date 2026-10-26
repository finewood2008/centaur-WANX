import hashlib
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace

import pytest
from test_local_ledger import (
    NOW,
    activate,
    commit,
    new_material,
    prepare,
    read,
    verified,
)
from test_local_ledger import (
    ledger as _ledger,
)
from test_local_ledger import (
    provisioned as _provisioned,
)

from wanx_bridge import local_authority_store as store
from wanx_bridge import local_ledger_operations as operations
from wanx_bridge import local_ledger_protocol as protocol
from wanx_bridge import local_management_protocol as wire
from wanx_bridge import local_trust_protocol as evidence

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Private authority requires POSIX")


@pytest.fixture
def provisioned(tmp_path):
    return _provisioned.__wrapped__(tmp_path)


@pytest.fixture
def ledger(provisioned):
    yield from _ledger.__wrapped__(provisioned)


class SyntheticProvider:
    """Test only. Production adapter must check actual immutable OS journals."""

    def __init__(self):
        self.reject = False

    def prepare(self, mutation, authorization, now):
        return {
            "schemaVersion": 1,
            "backupId": wire.digest({"requestId": mutation["requestId"]}),
            "scopeDigest": wire.digest({"resources": mutation["args"]["resourceIds"]}),
            "sourceBoxKey": None,
            "sourceHeader": None,
            "sourceProof": None,
            "plan": {"fixture": "synthetic-no-real-files"},
        }

    def validate_phase(self, plan, status, proof, now):
        if self.reject:
            raise evidence.BindingProtocolError("FIXTURE_JOURNAL_REJECTED")

    def validate_source(self, plan, status, header, payload, now):
        if self.reject:
            raise evidence.BindingProtocolError("FIXTURE_JOURNAL_REJECTED")


@pytest.fixture
def job(ledger):
    activate(ledger)
    signing, recovery = new_material(1)
    setup = prepare(
        ledger,
        "recovery.setup",
        {"expectedRecoveryVersion": 0, "newRecovery": recovery},
        now=NOW + 11,
    )
    commit(ledger, setup, material=signing, now=NOW + 11)
    provider = SyntheticProvider()
    ledger.authority.configure_operation_provider(provider)
    review = prepare(
        ledger,
        "backup.create",
        {
            "scopeProfile": "fixture-v1",
            "resourceIds": ["space:personal"],
            "expectedRecoveryVersion": 1,
            "recipientKeyThumbprint": wire.digest(recovery["backupKey"]),
            "targetId": "target:fixture",
            "includeBusinessSecrets": False,
        },
        now=NOW + 12,
    )
    ack, _ = commit(ledger, review, now=NOW + 12)
    identifier = verified(ledger, ack, "mutation-ack")["result"]["operationId"]
    return SimpleNamespace(
        ledger=ledger, provider=provider, identifier=identifier, recovery=recovery
    )


def test_backup_requires_provider_and_current_recovery_recipient(ledger):
    activate(ledger)
    signing, material = new_material(1)
    setup = prepare(
        ledger,
        "recovery.setup",
        {"expectedRecoveryVersion": 0, "newRecovery": material},
        now=NOW + 11,
    )
    commit(ledger, setup, material=signing, now=NOW + 11)
    with pytest.raises(evidence.BindingProtocolError, match="OPERATION_UNAVAILABLE"):
        prepare(
            ledger,
            "backup.create",
            {
                "scopeProfile": "fixture-v1",
                "resourceIds": ["space:personal"],
                "expectedRecoveryVersion": 1,
                "recipientKeyThumbprint": wire.digest(material["backupKey"]),
                "targetId": "target:fixture",
                "includeBusinessSecrets": False,
            },
            now=NOW + 12,
        )


def test_worker_cas_expiry_and_restart_never_create_parallel_attempts(job):
    ledger = job.ledger
    claim = ledger.authority.claim_operation(job.identifier, 1, 1, NOW + 13)
    assert verified(ledger, claim["status"], "operation-status")["status"]["stateVersion"] == 2
    with pytest.raises(evidence.BindingProtocolError, match="OPERATION_BUSY"):
        ledger.authority.claim_operation(job.identifier, 1, 2, NOW + 14)
    with pytest.raises(evidence.BindingProtocolError, match="OPERATION_PHASE_INVALID"):
        ledger.authority.operation_transition(
            claim["permit"],
            {"phase": "complete", "errorCode": None, "recoveryRequired": False, "result": None},
            1,
            2,
            NOW + 14,
        )
    ledger.authority.close()
    ledger.authority = store.LocalTrustAuthority(
        ledger.provisioned.directory, boot_id="worker:new-generation"
    )
    ledger.authority.configure_operation_provider(job.provider)
    renewed = ledger.authority.claim_operation(job.identifier, 1, 2, NOW + 15)
    status = verified(ledger, renewed["status"], "operation-status")["status"]
    assert status["attempt"] == 2 and status["stateVersion"] == 3
    with pytest.raises(evidence.BindingProtocolError, match="OPERATION_CONFLICT"):
        ledger.authority.operation_transition(
            claim["permit"],
            {"phase": "quiescing", "errorCode": None, "recoveryRequired": False, "result": None},
            1,
            2,
            NOW + 15,
        )


def test_rotation_between_snapshot_and_publication_invalidates_worker(job):
    ledger = job.ledger
    claim = ledger.authority.claim_operation(job.identifier, 1, 1, NOW + 13)
    signing, material = new_material(2)
    rotation = prepare(
        ledger,
        "recovery.rotate",
        {"expectedRecoveryVersion": 1, "newRecovery": material},
        now=NOW + 14,
    )
    commit(ledger, rotation, material=signing, now=NOW + 14)
    effect = ledger.authority.get_effect_commit(rotation["mutation"]["requestId"])
    assert effect["affectedJobsComplete"] is True
    assert effect["affectedJobs"] == [
        {
            "operationId": job.identifier,
            "attempt": 1,
            "stateVersion": 2,
            "bindingId": ledger.root.binding_id,
            "principalId": ledger.root.payload["principalId"],
            "ownershipEpoch": 1,
            "authorizationVersion": verified(
                ledger, ledger.authority._v2()._mutation(job.identifier)["ack"], "mutation-ack"
            )["authorizationVersion"],
        }
    ]
    with pytest.raises(evidence.BindingProtocolError, match="RECOVERY_VERSION_MISMATCH"):
        ledger.authority.operation_transition(
            claim["permit"],
            {"phase": "quiescing", "errorCode": None, "recoveryRequired": False, "result": None},
            1,
            2,
            NOW + 15,
        )
    assert (
        read(ledger, "operation-status", request_id=job.identifier, now=NOW + 15)["status"]["state"]
        == "running"
    )


def test_publication_guard_fences_an_independent_authority_connection(job):
    ledger = job.ledger
    claim = ledger.authority.claim_operation(job.identifier, 1, 1, NOW + 13)
    signing, material = new_material(2)
    rotation = prepare(
        ledger,
        "recovery.rotate",
        {"expectedRecoveryVersion": 1, "newRecovery": material},
        now=NOW + 14,
    )
    second = store.LocalTrustAuthority(
        ledger.provisioned.directory, boot_id=ledger.authority._boot_id
    )
    started, done = Event(), Event()

    def rotate():
        from types import SimpleNamespace

        started.set()
        commit(
            SimpleNamespace(authority=second, root=ledger.root, provisioned=ledger.provisioned),
            rotation,
            material=signing,
            now=NOW + 14,
        )
        done.set()

    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            with ledger.authority.operation_publication_guard(
                claim["permit"], 1, 2, NOW + 14
            ) as checked:
                assert checked["status"]["operationId"] == job.identifier
                future = pool.submit(rotate)
                assert started.wait(1)
                assert not done.wait(0.05)
            future.result(timeout=5)
        with pytest.raises(evidence.BindingProtocolError, match="RECOVERY_VERSION_MISMATCH"):
            ledger.authority.check_operation_current(claim["permit"], 1, 2, NOW + 15)
    finally:
        second.close()


def test_readonly_worker_checker_and_reservation_status_require_current_attempt(job):
    ledger = job.ledger
    assert ledger.authority.operation_reservation_state(wire.digest("unknown")) is None
    status = ledger.authority.operation_reservation_state(job.identifier)
    assert status["state"] == "queued"
    status["state"] = "completed"
    assert ledger.authority.operation_reservation_state(job.identifier)["state"] == "queued"
    claim = ledger.authority.claim_operation(job.identifier, 1, 1, NOW + 13)
    db = sqlite3.connect(
        f"file:{ledger.provisioned.directory / 'local-authority.sqlite3'}?mode=ro", uri=True
    )
    db.row_factory = sqlite3.Row
    try:
        with pytest.raises(evidence.BindingProtocolError, match="STATE_INVALID"):
            operations.verify_worker_permit_readonly(
                db, ledger.provisioned.bundle, claim["permit"], NOW + 13
            )
        db.execute("BEGIN")
        checked = operations.verify_worker_permit_readonly(
            db, ledger.provisioned.bundle, claim["permit"], NOW + 13
        )
        assert checked["status"]["attempt"] == 1
        db.rollback()
        signing, material = new_material(2)
        rotation = prepare(
            ledger,
            "recovery.rotate",
            {"expectedRecoveryVersion": 1, "newRecovery": material},
            now=NOW + 14,
        )
        commit(ledger, rotation, material=signing, now=NOW + 14)
        db.execute("BEGIN")
        with pytest.raises(evidence.BindingProtocolError, match="RECOVERY_VERSION_MISMATCH"):
            operations.verify_worker_permit_readonly(
                db, ledger.provisioned.bundle, claim["permit"], NOW + 14
            )
    finally:
        db.close()


def test_provider_failure_rolls_back_phase_and_completed_status_requires_signed_source(job):
    ledger = job.ledger
    claim = ledger.authority.claim_operation(job.identifier, 1, 1, NOW + 13)
    job.provider.reject = True
    with pytest.raises(evidence.BindingProtocolError, match="FIXTURE_JOURNAL_REJECTED"):
        ledger.authority.operation_transition(
            claim["permit"],
            {"phase": "quiescing", "errorCode": None, "recoveryRequired": False, "result": None},
            1,
            2,
            NOW + 14,
        )
    assert (
        read(ledger, "operation-status", request_id=job.identifier, now=NOW + 14)["status"][
            "stateVersion"
        ]
        == 2
    )
    job.provider.reject = False
    version = 2
    for phase in ("quiescing", "snapshotting", "encrypting", "staged", "publishing"):
        response = ledger.authority.operation_transition(
            claim["permit"],
            {"phase": phase, "errorCode": None, "recoveryRequired": False, "result": None},
            1,
            version,
            NOW + 15,
        )
        version = verified(ledger, response, "operation-status")["status"]["stateVersion"]
    result = {
        "type": "backup-created",
        "operationId": job.identifier,
        "backupId": claim["plan"]["backupId"],
        "archiveSha256": wire.digest("archive"),
        "manifestSha256": wire.digest("manifest"),
        "scopeProfile": "fixture-v1",
        "resourceIds": ["space:personal"],
        "recoveryId": job.recovery["recoveryId"],
        "recoveryVersion": 1,
        "recipientKeyThumbprint": wire.digest(job.recovery["backupKey"]),
        "targetId": "target:fixture",
        "bytes": 1234,
        "completedAt": NOW + 16,
        "targetDurable": True,
    }
    with pytest.raises(evidence.BindingProtocolError, match="OPERATION_DENIED"):
        ledger.authority.operation_transition(
            claim["permit"],
            {"phase": "complete", "errorCode": None, "recoveryRequired": False, "result": result},
            1,
            version,
            NOW + 16,
        )


def test_source_signing_is_bound_to_admitted_job_current_material_and_real_provider(job):
    ledger = job.ledger
    claim = ledger.authority.claim_operation(job.identifier, 1, 1, NOW + 13)
    version = 2
    for phase in ("quiescing", "snapshotting", "encrypting"):
        response = ledger.authority.operation_transition(
            claim["permit"],
            {"phase": phase, "errorCode": None, "recoveryRequired": False, "result": None},
            1,
            version,
            NOW + 14,
        )
        version = verified(ledger, response, "operation-status")["status"]["stateVersion"]
    header = {
        "schemaVersion": 1,
        "format": "centuarai-business-backup-v1",
        "backupId": claim["plan"]["backupId"],
        "sourceBoxId": "box:test",
        "sourceBoxKeyThumbprint": evidence.public_key_thumbprint(
            ledger.provisioned.bundle["boxKey"]
        ),
        "sourceOwnershipEpoch": 1,
        "principalId": ledger.root.payload["principalId"],
        "principalSecurityVersion": 1,
        "recoveryId": job.recovery["recoveryId"],
        "recoveryVersion": 1,
        "sourceRecoverySigningKey": job.recovery["signingKey"],
        "recipientKeyThumbprint": wire.digest(job.recovery["backupKey"]),
        "createdAt": NOW + 14,
        "scopeProfile": "fixture-v1",
        "scopeDigest": claim["plan"]["scopeDigest"],
        "wrapAlgorithm": "RSA-OAEP-256",
        "wrappedDataKey": evidence._encode(bytes(384)),
        "cipher": "A256GCM",
        "noncePrefix": evidence._encode(bytes(4)),
        "chunkSize": 1048576,
        "chunkCount": 1,
        "plaintextBytes": 20,
        "manifestBytes": 20,
        "manifestSha256": wire.digest("manifest"),
    }
    payload = {
        "schemaVersion": 1,
        "purpose": "centuarai.business-backup",
        "boxId": "box:test",
        "boxKeyThumbprint": header["sourceBoxKeyThumbprint"],
        "backupId": header["backupId"],
        "headerSha256": wire.digest(header),
        "ciphertextSha256": wire.digest("ciphertext"),
        "ciphertextBytes": 40,
        "manifestSha256": header["manifestSha256"],
        "scopeDigest": header["scopeDigest"],
        "createdAt": NOW + 14,
    }
    signed = ledger.authority.sign_backup_source(
        claim["permit"], header, payload, 1, version, NOW + 14
    )
    assert wire._decode(signed, operations.SOURCE_TYPE, operations.source_payload) == payload
    wrong = {**payload, "backupId": wire.digest("another")}
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.sign_backup_source(claim["permit"], header, wrong, 1, version, NOW + 14)
    for phase in ("staged", "publishing"):
        response = ledger.authority.operation_transition(
            claim["permit"],
            {"phase": phase, "errorCode": None, "recoveryRequired": False, "result": None},
            1,
            version,
            NOW + 15,
        )
        version = verified(ledger, response, "operation-status")["status"]["stateVersion"]
    result = {
        "type": "backup-created",
        "operationId": job.identifier,
        "backupId": header["backupId"],
        "archiveSha256": wire.digest("archive"),
        "manifestSha256": header["manifestSha256"],
        "scopeProfile": "fixture-v1",
        "resourceIds": ["space:personal"],
        "recoveryId": job.recovery["recoveryId"],
        "recoveryVersion": 1,
        "recipientKeyThumbprint": header["recipientKeyThumbprint"],
        "targetId": "target:fixture",
        "bytes": 1234,
        "completedAt": NOW + 16,
        "targetDurable": True,
    }
    completed = ledger.authority.operation_transition(
        claim["permit"],
        {"phase": "complete", "errorCode": None, "recoveryRequired": False, "result": result},
        1,
        version,
        NOW + 16,
    )
    assert verified(ledger, completed, "operation-status")["status"]["state"] == "completed"
    ledger.authority.close()
    ledger.authority = store.LocalTrustAuthority(
        ledger.provisioned.directory, boot_id="worker:completed-restart"
    )
    assert (
        read(ledger, "operation-status", request_id=job.identifier, now=NOW + 17)["status"][
            "result"
        ]
        == result
    )


def test_restore_key_is_fresh_original_actor_bound_and_never_persisted(job):
    import sqlite3

    from cryptography.hazmat.primitives.asymmetric import ec
    from test_local_ledger import actor

    ledger = job.ledger
    source_key = ec.generate_private_key(ec.SECP256R1())
    old_signing, old_material = new_material(7)
    backup_id = wire.digest("source-backup")
    header = {
        "schemaVersion": 1,
        "format": "centuarai-business-backup-v1",
        "backupId": backup_id,
        "sourceBoxId": "box:source",
        "sourceBoxKeyThumbprint": evidence.public_key_thumbprint(wire.public_jwk(source_key)),
        "sourceOwnershipEpoch": 3,
        "principalId": "principal:source",
        "principalSecurityVersion": 4,
        "recoveryId": old_material["recoveryId"],
        "recoveryVersion": 7,
        "sourceRecoverySigningKey": old_material["signingKey"],
        "recipientKeyThumbprint": wire.digest(old_material["backupKey"]),
        "createdAt": NOW,
        "scopeProfile": "fixture-v1",
        "scopeDigest": wire.digest("source-scope"),
        "wrapAlgorithm": "RSA-OAEP-256",
        "wrappedDataKey": evidence._encode(bytes(384)),
        "cipher": "A256GCM",
        "noncePrefix": evidence._encode(bytes(4)),
        "chunkSize": 1048576,
        "chunkCount": 1,
        "plaintextBytes": 20,
        "manifestBytes": 20,
        "manifestSha256": wire.digest("source-manifest"),
    }
    source_payload = {
        "schemaVersion": 1,
        "purpose": "centuarai.business-backup",
        "boxId": "box:source",
        "boxKeyThumbprint": header["sourceBoxKeyThumbprint"],
        "backupId": backup_id,
        "headerSha256": wire.digest(header),
        "ciphertextSha256": wire.digest("ciphertext"),
        "ciphertextBytes": 40,
        "manifestSha256": header["manifestSha256"],
        "scopeDigest": header["scopeDigest"],
        "createdAt": NOW,
    }
    source_proof = wire._sign(
        source_payload, source_key, operations.SOURCE_TYPE, operations.source_payload
    )

    class RestoreProvider(SyntheticProvider):
        received = None

        def prepare(self, mutation, authorization, now):
            return {
                "schemaVersion": 1,
                "backupId": backup_id,
                "scopeDigest": wire.digest("target-scope"),
                "sourceBoxKey": wire.public_jwk(source_key),
                "sourceHeader": header,
                "sourceProof": source_proof,
                "plan": {"fixture": "immutable-source"},
            }

        def receive_restore_key(self, plan, operation_id, key, now):
            self.received = (operation_id, key)

    provider = RestoreProvider()
    ledger.authority.configure_operation_provider(provider)
    args = {
        "backupId": backup_id,
        "archiveSha256": wire.digest("source-archive"),
        "sourceBoxKeyThumbprint": header["sourceBoxKeyThumbprint"],
        "manifestSha256": header["manifestSha256"],
        "targetDescriptorDigest": wire.digest("current-target"),
        "scopeProfile": "fixture-v1",
        "resourceIds": ["space:personal"],
        "ownerMapping": [
            {
                "sourcePrincipalId": "principal:source",
                "targetPrincipalId": ledger.root.payload["principalId"],
                "resourceIds": ["space:personal"],
            }
        ],
        "sourceId": "source:registered",
    }
    review = prepare(ledger, "backup.restore", args, now=NOW + 13)
    value = review["mutation"]
    ledger.authority.commit_mutation(
        protocol.sign_mutation(value, ledger.root.approval),
        None,
        None,
        None,
        protocol.sign_mutation(value, old_signing, purpose="source-recovery"),
        NOW + 13,
    )
    challenge = verified(ledger, ledger.authority.auth_challenge_v2(NOW + 14), "read-challenge")
    raw = os.urandom(32)
    encoded = evidence._encode(raw)
    key_proof = {
        "schemaVersion": 1,
        "purpose": "centuarai.local-restore.key",
        "boxId": "box:test",
        "boxKeyThumbprint": challenge["context"]["boxKeyThumbprint"],
        "ownershipEpoch": 1,
        "principalSecurityVersion": 1,
        "operationId": value["requestId"],
        "archiveSha256": args["archiveSha256"],
        "dataKeySha256": evidence._encode(hashlib.sha256(raw).digest()),
        "nonce": challenge["nonce"],
        "issuedAt": NOW + 14,
        "expiresAt": NOW + 74,
        "actor": actor(ledger.root),
    }
    proof = wire._sign(
        key_proof, ledger.root.access, operations.RESTORE_KEY_TYPE, operations.restore_key_schema
    )
    with pytest.raises(evidence.BindingProtocolError, match="CONTEXT_MISMATCH"):
        ledger.authority.receive_restore_key(
            value["requestId"],
            args["archiveSha256"],
            evidence._encode(os.urandom(32)),
            proof,
            NOW + 14,
        )
    connection = ledger.authority._db

    class CommitFailure:
        def __getattr__(self, name):
            return getattr(connection, name)

        def commit(self):
            raise sqlite3.OperationalError("synthetic commit failure")

    ledger.authority._db = CommitFailure()
    try:
        with pytest.raises(sqlite3.OperationalError, match="synthetic commit failure"):
            ledger.authority.receive_restore_key(
                value["requestId"], args["archiveSha256"], encoded, proof, NOW + 14
            )
        assert provider.received is None
    finally:
        ledger.authority._db = connection
    received = ledger.authority.receive_restore_key(
        value["requestId"], args["archiveSha256"], encoded, proof, NOW + 14
    )
    assert verified(ledger, received, "restore-key-received")["operationId"] == value["requestId"]
    assert provider.received == (value["requestId"], raw)
    with pytest.raises(evidence.BindingProtocolError, match="CHALLENGE_INVALID"):
        ledger.authority.receive_restore_key(
            value["requestId"], args["archiveSha256"], encoded, proof, NOW + 14
        )
    dump = "\n".join(ledger.authority._db.iterdump())
    assert encoded not in dump and proof not in dump
