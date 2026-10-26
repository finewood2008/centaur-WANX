"""Runtime wiring and signed HTTPS resource preparation through the real UDS gate."""

# Cross-package fixtures must be located before importing their test modules.
# ruff: noqa: E402
from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from fastapi import FastAPI

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "wanx-bridge"))
sys.path.insert(0, str(ROOT / "wanx-bridge/tests"))
sys.path.insert(0, str(ROOT / "tests/unit/applications"))

from centuarai_local_data_gate.native_policy import check_octop_request
from test_local_data_gateway import RealClock, proof
from test_local_data_gateway import network as network
from test_local_data_sessions import Harness
from test_local_resources import body
from test_local_resources import runtime as _resource_runtime
from wanx_bridge.local_data_config import LocalDataConfig
from wanx_bridge.local_trust_runtime import data_application
from wanx_bridge.local_trust_service import LocalTrustService

from octop.api.common.local_data import _check_private_resources, _resolve, protocol_error
from octop.api.routers.local_applications import router
from octop.infra.applications.local_catalog import LocalResourceCatalog

# Register the shared fixture explicitly; Ruff must not remove its import.
application_runtime = _resource_runtime


@pytest.fixture
def short_directory():
    with tempfile.TemporaryDirectory(prefix="runtime-", dir=Path("/tmp").resolve()) as directory:
        yield Path(directory)


@pytest.mark.asyncio
async def test_runtime_assembles_one_authority_and_separate_management_data(
    monkeypatch, tmp_path, short_directory
):
    h = Harness()
    h.clock = RealClock()
    tmp_path.chmod(0o700)
    staging = tmp_path / "stage"
    staging.mkdir(mode=0o700)
    key_file = tmp_path / "box-signing-key.pem"
    key_file.write_bytes(
        h.box.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    key_file.chmod(0o600)
    settings = LocalDataConfig(
        "gateway:test",
        h.gateway,
        short_directory / "gate.sock",
        staging,
        {"octop": {"origin": "http://127.0.0.1:19001", "uid": os.geteuid()}},
        None,
    )
    monkeypatch.setattr(LocalDataConfig, "load", lambda *a, **k: settings)
    config = SimpleNamespace(
        data_config=tmp_path / "data.json", state_directory=tmp_path, authority="box.test:9443"
    )
    captures = []
    authority = SimpleNamespace(
        bundle={"boxId": "box:test", "boxKey": h.view["accessKey"]},
        get_authorization=lambda binding, now: copy.deepcopy(h.view),
        close=lambda: None,
        install_effect_provider=lambda provider, **kwargs: captures.append(kwargs),
    )
    # Bind signing and public identity to the same synthetic box.
    from wanx_bridge import local_data_protocol as wire

    authority.bundle["boxKey"] = wire.public_jwk(h.box)
    service = LocalTrustService(authority)
    dispatcher, gateway, broker, sessions = await data_application(config, authority, service)
    try:
        assert sessions.authority is authority
        assert captures == [{"generation": sessions.generation}]
        assert gateway.sessions is broker.sessions is sessions
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=dispatcher), base_url="https://box.test:9443"
        ) as client:
            response = await client.post(
                "/local-trust/v1/data/session-challenge",
                json=h.intent(),
            )
            assert response.status_code == 200, response.text
            decoded = wire.verify_data_response(
                response.text,
                wire.public_jwk(h.box),
                box_id="box:test",
                kind="session-challenge",
                now_ms=h.clock.wall,
            )
            assert decoded["body"]["gatewayGeneration"] == sessions.generation
            # A legacy bearer cannot select a management or data principal.
            assert (
                await client.post(
                    "/local-trust/v1/data/session-challenge",
                    json={},
                    headers={"Authorization": "Bearer old"},
                )
            ).status_code == 403
            assert (
                await client.post(
                    "/local-trust/v1/auth/challenge",
                    json={},
                    headers={"Authorization": "Bearer old"},
                )
            ).status_code == 403
    finally:
        await sessions.close()
        await gateway.close()
        await broker.close()
        await service.close()
        await h.service.close()


def install_resource_app(network, application_runtime, monkeypatch):
    resource, services, registry, _, fixture = application_runtime
    users = {}
    server = SimpleNamespace(
        _started=True,
        services=services,
        user_manager=SimpleNamespace(
            get_by_id=users.get, register_cached_user=lambda user: users.setdefault(user.id, user)
        ),
        app_runtime=SimpleNamespace(agent_registry=registry),
    )
    app = FastAPI()
    app.state.octop_server = server
    app.state.local_data_required = True
    app.include_router(router)
    from centuarai_local_data_gate.protocol import DataProtocolError

    app.add_exception_handler(DataProtocolError, protocol_error)
    monkeypatch.setattr(LocalResourceCatalog, "from_environment", lambda: resource.catalog)

    async def authorize(scope, context):
        check_octop_request(scope, context.claims)
        user = await asyncio.to_thread(_resolve, server, context)
        await asyncio.to_thread(_check_private_resources, server, scope, context, user)
        scope.setdefault("state", {})["octop_user"] = user

    network.native.authorize = authorize
    network.native.app = app
    return services, registry, fixture


@pytest.mark.asyncio
async def test_real_https_uds_native_candidate_and_readiness(
    network, application_runtime, monkeypatch
):
    services, registry, fixture = install_resource_app(network, application_runtime, monkeypatch)
    path = "/api/platform/applications/candidates/prepare"
    raw = json.dumps(body(fixture), separators=(",", ":")).encode()
    _, signed = proof(
        network, path, method="POST", data=raw, selectors={"contentType": "application/json"}
    )
    response = await network.client.post(
        path,
        content=raw,
        headers={"Content-Type": "application/json", "X-Centuarai-Data-Proof": signed},
    )
    assert response.status_code == 200, response.text
    prepared = response.json()
    assert prepared["status"] == "ready"
    assert prepared["bindingScope"]["authorization"] == "local-trust-v1"
    assert len(registry.list_rows()) == 1 and len(services.skill_package_repo.list_all()) == 1
    path = "/api/platform/applications/readiness"
    raw = json.dumps(
        body(fixture, operation="readiness", binding_id=prepared["bindingSetId"]),
        separators=(",", ":"),
    ).encode()
    _, signed = proof(
        network, path, method="POST", data=raw, n=4, selectors={"contentType": "application/json"}
    )
    response = await network.client.post(
        path,
        content=raw,
        headers={"Content-Type": "application/json", "X-Centuarai-Data-Proof": signed},
    )
    assert response.status_code == 200 and response.json()["bindings"] == prepared["bindings"], (
        response.text
    )
    # Batch authorization remains live for the whole parent operation. A new
    # session with insufficient current grants may not start another write.
    network.h.view["grants"] = [{"resourceId": "wanx", "actions": ["read"]}]
    await network.h.service.invalidate_authority()
    _, signed = proof(
        network, path, method="POST", data=raw, n=5, selectors={"contentType": "application/json"}
    )
    rejected = await network.client.post(
        path,
        content=raw,
        headers={"Content-Type": "application/json", "X-Centuarai-Data-Proof": signed},
    )
    assert rejected.status_code == 403
    assert len(registry.list_rows()) == len(services.skill_package_repo.list_all()) == 1


@pytest.mark.asyncio
async def test_real_batch_resource_denial_before_any_preparation(
    network, application_runtime, monkeypatch
):
    services, registry, fixture = install_resource_app(network, application_runtime, monkeypatch)
    network.h.view["grants"] = [{"resourceId": "wanx", "actions": ["write"]}]
    await asyncio.sleep(1.05)  # authoritative cache expires, session remains present
    path = "/api/platform/applications/candidates/prepare"
    raw = json.dumps(body(fixture), separators=(",", ":")).encode()
    _, signed = proof(
        network, path, method="POST", data=raw, n=8, selectors={"contentType": "application/json"}
    )
    response = await network.client.post(
        path,
        content=raw,
        headers={"Content-Type": "application/json", "X-Centuarai-Data-Proof": signed},
    )
    assert response.status_code == 403, response.text
    assert registry.list_rows() == [] and services.skill_package_repo.list_all() == []
