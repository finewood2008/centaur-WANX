"""Admin provider leases reach the real WANX model APIs without dashboard edits."""

from __future__ import annotations

import copy
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, call

import httpx
import pytest


class _NativeAdmin:
    """Reuse the test's authenticated ASGI transport, not a provider-store fake."""

    def __init__(self, client, auth):
        self.client, self.auth = client, auth

    async def _admin(self, method, path, **kwargs):
        return await self.client.request(method, path, headers=self.auth, **kwargs)

    async def close(self):
        # The env fixture owns the shared ASGI client's lifetime.
        pass


class _Catalog:
    def __init__(self):
        self.config = SimpleNamespace(device_id="registered-box", interval=60)
        self.value = {
            "schemaVersion": 2,
            "deviceId": "registered-box",
            "bindingId": "owner-binding",
            "ownerAccountId": "owner-1",
            "ownershipEpoch": 1,
            "authVersion": 1,
            "issuedAt": "2026-10-17T00:00:00Z",
            "expiresAt": "2026-10-17T00:05:00Z",
            "providers": [
                {
                    "providerId": "company",
                    "displayName": "Company models",
                    "configVersion": "1",
                    "enabled": True,
                    "protocol": "openai-compatible",
                    "baseUrl": "https://models.example.com/v1",
                    "apiKey": "supplier-secret-never-exported",
                    # Existing Admin records must work without an authorization edit.
                    "allowedProducts": ["zhijun"],
                    "allowedModels": ["chat-a", "chat-b"],
                }
            ],
        }

    async def refresh(self):
        return self.active()

    def active(self):
        return copy.deepcopy(self.value)

    async def close(self):
        pass


@pytest.fixture
async def model_sync(env, monkeypatch, repo_root):
    monkeypatch.syspath_prepend(str(repo_root / "wanx-bridge"))
    from wanx_bridge.model_provider_runtime import ModelProviderRuntime

    client, server, auth = env
    catalog = _Catalog()

    def unexpected_supplier_request(request):
        raise AssertionError(
            f"No supplier request expected with an explicit model list: {request.url.path}"
        )

    runtime = ModelProviderRuntime(
        catalog,
        _NativeAdmin(client, auth),
        "http://127.0.0.1:18089",
        transport=httpx.MockTransport(unexpected_supplier_request),
    )
    registry = server.app_runtime.agent_registry
    changed = AsyncMock(wraps=registry.on_provider_changed)
    monkeypatch.setattr(registry, "on_provider_changed", changed)
    try:
        yield client, server, auth, catalog, runtime, changed
    finally:
        await runtime.close()


async def _read(client, auth, path):
    response = await client.get(path, headers=auth)
    response.raise_for_status()
    return response.json()


async def test_admin_provider_becomes_active_and_rehydrates_native_agents(model_sync):
    client, _server, auth, catalog, runtime, changed = model_sync
    assert await _read(client, auth, "/api/admin/providers") == []
    assert await _read(client, auth, "/api/providers/active-model") == {
        "provider_name": "",
        "model": "",
    }

    await runtime.reconcile()

    providers = await _read(client, auth, "/api/admin/providers")
    assert len(providers) == 1
    provider = providers[0]
    assert provider["name"] == "admin-managed-company"
    assert provider["enabled"] is True
    assert provider["base_url"] == "http://127.0.0.1:18089/model-providers/company/v1"
    assert provider["api_key"] and provider["api_key"] != catalog.value["providers"][0]["apiKey"]
    assert [model["id"] for model in provider["models"]] == ["chat-a", "chat-b"]
    assert await _read(client, auth, "/api/providers/active-model") == {
        "provider_name": "admin-managed-company",
        "model": "chat-a",
    }
    changed.assert_has_awaits(
        [
            call(provider_name="admin-managed-company"),
            call(active_model_changed=True),
        ]
    )
    for path in ("/api/admin/providers", "/api/providers", "/api/providers/resolved"):
        output = await _read(client, auth, path)
        assert "supplier-secret-never-exported" not in json.dumps(output)
    models = await _read(client, auth, "/api/providers/resolved")
    assert len(models) == 2

    # An unchanged renewal must not restart the harness or reset the selected model.
    changed.reset_mock()
    await runtime.reconcile()
    changed.assert_not_awaited()


async def test_rotation_and_disable_clear_native_agent_and_global_model_pins(model_sync):
    client, server, auth, catalog, runtime, changed = model_sync
    await runtime.reconcile()
    original = (await _read(client, auth, "/api/admin/providers"))[0]
    agents = await _read(client, auth, "/api/agents")
    agent_id = agents[0]["agent_id"]
    # Use native persistence only to establish the existing stale pin; all provider
    # changes and cleanup exercise the production HTTP API invoked by the runtime.
    server.services.agent_repo.update_config(agent_id, default_model="admin-managed-company/chat-a")
    changed.reset_mock()
    catalog.value["providers"][0].update(
        configVersion="2", apiKey="rotated-supplier-secret", allowedModels=["chat-b"]
    )

    await runtime.reconcile()

    rotated = (await _read(client, auth, "/api/admin/providers"))[0]
    assert rotated["id"] == original["id"]
    assert rotated["api_key"] != original["api_key"]
    assert rotated["api_key"] != "rotated-supplier-secret"
    assert [model["id"] for model in rotated["models"]] == ["chat-b"]
    assert server.services.agent_repo.get(agent_id).default_model is None
    assert await _read(client, auth, "/api/providers/active-model") == {
        "provider_name": "admin-managed-company",
        "model": "chat-b",
    }
    changed.assert_has_awaits(
        [
            call(provider_name="admin-managed-company"),
            call(active_model_changed=True),
        ]
    )
    assert "rotated-supplier-secret" not in json.dumps(await _read(client, auth, "/api/providers"))

    server.services.agent_repo.update_config(agent_id, default_model="admin-managed-company/chat-b")
    changed.reset_mock()
    catalog.value["providers"] = []
    await runtime.reconcile()

    disabled = (await _read(client, auth, "/api/admin/providers"))[0]
    assert disabled["enabled"] is False and disabled["models"] == []
    assert server.services.agent_repo.get(agent_id).default_model is None
    assert await _read(client, auth, "/api/providers/active-model") == {
        "provider_name": "",
        "model": "",
    }
    assert await _read(client, auth, "/api/providers/resolved") == []
    changed.assert_awaited_once_with(provider_name="admin-managed-company")
