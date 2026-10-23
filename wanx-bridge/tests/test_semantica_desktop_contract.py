"""Bridge desktop contract, using synthetic public identity and integration servers."""

import asyncio
import base64
import hashlib
import hmac
import json
import time
import uuid
from types import SimpleNamespace

import httpx
import pytest
from test_gateway import Auth

from wanx_bridge.semantica.desktop import DesktopConfig, DesktopError, resolve
from wanx_bridge.server import create_app

WAREHOUSE = "10000000-0000-4000-8000-000000000001"
TRANSFER = "20000000-0000-4000-8000-000000000001"
BASE = "/api/semantica"
W = f"/warehouses/{WAREHOUSE}"
CONFIG = {
    "service_url": "http://semantica:8090",
    "service_token": "synthetic-service-" + "a" * 32,
    "box_id": "box-contract",
    "application_id": "semantica",
}
AUTH = {"authorization": "Bearer opaque-marker"}


def claims(request):
    encoded = request.headers["x-semantica-scope"]
    assert (
        request.headers["x-semantica-signature"]
        == hmac.new(CONFIG["service_token"].encode(), encoded.encode(), hashlib.sha256).hexdigest()
    )
    return json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))


@pytest.fixture
async def desktop(tmp_path):
    config_file = tmp_path / "semantica.json"
    config_file.write_text(json.dumps(CONFIG), encoding="utf8")
    auth = Auth()
    auth.config = SimpleNamespace(device_id="wanx-existing-device")
    auth.session.user = {"id": 7}
    profile = {
        "id": 7,
        "role": "user",
        "permissions": ["knowledge_bases"],
        "application_id": "wanx",
    }
    seen = []
    reply = {"status": 200, "value": {"items": [], "total": 0}}

    async def handler(request):
        if request.url == "http://127.0.0.1:18088/api/auth/me":
            assert request.headers["authorization"] == "Bearer private.upstream.jwt"
            return httpx.Response(200, json=profile, headers={"set-cookie": "private=cookie"})
        assert request.url.host == "semantica"
        seen.append(request)
        if "handler" in reply:
            return await reply["handler"](request)
        return httpx.Response(
            reply["status"], json=reply["value"], headers={"set-cookie": "service=private"}
        )

    app = create_app(
        auth,
        object(),
        semantica_config_file=config_file,
        semantica_desktop_url=CONFIG["service_url"],
        http_transport=httpx.MockTransport(handler),
        dashboard_dir=tmp_path,
        lease_check_interval=0.005,
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://bridge"
        ) as client:
            yield client, auth, profile, seen, reply, app


READS = [
    "/status",
    "/capabilities",
    "/warehouses",
    "/warehouses/runtime",
    W,
    W + "/keys",
    "/warehouses/transfers",
    "/warehouses/transfers/" + TRANSFER,
    "/warehouses/transfers/" + TRANSFER + "/blob?offset=0&length=100",
    W + "/documents?limit=100&offset=0",
    W + "/documents/doc-a?segment_offset=0&segment_limit=100",
    W
    + "/documents/doc-a/blob?offset=1048576&length=1048576&expected_sha256=abc&expected_origin_revision=3",
    W + "/jobs?limit=100&offset=0",
    W + "/owner/graph?limit=120",
    W + "/retrieval/status",
    W + "/sensitive/settings",
    W + "/operations/op",
    W + "/skills?limit=20&offset=0&keyword=contract",
    W + "/skills/contract?path=references%2Fa.md",
    W + "/skills/contract/download",
    "/processing?warehouse_id=" + WAREHOUSE,
    "/processing/catalog",
]
WRITES = [
    ("POST", "/warehouses", {"name": "Contract"}),
    ("POST", W + "/keys", {"name": "Contract"}),
    ("POST", W + "/keys/" + TRANSFER + "/revoke", {}),
    *[
        ("POST", W + "/" + action, {"confirmation_token": "intent", "typed_name": "Contract"})
        for action in ("clear/prepare", "clear", "delete/prepare", "delete", "exports")
    ],
    ("POST", "/warehouses/imports", {"filename": "test.xingtu"}),
    ("PATCH", "/warehouses/imports/" + TRANSFER, {"offset": 0, "content_base64": "YQ=="}),
    ("POST", "/warehouses/imports/" + TRANSFER + "/commit", {}),
    ("PUT", W + "/sensitive/settings", {"payload": {"expected_revision": 1}}),
    (
        "POST",
        W + "/documents/doc-a/correction",
        {"payload": {"base_version_id": "v1", "segments": []}},
    ),
    ("POST", W + "/jobs/job-a/retry", {}),
    ("POST", W + "/retrieval/indexes", {}),
    ("POST", W + "/imports", {"filename": "contract.txt"}),
    ("PATCH", W + "/imports/upload-a", {"offset": 0, "content_base64": "YQ=="}),
    ("POST", W + "/imports/upload-a/commit", {}),
    ("POST", W + "/skills/import", {"content_base64": "YQ=="}),
    ("POST", W + "/skills/contract/delete", {"confirm": True, "typed_name": "Contract"}),
    ("PUT", "/processing", {"warehouse_id": None, "expected_revision": 1}),
    ("POST", "/processing/check", {"warehouse_id": WAREHOUSE, "extraction": "model-a"}),
    (
        "POST",
        "/processing/reprocess",
        {"warehouse_id": WAREHOUSE, "documents": [], "expected_signature": "signature"},
    ),
    *[
        ("POST", W + "/reasoning/" + op, {"arguments": {"preparation_id": "prep-a"}})
        for op in (
            "discover",
            "prepare",
            "reference",
            "scope",
            "search",
            "evidence",
            "read-document",
            "coverage",
        )
    ],
]
CASES = [("GET", path, None) for path in READS] + [
    (method, path, {"operation_id": "op", **body}) for method, path, body in WRITES
]
CASES += [
    (
        "POST",
        W + "/search",
        {"query": "contract", "document_ids": [], "entity_types": [], "limit": 10},
    )
]


@pytest.mark.parametrize("method,path,body", CASES)
async def test_desktop_contract_routes_and_signed_context(desktop, method, path, body):
    client, _, _, seen, _, _ = desktop
    response = await client.request(
        method,
        BASE + path,
        headers={
            **AUTH,
            "cookie": "caller=secret",
            "referer": "http://caller/?token=secret",
            "x-semantica-scope": "forged",
            "x-starklink-signature": "forged",
        },
        json=body,
    )
    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0}
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers
    assert len(seen) == 1
    outgoing = seen[0]
    target = path.split("?")[0]
    managed = target == W or target.startswith(
        (W + "/keys", W + "/clear", W + "/delete", W + "/exports")
    )
    if target.startswith(W + "/") and not managed:
        target = target[len(W) :]
    assert outgoing.url.path == "/api/integration" + target
    assert outgoing.url.params == httpx.URL("http://x" + path).params
    assert outgoing.headers["authorization"] == "Bearer " + CONFIG["service_token"]
    for key in ("cookie", "referer", "x-starklink-signature"):
        assert key not in outgoing.headers
    grant = claims(outgoing)
    assert grant["actor_id"] == "wanx:7"
    assert grant["owner_view"] is (target == "/owner/graph")
    assert grant["operation_id"] == (body or {}).get("operation_id")
    assert grant["permissions"] == (
        ["read", "write"] if (body or {}).get("operation_id") else ["read"]
    )
    assert int(time.time()) < grant["expires_at"] <= int(time.time()) + 300
    assert grant["expires_at"] - time.time() > resolve(method, path.split("?")[0]).timeout
    if body is not None:
        expected = dict(body)
        if method == "PATCH":
            expected.pop("operation_id")
        if target == "/search":
            expected["delivery_mode"] = "masked"
        assert json.loads(outgoing.content) == expected


def test_identity_derivation_matches_legacy_workspace():
    config = DesktopConfig(**CONFIG)
    for app in ("wanx", "centaurai.wanx.semantica"):
        personal = str(
            uuid.uuid5(
                uuid.UUID("8ae54f40-4054-4bba-a2e2-06e1c43d7514"),
                json.dumps(
                    [CONFIG["box_id"], CONFIG["application_id"], f"personal:{app}:7"],
                    separators=(",", ":"),
                ),
            )
        )
        for warehouse in (None, personal, WAREHOUSE):
            grant = claims(
                httpx.Request(
                    "GET", "http://x", headers=config.headers(7, app, warehouse=warehouse)
                )
            )
            resource = f"personal:{app}:7" + (
                ":warehouse:" + warehouse if warehouse not in (None, personal) else ""
            )
            expected = str(
                uuid.uuid5(
                    uuid.UUID("8ae54f40-4054-4bba-a2e2-06e1c43d7514"),
                    json.dumps(
                        [CONFIG["box_id"], CONFIG["application_id"], resource],
                        separators=(",", ":"),
                    ),
                )
            )
            assert grant["workspace_id"] == expected
            assert grant["workspace_bindings"] == {expected: resource}


@pytest.mark.parametrize(
    "profile", [{"id": 8}, {"permissions": []}, {"permissions": None}, {"application_id": "zhijun"}]
)
async def test_permission_changes_are_checked_before_dispatch(desktop, profile):
    client, _, current, seen, _, _ = desktop
    current.update(profile)
    response = await client.get(BASE + "/warehouses", headers=AUTH)
    assert response.status_code == 403
    assert seen == []


@pytest.mark.parametrize(
    "method,path,body,status",
    [
        ("GET", W + "/documents?workspace_id=another", None, 422),
        ("GET", W + "/documents?limit=1&limit=2", None, 422),
        (
            "POST",
            W + "/reasoning/prepare",
            {"operation_id": "op", "arguments": {"workspace_id": "other"}},
            403,
        ),
        (
            "PUT",
            W + "/sensitive/settings",
            {"operation_id": "op", "payload": {"workspace_id": "other"}},
            403,
        ),
        ("POST", W + "/imports", {}, 422),
        ("POST", "/processing/authorize", {"operation_id": "op"}, 404),
        ("GET", W + "/processing/catalog", None, 404),
        ("GET", "/documents/%252e%252e/auth", None, 404),
        ("POST", "/status", {"operation_id": "op"}, 405),
        ("DELETE", "/warehouses", {}, 405),
        ("GET", "", None, 404),
        ("GET", "/unknown", None, 404),
    ],
)
async def test_untrusted_scope_and_methods_never_reach_upstream(
    desktop, method, path, body, status
):
    client, _, _, seen, _, _ = desktop
    response = await client.request(method, BASE + path, json=body, headers=AUTH)
    assert response.status_code == status
    assert seen == []


@pytest.mark.parametrize(
    "status,value,expected,code",
    [
        (401, {"detail": "service auth"}, 503, "SEMANTICA_SERVICE_AUTH_FAILED"),
        (
            409,
            {"detail": {"code": "SKILL_REVISION_CONFLICT", "message": "已变化"}},
            409,
            "SKILL_REVISION_CONFLICT",
        ),
        (422, {"detail": [{"secret": "must not leak"}]}, 422, "SEMANTICA_INVALID_REQUEST"),
        (302, {"code": "SKILL_INVALID_REQUEST"}, 503, "SEMANTICA_SERVICE_ERROR"),
        (200, [], 502, "SEMANTICA_INVALID_RESPONSE"),
    ],
)
async def test_errors_are_desktop_envelopes(desktop, status, value, expected, code):
    client, _, _, _, reply, _ = desktop
    reply.update(status=status, value=value)
    response = await client.get(BASE + W + "/skills", headers=AUTH)
    assert response.status_code == expected
    assert response.json()["code"] == code
    assert set(response.json()) == {"code", "message"}
    assert "must not leak" not in response.text


async def test_four_megabyte_skill_zip_and_response(desktop):
    client, _, _, seen, reply, _ = desktop
    reply.update(status=201, value={"skill": {"id": "contract"}})
    response = await client.post(
        BASE + W + "/skills/import",
        headers=AUTH,
        json={
            "operation_id": "op",
            "content_base64": base64.b64encode(b"x" * (4 * 1024 * 1024)).decode(),
        },
    )
    assert response.status_code == 201
    assert response.json() == reply["value"]
    assert len(seen[0].content) > 5 * 1024 * 1024
    seen.clear()
    response = await client.post(
        BASE + W + "/imports",
        headers=AUTH,
        json={"operation_id": "op", "unexpected": "x" * (2 * 1024 * 1024)},
    )
    assert response.status_code == 413
    assert seen == []


@pytest.mark.parametrize(
    "path,method,body",
    [
        ("/warehouse", "GET", None),
        ("/documents?limit=20&offset=0", "GET", None),
        ("/graph?limit=120", "GET", None),
        ("/evidence/e-a", "GET", None),
        ("/search", "POST", {"query": "contract"}),
        *[
            ("/reasoning/" + op, "POST", {"arguments": {"preparation_id": "prep-a"}})
            for op in (
                "discover",
                "prepare",
                "reference",
                "scope",
                "search",
                "evidence",
                "read-document",
                "coverage",
            )
        ],
    ],
)
async def test_public_key_contract_is_separate(desktop, path, method, body):
    client, _, profile, seen, _, _ = desktop
    profile["permissions"] = []
    key = "xg_" + "a" * 43
    response = await client.request(
        method, BASE + "/open/v1" + path, headers={**AUTH, "x-xingtu-key": key}, json=body
    )
    assert response.status_code == 200
    assert seen[0].url.path == "/api/open/v1" + path.split("?")[0]
    assert seen[0].headers["authorization"] == "Bearer " + key
    assert "x-semantica-scope" not in seen[0].headers


async def test_public_bad_key_does_not_revoke_wanx_session(desktop):
    client, _, _, _, reply, _ = desktop
    reply.update(status=401, value={"code": "ACCESS_KEY_INVALID"})
    response = await client.get(
        BASE + "/open/v1/graph", headers={**AUTH, "x-xingtu-key": "xg_" + "a" * 43}
    )
    assert response.status_code == 403
    assert response.json()["code"] == "ACCESS_KEY_INVALID"


async def test_public_warehouse_rejects_undeclared_pagination(desktop):
    client, _, _, seen, _, _ = desktop
    response = await client.get(
        BASE + "/open/v1/warehouse?limit=20",
        headers={**AUTH, "x-xingtu-key": "xg_" + "a" * 43},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "SEMANTICA_QUERY_NOT_ALLOWED"
    assert seen == []


async def test_waiting_call_cancels_on_lease_expiry(desktop):
    client, auth, _, _, reply, _ = desktop
    cancelled = asyncio.Event()

    async def handler(request):
        auth.deadline = time.monotonic() + 0.02
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    reply["handler"] = handler
    response = await asyncio.wait_for(client.get(BASE + "/status", headers=AUTH), 2)
    assert response.status_code == 401
    assert cancelled.is_set()


async def test_missing_config_uses_existing_wanx_device_without_shared_secret(desktop, tmp_path):
    client, _, _, seen, _, _ = desktop
    (tmp_path / "semantica.json").unlink()
    response = await client.get(
        BASE + "/status",
        headers={**AUTH, "x-semantica-scope": "forged", "x-semantica-signature": "forged"},
    )
    assert response.status_code == 200
    context = seen[0].headers["x-semantica-scope"]
    value = json.loads(base64.urlsafe_b64decode(context + "=" * (-len(context) % 4)))
    assert value["box_id"] == "wanx-existing-device"
    assert value["application_id"] == "semantica"
    assert value["actor_id"] == "wanx:7"
    assert "authorization" not in seen[0].headers
    assert "x-semantica-signature" not in seen[0].headers
    assert not (tmp_path / "semantica.json").exists()


def test_secretless_config_preserves_legacy_identity_and_new_identity_is_stable(tmp_path):
    path = tmp_path / "semantica.json"
    fresh = DesktopConfig.load(path, box_id="stable-device")
    again = DesktopConfig.load(path, box_id="stable-device")
    assert fresh == again
    path.write_text(json.dumps({k: v for k, v in CONFIG.items() if k != "service_token"}))
    legacy = DesktopConfig.load(path, box_id="stable-device")
    assert (legacy.box_id, legacy.application_id) == (CONFIG["box_id"], CONFIG["application_id"])
    encoded = legacy.headers(7, "wanx")["x-semantica-scope"]
    decoded = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    original = claims(
        httpx.Request("GET", "http://x", headers=DesktopConfig(**CONFIG).headers(7, "wanx"))
    )
    assert decoded["workspace_id"] == original["workspace_id"]
    assert set(legacy.headers(7, "wanx")) == {"x-semantica-scope"}


def test_missing_wanx_identity_does_not_create_shared_default_warehouse(tmp_path):
    with pytest.raises(DesktopError):
        DesktopConfig.load(tmp_path / "semantica.json")


@pytest.mark.parametrize("value", [None, [], {}, {"box_id": "old-box"}])
def test_invalid_existing_config_never_falls_back_to_a_different_identity(tmp_path, value):
    path = tmp_path / "semantica.json"
    path.write_text(json.dumps(value))
    with pytest.raises(DesktopError, match="SEMANTICA_CONFIG_INVALID"):
        DesktopConfig.load(path, box_id="new-device")


def test_timeouts_and_private_route_boundary():
    assert resolve("POST", "/processing/check").timeout == 285
    assert resolve("POST", W + "/reasoning/prepare").timeout == 285
    assert resolve("POST", W + "/search").timeout == 85
    assert resolve("POST", "/processing/reprocess").timeout == 45
    with pytest.raises(DesktopError):
        resolve("POST", "/processing/authorize")


async def test_permissions_revoked_during_request_discard_result(desktop):
    client, _, profile, _, reply, _ = desktop

    async def handler(request):
        profile["permissions"] = []
        return httpx.Response(200, json={"text": "private-result"})

    reply["handler"] = handler
    response = await client.get(BASE + W + "/skills", headers=AUTH)
    assert response.status_code == 403
    assert "private-result" not in response.text


async def test_desktop_disconnect_cancels_before_headers(desktop):
    _, _, _, _, reply, app = desktop
    started, disconnected, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()
    delivered = False

    async def handler(request):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await disconnected.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        pass

    reply["handler"] = handler
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": BASE + "/status",
        "query_string": b"",
        "root_path": "",
        "headers": [(b"authorization", b"Bearer opaque-marker")],
        "client": ("127.0.0.1", 1),
        "server": ("box", 80),
    }
    task = asyncio.create_task(app(scope, receive, send))
    try:
        await asyncio.wait_for(started.wait(), 2)
        disconnected.set()
        await asyncio.wait_for(cancelled.wait(), 1)
        await asyncio.wait_for(task, 2)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize(
    "raw",
    [b"[]", b'{"operation_id":"op","value":NaN}', b'{"operation_id":"op","value":1e999}', b"{"],
)
async def test_malformed_json_never_reaches_upstream(desktop, raw):
    client, _, _, seen, _, _ = desktop
    response = await client.post(
        BASE + "/warehouses", headers={**AUTH, "content-type": "application/json"}, content=raw
    )
    assert response.status_code == 422
    assert seen == []


async def test_large_skill_download_and_invalid_upstream_json(desktop):
    client, _, _, _, reply, _ = desktop
    reply["value"] = {"content_base64": base64.b64encode(b"x" * (8 * 1024 * 1024)).decode()}
    response = await client.get(BASE + W + "/skills/contract/download", headers=AUTH)
    assert response.status_code == 200 and response.json() == reply["value"]

    async def handler(request):
        return httpx.Response(200, content=b'{"value":NaN}')

    reply["handler"] = handler
    response = await client.get(BASE + "/status", headers=AUTH)
    assert response.status_code == 502


async def test_missing_session_and_private_callback_are_rejected(desktop):
    client, _, _, seen, _, _ = desktop
    assert (await client.get(BASE + "/status")).status_code == 401
    assert (
        await client.post("/internal/starklink/models", headers=AUTH, json={})
    ).status_code == 403
    assert seen == []


@pytest.mark.parametrize("field,value", [("service_url", 123), ("service_token", "a" * 32 + "\n")])
def test_invalid_configuration_is_business_error(field, value):
    with pytest.raises(DesktopError, match="SEMANTICA_CONFIG_INVALID"):
        DesktopConfig(**{**CONFIG, field: value})
