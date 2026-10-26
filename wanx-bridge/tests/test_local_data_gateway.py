"""Real TLS → gateway → HTTP/WS native gate → real Unix broker, synthetic authority."""

import asyncio
import copy
import hashlib
import os
import socket
import ssl
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import uvicorn
from centuarai_local_data_gate import GateConfig, LocalDataGateMiddleware
from centuarai_local_data_gate.native_policy import check_octop_request
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from test_local_data_sessions import Harness
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from wanx_bridge import local_data_broker as broker_module
from wanx_bridge import local_data_protocol as wire
from wanx_bridge.local_data_broker import LocalDataBroker
from wanx_bridge.local_data_gateway import LocalDataGateway
from wanx_bridge.local_data_routes import application_policy, child_policy, route_policy
from wanx_bridge.local_data_transport import LocalDataHTTPProtocol, LocalDataWebSocketProtocol


class RealClock:
    @property
    def wall(self):
        return time.time_ns() // 1_000_000

    @property
    def mono(self):
        return time.monotonic()


@asynccontextmanager
async def server(app, *, tls=None, prebound=None, lifespan=False):
    listener = prebound or socket.socket()
    if prebound is None:
        listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    options = {} if tls is None else {"ssl_certfile": str(tls[0]), "ssl_keyfile": str(tls[1])}
    service = uvicorn.Server(
        uvicorn.Config(
            app,
            log_level="critical",
            lifespan="on" if lifespan else "off",
            http=LocalDataHTTPProtocol,
            ws=LocalDataWebSocketProtocol,
            **options,
        )
    )
    task = asyncio.create_task(service.serve(sockets=[listener]))
    try:
        for _ in range(200):
            if service.started:
                break
            if task.done():
                await task
            await asyncio.sleep(0.01)
        assert service.started
        yield f"{'https' if tls else 'http'}://127.0.0.1:{port}"
    finally:
        service.should_exit = True
        try:
            await asyncio.wait_for(asyncio.shield(task), 1)
        except TimeoutError:
            service.force_exit = True
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        listener.close()


@pytest.fixture
async def network(monkeypatch, request):
    with tempfile.TemporaryDirectory(prefix="wanx-data-", dir=Path("/tmp").resolve()) as directory:
        root = Path(directory)
        root.chmod(0o700)
        staging = root / "stage"
        staging.mkdir(mode=0o700)
        h = Harness()
        h.clock = RealClock()
        ledger = None
        if getattr(request, "param", None) == "ledger":
            from test_local_authority_store import (
                approval_proof,
                claim,
                new_request,
                provisioned,
                submit,
            )
            from test_local_authority_store import (
                body as management_body,
            )
            from test_local_ledger import activate

            from wanx_bridge import local_authority_store as store

            provision = provisioned.__wrapped__(root)
            old = store.LocalTrustAuthority(provision.directory, boot_id="gateway:test-v1")
            manager = claim(provision, old)
            now = h.clock.wall // 1000
            device = new_request(provision, old, manager, now=now)
            submit(old, device, now=now)
            ack = old.approve_request(
                device.payload["requestId"], approval_proof(manager, device, now=now), now
            )
            device.binding_id = management_body(provision, ack, "binding-ack")["bindingId"]
            old.close()
            store.migrate_authority_v2(provision.directory, now=now)
            authority_store = store.LocalTrustAuthority(
                provision.directory, boot_id="gateway:test-v2"
            )
            ledger = SimpleNamespace(
                authority=authority_store, root=manager, use=device, provisioned=provision
            )
            activate(ledger, now=now)
            h.box, h.access = provision.key, device.access
            h.view = authority_store.get_authorization(device.binding_id, now)
            h.service.authority = authority_store
            h.service.box_key_thumbprint = h.view["boxKeyThumbprint"]
        h.service.application_policy = application_policy
        h.service.route_policy = route_policy
        h.service.child_policy = child_policy
        h.service.gateway_resources_signer = lambda payload: wire.sign_gateway_resources(
            payload, h.gateway
        )
        h.service.gateway_observation_signer = lambda payload: wire.sign_gateway_observation(
            payload, h.gateway
        )
        h.service.effects.audiences = frozenset({"octop"})
        # Linux uses actual SO_PEERCRED. macOS is deliberately unsupported in
        # production; only the credential lookup seam is substituted in this
        # cross-platform real-socket fixture, with a separate fail-closed test.
        if sys.platform != "linux":
            monkeypatch.setattr(broker_module, "peer_uid", lambda connection: os.geteuid())
        broker = LocalDataBroker(
            h.service, socket_path=root / "gate.sock", audience_uids={"octop": {os.geteuid()}}
        )
        await broker.start()
        config = GateConfig(
            "octop",
            "gateway:test",
            wire.public_jwk(h.gateway),
            "box:test",
            h.view["boxKeyThumbprint"],
            str(root / "gate.sock"),
            staging,
        )
        calls = []
        writes = []
        last_bytes = []

        async def business(scope, receive, send):
            if scope["type"] == "lifespan":
                while True:
                    message = await receive()
                    if message["type"] == "lifespan.startup":
                        await send({"type": "lifespan.startup.complete"})
                    elif message["type"] == "lifespan.shutdown":
                        await send({"type": "lifespan.shutdown.complete"})
                        return
            claims = scope["centuarai.local_data"].claims
            calls.append((scope["path"], claims))
            if scope["type"] == "websocket":
                assert (await receive())["type"] == "websocket.connect"
                await send({"type": "websocket.accept"})
                while True:
                    try:
                        message = await asyncio.wait_for(receive(), timeout=0.04)
                        if message["type"] == "websocket.disconnect":
                            return
                    except TimeoutError:
                        message = {"text": "tick"}
                    await send({"type": "websocket.send", "text": message.get("text", "echo")})
            raw = bytearray()
            while True:
                message = await receive()
                raw.extend(message.get("body", b""))
                if not message.get("more_body", False):
                    break
            if scope["path"].endswith("/events"):
                await send(
                    {
                        "type": "http.response.start",
                        "status": 200,
                        "headers": [(b"content-type", b"text/event-stream")],
                    }
                )
                while True:
                    last_bytes.append(time.monotonic_ns())
                    await send(
                        {"type": "http.response.body", "body": b"data: tick\n\n", "more_body": True}
                    )
                    await asyncio.sleep(0.04)
            if scope["path"] == "/api/personal-space/files/" + "5" * 32 + "/content":
                await send(
                    {
                        "type": "http.response.start",
                        "status": 206,
                        "headers": [
                            (b"content-type", b"application/octet-stream"),
                            (b"content-range", b"bytes 0-1048575/1048576"),
                            (b"content-length", b"1048576"),
                        ],
                    }
                )
                for _ in range(256):
                    await send(
                        {"type": "http.response.body", "body": b"x" * 4096, "more_body": True}
                    )
                    await asyncio.sleep(0.04)
                await send({"type": "http.response.body", "body": b""})
                return
            if scope["method"] == "PUT":
                writes.append(bytes(raw))
                output = hashlib.sha256(raw).hexdigest().encode()
                status, headers = 200, [(b"content-length", str(len(output)).encode())]
            else:
                output = b"bcd" if claims["headers"]["range"] == "bytes=1-3" else b"abcdef"
                status = 206 if len(output) == 3 else 200
                headers = [
                    (b"content-type", b"application/octet-stream"),
                    (b"content-length", str(len(output)).encode()),
                    (b"content-range", b"bytes 1-3/6"),
                    (b"set-cookie", b"forbidden=1"),
                    (b"x-centuarai-private", b"do-not-forward"),
                ]
            await send({"type": "http.response.start", "status": status, "headers": headers})
            await send({"type": "http.response.body", "body": output})

        async def authorize(scope, context):
            check_octop_request(scope, context.claims)

        native = LocalDataGateMiddleware(business, config=config, authorize=authorize)
        certificate = (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test")]))
            .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test")]))
            .public_key(h.box.public_key())
            .serial_number(1)
            .not_valid_before(datetime.now(UTC) - timedelta(minutes=1))
            .not_valid_after(datetime.now(UTC) + timedelta(days=1))
            .sign(h.box, hashes.SHA256())
        )
        cert_path, key_path = root / "test.pem", root / "test-key.pem"
        cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(
            h.box.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        key_path.chmod(0o600)
        async with server(native, lifespan=True) as native_url:
            listener = socket.socket()
            listener.bind(("127.0.0.1", 0))
            authority = "127.0.0.1:" + str(listener.getsockname()[1])
            gateway = LocalDataGateway(
                h.service,
                upstreams={"octop": native_url},
                staging_directory=staging,
                authority=authority,
            )

            async def closed(operation, reason):
                h.closed.append((operation, reason))
                await gateway.operation_closed(operation, reason)

            h.service.on_operation_closed = closed
            await gateway.start()
            async with server(gateway, tls=(cert_path, key_path), prebound=listener) as url:
                async with httpx.AsyncClient(
                    base_url=url, verify=False, trust_env=False, timeout=3
                ) as client:
                    challenge = await client.post(
                        "/local-trust/v1/data/session-challenge",
                        json=h.intent(
                            launchId=wire.encode(b"l" * 32), requestId=wire.encode(b"r" * 32)
                        ),
                    )
                    assert challenge.status_code == 200, challenge.text
                    body = h.response(challenge.text, "session-challenge")
                    payload = {
                        "schemaVersion": 1,
                        "purpose": "centuarai.local-data.session",
                        **{name: h.view[name] for name in wire.IDENTITY},
                        "gatewayGeneration": body["gatewayGeneration"],
                        "challenge": body["challenge"],
                        "requestId": wire.encode(b"r" * 32),
                        "issuedAtMs": h.clock.wall,
                        "expiresAtMs": body["expiresAtMs"],
                        "applicationId": "wanx-host",
                        "launchId": wire.encode(b"l" * 32),
                        "channelKey": wire.public_jwk(h.channel),
                    }
                    response = await client.post(
                        "/local-trust/v1/data/sessions",
                        json={"accessProof": wire.sign_session(payload, h.access)},
                    )
                    assert response.status_code == 200, response.text
                    h.session = h.response(response.text, "session")
                    try:
                        yield SimpleNamespace(
                            h=h,
                            client=client,
                            url=url,
                            gateway=gateway,
                            broker=broker,
                            native=native,
                            native_url=native_url,
                            calls=calls,
                            writes=writes,
                            stage=staging,
                            last_bytes=last_bytes,
                            ledger=ledger,
                        )
                    finally:
                        await gateway.close()
        await native.broker.close()
        await broker.close()
        await h.service.close()
        if ledger is not None:
            ledger.authority.close()


def proof(network, path, *, method="GET", data=b"", n=3, selectors=None, transport="http"):
    h = network.h
    payload = h.payload(
        n=n,
        method=method,
        rawTarget=path,
        bodySha256=wire.encode(hashlib.sha256(data).digest()),
        bodyBytes=len(data),
        transport=transport,
        launchId=h.session["launchId"],
    )
    payload["headers"].update(selectors or {})
    return payload, h.signed(payload)


@pytest.mark.asyncio
async def test_real_range_response_and_independent_native_proof(network):
    path = "/api/personal-space/files/" + "1" * 32 + "/content"
    payload, signed = proof(network, path, selectors={"range": "bytes=1-3", "ifRange": '"v1"'})
    response = await network.client.get(
        path, headers={"x-centuarai-data-proof": signed, "range": "bytes=1-3", "if-range": '"v1"'}
    )
    assert response.status_code == 206, response.text
    assert response.content == b"bcd" and response.headers["content-range"] == "bytes 1-3/6"
    assert "set-cookie" not in response.headers and "x-centuarai-private" not in response.headers
    assert network.calls[0][1]["headers"]["range"] == payload["headers"]["range"]
    assert network.calls[0][1]["sessionId"] == network.h.session["sessionId"]


@pytest.mark.asyncio
async def test_real_concurrent_replay_exactly_one_handler(network):
    path = "/api/personal-space/files/" + "2" * 32
    _, signed = proof(network, path)
    responses = await asyncio.gather(
        *(network.client.get(path, headers={"x-centuarai-data-proof": signed}) for _ in range(12))
    )
    assert [r.status_code for r in responses].count(200) == 1
    assert [r.status_code for r in responses].count(403) == 11
    assert len(network.calls) == 1
    print("request replay concurrency=12 accepted=1 denied=11 native-handlers=1")


@pytest.mark.asyncio
async def test_real_staged_upload_no_handler_before_complete_and_hash_mismatch_denies(network):
    path = "/api/personal-space/uploads/" + "3" * 32 + "?offset=0"
    data = b"verified body" * 1000
    _, signed = proof(
        network,
        path,
        method="PUT",
        data=data,
        selectors={"contentSha256": hashlib.sha256(data).hexdigest()},
    )
    release = asyncio.Event()
    sent = asyncio.Event()

    async def chunks():
        yield data[:100]
        sent.set()
        await release.wait()
        yield data[100:]

    pending = asyncio.create_task(
        network.client.put(
            path,
            content=chunks(),
            headers={
                "content-length": str(len(data)),
                "x-centuarai-data-proof": signed,
                "x-content-sha256": hashlib.sha256(data).hexdigest(),
            },
        )
    )
    await sent.wait()
    await asyncio.sleep(0.08)
    assert network.calls == []
    release.set()
    response = await pending
    assert response.status_code == 200, response.text
    assert network.writes == [data]
    _, signed = proof(network, path, method="PUT", data=b"right", n=4)
    response = await network.client.put(
        path, content=b"wrong", headers={"x-centuarai-data-proof": signed}
    )
    assert response.status_code == 403 and len(network.writes) == 1
    assert list(network.stage.iterdir()) == []


@pytest.mark.asyncio
async def test_real_range_download_revocation_truncates_without_valid_terminator(network):
    path = "/api/personal-space/files/" + "5" * 32 + "/content"
    _, signed = proof(network, path, selectors={"range": "bytes=0-1048575"})
    observed = []
    seen = asyncio.Event()
    truncated = []

    async def consume():
        try:
            async with network.client.stream(
                "GET", path, headers={"x-centuarai-data-proof": signed, "range": "bytes=0-1048575"}
            ) as response:
                assert response.status_code == 206
                async for chunk in response.aiter_raw():
                    if chunk:
                        observed.append((time.monotonic_ns(), len(chunk)))
                        seen.set()
        except httpx.RemoteProtocolError:
            truncated.append(True)

    reading = asyncio.create_task(consume())
    await asyncio.wait_for(seen.wait(), 2)
    committed = time.monotonic_ns()
    network.h.view["status"] = "revoked"
    await asyncio.wait_for(reading, 5)
    elapsed = (time.monotonic_ns() - committed) / 1e9
    assert truncated == [True] and sum(size for _, size in observed) < 1048576
    assert elapsed < 5 and observed[-1][0] - committed < 5_000_000_000
    print(
        f"Range revoke->closed={elapsed:.6f}s last-byte-after-commit={max(0, observed[-1][0] - committed) / 1e9:.6f}s bytes={sum(size for _, size in observed)}"
    )


@pytest.mark.asyncio
async def test_real_upload_revocation_before_staging_complete_has_zero_side_effect(network):
    path = "/api/personal-space/uploads/" + "7" * 32 + "?offset=0"
    body = b"staged" * 1000
    _, signed = proof(network, path, method="PUT", data=body)
    started = asyncio.Event()
    release = asyncio.Event()

    async def chunks():
        yield body[:16]
        started.set()
        await release.wait()
        yield body[16:]

    upload = asyncio.create_task(
        network.client.put(
            path,
            content=chunks(),
            headers={"x-centuarai-data-proof": signed, "content-length": str(len(body))},
        )
    )
    await started.wait()
    for _ in range(100):
        if network.gateway.operations:
            break
        await asyncio.sleep(0.01)
    assert network.gateway.operations and network.calls == []
    committed = time.monotonic_ns()
    network.h.view["status"] = "revoked"
    while network.gateway.operations:
        assert time.monotonic_ns() - committed < 5_000_000_000
        await asyncio.sleep(0.01)
    elapsed = (time.monotonic_ns() - committed) / 1e9
    release.set()
    response = await upload
    assert response.status_code == 403 and network.calls == [] and network.writes == []
    assert not list(network.stage.iterdir())
    print(f"Upload revoke->physical-stage-close={elapsed:.6f}s native-handlers=0")


@pytest.mark.asyncio
async def test_real_sse_revocation_stops_bytes_under_five_seconds(network):
    path = "/api/dialogue/sessions/session1/events"
    _, signed = proof(network, path)
    seen = asyncio.Event()
    observed = []

    async def consume():
        try:
            async with network.client.stream(
                "GET", path, headers={"x-centuarai-data-proof": signed}
            ) as response:
                assert response.status_code == 200
                async for chunk in response.aiter_raw():
                    if chunk:
                        observed.append(time.monotonic_ns())
                        seen.set()
        except httpx.RemoteProtocolError:
            pass

    reading = asyncio.create_task(consume())
    await asyncio.wait_for(seen.wait(), 2)
    committed = time.monotonic_ns()
    network.h.view["status"] = "revoked"
    # No explicit notification: independently exercise <=1s authoritative polling.
    await asyncio.wait_for(reading, 5)
    elapsed = (time.monotonic_ns() - committed) / 1e9
    assert elapsed < 5 and max(observed) - committed < 5_000_000_000
    print(
        f"SSE revoke->closed={elapsed:.6f}s last-byte-after-commit={max(0, max(observed) - committed) / 1e9:.6f}s"
    )


@pytest.mark.asyncio
async def test_real_chat_websocket_fresh_upstream_key_and_idle_revoke(network):
    path = "/api/agents/agent1/chat/ws"
    ctx = ssl._create_unverified_context()
    observed = []

    class Bound(ClientConnection):
        async def handshake(self, additional_headers=None, user_agent_header=None):
            request = self.protocol.connect()
            _, signed = proof(
                network,
                path,
                transport="websocket",
                selectors={"webSocketKey": request.headers["Sec-WebSocket-Key"]},
            )
            await super().handshake({"x-centuarai-data-proof": signed})

    async with connect(
        "wss" + network.url[5:] + path,
        ssl=ctx,
        proxy=None,
        compression=None,
        create_connection=Bound,
        close_timeout=0.5,
    ) as ws:
        await ws.send("echo")
        assert await asyncio.wait_for(ws.recv(), 2) == "echo"
        assert (
            network.calls[0][1]["headers"]["webSocketKey"]
            != ws.request.headers["Sec-WebSocket-Key"]
        )
        committed = time.monotonic_ns()
        network.h.view["status"] = "revoked"
        try:
            async with asyncio.timeout(5):
                while True:
                    await ws.recv()
                    observed.append(time.monotonic_ns())
        except ConnectionClosed:
            pass
        elapsed = (time.monotonic_ns() - committed) / 1e9
        assert elapsed < 5 and (not observed or max(observed) - committed < 5_000_000_000)
        print(
            f"WS revoke->closed={elapsed:.6f}s last-frame-after-commit={max(0, max(observed, default=committed) - committed) / 1e9:.6f}s"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path",
    [
        "/api/auth/login",
        "/api/auth/platform/exchange",
        "/api/terminal",
        "/api/desktop/stream",
        "/api/mobile/stream",
        "/api/browser-stream/ws",
        "/api/admin/settings",
        "/api/internal/mcp",
        "/unknown",
    ],
)
async def test_real_legacy_host_and_unknown_paths_deny_without_native_handler(network, path):
    _, signed = proof(network, path)
    response = await network.client.get(path, headers={"x-centuarai-data-proof": signed})
    assert response.status_code == 403 and network.calls == []


@pytest.mark.asyncio
async def test_real_native_direct_request_with_old_bearer_fails(network):
    async with httpx.AsyncClient(trust_env=False) as client:
        response = await client.get(
            network.native_url + "/api/personal-space/files",
            headers={"Authorization": "Bearer copied-native-token"},
        )
    assert response.status_code == 403 and network.calls == []


@pytest.mark.asyncio
async def test_real_operation_capacity_denies_before_upstream_and_cleans_stage(network):
    network.h.service.limits["operations_per_session"] = 1
    path = "/api/dialogue/sessions/session1/events"
    _, signed = proof(network, path)
    async with network.client.stream(
        "GET", path, headers={"x-centuarai-data-proof": signed}
    ) as stream:
        assert stream.status_code == 200
        other = "/api/personal-space/files/" + "4" * 32
        _, signed = proof(network, other, n=8)
        response = await network.client.get(other, headers={"x-centuarai-data-proof": signed})
        assert response.status_code == 403 and response.json()["code"] == "LOCAL_DATA_CAPACITY"
        assert len(network.calls) == 1 and network.gateway.measurements["capacityDenied"] == 1
        print(
            "operation cap=1 active-stream=1 second-request=LOCAL_DATA_CAPACITY native-handlers=1"
        )
    await asyncio.sleep(0.1)
    assert list(network.stage.iterdir()) == []


@pytest.mark.asyncio
async def test_real_clipboard_child_hop_fixed_audience_and_private_scope(network):
    from centuarai_local_data_gate.protocol import DataProtocolError

    network.broker.audience_uids["clipboard"] = frozenset({os.geteuid()})
    config = GateConfig(
        "clipboard",
        "gateway:test",
        wire.public_jwk(network.h.gateway),
        "box:test",
        network.h.view["boxKeyThumbprint"],
        str(network.broker.socket_path),
        network.stage,
    )
    targets = ["/api/personal-space/files/" + "8" * 32 + "/content"]

    async def clipboard(scope, receive, send):
        context = scope["centuarai.local_data"]
        try:
            headers = await asyncio.to_thread(
                context.child_headers,
                audience="octop",
                method="GET",
                raw_target=targets[0],
                headers=[],
                body=b"",
            )
            async with httpx.AsyncClient(trust_env=False) as client:
                response = await client.get(network.native_url + targets[0], headers=headers)
            status, body = response.status_code, response.content
        except DataProtocolError:
            status, body = 403, b"denied"
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(b"content-length", str(len(body)).encode())],
            }
        )
        await send({"type": "http.response.body", "body": body})

    native = LocalDataGateMiddleware(clipboard, config=config)
    try:
        async with server(native) as url:
            network.gateway.upstreams["clipboard"] = url
            path = "/api/clipboard/v1/" + "9" * 32 + "/content"
            _, signed = proof(network, path, n=70)
            response = await network.client.get(path, headers={"x-centuarai-data-proof": signed})
            assert response.status_code == 200 and response.content == b"abcdef"
            claims = network.calls[-1][1]
            assert claims["parentOperationId"] is not None and claims["audience"] == "octop"
            assert claims["serviceContext"]["clipboardScope"] == {
                "application": "wanx.clipboard",
                "exportId": None,
                "parent": None,
            }
            assert claims["principalId"] == network.h.view["principalId"]
            targets[0] = "/api/auth/me"
            _, signed = proof(network, path, n=71)
            response = await network.client.get(path, headers={"x-centuarai-data-proof": signed})
            assert response.status_code == 403 and len(network.calls) == 1
    finally:
        await native.broker.close()


@pytest.mark.asyncio
async def test_real_anonymous_flood_cannot_allocate_challenges_or_block_heartbeat_and_initial_pop(
    network,
):
    replies = await asyncio.gather(
        *(network.client.post("/local-trust/v1/data/session-challenge", json={}) for _ in range(48))
    )
    denied = sum(response.json().get("code") == "LOCAL_DATA_CAPACITY" for response in replies)
    assert denied >= 16 and len(network.gateway.source_budgets) == 1
    heartbeat = network.h.payload("heartbeat", n=80, launchId=network.h.session["launchId"])
    reply = await network.client.post(
        "/local-trust/v1/data/heartbeat", json={"proof": network.h.signed(heartbeat)}
    )
    assert reply.status_code == 200 and network.calls == []
    assert not network.h.service._challenges
    h = network.h
    channel = ec.generate_private_key(ec.SECP256R1())
    intent = h.intent(
        launchId=wire.encode(b"n" * 32),
        requestId=wire.encode(b"q" * 32),
        channelKey=wire.public_jwk(channel),
    )
    start = await network.client.post("/local-trust/v1/data/session-challenge", json=intent)
    assert start.status_code == 200, start.text
    challenge = h.response(start.text, "session-challenge")
    proposal = wire.verify_session_intent(
        intent["proof"], wire.public_jwk(h.access), now_ms=h.clock.wall
    )
    payload = {
        "schemaVersion": 1,
        "purpose": "centuarai.local-data.session",
        **{name: h.view[name] for name in wire.IDENTITY},
        **{
            name: proposal[name]
            for name in ("requestId", "channelKey", "applicationId", "launchId")
        },
        "gatewayGeneration": challenge["gatewayGeneration"],
        "challenge": challenge["challenge"],
        "issuedAtMs": h.clock.wall,
        "expiresAtMs": challenge["expiresAtMs"],
    }
    created = await network.client.post(
        "/local-trust/v1/data/sessions", json={"accessProof": wire.sign_session(payload, h.access)}
    )
    assert created.status_code == 200, created.text
    assert h.response(created.text, "session")["sessionId"] != h.session["sessionId"]
    print(
        f"anonymous handshake concurrency=48 capacity-denied={denied} allocated=0 heartbeat=200 initial-PoP=200"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("network", ["ledger"], indirect=True)
async def test_real_ledger_commit_to_transport_close_and_signed_positive_effect(network):
    from test_local_ledger import actor, commit, prepare, verified

    from wanx_bridge import local_ledger_protocol as ledger_wire

    ledger, sessions = network.ledger, network.h.service
    loop = asyncio.get_running_loop()
    changes = []
    committed_times = []
    changes_seen = asyncio.Event()

    async def changed(value):
        assert value is not None
        changes.append(value)
        await sessions.observe_commit(value)
        await sessions.invalidate_authority()
        changes_seen.set()

    pending = set()

    def schedule(value):
        task = asyncio.create_task(changed(value))
        pending.add(task)

    def committed(value):
        committed_times.append(time.monotonic_ns())
        loop.call_soon_threadsafe(schedule, value)

    ledger.authority.install_commit_observer(committed)
    ledger.authority.install_effect_provider(
        sessions.effect_snapshot, generation=sessions.generation
    )
    review = await asyncio.to_thread(
        prepare,
        ledger,
        "device.revoke",
        {"bindingId": ledger.use.binding_id, "mode": "normal"},
        now=network.h.clock.wall // 1000,
    )
    path = "/api/personal-space/files/" + "5" * 32 + "/content"
    _, signed = proof(network, path, selectors={"range": "bytes=0-1048575"})
    seen = asyncio.Event()
    observed = []
    truncated = []

    async def consume():
        try:
            async with network.client.stream(
                "GET", path, headers={"x-centuarai-data-proof": signed, "range": "bytes=0-1048575"}
            ) as response:
                assert response.status_code == 206
                async for chunk in response.aiter_raw():
                    if chunk:
                        observed.append(time.monotonic_ns())
                        seen.set()
        except httpx.RemoteProtocolError:
            truncated.append(True)

    reading = asyncio.create_task(consume())
    await asyncio.wait_for(seen.wait(), 2)
    before = time.monotonic_ns()
    await asyncio.to_thread(commit, ledger, review, now=network.h.clock.wall // 1000)
    await asyncio.wait_for(changes_seen.wait(), 2)
    await asyncio.gather(*pending)
    await asyncio.wait_for(reading, 5)
    closed = time.monotonic_ns()
    assert len(committed_times) == 1 and truncated == [True]
    expected = {
        key: value
        for key, value in changes[0].items()
        if key not in {"affectedBindingIds", "affectedJobs", "affectedJobsComplete"}
    }
    while True:
        snapshot = sessions.effect_snapshot(expected["operationId"], expected)
        if snapshot and snapshot["effectState"] == "effective":
            break
        assert time.monotonic_ns() - before < 5_000_000_000, snapshot
        await asyncio.sleep(0.01)
    assert snapshot["gateway"]["closedSessions"] == snapshot["gateway"]["targetSessions"] == 1
    assert snapshot["native"]["closedOperations"] == snapshot["native"]["targetOperations"] == 1
    assert snapshot["native"]["unknownOperations"] == 0 and not list(network.stage.iterdir())
    now = network.h.clock.wall // 1000
    challenge = verified(ledger, ledger.authority.auth_challenge_v2(now), "read-challenge")
    read_payload = {
        "schemaVersion": 2,
        "purpose": "centuarai.local-ledger.read",
        "boxId": "box:test",
        "boxKeyThumbprint": challenge["context"]["boxKeyThumbprint"],
        "ownershipEpoch": challenge["context"]["ownershipEpoch"],
        "nonce": challenge["nonce"],
        "issuedAt": now,
        "expiresAt": now + 60,
        "actor": actor(ledger.root),
        "operation": "data-effect",
        "requestId": expected["operationId"],
        "bindingId": None,
    }
    response = await asyncio.to_thread(
        ledger.authority.read_v2, ledger_wire.sign_read(read_payload, ledger.root.access), now
    )
    signed_effect = wire.verify_data_response(
        response,
        ledger.provisioned.bundle["boxKey"],
        box_id="box:test",
        kind="effect",
        now_ms=network.h.clock.wall,
    )["body"]
    assert signed_effect == snapshot
    assert (closed - before) < 5_000_000_000 and max(observed) - committed_times[0] < 5_000_000_000
    print(
        f"Real SQLite commit->Range TCP-close={(closed - committed_times[0]) / 1e9:.6f}s conservative-submit->close={(closed - before) / 1e9:.6f}s last-byte-after-commit={max(0, max(observed) - committed_times[0]) / 1e9:.6f}s signed-effect=effective gateway=1/1 native=1/1"
    )


@pytest.mark.asyncio
async def test_same_peer_four_devices_with_fourteen_children_renew_during_anonymous_flood(network):
    h = network.h
    views = {h.view["bindingId"]: h.view}

    def query(binding_id, now):
        return copy.deepcopy(views[binding_id])

    h.service.authority = SimpleNamespace(get_authorization=query)
    old = []
    for device in range(4):
        access = ec.generate_private_key(ec.SECP256R1())
        view = {
            **h.view,
            "bindingId": f"binding:device-{device}",
            "clientId": f"client:device-{device}",
            "accessKey": wire.public_jwk(access),
        }
        views[view["bindingId"]] = view
        for launch in range(15):
            application = "wanx-host" if launch == 0 else "centaurai.wanx.zhijun"
            launch_id = wire.encode(os.urandom(32))
            channel = ec.generate_private_key(ec.SECP256R1())
            request_id = wire.encode(os.urandom(32))
            challenge = h.response(
                await h.service.challenge(
                    h.intent(
                        key=access,
                        bindingId=view["bindingId"],
                        applicationId=application,
                        launchId=launch_id,
                        requestId=request_id,
                        channelKey=wire.public_jwk(channel),
                    )
                ),
                "session-challenge",
            )
            payload = {
                "schemaVersion": 1,
                "purpose": "centuarai.local-data.session",
                **{name: view[name] for name in wire.IDENTITY},
                "gatewayGeneration": h.service.generation,
                "challenge": challenge["challenge"],
                "requestId": request_id,
                "channelKey": wire.public_jwk(channel),
                "applicationId": application,
                "launchId": launch_id,
                "issuedAtMs": h.clock.wall,
                "expiresAtMs": challenge["expiresAtMs"],
            }
            session = h.response(
                await h.service.create_session(wire.sign_session(payload, access)), "session"
            )
            old.append((session, view, access, channel))
    # Existing authenticated devices were established before this source became
    # hostile. The same real TLS peer now exhausts only anonymous handshake slots.
    await asyncio.gather(
        *(network.client.post("/local-trust/v1/data/session-challenge", json={}) for _ in range(48))
    )
    denied_before = network.gateway.measurements["capacityDenied"]
    stop = asyncio.Event()

    async def flood():
        while not stop.is_set():
            await asyncio.gather(
                *(
                    network.client.post("/local-trust/v1/data/session-challenge", json={})
                    for _ in range(4)
                )
            )

    flooding = asyncio.create_task(flood())

    async def renew(item):
        session, view, access, channel = item
        next_channel = ec.generate_private_key(ec.SECP256R1())
        request_id = wire.encode(os.urandom(32))
        now = h.clock.wall
        renewal = {
            "schemaVersion": 1,
            "purpose": "centuarai.local-data.renewal",
            "boxId": "box:test",
            "sessionId": session["sessionId"],
            "gatewayGeneration": h.service.generation,
            "applicationId": session["applicationId"],
            "launchId": session["launchId"],
            "jti": wire.encode(os.urandom(32)),
            "requestId": request_id,
            "channelKey": wire.public_jwk(next_channel),
            "issuedAtMs": now,
            "expiresAtMs": now + 3000,
        }
        response = await network.client.post(
            "/local-trust/v1/data/renewal-challenge",
            json={"proof": wire.sign_channel(renewal, channel, kind="renewal")},
        )
        assert response.status_code == 200, response.text
        challenge = h.response(response.text, "session-challenge")
        payload = {
            "schemaVersion": 1,
            "purpose": "centuarai.local-data.session",
            **{name: view[name] for name in wire.IDENTITY},
            "gatewayGeneration": h.service.generation,
            "challenge": challenge["challenge"],
            "requestId": request_id,
            "channelKey": wire.public_jwk(next_channel),
            "applicationId": session["applicationId"],
            "launchId": session["launchId"],
            "issuedAtMs": h.clock.wall,
            "expiresAtMs": challenge["expiresAtMs"],
        }
        response = await network.client.post(
            "/local-trust/v1/data/renewals",
            json={"accessProof": wire.sign_session(payload, access)},
        )
        assert response.status_code == 200, response.text
        fresh = h.response(response.text, "session")
        assert (
            fresh["sessionId"] != session["sessionId"]
            and fresh["authorization"]["grants"] == session["authorization"]["grants"]
        )
        return fresh

    started = time.monotonic()
    try:
        results = await asyncio.gather(*(renew(item) for item in old))
    finally:
        stop.set()
        await flooding
    assert len({row["sessionId"] for row in results}) == 60
    assert network.gateway.measurements["capacityDenied"] > denied_before
    assert len(network.gateway.source_budgets) == 1
    assert len(h.service._renewal_budgets) == 4
    print(
        f"same-peer authenticated renewal devices=4 launches/device=15 fresh-sessions=60 anonymous-flood=denied elapsed={time.monotonic() - started:.6f}s"
    )
