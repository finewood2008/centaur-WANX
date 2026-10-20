"""Independent native upstream routing, credentials, and lease contracts."""

import asyncio
import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from test_gateway import Auth

from wanx_bridge.semantica import PREFIX, configured_origin, upstream_origin
from wanx_bridge.server import create_app

AUTH = {"authorization": "Bearer opaque-marker"}


class Body(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data = data
        self.closed = False

    async def __aiter__(self):
        yield self.data

    async def aclose(self):
        self.closed = True


@pytest.fixture
async def environment(tmp_path):
    auth = Auth()
    profile = {"id": "mapped-user", "role": "admin", "application_id": "wanx"}
    seen = []
    responses = []
    headers = {"content-type": "application/json"}

    async def handle(request):
        body = await request.aread()
        seen.append((request, body))
        if request.url.host == "127.0.0.1" and request.url.path == "/api/auth/me":
            return httpx.Response(200, json=profile, headers={"set-cookie": "upstream=private"})
        stream = Body(body or b'{"items":[]}')
        responses.append(stream)
        return httpx.Response(307 if "location" in headers else 200, stream=stream, headers=headers)

    app = create_app(
        auth,
        object(),
        semantica_url="http://semantica:8090",
        http_transport=httpx.MockTransport(handle),
        dashboard_dir=tmp_path,
        lease_check_interval=0.005,
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://box",
        ) as client:
            yield client, auth, profile, seen, headers, responses


async def test_native_routes_to_separate_service(environment):
    client, _, _, seen, _, responses = environment
    response = await client.get(PREFIX + "/documents?workspace_id=default&limit=10", headers=AUTH)
    assert response.status_code == 200
    assert response.json() == {"items": []}
    identity, native = [item[0] for item in seen]
    assert identity.url == "http://127.0.0.1:18088/api/auth/me"
    assert identity.headers["authorization"] == "Bearer private.upstream.jwt"
    assert native.url == "http://semantica:8090/api/documents?workspace_id=default&limit=10"
    assert "authorization" not in native.headers
    assert "cookie" not in native.headers
    assert response.headers["cache-control"] == "no-store"
    assert responses[-1].closed


@pytest.mark.parametrize(
    "method,path,payload",
    [
        ("POST", "/search", {"workspace_id": "default", "query": "test"}),
        ("PATCH", "/documents/doc/content", {"base_version_id": "v1", "segments": []}),
        ("PUT", "/skills/test/draft", {"expected_revision": 1}),
        ("DELETE", "/documents/doc?confirm=true", None),
        ("POST", "/reasoning/documents/read", {"workspace_id": "default"}),
        ("GET", "/health/ready", None),
    ],
)
async def test_native_preserves_method_query_and_body(environment, method, path, payload):
    client, _, _, seen, _, _ = environment
    response = await client.request(method, PREFIX + path, headers=AUTH, json=payload)
    assert response.status_code == 200
    request, body = seen[-1]
    assert request.method == method
    assert str(request.url) == "http://semantica:8090/api" + path
    if payload is not None:
        assert json.loads(body) == payload


async def test_native_upload_download_and_credentials_are_not_reencoded(environment):
    client, _, _, seen, response_headers, _ = environment
    data = b"\x00\xff" * (2 * 1024 * 1024)
    outgoing = {
        **AUTH,
        "cookie": "browser=private",
        "origin": "https://renderer.invalid",
        "x-semantica-scope": "caller-scope",
        "x-semantica-signature": "caller-signature",
        "x-xingtu-key": "caller-key",
        "x-wanx-secret": "caller-secret",
        "x-octop-agent-id": "caller-agent",
    }
    response_headers.update({"set-cookie": "secret=value", "x-octop-access-token": "private"})
    response = await client.post(
        PREFIX + "/documents?token=opaque-marker&workspace_id=default",
        headers=outgoing,
        files={"file": ("large.bin", data)},
    )
    assert response.status_code == 200
    request, body = seen[-1]
    assert data in body
    assert response.content == body
    assert request.headers["content-type"].startswith("multipart/form-data; boundary=")
    assert "token" not in request.url.params
    assert not set(outgoing).intersection(request.headers)
    assert "set-cookie" not in response.headers
    assert "x-octop-access-token" not in response.headers

    response_headers.clear()
    response_headers.update(
        {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="x.bin"',
            "content-range": "bytes 0-3/10",
        }
    )
    response = await client.get(
        PREFIX + "/documents/doc/original", headers={**AUTH, "range": "bytes=0-3"}
    )
    assert seen[-1][0].headers["range"] == "bytes=0-3"
    assert response.headers["content-disposition"] == 'attachment; filename="x.bin"'
    assert response.headers["content-range"] == "bytes 0-3/10"


async def test_native_requires_session_even_for_health(environment):
    client, _, _, seen, _, _ = environment
    assert (await client.get(PREFIX + "/health/live")).status_code == 401
    assert seen == []


@pytest.mark.parametrize(
    "override",
    [
        {"role": "user"},
        {"id": "another-user"},
        {"application_id": "super-advisory"},
    ],
)
async def test_native_checks_current_identity_on_every_request(environment, override):
    client, _, profile, seen, _, _ = environment
    assert (await client.get(PREFIX + "/documents", headers=AUTH)).status_code == 200
    seen.clear()
    profile.update(override)
    response = await client.get(PREFIX + "/documents", headers=AUTH)
    assert response.status_code == 403
    assert response.json()["code"] == "SEMANTICA_NATIVE_ADMIN_REQUIRED"
    assert len(seen) == 1
    assert seen[0][0].url.path == "/api/auth/me"


@pytest.mark.parametrize(
    "path",
    [
        "",
        "/integration/warehouses",
        "/open/v1/documents",
        "/auth/me",
        "/internal/starklink/models",
        "/documents//doc",
        "/documents/%252e%252e/auth",
        "/documents/%5Cauth",
    ],
)
async def test_native_does_not_fall_through_to_other_namespaces(environment, path):
    client, _, _, seen, _, _ = environment
    response = await client.get(PREFIX + path, headers=AUTH)
    assert response.status_code == 404
    assert seen == []


async def test_native_redirect_stays_inside_bridge_namespace(environment):
    client, _, _, _, headers, _ = environment
    headers["location"] = "http://semantica:8090/api/documents/?limit=20"
    response = await client.get(PREFIX + "/documents", headers=AUTH)
    assert response.status_code == 307
    assert response.headers["location"] == PREFIX + "/documents/?limit=20"
    headers["location"] = "https://unrelated.invalid/"
    response = await client.get(PREFIX + "/documents", headers=AUTH)
    assert response.status_code == 502


@pytest.mark.parametrize(
    "location",
    [
        "/api/documents/../../../auth/me",
        "/api/documents/%2e%2e/%2e%2e/%2e%2e/auth/me",
        "/api/documents/%252e%252e/auth/me",
        "/api/documents/%5c../auth/me",
        "/api/integration/warehouses",
        "/api/open/v1/documents",
        "http://[invalid",
    ],
)
async def test_native_rejects_redirect_aliases_and_non_native_targets(environment, location):
    client, _, _, _, headers, responses = environment
    headers["location"] = location
    response = await client.get(PREFIX + "/documents", headers=AUTH)
    assert response.status_code == 502
    assert "location" not in response.headers
    assert responses[-1].closed


async def test_native_drops_referrer_and_other_service_credentials(environment):
    client, _, _, seen, _, _ = environment
    headers = {
        **AUTH,
        "referer": "http://box/api/semantica/native/documents?token=opaque-marker",
        "x-skill-admin-token": "private-skill-token",
        "x-starklink-signature": "private-model-signature",
        "x-starklink-nonce": "private-model-nonce",
        "if-range": '"version-one"',
    }
    response = await client.get(PREFIX + "/documents/doc/original", headers=headers)
    assert response.status_code == 200
    forwarded = seen[-1][0].headers
    assert all(key not in forwarded for key in headers if key != "if-range")
    assert forwarded["if-range"] == '"version-one"'


async def test_native_downstream_disconnect_before_headers_cancels_upstream(tmp_path):
    started = asyncio.Event()
    cancelled = asyncio.Event()
    disconnected = asyncio.Event()

    async def handle(request):
        if request.url.path == "/api/auth/me":
            return httpx.Response(200, json={"id": "mapped-user", "role": "admin"})
        await request.aread()
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    app = create_app(
        Auth(),
        object(),
        http_transport=httpx.MockTransport(handle),
        dashboard_dir=tmp_path,
    )
    body_delivered = False

    async def receive():
        nonlocal body_delivered
        if not body_delivered:
            body_delivered = True
            return {
                "type": "http.request",
                "body": b'{"workspace_id":"default"}',
                "more_body": False,
            }
        await disconnected.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        pass  # The downstream has closed; only upstream cleanup matters.

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": PREFIX + "/reasoning/prepare",
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"authorization", b"Bearer opaque-marker"),
            (b"content-type", b"application/json"),
        ],
        "client": ("127.0.0.1", 1),
        "server": ("box", 80),
    }
    async with app.router.lifespan_context(app):
        task = asyncio.create_task(app(scope, receive, send))
        try:
            await asyncio.wait_for(started.wait(), 2)
            disconnected.set()
            await asyncio.wait_for(cancelled.wait(), 0.5)
            await asyncio.wait_for(task, 2)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("status", [401, 403, 409, 422, 503])
async def test_native_preserves_backend_status_and_error_body(tmp_path, status):
    async def handle(request):
        if request.url.path == "/api/auth/me":
            return httpx.Response(200, json={"id": "mapped-user", "role": "admin"})
        return httpx.Response(
            status,
            stream=Body(b'{"detail":{"code":"SKILL_INVALID_REQUEST"}}'),
            headers={"content-type": "application/json"},
        )

    app = create_app(
        Auth(), object(), http_transport=httpx.MockTransport(handle), dashboard_dir=tmp_path
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://box"
        ) as client:
            response = await client.post(PREFIX + "/skills/test/validate", headers=AUTH, json={})
    assert response.status_code == status
    assert response.json() == {"detail": {"code": "SKILL_INVALID_REQUEST"}}


def test_native_websocket_does_not_fall_through_to_octop(tmp_path):
    app = create_app(Auth(), object(), dashboard_dir=tmp_path)
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect(PREFIX + "/documents", headers=AUTH):
                pytest.fail("native websocket unexpectedly accepted")
    assert error.value.code == 4403


async def test_native_waiting_request_is_cancelled_when_lease_expires(tmp_path):
    auth = Auth()
    cancelled = asyncio.Event()

    async def handle(request):
        if request.url.path == "/api/auth/me":
            return httpx.Response(200, json={"id": "mapped-user", "role": "admin"})
        auth.deadline = time.monotonic() + 0.02
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    app = create_app(
        auth,
        object(),
        http_transport=httpx.MockTransport(handle),
        dashboard_dir=tmp_path,
        lease_check_interval=0.005,
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://box"
        ) as client:
            response = await asyncio.wait_for(
                client.get(PREFIX + "/search/indexes", headers=AUTH), 2
            )
    assert response.status_code == 401
    assert cancelled.is_set()


def test_runtime_semantica_origin_is_independent(monkeypatch):
    for name in (
        "WANX_BRIDGE_SEMANTICA_URL",
        "WANX_BRIDGE_PORT",
        "WANX_BRIDGE_OIDC_PORT",
        "WANX_BRIDGE_UPSTREAM_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    assert configured_origin() == "http://127.0.0.1:8090"
    monkeypatch.setenv("WANX_BRIDGE_SEMANTICA_URL", "https://semantica.internal:8443/")
    assert configured_origin() == "https://semantica.internal:8443"


@pytest.mark.parametrize(
    "url",
    [
        "",
        "file:///tmp/service",
        "http://user:password@localhost:8090",
        "http://localhost:8090/api",
        "http://localhost:8090?key=secret",
        "http://localhost:8090/#x",
        "http://localhost:0",
        "http://localhost:bad",
    ],
)
def test_semantica_origin_rejects_credentials_and_non_origins(url):
    with pytest.raises(ValueError, match="HTTP\\(S\\) origin"):
        upstream_origin(url)


def test_native_package_uses_no_backend_internal_imports():
    import ast
    from pathlib import Path

    for path in Path(__file__).parents[1].joinpath("wanx_bridge", "semantica").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                names = [node.module or ""]
            else:
                continue
            assert all(name.split(".")[0] not in {"octop", "app"} for name in names), path
