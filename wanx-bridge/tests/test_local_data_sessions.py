"""Real ECDSA proofs, deterministic clocks and bounded executor seams; no services."""

import asyncio
import copy
import hashlib
import secrets
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from wanx_bridge import local_data_protocol as wire
from wanx_bridge.local_data_sessions import LocalDataSessions

NOW = 1792886400000


def nonce(n=1):
    return wire.encode(bytes([n]) * 32)


class Clock:
    wall = NOW
    mono = 100.0

    def advance(self, ms):
        self.wall += ms
        self.mono += ms / 1000


class Harness:
    def __init__(self, **options):
        self.clock = Clock()
        self.box, self.access, self.channel, self.gateway = (
            ec.generate_private_key(ec.SECP256R1()) for _ in range(4)
        )
        self.view = {
            "boxId": "box:test",
            "boxKeyThumbprint": wire.public_key_thumbprint(wire.public_jwk(self.box)),
            "ownershipEpoch": 1,
            "rosterVersion": 1,
            "rosterDigest": nonce(),
            "policyVersion": 1,
            "authorizationVersion": 1,
            "principalSecurityVersion": 1,
            "principalStatus": "active",
            "ownershipState": "owned",
            "bindingId": "binding:test",
            "bindingRevision": 1,
            "principalId": "principal:test",
            "clientId": "client:test",
            "accessKey": wire.public_jwk(self.access),
            "status": "active",
            "grants": [{"resourceId": "wanx", "actions": ["execute", "read", "write"]}],
            "expiresAt": None,
        }
        self.calls = 0
        self.closed = []
        self.wait = None

        def query(binding_id, now):
            self.calls += 1
            assert binding_id == self.view["bindingId"]
            assert now == self.clock.wall // 1000
            return copy.deepcopy(self.view)

        async def execute(fn, *args):
            if self.wait:
                await self.wait.wait()
            # Real off-loop execution, not a synchronous fake marked async.
            return await asyncio.to_thread(fn, *args)

        self.service = LocalDataSessions(
            authority=SimpleNamespace(get_authorization=query),
            execute_authority=execute,
            box_id=self.view["boxId"],
            box_key_thumbprint=self.view["boxKeyThumbprint"],
            gateway_id="gateway:test",
            box_response_signer=lambda kind, body, now: wire.sign_data_response(
                self.box, box_id="box:test", kind=kind, body=body, now_ms=now
            ),
            gateway_signer=lambda payload: wire.sign_gateway_request(payload, self.gateway),
            gateway_verifier=lambda proof, now: wire.verify_gateway_request(
                proof, wire.public_jwk(self.gateway), now
            ),
            gateway_lease_signer=lambda payload: wire.sign_gateway_lease(payload, self.gateway),
            application_policy=lambda app, launch, view: (
                view["grants"] if app == "wanx-host" else []
            ),
            route_policy=self.route,
            child_policy=self.child,
            wall_clock_ms=lambda: self.clock.wall,
            monotonic_clock=lambda: self.clock.mono,
            on_operation_closed=lambda operation, reason: self.closed.append((operation, reason)),
            **options,
        )
        self.session = None

    def route(self, context, observation):
        audience = "clipboard" if observation["rawTarget"] == "/notes" else "octop"
        return {
            "audience": audience,
            "resourceId": "wanx",
            "action": "read",
            "serviceContext": {
                "kind": "clipboard",
                "principalNamespace": context["principalNamespace"],
                "applicationId": context["applicationId"],
            }
            if audience == "clipboard"
            else {
                "kind": "principal",
                "principalNamespace": context["principalNamespace"],
                "clipboardScope": None,
            },
            "bodyLimit": 200 * 1024**2,
            "upstreamPath": observation["rawTarget"],
        }

    def child(self, parent, body):
        need = body["rawTarget"] == "/files"
        if not need:
            raise wire.DataProtocolError("LOCAL_DATA_ROUTE_DENIED")
        route = self.route(parent["context"], body)
        route["serviceContext"]["clipboardScope"] = {
            "application": "wanx.clipboard",
            "exportId": None,
            "parent": None,
        }
        return route

    def response(self, signed, kind):
        return wire.verify_data_response(
            signed, wire.public_jwk(self.box), box_id="box:test", kind=kind, now_ms=self.clock.wall
        )["body"]

    def intent(self, *, key=None, **changes):
        payload = {
            "schemaVersion": 1,
            "purpose": "centuarai.local-data.session-intent",
            "boxId": self.view["boxId"],
            "boxKeyThumbprint": self.view["boxKeyThumbprint"],
            "bindingId": self.view["bindingId"],
            "applicationId": "wanx-host",
            "launchId": nonce(2),
            "requestId": nonce(3),
            "channelKey": wire.public_jwk(self.channel),
            "jti": secrets.token_urlsafe(32),
            "issuedAtMs": self.clock.wall,
            "expiresAtMs": self.clock.wall + 3000,
            **changes,
        }
        return {"proof": wire.sign_session_intent(payload, key or self.access)}

    async def session_proof(self, app="wanx-host"):
        challenge = self.response(
            await self.service.challenge(self.intent(applicationId=app)),
            "session-challenge",
        )
        payload = {
            "schemaVersion": 1,
            "purpose": "centuarai.local-data.session",
            **{name: self.view[name] for name in wire.IDENTITY},
            "gatewayGeneration": challenge["gatewayGeneration"],
            "challenge": challenge["challenge"],
            "requestId": nonce(3),
            "issuedAtMs": self.clock.wall,
            "expiresAtMs": self.clock.wall + 30000,
            "applicationId": app,
            "launchId": nonce(2),
            "channelKey": wire.public_jwk(self.channel),
        }
        return wire.sign_session(payload, self.access)

    async def start(self):
        self.session = self.response(
            await self.service.create_session(await self.session_proof()), "session"
        )
        return self.session

    def payload(self, kind="request", n=4, **changes):
        value = {
            "schemaVersion": 1,
            "purpose": "centuarai.local-data." + kind,
            "boxId": "box:test",
            "sessionId": self.session["sessionId"],
            "gatewayGeneration": self.service.generation,
            "applicationId": "wanx-host",
            "launchId": nonce(2),
            "jti": nonce(n),
            "issuedAtMs": self.clock.wall,
            "expiresAtMs": self.clock.wall + (10000 if kind == "request" else 3000),
        }
        if kind == "request":
            value.update(
                transport="http",
                method="GET",
                rawTarget="/files",
                headers={name: None for name in wire.HEADERS},
                bodySha256=wire.encode(hashlib.sha256(b"").digest()),
                bodyBytes=0,
            )
        elif kind == "heartbeat":
            value["sequence"] = n
        else:
            value["reason"] = "lock"
        value.update(changes)
        return value

    def signed(self, payload):
        return wire.sign_channel(payload, self.channel, kind=payload["purpose"].split(".")[-1])

    @staticmethod
    def observed(payload):
        return {
            key: copy.deepcopy(payload[key])
            for key in ("transport", "method", "rawTarget", "headers", "bodySha256", "bodyBytes")
        }

    async def operation(self, **changes):
        payload = self.payload(**changes)
        op = await self.service.admit_request(self.signed(payload), self.observed(payload))
        await self.service.activate_request(
            op["operationId"], payload["bodySha256"], payload["bodyBytes"]
        )
        proof = await self.service.gateway_request(op["operationId"], self.observed(payload))
        return op, proof

    def native(self, op, n=8, **kwargs):
        return {
            "operationId": op["operationId"],
            "nativeGateGeneration": nonce(9),
            "gateNonce": nonce(n),
            **kwargs,
        }

    async def native_start(self, op, proof):
        audience = op["route"]["audience"]
        await self.service.native_admit(
            {"gatewayProof": proof, "nativeGateGeneration": nonce(9), "gateNonce": nonce(10)},
            audience=audience,
        )
        return await self.service.native_activate(
            self.native(op, bodySha256=op["bodySha256"], bodyBytes=op["bodyBytes"]),
            audience=audience,
        )


@pytest.mark.asyncio
async def test_full_session_request_native_lifecycle():
    h = Harness()
    await h.start()
    op, proof = await h.operation()
    lease = await h.native_start(op, proof)
    assert (
        wire.verify_gateway_lease(lease, wire.public_jwk(h.gateway), h.clock.wall)["state"]
        == "active"
    )
    lease = await h.service.native_check(h.native(op, n=11), audience="octop")
    assert (
        wire.verify_gateway_lease(lease, wire.public_jwk(h.gateway), h.clock.wall)["operationId"]
        == op["operationId"]
    )
    await h.service.native_closed(h.native(op, n=12, outcome="completed"), audience="octop")
    # Native EOF must not race the gateway's final download/SSE bytes.
    assert (await h.service.assert_live(op["operationId"]))["state"] == "active"
    await h.service.finish_operation(op["operationId"])
    assert len(h.closed) == 1
    with pytest.raises(wire.DataProtocolError):
        await h.service.assert_live(op["operationId"])


@pytest.mark.asyncio
async def test_concurrent_same_session_challenge_has_one_winner_and_one_query():
    h = Harness()
    proof = await h.session_proof()
    h.calls = 0  # The intent lookup precedes these concurrent commit lookups.
    results = await asyncio.gather(
        *(h.service.create_session(proof) for _ in range(20)), return_exceptions=True
    )
    assert sum(isinstance(value, str) for value in results) == 1
    assert all(isinstance(value, (str, wire.DataProtocolError)) for value in results)
    assert h.calls == 1


@pytest.mark.asyncio
async def test_concurrent_request_proof_and_native_hop_admit_have_one_winner():
    h = Harness()
    await h.start()
    payload = h.payload()
    proof = h.signed(payload)
    results = await asyncio.gather(
        *(h.service.admit_request(proof, h.observed(payload)) for _ in range(30)),
        return_exceptions=True,
    )
    ops = [value for value in results if isinstance(value, dict)]
    assert len(ops) == 1
    op = ops[0]
    await h.service.activate_request(op["operationId"], payload["bodySha256"], 0)
    hop = await h.service.gateway_request(op["operationId"], h.observed(payload))
    results = await asyncio.gather(
        *(
            h.service.native_admit(
                {
                    "gatewayProof": hop,
                    "nativeGateGeneration": nonce(20 + i),
                    "gateNonce": nonce(60 + i),
                },
                audience="octop",
            )
            for i in range(20)
        ),
        return_exceptions=True,
    )
    assert sum(isinstance(value, str) for value in results) == 1


@pytest.mark.asyncio
async def test_late_heartbeat_preserves_signed_deadline_and_cannot_resurrect():
    h = Harness()
    await h.start()
    payload = h.payload("heartbeat", issuedAtMs=h.clock.wall, expiresAtMs=h.clock.wall + 3000)
    h.clock.advance(2500)
    response = h.response(await h.service.heartbeat(h.signed(payload)), "heartbeat")
    assert response["presenceExpiresAtMs"] == NOW + 3000
    h.clock.advance(500)
    with pytest.raises(wire.DataProtocolError):
        await h.service.heartbeat(h.signed(h.payload("heartbeat", n=5)))


@pytest.mark.asyncio
async def test_reordered_or_replayed_heartbeat_rejected():
    h = Harness()
    await h.start()
    first = h.signed(h.payload("heartbeat", n=7))
    await h.service.heartbeat(first)
    with pytest.raises(wire.DataProtocolError):
        await h.service.heartbeat(first)
    with pytest.raises(wire.DataProtocolError):
        await h.service.heartbeat(h.signed(h.payload("heartbeat", n=6)))


@pytest.mark.asyncio
async def test_request_signed_selector_and_body_must_match_observation():
    h = Harness()
    await h.start()
    payload = h.payload()
    observed = h.observed(payload)
    observed["headers"]["range"] = "bytes=1-4"
    with pytest.raises(wire.DataProtocolError):
        await h.service.admit_request(h.signed(payload), observed)
    op = await h.service.admit_request(h.signed(payload), h.observed(payload))
    with pytest.raises(wire.DataProtocolError):
        await h.service.activate_request(op["operationId"], nonce(14), 0)
    with pytest.raises(wire.DataProtocolError):
        await h.service.activate_request(op["operationId"], payload["bodySha256"], 0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,value",
    [
        ("status", "revoked"),
        ("principalStatus", "revoked"),
        ("ownershipState", "unowned"),
        ("ownershipEpoch", 2),
        ("bindingRevision", 2),
        ("principalSecurityVersion", 2),
        ("grants", []),
        ("expiresAt", NOW // 1000),
    ],
)
async def test_current_authority_revoke_expiry_and_versions_close_operations(field, value):
    h = Harness()
    await h.start()
    op, _ = await h.operation()
    h.view[field] = value
    h.clock.advance(1000)
    await h.service.sweep()
    assert len(h.closed) == 1
    with pytest.raises(wire.DataProtocolError):
        await h.service.assert_live(op["operationId"])


@pytest.mark.asyncio
async def test_global_version_advances_without_expanding_grants():
    h = Harness()
    h.view["grants"] = [{"resourceId": "wanx", "actions": ["read"]}]
    await h.start()
    op, _ = await h.operation()
    h.view["authorizationVersion"] = 2
    h.view["grants"][0]["actions"] = ["execute", "read", "write"]
    h.clock.advance(1000)
    result = await h.service.assert_live(op["operationId"])
    assert result["context"]["authorizationVersion"] == 2
    assert result["context"]["grants"][0]["actions"] == ["read"]


@pytest.mark.asyncio
async def test_inflight_query_invalidated_cannot_repopulate_or_hold_state_lock():
    h = Harness()
    proof = await h.session_proof()
    h.wait = asyncio.Event()
    pending = asyncio.create_task(h.service.create_session(proof))
    await asyncio.sleep(0)
    await asyncio.wait_for(
        h.service.invalidate_authority(binding_ids=["binding:test"]), timeout=0.2
    )
    h.wait.set()
    with pytest.raises(wire.DataProtocolError):
        await pending
    assert not h.service._cache and not h.service._sessions


@pytest.mark.asyncio
async def test_cancelled_waiter_retains_executor_capacity_until_completion():
    h = Harness(limits={"authority_queries": 1})
    proof = await h.session_proof()
    h.wait = asyncio.Event()
    pending = asyncio.create_task(h.service.create_session(proof))
    await asyncio.sleep(0)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert len(h.service._queries) == 1
    h.wait.set()
    await asyncio.gather(*h.service._queries.values())
    assert not h.service._queries


@pytest.mark.asyncio
async def test_channel_key_compromise_does_not_change_app_launch_or_identity():
    h = Harness()
    await h.start()
    for change in (
        {"applicationId": "another-app"},
        {"launchId": nonce(20)},
        {"boxId": "another-box"},
    ):
        payload = h.payload(**change)
        with pytest.raises(wire.DataProtocolError):
            await h.service.admit_request(h.signed(payload), h.observed(payload))


@pytest.mark.asyncio
async def test_restart_rejects_sessions_and_native_proofs():
    h = Harness()
    await h.start()
    op, proof = await h.operation()
    old = h.service.generation
    h.service.generation = nonce(55)
    payload = h.payload(gatewayGeneration=old)
    with pytest.raises(wire.DataProtocolError):
        await h.service.admit_request(h.signed(payload), h.observed(payload))
    with pytest.raises(wire.DataProtocolError):
        await h.service.native_admit(
            {"gatewayProof": proof, "nativeGateGeneration": nonce(9), "gateNonce": nonce(8)},
            audience="octop",
        )


@pytest.mark.asyncio
async def test_clock_rollback_and_idle_presence_close_without_traffic():
    h = Harness()
    await h.start()
    await h.operation()
    h.clock.advance(-1)
    await h.service.sweep()
    assert len(h.closed) == 1
    h = Harness()
    await h.start()
    await h.operation()
    h.clock.advance(3000)
    await h.service.sweep()
    assert len(h.closed) == 1


@pytest.mark.asyncio
async def test_global_two_copy_staging_reservation_and_release():
    h = Harness(limits={"staging_bytes": 40})
    await h.start()
    payload = h.payload(bodyBytes=20, bodySha256=nonce(1))
    first = await h.service.admit_request(h.signed(payload), h.observed(payload))
    payload = h.payload(n=5, bodyBytes=1)
    with pytest.raises(wire.DataProtocolError, match="CAPACITY"):
        await h.service.admit_request(h.signed(payload), h.observed(payload))
    await h.service.finish_operation(first["operationId"], "cancelled")
    # Capacity-denied proof was burned; a new proof can use the released budget.
    with pytest.raises(wire.DataProtocolError, match="REPLAY"):
        await h.service.admit_request(h.signed(payload), h.observed(payload))
    payload = h.payload(n=6, bodyBytes=20)
    await h.service.admit_request(h.signed(payload), h.observed(payload))


@pytest.mark.asyncio
async def test_child_fixed_callgraph_no_grandchildren_and_parent_closes_child():
    h = Harness()
    await h.start()
    parent, proof = await h.operation(rawTarget="/notes")
    await h.native_start(parent, proof)
    observation = h.observed(h.payload())
    child_body = {
        "parentOperationId": parent["operationId"],
        "nativeGateGeneration": nonce(9),
        "gateNonce": nonce(30),
        "audience": "octop",
        **observation,
    }
    child_proof = await h.service.child_hop(child_body, audience="clipboard")
    child_payload = wire.verify_gateway_request(
        child_proof, wire.public_jwk(h.gateway), h.clock.wall
    )
    assert child_payload["parentOperationId"] == parent["operationId"]
    child_body["gateNonce"] = nonce(31)
    child_body["audience"] = "semantica"
    with pytest.raises(wire.DataProtocolError):
        await h.service.child_hop(child_body, audience="clipboard")
    await h.service.finish_operation(parent["operationId"], "cancelled")
    with pytest.raises(wire.DataProtocolError):
        await h.service.assert_live(child_payload["operationId"])
    assert len(h.closed) == 2


@pytest.mark.asyncio
async def test_native_changed_audience_generation_body_and_nonce_deny():
    h = Harness()
    await h.start()
    op, proof = await h.operation()
    with pytest.raises(wire.DataProtocolError):
        await h.service.native_admit(
            {"gatewayProof": proof, "nativeGateGeneration": nonce(9), "gateNonce": nonce(10)},
            audience="clipboard",
        )
    await h.native_start(op, proof)
    with pytest.raises(wire.DataProtocolError):
        await h.service.native_check(h.native(op, nativeGateGeneration=nonce(11)), audience="octop")
    body = h.native(op, n=14)
    await h.service.native_check(body, audience="octop")
    with pytest.raises(wire.DataProtocolError):
        await h.service.native_check(body, audience="octop")


@pytest.mark.asyncio
async def test_authority_hang_fails_closed_and_retains_physical_query_capacity():
    h = Harness(limits={"authority_queries": 1})
    await h.start()
    op, _ = await h.operation()
    h.clock.advance(1000)
    h.wait = asyncio.Event()
    with pytest.raises(wire.DataProtocolError):
        await asyncio.wait_for(h.service.assert_live(op["operationId"]), timeout=1.5)
    assert len(h.closed) == 1 and len(h.service._queries) == 1
    with pytest.raises(wire.DataProtocolError):
        await h.service._view("binding:test")
    assert len(h.service._queries) == 1
    h.wait.set()
    for _ in range(30):
        if not h.service._queries:
            break
        await asyncio.sleep(0.01)
    assert not h.service._queries


@pytest.mark.asyncio
async def test_monotonic_presence_expires_even_when_wall_clock_stalls():
    h = Harness()
    await h.start()
    op, _ = await h.operation()
    h.clock.mono += 3
    with pytest.raises(wire.DataProtocolError):
        await h.service.assert_live(op["operationId"])
    assert len(h.closed) == 1


@pytest.mark.asyncio
async def test_closed_session_and_blocked_callback_cannot_hold_other_operations():
    h = Harness()
    await h.start()
    first, _ = await h.operation(n=20)
    second, _ = await h.operation(n=21)
    entered = []

    async def close(operation, reason):
        entered.append(operation["operationId"])
        if operation["operationId"] == first["operationId"]:
            await asyncio.Event().wait()

    h.service.on_operation_closed = close
    closing = asyncio.create_task(h.service.close_session(h.signed(h.payload("close", n=22))))
    await asyncio.sleep(0.01)
    assert set(entered) == {first["operationId"], second["operationId"]}
    with pytest.raises(wire.DataProtocolError):
        await h.service.heartbeat(h.signed(h.payload("heartbeat", n=23)))
    await asyncio.wait_for(closing, timeout=1.5)


@pytest.mark.asyncio
async def test_session_hard_expiry_is_not_renewed_by_heartbeats():
    h = Harness()
    await h.start()
    for step in range(1, 150):
        h.clock.advance(2000)
        await h.service.heartbeat(
            h.signed(h.payload("heartbeat", n=(step % 240) + 10, sequence=step))
        )
    h.clock.advance(2000)
    with pytest.raises(wire.DataProtocolError):
        await h.service.heartbeat(h.signed(h.payload("heartbeat", n=250, sequence=150)))


@pytest.mark.asyncio
async def test_replay_capacity_never_evicts_unexpired_proof():
    h = Harness(limits={"replay_per_session": 1})
    await h.start()
    payload = h.payload()
    proof = h.signed(payload)
    first = await h.service.admit_request(proof, h.observed(payload))
    await h.service.finish_operation(first["operationId"])
    newer = h.payload(n=5)
    with pytest.raises(wire.DataProtocolError, match="CAPACITY"):
        await h.service.admit_request(h.signed(newer), h.observed(newer))
    with pytest.raises(wire.DataProtocolError, match="REPLAY"):
        await h.service.admit_request(proof, h.observed(payload))


@pytest.mark.asyncio
async def test_native_lease_refreshes_nearly_expired_authority_cache_before_minting():
    h = Harness()
    await h.start()
    op, proof = await h.operation()
    h.clock.advance(900)
    lease = await h.native_start(op, proof)
    value = wire.verify_gateway_lease(lease, wire.public_jwk(h.gateway), h.clock.wall)
    assert value["expiresAtMs"] - h.clock.wall >= 750

    h.clock.advance(500)
    lease = await h.service.native_check(h.native(op, n=22), audience="octop")
    value = wire.verify_gateway_lease(lease, wire.public_jwk(h.gateway), h.clock.wall)
    assert value["expiresAtMs"] - h.clock.wall >= 750


async def preparation_harness():
    from wanx_bridge.local_data_routes import route_policy

    h = Harness()
    h.service.route_policy = route_policy
    h.service.gateway_resources_signer = lambda value: wire.sign_gateway_resources(value, h.gateway)
    h.view["grants"] = [
        {"resourceId": "semantica", "actions": ["read", "write"]},
        {"resourceId": "wanx", "actions": ["read", "write"]},
    ]
    await h.start()
    op, proof = await h.operation(method="POST", rawTarget="/api/platform/applications/prepare")
    await h.native_start(op, proof)
    return h, op


@pytest.mark.asyncio
async def test_native_preparation_batch_exact_signature_replay_and_permission_loss():
    h, op = await preparation_harness()
    required = [{"resourceId": "semantica", "actions": ["read", "write"]}]
    body = h.native(op, n=40, grants=required)
    results = await asyncio.gather(
        *(h.service.native_authorize_resources(body, audience="octop") for _ in range(12)),
        return_exceptions=True,
    )
    winners = [value for value in results if isinstance(value, str)]
    assert len(winners) == 1
    payload = wire.verify_gateway_resources(winners[0], wire.public_jwk(h.gateway), h.clock.wall)
    assert payload["grants"] == required and payload["requestDigest"] == wire.digest(body)
    assert payload["gatewayProofDigest"] and payload["operationId"] == op["operationId"]
    with pytest.raises(wire.DataProtocolError):
        wire.verify_gateway_lease(winners[0], wire.public_jwk(h.gateway), h.clock.wall)
    with pytest.raises(wire.DataProtocolError, match="CONTEXT_CHANGED"):
        await h.service.native_authorize_resources(
            h.native(op, n=41, grants=[{"resourceId": "wanx", "actions": ["read"]}]),
            audience="octop",
        )
    h.view["grants"] = [{"resourceId": "wanx", "actions": ["read", "write"]}]
    await h.service.invalidate_authority()
    with pytest.raises(wire.DataProtocolError):
        await h.service.native_check(h.native(op, n=42), audience="octop")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change", ["empty", "not_granted", "wrong_generation", "wrong_audience", "not_prepare"]
)
async def test_native_batch_cannot_be_general_privilege_oracle(change):
    h, op = await preparation_harness()
    body = h.native(op, n=43, grants=[{"resourceId": "semantica", "actions": ["read"]}])
    audience = "octop"
    if change == "empty":
        body["grants"] = []
    if change == "not_granted":
        body["grants"][0]["actions"] = ["execute"]
    if change == "wrong_generation":
        body["nativeGateGeneration"] = nonce(44)
    if change == "wrong_audience":
        audience = "clipboard"
    if change == "not_prepare":
        other, proof = await h.operation(n=44, rawTarget="/api/auth/me")
        await h.native_start(other, proof)
        body = h.native(other, n=45, grants=body["grants"])
    with pytest.raises(wire.DataProtocolError):
        await h.service.native_authorize_resources(body, audience=audience)


@pytest.mark.asyncio
async def test_logical_close_does_not_release_either_physical_staging_copy():
    h = Harness(limits={"staging_bytes": 40})
    await h.start()
    first, signed = await h.operation(bodyBytes=20, bodySha256=nonce(60))
    await h.native_start(first, signed)
    await h.service.close_session(h.signed(h.payload("close", n=61)))
    await h.start()
    h.clock.advance(2100)  # Expired native proof must not prune reserved storage.
    for number in (62, 63):
        value = h.payload(n=number, bodyBytes=20, bodySha256=nonce(60))
        with pytest.raises(wire.DataProtocolError, match="CAPACITY"):
            await h.service.admit_request(h.signed(value), h.observed(value))
        await h.service.finish_operation(first["operationId"], "cancelled")
    await h.service.native_closed(h.native(first, n=64, outcome="cancelled"), audience="octop")
    value = h.payload(n=65, bodyBytes=20, bodySha256=nonce(60))
    await h.service.admit_request(h.signed(value), h.observed(value))


async def renewal_proof(h, *, n=100, key=None):
    channel = key or ec.generate_private_key(ec.SECP256R1())
    payload = h.payload("heartbeat", n=n)
    del payload["sequence"]
    payload.update(
        purpose="centuarai.local-data.renewal",
        requestId=nonce(n + 1),
        channelKey=wire.public_jwk(channel),
    )
    challenge = h.response(
        await h.service.renewal_challenge(wire.sign_channel(payload, h.channel, kind="renewal")),
        "session-challenge",
    )
    fresh = {
        "schemaVersion": 1,
        "purpose": "centuarai.local-data.session",
        **{name: h.view[name] for name in wire.IDENTITY},
        "gatewayGeneration": h.service.generation,
        "challenge": challenge["challenge"],
        "requestId": payload["requestId"],
        "channelKey": payload["channelKey"],
        "applicationId": payload["applicationId"],
        "launchId": payload["launchId"],
        "issuedAtMs": h.clock.wall,
        "expiresAtMs": challenge["expiresAtMs"],
    }
    return fresh, channel


@pytest.mark.asyncio
async def test_authenticated_renewal_survives_full_initial_challenge_pool_without_scope_growth():
    h = Harness(limits={"challenges": 1})
    h.view["grants"] = [{"resourceId": "wanx", "actions": ["read"]}]
    await h.start()
    h.clock.advance(1)
    await h.service.challenge(h.intent(launchId=nonce(100)))
    fresh, _ = await renewal_proof(h)
    h.view["grants"] = [{"resourceId": "wanx", "actions": ["read", "write"]}]
    h.clock.advance(1001)
    value = h.response(
        await h.service.create_session(wire.sign_session(fresh, h.access), renewal=True), "session"
    )
    assert value["authorization"]["grants"] == [{"resourceId": "wanx", "actions": ["read"]}]
    assert (
        value["sessionId"] != h.session["sessionId"]
        and value["expiresAtMs"] > h.session["expiresAtMs"]
    )
    assert h.service._sessions[h.session["sessionId"]]["expiresAtMs"] == h.session["expiresAtMs"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change", ["old_close", "key_swap", "request_swap", "old_key", "anonymous_commit"]
)
async def test_renewal_cannot_bypass_parent_fence_or_proposal(change):
    h = Harness()
    await h.start()
    if change == "old_key":
        with pytest.raises(wire.DataProtocolError):
            await renewal_proof(h, key=h.channel)
        return
    fresh, _ = await renewal_proof(h)
    if change == "old_close":
        await h.service.close_session(h.signed(h.payload("close", n=120)))
    if change == "key_swap":
        fresh["channelKey"] = wire.public_jwk(ec.generate_private_key(ec.SECP256R1()))
    if change == "request_swap":
        fresh["requestId"] = nonce(122)
    with pytest.raises(wire.DataProtocolError):
        await h.service.create_session(
            wire.sign_session(fresh, h.access), renewal=change != "anonymous_commit"
        )


@pytest.mark.asyncio
async def test_renewal_budget_is_per_binding_and_proofs_cannot_open_unbounded_candidates():
    h = Harness(limits={"renewals_per_binding": 1})
    await h.start()
    fresh, _ = await renewal_proof(h)
    await h.service.create_session(wire.sign_session(fresh, h.access), renewal=True)
    with pytest.raises(wire.DataProtocolError, match="CAPACITY"):
        await renewal_proof(h, n=110)


@pytest.mark.asyncio
async def test_fresh_signed_renewal_retry_supersedes_lost_challenge_without_late_resurrection():
    h = Harness()
    await h.start()
    first, _ = await renewal_proof(h, n=100)
    second, _ = await renewal_proof(h, n=110)
    with pytest.raises(wire.DataProtocolError):
        await h.service.create_session(wire.sign_session(first, h.access), renewal=True)
    fresh = h.response(
        await h.service.create_session(wire.sign_session(second, h.access), renewal=True), "session"
    )
    assert fresh["sessionId"] != h.session["sessionId"]


@pytest.mark.asyncio
async def test_initial_challenge_requires_pinned_access_pop_before_allocating_any_state():
    h = Harness()
    for body in (
        {},
        {"bindingId": h.view["bindingId"], "applicationId": "wanx-host", "launchId": nonce(2)},
    ):
        with pytest.raises(wire.DataProtocolError):
            await h.service.challenge(body)
    assert h.calls == 0 and not h.service._challenges
    attacker = ec.generate_private_key(ec.SECP256R1())
    for _ in range(20):
        with pytest.raises(wire.DataProtocolError, match="FORBIDDEN"):
            await h.service.challenge(h.intent(key=attacker))
    assert not h.service._challenges and not h.service._intent_replay and not h.service._cache
    await h.service.challenge(h.intent())
    assert len(h.service._challenges) == 1


@pytest.mark.asyncio
async def test_initial_intent_replay_has_one_winner_and_per_binding_candidates_are_bounded():
    h = Harness(limits={"challenges": 4, "challenges_per_binding": 2})
    intent = h.intent()
    results = await asyncio.gather(
        *(h.service.challenge(intent) for _ in range(20)), return_exceptions=True
    )
    assert sum(isinstance(value, str) for value in results) == 1
    assert len(h.service._challenges) == len(h.service._intent_replay) == 1
    await h.service.challenge(h.intent(launchId=nonce(40)))
    with pytest.raises(wire.DataProtocolError, match="CAPACITY"):
        await h.service.challenge(h.intent(launchId=nonce(41)))
    assert len(h.service._challenges) == 2 < h.service.limits["challenges"]
    second_key = ec.generate_private_key(ec.SECP256R1())
    second = {
        **h.view,
        "bindingId": "binding:second",
        "clientId": "client:second",
        "accessKey": wire.public_jwk(second_key),
    }
    h.service.authority.get_authorization = lambda binding, now: copy.deepcopy(
        second if binding == second["bindingId"] else h.view
    )
    await h.service.challenge(h.intent(key=second_key, bindingId=second["bindingId"]))
    assert len(h.service._challenges) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["requestId", "channelKey", "applicationId", "launchId"])
async def test_initial_session_commit_cannot_swap_access_signed_proposal(field):
    h = Harness()
    proof = await h.session_proof()
    payload = wire.verify_session_proof(proof, wire.public_jwk(h.access), now_ms=h.clock.wall)
    payload[field] = {
        "requestId": nonce(50),
        "launchId": nonce(51),
        "applicationId": "different-app",
        "channelKey": wire.public_jwk(ec.generate_private_key(ec.SECP256R1())),
    }[field]
    with pytest.raises(wire.DataProtocolError, match="CONTEXT_CHANGED"):
        await h.service.create_session(wire.sign_session(payload, h.access))
    assert not h.service._sessions


@pytest.mark.asyncio
async def test_initial_candidate_replacement_fences_late_commit_and_random_locator_avoids_lookup():
    h = Harness()
    first = await h.session_proof()
    second = await h.session_proof()
    h.calls = 0
    with pytest.raises(wire.DataProtocolError):
        await h.service.create_session(first)
    payload = wire.verify_session_proof(second, wire.public_jwk(h.access), now_ms=h.clock.wall)
    payload.update(challenge=nonce(80), bindingId="binding:unregistered")
    with pytest.raises(wire.DataProtocolError):
        await h.service.create_session(wire.sign_session(payload, h.access))
    assert h.calls == 0
    await h.service.create_session(second)
    assert len(h.service._sessions) == 1


@pytest.mark.asyncio
async def test_unverified_intent_lookups_keep_physical_slots_without_blocking_heartbeat():
    h = Harness()
    await h.start()
    h.clock.advance(1001)
    release = asyncio.Event()
    original = h.service.execute_authority
    entered = []

    async def blocking_unknown(function, binding_id):
        if binding_id.startswith("binding:unknown"):
            entered.append(binding_id)
            await release.wait()
        return await original(function, binding_id)

    h.service.execute_authority = blocking_unknown
    callers = [
        asyncio.create_task(h.service.challenge(h.intent(bindingId=f"binding:unknown-{index}")))
        for index in range(8)
    ]
    for _ in range(30):
        if len(entered) == 8:
            break
        await asyncio.sleep(0)
    assert len(entered) == len(h.service._intent_queries) == 8
    for caller in callers:
        caller.cancel()
    await asyncio.gather(*callers, return_exceptions=True)
    with pytest.raises(wire.DataProtocolError, match="CAPACITY"):
        await h.service.challenge(h.intent(bindingId="binding:unknown-late"))
    assert not h.service._queries
    heartbeat = h.payload("heartbeat", sequence=1)
    signed = await h.service.heartbeat(wire.sign_channel(heartbeat, h.channel, kind="heartbeat"))
    assert h.response(signed, "heartbeat")["sequence"] == 1
    physical = list(h.service._intent_queries.values())
    release.set()
    await asyncio.gather(*physical, return_exceptions=True)
    assert not h.service._intent_queries
