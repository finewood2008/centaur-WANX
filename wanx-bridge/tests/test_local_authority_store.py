import copy
import hashlib
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from wanx_bridge import local_authority_store as store
from wanx_bridge import local_management_protocol as wire
from wanx_bridge import local_trust_protocol as evidence
from wanx_bridge.local_trust_protocol import BindingProtocolError

pytestmark = pytest.mark.skipif(
    os.name != "posix", reason="Private authority filesystem requires POSIX"
)
NOW = 1792886400


def private(path, data):
    path.write_bytes(data)
    path.chmod(0o600)


@pytest.fixture
def provisioned(tmp_path):
    directory = tmp_path / "authority"
    directory.mkdir(mode=0o700)
    key = ec.generate_private_key(ec.SECP256R1())
    secret = b"synthetic fixture claim secret!!!"
    verifier = hashlib.sha256(secret).digest()
    bundle = {
        "schemaVersion": 1,
        "type": "centuarai-local-trust-private",
        "boxId": "box:test",
        "baseUrl": "https://127.0.0.1:9443",
        "boxKey": wire.public_jwk(key),
        "tlsSpkiSha256": evidence._encode(bytes(32)),
        "provisioningId": evidence._encode(b"p" * 32),
        "ownershipEpoch": 1,
        "grants": [{"resourceId": "space:personal", "actions": ["read", "write"]}],
        "claimSecretSha256": evidence._encode(verifier),
        "sourceEvidenceKind": "factory-clean",
        "sourceEvidenceSha256": evidence._encode(b"e" * 32),
    }
    private(directory / store.BUNDLE, wire.canonical(bundle))
    private(
        directory / store.KEY,
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ),
    )
    store.initialize_authority(directory, now=NOW)
    return SimpleNamespace(directory=directory, bundle=bundle, key=key, verifier=verifier)


@pytest.fixture
def authority(provisioned):
    authority = store.LocalTrustAuthority(provisioned.directory, boot_id="boot:one")
    yield authority
    authority.close()


def body(provisioned, proof, kind):
    return wire.verify_response(proof, provisioned.bundle["boxKey"], box_id="box:test", kind=kind)[
        "body"
    ]


def new_root(provisioned, authority, now=NOW):
    challenge = body(provisioned, authority.first_root_challenge(now), "first-root-challenge")
    access, approval = (ec.generate_private_key(ec.SECP256R1()) for _ in range(2))
    payload = {
        "schemaVersion": 1,
        "purpose": "centuarai.local-management.first-root",
        "boxId": "box:test",
        "boxKeyThumbprint": evidence.public_key_thumbprint(provisioned.bundle["boxKey"]),
        "provisioningId": challenge["provisioningId"],
        "ownershipEpoch": challenge["ownershipEpoch"],
        "challenge": challenge["challenge"],
        "requestId": evidence._encode(os.urandom(32)),
        "issuedAt": now,
        "expiresAt": now + 300,
        "principalId": "principal:independent",
        "clientId": "client:" + os.urandom(16).hex(),
        "accessKey": wire.public_jwk(access),
        "approvalKey": wire.public_jwk(approval),
        "grants": challenge["grants"],
        "grantExpiresAt": None,
        "keyProtection": "software-passphrase-v1",
    }
    return SimpleNamespace(payload=payload, access=access, approval=approval)


def root_proofs(provisioned, root):
    return (
        wire.sign_first_root(root.payload, root.access, purpose="access"),
        wire.sign_first_root(root.payload, root.approval, purpose="approval"),
        wire.sign_first_root_secret(root.payload, provisioned.verifier),
    )


def claim(provisioned, authority):
    root = new_root(provisioned, authority)
    root.ack = authority.commit_first_root(*root_proofs(provisioned, root), NOW)
    root.binding_id = body(provisioned, root.ack, "binding-ack")["bindingId"]
    return root


def read_proof(provisioned, authority, actor, now, request_id=None):
    challenge = body(provisioned, authority.auth_challenge(now), "auth-challenge")
    payload = {
        "schemaVersion": 1,
        "purpose": "centuarai.local-management.read",
        "boxId": "box:test",
        "boxKeyThumbprint": evidence.public_key_thumbprint(provisioned.bundle["boxKey"]),
        "ownershipEpoch": challenge["ownershipEpoch"],
        "nonce": challenge["nonce"],
        "issuedAt": now,
        "expiresAt": now + 60,
        "clientId": actor.payload["clientId"],
        "operation": "request" if request_id is not None else "state",
        "requestId": request_id,
    }
    return wire.sign_read_proof(payload, actor.access)


def new_request(provisioned, authority, root, now=NOW + 1):
    challenge = body(provisioned, authority.request_challenge(now), "binding-challenge")
    access = ec.generate_private_key(ec.SECP256R1())
    payload = {
        **challenge["context"],
        "schemaVersion": 1,
        "purpose": "centuarai.local-device-binding.request",
        "requestId": evidence._encode(os.urandom(32)),
        "challenge": challenge["challenge"],
        "issuedAt": now,
        "expiresAt": now + 300,
        "principalId": root.payload["principalId"],
        "clientId": "client:" + os.urandom(16).hex(),
        "accessKey": wire.public_jwk(access),
        "approvalKey": None,
        "role": "use",
        "grants": [{"resourceId": "space:personal", "actions": ["read"]}],
        "delegationAllowed": False,
        "grantExpiresAt": now + 5000,
    }
    return SimpleNamespace(payload=payload, access=access)


def submit(authority, request, now=NOW + 1):
    request.proof = evidence.sign_request(request.payload, request.access)
    return authority.submit_request(request.proof, now)


def approval_proof(root, request, now=NOW + 2):
    return evidence.sign_approval(
        {
            "schemaVersion": 1,
            "purpose": "centuarai.local-device-binding.approval",
            "requestDigest": evidence.request_digest(request.payload),
            "approverBindingId": root.binding_id,
            "approvalKeyVersion": 1,
            "approvedAt": now,
            "expiresAt": request.payload["expiresAt"],
        },
        root.approval,
    )


def cancel_proof(request, now=NOW + 2):
    return evidence.sign_cancel(
        {
            "schemaVersion": 1,
            "purpose": "centuarai.local-device-binding.cancel",
            "requestId": request.payload["requestId"],
            "requestDigest": evidence.request_digest(request.payload),
            "issuedAt": now,
            "expiresAt": now + 300,
        },
        request.access,
    )


def test_full_first_root_join_approve_fresh_read_and_saved_ack(provisioned, authority):
    root = claim(provisioned, authority)
    assert authority._meta()["claimSecretSha256"] is None
    first_ack = body(provisioned, root.ack, "binding-ack")
    assert first_ack["role"] == "manage" and first_ack["recoveryConfigured"] is False
    assert first_ack["requestDigest"] == wire.first_root_digest(root.payload)
    request = new_request(provisioned, authority, root)
    assert body(provisioned, submit(authority, request), "request-receipt")["state"] == "pending"
    approval = approval_proof(root, request)
    ack = authority.approve_request(request.payload["requestId"], approval, NOW + 2)
    assert body(provisioned, ack, "binding-ack")["rosterVersion"] == 2
    assert authority.approve_request(request.payload["requestId"], approval, NOW + 1000) == ack
    proof = read_proof(provisioned, authority, root, NOW + 1000)
    state = body(provisioned, authority.read_state(proof, NOW + 1000), "state")
    assert len(state["bindings"]) == 2
    use = next(row for row in state["bindings"] if row["role"] == "use")
    assert (
        use["approvalKey"] is None
        and use["delegableGrants"] == []
        and use["delegationExpiresAt"] is None
    )
    proof = read_proof(provisioned, authority, request, NOW + 1000, request.payload["requestId"])
    receipt = body(provisioned, authority.read_request(proof, NOW + 1000), "request")
    assert (
        receipt["state"] == "approved"
        and receipt["ack"] == ack
        and receipt["requestJws"] == request.proof
    )
    authority.close()
    reopened = store.LocalTrustAuthority(provisioned.directory, boot_id="boot:two")
    try:
        assert reopened.commit_first_root(*root_proofs(provisioned, root), NOW + 1001) == root.ack
        assert reopened.approve_request(request.payload["requestId"], approval, NOW + 1001) == ack
    finally:
        reopened.close()


def race(functions):
    barrier = Barrier(len(functions))

    def run(function):
        barrier.wait()
        try:
            return function()
        except BindingProtocolError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=len(functions)) as executor:
        return list(executor.map(run, functions))


@pytest.mark.parametrize("identical", [False, True])
def test_two_sqlite_connections_allow_only_one_first_root(provisioned, authority, identical):
    second = store.LocalTrustAuthority(provisioned.directory, boot_id="boot:one")
    one = new_root(provisioned, authority)
    two = one if identical else new_root(provisioned, second)
    try:
        p1, p2 = root_proofs(provisioned, one), root_proofs(provisioned, two)
        results = race(
            [
                lambda: authority.commit_first_root(*p1, NOW),
                lambda: second.commit_first_root(*p2, NOW),
            ]
        )
        successes = [value for value in results if value.count(".") == 2]
        assert len(successes) == (2 if identical else 1)
        if identical:
            assert successes[0] == successes[1]
        else:
            assert "LOCAL_TRUST_ALREADY_OWNED" in results
        assert authority._db.execute("SELECT COUNT(*) FROM bindings").fetchone()[0] == 1
        assert authority._db.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 1
    finally:
        second.close()


def test_approve_cancel_race_has_one_terminal_result_across_connections(provisioned, authority):
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    submit(authority, request)
    second = store.LocalTrustAuthority(provisioned.directory, boot_id="boot:one")
    try:
        approval, cancel = approval_proof(root, request), cancel_proof(request)
        results = race(
            [
                lambda: authority.approve_request(request.payload["requestId"], approval, NOW + 2),
                lambda: second.cancel_request(cancel, NOW + 2),
            ]
        )
        row = authority._existing(request.payload["requestId"])
        assert row["state"] in ("approved", "cancelled")
        count = authority._db.execute("SELECT COUNT(*) FROM bindings").fetchone()[0]
        assert count == (2 if row["state"] == "approved" else 1)
        assert authority._db.execute("SELECT COUNT(*) FROM events").fetchone()[0] == count
        assert any(result.count(".") == 2 for result in results)
        if row["state"] == "cancelled":
            assert "LOCAL_TRUST_REQUEST_TERMINAL" in results
    finally:
        second.close()


def test_two_connections_approve_same_request_return_identical_ack(provisioned, authority):
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    submit(authority, request)
    second = store.LocalTrustAuthority(provisioned.directory, boot_id="boot:one")
    try:
        approval = approval_proof(root, request)
        results = race(
            [
                lambda: authority.approve_request(request.payload["requestId"], approval, NOW + 2),
                lambda: second.approve_request(request.payload["requestId"], approval, NOW + 2),
            ]
        )
        assert results[0] == results[1] and results[0].count(".") == 2
        assert authority._db.execute("SELECT COUNT(*) FROM bindings").fetchone()[0] == 2
    finally:
        second.close()


def test_failed_signing_rolls_back_root_consumption_and_all_authority_writes(
    provisioned, authority, monkeypatch
):
    root = new_root(provisioned, authority)
    original = authority._signed

    def fail_ack(meta, kind, payload, now):
        if kind == "binding-ack":
            raise RuntimeError("synthetic signing failure")
        return original(meta, kind, payload, now)

    monkeypatch.setattr(authority, "_signed", fail_ack)
    with pytest.raises(RuntimeError, match="synthetic"):
        authority.commit_first_root(*root_proofs(provisioned, root), NOW)
    assert authority._meta()["claimSecretSha256"] == provisioned.bundle["claimSecretSha256"]
    for table in ("bindings", "keys", "requests", "events"):
        assert authority._db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] == 0
    assert authority._db.execute("SELECT consumed FROM challenges").fetchone()[0] is None
    monkeypatch.setattr(authority, "_signed", original)
    authority.commit_first_root(*root_proofs(provisioned, root), NOW)


@pytest.mark.parametrize(
    "change", ["wrong_secret", "wrong_grants", "epoch", "pin", "provisioning", "stolen_access"]
)
def test_root_failures_never_consume_credentials(provisioned, authority, change):
    root = new_root(provisioned, authority)
    if change == "wrong_grants":
        root.payload["grants"][0]["actions"] = ["read"]
    elif change == "epoch":
        root.payload["ownershipEpoch"] += 1
    elif change == "pin":
        root.payload["boxKeyThumbprint"] = evidence._encode(b"x" * 32)
    elif change == "provisioning":
        root.payload["provisioningId"] = evidence._encode(b"x" * 32)
    proofs = list(root_proofs(provisioned, root))
    if change == "wrong_secret":
        proofs[2] = wire.sign_first_root_secret(root.payload, b"x" * 32)
    if change == "stolen_access":
        proofs[1] = wire._sign(
            root.payload, root.access, wire.ROOT_APPROVAL, wire.validate_first_root
        )
    with pytest.raises(BindingProtocolError):
        authority.commit_first_root(*proofs, NOW + 1)
    assert authority._meta()["principalId"] is None
    assert authority._db.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0
    assert authority._db.execute("SELECT consumed FROM challenges").fetchone()[0] is None


def test_exact_root_retry_does_not_require_consumed_secret_but_does_require_both_keys(
    provisioned, authority
):
    root = claim(provisioned, authority)
    proofs = list(root_proofs(provisioned, root))
    proofs[2] = wire.sign_first_root_secret(root.payload, b"x" * 32)
    assert authority.commit_first_root(*proofs, NOW + 10000) == root.ack
    proofs[1] = wire._sign(root.payload, root.access, wire.ROOT_APPROVAL, wire.validate_first_root)
    with pytest.raises(BindingProtocolError, match="SIGNATURE_INVALID"):
        authority.commit_first_root(*proofs, NOW + 10000)


def test_request_id_conflict_does_not_expand_saved_root(provisioned, authority):
    root = claim(provisioned, authority)
    root.payload["clientId"] = "client:replacement"
    with pytest.raises(BindingProtocolError, match="REQUEST_CONFLICT"):
        authority.commit_first_root(*root_proofs(provisioned, root), NOW + 1)
    assert len(authority._bindings()) == 1


def test_read_nonce_is_single_use_and_proposal_proof_is_not_read_auth(provisioned, authority):
    root = claim(provisioned, authority)
    proof = read_proof(provisioned, authority, root, NOW + 1)
    authority.read_state(proof, NOW + 1)
    with pytest.raises(BindingProtocolError, match="READ_DENIED"):
        authority.read_state(proof, NOW + 1)
    with pytest.raises(BindingProtocolError):
        authority.read_state(root_proofs(provisioned, root)[0], NOW + 1)


def test_use_applicant_reads_own_request_but_not_state_other_request_or_root(
    provisioned, authority
):
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    submit(authority, request)
    other = new_request(provisioned, authority, root)
    submit(authority, other)
    for request_id in (
        other.payload["requestId"],
        root.payload["requestId"],
        evidence._encode(b"z" * 32),
    ):
        proof = read_proof(provisioned, authority, request, NOW + 1, request_id)
        with pytest.raises(BindingProtocolError, match="READ_DENIED"):
            authority.read_request(proof, NOW + 1)
    proof = read_proof(provisioned, authority, request, NOW + 1)
    with pytest.raises(BindingProtocolError, match="READ_DENIED"):
        authority.read_state(proof, NOW + 1)
    proof = read_proof(provisioned, authority, request, NOW + 1, request.payload["requestId"])
    assert (
        body(provisioned, authority.read_request(proof, NOW + 1), "request")["state"] == "pending"
    )


def test_unknown_and_wrong_signature_reads_have_same_denial(provisioned, authority):
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    submit(authority, request)
    correct = read_proof(provisioned, authority, root, NOW + 1, request.payload["requestId"])
    payload = wire.decode_read_proof(correct)
    bad = wire.sign_read_proof(payload, request.access)
    with pytest.raises(BindingProtocolError, match="READ_DENIED"):
        authority.read_request(bad, NOW + 1)
    payload["requestId"] = evidence._encode(b"z" * 32)
    with pytest.raises(BindingProtocolError, match="READ_DENIED"):
        authority.read_request(wire.sign_read_proof(payload, root.access), NOW + 1)


@pytest.mark.parametrize("change", ["revoked", "expired", "policy", "scope", "epoch"])
def test_approval_rechecks_current_authority_inside_transaction(provisioned, authority, change):
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    submit(authority, request)
    proof = approval_proof(root, request)
    manager = authority._bindings()[0]
    if change in ("policy", "epoch"):
        meta = authority._meta()
        meta["policyVersion" if change == "policy" else "ownershipEpoch"] += 1
        authority._save_meta(meta)
    else:
        if change == "revoked":
            manager["status"] = "revoked"
        elif change == "expired":
            manager["expiresAt"] = NOW + 2
        else:
            manager["delegableGrants"] = []
        authority._db.execute(
            "UPDATE bindings SET value=? WHERE binding_id=?",
            (store._json(manager), manager["bindingId"]),
        )
    with pytest.raises(BindingProtocolError):
        authority.approve_request(request.payload["requestId"], proof, NOW + 2)
    assert authority._existing(request.payload["requestId"])["state"] == "pending"
    assert len(authority._bindings()) == 1


def test_expiry_wins_at_deadline_and_clock_fence_survives_failure_and_restart(
    provisioned, authority
):
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    submit(authority, request)
    expiry = request.payload["expiresAt"]
    with pytest.raises(BindingProtocolError, match="REQUEST_TERMINAL"):
        authority.approve_request(
            request.payload["requestId"], approval_proof(root, request), expiry
        )
    assert authority._existing(request.payload["requestId"])["state"] == "expired"
    with pytest.raises(BindingProtocolError, match="CLOCK_ROLLBACK"):
        authority.auth_challenge(expiry - 1)
    authority.close()
    reopened = store.LocalTrustAuthority(provisioned.directory, boot_id="boot:two")
    try:
        with pytest.raises(BindingProtocolError, match="CLOCK_ROLLBACK"):
            reopened.auth_challenge(expiry - 1)
    finally:
        reopened.close()


def test_new_service_generation_expires_pending_and_fences_old_connections(provisioned, authority):
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    submit(authority, request)
    second = store.LocalTrustAuthority(provisioned.directory, boot_id="boot:two")
    try:
        assert second._existing(request.payload["requestId"])["state"] == "expired"
        with pytest.raises(BindingProtocolError, match="BOOT_MISMATCH"):
            authority.auth_challenge(NOW + 2)
        with pytest.raises(BindingProtocolError, match="BOOT_MISMATCH"):
            store.LocalTrustAuthority(provisioned.directory, boot_id="boot:one")
    finally:
        second.close()


def test_public_challenge_capacity_preserves_authenticated_read_pool(provisioned, authority):
    root = claim(provisioned, authority)
    for _ in range(128):
        authority.request_challenge(NOW)
    with pytest.raises(BindingProtocolError, match="CAPACITY"):
        authority.request_challenge(NOW)
    proof = read_proof(provisioned, authority, root, NOW)
    assert body(provisioned, authority.read_state(proof, NOW), "state")["bindings"]


def test_terminal_retention_reclaims_capacity_without_deleting_approved_ack(provisioned, authority):
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    submit(authority, request)
    authority.cancel_request(cancel_proof(request), NOW + 2)
    expiry = request.payload["expiresAt"]
    authority.auth_challenge(expiry + 3599)
    assert authority._existing(request.payload["requestId"]) is not None
    authority.auth_challenge(expiry + 3600)
    assert authority._existing(request.payload["requestId"]) is None
    assert authority._existing(root.payload["requestId"])["ack"] == root.ack
    with pytest.raises(BindingProtocolError):
        authority.submit_request(request.proof, expiry + 3600)


@pytest.mark.parametrize("terminal", ["approved", "cancelled", "expired", "restarted"])
def test_old_proposal_retry_returns_original_receipt_not_current_metadata(
    provisioned, authority, terminal
):
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    original = submit(authority, request)
    now = NOW + 2
    active = authority
    if terminal == "approved":
        authority.approve_request(request.payload["requestId"], approval_proof(root, request), now)
    elif terminal == "cancelled":
        authority.cancel_request(cancel_proof(request), now)
    elif terminal == "expired":
        now = request.payload["expiresAt"]
    else:
        authority.close()
        active = store.LocalTrustAuthority(provisioned.directory, boot_id="boot:next")
    try:
        assert active.submit_request(request.proof, now) == original
        assert body(provisioned, original, "request-receipt")["state"] == "pending"
        proof = read_proof(provisioned, active, request, now, request.payload["requestId"])
        current = body(provisioned, active.read_request(proof, now), "request")
        assert current["state"] == ("expired" if terminal == "restarted" else terminal)
    finally:
        if active is not authority:
            active.close()


def test_different_concurrent_approvals_with_same_checkpoint_cannot_both_commit(
    provisioned, authority
):
    root = claim(provisioned, authority)
    one = new_request(provisioned, authority, root)
    two = new_request(provisioned, authority, root)
    submit(authority, one)
    submit(authority, two)
    second = store.LocalTrustAuthority(provisioned.directory, boot_id="boot:one")
    try:
        p1, p2 = approval_proof(root, one), approval_proof(root, two)
        results = race(
            [
                lambda: authority.approve_request(one.payload["requestId"], p1, NOW + 2),
                lambda: second.approve_request(two.payload["requestId"], p2, NOW + 2),
            ]
        )
        assert len([value for value in results if value.count(".") == 2]) == 1
        assert "LOCAL_BINDING_CONTEXT_MISMATCH" in results
        assert len(authority._bindings()) == 2
        assert authority._meta()["rosterVersion"] == 2
    finally:
        second.close()


def test_cancelled_request_cannot_be_approved_or_resubmitted_to_revive(provisioned, authority):
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    original = submit(authority, request)
    cancel = cancel_proof(request)
    first = body(provisioned, authority.cancel_request(cancel, NOW + 2), "request-receipt")
    assert first["state"] == "cancelled"
    assert body(provisioned, authority.cancel_request(cancel, NOW + 2), "request-receipt") == first
    assert authority.submit_request(request.proof, NOW + 2) == original
    with pytest.raises(BindingProtocolError, match="REQUEST_TERMINAL"):
        authority.approve_request(
            request.payload["requestId"], approval_proof(root, request), NOW + 2
        )


@pytest.mark.parametrize("collision", ["client", "key", "challenge"])
def test_submit_rejects_known_identity_or_consumed_challenge(provisioned, authority, collision):
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    if collision == "client":
        request.payload["clientId"] = root.payload["clientId"]
    elif collision == "key":
        request.payload["accessKey"], request.access = root.payload["accessKey"], root.access
    else:
        submit(authority, request)
        request.payload["requestId"] = evidence._encode(os.urandom(32))
    with pytest.raises(BindingProtocolError):
        submit(authority, request)
    assert authority._meta()["rosterVersion"] == 1


def test_saved_approval_retry_rejects_changed_payload_and_wrong_key(provisioned, authority):
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    submit(authority, request)
    approval = approval_proof(root, request)
    ack = authority.approve_request(request.payload["requestId"], approval, NOW + 2)
    changed = evidence._decode_jws(approval, "approval")
    changed["approvedAt"] += 1
    with pytest.raises(BindingProtocolError, match="CONTEXT_MISMATCH"):
        authority.approve_request(
            request.payload["requestId"], evidence.sign_approval(changed, root.approval), NOW + 3
        )
    original = evidence._decode_jws(approval, "approval")
    with pytest.raises(BindingProtocolError, match="SIGNATURE_INVALID"):
        authority.approve_request(
            request.payload["requestId"], evidence.sign_approval(original, request.access), NOW + 3
        )
    assert authority.approve_request(request.payload["requestId"], approval, NOW + 3) == ack


def test_unsigned_saved_request_mirror_cannot_substitute_for_proof(provisioned, authority):
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    submit(authority, request)
    changed = copy.deepcopy(request.payload)
    changed["grants"][0]["actions"] = ["read", "write"]
    authority._db.execute(
        "UPDATE requests SET value=? WHERE request_id=?",
        (store._json(changed), changed["requestId"]),
    )
    with pytest.raises(BindingProtocolError, match="STATE_INVALID"):
        authority.approve_request(
            request.payload["requestId"], approval_proof(root, request), NOW + 2
        )
    assert len(authority._bindings()) == 1


def test_failed_credential_check_still_advances_clock_fence(provisioned, authority):
    root = new_root(provisioned, authority)
    proofs = list(root_proofs(provisioned, root))
    proofs[2] = wire.sign_first_root_secret(root.payload, b"x" * 32)
    with pytest.raises(BindingProtocolError, match="SIGNATURE_INVALID"):
        authority.commit_first_root(*proofs, NOW + 10)
    authority.close()
    reopened = store.LocalTrustAuthority(provisioned.directory, boot_id="boot:two")
    try:
        with pytest.raises(BindingProtocolError, match="CLOCK_ROLLBACK"):
            reopened.first_root_challenge(NOW + 9)
    finally:
        reopened.close()


@pytest.mark.parametrize(
    "now", [True, 0, -1, NOW + 0.5, float("nan"), float("inf"), 9007199254740992]
)
def test_invalid_execution_clock_is_rejected_without_mutation(authority, now):
    before = authority._meta()
    with pytest.raises(BindingProtocolError):
        authority.first_root_challenge(now)
    assert authority._meta() == before


def test_missing_database_never_reinitializes_even_with_retained_bundle(provisioned, authority):
    authority.close()
    (provisioned.directory / store.DATABASE).unlink()
    with pytest.raises(BindingProtocolError, match="STATE_MISSING"):
        store.LocalTrustAuthority(provisioned.directory, boot_id="boot:two")
    with pytest.raises(BindingProtocolError, match="ALREADY_INITIALIZED"):
        store.initialize_authority(provisioned.directory, now=NOW)
    assert not (provisioned.directory / store.DATABASE).exists()


def test_corrupt_checkpoint_is_not_treated_as_unclaimed(provisioned, authority):
    claim(provisioned, authority)
    authority._db.execute("DELETE FROM events")
    authority.close()
    with pytest.raises(BindingProtocolError, match="STATE_INVALID"):
        store.LocalTrustAuthority(provisioned.directory, boot_id="boot:two")


@pytest.mark.parametrize("target", [store.BUNDLE, store.KEY, store.DATABASE, store.SEAL])
def test_private_files_reject_symlink_aliases(provisioned, target):
    path = provisioned.directory / target
    replacement = path.with_name(path.name + ".real")
    path.rename(replacement)
    path.symlink_to(replacement)
    with pytest.raises(BindingProtocolError):
        store.LocalTrustAuthority(provisioned.directory, boot_id="boot:one")


def test_private_directory_permissions_and_bundle_pin_are_enforced(provisioned):
    provisioned.directory.chmod(0o755)
    with pytest.raises(BindingProtocolError, match="PATH_INVALID"):
        store.LocalTrustAuthority(provisioned.directory, boot_id="boot:one")
    provisioned.directory.chmod(0o700)
    changed = copy.deepcopy(provisioned.bundle)
    changed["boxKey"] = wire.public_jwk(ec.generate_private_key(ec.SECP256R1()))
    private(provisioned.directory / store.BUNDLE, wire.canonical(changed))
    with pytest.raises(BindingProtocolError, match="KEY_MISMATCH"):
        store.LocalTrustAuthority(provisioned.directory, boot_id="boot:one")


def test_data_view_uses_actual_admitted_scope_and_never_delegable_scope(provisioned, authority):
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    submit(authority, request)
    ack = body(provisioned, authority.approve_request(request.payload["requestId"], approval_proof(root, request), NOW + 2), "binding-ack")
    binding = next(row for row in authority._bindings() if row["bindingId"] == ack["bindingId"])
    assert binding["delegableGrants"] == []
    view = authority.get_authorization(binding["bindingId"], NOW + 2)
    assert view["grants"] == [{"resourceId": "space:personal", "actions": ["read"]}]
    assert view["expiresAt"] == request.payload["grantExpiresAt"]
    assert view["principalSecurityVersion"] == view["bindingRevision"] == 1
    view["grants"][0]["actions"].append("write")
    assert authority.get_authorization(binding["bindingId"], NOW + 2)["grants"][0]["actions"] == ["read"]
    with pytest.raises(BindingProtocolError, match="ACCESS_DENIED"):
        authority.get_authorization(binding["bindingId"], request.payload["grantExpiresAt"])


def test_data_view_rejects_current_revocation_and_unknown_binding(provisioned, authority):
    root = claim(provisioned, authority)
    with pytest.raises(BindingProtocolError, match="ACCESS_DENIED"):
        authority.get_authorization("binding:unknown", NOW)
    binding = authority._bindings()[0]
    binding["status"] = "revoked"
    authority._db.execute("UPDATE bindings SET value=? WHERE binding_id=?", (store._json(binding), root.binding_id))
    with pytest.raises(BindingProtocolError, match="ACCESS_DENIED"):
        authority.get_authorization(root.binding_id, NOW)


def test_private_resource_catalog_never_aliases_other_principal():
    from wanx_bridge.local_resource_catalog import resolve_resource

    alice = resolve_resource("principal:alice", "space")
    alias = resolve_resource("principal:alice", "space:personal")
    bob = resolve_resource("principal:bob", "space")
    assert alice["namespaceId"] == alias["namespaceId"]
    assert alice["namespaceId"] != bob["namespaceId"]
    assert alice["scope"] == bob["scope"] == "principal-private"
    with pytest.raises(BindingProtocolError, match="RESOURCE_UNSUPPORTED"):
        resolve_resource("principal:alice", "shared:other")
