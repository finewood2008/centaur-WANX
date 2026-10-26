"""Real loopback HTTP + Unix broker + shared proof verification, synthetic keys only.

The broker below is an isolated authority fixture, not the product ledger. Its
purpose is to exercise both native gates and the clipboard's actual child hops.
Runtime catalog/last-manager policy is covered by the runtime's separate tests.
"""

import hashlib
import json
import os
import secrets
import socket
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingUnixStreamServer
from types import SimpleNamespace

import httpx
import pytest
import uvicorn
from centuarai_local_data_gate import GateConfig, LocalDataGateMiddleware, get_context
from centuarai_local_data_gate.observations import observed_headers
from centuarai_local_data_gate.protocol import (
    LEASE,
    encode,
    gateway_proof_digest,
    principal_namespace,
    public_jwk,
    sign_gateway_lease,
    sign_gateway_request,
    verify_gateway_request,
)
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI, Request
from wanx_clipboard.app import PREFIX, create_app

from octop.api.deps import current_user, get_server
from octop.api.routers import personal_space, space_links

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Native gate requires Unix sockets")


@contextmanager
def http_server(app):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    config = uvicorn.Config(app, log_level="critical", access_log=False, lifespan="on", ws="none")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 5
    while not server.started and thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert server.started
    try:
        yield "http://127.0.0.1:" + str(listener.getsockname()[1])
    finally:
        server.should_exit = True
        thread.join(5)
        listener.close()
        assert not thread.is_alive()


class SyntheticBroker:
    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.public = public_jwk(self.key)
        self.box_pin = encode(secrets.token_bytes(32))
        self.generation = encode(secrets.token_bytes(32))
        self.operations = {}
        self.revoked = set()
        self.children = []
        self.consume = set()
        self.revoke_on_child = None
        self.export_plans = {}

    def payload(self, principal, request, audience="clipboard"):
        now = int(time.time() * 1000)
        namespace = principal_namespace(self.box_pin, 1, principal)
        payload = {
            "schemaVersion": 1, "purpose": "centuarai.local-data.gateway-request",
            "audience": audience, "gatewayId": "synthetic-gateway",
            "gatewayGeneration": self.generation, "sessionId": encode(hashlib.sha256(principal.encode()).digest()),
            "operationId": secrets.token_urlsafe(32), "parentOperationId": None,
            "jti": secrets.token_urlsafe(32), "issuedAtMs": now, "expiresAtMs": now + 2000,
            "boxId": "synthetic-box", "boxKeyThumbprint": self.box_pin, "ownershipEpoch": 1,
            "authorizationVersion": 1, "principalSecurityVersion": 1,
            "bindingId": "binding-" + principal, "bindingRevision": 1,
            "principalId": principal, "clientId": "client-" + principal,
            "applicationId": "clipboard", "launchId": encode(hashlib.sha256((principal + "launch").encode()).digest()),
            "transport": "http", "method": request.method,
            "rawTarget": request.url.raw_path.decode(), "headers": observed_headers(request.headers),
            "bodySha256": encode(hashlib.sha256(request.content).digest()), "bodyBytes": len(request.content),
            "resourceId": "clipboard", "action": "read" if request.method == "GET" else "write",
            "serviceContext": {"kind": "clipboard", "principalNamespace": namespace, "applicationId": "clipboard"}
                if audience == "clipboard" else {"kind": "principal", "principalNamespace": namespace,
                    "clipboardScope": None},
        }
        # This synthetic broker models only the already-admitted parent's fixed
        # plan. The real catalog/body authorization is tested by the runtime.
        if audience == "clipboard" and request.method == "POST" and request.url.path.endswith("/export"):
            value = json.loads(request.content)
            self.export_plans[payload["operationId"]] = {
                "application": "wanx.clipboard", "exportId": value["id"], "parent": value["parent"]}
        return payload

    def dispatch(self, operation, body, audience):
        now = int(time.time() * 1000)
        if operation == "admit":
            proof = body["gatewayProof"]
            claims = verify_gateway_request(proof, self.public, now)
            if claims["jti"] in self.consume:
                raise ValueError("replay")
            self.consume.add(claims["jti"])
            self.operations[claims["operationId"]] = [claims, gateway_proof_digest(proof), "staging"]
        else:
            lookup = body.get("operationId", body.get("parentOperationId"))
            claims = self.operations[lookup][0]
        if claims["principalId"] in self.revoked or claims["audience"] != audience:
            raise ValueError("revoked or wrong service")
        if operation == "child":
            assert audience == "clipboard" and claims["parentOperationId"] is None
            assert body["audience"] == "octop" and body["rawTarget"].startswith("/api/personal-space/")
            child = dict(claims)
            for field in ("audience", "transport", "method", "rawTarget", "headers", "bodySha256", "bodyBytes"):
                child[field] = body[field]
            child.update(operationId=secrets.token_urlsafe(32), parentOperationId=claims["operationId"],
                jti=secrets.token_urlsafe(32), issuedAtMs=now, expiresAtMs=now + 2000,
                serviceContext={"kind": "principal", "principalNamespace": claims["serviceContext"]["principalNamespace"],
                    "clipboardScope": self.export_plans.get(claims["operationId"],
                        {"application": "wanx.clipboard", "exportId": None, "parent": None})})
            self.children.append(child)
            if self.revoke_on_child and self.revoke_on_child(child):
                self.revoked.add(claims["principalId"])
            return sign_gateway_request(child, self.key)
        record = self.operations[claims["operationId"]]
        if operation == "activate":
            assert body["bodySha256"] == claims["bodySha256"] and body["bodyBytes"] == claims["bodyBytes"]
            record[2] = "active"
        if operation == "closed":
            record[2] = "closed"
        lease = {name: claims[name] for name in LEASE if name in claims}
        lease.update(purpose="centuarai.local-data.gateway-lease", gatewayProofDigest=record[1],
            nativeGateGeneration=body["nativeGateGeneration"], gateNonce=body["gateNonce"],
            state=record[2], issuedAtMs=now, expiresAtMs=now + 1000)
        return sign_gateway_lease(lease, self.key)


@pytest.fixture
def protected(tmp_path):
    broker = SyntheticBroker()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                result = broker.dispatch(self.path.removeprefix("/v1/"), body,
                    self.headers["x-centuarai-native-audience"]).encode()
                self.send_response(200)
            except (ValueError, KeyError, AssertionError):
                result = b'{"code":"synthetic-denied"}'
                self.send_response(403)
            self.send_header("Content-Length", str(len(result)))
            self.end_headers()
            self.wfile.write(result)

    with tempfile.TemporaryDirectory(prefix="clip-gate-") as directory:
        socket_path = str(Path(directory).resolve() / "gate.sock")
        uds = ThreadingUnixStreamServer(socket_path, Handler)
        thread = threading.Thread(target=uds.serve_forever, daemon=True)
        thread.start()

        def config(audience):
            staging = (tmp_path / (audience + "-staging")).resolve()
            staging.mkdir(mode=0o700)
            return GateConfig(audience, "synthetic-gateway", broker.public, "synthetic-box",
                broker.box_pin, socket_path, staging)

        core = FastAPI()
        core.include_router(personal_space.router, prefix="/api/personal-space")
        core.include_router(space_links.router, prefix="/api/personal-space")

        def user(request: Request):
            context = get_context(request.scope)
            assert context is not None
            return SimpleNamespace(id={"first": 1001, "second": 1002}[context.claims["principalId"]], application_id="wanx")

        core.dependency_overrides[current_user] = user
        core.dependency_overrides[get_server] = lambda: SimpleNamespace(paths=SimpleNamespace(root=tmp_path / "core"))
        core.add_middleware(LocalDataGateMiddleware, config=config("octop"))
        try:
            with http_server(core) as upstream:
                app = create_app(tmp_path / "clipboard", upstream, gate_config=config("clipboard"), local_data_required=True)
                with http_server(app) as url, httpx.Client(base_url=url, timeout=15, trust_env=False) as client:
                    def request(method, path, *, principal="first", audience="clipboard", **kwargs):
                        target = upstream + path if audience == "octop" else path
                        wire = client.build_request(method, target, **kwargs)
                        payload = broker.payload(principal, wire, audience)
                        wire.headers["X-Centuarai-Gateway-Proof"] = sign_gateway_request(payload, broker.key)
                        return client.send(wire)
                    yield SimpleNamespace(request=request, client=client, broker=broker, path=tmp_path, upstream=upstream)
        finally:
            uds.shutdown()
            uds.server_close()
            thread.join(5)


def test_real_gate_note_conflict_principal_isolation_and_no_bearer(protected):
    e = protected
    assert e.client.get(PREFIX, headers={"Authorization": "Bearer old-cloud"}).status_code == 403
    assert e.client.get(PREFIX + "/openapi.json").status_code == 403
    original = {"expected": 0, "operation": uuid.uuid4().hex,
        "blocks": [{"type": "text", "text": "本地成员的便签"}], "action": "save"}
    result = e.request("PUT", PREFIX + "/note", json=original)
    assert result.status_code == 200, result.text
    assert e.request("GET", PREFIX + "/note").json()["blocks"] == original["blocks"]
    assert e.request("GET", PREFIX + "/note", principal="second").json()["blocks"] == []
    changed = original | {"operation": uuid.uuid4().hex, "blocks": [{"type": "text", "text": "conflict"}]}
    assert e.request("PUT", PREFIX + "/note", json=changed).status_code == 409
    assert e.broker.children and all(c["parentOperationId"] for c in e.broker.children)
    assert all(c["audience"] == "octop" and c["principalId"] == "first" for c in e.broker.children)


def test_real_gate_image_chunks_exact_headers_and_revocation(protected):
    e = protected
    data = b"\x89PNG\r\n\x1a\n" + b"x" * (1024 * 1024)
    item_id = uuid.uuid4().hex
    item = {"id": item_id, "kind": "image", "name": "image.png", "mime": "image/png",
        "size": len(data), "digest": hashlib.sha256(data).hexdigest(), "device": "synthetic"}
    assert e.request("POST", PREFIX + "/batches", json={"id": uuid.uuid4().hex, "items": [item]}).status_code == 200
    for offset in range(0, len(data), 1024 * 1024):
        chunk = data[offset:offset + 1024 * 1024]
        result = e.request("PUT", PREFIX + f"/{item_id}/content?offset={offset}", content=chunk,
            headers={"X-Content-SHA256": hashlib.sha256(chunk).hexdigest()})
        assert result.status_code == 200, result.text
    assert e.request("POST", PREFIX + f"/{item_id}/complete", json={"digest": item["digest"]}).status_code == 200
    assert e.request("GET", PREFIX + f"/{item_id}/content?length=1048576").content == data[:1048576]
    assert e.request("GET", PREFIX + f"/{item_id}", principal="second").status_code == 404
    exported = e.request("POST", PREFIX + f"/{item_id}/export", json={
        "expected": 1, "id": uuid.uuid4().hex, "parent": "", "space_id": "personal",
    })
    assert exported.status_code == 200, exported.text
    assert exported.json()["digest"] == item["digest"]
    e.broker.revoke_on_child = lambda child: "/content?" in child["rawTarget"]
    response = e.request("GET", PREFIX + f"/{item_id}/content?length=1048576")
    assert response.status_code == 403 and data[:100] not in response.content
    assert e.request("GET", PREFIX).status_code == 403


def test_real_gate_agent_context_checks_and_signed_link(protected):
    e = protected
    result = e.request("PUT", PREFIX + "/note", json={"expected": 0, "operation": uuid.uuid4().hex,
        "blocks": [{"type": "text", "text": "Agent visible synthetic note"}], "action": "save"})
    assert result.status_code == 200, result.text
    connection = e.request("POST", "/api/personal-space/connections", audience="octop",
        json={"profile": "synthetic", "name": "synthetic"})
    assert connection.status_code == 200, connection.text
    token = connection.json()["token"]
    result = e.request("POST", PREFIX + "/agent-access", headers={"X-Space-Link": token},
        json={"action": "clipboard-read", "target": "note"})
    assert result.status_code == 200, result.text
    assert "Agent visible synthetic note" in result.text
    assert any(child["headers"]["spaceLink"] == token for child in e.broker.children)
    assert e.request("POST", PREFIX + "/agent-access", json={"action": "clipboard-read", "target": "note"}).status_code == 403
    assert e.request("POST", "/api/personal-space/connections/" + connection.json()["id"] + "/manage",
        audience="octop", json={"action": "pause"}).status_code == 200
    assert e.request("POST", PREFIX + "/agent-access", headers={"X-Space-Link": token},
        json={"action": "clipboard-read", "target": "note"}).status_code == 403


def test_real_gate_rejects_tampered_header_body_audience_and_parent_proof(protected):
    e = protected
    wire = e.client.build_request("GET", PREFIX)
    payload = e.broker.payload("first", wire)
    proof = sign_gateway_request(payload, e.broker.key)
    wire.headers["X-Centuarai-Gateway-Proof"] = proof
    wire.headers["X-Space-Link"] = "unsigned-link"
    assert e.client.send(wire).status_code == 403
    wrong = e.client.build_request("POST", PREFIX + "/batches", content=b"different")
    wrong.headers["X-Centuarai-Gateway-Proof"] = proof
    assert e.client.send(wrong).status_code == 403
    assert e.client.get(e.upstream + "/api/personal-space/files", headers={"X-Centuarai-Gateway-Proof": proof}).status_code == 403
    assert e.client.get(PREFIX, headers={"X-Centuarai-Gateway-Proof":
        sign_gateway_request(payload, ec.generate_private_key(ec.SECP256R1()))}).status_code == 403
