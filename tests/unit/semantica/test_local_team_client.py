"""Finite child adapter over real loopback HTTP with real gateway signatures."""

import hashlib
import json
import secrets
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest
from centuarai_local_data_gate.client import GateContext
from centuarai_local_data_gate.observations import observed_headers
from centuarai_local_data_gate.protocol import (
    DataProtocolError,
    encode,
    principal_namespace,
    public_jwk,
    sign_gateway_request,
    verify_gateway_request,
)
from cryptography.hazmat.primitives.asymmetric import ec

from octop.infra.semantica.client import SemanticaError
from octop.infra.semantica.local_team_client import LocalSemanticaClient
from octop.infra.semantica.team_data import FIELD, read_bound, store_bindings

WAREHOUSE = "3ed4b7cd-f7ba-49ac-8c59-fda70cd54ae1"


class Context(GateContext):
    def __init__(self):
        self.claims = {"audience": "octop"}
        self.revoked = False
        self.calls = []
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.resources = {"semantica", "team:knowledge:" + WAREHOUSE}

    def check_cached(self):
        if self.revoked:
            raise DataProtocolError("LOCAL_DATA_SESSION_CLOSED")

    require_live = check_cached

    def child_headers(self, *, audience, method, raw_target, headers, body):
        self.check_cached()
        assert audience == "semantica"
        resource = headers.get("X-Wanx-Data-Context", "semantica")
        if resource not in self.resources:
            raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")
        self.calls.append((method, raw_target, headers, body))
        thumb = encode(b"b" * 32)
        namespace = principal_namespace(thumb, 1, "principal")
        warehouse = resource.removeprefix("team:knowledge:") if resource != "semantica" else None
        resource_name = "team:1:knowledge:" + warehouse if warehouse else "local:" + namespace
        workspace = str(
            uuid.uuid5(
                uuid.UUID("8ae54f40-4054-4bba-a2e2-06e1c43d7514"),
                json.dumps(["box", "semantica", resource_name], separators=(",", ":")),
            )
        )
        now = int(time.time() * 1000)
        claims = {
            "schemaVersion": 1,
            "purpose": "centuarai.local-data.gateway-request",
            "audience": audience,
            "gatewayId": "gateway",
            "gatewayGeneration": encode(b"g" * 32),
            "sessionId": encode(b"s" * 32),
            "operationId": secrets.token_urlsafe(32),
            "parentOperationId": encode(b"p" * 32),
            "jti": secrets.token_urlsafe(32),
            "issuedAtMs": now,
            "expiresAtMs": now + 2000,
            "boxId": "box",
            "boxKeyThumbprint": thumb,
            "ownershipEpoch": 1,
            "authorizationVersion": 1,
            "principalSecurityVersion": 1,
            "bindingId": "binding",
            "bindingRevision": 1,
            "principalId": "principal",
            "clientId": "client",
            "applicationId": "application",
            "launchId": encode(b"l" * 32),
            "transport": "http",
            "method": method,
            "rawTarget": raw_target,
            "headers": observed_headers(headers),
            "bodySha256": encode(hashlib.sha256(body).digest()),
            "bodyBytes": len(body),
            "resourceId": resource,
            "action": "read",
            "serviceContext": {
                "kind": "warehouse",
                "principalNamespace": namespace,
                "workspaceId": workspace,
                "warehouseId": warehouse,
                "operation": "search_knowledge" if method == "POST" else "list_documents",
            },
        }
        if warehouse:
            claims.update(
                schemaVersion=2,
                team={
                    "schemaVersion": 1,
                    "boxId": "box",
                    "ownershipEpoch": 1,
                    "principalId": "principal",
                    "membershipId": encode(b"m" * 32),
                    "membershipRevision": 1,
                    "roleId": "member",
                    "permissions": [],
                },
            )
        return {**headers, "X-Centuarai-Gateway-Proof": sign_gateway_request(claims, self.key)}


@pytest.fixture
def endpoint():
    context = Context()
    requests = []
    response = {"status": 200, "body": {"items": [{"id": "document"}]}, "after": None}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            assert self.headers.get("Authorization") is None
            proof = self.headers["X-Centuarai-Gateway-Proof"]
            claims = verify_gateway_request(proof, public_jwk(context.key), int(time.time() * 1000))
            assert claims["rawTarget"] == self.path and claims["method"] == self.command
            assert claims["bodySha256"] == encode(hashlib.sha256(body).digest())
            assert claims["headers"] == observed_headers(
                dict(self.headers), proof_header="x-centuarai-gateway-proof"
            )
            requests.append(claims)
            raw = json.dumps(response["body"]).encode()
            self.send_response(response["status"])
            self.send_header("Content-Length", str(len(raw)))
            if response["status"] == 302:
                self.send_header("Location", "http://127.0.0.1:1/should-not-connect")
            self.end_headers()
            if response["after"]:
                response["after"]()
            self.wfile.write(raw)

        do_POST = do_GET

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    client = LocalSemanticaClient(
        context,
        {
            "service_url": f"http://127.0.0.1:{server.server_port}",
            "service_token": "must never be sent",
        },
    )
    try:
        yield client, context, requests, response
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.asyncio
async def test_signed_team_and_private_read_bind_actual_bytes(endpoint):
    client, context, requests, _ = endpoint
    result = await client.request(
        "GET", "/warehouses/" + WAREHOUSE + "/documents", query={"limit": "5"}
    )
    assert result["items"][0]["id"] == "document"
    assert requests[-1]["resourceId"] == "team:knowledge:" + WAREHOUSE
    assert requests[-1]["rawTarget"] == "/api/integration/documents?limit=5"
    await client.request("POST", "/search", payload={"query": "中文 evidence", "limit": 2})
    assert requests[-1]["resourceId"] == "semantica"
    assert json.loads(context.calls[-1][3])["delivery_mode"] == "masked"
    await client.request("GET", "/warehouses/" + WAREHOUSE + "/graph")
    assert requests[-1]["rawTarget"] == "/api/integration/graph"
    await client.request("GET", "/warehouses/" + WAREHOUSE + "/evidence/evidence-id")
    assert requests[-1]["rawTarget"] == "/api/integration/evidence/evidence-id"
    assert requests[-1]["resourceId"] == "team:knowledge:" + WAREHOUSE


@pytest.mark.asyncio
async def test_unfrozen_resource_write_and_scope_overrides_never_reach_http(endpoint):
    client, context, requests, _ = endpoint
    with pytest.raises(SemanticaError, match="FORBIDDEN"):
        await client.request("GET", "/warehouses/00000000-0000-0000-0000-000000000001/documents")
    for method, path, options in (
        ("POST", "/documents", {"payload": {"filename": "bad"}}),
        ("GET", "/owner/graph", {}),
        ("GET", "/documents", {"query": {"workspace_id": "foreign"}}),
        ("POST", "/search", {"payload": {"query": "q", "owner_view": True}}),
        ("GET", "/documents/../status", {}),
    ):
        with pytest.raises(SemanticaError):
            await client.request(method, path, **options)
    assert requests == [] and context.calls == []


@pytest.mark.asyncio
async def test_redirect_and_late_revocation_do_not_deliver_data(endpoint):
    client, context, requests, response = endpoint
    response["status"] = 302
    with pytest.raises(SemanticaError, match="SERVICE_ERROR"):
        await client.request("GET", "/documents")
    assert len(requests) == 1
    response["status"] = 200
    response["after"] = lambda: setattr(context, "revoked", True)
    with pytest.raises(SemanticaError, match="FORBIDDEN"):
        await client.request("GET", "/documents")


def test_fixed_loopback_origin_and_real_context_required():
    for url in (
        "https://example.com",
        "http://127.0.0.1/path",
        "http://user@127.0.0.1",
        "http://127.0.0.1?x=1",
    ):
        with pytest.raises(SemanticaError, match="CONFIG_INVALID"):
            LocalSemanticaClient(Context(), {"service_url": url})
    with pytest.raises(SemanticaError, match="FORBIDDEN"):
        LocalSemanticaClient(object(), {"service_url": "http://127.0.0.1:8090"})


@pytest.mark.asyncio
async def test_deployed_team_binding_uses_current_principal_child_proof_no_secret_fallback(
    endpoint, tmp_path, monkeypatch
):
    client, context, requests, _ = endpoint
    context.claims.update(
        boxId="box", ownershipEpoch=1, principalId="principal", boxKeyThumbprint=encode(b"b" * 32)
    )
    context.principal_namespace = principal_namespace(encode(b"b" * 32), 1, "principal")
    config = {"service_url": client.base_url, "service_token": "old JWT must not be used"}
    (tmp_path / "semantica.json").write_text(json.dumps(config))
    saved = {"resourceId": "team:knowledge:" + WAREHOUSE, "boxId": "box", "ownershipEpoch": 1}
    services = SimpleNamespace(
        paths=SimpleNamespace(root=tmp_path),
        application_repo=SimpleNamespace(
            deployment=lambda _: {"configuration": {FIELD: {WAREHOUSE: saved}}}
        ),
        local_data_principal_repo=SimpleNamespace(
            resolve=lambda namespace, thumb, epoch, principal: 3
        ),
    )
    await read_bound(
        services, "wanx:3", "app", "documents", {"warehouseId": WAREHOUSE}, context=context
    )
    assert requests[-1]["resourceId"] == "team:knowledge:" + WAREHOUSE
    await read_bound(
        services, "wanx:3", "app", "graph", {"warehouseId": WAREHOUSE}, context=context
    )
    assert requests[-1]["rawTarget"] == "/api/integration/graph"
    await read_bound(
        services,
        "wanx:3",
        "app",
        "evidence",
        {"warehouseId": WAREHOUSE, "id": "evidence-id"},
        context=context,
    )
    assert requests[-1]["rawTarget"] == "/api/integration/evidence/evidence-id"
    count = len(requests)
    for owner, supplied in (("wanx:4", context), ("wanx:3", object())):
        with pytest.raises(SemanticaError):
            await read_bound(
                services, owner, "app", "documents", {"warehouseId": WAREHOUSE}, context=supplied
            )
    saved["ownershipEpoch"] = 2
    with pytest.raises(SemanticaError):
        await read_bound(
            services, "wanx:3", "app", "documents", {"warehouseId": WAREHOUSE}, context=context
        )
    monkeypatch.setenv("OCTOP_LOCAL_DATA_MODE", "required")
    with pytest.raises(SemanticaError):
        await read_bound(services, "wanx:3", "app", "documents", {"warehouseId": WAREHOUSE})
    assert len(requests) == count


def test_required_binding_freezes_only_explicit_read_resource_and_never_legacy_key():
    context = Context()
    context.principal_namespace = "current-principal"
    team = {"permissions": ["applications.manage"]}
    context.claims.update(boxId="box", ownershipEpoch=1, resourceId="team:management", team=team)
    frozen = []
    context.authorize_resources_sync = lambda grants: frozen.append(grants)
    user = SimpleNamespace(
        local_data=True,
        is_admin=False,
        local_team_context=context,
        local_team=team,
        username="local_current-principal",
    )
    app = "ai.wanx.selfmade." + "a" * 32
    result = store_bindings(
        None, user, app, {FIELD: {WAREHOUSE: {"resourceId": "team:knowledge:" + WAREHOUSE}}}
    )
    assert frozen == [[{"resourceId": "team:knowledge:" + WAREHOUSE, "actions": ["read"]}]]
    assert result[FIELD][WAREHOUSE] == {
        "resourceId": "team:knowledge:" + WAREHOUSE,
        "boxId": "box",
        "ownershipEpoch": 1,
    }
    with pytest.raises(SemanticaError):
        store_bindings(None, user, app, {FIELD: {WAREHOUSE: {"keyId": "legacy-key"}}})
    assert len(frozen) == 1
