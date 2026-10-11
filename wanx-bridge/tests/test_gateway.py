"""Exercise the boundary against real HTTP/SSE/WebSocket servers."""

import asyncio
import json
import socket
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass

import httpx
import pytest
import uvicorn
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from wanx_bridge.auth import BridgeAuthError
from wanx_bridge.server import create_app
from wanx_bridge.upstream import BridgeUpstreamError


@dataclass
class Session:
    upstream_token: str = "private.upstream.jwt"
    user: dict = None
    sid: str = "lease"
    key: str = "identity"
    expires_at: float = 0


class Auth:
    def __init__(self):
        self.session = Session(user={"id": "mapped-user"}, expires_at=time.time() + 30)
        self.deadline = time.monotonic() + 30

    def challenge(self, account_id, client_id, network_session_id):
        return {"challengeReceipt": "signed.receipt", "expiresIn": 60}

    async def exchange(self, grant, adapter):
        if grant == "upstream.error":
            raise BridgeUpstreamError("BOX_UPSTREAM_CAPTCHA_REQUIRED", 503)
        if grant != "valid.grant":
            raise BridgeAuthError("INVALID_GRANT", 401)
        return {"access_token": "opaque-marker", "user": self.session.user, "expires_in": 120}

    def authorize(self, token):
        if token != "opaque-marker":
            raise BridgeAuthError("AUTH_REQUIRED", 401)
        self.assert_live(self.session)
        return self.session

    def assert_live(self, session):
        if time.monotonic() >= self.deadline:
            raise BridgeAuthError("LEASE_EXPIRED", 401)


@asynccontextmanager
async def live_server(app):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    port = sock.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(app, log_level="critical", access_log=False, timeout_graceful_shutdown=1)
    )
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        for _ in range(200):
            if server.started:
                break
            if task.done():
                await task
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("test server did not start")
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 5)
        sock.close()


@pytest.fixture
async def environment():
    upstream = FastAPI()
    seen = []
    stream_closed = asyncio.Event()

    @upstream.get("/api/health")
    async def health():
        return {"status": "ok"}

    @upstream.get("/")
    async def index():
        return "dashboard"

    @upstream.get("/api/setup/status")
    async def setup_status(request: Request):
        seen.append({"path": request.url.path, "headers": dict(request.headers)})
        return {"setup_required": False, "database_bound": True}

    @upstream.get("/api/auth/me")
    async def me(request: Request):
        seen.append({"path": request.url.path, "headers": dict(request.headers)})
        return {"id": "mapped-user", "locale": "zh"}

    @upstream.get("/api/admin/backup/list")
    @upstream.get("/api/admin/backup/status")
    @upstream.get("/api/admin/backup/auto")
    async def backup_metadata(request: Request):
        seen.append({"path": request.url.path, "headers": dict(request.headers)})
        if request.headers.get("authorization") != "Bearer private.upstream.jwt":
            return JSONResponse({"code": "UPSTREAM_BACKUP_PERMISSION_DENIED"}, status_code=403)
        return {"items": [], "busy": False, "auto_enabled": False}

    @upstream.api_route("/api/echo", methods=["GET", "POST"])
    async def echo(request: Request):
        body = await request.body()
        seen.append(
            {
                "path": request.url.path,
                "headers": dict(request.headers),
                "query": dict(request.query_params),
                "body": body,
            }
        )
        return JSONResponse(
            {"size": len(body)},
            headers={
                "X-Octop-Access-Token": "private.refresh.jwt",
                "Set-Cookie": "secret=jwt",
            },
        )

    @upstream.get("/api/redirect")
    async def redirect(kind: str = "safe"):
        location = (
            "/next?tab=chat"
            if kind == "safe"
            else (
                "https://example.com/?token=private.upstream.jwt"
                if kind == "external"
                else "/?access_token=private.upstream.jwt"
            )
        )
        return RedirectResponse(location)

    @upstream.get("/api/stream")
    async def stream():
        async def chunks():
            try:
                while True:
                    yield b"data: keepalive\n\n"
                    await asyncio.sleep(0.025)
            finally:
                stream_closed.set()

        return StreamingResponse(chunks(), media_type="text/event-stream")

    @upstream.websocket("/api/desktop-stream/ws")
    @upstream.websocket("/api/chat/ws")
    async def ws(websocket: WebSocket):
        await websocket.accept()
        seen.append(
            {
                "path": websocket.url.path,
                "headers": dict(websocket.headers),
                "query": dict(websocket.query_params),
            }
        )
        try:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    return
                if message.get("bytes") is not None:
                    await websocket.send_bytes(message["bytes"])
                else:
                    seen.append({"frame": message["text"]})
                    await websocket.send_text("ack")
        except Exception:
            return

    auth = Auth()
    async with live_server(upstream) as upstream_url:
        app = create_app(auth, object(), upstream_url=upstream_url, lease_check_interval=0.01)
        async with live_server(app) as url:
            async with httpx.AsyncClient(base_url=url, trust_env=False) as client:
                yield auth, client, url.replace("http:", "ws:"), seen, stream_closed


@pytest.mark.asyncio
async def test_exchange_public_health_and_protected_http(environment):
    auth, client, _, seen, _ = environment
    assert (await client.get("/api/health")).status_code == 200
    assert (await client.get("/")).status_code == 200
    assert (await client.get("/api/echo")).status_code == 401
    assert (await client.get("/api/echo?token=private.upstream.jwt")).status_code == 401
    challenge = await client.post(
        "/api/auth/platform/challenge",
        json={
            "accountId": "account",
            "clientId": "client",
            "networkSessionId": "network",
        },
    )
    assert challenge.json()["challengeReceipt"] == "signed.receipt"
    exchange = await client.post("/api/auth/platform/exchange", json={"grant": "valid.grant"})
    assert exchange.json()["access_token"] == "opaque-marker"
    failed = await client.post("/api/auth/platform/exchange", json={"grant": "upstream.error"})
    assert failed.status_code == 503
    assert failed.json()["code"] == "BOX_UPSTREAM_CAPTCHA_REQUIRED"
    headers = {
        "Authorization": "Bearer opaque-marker",
        "Cookie": "untrusted=1",
        "X-Forwarded-Host": "evil.example",
    }
    result = await client.post(
        "/api/echo?token=opaque-marker&access_token=opaque-marker",
        headers=headers,
        content=b"binary\x00upload",
    )
    assert result.status_code == 200
    assert result.json() == {"size": 13}
    assert "x-octop-access-token" not in result.headers
    assert "set-cookie" not in result.headers
    assert "private." not in result.text
    assert seen[-1]["headers"]["authorization"] == "Bearer private.upstream.jwt"
    assert "cookie" not in seen[-1]["headers"]
    assert "x-forwarded-host" not in seen[-1]["headers"]
    assert seen[-1]["query"] == {
        "token": "private.upstream.jwt",
        "access_token": "private.upstream.jwt",
    }
    # The upstream sends Set-Cookie, but the shared HTTP pool must never forward
    # its cookie jar into another proxied request.
    assert (await client.get("/api/echo", headers=headers)).status_code == 200
    assert "cookie" not in seen[-1]["headers"]
    assert (await client.get("/api/echo?token=other", headers=headers)).status_code == 401


@pytest.mark.asyncio
async def test_dashboard_boot_requires_live_session_for_setup_status_and_me(environment):
    auth, client, _, seen, _ = environment
    headers = {"Authorization": "Bearer opaque-marker"}
    paths = ["/api/setup/status", "/api/auth/me"]
    for path in paths:
        assert (await client.get(path)).status_code == 401
    assert seen == []

    status = await client.get(paths[0], headers=headers)
    assert status.status_code == 200
    assert status.json() == {"setup_required": False, "database_bound": True}
    me = await client.get(paths[1], headers=headers)
    assert me.status_code == 200
    assert me.json()["id"] == "mapped-user"
    assert [request["path"] for request in seen] == paths
    assert all(
        request["headers"]["authorization"] == "Bearer private.upstream.jwt" for request in seen
    )

    auth.deadline = 0
    for path in paths:
        response = await client.get(path, headers=headers)
        assert response.status_code == 401
        assert response.json()["code"] == "LEASE_EXPIRED"
    assert len(seen) == 2


@pytest.mark.asyncio
async def test_setup_status_exception_does_not_allow_writes_or_other_setup_paths(environment):
    _, client, _, seen, _ = environment
    headers = {"Authorization": "Bearer opaque-marker"}
    for method in ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]:
        response = await client.request(method, "/api/setup/status", headers=headers)
        assert response.status_code == 403, method
    for path in [
        "/api/setup",
        "/api/setup/",
        "/api/setup/status/",
        "/api/setup/status/extra",
        "/api/setup//status",
        "/api/setup/%2Fstatus",
        "/api/setup/begin",
        "/api/setup/initial-admin",
        "/api/setup/database",
    ]:
        assert (await client.get(path, headers=headers)).status_code == 403, path
    assert seen == []


@pytest.mark.asyncio
async def test_backup_metadata_requires_live_session_and_upstream_permission(environment):
    auth, client, _, seen, _ = environment
    headers = {"Authorization": "Bearer opaque-marker"}
    paths = ["/api/admin/backup/list", "/api/admin/backup/status", "/api/admin/backup/auto"]
    for path in paths:
        assert (await client.get(path)).status_code == 401
    assert seen == []

    for path in paths:
        result = await client.get(path, headers=headers)
        assert result.status_code == 200
        assert result.json() == {"items": [], "busy": False, "auto_enabled": False}
    assert [request["path"] for request in seen] == paths
    assert all(
        request["headers"]["authorization"] == "Bearer private.upstream.jwt" for request in seen
    )

    auth.session.upstream_token = "member.without.backup.permission"
    for path in paths:
        result = await client.get(path, headers=headers)
        assert result.status_code == 403
        assert result.json()["code"] == "UPSTREAM_BACKUP_PERMISSION_DENIED"

    auth.deadline = 0
    for path in paths:
        result = await client.get(path, headers=headers)
        assert result.status_code == 401
        assert result.json()["code"] == "LEASE_EXPIRED"
    assert len(seen) == 6


@pytest.mark.asyncio
async def test_backup_metadata_exception_keeps_archives_and_mutations_blocked(environment):
    _, client, _, seen, _ = environment
    headers = {"Authorization": "Bearer opaque-marker"}
    for endpoint in ["list", "status", "auto"]:
        path = f"/api/admin/backup/{endpoint}"
        for method in ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]:
            assert (await client.request(method, path, headers=headers)).status_code == 403
        for variant in [path + "/", path + "/extra", path.replace("/backup/", "/backup//")]:
            assert (await client.get(variant, headers=headers)).status_code == 403
    for path in [
        "/api/admin/backup/export?include_config=false",
        "/api/admin/backup/files/raw.tar.gz",
        "/api/admin/backup/files/raw.tar.gz/restore?restore_config=false",
        "/api/admin/backup/create",
        "/api/admin/backup/import",
        "/api/admin/backup/auto/run",
    ]:
        for method in ["GET", "POST", "DELETE"]:
            assert (await client.request(method, path, headers=headers)).status_code == 403
    assert seen == []


@pytest.mark.asyncio
async def test_sensitive_routes_and_redirects_fail_closed(environment):
    _, client, _, _, _ = environment
    headers = {"Authorization": "Bearer opaque-marker"}
    for path in [
        "/api/auth/login",
        "/api/auth/oidc/config",
        "/api/auth/oidc/exchange",
        "/api/setup/begin",
        "/api/config",
        "/internal/token",
        "/.well-known/openid-configuration",
        "/api/users",
        "/api/users/roles",
        "/api/users/invites",
        "/api/users/23/reset-password",
        "/api/admin/backup/export",
    ]:
        assert (await client.post(path, headers=headers)).status_code == 403, path
    assert (
        await client.patch("/api/users/23", headers=headers, json={"role": "admin"})
    ).status_code == 403
    assert (
        await client.get("/api/admin/backup/files/raw.tar.gz", headers=headers)
    ).status_code == 403
    assert (await client.get("/api/redirect?kind=external", headers=headers)).status_code == 502
    assert (await client.get("/api/redirect?kind=token", headers=headers)).status_code == 502
    result = await client.get("/api/redirect", headers=headers)
    assert result.status_code == 307
    assert result.headers["location"] == "/next?tab=chat"
    assert (
        await client.post("/api/auth/platform/exchange", content=b"x" * 17000)
    ).status_code == 413


@pytest.mark.asyncio
async def test_sse_renewal_survives_and_revocation_closes_upstream(environment):
    auth, client, _, _, closed = environment
    auth.deadline = time.monotonic() + 0.15
    async with client.stream(
        "GET", "/api/stream", headers={"Authorization": "Bearer opaque-marker"}
    ) as result:
        iterator = result.aiter_lines()
        assert await anext(iterator) == "data: keepalive"
        auth.deadline = time.monotonic() + 1
        await asyncio.sleep(0.18)
        assert not closed.is_set()
        auth.deadline = 0
        async for _ in iterator:
            pass
    await asyncio.wait_for(closed.wait(), 1)


@pytest.mark.asyncio
async def test_sse_downstream_disconnect_cancels_upstream(environment):
    _, client, _, _, closed = environment
    async with client.stream("GET", "/api/stream?token=opaque-marker") as result:
        assert await anext(result.aiter_bytes())
    await asyncio.wait_for(closed.wait(), 1)


@pytest.mark.asyncio
async def test_websocket_bound_token_binary_and_desktop_start(environment):
    auth, _, url, seen, _ = environment
    async with connect(url + "/api/desktop-stream/ws?token=opaque-marker", proxy=None) as ws:
        auth.session.upstream_token = "new.jwt.after.renewal"
        await ws.send(json.dumps({"type": "start", "token": "opaque-marker", "mode": "view"}))
        assert await ws.recv() == "ack"
        assert seen[0]["query"]["token"] == "private.upstream.jwt"
        assert json.loads(seen[1]["frame"])["token"] == "private.upstream.jwt"
        await ws.send(b"binary\x00frame")
        assert await ws.recv() == b"binary\x00frame"
        auth.deadline = 0
        with pytest.raises(ConnectionClosed):
            await asyncio.wait_for(ws.recv(), 1)


@pytest.mark.asyncio
async def test_websocket_conflicting_start_and_missing_auth_rejected(environment):
    _, _, url, seen, _ = environment
    with pytest.raises(InvalidStatus):
        async with connect(url + "/api/chat/ws", proxy=None):
            pass
    with pytest.raises(InvalidStatus):
        async with connect(url + "/api/chat/ws?token=opaque-marker&access_token=other", proxy=None):
            pass
    async with connect(url + "/api/desktop-stream/ws?token=opaque-marker", proxy=None) as ws:
        await ws.send(json.dumps({"type": "start", "token": "stolen.jwt"}))
        with pytest.raises(ConnectionClosed):
            await ws.recv()
    assert all("stolen.jwt" not in str(item) for item in seen)


@pytest.mark.asyncio
async def test_idle_websocket_survives_renewal_until_revoked(environment):
    auth, _, url, _, _ = environment
    auth.deadline = time.monotonic() + 0.1
    async with connect(url + "/api/chat/ws?token=opaque-marker", proxy=None) as ws:
        auth.deadline = time.monotonic() + 1
        await asyncio.sleep(0.15)
        await ws.send("still alive")
        assert await ws.recv() == "ack"
        auth.deadline = 0
        with pytest.raises(ConnectionClosed):
            await asyncio.wait_for(ws.recv(), 1)


@pytest.mark.asyncio
async def test_upload_reaches_upstream_before_client_finishes_body():
    upstream = FastAPI()
    received = asyncio.Event()

    @upstream.post("/api/upload")
    async def upload(request: Request):
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            received.set()
        return {"size": size}

    async def chunks():
        yield b"first"
        # A buffering proxy deadlocks here and fails the bounded wait.
        await asyncio.wait_for(received.wait(), 1)
        yield b"second"

    async with live_server(upstream) as upstream_url:
        bridge = create_app(Auth(), object(), upstream_url=upstream_url)
        async with live_server(bridge) as bridge_url:
            async with httpx.AsyncClient(base_url=bridge_url, trust_env=False) as client:
                response = await client.post("/api/upload?token=opaque-marker", content=chunks())
                assert response.json() == {"size": 11}


def test_only_loopback_upstream_permitted():
    for url in ["https://evil.example", "http://127.0.0.1:18088/api", "http://u:p@127.0.0.1"]:
        with pytest.raises(ValueError):
            create_app(Auth(), object(), upstream_url=url)
