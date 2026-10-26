"""Real ledger and HTTP admission: anonymous floods cannot exhaust held-key slots."""

import os
from contextlib import asynccontextmanager

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from test_local_authority_store import approval_proof, new_request, submit
from test_local_backup_io import FixtureIO
from test_local_ledger import (
    NOW,
    activate,
    actor,
    manager_target,
    verified,
)
from test_local_ledger import (
    ledger as _ledger,
)
from test_local_ledger import (
    provisioned as _provisioned,
)

from wanx_bridge import local_backup_io as backup
from wanx_bridge import local_ledger_protocol as protocol
from wanx_bridge import local_management_protocol as wire
from wanx_bridge import local_trust_protocol as evidence
from wanx_bridge.local_trust_server import create_app
from wanx_bridge.local_trust_service import LocalTrustService

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Private ledger requires POSIX")
NOW_HTTP = NOW + 11
AUTH_PATH = "/local-trust/v2/authenticated-challenge"


@pytest.fixture
def provisioned(tmp_path):
    return _provisioned.__wrapped__(tmp_path)


@pytest.fixture
def ledger(provisioned):
    yield from _ledger.__wrapped__(provisioned)


def challenge_proof(ledger, device, *, identity=None, key=None):
    value = {
        "schemaVersion": 2,
        "purpose": "centuarai.local-ledger.auth-challenge",
        "boxId": "box:test",
        "boxKeyThumbprint": evidence.public_key_thumbprint(ledger.provisioned.bundle["boxKey"]),
        "ownershipEpoch": 1,
        "actor": identity or actor(device),
        "clientNonce": evidence._encode(os.urandom(32)),
        "issuedAt": NOW_HTTP,
        "expiresAt": NOW_HTTP + 60,
    }
    return protocol.sign_auth_challenge(value, key or device.access)


def read_proof(challenge, device):
    return protocol.sign_read(
        {
            "schemaVersion": 2,
            "purpose": "centuarai.local-ledger.read",
            "boxId": "box:test",
            "boxKeyThumbprint": challenge["context"]["boxKeyThumbprint"],
            "ownershipEpoch": challenge["context"]["ownershipEpoch"],
            "nonce": challenge["nonce"],
            "issuedAt": challenge["issuedAt"],
            "expiresAt": challenge["expiresAt"],
            "actor": actor(device),
            "operation": "self-binding",
            "requestId": None,
            "bindingId": device.binding_id,
        },
        device.access,
    )


@asynccontextmanager
async def runtime(ledger):
    service = LocalTrustService(ledger.authority, clock=lambda: NOW_HTTP, budget_clock=lambda: 1)
    app = create_app(service, authority="box.test")
    try:
        yield app, service
    finally:
        await service.close()


def connection(app, source="198.51.100.1"):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=(source, 12345)), base_url="https://box.test"
    )


@pytest.mark.asyncio
async def test_anonymous_128_slot_flood_does_not_block_bound_management_or_backup(ledger):
    activate(ledger)
    provider = FixtureIO()
    ledger.authority.configure_operation_provider(provider)
    async with runtime(ledger) as (app, service):
        for source, count in (("198.51.100.1", 60), ("198.51.100.2", 60), ("198.51.100.3", 8)):
            async with connection(app, source) as client:
                for _ in range(count):
                    result = await client.post("/local-trust/v2/auth/challenge", json={})
                    assert result.status_code == 200
        async with connection(app, "198.51.100.4") as client:
            denied = await client.post("/local-trust/v2/auth/challenge", json={})
            assert denied.status_code == 429
        # Same source whose anonymous HTTP budget is already exhausted.
        async with connection(app) as client:
            for device in (ledger.root, ledger.use):
                response = await client.post(
                    AUTH_PATH, json={"proof": challenge_proof(ledger, device)}
                )
                assert response.status_code == 200, response.text
                challenge = verified(ledger, response.text, "read-challenge")
                response = await client.post(
                    "/local-trust/v2/read", json={"proof": read_proof(challenge, device)}
                )
                assert response.status_code == 200, response.text
                verified(ledger, response.text, "self-binding")
            response = await client.post(
                AUTH_PATH, json={"proof": challenge_proof(ledger, ledger.root)}
            )
            challenge = verified(ledger, response.text, "read-challenge")
            payload = {
                "schemaVersion": 1,
                "purpose": "centuarai.local-backup.io",
                "boxId": "box:test",
                "boxKeyThumbprint": challenge["context"]["boxKeyThumbprint"],
                "ownershipEpoch": 1,
                "principalSecurityVersion": 1,
                "nonce": challenge["nonce"],
                "issuedAt": NOW_HTTP,
                "expiresAt": NOW_HTTP + 60,
                "actor": actor(ledger.root),
                "operation": "targets.list",
                "bodySha256": wire.digest({}),
            }
            proof = wire._sign(payload, ledger.root.access, backup.PROOF_TYPE, backup.proof_schema)
            response = await client.post(
                "/local-trust/v2/backup-io/targets.list", json={"body": {}, "proof": proof}
            )
            assert response.status_code == 200, response.text
            backup.verify_response(
                response.json(),
                ledger.provisioned.bundle["boxKey"],
                box_id="box:test",
                operation="targets.list",
                nonce=payload["nonce"],
                request={},
            )
            assert len(provider.calls) == 1
        assert service._sources["nonce"]["198.51.100.1"][1] == 60
        assert service._sources["authenticated_nonce"]["198.51.100.1"][1] == 3


@pytest.mark.asyncio
async def test_forged_identity_never_reserves_an_authenticated_nonce(ledger):
    activate(ledger)
    wrong_key = ec.generate_private_key(ec.SECP256R1())
    unknown = {**actor(ledger.root), "bindingId": evidence._encode(os.urandom(32))}
    async with runtime(ledger) as (app, _), connection(app) as client:
        for proof in (
            challenge_proof(ledger, ledger.root, key=wrong_key),
            challenge_proof(ledger, ledger.root, identity=unknown),
        ):
            response = await client.post(AUTH_PATH, json={"proof": proof})
            assert response.status_code == 403, response.text
            assert response.json() == {"code": "LOCAL_TRUST_CHALLENGE_DENIED"}
        assert (
            ledger.authority._db.execute(
                "SELECT count(*) FROM challenges WHERE kind LIKE 'read-v2-auth:%'"
            ).fetchone()[0]
            == 0
        )
        response = await client.post(
            AUTH_PATH, json={"proof": challenge_proof(ledger, ledger.root)}
        )
        assert response.status_code == 200


@pytest.mark.asyncio
async def test_one_binding_cannot_exhaust_another_device_and_consumed_pop_is_not_reissued(ledger):
    activate(ledger)
    async with runtime(ledger) as (app, _), connection(app) as client:
        first_proof = challenge_proof(ledger, ledger.root)
        first = await client.post(AUTH_PATH, json={"proof": first_proof})
        assert first.status_code == 200
        challenge = verified(ledger, first.text, "read-challenge")
        retry = await client.post(AUTH_PATH, json={"proof": first_proof})
        assert verified(ledger, retry.text, "read-challenge") == challenge
        for _ in range(7):
            assert (
                await client.post(AUTH_PATH, json={"proof": challenge_proof(ledger, ledger.root)})
            ).status_code == 200
        assert (
            await client.post(AUTH_PATH, json={"proof": challenge_proof(ledger, ledger.root)})
        ).status_code == 429
        other = await client.post(AUTH_PATH, json={"proof": challenge_proof(ledger, ledger.use)})
        assert other.status_code == 200, other.text
        # A valid key still cannot consume a nonce reserved for another binding.
        wrong_actor = await client.post(
            "/local-trust/v2/read", json={"proof": read_proof(challenge, ledger.use)}
        )
        assert wrong_actor.status_code == 403
        consumed = await client.post(
            "/local-trust/v2/read", json={"proof": read_proof(challenge, ledger.root)}
        )
        assert consumed.status_code == 200
        repeat = await client.post(AUTH_PATH, json={"proof": first_proof})
        assert repeat.status_code in (403, 409)
        # The replay tombstone remains, while the consumed pending slot is reusable.
        fresh = await client.post(AUTH_PATH, json={"proof": challenge_proof(ledger, ledger.root)})
        assert fresh.status_code == 200


async def execute_mutation_http(client, ledger, action, args, *, target=None):
    intent = protocol.decode_auth_challenge(challenge_proof(ledger, ledger.root))
    intent.update(purpose="centuarai.local-ledger.auth-mutation-challenge", action=action)
    response = await client.post(
        "/local-trust/v2/mutations/authenticated-challenge",
        json={"proof": protocol.sign_auth_mutation_challenge(intent, ledger.root.access)},
    )
    assert response.status_code == 200, response.text
    challenge = verified(ledger, response.text, "mutation-challenge")
    payload = {
        **challenge["context"],
        "schemaVersion": 2,
        "purpose": "centuarai.local-ledger.prepare",
        "requestId": evidence._encode(os.urandom(32)),
        "challenge": challenge["challenge"],
        "issuedAt": challenge["issuedAt"],
        "expiresAt": challenge["expiresAt"],
        "actor": actor(ledger.root),
        "action": action,
        "args": args,
    }
    response = await client.post(
        "/local-trust/v2/mutations/prepare",
        json={"prepareProof": protocol.sign_prepare(payload, ledger.root.access)},
    )
    assert response.status_code == 200, response.text
    review = verified(ledger, response.text, "mutation-review")
    value = review["mutation"]
    response = await client.post(
        "/local-trust/v2/mutations/commit",
        json={
            "mutationProof": protocol.sign_mutation(value, ledger.root.approval),
            "targetAccessProof": protocol.sign_mutation(
                value, target.access, purpose="target-access"
            )
            if target
            else None,
            "targetApprovalProof": protocol.sign_mutation(
                value, target.approval, purpose="target-approval"
            )
            if target
            else None,
            "recoveryMaterialProof": None,
            "sourceRecoveryProof": None,
        },
    )
    assert response.status_code == 200, response.text
    return verified(ledger, response.text, "mutation-ack")


@pytest.mark.asyncio
async def test_unknown_actor_mutation_flood_cannot_block_real_revoke_or_member_approval(ledger):
    activate(ledger)
    unknown = {**actor(ledger.root), "bindingId": evidence._encode(os.urandom(32))}
    async with runtime(ledger) as (app, _):
        for source, count in (("198.51.100.1", 60), ("198.51.100.2", 60), ("198.51.100.3", 8)):
            async with connection(app, source) as client:
                for _ in range(count):
                    response = await client.post(
                        "/local-trust/v2/mutations/challenge",
                        json={"actor": unknown, "action": "device.revoke"},
                    )
                    assert response.status_code == 200
        async with connection(app, "198.51.100.4") as client:
            response = await client.post(
                "/local-trust/v2/mutations/challenge",
                json={"actor": unknown, "action": "device.revoke"},
            )
            assert response.status_code == 429
        async with connection(app) as client:
            revoked = await execute_mutation_http(
                client,
                ledger,
                "device.revoke",
                {"bindingId": ledger.use.binding_id, "mode": "normal"},
            )
            assert revoked["action"] == "device.revoke"
            with pytest.raises(evidence.BindingProtocolError):
                ledger.authority.get_authorization(ledger.use.binding_id, NOW_HTTP)
            member = manager_target(principal_id="principal:flood-isolated-member")
            member.target["capabilities"] = sorted(protocol.INVITED_CAPABILITIES)
            approved = await execute_mutation_http(
                client,
                ledger,
                "principal.invite",
                {"principalId": member.payload["principalId"], "target": member.target},
                target=member,
            )
            view = ledger.authority.get_authorization(approved["result"]["bindingId"], NOW_HTTP)
            assert view["principalId"] == member.payload["principalId"]


@pytest.mark.asyncio
async def test_manager_can_review_and_approve_pending_use_device_when_legacy_read_pool_is_full(
    ledger,
):
    activate(ledger)
    pending = new_request(ledger.provisioned, ledger.authority, ledger.root, now=NOW_HTTP)
    submit(ledger.authority, pending, now=NOW_HTTP)
    async with runtime(ledger) as (app, _):
        for source, count in (("198.51.100.1", 60), ("198.51.100.2", 60), ("198.51.100.3", 8)):
            async with connection(app, source) as client:
                for _ in range(count):
                    assert (
                        await client.post("/local-trust/v1/auth/challenge", json={})
                    ).status_code == 200
        async with connection(app, "198.51.100.4") as client:
            assert (await client.post("/local-trust/v1/auth/challenge", json={})).status_code == 429
        async with connection(app) as client:
            issued = await client.post(
                AUTH_PATH, json={"proof": challenge_proof(ledger, ledger.root)}
            )
            assert issued.status_code == 200, issued.text
            challenge = verified(ledger, issued.text, "read-challenge")
            proof = wire.sign_read_proof(
                {
                    "schemaVersion": 1,
                    "purpose": "centuarai.local-management.read",
                    "boxId": "box:test",
                    "boxKeyThumbprint": challenge["context"]["boxKeyThumbprint"],
                    "ownershipEpoch": challenge["context"]["ownershipEpoch"],
                    "nonce": challenge["nonce"],
                    "issuedAt": challenge["issuedAt"],
                    "expiresAt": challenge["expiresAt"],
                    "clientId": ledger.root.payload["clientId"],
                    "operation": "request",
                    "requestId": pending.payload["requestId"],
                },
                ledger.root.access,
            )
            response = await client.post("/local-trust/v1/requests/read", json={"proof": proof})
            assert response.status_code == 200, response.text
            review = wire.verify_response(
                response.text,
                ledger.provisioned.bundle["boxKey"],
                box_id="box:test",
                kind="request",
            )["body"]
            assert review["requestJws"] == pending.proof and review["state"] == "pending"
            response = await client.post(
                "/local-trust/v1/requests/approve",
                json={
                    "requestId": pending.payload["requestId"],
                    "approvalProof": approval_proof(ledger.root, pending, now=NOW_HTTP),
                },
            )
            assert response.status_code == 200, response.text
            ack = wire.verify_response(
                response.text,
                ledger.provisioned.bundle["boxKey"],
                box_id="box:test",
                kind="binding-ack",
            )["body"]
            assert (
                ledger.authority.get_authorization(ack["bindingId"], NOW_HTTP)["clientId"]
                == pending.payload["clientId"]
            )


@pytest.mark.asyncio
async def test_v2_fixed_version_hint_is_not_masked_as_a_private_read_denial(ledger):
    async with runtime(ledger) as (app, _), connection(app) as client:
        response = await client.post("/local-trust/v1/state", json={"proof": "version-probe"})
        assert response.status_code == 409
        assert response.json() == {"code": "LOCAL_TRUST_CLIENT_UPGRADE_REQUIRED"}
        assert response.headers["cache-control"] == "no-store"
        # The exception does not turn an ordinary v2 read rejection into a
        # version hint or disclose whether an actor exists.
        denied = await client.post("/local-trust/v2/read", json={"proof": "version-probe"})
        assert denied.status_code == 403
        assert denied.json() == {"code": "LOCAL_TRUST_READ_DENIED"}
