"""Required-mode WANX starts device models without the legacy login bridge."""

from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from octop.api.common import local_data
from tests.support.app import octop_client


@pytest.fixture
def device_environment(monkeypatch, tmp_path, repo_root):
    monkeypatch.syspath_prepend(str(repo_root / "wanx-bridge"))
    for name in list(os.environ):
        if name.startswith(("WANX_MODEL_PROVIDERS_", "WANX_RESOURCES_", "WANX_PLATFORM_")):
            monkeypatch.delenv(name)
    key = tmp_path / "device-key"
    key.write_text("synthetic-device-key-for-tests")
    key.chmod(0o600)
    monkeypatch.setenv("OCTOP_LOCAL_DATA_MODE", "required")
    for name, value in {
        "ENABLED": "1",
        "DEVICE_ID": "registry-box",
        "IDENTITY_DEVICE_ID": "physical-box",
        "API_BASE": "https://admin.example.com",
        "KEY_FILE": str(key),
        "PROTOCOL_VERSION": "3",
    }.items():
        monkeypatch.setenv("WANX_MODEL_PROVIDERS_" + name, value)
    gate = local_data.GateConfig(
        audience="octop",
        box_id="physical-box",
        gateway_id="gateway-test",
        gateway_key={},
        box_key_thumbprint="synthetic-thumbprint",
        broker_socket=str(tmp_path / "broker.sock"),
        staging_directory=tmp_path,
    )
    policy = {"boxId": gate.box_id, "gatewayId": gate.gateway_id}
    monkeypatch.setattr(local_data, "load_required_policy", lambda: policy)
    monkeypatch.setattr(local_data.GateConfig, "load", lambda *a, **kw: gate)
    calls = []

    @asynccontextmanager
    async def native(config, projection, **kwargs):
        calls.append((config, projection))
        await projection.create_provider(
            {
                "name": "admin-managed-qeetoken",
                "kind": "openai",
                "base_url": "http://127.0.0.1:18089/model-providers/qeetoken/v1",
                "api_key": "synthetic-local-proxy-token",
                "note": "wanx-admin-model-provider-v1:registry-box",
                "models": [{"id": "gpt-test", "enabled": True}],
            }
        )
        try:
            yield SimpleNamespace(closed=False)
        finally:
            calls.append("closed")

    monkeypatch.setitem(
        sys.modules,
        "wanx_bridge.native_model_service",
        SimpleNamespace(native_model_service=native),
    )
    return calls, gate


async def test_required_lifespan_projects_provider_for_builder_without_legacy_login(
    device_environment, tmp_octop_home
):
    calls, _ = device_environment
    async with octop_client(tmp_octop_home) as (client, server):
        app = client._octop_app
        assert app.state.local_data_required
        assert not calls
        async with app.router.lifespan_context(app):
            assert len(calls) == 1, "required mode did not start device Provider synchronization"
            config, _ = calls[0]
            assert config.device_id == "registry-box"
            assert config.identity_device_id == "physical-box"
            configured = app.state.app_studio.model.codex_provider()
            assert configured["model"] == "gpt-test"
            assert configured["api_key"] == "synthetic-local-proxy-token"
            # Native data routes still require a local proof; no admin HTTP bypass.
            rejected = await client.get("/api/admin/providers")
            assert rejected.status_code == 403
            assert server.services.provider_repo.get_by_name("admin-managed-qeetoken")
        assert calls[-1] == "closed"


@pytest.mark.parametrize(
    "change", ["disabled", "foreign-device", "missing-identity", "invalid-config", "legacy"]
)
async def test_device_models_do_not_start_outside_matching_required_device(
    device_environment, tmp_octop_home, monkeypatch, change
):
    calls, _ = device_environment
    if change == "disabled":
        monkeypatch.setenv("WANX_MODEL_PROVIDERS_ENABLED", "0")
    elif change == "foreign-device":
        monkeypatch.setenv("WANX_MODEL_PROVIDERS_IDENTITY_DEVICE_ID", "different-physical-box")
    elif change == "missing-identity":
        monkeypatch.delenv("WANX_MODEL_PROVIDERS_IDENTITY_DEVICE_ID")
    elif change == "invalid-config":
        monkeypatch.setenv("WANX_MODEL_PROVIDERS_CHECK_INTERVAL_SECONDS", "invalid")
    else:
        monkeypatch.setattr(local_data, "install", lambda *args: None)
    async with octop_client(tmp_octop_home) as (client, _):
        app = client._octop_app
        async with app.router.lifespan_context(app):
            assert not calls


async def test_private_listener_startup_error_preserves_app_and_redacts_error(
    device_environment, tmp_octop_home, monkeypatch, caplog
):
    @asynccontextmanager
    async def unavailable(*args, **kwargs):
        raise OSError("synthetic-secret-that-must-not-be-logged")
        yield

    monkeypatch.setitem(
        sys.modules,
        "wanx_bridge.native_model_service",
        SimpleNamespace(native_model_service=unavailable),
    )
    async with octop_client(tmp_octop_home) as (client, _):
        app = client._octop_app
        async with app.router.lifespan_context(app):
            assert app.state.local_data_required
            assert app.state.device_model_runtime is None
    assert "MODEL_PROVIDER_SERVICE_UNAVAILABLE" in caplog.text
    assert "synthetic-secret-that-must-not-be-logged" not in caplog.text
