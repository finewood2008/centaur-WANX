"""Real synthetic cloud signatures, dual device PoP and SQLite ledger commits."""

import copy
import os
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from test_local_authority_store import NOW
from test_local_ledger import (
    activate,
    actor,
    commit,
    manager_target,
    prepare,
    read,
    verified,
)
from test_local_ledger import ledger as _ledger
from test_local_ledger import provisioned as _provisioned

from wanx_bridge import local_ledger_engine as engine
from wanx_bridge import local_ledger_protocol as protocol
from wanx_bridge import local_management_protocol as wire
from wanx_bridge import local_team_protocol as team
from wanx_bridge import local_trust_protocol as evidence

pytestmark = pytest.mark.skipif(
    os.name != "posix", reason="Box authority requires POSIX private storage"
)


@pytest.fixture
def provisioned(tmp_path):
    return _provisioned.__wrapped__(tmp_path)


@pytest.fixture
def ledger(provisioned):
    yield from _ledger.__wrapped__(provisioned)


def cloud_key():
    key = ed25519.Ed25519PrivateKey.generate()
    policy = {
        "schemaVersion": 1,
        "type": "centuarai-team-identity-policy",
        "issuer": "nexusaos-platform",
        "audience": "centuarai-local-team-identity",
        "kid": "cloud:test",
        "publicKey": {
            "kty": "OKP",
            "crv": "Ed25519",
            "x": evidence._encode(
                key.public_key().public_bytes(
                    serialization.Encoding.Raw, serialization.PublicFormat.Raw
                )
            ),
        },
        "maximumProofLifetimeSeconds": 300,
    }
    return key, policy


def identity_proof(key, policy, request, *, subject="account:owner", now=NOW + 11, **overrides):
    value = {
        "schemaVersion": 1,
        "purpose": "centuarai.team.identity-association",
        "issuer": policy["issuer"],
        "audience": policy["audience"],
        "subject": subject,
        "jti": evidence._encode(os.urandom(32)),
        "issuedAt": now,
        "expiresAt": now + 300,
        **{
            name: request[name]
            for name in ("boxId", "boxKeyThumbprint", "ownershipEpoch", "invitationId")
        },
        "requestDigest": team.request_digest(request),
        "targetAccessKeyThumbprint": evidence.public_key_thumbprint(request["target"]["accessKey"]),
        "targetApprovalKeyThumbprint": evidence.public_key_thumbprint(
            request["target"]["approvalKey"]
        ),
        "clientId": "cloud:client",
        "clientKeyThumbprint": evidence._encode(bytes([1]) * 32),
        "nonce": evidence._encode(os.urandom(32)),
    }
    value.update(overrides)
    header = {"alg": "EdDSA", "typ": "centuarai-team-cloud-identity+jws", "kid": policy["kid"]}
    signing = (
        evidence._encode(wire.canonical(header)) + "." + evidence._encode(wire.canonical(value))
    )
    return signing + "." + evidence._encode(key.sign(signing.encode("ascii")))


def request(ledger, principal_id, target, invitation_id=None):
    context = ledger.authority._context(ledger.authority._meta())
    return {
        "schemaVersion": 1,
        "purpose": "centuarai.team-membership.request",
        **{key: context[key] for key in ("boxId", "boxKeyThumbprint", "ownershipEpoch")},
        "invitationId": invitation_id,
        "principalId": principal_id,
        "target": copy.deepcopy(target),
    }


def activate_team(ledger):
    activate(ledger)
    key, policy = cloud_key()
    ledger.authority.configure_team_identity(policy)
    snapshot = ledger.authority._v2().snapshot(ledger.authority._meta())
    row = engine.binding(snapshot, ledger.root.binding_id)
    target = {
        name: row[name]
        for name in (
            "clientId",
            "accessKey",
            "approvalKey",
            "capabilities",
            "expiresAt",
            "delegationExpiresAt",
        )
    }
    target.update(
        keyProtection="software-passphrase-v1",
        grants=sorted(
            engine.grant_list(engine.effective_grants(snapshot, row, NOW + 11))
            + [{"resourceId": "team:management", "actions": ["execute", "read", "write"]}],
            key=lambda item: item["resourceId"],
        ),
        delegableGrants=engine.grant_list(
            engine.effective_grants(snapshot, row, NOW + 11, delegation=True), delegate=True
        ),
    )
    value = request(ledger, row["principalId"], target)
    proof = identity_proof(key, policy, value)
    review = prepare(
        ledger,
        "team.activate",
        {"request": value, "cloudProof": proof, "cloudPolicy": policy},
        now=NOW + 11,
    )
    ack, _ = commit(ledger, review, target=ledger.root, now=NOW + 11)
    return SimpleNamespace(key=key, policy=policy, request=value, proof=proof, ack=ack)


@pytest.fixture
def team_ledger(ledger):
    ledger.team = activate_team(ledger)
    return ledger


def invite_member(ledger, *, role="member", now=NOW + 12, principal_id="principal:member"):
    target = manager_target(principal_id=principal_id)
    target.target["capabilities"] = sorted(protocol.INVITED_CAPABILITIES)
    if role == "manager":
        target.target["grants"] = sorted(
            target.target["grants"]
            + [{"resourceId": "team:management", "actions": ["execute", "read", "write"]}],
            key=lambda item: item["resourceId"],
        )
    invitation_id = evidence._encode(os.urandom(32))
    args = {
        "invitationId": invitation_id,
        "roleId": role,
        "targetPolicy": {key: target.target[key] for key in team.TARGET_POLICY_FIELDS},
        "expiresAt": now + 3600,
    }
    review = prepare(ledger, "team.invite-create", args, now=now)
    commit(ledger, review, now=now)
    target.request = request(ledger, principal_id, target.target, invitation_id)
    target.proof = identity_proof(
        ledger.team.key,
        ledger.team.policy,
        target.request,
        subject="account:" + principal_id,
        now=now + 1,
    )
    target.request_id = team.request_digest(target.request)
    return target


def admit_member(ledger, target, *, now=NOW + 13):
    ledger.authority.submit_team_request(
        team.sign_request(target.request, target.access),
        team.sign_request(target.request, target.approval, purpose="request-approval"),
        target.proof,
        now,
    )
    review = prepare(
        ledger,
        "team.member-admit",
        {"request": target.request, "cloudProof": target.proof},
        now=now,
    )
    proofs = [
        protocol.sign_mutation(review["mutation"], key, purpose=purpose)
        for key, purpose in ((target.access, "target-access"), (target.approval, "target-approval"))
    ]
    ledger.authority.consent_team_request(target.request_id, *proofs, now)
    ack, _ = commit(ledger, review, target=target, now=now)
    target.binding_id = verified(ledger, ack, "mutation-ack")["result"]["bindingId"]
    return ack


def test_cloud_team_activate_invite_consent_and_restart(team_ledger):
    ledger = team_ledger
    owner = ledger.authority.get_authorization(ledger.root.binding_id, NOW + 11)
    assert owner["team"]["roleId"] == "owner"
    assert "members.manage" in owner["team"]["permissions"]
    target = invite_member(ledger)
    ack = admit_member(ledger, target)
    auth = ledger.authority.get_authorization(target.binding_id, NOW + 14)
    assert auth["team"]["roleId"] == "member"
    assert auth["team"]["permissions"] == []
    assert auth["principalId"] != owner["principalId"]
    state = read(ledger, "team-state", now=NOW + 14)
    assert len(state["members"]) == 2 and state["invitations"][0]["status"] == "used"
    assert (
        ledger.authority._db.execute(
            "SELECT ack FROM requests WHERE request_id=?", (target.request_id,)
        ).fetchone()[0]
        == ack
    )
    directory = ledger.authority.directory
    ledger.authority.close()
    from wanx_bridge.local_authority_store import LocalTrustAuthority

    ledger.authority = LocalTrustAuthority(directory, boot_id="team:restart")
    ledger.authority.configure_team_identity(ledger.team.policy)
    assert ledger.authority.get_authorization(target.binding_id, NOW + 15)["team"] == auth["team"]


def test_cloud_proof_alone_and_legacy_invite_cannot_enroll(team_ledger):
    ledger = team_ledger
    target = invite_member(ledger)
    before = ledger.authority._meta()["rosterDigest"]
    with pytest.raises(evidence.BindingProtocolError):
        prepare(
            ledger,
            "team.member-admit",
            {"request": target.request, "cloudProof": target.proof},
            now=NOW + 13,
        )
    with pytest.raises(evidence.BindingProtocolError, match="CLOUD_IDENTITY_REQUIRED"):
        prepare(
            ledger,
            "principal.invite",
            {"principalId": target.request["principalId"], "target": target.target},
            now=NOW + 13,
        )
    assert ledger.authority._meta()["rosterDigest"] == before


@pytest.mark.parametrize(
    "field",
    [
        "boxId",
        "ownershipEpoch",
        "requestDigest",
        "targetAccessKeyThumbprint",
        "targetApprovalKeyThumbprint",
    ],
)
def test_wrong_cloud_context_rejected_without_pending_allocation(team_ledger, field):
    ledger = team_ledger
    target = invite_member(ledger)
    wrong = (
        "box:other"
        if field == "boxId"
        else 99
        if field == "ownershipEpoch"
        else evidence._encode(bytes([2]) * 32)
    )
    proof = identity_proof(
        ledger.team.key, ledger.team.policy, target.request, now=NOW + 13, **{field: wrong}
    )
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.submit_team_request(
            team.sign_request(target.request, target.access),
            team.sign_request(target.request, target.approval, purpose="request-approval"),
            proof,
            NOW + 13,
        )
    assert (
        ledger.authority._db.execute("SELECT count(*) FROM requests WHERE kind='team'").fetchone()[
            0
        ]
        == 0
    )


def test_suspend_member_closes_authority_and_cannot_demote_owner(team_ledger):
    ledger = team_ledger
    target = invite_member(ledger)
    admit_member(ledger, target)
    review = prepare(
        ledger, "team.member-suspend", {"principalId": target.request["principalId"]}, now=NOW + 14
    )
    commit(ledger, review, now=NOW + 14)
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.get_authorization(target.binding_id, NOW + 14)
    with pytest.raises(evidence.BindingProtocolError, match="LAST_MANAGER"):
        prepare(
            ledger,
            "team.member-role",
            {"principalId": ledger.root.payload["principalId"], "roleId": "member"},
            now=NOW + 14,
        )


def test_cloud_jti_accepts_full_digest_alphabet(team_ledger):
    ledger = team_ledger
    target = invite_member(ledger)
    value = identity_proof(
        ledger.team.key,
        ledger.team.policy,
        target.request,
        now=NOW + 13,
        jti=evidence._encode(bytes([255]) * 32),
    )
    assert team.verify_cloud(value, ledger.team.policy, target.request, NOW + 13)["jti"].startswith(
        "_"
    )


def test_cloud_pin_is_installation_policy_not_an_actor_selected_key(ledger):
    activate(ledger)
    original = ledger.authority._meta()["rosterDigest"]
    _, pinned = cloud_key()
    ledger.authority.configure_team_identity(pinned)
    key, attacker = cloud_key()
    target = manager_target(principal_id=ledger.root.payload["principalId"])
    value = request(ledger, target.payload["principalId"], target.target)
    proof = identity_proof(key, attacker, value)
    with pytest.raises(evidence.BindingProtocolError, match="IDENTITY_POLICY_REQUIRED"):
        prepare(
            ledger,
            "team.activate",
            {"request": value, "cloudProof": proof, "cloudPolicy": attacker},
            now=NOW + 11,
        )
    assert ledger.authority._meta()["rosterDigest"] == original


def test_wrong_target_final_signature_rolls_back_then_valid_retry_succeeds(team_ledger):
    ledger = team_ledger
    target = invite_member(ledger)
    ledger.authority.submit_team_request(
        team.sign_request(target.request, target.access),
        team.sign_request(target.request, target.approval, purpose="request-approval"),
        target.proof,
        NOW + 13,
    )
    review = prepare(
        ledger,
        "team.member-admit",
        {"request": target.request, "cloudProof": target.proof},
        now=NOW + 13,
    )
    before = ledger.authority._meta()["rosterDigest"]
    wrong = manager_target()
    with pytest.raises(evidence.BindingProtocolError):
        commit(ledger, review, target=wrong, now=NOW + 13)
    assert ledger.authority._meta()["rosterDigest"] == before
    commit(ledger, review, target=target, now=NOW + 13)


def test_invitation_revocation_cancels_pending_review(team_ledger):
    ledger = team_ledger
    target = invite_member(ledger)
    ledger.authority.submit_team_request(
        team.sign_request(target.request, target.access),
        team.sign_request(target.request, target.approval, purpose="request-approval"),
        target.proof,
        NOW + 13,
    )
    review = prepare(
        ledger,
        "team.member-admit",
        {"request": target.request, "cloudProof": target.proof},
        now=NOW + 13,
    )
    cancel = prepare(
        ledger, "team.invite-revoke", {"invitationId": target.request["invitationId"]}, now=NOW + 13
    )
    commit(ledger, cancel, now=NOW + 13)
    with pytest.raises(evidence.BindingProtocolError):
        commit(ledger, review, target=target, now=NOW + 13)
    assert (
        ledger.authority._db.execute(
            "SELECT state FROM requests WHERE request_id=?", (target.request_id,)
        ).fetchone()[0]
        == "expired"
    )


def test_request_read_requires_target_key_and_final_receipt_is_delivered(team_ledger):
    ledger = team_ledger
    target = invite_member(ledger)
    ack = admit_member(ledger, target)
    context = ledger.authority._meta()
    value = {
        "schemaVersion": 1,
        "purpose": "centuarai.team-request.read",
        **{key: context[key] for key in ("boxId", "boxKeyThumbprint", "ownershipEpoch")},
        "requestId": target.request_id,
        "nonce": evidence._encode(os.urandom(32)),
        "issuedAt": NOW + 14,
        "expiresAt": NOW + 74,
    }
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.read_team_request(
            team.sign_request_read(value, ledger.root.access), NOW + 14
        )
    result = verified(
        ledger,
        ledger.authority.read_team_request(team.sign_request_read(value, target.access), NOW + 14),
        "team-request",
    )
    assert result["state"] == "approved" and result["receipt"] == ack


def test_manager_cannot_self_promote_or_invite_members(team_ledger):
    ledger = team_ledger
    target = invite_member(ledger, role="manager")
    admit_member(ledger, target)
    target.payload["principalId"] = target.request["principalId"]
    assert ledger.authority.get_authorization(target.binding_id, NOW + 14)["team"][
        "permissions"
    ] == ["applications.manage", "members.read", "resources.manage"]
    with pytest.raises(evidence.BindingProtocolError):
        prepare(
            ledger,
            "team.member-role",
            {"principalId": target.request["principalId"], "roleId": "manager"},
            device=target,
            now=NOW + 14,
        )


def test_exact_shared_acl_needs_explicit_device_grant_and_dual_pop(team_ledger):
    ledger = team_ledger
    owner_id = ledger.root.payload["principalId"]
    resource = "team:application:company-test"
    review = prepare(
        ledger,
        "team.resource-set",
        {
            "resourceId": resource,
            "expectedRevision": 0,
            "grants": [{"principalId": owner_id, "actions": ["execute", "read", "write"]}],
        },
        now=NOW + 12,
    )
    commit(ledger, review, now=NOW + 12)
    before = ledger.authority.get_authorization(ledger.root.binding_id, NOW + 12)
    assert resource not in [row["resourceId"] for row in before["grants"]]
    desired = sorted(
        before["grants"] + [{"resourceId": resource, "actions": ["execute", "read"]}],
        key=lambda row: row["resourceId"],
    )
    args = {
        "principalId": owner_id,
        "bindingId": ledger.root.binding_id,
        "expectedBindingRevision": before["bindingRevision"],
        "grants": desired,
    }
    review = prepare(ledger, "team.device-resources", args, now=NOW + 12)
    with pytest.raises(evidence.BindingProtocolError):
        commit(ledger, review, now=NOW + 12)
    commit(ledger, review, target=ledger.root, now=NOW + 12)
    after = ledger.authority.get_authorization(ledger.root.binding_id, NOW + 12)
    assert after["grants"] == desired and after["bindingRevision"] == before["bindingRevision"] + 1
    wrong = {
        **args,
        "expectedBindingRevision": after["bindingRevision"],
        "grants": sorted(
            desired + [{"resourceId": "wanx", "actions": ["execute", "read", "write"]}],
            key=lambda row: row["resourceId"],
        ),
    }
    with pytest.raises(evidence.BindingProtocolError):
        prepare(ledger, "team.device-resources", wrong, now=NOW + 12)
    revoke = prepare(
        ledger,
        "team.resource-set",
        {"resourceId": resource, "expectedRevision": 1, "grants": []},
        now=NOW + 13,
    )
    commit(ledger, revoke, now=NOW + 13)
    assert resource not in [
        row["resourceId"]
        for row in ledger.authority.get_authorization(ledger.root.binding_id, NOW + 13)["grants"]
    ]


def test_two_sqlite_connections_cannot_consume_one_invite_twice(team_ledger):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from wanx_bridge.local_authority_store import LocalTrustAuthority

    ledger = team_ledger
    first = invite_member(ledger)
    second = manager_target(principal_id="principal:other")
    second.target["capabilities"] = sorted(protocol.INVITED_CAPABILITIES)
    second.request = request(
        ledger, second.payload["principalId"], second.target, first.request["invitationId"]
    )
    second.proof = identity_proof(
        ledger.team.key, ledger.team.policy, second.request, subject="account:other", now=NOW + 13
    )
    reviews = []
    for target in (first, second):
        ledger.authority.submit_team_request(
            team.sign_request(target.request, target.access),
            team.sign_request(target.request, target.approval, purpose="request-approval"),
            target.proof,
            NOW + 13,
        )
        reviews.append(
            prepare(
                ledger,
                "team.member-admit",
                {"request": target.request, "cloudProof": target.proof},
                now=NOW + 13,
            )
        )
    other = LocalTrustAuthority(ledger.authority.directory, boot_id=ledger.authority._boot_id)
    other.configure_team_identity(ledger.team.policy)
    barrier = Barrier(2)

    def run(index):
        barrier.wait()
        try:
            commit(
                ledger,
                reviews[index],
                target=(first, second)[index],
                authority=(ledger.authority, other)[index],
                now=NOW + 13,
            )
            return "committed"
        except evidence.BindingProtocolError:
            return "rejected"

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(run, range(2))) == ["committed", "rejected"]
        assert len(read(ledger, "team-state", now=NOW + 14)["members"]) == 2
    finally:
        other.close()


def test_migration_requires_current_signed_permit_and_root_complete_journal(
    team_ledger, monkeypatch
):
    from centuarai_local_data_gate.protocol import principal_namespace

    from wanx_bridge import local_team_migration as migration

    ledger = team_ledger
    auth = ledger.authority.get_authorization(ledger.root.binding_id, NOW + 12)
    args = {
        "principalId": auth["principalId"],
        "membershipId": auth["team"]["membershipId"],
        "planDigest": evidence._encode(os.urandom(32)),
        "sourceUserId": 17,
        "targetNamespace": principal_namespace(
            auth["boxKeyThumbprint"], auth["ownershipEpoch"], auth["principalId"]
        ),
        "targetBindingId": auth["bindingId"],
        "expiresAt": NOW + 200,
    }
    review = prepare(ledger, "team.migration-authorize", args, now=NOW + 12)
    commit(ledger, review, target=ledger.root, now=NOW + 12)
    request_id = review["mutation"]["requestId"]
    permit = migration.verify_team_migration_permit_readonly(
        ledger.authority._db, ledger.provisioned.bundle, request_id, args["planDigest"], NOW + 12
    )
    assert permit["sourceUserId"] == 17
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.consume_team_migration(request_id, args["planDigest"], NOW + 12)
    # Only the filesystem verification seam is replaced here; the real permit,
    # SQLite transaction, signing and replay checks remain active.
    monkeypatch.setattr(migration, "_journal", lambda digest: {**permit, "phase": "complete"})
    with pytest.raises(evidence.BindingProtocolError):
        migration.verify_team_migration_permit_readonly(
            ledger.authority._db,
            ledger.provisioned.bundle,
            request_id,
            args["planDigest"],
            NOW + 201,
        )
    receipt = ledger.authority.consume_team_migration(request_id, args["planDigest"], NOW + 201)
    assert verified(ledger, receipt, "migration-consumed")["requestId"] == request_id
    assert (
        ledger.authority.consume_team_migration(request_id, args["planDigest"], NOW + 500)
        == receipt
    )
    with pytest.raises(evidence.BindingProtocolError):
        migration.verify_team_migration_permit_readonly(
            ledger.authority._db,
            ledger.provisioned.bundle,
            request_id,
            args["planDigest"],
            NOW + 500,
        )


def test_role_does_not_replace_approved_device_management_scope(team_ledger):
    ledger = team_ledger
    auth = ledger.authority.get_authorization(ledger.root.binding_id, NOW + 12)
    private = [grant for grant in auth["grants"] if grant["resourceId"] != "team:management"]
    args = {
        "principalId": auth["principalId"],
        "bindingId": auth["bindingId"],
        "expectedBindingRevision": auth["bindingRevision"],
        "grants": private,
    }
    review = prepare(ledger, "team.device-resources", args, now=NOW + 12)
    commit(ledger, review, target=ledger.root, now=NOW + 12)
    after = ledger.authority.get_authorization(ledger.root.binding_id, NOW + 12)
    assert after["team"]["roleId"] == "owner" and after["team"]["permissions"] == []
    with pytest.raises(evidence.BindingProtocolError):
        read(ledger, "team-state", now=NOW + 12)
    with pytest.raises(evidence.BindingProtocolError):
        prepare(
            ledger,
            "team.resource-set",
            {"resourceId": "team:application:denied", "expectedRevision": 0, "grants": []},
            now=NOW + 12,
        )
    # Recovery of the explicitly removed device ceiling still needs its two keys.
    args.update(expectedBindingRevision=after["bindingRevision"], grants=auth["grants"])
    restore = prepare(ledger, "team.device-resources", args, now=NOW + 12)
    with pytest.raises(evidence.BindingProtocolError):
        commit(ledger, restore, now=NOW + 12)
    commit(ledger, restore, target=ledger.root, now=NOW + 12)
    assert (
        "members.manage"
        in ledger.authority.get_authorization(ledger.root.binding_id, NOW + 12)["team"][
            "permissions"
        ]
    )


def test_association_revision_persists_and_revoked_cloud_identity_is_terminal(team_ledger):
    ledger = team_ledger
    target = invite_member(ledger)
    admit_member(ledger, target)
    membership = ledger.authority.get_authorization(target.binding_id, NOW + 14)["team"][
        "membershipId"
    ]
    before = read(ledger, "team-association", request_id=membership, now=NOW + 14)["receipt"]
    before = team.verify_association(before, ledger.provisioned.bundle["boxKey"])
    review = prepare(
        ledger, "team.member-revoke", {"principalId": target.request["principalId"]}, now=NOW + 14
    )
    commit(ledger, review, now=NOW + 14)
    receipt = read(ledger, "team-association", request_id=membership, now=NOW + 15)["receipt"]
    after = team.verify_association(receipt, ledger.provisioned.bundle["boxKey"])
    assert (
        after["status"] == "revoked" and after["membershipRevision"] > before["membershipRevision"]
    )
    later = team.verify_association(
        read(ledger, "team-association", request_id=membership, now=NOW + 16)["receipt"],
        ledger.provisioned.bundle["boxKey"],
    )
    assert later["membershipRevision"] == after["membershipRevision"]
    replacement = invite_member(ledger, now=NOW + 17, principal_id="principal:replacement")
    replacement.proof = identity_proof(
        ledger.team.key,
        ledger.team.policy,
        replacement.request,
        subject=before["subject"],
        now=NOW + 18,
    )
    with pytest.raises(evidence.BindingProtocolError, match="IDENTITY_CONFLICT"):
        ledger.authority.submit_team_request(
            team.sign_request(replacement.request, replacement.access),
            team.sign_request(
                replacement.request, replacement.approval, purpose="request-approval"
            ),
            replacement.proof,
            NOW + 18,
        )


def test_team_request_large_response_does_not_expand_ordinary_proofs(team_ledger):
    ledger = team_ledger
    target = invite_member(ledger)
    ledger.authority.submit_team_request(
        team.sign_request(target.request, target.access),
        team.sign_request(target.request, target.approval, purpose="request-approval"),
        target.proof,
        NOW + 13,
    )
    review = prepare(
        ledger,
        "team.member-admit",
        {"request": target.request, "cloudProof": target.proof},
        now=NOW + 13,
    )
    proofs = [
        protocol.sign_mutation(review["mutation"], key, purpose=purpose)
        for key, purpose in ((target.access, "target-access"), (target.approval, "target-approval"))
    ]
    ledger.authority.consent_team_request(target.request_id, *proofs, NOW + 13)
    from wanx_bridge.local_team_service import TeamService

    body = TeamService(ledger.authority).request_body(target.request_id, NOW + 13)
    response = protocol.sign_response(ledger.authority, "team-request", body, NOW + 13)
    assert 16384 < len(response) <= 65536
    assert verified(ledger, response, "team-request")["targetAccessProof"] == proofs[0]
    with pytest.raises(evidence.BindingProtocolError):
        wire._decode(
            response, "centuarai-local-team-request-response+jws", protocol.validate_response
        )
    with pytest.raises(evidence.BindingProtocolError):
        verified(ledger, response, "mutation-review")
    with pytest.raises(evidence.BindingProtocolError):
        verified(ledger, response + "x" * 65536, "team-request")


def test_verified_full_erase_does_not_retain_team_identity_in_new_epoch(team_ledger):
    from test_local_ledger_transfer import SyntheticOS, transfer_args

    from wanx_bridge.local_authority_store import LocalTrustAuthority

    ledger = team_ledger
    provider = SyntheticOS(ledger.provisioned.bundle)
    ledger.authority.configure_transfer_provider(provider)
    args = transfer_args(ledger)
    review = prepare(ledger, "ownership.transfer-prepare", args, now=NOW + 12)
    commit(ledger, review, now=NOW + 12)
    ledger.authority.mark_erase_started(args["transferId"], "fixture:valid-plan", NOW + 13)
    ledger.authority.complete_verified_redelivery(
        args["transferId"],
        "fixture:full-erase-data-empty",
        "fixture:durable-private-delivery",
        NOW + 14,
    )
    assert "team" not in ledger.authority._meta()
    directory = ledger.authority.directory
    ledger.authority.close()
    ledger.authority = LocalTrustAuthority(directory, boot_id="team:new-epoch")
    ledger.authority.configure_team_identity(ledger.team.policy)
    assert ledger.authority._meta()["ownershipEpoch"] == 2
    assert "team" not in ledger.authority._v2().snapshot(ledger.authority._meta())
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.get_authorization(ledger.root.binding_id, NOW + 15)


def test_pending_invitation_capacity_and_expiry_cannot_lock_management(team_ledger):
    ledger = team_ledger
    first = invite_member(ledger)
    targets = [first]
    for index in range(2):
        target = manager_target(principal_id=f"principal:pending{index}")
        target.target["capabilities"] = sorted(protocol.INVITED_CAPABILITIES)
        target.request = request(
            ledger, target.payload["principalId"], target.target, first.request["invitationId"]
        )
        target.proof = identity_proof(
            ledger.team.key,
            ledger.team.policy,
            target.request,
            subject=f"account:pending{index}",
            now=NOW + 13,
        )
        targets.append(target)
    for target in targets[:2]:
        ledger.authority.submit_team_request(
            team.sign_request(target.request, target.access),
            team.sign_request(target.request, target.approval, purpose="request-approval"),
            target.proof,
            NOW + 13,
        )
    third = targets[2]
    with pytest.raises(evidence.BindingProtocolError, match="CAPACITY"):
        ledger.authority.submit_team_request(
            team.sign_request(third.request, third.access),
            team.sign_request(third.request, third.approval, purpose="request-approval"),
            third.proof,
            NOW + 13,
        )
    before = ledger.authority._meta()["rosterDigest"]
    review = prepare(
        ledger,
        "team.member-admit",
        {"request": first.request, "cloudProof": first.proof},
        now=NOW + 13,
    )
    with pytest.raises(evidence.BindingProtocolError):
        commit(ledger, review, target=first, now=NOW + 313)
    assert ledger.authority._meta()["rosterDigest"] == before
    assert (
        ledger.authority._db.execute(
            "SELECT count(*) FROM requests WHERE kind='team' AND state='pending'"
        ).fetchone()[0]
        == 0
    )
    revoke = prepare(
        ledger, "team.invite-revoke", {"invitationId": first.request["invitationId"]}, now=NOW + 313
    )
    commit(ledger, revoke, now=NOW + 313)
    assert read(ledger, "team-state", now=NOW + 313)["invitations"][0]["status"] == "revoked"


@pytest.mark.asyncio
async def test_http_invalid_request_flood_does_not_consume_authenticated_management_pool(
    team_ledger,
):
    import httpx

    from wanx_bridge.local_trust_server import create_app
    from wanx_bridge.local_trust_service import LocalTrustService

    ledger = team_ledger
    service = LocalTrustService(ledger.authority, clock=lambda: NOW + 12, budget_clock=lambda: 1)
    app = create_app(service, authority="box.test")
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://box.test"
        ) as client:
            for _ in range(120):
                response = await client.post(
                    "/local-trust/v2/team/requests",
                    json={
                        "requestProof": "invalid",
                        "approvalProof": "invalid",
                        "cloudProof": "invalid",
                    },
                )
                assert response.status_code == 400
                assert response.headers["cache-control"] == "no-store"
            assert (
                await client.post(
                    "/local-trust/v2/team/requests",
                    json={
                        "requestProof": "invalid",
                        "approvalProof": "invalid",
                        "cloudProof": "invalid",
                    },
                )
            ).status_code == 429
            assert (
                ledger.authority._db.execute(
                    "SELECT count(*) FROM requests WHERE kind='team'"
                ).fetchone()[0]
                == 0
            )
            meta = ledger.authority._meta()
            proof = protocol.sign_auth_challenge(
                {
                    "schemaVersion": 2,
                    "purpose": "centuarai.local-ledger.auth-challenge",
                    **{
                        name: meta[name] for name in ("boxId", "boxKeyThumbprint", "ownershipEpoch")
                    },
                    "actor": actor(ledger.root),
                    "clientNonce": evidence._encode(os.urandom(32)),
                    "issuedAt": NOW + 12,
                    "expiresAt": NOW + 72,
                },
                ledger.root.access,
            )
            response = await client.post(
                "/local-trust/v2/authenticated-challenge", json={"proof": proof}
            )
            assert response.status_code == 200
            challenge = verified(ledger, response.text, "read-challenge")
            value = {
                "schemaVersion": 2,
                "purpose": "centuarai.local-ledger.read",
                **{name: meta[name] for name in ("boxId", "boxKeyThumbprint", "ownershipEpoch")},
                "nonce": challenge["nonce"],
                "issuedAt": NOW + 12,
                "expiresAt": NOW + 72,
                "actor": actor(ledger.root),
                "operation": "team-state",
                "requestId": None,
                "bindingId": None,
            }
            response = await client.post(
                "/local-trust/v2/read",
                json={"proof": protocol.sign_read(value, ledger.root.access)},
            )
            assert response.status_code == 200
            assert len(verified(ledger, response.text, "team-state")["members"]) == 1
            denied = await client.post(
                "/local-trust/v2/team/policy",
                json={},
                headers={"Authorization": "Bearer old-native-token"},
            )
            assert denied.status_code == 403
    finally:
        await service.close()


def test_member_scope_handoff_exposes_only_own_acl_and_request_bound_target_keys(team_ledger):
    ledger = team_ledger
    target = invite_member(ledger)
    admit_member(ledger, target)
    resource = "team:knowledge:member-library"
    acl = prepare(
        ledger,
        "team.resource-set",
        {
            "resourceId": resource,
            "expectedRevision": 0,
            "grants": [
                {"principalId": target.request["principalId"], "actions": ["read", "write"]}
            ],
        },
        now=NOW + 14,
    )
    commit(ledger, acl, now=NOW + 14)
    own = read(ledger, "self-resources", device=target, now=NOW + 14)
    assert own["availableGrants"] == [{"resourceId": resource, "actions": ["read", "write"]}]
    assert resource not in [
        grant["resourceId"]
        for grant in read(ledger, "self-resources", now=NOW + 14)["availableGrants"]
    ]
    desired = sorted(
        own["approvedGrants"] + [{"resourceId": resource, "actions": ["read"]}],
        key=lambda grant: grant["resourceId"],
    )
    args = {
        "principalId": own["principalId"],
        "bindingId": own["bindingId"],
        "expectedBindingRevision": own["bindingRevision"],
        "grants": desired,
    }
    review = prepare(ledger, "team.device-resources", args, now=NOW + 14)
    request_id = review["mutation"]["requestId"]
    for device in (ledger.root, target):
        keys = read(
            ledger, "team-device-review", device=device, request_id=request_id, now=NOW + 14
        )
        assert keys["mutationDigest"] == wire.digest(review["mutation"])
        assert keys["target"]["accessKey"] == target.target["accessKey"]
        assert keys["target"]["approvalKey"] == target.target["approvalKey"]
    with pytest.raises(evidence.BindingProtocolError):
        read(ledger, "team-device-review", device=ledger.use, request_id=request_id, now=NOW + 14)
    with pytest.raises(evidence.BindingProtocolError):
        commit(ledger, review, target=ledger.root, now=NOW + 14)
    commit(ledger, review, target=target, now=NOW + 14)
    assert ledger.authority.get_authorization(target.binding_id, NOW + 14)["grants"] == desired
    with pytest.raises(evidence.BindingProtocolError):
        read(ledger, "team-device-review", request_id=request_id, now=NOW + 14)


def test_use_device_cannot_self_approve_but_can_cosign_exact_owner_review(team_ledger):
    ledger = team_ledger
    resource = "team:space:use-device-space"
    principal_id = ledger.root.payload["principalId"]
    acl = prepare(
        ledger,
        "team.resource-set",
        {
            "resourceId": resource,
            "expectedRevision": 0,
            "grants": [{"principalId": principal_id, "actions": ["read"]}],
        },
        now=NOW + 12,
    )
    commit(ledger, acl, now=NOW + 12)
    own = read(ledger, "self-resources", device=ledger.use, now=NOW + 12)
    args = {
        "principalId": principal_id,
        "bindingId": ledger.use.binding_id,
        "expectedBindingRevision": own["bindingRevision"],
        "grants": sorted(
            own["approvedGrants"] + [{"resourceId": resource, "actions": ["read"]}],
            key=lambda grant: grant["resourceId"],
        ),
    }
    with pytest.raises(evidence.BindingProtocolError):
        prepare(ledger, "team.device-resources", args, device=ledger.use, now=NOW + 12)
    review = prepare(ledger, "team.device-resources", args, now=NOW + 12)
    keys = read(
        ledger,
        "team-device-review",
        device=ledger.use,
        request_id=review["mutation"]["requestId"],
        now=NOW + 12,
    )["target"]
    assert keys["role"] == "use" and keys["approvalKey"] is None
    mutation = review["mutation"]
    owner_proof = protocol.sign_mutation(mutation, ledger.root.approval)
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.commit_mutation(owner_proof, None, None, None, None, NOW + 12)
    target_proof = protocol.sign_mutation(mutation, ledger.use.access, purpose="target-access")
    ledger.authority.commit_mutation(owner_proof, target_proof, None, None, None, NOW + 12)
    assert (
        ledger.authority.get_authorization(ledger.use.binding_id, NOW + 12)["grants"]
        == args["grants"]
    )


def test_shared_acl_effect_capture_includes_other_principals_and_device_descendants(team_ledger):
    from wanx_bridge.local_data_protocol import verify_data_response

    ledger = team_ledger
    target = invite_member(ledger)
    admit_member(ledger, target)
    review = prepare(
        ledger,
        "team.resource-set",
        {
            "resourceId": "team:space:effect-test",
            "expectedRevision": 0,
            "grants": [{"principalId": target.request["principalId"], "actions": ["read"]}],
        },
        now=NOW + 14,
    )
    commit(ledger, review, now=NOW + 14)
    request_id = review["mutation"]["requestId"]
    observed = ledger.authority.get_effect_commit(request_id)
    assert observed["targetScope"] == {"kind": "ownership", "id": "box:test"}
    assert {ledger.root.binding_id, ledger.use.binding_id, target.binding_id} <= set(
        observed["affectedBindingIds"]
    )
    challenge = verified(ledger, ledger.authority.auth_challenge_v2(NOW + 14), "read-challenge")
    value = {
        "schemaVersion": 2,
        "purpose": "centuarai.local-ledger.read",
        **{
            name: challenge["context"][name]
            for name in ("boxId", "boxKeyThumbprint", "ownershipEpoch")
        },
        "nonce": challenge["nonce"],
        "issuedAt": NOW + 14,
        "expiresAt": NOW + 74,
        "actor": actor(ledger.root),
        "operation": "data-effect",
        "requestId": request_id,
        "bindingId": None,
    }
    signed = ledger.authority.read_v2(protocol.sign_read(value, ledger.root.access), NOW + 14)
    body = verify_data_response(
        signed,
        ledger.provisioned.bundle["boxKey"],
        box_id="box:test",
        kind="effect",
        now_ms=(NOW + 14) * 1000,
    )["body"]
    assert body["targetScope"] == observed["targetScope"] and body["effectState"] == "unknown"
    auth = ledger.authority.get_authorization(ledger.root.binding_id, NOW + 14)
    extension = prepare(
        ledger,
        "team.device-resources",
        {
            "principalId": auth["principalId"],
            "bindingId": auth["bindingId"],
            "expectedBindingRevision": auth["bindingRevision"],
            "grants": auth["grants"],
        },
        now=NOW + 14,
    )
    commit(ledger, extension, target=ledger.root, now=NOW + 14)
    observed = ledger.authority.get_effect_commit(extension["mutation"]["requestId"])
    assert observed["targetScope"] == {"kind": "binding", "id": ledger.root.binding_id}
    assert ledger.use.binding_id in observed["affectedBindingIds"]


@pytest.mark.parametrize(
    "action",
    [
        "team.member-revoke",
        "team.member-suspend",
        "team.invite-revoke",
        "ownership.transfer-prepare",
    ],
)
def test_capacity_rejects_growth_but_never_locks_security_tightening(team_ledger, action):
    from test_local_ledger_transfer import SyntheticOS, transfer_args

    from wanx_bridge.local_authority_store import LocalTrustAuthority

    ledger = team_ledger
    member = invite_member(ledger)
    admit_member(ledger, member)
    accepted = []
    for index in range(128):
        now = NOW + 20 + index
        before = ledger.authority._meta()["rosterDigest"]
        try:
            invitation = invite_member(ledger, now=now, principal_id=f"principal:capacity{index}")
            accepted.append(invitation.request["invitationId"])
        except evidence.BindingProtocolError as exc:
            assert exc.code == "LOCAL_TRUST_CAPACITY"
            assert ledger.authority._meta()["rosterDigest"] == before
            break
    else:
        pytest.fail("projection capacity should reject growth before unbounded history")
    assert accepted
    state = read(ledger, "team-state", now=now)
    assert len(state["invitations"]) == len(accepted) + 1
    if action.startswith("team.member-"):
        args = {"principalId": member.request["principalId"]}
    elif action == "team.invite-revoke":
        args = {"invitationId": accepted[-1]}
    else:
        ledger.authority.configure_transfer_provider(SyntheticOS(ledger.provisioned.bundle))
        args = transfer_args(ledger)
    review = prepare(ledger, action, args, now=now)
    ack, _ = commit(ledger, review, now=now)
    assert verified(ledger, ack, "mutation-ack")["action"] == action
    if action == "ownership.transfer-prepare":
        ledger.authority.mark_erase_started(args["transferId"], "fixture:valid-plan", now)
        ledger.authority.complete_verified_redelivery(
            args["transferId"],
            "fixture:full-erase-data-empty",
            "fixture:durable-private-delivery",
            now,
        )
        assert "team" not in ledger.authority._meta()
    else:
        after = read(ledger, "team-state", now=now)
        if action == "team.invite-revoke":
            assert (
                next(row for row in after["invitations"] if row["invitationId"] == accepted[-1])[
                    "status"
                ]
                == "revoked"
            )
        else:
            expected = "revoked" if action.endswith("revoke") else "suspended"
            assert (
                next(
                    row
                    for row in after["members"]
                    if row["principalId"] == member.request["principalId"]
                )["status"]
                == expected
            )
            with pytest.raises(evidence.BindingProtocolError):
                ledger.authority.get_authorization(member.binding_id, now)
    directory = ledger.authority.directory
    ledger.authority.close()
    ledger.authority = LocalTrustAuthority(directory, boot_id="team:capacity-restart")
    ledger.authority.configure_team_identity(ledger.team.policy)
    if action != "ownership.transfer-prepare":
        assert read(ledger, "team-state", now=now) == after


@pytest.mark.parametrize("action", ["team.member-suspend", "team.member-revoke"])
def test_member_hard_limit_or_projection_limit_never_blocks_removal(team_ledger, action):
    ledger = team_ledger
    members = []
    for index in range(32):
        now = NOW + 20 + index * 3
        before = ledger.authority._meta()["rosterDigest"]
        try:
            target = invite_member(ledger, now=now, principal_id=f"principal:member-limit{index}")
        except evidence.BindingProtocolError as exc:
            assert exc.code == "LOCAL_TRUST_CAPACITY"
            assert ledger.authority._meta()["rosterDigest"] == before
            break
        before = ledger.authority._meta()["rosterDigest"]
        now += 1
        try:
            admit_member(ledger, target, now=now)
        except evidence.BindingProtocolError as exc:
            assert exc.code == "LOCAL_TRUST_CAPACITY"
            assert ledger.authority._meta()["rosterDigest"] == before
            break
        members.append(target)
    else:
        pytest.fail("the explicit member hard limit must reject growth")
    assert members and len(members) < 32
    target = members[-1]
    review = prepare(ledger, action, {"principalId": target.request["principalId"]}, now=now)
    commit(ledger, review, now=now)
    state = read(ledger, "team-state", now=now)
    assert next(
        row for row in state["members"] if row["principalId"] == target.request["principalId"]
    )["status"] == ("revoked" if action.endswith("revoke") else "suspended")
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.get_authorization(target.binding_id, now)
