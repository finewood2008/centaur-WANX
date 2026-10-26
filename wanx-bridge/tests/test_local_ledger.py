"""Synthetic histories only: no production paths, credentials, or migrations."""

import copy
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from test_local_authority_store import NOW, approval_proof, body, claim, new_request, submit
from test_local_authority_store import provisioned as _provisioned

from wanx_bridge import local_authority_store as store
from wanx_bridge import local_ledger_protocol as protocol
from wanx_bridge import local_management_protocol as wire
from wanx_bridge import local_trust_protocol as evidence

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Private authority requires POSIX")


@pytest.fixture
def provisioned(tmp_path):
    return _provisioned.__wrapped__(tmp_path)


@pytest.fixture
def ledger(provisioned):
    old = store.LocalTrustAuthority(provisioned.directory, boot_id="v1:boot")
    root = claim(provisioned, old)
    use = new_request(provisioned, old, root)
    submit(old, use)
    use.ack = old.approve_request(use.payload["requestId"], approval_proof(root, use), NOW + 2)
    use.binding_id = body(provisioned, use.ack, "binding-ack")["bindingId"]
    old.close()
    migration = store.migrate_authority_v2(provisioned.directory, now=NOW + 3)
    authority = store.LocalTrustAuthority(provisioned.directory, boot_id="v2:boot")
    yield SimpleNamespace(
        authority=authority, root=root, use=use, migration=migration, provisioned=provisioned
    )
    authority.close()


def verified(ledger, proof, kind):
    return protocol.verify_response(
        proof, ledger.provisioned.bundle["boxKey"], box_id="box:test", kind=kind
    )["body"]


def actor(device):
    return {
        "kind": "binding",
        "principalId": device.payload["principalId"],
        "bindingId": device.binding_id,
        "keyVersion": 1,
    }


def prepare(ledger, action, args, *, device=None, now=NOW + 10, authority=None):
    authority = authority or ledger.authority
    device = device or ledger.root
    identity = actor(device) if not hasattr(device, "identity") else device.identity
    challenge = verified(
        ledger, authority.mutation_challenge(identity, action, now), "mutation-challenge"
    )
    payload = {
        **challenge["context"],
        "schemaVersion": 2,
        "purpose": "centuarai.local-ledger.prepare",
        "requestId": evidence._encode(os.urandom(32)),
        "challenge": challenge["challenge"],
        "issuedAt": now,
        "expiresAt": now + 300,
        "actor": identity,
        "action": action,
        "args": args,
    }
    proof = protocol.sign_prepare(payload, device.access)
    return verified(ledger, authority.prepare_mutation(proof, now), "mutation-review")


def commit(
    ledger, review, *, device=None, target=None, material=None, now=NOW + 10, authority=None
):
    device = device or ledger.root
    value = review["mutation"]
    proofs = [
        protocol.sign_mutation(value, device.approval),
        protocol.sign_mutation(value, target.access, purpose="target-access") if target else None,
        protocol.sign_mutation(value, target.approval, purpose="target-approval")
        if target
        else None,
        protocol.sign_mutation(value, material, purpose="recovery-material") if material else None,
        None,
    ]
    return (authority or ledger.authority).commit_mutation(*proofs, now), proofs


def read(ledger, operation, *, device=None, request_id=None, now=NOW + 11):
    device = device or ledger.root
    identity = actor(device) if not hasattr(device, "identity") else device.identity
    challenge = verified(ledger, ledger.authority.auth_challenge_v2(now), "read-challenge")
    payload = {
        "schemaVersion": 2,
        "purpose": "centuarai.local-ledger.read",
        "boxId": "box:test",
        "boxKeyThumbprint": challenge["context"]["boxKeyThumbprint"],
        "ownershipEpoch": challenge["context"]["ownershipEpoch"],
        "nonce": challenge["nonce"],
        "issuedAt": now,
        "expiresAt": now + 60,
        "actor": identity,
        "operation": operation,
        "requestId": request_id,
        "bindingId": identity["bindingId"] if operation == "self-binding" else None,
    }
    return verified(
        ledger, ledger.authority.read_v2(protocol.sign_read(payload, device.access), now), operation
    )


def activate(ledger, *, now=NOW + 10):
    review = prepare(
        ledger, "owner-policy.activate-v2", {"capabilities": sorted(protocol.CAPABILITIES)}, now=now
    )
    return commit(ledger, review, now=now)


def manager_target(*, principal_id="principal:independent"):
    access, approval = (ec.generate_private_key(ec.SECP256R1()) for _ in range(2))
    payload = {
        "clientId": "client:" + os.urandom(16).hex(),
        "accessKey": wire.public_jwk(access),
        "approvalKey": wire.public_jwk(approval),
        "keyProtection": "software-passphrase-v1",
        "capabilities": sorted(protocol.CAPABILITIES),
        "grants": [{"resourceId": "space:personal", "actions": ["read", "write"]}],
        "delegableGrants": [{"resourceId": "space:personal", "actions": ["read", "write"]}],
        "expiresAt": None,
        "delegationExpiresAt": None,
    }
    return SimpleNamespace(
        access=access,
        approval=approval,
        payload={"principalId": principal_id, **payload},
        target=payload,
    )


def new_material(version):
    signing = ec.generate_private_key(ec.SECP256R1())
    backup = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    pub = backup.public_key().public_numbers()
    return signing, {
        "recoveryId": evidence._encode(os.urandom(32)),
        "version": version,
        "signingKey": wire.public_jwk(signing),
        "backupKey": {"kty": "RSA", "n": evidence._encode(pub.n.to_bytes(384, "big")), "e": "AQAB"},
    }


def test_roster_growth_rejects_before_an_authorized_scoped_read_becomes_oversized(ledger):
    activate(ledger)
    accepted = 0
    for index in range(20):
        target = manager_target(principal_id=ledger.root.payload["principalId"])
        before = ledger.authority._meta()["rosterVersion"]
        try:
            review = prepare(
                ledger, "device.add-manager", {"target": target.target}, now=NOW + 11 + index
            )
            commit(ledger, review, target=target, now=NOW + 11 + index)
        except evidence.BindingProtocolError as exc:
            assert exc.code == "LOCAL_TRUST_CAPACITY"
            assert ledger.authority._meta()["rosterVersion"] == before
            state = read(ledger, "principal-state", now=NOW + 11 + index)
            assert len(state["projection"]["bindings"]) == accepted + 2
            break
        accepted += 1
        read(ledger, "principal-state", now=NOW + 11 + index)
    else:
        pytest.fail("bounded projection capacity was not enforced")
    assert accepted > 0


def test_consumed_read_nonces_do_not_exhaust_live_challenge_capacity(ledger):
    first = None
    for _ in range(240):
        challenge = verified(ledger, ledger.authority.auth_challenge_v2(NOW + 10), "read-challenge")
        payload = {
            "schemaVersion": 2,
            "purpose": "centuarai.local-ledger.read",
            "boxId": "box:test",
            "boxKeyThumbprint": challenge["context"]["boxKeyThumbprint"],
            "ownershipEpoch": challenge["context"]["ownershipEpoch"],
            "nonce": challenge["nonce"],
            "issuedAt": NOW + 10,
            "expiresAt": NOW + 60,
            "actor": actor(ledger.root),
            "operation": "self-binding",
            "requestId": None,
            "bindingId": ledger.root.binding_id,
        }
        proof = protocol.sign_read(payload, ledger.root.access)
        first = proof if first is None else first
        ledger.authority.read_v2(proof, NOW + 10)
        assert ledger.authority._db.execute("SELECT count(*) FROM challenges").fetchone()[0] <= 1
    with pytest.raises(evidence.BindingProtocolError, match="READ_DENIED"):
        ledger.authority.read_v2(first, NOW + 10)


def test_authenticated_issuance_is_bounded_per_actor_and_replay_survives_restart(ledger):
    activate(ledger)
    signing, material = new_material(1)
    setup = prepare(
        ledger,
        "recovery.setup",
        {"expectedRecoveryVersion": 0, "newRecovery": material},
        now=NOW + 11,
    )
    commit(ledger, setup, material=signing, now=NOW + 11)
    member = manager_target(principal_id="principal:separate-quota")
    member.target["capabilities"] = sorted(protocol.INVITED_CAPABILITIES)
    invite = prepare(
        ledger,
        "principal.invite",
        {"principalId": member.payload["principalId"], "target": member.target},
        now=NOW + 12,
    )
    ack, _ = commit(ledger, invite, target=member, now=NOW + 12)
    member.binding_id = verified(ledger, ack, "mutation-ack")["result"]["bindingId"]

    def proof(identity, key, epoch=1, now=NOW + 14):
        value = {
            "schemaVersion": 2,
            "purpose": "centuarai.local-ledger.auth-challenge",
            "boxId": "box:test",
            "boxKeyThumbprint": evidence.public_key_thumbprint(ledger.provisioned.bundle["boxKey"]),
            "ownershipEpoch": epoch,
            "actor": identity,
            "clientNonce": evidence._encode(os.urandom(32)),
            "issuedAt": now,
            "expiresAt": now + 60,
        }
        return protocol.sign_auth_challenge(value, key)

    first = None
    for _ in range(1024):
        signed = proof(actor(ledger.root), ledger.root.access)
        first = signed if first is None else first
        challenge = verified(
            ledger, ledger.authority.authenticated_challenge_v2(signed, NOW + 14), "read-challenge"
        )
        read_value = {
            "schemaVersion": 2,
            "purpose": "centuarai.local-ledger.read",
            "boxId": "box:test",
            "boxKeyThumbprint": challenge["context"]["boxKeyThumbprint"],
            "ownershipEpoch": 1,
            "nonce": challenge["nonce"],
            "issuedAt": NOW + 14,
            "expiresAt": NOW + 74,
            "actor": actor(ledger.root),
            "operation": "self-binding",
            "requestId": None,
            "bindingId": ledger.root.binding_id,
        }
        ledger.authority.read_v2(protocol.sign_read(read_value, ledger.root.access), NOW + 14)
    with pytest.raises(evidence.BindingProtocolError, match="CAPACITY"):
        ledger.authority.authenticated_challenge_v2(
            proof(actor(ledger.root), ledger.root.access), NOW + 14
        )
    other = proof(actor(member), member.access)
    ledger.authority.authenticated_challenge_v2(other, NOW + 14)
    recovery_actor = {
        "kind": "recovery",
        "principalId": ledger.root.payload["principalId"],
        "bindingId": None,
        "keyVersion": 1,
    }
    ledger.authority.authenticated_challenge_v2(proof(recovery_actor, signing, None), NOW + 14)
    root_kind = "read-v2-auth:" + wire.digest(actor(ledger.root))
    assert (
        ledger.authority._db.execute(
            "SELECT COUNT(*) FROM challenges WHERE kind=?", (root_kind,)
        ).fetchone()[0]
        == 1024
    )
    ledger.authority.close()
    ledger.authority = store.LocalTrustAuthority(
        ledger.provisioned.directory, boot_id="authenticated:restart"
    )
    for captured in (first, other):
        with pytest.raises(evidence.BindingProtocolError, match="CHALLENGE_DENIED"):
            ledger.authority.authenticated_challenge_v2(captured, NOW + 15)
    ledger.authority.authenticated_challenge_v2(
        proof(actor(member), member.access, now=NOW + 15), NOW + 15
    )
    ledger.authority.authenticated_challenge_v2(
        proof(actor(ledger.root), ledger.root.access, now=NOW + 75), NOW + 75
    )
    assert (
        ledger.authority._db.execute(
            "SELECT COUNT(*) FROM challenges WHERE kind=?", (root_kind,)
        ).fetchone()[0]
        == 1
    )


def test_migration_preserves_grants_and_never_implicitly_expands_capabilities(ledger):
    assert verified(ledger, ledger.migration, "migration-ack")["context"]["rosterVersion"] == 3
    view = ledger.authority.get_authorization(ledger.use.binding_id, NOW + 4)
    assert view["grants"] == ledger.use.payload["grants"]
    state = read(ledger, "principal-state")
    assert state["projection"]["qualifiedOriginalOwnerRoot"] is True
    assert next(
        row for row in state["projection"]["bindings"] if row["bindingId"] == ledger.root.binding_id
    )["capabilities"] == ["device.approve_use"]
    with pytest.raises(evidence.BindingProtocolError, match="AUTHORIZATION_DENIED"):
        prepare(
            ledger,
            "device.revoke",
            {"bindingId": ledger.use.binding_id, "mode": "normal"},
            now=NOW + 12,
        )


def test_activation_revoke_saved_retry_restart_and_fresh_historical_self_status(ledger):
    activate(ledger)
    review = prepare(
        ledger,
        "device.revoke",
        {"bindingId": ledger.use.binding_id, "mode": "normal"},
        now=NOW + 11,
    )
    ack, proofs = commit(ledger, review, now=NOW + 11)
    assert verified(ledger, ack, "mutation-ack")["action"] == "device.revoke"
    with pytest.raises(evidence.BindingProtocolError, match="ACCESS_DENIED"):
        ledger.authority.get_authorization(ledger.use.binding_id, NOW + 12)
    assert read(ledger, "self-binding", device=ledger.use, now=NOW + 12)["status"] == "revoked"
    ledger.authority.close()
    ledger.authority = store.LocalTrustAuthority(
        ledger.provisioned.directory, boot_id="v2:restarted"
    )
    assert ledger.authority.commit_mutation(*proofs, NOW + 500) == ack
    assert (
        read(ledger, "mutation-status", request_id=review["mutation"]["requestId"], now=NOW + 501)[
            "ack"
        ]
        == ack
    )


def test_only_one_connection_can_activate_owner_policy(ledger):
    one = prepare(
        ledger, "owner-policy.activate-v2", {"capabilities": sorted(protocol.CAPABILITIES)}
    )
    two = prepare(
        ledger, "owner-policy.activate-v2", {"capabilities": sorted(protocol.CAPABILITIES)}
    )
    other = store.LocalTrustAuthority(ledger.provisioned.directory, boot_id="v2:boot")
    barrier = Barrier(2)

    def run(authority, review):
        barrier.wait()
        try:
            return commit(ledger, review, authority=authority)[0]
        except evidence.BindingProtocolError as exc:
            return exc.code

    try:
        with ThreadPoolExecutor(2) as pool:
            futures = [
                pool.submit(run, authority, review)
                for authority, review in ((ledger.authority, one), (other, two))
            ]
            results = [future.result() for future in futures]
        assert sum(result.count(".") == 2 for result in results) == 1
        assert "LOCAL_BINDING_CONTEXT_MISMATCH" in results
    finally:
        other.close()


def test_explicit_manager_and_member_require_both_final_target_proofs(ledger):
    activate(ledger)
    target = manager_target()
    review = prepare(ledger, "device.add-manager", {"target": target.target}, now=NOW + 11)
    proof = protocol.sign_mutation(review["mutation"], ledger.root.approval)
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.commit_mutation(proof, None, None, None, None, NOW + 11)
    ack, _ = commit(ledger, review, target=target, now=NOW + 11)
    target.binding_id = verified(ledger, ack, "mutation-ack")["result"]["bindingId"]
    assert (
        ledger.authority.get_authorization(target.binding_id, NOW + 11)["grants"]
        == target.target["grants"]
    )
    member = manager_target(principal_id="principal:new-member")
    member.target["capabilities"] = sorted(protocol.INVITED_CAPABILITIES)
    review = prepare(
        ledger,
        "principal.invite",
        {"principalId": member.payload["principalId"], "target": member.target},
        now=NOW + 12,
    )
    ack, _ = commit(ledger, review, target=member, now=NOW + 12)
    member.binding_id = verified(ledger, ack, "mutation-ack")["result"]["bindingId"]
    own_state = read(ledger, "principal-state", device=member, now=NOW + 13)["projection"]
    assert all(
        row["principalId"] == "principal:new-member"
        for row in own_state["bindings"] + own_state["grants"]
    )
    root_state = read(ledger, "principal-state", now=NOW + 13)["projection"]
    assert {row["resourceNamespaceId"] for row in root_state["grants"]}.isdisjoint(
        {row["resourceNamespaceId"] for row in own_state["grants"]}
    )
    ledger.authority.close()
    ledger.authority = store.LocalTrustAuthority(
        ledger.provisioned.directory, boot_id="v2:restart-member"
    )


def test_recovery_replaces_old_devices_and_material_in_one_commit(ledger):
    activate(ledger)
    signing, material = new_material(1)
    setup = prepare(
        ledger,
        "recovery.setup",
        {"expectedRecoveryVersion": 0, "newRecovery": material},
        now=NOW + 11,
    )
    commit(ledger, setup, material=signing, now=NOW + 11)
    offline = SimpleNamespace(
        identity={
            "kind": "recovery",
            "principalId": ledger.root.payload["principalId"],
            "bindingId": None,
            "keyVersion": 1,
        },
        access=signing,
        approval=signing,
    )
    next_signing, next_material = new_material(2)
    target = manager_target()
    minimal = {
        name: target.target[name]
        for name in ("clientId", "accessKey", "approvalKey", "keyProtection")
    }
    review = prepare(
        ledger,
        "recovery.recover",
        {
            "expectedRecoveryVersion": 1,
            "expectedPrincipalSecurityVersion": 1,
            "newRecovery": next_material,
            "target": minimal,
        },
        device=offline,
        now=NOW + 12,
    )
    ack, proofs = commit(
        ledger, review, device=offline, target=target, material=next_signing, now=NOW + 12
    )
    target.binding_id = verified(ledger, ack, "mutation-ack")["result"]["bindingId"]
    for old in (ledger.root, ledger.use):
        with pytest.raises(evidence.BindingProtocolError, match="ACCESS_DENIED"):
            ledger.authority.get_authorization(old.binding_id, NOW + 13)
    assert (
        ledger.authority.get_authorization(target.binding_id, NOW + 13)["principalSecurityVersion"]
        == 2
    )
    ledger.authority.close()
    ledger.authority = store.LocalTrustAuthority(
        ledger.provisioned.directory, boot_id="v2:recovered"
    )
    assert ledger.authority.commit_mutation(*proofs, NOW + 500) == ack


def test_migrated_unclaimed_authority_requires_original_secret_and_supports_restart(provisioned):
    from test_local_authority_store import new_root, root_proofs

    store.migrate_authority_v2(provisioned.directory, now=NOW + 1)
    authority = store.LocalTrustAuthority(provisioned.directory, boot_id="v2:unclaimed")
    try:
        root = new_root(provisioned, authority, NOW + 2)
        proofs = root_proofs(provisioned, root)
        bad = wire.sign_first_root_secret(root.payload, os.urandom(32))
        with pytest.raises(evidence.BindingProtocolError, match="SIGNATURE_INVALID"):
            authority.commit_first_root(proofs[0], proofs[1], bad, NOW + 2)
        ack = authority.commit_first_root(*proofs, NOW + 2)
        authority.close()
        authority = store.LocalTrustAuthority(provisioned.directory, boot_id="v2:claimed")
        assert authority.commit_first_root(*proofs, NOW + 500) == ack
        assert body(provisioned, ack, "binding-ack")["rosterVersion"] == 2
    finally:
        authority.close()


def test_v1_use_protocol_survives_v2_without_old_state_digest_ambiguity(ledger):
    from test_local_authority_store import read_proof

    request = new_request(ledger.provisioned, ledger.authority, ledger.root, NOW + 4)
    receipt = submit(ledger.authority, request, NOW + 4)
    proof = approval_proof(ledger.root, request, NOW + 5)
    ack = ledger.authority.approve_request(request.payload["requestId"], proof, NOW + 5)
    assert body(ledger.provisioned, ack, "binding-ack")["role"] == "use"
    read_request_proof = read_proof(
        ledger.provisioned, ledger.authority, request, NOW + 6, request.payload["requestId"]
    )
    assert (
        body(
            ledger.provisioned,
            ledger.authority.read_request(read_request_proof, NOW + 6),
            "request",
        )["ack"]
        == ack
    )
    ledger.authority.close()
    ledger.authority = store.LocalTrustAuthority(
        ledger.provisioned.directory, boot_id="v2:use-restart"
    )
    assert ledger.authority.approve_request(request.payload["requestId"], proof, NOW + 400) == ack
    assert ledger.authority.submit_request(request.proof, NOW + 400) == receipt
    with pytest.raises(evidence.BindingProtocolError, match="CLIENT_UPGRADE_REQUIRED"):
        ledger.authority.read_state("old-state-proof", NOW + 400)


def test_v1_manager_request_read_uses_own_authenticated_pool_when_anonymous_is_full(ledger):
    request = new_request(ledger.provisioned, ledger.authority, ledger.root, NOW + 4)
    submit(ledger.authority, request, NOW + 4)
    for _ in range(128):
        ledger.authority.auth_challenge(NOW + 5)
    with pytest.raises(evidence.BindingProtocolError, match="CAPACITY"):
        ledger.authority.auth_challenge(NOW + 5)
    signed = protocol.sign_auth_challenge(
        {
            "schemaVersion": 2,
            "purpose": "centuarai.local-ledger.auth-challenge",
            "boxId": "box:test",
            "boxKeyThumbprint": evidence.public_key_thumbprint(ledger.provisioned.bundle["boxKey"]),
            "ownershipEpoch": 1,
            "actor": actor(ledger.root),
            "clientNonce": evidence._encode(os.urandom(32)),
            "issuedAt": NOW + 5,
            "expiresAt": NOW + 65,
        },
        ledger.root.access,
    )
    challenge = verified(
        ledger, ledger.authority.authenticated_challenge_v2(signed, NOW + 5), "read-challenge"
    )
    value = {
        "schemaVersion": 1,
        "purpose": "centuarai.local-management.read",
        "boxId": "box:test",
        "boxKeyThumbprint": challenge["context"]["boxKeyThumbprint"],
        "ownershipEpoch": 1,
        "nonce": challenge["nonce"],
        "issuedAt": NOW + 5,
        "expiresAt": NOW + 65,
        "clientId": ledger.root.payload["clientId"],
        "operation": "request",
        "requestId": request.payload["requestId"],
    }
    # An applicant knows its own request key, but cannot consume a manager's
    # reserved nonce. The rejected read also must not burn that nonce.
    for device in (request, ledger.use):
        with pytest.raises(evidence.BindingProtocolError, match="READ_DENIED"):
            ledger.authority.read_request(
                wire.sign_read_proof(
                    {**value, "clientId": device.payload["clientId"]}, device.access
                ),
                NOW + 5,
            )
    proof = wire.sign_read_proof(value, ledger.root.access)
    result = body(ledger.provisioned, ledger.authority.read_request(proof, NOW + 5), "request")
    assert result["state"] == "pending" and result["requestJws"] == request.proof
    with pytest.raises(evidence.BindingProtocolError, match="READ_DENIED"):
        ledger.authority.read_request(proof, NOW + 5)


def test_private_effect_evidence_never_accepts_wrong_commit_generation_or_pending_work(ledger):
    from wanx_bridge.local_data_protocol import DataProtocolError

    activate(ledger)
    review = prepare(
        ledger,
        "device.revoke",
        {"bindingId": ledger.use.binding_id, "mode": "normal"},
        now=NOW + 11,
    )
    commit(ledger, review, now=NOW + 11)
    request_id = review["mutation"]["requestId"]
    assert ledger.authority.get_effect_evidence(request_id) is None
    generation = wire.digest("fixture:data-generation")
    observed = None

    def provider(identifier, expected):
        assert identifier == request_id
        return {**expected, **observed}

    ledger.authority.install_effect_provider(provider, generation=generation)
    observed = {
        "effectState": "effective",
        "gateway": {
            "generation": generation,
            "targetSessions": 0,
            "closedSessions": 0,
            "pendingSessions": 0,
        },
        "native": {
            "targetOperations": 0,
            "closedOperations": 0,
            "pendingOperations": 0,
            "unknownOperations": 0,
        },
        "observedAtMs": (NOW + 12) * 1000,
        "evidenceDigest": wire.digest("fixture:observed"),
    }
    assert ledger.authority.get_effect_evidence(request_id)["effectState"] == "effective"
    observed["operationId"] = wire.digest("other:operation")
    with pytest.raises(evidence.BindingProtocolError, match="STATE_INVALID"):
        ledger.authority.get_effect_evidence(request_id)
    del observed["operationId"]
    observed["gateway"]["generation"] = wire.digest("old:generation")
    with pytest.raises(evidence.BindingProtocolError, match="STATE_INVALID"):
        ledger.authority.get_effect_evidence(request_id)
    observed["gateway"]["generation"] = generation
    observed["native"].update(targetOperations=1, unknownOperations=1)
    with pytest.raises(DataProtocolError):
        ledger.authority.get_effect_evidence(request_id)


def test_cascade_last_manager_and_explicit_emergency_lock(ledger):
    activate(ledger)
    target = manager_target()
    review = prepare(ledger, "device.add-manager", {"target": target.target}, now=NOW + 11)
    ack, _ = commit(ledger, review, target=target, now=NOW + 11)
    target.binding_id = verified(ledger, ack, "mutation-ack")["result"]["bindingId"]
    with pytest.raises(evidence.BindingProtocolError, match="LAST_MANAGER"):
        prepare(
            ledger,
            "device.revoke",
            {"bindingId": ledger.root.binding_id, "mode": "normal"},
            now=NOW + 12,
        )
    review = prepare(
        ledger,
        "device.revoke",
        {"bindingId": ledger.root.binding_id, "mode": "emergency-lock"},
        now=NOW + 12,
    )
    assert review["effects"]["remainingIndependentManagers"] == 0
    assert review["effects"]["suspendedBindings"]["count"] == 2
    commit(ledger, review, now=NOW + 12)
    assert (
        read(ledger, "self-binding", device=target, now=NOW + 13)["principalStatus"] == "suspended"
    )
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.get_authorization(target.binding_id, NOW + 13)


@pytest.mark.parametrize(
    "alter", ["grant", "event", "signature", "index", "approval", "receipt", "schema"]
)
def test_migration_rejects_corrupt_v1_without_partial_v2(provisioned, alter):
    import sqlite3

    authority = store.LocalTrustAuthority(provisioned.directory, boot_id="corruption:source")
    root = claim(provisioned, authority)
    request = new_request(provisioned, authority, root)
    submit(authority, request)
    authority.approve_request(request.payload["requestId"], approval_proof(root, request), NOW + 2)
    if alter == "grant":
        value = authority._meta()
        value["initialGrants"] = [{"resourceId": "wanx", "actions": ["execute"]}]
        authority._save_meta(value)
    elif alter == "event":
        authority._db.execute(
            "UPDATE events SET previous_digest=? WHERE seq=2", (evidence._encode(bytes(32)),)
        )
    elif alter == "signature":
        authority._db.execute("UPDATE requests SET ack='not-a-proof' WHERE kind='root'")
    elif alter == "index":
        authority._db.execute("DELETE FROM keys WHERE purpose='approvalKey'")
    elif alter == "approval":
        authority._db.execute(
            "UPDATE requests SET approval_key=? WHERE kind='use'",
            (wire.canonical(wire.public_jwk(ec.generate_private_key(ec.SECP256R1()))).decode(),),
        )
    elif alter == "receipt":
        authority._db.execute("UPDATE requests SET receipt=NULL WHERE kind='use'")
    else:
        authority._db.execute("CREATE TABLE unexpected (value TEXT)")
    authority.close()
    with pytest.raises((evidence.BindingProtocolError, TypeError)):
        store.migrate_authority_v2(provisioned.directory, now=NOW + 3)
    connection = sqlite3.connect(provisioned.directory / store.DATABASE)
    try:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 0
        assert (
            connection.execute(
                "SELECT name FROM sqlite_master WHERE name='ledger_events'"
            ).fetchone()
            is None
        )
    finally:
        connection.close()


@pytest.mark.parametrize(
    "field,value",
    [
        ("issuedAt", True),
        ("expiresAt", 1.5),
        ("schemaVersion", 2.0),
        ("action", "patch"),
        ("unknown", "extra"),
    ],
)
def test_protocol_rejects_shape_and_numeric_ambiguity(ledger, field, value):
    review = prepare(
        ledger, "owner-policy.activate-v2", {"capabilities": sorted(protocol.CAPABILITIES)}
    )
    invalid = copy.deepcopy(review["mutation"])
    invalid[field] = value
    with pytest.raises(evidence.BindingProtocolError):
        protocol.sign_mutation(invalid, ledger.root.approval)


@pytest.mark.parametrize("capability", ["member.invite", "member.revoke", "ownership.transfer"])
def test_member_invitation_never_delegates_owner_administration(ledger, capability):
    activate(ledger)
    member = manager_target(principal_id="principal:other")
    member.target["capabilities"] = [capability]
    with pytest.raises(evidence.BindingProtocolError, match="SCOPE_EXCEEDED"):
        prepare(
            ledger,
            "principal.invite",
            {"principalId": member.payload["principalId"], "target": member.target},
            now=NOW + 11,
        )
    assert len(ledger.authority._ledger.snapshot(ledger.authority._meta())["principals"]) == 1


def test_owner_recovery_leaves_independently_invited_member_and_namespace_valid(ledger):
    activate(ledger)
    member = manager_target(principal_id="principal:independent-member")
    member.target["capabilities"] = sorted(protocol.INVITED_CAPABILITIES)
    review = prepare(
        ledger,
        "principal.invite",
        {"principalId": member.payload["principalId"], "target": member.target},
        now=NOW + 11,
    )
    ack, _ = commit(ledger, review, target=member, now=NOW + 11)
    member.binding_id = verified(ledger, ack, "mutation-ack")["result"]["bindingId"]
    before_namespace = {
        row["resourceNamespaceId"]
        for row in read(ledger, "principal-state", device=member, now=NOW + 12)["projection"][
            "grants"
        ]
    }
    signing, first = new_material(1)
    setup = prepare(
        ledger, "recovery.setup", {"expectedRecoveryVersion": 0, "newRecovery": first}, now=NOW + 13
    )
    commit(ledger, setup, material=signing, now=NOW + 13)
    second_signing, second = new_material(2)
    target = manager_target()
    offline = SimpleNamespace(
        identity={
            "kind": "recovery",
            "principalId": ledger.root.payload["principalId"],
            "bindingId": None,
            "keyVersion": 1,
        },
        access=signing,
        approval=signing,
    )
    review = prepare(
        ledger,
        "recovery.recover",
        {
            "expectedRecoveryVersion": 1,
            "expectedPrincipalSecurityVersion": 1,
            "newRecovery": second,
            "target": {
                field: target.target[field]
                for field in ("clientId", "accessKey", "approvalKey", "keyProtection")
            },
        },
        device=offline,
        now=NOW + 14,
    )
    assert review["effects"]["suspendedBindings"]["count"] == 0
    commit(ledger, review, device=offline, target=target, material=second_signing, now=NOW + 14)
    ledger.authority.close()
    ledger.authority = store.LocalTrustAuthority(
        ledger.provisioned.directory, boot_id="independent:member-restart"
    )
    assert (
        ledger.authority.get_authorization(member.binding_id, NOW + 15)["principalSecurityVersion"]
        == 1
    )
    assert read(ledger, "self-binding", device=member, now=NOW + 15)["status"] == "active"
    after_namespace = {
        row["resourceNamespaceId"]
        for row in read(ledger, "principal-state", device=member, now=NOW + 15)["projection"][
            "grants"
        ]
    }
    assert before_namespace == after_namespace


def test_finite_manager_cannot_delegate_unlimited_and_self_view_expires_at_boundary(ledger):
    activate(ledger)
    finite = manager_target()
    finite.target.update(expiresAt=NOW + 30, delegationExpiresAt=NOW + 30)
    review = prepare(ledger, "device.add-manager", {"target": finite.target}, now=NOW + 11)
    ack, _ = commit(ledger, review, target=finite, now=NOW + 11)
    finite.binding_id = verified(ledger, ack, "mutation-ack")["result"]["bindingId"]
    child = manager_target()
    with pytest.raises(evidence.BindingProtocolError, match="LIFETIME_EXCEEDED"):
        prepare(ledger, "device.add-manager", {"target": child.target}, device=finite, now=NOW + 12)
    assert ledger.authority.get_authorization(finite.binding_id, NOW + 29)["expiresAt"] == NOW + 30
    with pytest.raises(evidence.BindingProtocolError, match="ACCESS_DENIED"):
        ledger.authority.get_authorization(finite.binding_id, NOW + 30)
    assert read(ledger, "self-binding", device=finite, now=NOW + 30)["status"] == "suspended"


def test_target_signature_from_another_key_cannot_commit_or_consume_review(ledger):
    activate(ledger)
    target = manager_target()
    review = prepare(ledger, "device.add-manager", {"target": target.target}, now=NOW + 11)
    mutation = review["mutation"]
    bad_key = ec.generate_private_key(ec.SECP256R1())
    proofs = [
        protocol.sign_mutation(mutation, ledger.root.approval),
        protocol.sign_mutation(mutation, bad_key, purpose="target-access"),
        protocol.sign_mutation(mutation, target.approval, purpose="target-approval"),
        None,
        None,
    ]
    version = ledger.authority._meta()["rosterVersion"]
    with pytest.raises(evidence.BindingProtocolError, match="SIGNATURE_INVALID"):
        ledger.authority.commit_mutation(*proofs, NOW + 11)
    assert ledger.authority._meta()["rosterVersion"] == version
    assert ledger.authority._ledger._mutation(mutation["requestId"])["state"] == "prepared"
    commit(ledger, review, target=target, now=NOW + 11)


def test_v1_admission_and_v2_revoke_compete_on_one_database_checkpoint(ledger):
    activate(ledger)
    request = new_request(ledger.provisioned, ledger.authority, ledger.root, NOW + 11)
    submit(ledger.authority, request, NOW + 11)
    approve = approval_proof(ledger.root, request, NOW + 12)
    review = prepare(
        ledger,
        "device.revoke",
        {"bindingId": ledger.use.binding_id, "mode": "normal"},
        now=NOW + 12,
    )
    other = store.LocalTrustAuthority(ledger.provisioned.directory, boot_id="v2:boot")
    barrier = Barrier(2)

    def run(action):
        barrier.wait()
        try:
            return action()
        except evidence.BindingProtocolError as exc:
            return exc.code

    try:
        with ThreadPoolExecutor(2) as pool:
            first = pool.submit(
                run, lambda: other.approve_request(request.payload["requestId"], approve, NOW + 12)
            )
            second = pool.submit(run, lambda: commit(ledger, review, now=NOW + 12)[0])
            results = [first.result(), second.result()]
        assert sum(result.count(".") == 2 for result in results) == 1
        assert "LOCAL_BINDING_CONTEXT_MISMATCH" in results
    finally:
        other.close()
