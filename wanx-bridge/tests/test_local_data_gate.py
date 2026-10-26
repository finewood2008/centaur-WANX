"""Signed broker fixture exercises real gateway verification and native staging."""

import asyncio
import hashlib
import json
import os
import secrets
import time

import httpx
import pytest
from centuarai_local_data_gate import GateConfig, LocalDataGateMiddleware, get_context
from centuarai_local_data_gate.client import BrokerClient
from centuarai_local_data_gate.observations import observed_headers
from centuarai_local_data_gate.protocol import (
    canonical,
    encode,
    gateway_proof_digest,
    principal_namespace,
    public_jwk,
    sign_gateway_lease,
    sign_gateway_observation,
    sign_gateway_request,
    verify_gateway_request,
)
from cryptography.hazmat.primitives.asymmetric import ec


def now():
    return int(time.time() * 1000)


@pytest.fixture
def native(tmp_path):
    if os.name != "posix":
        pytest.skip("reviewed POSIX staging")
    tmp_path.chmod(0o700)
    key = ec.generate_private_key(ec.SECP256R1())
    config = GateConfig(
        "octop",
        "gateway",
        public_jwk(key),
        "box",
        encode(b"b" * 32),
        str(tmp_path / "test.sock"),
        tmp_path,
    )
    proof = {
        "schemaVersion": 1,
        "purpose": "centuarai.local-data.gateway-request",
        "audience": "octop",
        "gatewayId": "gateway",
        "gatewayGeneration": encode(b"g" * 32),
        "sessionId": encode(b"s" * 32),
        "operationId": encode(b"o" * 32),
        "parentOperationId": None,
        "jti": secrets.token_urlsafe(32),
        "issuedAtMs": now(),
        "expiresAtMs": now() + 2000,
        "boxId": "box",
        "boxKeyThumbprint": config.box_key_thumbprint,
        "ownershipEpoch": 1,
        "authorizationVersion": 1,
        "principalSecurityVersion": 1,
        "bindingId": "binding",
        "bindingRevision": 1,
        "principalId": "principal",
        "clientId": "client",
        "applicationId": "wanx-host",
        "launchId": encode(b"l" * 32),
        "transport": "http",
        "method": "POST",
        "rawTarget": "/api/echo",
        "headers": observed_headers({"Content-Type": "application/octet-stream"}),
        "bodySha256": encode(hashlib.sha256(b"data").digest()),
        "bodyBytes": 4,
        "resourceId": "wanx",
        "action": "write",
        "serviceContext": {
            "kind": "principal",
            "clipboardScope": None,
            "principalNamespace": principal_namespace(config.box_key_thumbprint, 1, "principal"),
        },
    }
    state = {"used": set(), "revoked": False, "calls": [], "handler": [], "outcomes": []}

    def handle_broker(request):
        operation = request.url.path.rsplit("/", 1)[1]
        body = json.loads(request.content)
        state["calls"].append(operation)
        if operation == "observe":
            state.setdefault("inventories", []).append(body["activeOperationIds"])
            payload = {
                "schemaVersion": 1,
                "purpose": "centuarai.local-data.gateway-observation",
                "audience": config.audience,
                "gatewayId": config.gateway_id,
                "gatewayGeneration": proof["gatewayGeneration"],
                "nativeGateGeneration": body["nativeGateGeneration"],
                "gateNonce": secrets.token_urlsafe(32)
                if state.get("badObservation")
                else body["gateNonce"],
                "requestDigest": encode(hashlib.sha256(canonical(body)).digest()),
                "accepted": True,
                "issuedAtMs": now(),
                "expiresAtMs": now() + 1000,
            }
            return httpx.Response(200, text=sign_gateway_observation(payload, key))
        if state["revoked"] and operation != "closed":
            return httpx.Response(403, json={"code": "LOCAL_DATA_FORBIDDEN"})
        if operation == "admit":
            incoming = verify_gateway_request(body["gatewayProof"], config.gateway_key, now())
            if incoming["jti"] in state["used"]:
                return httpx.Response(403, json={"code": "LOCAL_DATA_REPLAY"})
            state["used"].add(incoming["jti"])
            state.update(claims=incoming, proof=body["gatewayProof"], phase="staging")
        if operation == "activate":
            state["phase"] = "active"
        if operation == "closed":
            state["phase"] = "closed"
            state["outcomes"].append(body["outcome"])
        claims = state["claims"]
        payload = {
            name: claims[name]
            for name in (
                "audience",
                "gatewayId",
                "gatewayGeneration",
                "sessionId",
                "operationId",
                "parentOperationId",
                "ownershipEpoch",
                "authorizationVersion",
                "principalSecurityVersion",
                "bindingId",
                "bindingRevision",
                "principalId",
                "clientId",
                "applicationId",
                "launchId",
                "resourceId",
                "action",
            )
        }
        payload.update(
            schemaVersion=1,
            purpose="centuarai.local-data.gateway-lease",
            nativeGateGeneration=body["nativeGateGeneration"],
            gateNonce=body["gateNonce"],
            gatewayProofDigest=gateway_proof_digest(state["proof"]),
            state=state["phase"],
            issuedAtMs=now(),
            expiresAtMs=now() + 1000,
        )
        return httpx.Response(200, text=sign_gateway_lease(payload, key))

    transport = httpx.MockTransport(handle_broker)
    client = BrokerClient(config, async_transport=transport, sync_transport=transport)

    async def app(scope, receive, send):
        context = get_context(scope)
        body = bytearray()
        while True:
            message = await receive()
            body.extend(message.get("body", b""))
            if not message.get("more_body", False):
                break
        state["handler"].append((context.principal_namespace, bytes(body)))
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"set-cookie", b"secret=1")],
            }
        )
        await send({"type": "http.response.body", "body": bytes(body)})

    gate = LocalDataGateMiddleware(app, config=config, broker=client)
    return config, key, proof, state, gate, client


@pytest.mark.asyncio
async def test_native_real_proof_body_and_replay_after_new_gate(native):
    config, key, proof, state, gate, broker = native
    header = {
        "X-Centuarai-Gateway-Proof": sign_gateway_request(proof, key),
        "Content-Type": "application/octet-stream",
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=gate), base_url="http://native"
    ) as client:
        response = await client.post("/api/echo", headers=header, content=b"data")
        assert response.status_code == 200 and response.content == b"data"
        assert (
            "set-cookie" not in response.headers and response.headers["cache-control"] == "no-store"
        )
    restarted = LocalDataGateMiddleware(gate.app, config=config, broker=broker)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=restarted), base_url="http://native"
    ) as client:
        assert (await client.post("/api/echo", headers=header, content=b"data")).status_code == 403
    assert len(state["handler"]) == 1 and gate.active == gate.reserved == 0
    await broker.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change", ["body", "target", "range", "bearer", "cookie", "wrong-key", "duplicate"]
)
async def test_native_rejects_each_unbound_input_before_handler(native, change):
    _, key, proof, state, gate, broker = native
    signer = ec.generate_private_key(ec.SECP256R1()) if change == "wrong-key" else key
    headers = [
        ("X-Centuarai-Gateway-Proof", sign_gateway_request(proof, signer)),
        ("Content-Type", "application/octet-stream"),
    ]
    if change == "range":
        headers.append(("Range", "bytes=1-2"))
    if change == "bearer":
        headers.append(("Authorization", "Bearer old-native-token"))
    if change == "cookie":
        headers.append(("Cookie", "session=old"))
    if change == "duplicate":
        headers.append(headers[0])
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=gate), base_url="http://native"
    ) as client:
        response = await client.post(
            "/api/other" if change == "target" else "/api/echo",
            headers=headers,
            content=b"xxxx" if change == "body" else b"data",
        )
    assert response.status_code == 403 and not state["handler"]
    assert gate.active == gate.reserved == 0
    assert list(gate.config.staging_directory.iterdir()) == []
    await broker.close()


@pytest.mark.asyncio
async def test_idle_native_handler_cancelled_after_revocation(native):
    _, key, proof, state, gate, broker = native
    entered, cancelled = asyncio.Event(), asyncio.Event()

    async def blocked(scope, receive, send):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    gate.app = blocked
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=gate), base_url="http://native"
    ) as client:
        request = asyncio.create_task(
            client.post(
                "/api/echo",
                content=b"data",
                headers={
                    "Content-Type": "application/octet-stream",
                    "X-Centuarai-Gateway-Proof": sign_gateway_request(proof, key),
                },
            )
        )
        await asyncio.wait_for(entered.wait(), 2)
        start = time.monotonic()
        state["revoked"] = True
        response = await asyncio.wait_for(request, 2)
    assert response.status_code == 403 and cancelled.is_set()
    assert time.monotonic() - start < 2
    assert gate.active == gate.reserved == 0
    await broker.close()


@pytest.mark.asyncio
async def test_cancelled_staging_waits_for_physical_write_before_close(tmp_path):
    import threading

    from centuarai_local_data_gate.staging import StagedBody

    tmp_path.chmod(0o700)
    staged = await StagedBody.create(tmp_path)
    entered, release = threading.Event(), threading.Event()
    original = staged.write

    def write(chunk):
        entered.set()
        assert release.wait(2)
        original(chunk)

    staged.write = write

    async def receive():
        return {"type": "http.request", "body": b"data", "more_body": False}

    task = asyncio.create_task(
        staged.consume(
            receive,
            expected_bytes=4,
            expected_digest=encode(hashlib.sha256(b"data").digest()),
            check=lambda: None,
        )
    )
    assert await asyncio.to_thread(entered.wait, 1)
    task.cancel()
    await asyncio.sleep(0.02)
    assert not task.done() and not staged.file.closed
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert staged.length == 4
    await staged.close()
    assert staged.file.closed and list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_native_inventory_removes_only_after_actual_handler_and_staging_cleanup(native):
    _, key, proof, state, gate, broker = native
    entered, release = asyncio.Event(), asyncio.Event()
    original = gate.app

    async def blocked(scope, receive, send):
        entered.set()
        await release.wait()
        await original(scope, receive, send)

    gate.app = blocked
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=gate), base_url="http://native"
    ) as client:
        task = asyncio.create_task(
            client.post(
                "/api/echo",
                content=b"data",
                headers={
                    "X-Centuarai-Gateway-Proof": sign_gateway_request(proof, key),
                    "Content-Type": "application/octet-stream",
                },
            )
        )
        await asyncio.wait_for(entered.wait(), 1)
        await gate._report()
        assert state["inventories"][-1] == [proof["operationId"]]
        assert gate.active == 1 and gate.reserved == 4
        release.set()
        assert (await task).status_code == 200
    assert state["inventories"][-1] == []
    assert state["calls"].index("closed") < len(state["calls"]) - 1
    assert state["calls"][-1] == "observe"
    await broker.close()


@pytest.mark.asyncio
async def test_native_observation_rejects_signed_receipt_for_another_nonce(native):
    from centuarai_local_data_gate.protocol import DataProtocolError

    _, _, _, state, gate, broker = native
    state["badObservation"] = True
    with pytest.raises(DataProtocolError, match="LOCAL_DATA_CONTEXT_CHANGED"):
        await broker.observe(gate.generation, [])
    assert gate.active == gate.reserved == 0
    await broker.close()


@pytest.mark.asyncio
async def test_exception_after_native_handler_started_reports_unknown_outcome(native):
    _, key, proof, state, gate, broker = native

    async def failed(scope, receive, send):
        raise ValueError("simulated failure after possible business mutation")

    gate.app = failed
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=gate), base_url="http://native"
    ) as client:
        response = await client.post(
            "/api/echo",
            content=b"data",
            headers={
                "X-Centuarai-Gateway-Proof": sign_gateway_request(proof, key),
                "Content-Type": "application/octet-stream",
            },
        )
    assert response.status_code == 403
    assert state["outcomes"] == ["outcome-unknown"]
    assert gate.active == gate.reserved == 0
    await broker.close()
