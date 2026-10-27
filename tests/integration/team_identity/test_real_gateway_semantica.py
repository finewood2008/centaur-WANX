"""Real cloud membership ledger -> TLS gateway -> Unix broker -> native services.

Semantica runs in its own existing interpreter with disposable SQLite. Only root
installation configuration and macOS's unsupported peer-UID lookup are fixtures.
No authorization response, resource registry or native request handler is mocked.
"""

from __future__ import annotations

import asyncio
import base64
import importlib
import ipaddress
import json
import os
import socket
import ssl
import sys
import tempfile
from contextlib import asynccontextmanager
from dataclasses import fields
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from centuarai_local_data_gate import GateConfig
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.x509.oid import NameOID
from fastapi import FastAPI
from tests.integration.team_identity.test_cross_runtime import ROOT
from tests.integration.team_identity.test_cross_runtime import bridge as bridge
from tests.integration.team_identity.test_real_enrollment import history as history

WAREHOUSE = "3ed4b7cd-f7ba-49ac-8c59-fda70cd54ae1"
FOREIGN = "9e3d88f4-2ea1-4881-bd49-872deed47515"
RESOURCE = "team:knowledge:" + WAREHOUSE


@asynccontextmanager
async def semantica(root, config):
    source = Path(
        os.environ.get("TEAM_IDENTITY_SEMANTICA_SOURCE", ROOT.parent / "centuarai-semantica")
    )
    python = os.environ.get("TEAM_IDENTITY_SEMANTICA_PYTHON")
    if not python or not (source / "app/main.py").is_file():
        pytest.skip("Coordinated release requires TEAM_IDENTITY_SEMANTICA_PYTHON and source")
    root.mkdir(mode=0o700)
    filename = root / "configuration.json"
    filename.write_text(json.dumps({**config, "root": str(root)}))
    env = {
        key: value
        for key, value in os.environ.items()
        if key
        in {"PATH", "HOME", "LANG", "USER", "TMPDIR", "PYTHONDONTWRITEBYTECODE", "PYTHONPATH"}
    }
    guard = [
        value
        for value in env.get("PYTHONPATH", "").split(os.pathsep)
        if (Path(value) / "sitecustomize.py").is_file()
    ]
    env["PYTHONPATH"] = os.pathsep.join(
        [*guard, str(source), str(ROOT / "packages/local-data-gate")]
    )
    errorfile = root / "server.stderr"
    with errorfile.open("wb") as errors:
        process = await asyncio.create_subprocess_exec(
            python,
            str(Path(__file__).with_name("semantica_process.py")),
            str(filename),
            cwd=root,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=errors,
        )
        try:
            line = await asyncio.wait_for(process.stdout.readline(), 30)
            assert line, errorfile.read_text()[-6000:]

            async def index_document(document_id):
                process.stdin.write(json.dumps({"indexDocument": document_id}).encode() + b"\n")
                await process.stdin.drain()
                response = await asyncio.wait_for(process.stdout.readline(), 30)
                assert response, errorfile.read_text()[-6000:]
                return json.loads(response)

            yield SimpleNamespace(url=json.loads(line)["url"], index_document=index_document)
        finally:
            if process.returncode is None:
                process.stdin.write(b"close\n")
                await process.stdin.drain()
                try:
                    await asyncio.wait_for(process.communicate(), 10)
                except TimeoutError:
                    process.kill()
                    await process.communicate()


def certificate(root, key):
    value = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "fixture")]))
        .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "fixture")]))
        .public_key(key.public_key())
        .serial_number(1)
        .not_valid_before(datetime.now(UTC) - timedelta(minutes=1))
        .not_valid_after(datetime.now(UTC) + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    public, private = root / "tls.pem", root / "tls-key.pem"
    public.write_bytes(value.public_bytes(serialization.Encoding.PEM))
    private.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    private.chmod(0o600)
    return public, private


async def test_real_member_gateway_routes_exact_warehouse_and_revocation(history, monkeypatch):
    from wanx_bridge import local_data_broker as broker_module
    from wanx_bridge import local_data_protocol as wire
    from wanx_bridge.local_data_broker import LocalDataBroker
    from wanx_bridge.local_data_gateway import LocalDataGateway
    from wanx_bridge.local_data_routes import application_policy, child_policy, route_policy

    from octop.api.common import local_data
    from octop.api.routers.auth import router as auth_router
    from octop.infra.db.migrate import run_migrations
    from octop.infra.db.pool import SqlitePool
    from octop.infra.db.services import RepoBundle

    setup = importlib.import_module("test_local_team")
    transport = importlib.import_module("test_local_data_gateway")
    ledger = history.ledger
    ledger.team = setup.activate_team(ledger)
    target = setup.invite_member(ledger)
    setup.admit_member(ledger, target)
    now = setup.NOW + 14
    policy = history.setup.prepare(
        ledger,
        "team.resource-set",
        {
            "resourceId": RESOURCE,
            "expectedRevision": 0,
            "grants": [
                {
                    "principalId": target.request["principalId"],
                    "actions": ["execute", "read", "write"],
                }
            ],
        },
        now=now,
    )
    history.setup.commit(ledger, policy, now=now)
    own = ledger.authority.get_authorization(target.binding_id, now)
    approval = history.setup.prepare(
        ledger,
        "team.device-resources",
        {
            "principalId": own["principalId"],
            "bindingId": own["bindingId"],
            "expectedBindingRevision": own["bindingRevision"],
            "grants": sorted(
                own["grants"] + [{"resourceId": RESOURCE, "actions": ["execute", "read", "write"]}],
                key=lambda item: item["resourceId"],
            ),
        },
        now=now,
    )
    history.setup.commit(ledger, approval, target=target, now=now)
    h = importlib.import_module("test_local_data_sessions").Harness()
    h.clock = transport.RealClock()
    h.box, h.access = ledger.authority._key, target.access
    h.view = ledger.authority.get_authorization(target.binding_id, h.clock.wall // 1000)
    sessions = h.service
    sessions.authority = ledger.authority
    sessions.box_key_thumbprint = h.view["boxKeyThumbprint"]
    sessions.application_policy, sessions.route_policy, sessions.child_policy = (
        application_policy,
        route_policy,
        child_policy,
    )
    sessions.gateway_resources_signer = lambda value: wire.sign_gateway_resources(value, h.gateway)
    sessions.gateway_observation_signer = lambda value: wire.sign_gateway_observation(
        value, h.gateway
    )
    sessions.effects.audiences = frozenset({"octop", "semantica"})

    with tempfile.TemporaryDirectory(prefix="ti-real-sem-", dir="/tmp") as directory:
        root = Path(directory).resolve()
        root.chmod(0o700)
        os.chown(root, -1, os.getgid())
        stage = root / "octop-stage"
        stage.mkdir(mode=0o700)
        if sys.platform != "linux":
            monkeypatch.setattr(broker_module, "peer_uid", lambda _: os.geteuid())
        broker = LocalDataBroker(
            sessions,
            socket_path=root / "gate.sock",
            audience_uids={"octop": {os.geteuid()}, "semantica": {os.geteuid()}},
        )
        await broker.start()
        config = GateConfig(
            "octop",
            "gateway:test",
            wire.public_jwk(h.gateway),
            h.view["boxId"],
            h.view["boxKeyThumbprint"],
            str(root / "gate.sock"),
            stage,
        )
        monkeypatch.setenv("OCTOP_LOCAL_DATA_MODE", "required")
        monkeypatch.setattr(local_data, "load_required_policy", lambda: None)
        monkeypatch.setattr(local_data.GateConfig, "load", lambda *args, **kwargs: config)
        database = SqlitePool(root / "octop.sqlite")
        run_migrations(database)
        repositories = RepoBundle.from_pool(database)
        services = SimpleNamespace(
            **{field.name: getattr(repositories, field.name) for field in fields(repositories)},
            paths=SimpleNamespace(user_avatars_dir=root / "avatars"),
        )
        cache = {}
        server = SimpleNamespace(
            _started=True,
            services=services,
            user_manager=SimpleNamespace(
                get_by_id=cache.get,
                register_cached_user=lambda user: cache.setdefault(user.id, user),
                get_row=services.user_repo.get,
                list_sso_identities=services.user_repo.list_sso_identities,
            ),
            app_runtime=SimpleNamespace(agent_registry=SimpleNamespace(get_row=lambda _: None)),
        )
        app = FastAPI()
        app.state.octop_server = server
        app.include_router(auth_router, prefix="/api/auth")
        local_data.install(app, server)
        public, private = certificate(root, h.box)
        try:
            async with (
                semantica(
                    root / "semantica",
                    {
                        "gatewayKey": wire.public_jwk(h.gateway),
                        "boxId": h.view["boxId"],
                        "boxKeyThumbprint": h.view["boxKeyThumbprint"],
                        "brokerPath": str(root / "gate.sock"),
                    },
                ) as sem,
                transport.server(app, lifespan=True) as octop_url,
            ):
                listener = socket.socket()
                listener.bind(("127.0.0.1", 0))
                gateway = LocalDataGateway(
                    sessions,
                    upstreams={"octop": octop_url, "semantica": sem.url},
                    staging_directory=stage,
                    authority="127.0.0.1:" + str(listener.getsockname()[1]),
                )
                sessions.on_operation_closed = gateway.operation_closed
                await gateway.start()
                try:
                    async with (
                        transport.server(gateway, tls=(public, private), prebound=listener) as url,
                        httpx.AsyncClient(
                            base_url=url,
                            verify=ssl.create_default_context(cafile=public),
                            trust_env=False,
                            timeout=10,
                        ) as client,
                    ):
                        access = await h.session_proof("wanx-host")
                        response = await client.post(
                            "/local-trust/v1/data/sessions", json={"accessProof": access}
                        )
                        assert response.status_code == 200, response.text
                        h.session = h.response(response.text, "session")
                        sequence = 10

                        async def call(method, path, body=None, resource=RESOURCE):
                            nonlocal sequence
                            sequence += 1
                            raw = (
                                b""
                                if body is None
                                else json.dumps(body, separators=(",", ":")).encode()
                            )
                            selectors = {"dataContext": resource}
                            headers = {"x-wanx-data-context": resource}
                            if body is not None:
                                selectors["contentType"] = "application/json"
                                headers["content-type"] = "application/json"
                            _, signed = transport.proof(
                                SimpleNamespace(h=h),
                                path,
                                method=method,
                                data=raw,
                                n=sequence,
                                selectors=selectors,
                            )
                            headers["x-centuarai-data-proof"] = signed
                            return await client.request(method, path, content=raw, headers=headers)

                        me = await call("GET", "/api/auth/me")
                        with database.connect() as connection:
                            assert (
                                connection.execute(
                                    "SELECT count(*) FROM knowledge_bases"
                                ).fetchone()[0]
                                == 0
                            )
                        created = await call(
                            "POST",
                            "/api/semantica/warehouses",
                            {
                                "name": "Approved shared warehouse",
                                "operation_id": "create-shared",
                            },
                        )
                        assert created.status_code == 200, created.text
                        assert created.json()["id"] == WAREHOUSE
                        uploaded = await call(
                            "POST",
                            "/api/semantica/documents",
                            {
                                "filename": "shared.txt",
                                "content_base64": base64.b64encode(
                                    b"approved shared facts"
                                ).decode(),
                                "external_document_id": "shared",
                                "operation_id": "upload-shared",
                            },
                        )
                        assert uploaded.status_code == 200, uploaded.text
                        document = uploaded.json()["document"]["id"]
                        await sem.index_document(document)
                        for path in (
                            "/api/semantica/warehouses/" + WAREHOUSE,
                            "/api/semantica/documents?limit=5",
                            "/api/semantica/graph?limit=5",
                        ):
                            result = await call("GET", path)
                            assert result.status_code == 200, (path, result.text)
                        found = await call(
                            "POST", "/api/semantica/search", {"query": "facts", "limit": 5}
                        )
                        assert found.status_code == 200, found.text
                        items = found.json()["items"]
                        assert items and items[0]["document_id"] == document, found.text
                        evidence_id = items[0]["id"]
                        evidence_path = "/api/semantica/evidence/" + evidence_id
                        evidence = await call("GET", evidence_path)
                        assert evidence.status_code == 200, evidence.text
                        assert evidence.json()["document_id"] == document
                        assert evidence.json()["evidence_kind"] == "search_chunk"
                        for path, resource in (
                            (
                                "/api/semantica/documents/" + document,
                                "team:knowledge:" + FOREIGN,
                            ),
                            ("/api/semantica/documents?warehouse_id=" + FOREIGN, RESOURCE),
                            ("/api/semantica/owner/graph", RESOURCE),
                            ("/api/knowledge-bases/ABCDEF", RESOURCE),
                            (evidence_path, "team:knowledge:" + FOREIGN),
                        ):
                            denied = await call("GET", path, resource=resource)
                            assert denied.status_code == 403, (path, denied.text)
                        assert (
                            await client.get(
                                "/api/semantica/documents",
                                headers={"Authorization": "Bearer cloud-login-only"},
                            )
                        ).status_code == 403
                        assert me.status_code == 200, me.text
                        assert me.json()["role"] == "user" and me.json()["has_password"] is False
                        expected_team = ledger.authority.get_team_authorization(
                            target.binding_id, h.clock.wall // 1000
                        )
                        assert me.json()["team"] == expected_team
                        revoked = history.setup.prepare(
                            ledger,
                            "team.member-revoke",
                            {"principalId": target.request["principalId"]},
                            now=h.clock.wall // 1000,
                        )
                        history.setup.commit(ledger, revoked, now=h.clock.wall // 1000)
                        await sessions.invalidate_authority()
                        assert (await call("GET", "/api/semantica/documents")).status_code == 403
                        assert (await call("GET", "/api/auth/me")).status_code == 403
                finally:
                    await gateway.close()
        finally:
            await broker.close()
            await sessions.close()
            database.close()
