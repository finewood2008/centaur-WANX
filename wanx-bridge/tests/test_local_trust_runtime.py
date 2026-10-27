"""Independent listener, real TLS, bounded workers and old-proxy isolation."""

import asyncio
import base64
import hashlib
import ipaddress
import json
import os
import socket
import ssl
import threading
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
import uvicorn
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from wanx_bridge import local_management_protocol as wire
from wanx_bridge import local_trust_server as server_module
from wanx_bridge import local_trust_service as service_module
from wanx_bridge.local_authority_store import LocalTrustAuthority, initialize_authority
from wanx_bridge.local_trust_config import LocalTrustConfig, LocalTrustError
from wanx_bridge.local_trust_protocol import BindingProtocolError
from wanx_bridge.local_trust_runtime import runtime_lock, server_for
from wanx_bridge.local_trust_server import PREFIX, create_app
from wanx_bridge.local_trust_service import CONCURRENCY, LocalTrustService
from wanx_bridge.server import _allowed
from wanx_bridge.server import create_app as legacy_app

posix_only = pytest.mark.skipif(os.name != "posix", reason="Box-side private authority storage")


def write_private(path, content):
    path.write_bytes(content)
    path.chmod(0o600)


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


@pytest.fixture
def configured(tmp_path):
    if os.name != "posix":
        pytest.skip("Box-side private authority storage")
    directory = tmp_path / "authority"
    directory.mkdir(mode=0o700)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    port = sock.getsockname()[1]
    box = ec.derive_private_key(31, ec.SECP256R1())
    tls = ec.derive_private_key(41, ec.SECP256R1())
    now = datetime.now(UTC)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "synthetic-local-box")])
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(tls.public_key())
        .serial_number(12345)
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            critical=False,
        )
        .sign(tls, hashes.SHA256())
    )
    for filename, key in (("box-signing-key.pem", box), ("tls-key.pem", tls)):
        write_private(
            directory / filename,
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ),
        )
    write_private(directory / "tls-cert.pem", certificate.public_bytes(serialization.Encoding.PEM))
    bundle = {
        "schemaVersion": 1,
        "type": "centuarai-local-trust-private",
        "boxId": "test-box",
        "baseUrl": f"https://127.0.0.1:{port}",
        "boxKey": wire.public_jwk(box),
        "tlsSpkiSha256": b64(
            hashlib.sha256(
                tls.public_key().public_bytes(
                    serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
                )
            ).digest()
        ),
        "provisioningId": b64(b"p" * 32),
        "ownershipEpoch": 1,
        "grants": [{"resourceId": "personal", "actions": ["read", "write"]}],
        "claimSecretSha256": b64(hashlib.sha256(b"synthetic-claim-material").digest()),
        "sourceEvidenceKind": "full-erase",
        "sourceEvidenceSha256": b64(b"e" * 32),
    }
    write_private(directory / "private-bundle.json", wire.canonical(bundle))
    initialize_authority(directory, now=int(time.time()))
    config = {
        "schemaVersion": 1,
        "bindHost": "127.0.0.1",
        "bindPort": port,
        "stateDirectory": str(directory),
    }
    filename = tmp_path / "management.json"
    write_private(filename, json.dumps(config).encode())
    try:
        yield SimpleNamespace(
            directory=directory, filename=filename, config=config, bundle=bundle, box=box, sock=sock
        )
    finally:
        sock.close()


@asynccontextmanager
async def running(server, sock):
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                if task.done():
                    await task
                    raise AssertionError("listener did not start")
                await asyncio.sleep(0.01)
        yield
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 10)


def test_config_does_not_require_cloud_credentials(configured, monkeypatch):
    for name in (
        "WANX_PLATFORM_SSO_ENABLED",
        "WANX_PLATFORM_DEVICE_ID",
        "WANX_PLATFORM_BOX_KEY_FILE",
        "WANX_PLATFORM_PUBLIC_KEY_FILE",
    ):
        monkeypatch.delenv(name, raising=False)
    value = LocalTrustConfig.load(configured.filename)
    assert value.base_url == configured.bundle["baseUrl"]
    assert value.state_directory == configured.directory


@pytest.mark.parametrize("first", ["_", "-"])
async def test_random_boot_id_always_satisfies_authority_protocol(configured, monkeypatch, first):
    from wanx_bridge import local_team_config, local_trust_operations_loader
    from wanx_bridge import local_trust_runtime as runtime

    random_value = first + "a" * 42
    monkeypatch.setattr(
        runtime, "secrets", SimpleNamespace(token_urlsafe=lambda size: random_value)
    )
    monkeypatch.setattr(local_team_config, "load_team_identity_policy", lambda: None)
    monkeypatch.setattr(
        local_trust_operations_loader, "create_operation_provider", lambda value: None
    )
    boots = []

    def server(config, service, application):
        async def serve_with_cleanup(cleanup):
            try:
                boots.append(service._authority._boot_id)
            finally:
                await cleanup.aclose()

        return SimpleNamespace(serve_with_cleanup=serve_with_cleanup)

    monkeypatch.setattr(runtime, "server_for", server)
    await runtime._serve(LocalTrustConfig.load(configured.filename))
    assert len(boots) == 1
    assert boots[0].endswith(random_value)


@pytest.mark.parametrize(
    "problem",
    [
        "unknown",
        "network-socket-override",
        "disable-wifi",
        "boolean-port",
        "relative-dir",
        "http",
        "path",
        "pin",
        "missing-db",
        "mode",
        "symlink",
    ],
)
def test_configuration_errors_fail_without_reinitializing(configured, problem):
    config = dict(configured.config)
    if problem == "unknown":
        config["cloudAccount"] = "not-a-trust-root"
    elif problem == "network-socket-override":
        config["networkSocket"] = "/tmp/caller.sock"
    elif problem == "disable-wifi":
        config["wifiEnabled"] = False
    elif problem == "boolean-port":
        config["bindPort"] = True
    elif problem == "relative-dir":
        config["stateDirectory"] = "authority"
    elif problem in {"http", "path", "pin"}:
        bundle = dict(configured.bundle)
        if problem == "http":
            bundle["baseUrl"] = bundle["baseUrl"].replace("https:", "http:")
        elif problem == "path":
            bundle["baseUrl"] += PREFIX
        else:
            bundle["tlsSpkiSha256"] = b64(b"x" * 32)
        write_private(configured.directory / "private-bundle.json", wire.canonical(bundle))
    elif problem == "missing-db":
        (configured.directory / "local-authority.sqlite3").unlink()
    elif problem == "mode":
        (configured.directory / "tls-key.pem").chmod(0o644)
    else:
        target = configured.directory / "tls-key.pem"
        target.rename(configured.directory / "saved-tls-key.pem")
        target.symlink_to(configured.directory / "saved-tls-key.pem")
    write_private(configured.filename, json.dumps(config).encode())
    with pytest.raises(LocalTrustError, match="LOCAL_TRUST_CONFIG_INVALID"):
        LocalTrustConfig.load(configured.filename)
    if problem == "missing-db":
        assert not (configured.directory / "local-authority.sqlite3").exists()


def test_runtime_lock_is_exclusive_and_not_removed(configured):
    with runtime_lock(configured.directory):
        with (
            pytest.raises(LocalTrustError, match="LOCAL_TRUST_ALREADY_RUNNING"),
            runtime_lock(configured.directory),
        ):
            pass
    assert (configured.directory / "management-runtime.lock").exists()
    with runtime_lock(configured.directory):
        pass


@pytest.mark.asyncio
async def test_real_https_listener_signs_minimal_challenge_without_old_auth(configured):
    config = LocalTrustConfig.load(configured.filename)
    authority = LocalTrustAuthority(config.state_directory, boot_id="test-https")
    service = LocalTrustService(authority)
    server = server_for(config, service)
    assert server.config.proxy_headers is False and server.config.workers == 1
    context = ssl.create_default_context(cafile=str(config.tls_certificate))
    async with running(server, configured.sock):
        async with httpx.AsyncClient(
            base_url=config.base_url, verify=context, trust_env=False
        ) as client:
            response = await client.post(PREFIX + "/first-root/challenge", json={})
            assert response.status_code == 200
            assert response.headers["content-type"] == "application/jose"
            assert response.headers["cache-control"] == "no-store"
            payload = wire.verify_response(
                response.text,
                configured.bundle["boxKey"],
                box_id="test-box",
                kind="first-root-challenge",
            )
            assert set(payload["body"]) == {
                "provisioningId",
                "ownershipEpoch",
                "challenge",
                "issuedAt",
                "expiresAt",
                "grants",
            }
            assert "claimSecret" not in response.text and "bindings" not in payload["body"]
            denied = await client.post(
                PREFIX + "/state",
                json={"proof": "invalid"},
                headers={"Authorization": "Bearer old-cloud-token"},
            )
            assert denied.status_code == 403 and denied.json() == {
                "code": "LOCAL_TRUST_TRANSPORT_DENIED"
            }
        async with httpx.AsyncClient(verify=True, trust_env=False) as client:
            with pytest.raises(httpx.ConnectError):
                await client.post(config.base_url + PREFIX + "/first-root/challenge", json={})


class FakeAuthority:
    def __init__(self):
        self.calls = []
        self.closed = False

    def first_root_challenge(self, now):
        self.calls.append(("public", now, threading.get_ident()))
        return "synthetic.signed.response"

    def read_state(self, proof, now):
        self.calls.append(("management", now, threading.get_ident()))
        if proof == "raise-private-error":
            raise ValueError("never-log-private-proof")
        raise BindingProtocolError("LOCAL_TRUST_NOT_FOUND")

    def close(self):
        self.closed = True


@pytest.fixture
async def endpoint():
    authority = FakeAuthority()
    service = LocalTrustService(authority, clock=lambda: 1792886400)
    app = create_app(service, authority="box.test")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://box.test"
    ) as client:
        yield client, authority, service
    await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("body", ["[]", '{"extra":1}', '{"x":1,"x":2}', "not-json"])
async def test_strict_empty_body_schema(endpoint, body):
    client, authority, _ = endpoint
    response = await client.post(
        PREFIX + "/first-root/challenge", content=body, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 400 and authority.calls == []
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["http", "host", "origin", "cookie", "query", "bearer"])
async def test_transport_metadata_never_grants_management_access(endpoint, change):
    client, authority, _ = endpoint
    headers = {}
    url = PREFIX + "/first-root/challenge"
    if change == "http":
        url = "http://box.test" + url
        headers["X-Forwarded-Proto"] = "https"
    elif change == "query":
        url += "?token=old-bearer"
    else:
        header = {
            "host": "Host",
            "origin": "Origin",
            "cookie": "Cookie",
            "bearer": "Authorization",
        }[change]
        headers[header] = {
            "host": "evil.test",
            "origin": "https://renderer",
            "cookie": "token=old",
            "bearer": "Bearer old",
        }[change]
    response = await client.post(url, json={}, headers=headers)
    assert response.status_code == 403 and authority.calls == []


@pytest.mark.asyncio
async def test_limits_methods_read_denials_and_no_private_exception_text(endpoint, caplog):
    client, authority, _ = endpoint
    assert (
        await client.post(
            PREFIX + "/first-root/challenge",
            content=b"x" * 18433,
            headers={"Content-Type": "application/json"},
        )
    ).status_code == 413
    for method in ("GET", "PUT", "PATCH", "DELETE", "OPTIONS"):
        response = await client.request(method, PREFIX + "/first-root/challenge")
        assert response.status_code == 405 and response.headers["cache-control"] == "no-store"
    assert (await client.post(PREFIX + "/first-root/challenge/", json={})).status_code == 404
    for proof in ("unknown-request", "wrong-key"):
        response = await client.post(PREFIX + "/state", json={"proof": proof})
        assert response.status_code == 403 and response.json() == {
            "code": "LOCAL_TRUST_READ_DENIED"
        }
    response = await client.post(PREFIX + "/state", json={"proof": "raise-private-error"})
    assert response.status_code == 503
    assert "never-log-private-proof" not in response.text + caplog.text
    assert all(call[2] != threading.get_ident() for call in authority.calls)


@pytest.mark.asyncio
async def test_public_source_budget_is_independent_of_management(endpoint, monkeypatch):
    client, authority, _ = endpoint
    monkeypatch.setitem(service_module.SOURCE_PER_MINUTE, "public", 1)
    assert (await client.post(PREFIX + "/first-root/challenge", json={})).status_code == 200
    assert (await client.post(PREFIX + "/first-root/challenge", json={})).status_code == 429
    assert (await client.post(PREFIX + "/state", json={"proof": "wrong-key"})).status_code == 403
    assert len(authority.calls) == 2


@pytest.mark.asyncio
async def test_deep_json_and_slow_body_fail_before_authority_and_release_slot(
    endpoint, monkeypatch
):
    client, authority, service = endpoint
    response = await client.post(
        PREFIX + "/first-root/challenge",
        content='{"value":' + "[" * 2000 + "0" + "]" * 2000 + "}",
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 400
    monkeypatch.setattr(server_module, "BODY_TIMEOUT", 0.01)

    async def slow_body():
        yield b"{"
        await asyncio.sleep(1)
        yield b"}"

    response = await client.post(
        PREFIX + "/first-root/challenge",
        content=slow_body(),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 408
    assert response.headers["cache-control"] == "no-store"
    assert authority.calls == [] and service._active["public"] == 0


@pytest.mark.asyncio
async def test_forwarded_source_does_not_change_source_budget(endpoint, monkeypatch):
    client, authority, _ = endpoint
    monkeypatch.setitem(service_module.SOURCE_PER_MINUTE, "public", 1)
    for attempt, source in enumerate(("192.0.2.1", "192.0.2.2")):
        response = await client.post(
            PREFIX + "/first-root/challenge",
            json={},
            headers={"X-Forwarded-For": source, "Forwarded": f"for={source}"},
        )
        assert response.status_code == (200 if attempt == 0 else 429)
    assert len(authority.calls) == 1


@pytest.mark.asyncio
async def test_cancelled_http_jobs_keep_capacity_until_worker_finishes():
    entered, release = threading.Event(), threading.Event()
    authority = FakeAuthority()

    def blocked(now):
        entered.set()
        assert release.wait(5)
        return "signed"

    authority.first_root_challenge = blocked
    service = LocalTrustService(authority)

    async def request():
        async with service.admission("127.0.0.1", "first-root/challenge") as ticket:
            return await service.invoke(ticket, "first-root/challenge", {})

    tasks = [asyncio.create_task(request()) for _ in range(CONCURRENCY["public"])]
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        with pytest.raises(LocalTrustError, match="LOCAL_TRUST_RATE_LIMITED"):
            async with service.admission("127.0.0.2", "first-root/challenge"):
                pass
        async with service.admission("127.0.0.1", "state"):
            pass
    finally:
        release.set()
        await service.close()
    assert authority.closed and not service._jobs


@pytest.mark.parametrize(
    "path",
    [
        "/local-trust",
        "/local-trust/v1/state",
        "/LOCAL-TRUST/v1/state",
        "/%6cocal-trust/v1/state",
        "/%256cocal-trust/v1/state",
        "//local-trust/v1/state",
        "/foo/../local-trust/v1/state",
        "/local-trust\\v1\\state",
    ],
)
def test_legacy_bridge_denies_management_prefix_for_every_method_and_alias(path):
    for method in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "WEBSOCKET"):
        assert _allowed(path, method) is False


@pytest.mark.asyncio
async def test_legacy_bridge_http_and_websocket_never_authorize_or_forward():
    class NoLegacyAuth:
        def authorize(self, *_):
            raise AssertionError("old authorization must not run")

    def no_upstream(_):
        raise AssertionError("management must never be proxied")

    app = legacy_app(NoLegacyAuth(), object(), http_transport=httpx.MockTransport(no_upstream))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://old-bridge"
    ) as client:
        for method in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
            response = await client.request(
                method, "/%256cocal-trust/v1/state", headers={"Authorization": "Bearer old"}
            )
            assert response.status_code == 403
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, access_log=False, log_level="critical"))
    try:
        async with running(server, sock):
            with pytest.raises(InvalidStatus):
                async with connect(f"ws://127.0.0.1:{port}/local-trust/v1/state"):
                    pass
    finally:
        sock.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation",
    [
        "targets.list",
        "source.begin",
        "source.append",
        "source.finalize",
        "source.read",
        "archive.read",
        "transfer.plan",
    ],
)
async def test_backup_io_routes_preserve_exact_json_wrapper(endpoint, operation):
    client, authority, _ = endpoint
    calls = []

    def backup_io(name, body, proof, now):
        calls.append((name, body, proof, now))
        return {
            "receipt": "synthetic.signed.receipt",
            "contentBase64": "ZGF0YQ==" if name == "archive.read" else None,
        }

    authority.backup_io = backup_io
    authority.backup_io_preflight = lambda name, body, proof, now: {"checkedAt": now}
    authority.run_backup_io_preflight = lambda name, body, checked: None
    response = await client.post(
        "/local-trust/v2/backup-io/" + operation, json={"body": {}, "proof": "proof"}
    )
    assert response.status_code == 200 and response.headers["content-type"] == "application/json"
    assert set(response.json()) == {"receipt", "contentBase64"}
    assert response.headers["cache-control"] == "no-store"
    assert calls[0][:3] == (operation, {}, "proof")


@pytest.mark.asyncio
async def test_backup_io_large_chunk_is_isolated_from_small_routes(endpoint):
    client, authority, _ = endpoint
    calls = []

    def backup_io(name, body, proof, now):
        calls.append(name)
        return {
            "receipt": "signed",
            "contentBase64": "A" * 40000 if name == "archive.read" else None,
        }

    authority.backup_io = backup_io
    large = {"body": {"contentBase64": "A" * 40000}, "proof": "proof"}
    for operation in ("source.begin", "source.read", "transfer.plan"):
        result = await client.post("/local-trust/v2/backup-io/" + operation, json=large)
        assert result.status_code == 413
    assert calls == []
    assert (
        await client.post("/local-trust/v2/backup-io/source.append", json=large)
    ).status_code == 200
    result = await client.post(
        "/local-trust/v2/backup-io/archive.read", json={"body": {}, "proof": "proof"}
    )
    assert result.status_code == 200 and len(result.json()["contentBase64"]) == 40000
    result = await client.post(
        "/local-trust/v2/backup-io/source.append",
        json={"body": {}, "proof": "proof", "path": "/ignored"},
    )
    assert result.status_code == 400


@pytest.mark.asyncio
@pytest.mark.parametrize("transport_kind", ["http", "websocket"])
async def test_runtime_transport_evidence_requires_real_connection_loss(configured, transport_kind):
    from wanx_bridge.local_data_transport import EXTENSION

    config = LocalTrustConfig.load(configured.filename)
    evidence_result = asyncio.get_running_loop().create_future()

    async def app(scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                event = await receive()
                await send({"type": event["type"] + ".complete"})
                if event["type"] == "lifespan.shutdown":
                    return
        assert scope["type"] == transport_kind
        evidence = scope["extensions"][EXTENSION]
        assert not evidence._lost.is_set()
        if transport_kind == "http":
            await receive()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})
        else:
            await receive()
            await send({"type": "websocket.accept"})
            await send({"type": "websocket.send", "text": "ok"})
            await send({"type": "websocket.close", "code": 1000})
        # Sending a complete response is not used as the closure assertion.
        evidence_result.set_result(await evidence.close_and_wait())

    service = LocalTrustService(FakeAuthority())
    server = server_for(config, service, app)
    context = ssl.create_default_context(cafile=str(config.tls_certificate))
    try:
        async with running(server, configured.sock):
            if transport_kind == "http":
                async with httpx.AsyncClient(verify=context, trust_env=False) as client:
                    result = await client.get(config.base_url + "/evidence")
                    assert result.content == b"ok"
                    assert result.headers["connection"] == "close"
            else:
                async with connect(
                    config.base_url.replace("https:", "wss:") + "/evidence", ssl=context
                ) as connection:
                    assert await connection.recv() == "ok"
            assert await asyncio.wait_for(evidence_result, 2) is True
    finally:
        await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["source.finalize", "transfer.plan"])
async def test_source_finalize_does_not_block_revocation_or_release_cancelled_inspection_slot(
    operation,
):
    entered, release = threading.Event(), threading.Event()
    now = [100]
    steps = []
    authority = FakeAuthority()

    def preflight(operation, body, proof, checked_at):
        steps.append(("preflight", checked_at))
        return {"checkedAt": checked_at}

    def inspect(operation, body, checked):
        entered.set()
        assert release.wait(5)
        steps.append(("inspection", checked["checkedAt"]))

    def finish(operation, body, proof, checked_at):
        steps.append(("commit", checked_at))
        return {"receipt": "signed", "contentBase64": None}

    authority.backup_io_preflight = preflight
    authority.run_backup_io_preflight = inspect
    authority.backup_io = finish
    authority.read_state = lambda proof, checked_at: "signed-current-management"
    service = LocalTrustService(authority, clock=lambda: now[0])

    async def finalize():
        async with service.admission("127.0.0.1", "v2/backup-io/" + operation) as ticket:
            return await service.invoke(
                ticket, "v2/backup-io/" + operation, {"body": {}, "proof": "proof"}
            )

    task = asyncio.create_task(finalize())
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        # A long archive inspection cannot occupy the management executor or DB
        # lock. Current management/revocation and data checks remain available.
        async with service.admission("127.0.0.1", "state") as ticket:
            assert (
                await asyncio.wait_for(service.invoke(ticket, "state", {"proof": "proof"}), 0.5)
                == "signed-current-management"
            )
        assert (
            await asyncio.wait_for(service.execute_authority(lambda: "current"), 0.5) == "current"
        )
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert service._active["inspection"] == 1
        with pytest.raises(LocalTrustError, match="LOCAL_TRUST_RATE_LIMITED"):
            await finalize()
        now[0] = 102
    finally:
        release.set()
        await service.close()
    assert steps == [("preflight", 100), ("inspection", 100), ("commit", 102)]
    assert service._active["inspection"] == 0


@pytest.mark.asyncio
async def test_max_archive_request_counts_have_separate_nonce_io_and_management_budgets(endpoint):
    client, authority, service = endpoint
    authority.authenticated_challenge_v2 = lambda proof, now: "signed-challenge"
    authority.backup_io = lambda operation, body, proof, now: {
        "receipt": "signed",
        "contentBase64": None,
    }
    authority.read_state = lambda proof, now: "signed-state"
    # A 200 MiB download followed by 200 MiB upload uses 400 one-MiB IO
    # requests plus 400 fresh nonces. Sizes are tested separately; here exercise
    # the actual HTTP route/source-budget wiring at those request counts.
    for index in range(400):
        assert (
            await client.post(
                "/local-trust/v2/authenticated-challenge", json={"proof": "synthetic-pop"}
            )
        ).status_code == 200
        operation = "archive.read" if index < 200 else "source.append"
        assert (
            await client.post(
                "/local-trust/v2/backup-io/" + operation, json={"body": {}, "proof": "proof"}
            )
        ).status_code == 200
    assert not service._sources["management"] and not service._sources["public"]
    for _ in range(service_module.SOURCE_PER_MINUTE["management"]):
        assert (await client.post(PREFIX + "/state", json={"proof": "proof"})).status_code == 200
    assert (await client.post(PREFIX + "/state", json={"proof": "proof"})).status_code == 429
    assert (
        await client.post(
            "/local-trust/v2/backup-io/archive.read", json={"body": {}, "proof": "proof"}
        )
    ).status_code == 200
    # Dedicated groups remain finite; a saturated nonce producer cannot occupy
    # normal management workers or obtain an unbounded queue.
    for _ in range(service_module.SOURCE_PER_MINUTE["authenticated_nonce"] - 400):
        assert (
            await client.post(
                "/local-trust/v2/authenticated-challenge", json={"proof": "synthetic-pop"}
            )
        ).status_code == 200
    assert (
        await client.post(
            "/local-trust/v2/authenticated-challenge", json={"proof": "synthetic-pop"}
        )
    ).status_code == 429


@pytest.mark.asyncio
async def test_anonymous_body_admission_cannot_exhaust_authenticated_challenge_workers(endpoint):
    client, authority, service = endpoint
    authority.authenticated_challenge_v2 = lambda proof, now: "signed-challenge"
    release = asyncio.Event()

    async def stalled_body():
        yield b"{"
        await release.wait()
        yield b"}"

    tasks = [
        asyncio.create_task(
            client.post(
                "/local-trust/v2/auth/challenge",
                content=stalled_body(),
                headers={"Content-Type": "application/json"},
            )
        )
        for _ in range(CONCURRENCY["nonce"])
    ]
    try:
        async with asyncio.timeout(1):
            while service._active["nonce"] != CONCURRENCY["nonce"]:
                await asyncio.sleep(0)
        async with asyncio.timeout(0.5):
            response = await client.post(
                "/local-trust/v2/authenticated-challenge", json={"proof": "synthetic-pop"}
            )
        assert response.status_code == 200
        assert service._active["nonce"] == CONCURRENCY["nonce"]
    finally:
        release.set()
        await asyncio.gather(*tasks)


@pytest.mark.asyncio
async def test_worker_inventory_relay_coalesces_burst_into_one_pending_snapshot():
    from wanx_bridge.local_trust_runtime import _install_worker_observer

    entered, release = asyncio.Event(), asyncio.Event()

    class Worker:
        def install_effect_observer(self, callback):
            self.callback = callback
            self.emit(1)

        def emit(self, sequence):
            self.callback(
                {"workerBootId": b64(b"w" * 32), "sequence": sequence, "ready": True, "jobs": []}
            )

    class Sessions:
        def __init__(self):
            self.sequences = []
            self.active = 0

        async def observe_worker(self, body):
            self.active += 1
            assert self.active == 1
            self.sequences.append(body["sequence"])
            entered.set()
            await release.wait()
            self.active -= 1

    worker, sessions, service = Worker(), Sessions(), LocalTrustService(FakeAuthority())
    installation = asyncio.create_task(_install_worker_observer(worker, sessions, service))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        for sequence in range(2, 10002):
            worker.emit(sequence)
        assert len(service._changes) == 1
        release.set()
        await installation
        assert sessions.sequences == [1, 10001]
    finally:
        release.set()
        await service.close()
