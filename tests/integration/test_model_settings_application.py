"""Opted-in clients configure native providers without gaining other WANX privileges."""

from typing import Any

from tests.integration.test_applications import grant_product, register_product
from tests.integration.test_applications import products as products


async def test_model_settings_reuses_native_provider_permissions(
    products: Any, monkeypatch: Any
) -> None:
    client, server, admin, *_ = products
    await register_product(client, admin)
    owner = await grant_product(client, server, admin, "admin")
    reader = await grant_product(client, server, admin, "reader")
    assert (await client.get("/api/providers/presets", headers=owner)).status_code == 404
    assert (await client.get("/api/admin/providers", headers=owner)).status_code == 404

    updated = await client.patch(
        "/api/admin/applications/example.product",
        headers=admin,
        json={"capabilities": ["chat", "model_settings"]},
    )
    assert updated.status_code == 200, updated.text
    assert (await client.get("/api/providers/presets", headers=reader)).status_code == 200
    assert (await client.get("/api/providers/resolved", headers=reader)).status_code == 200
    assert (await client.get("/api/admin/providers", headers=reader)).status_code == 403
    assert (await client.get("/api/admin/providers", headers=owner)).status_code == 200

    body = {
        "name": "settings-test",
        "kind": "openai",
        "base_url": "https://example.invalid/v1",
        "api_key": "synthetic-secret",
        "models": [{"id": "test-model", "name": "Test model", "enabled": True}],
    }
    assert (await client.post("/api/admin/providers", headers=reader, json=body)).status_code == 403
    created = await client.post("/api/admin/providers", headers=owner, json=body)
    assert created.status_code == 201, created.text
    pid = created.json()["id"]
    assert server.services.provider_repo.get(pid).name == "settings-test"
    changed = await client.patch(
        f"/api/admin/providers/{pid}",
        headers=owner,
        json={"base_url": "https://updated.invalid/v1"},
    )
    assert changed.status_code == 200, changed.text
    assert server.services.provider_repo.get(pid).api_key == "synthetic-secret"

    async def probe(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"ok": True, "latency_ms": 1}

    monkeypatch.setattr("octop.api.routers.providers.probe_provider_row", probe)
    draft = {**body, "model_id": "test-model"}
    assert (await client.post("/api/admin/providers/test-draft", headers=owner, json=draft)).json()[
        "ok"
    ] is True
    assert (
        await client.post("/api/admin/providers/test-draft", headers=reader, json=draft)
    ).status_code == 403
    assert (
        await client.post(
            f"/api/admin/providers/{pid}/test", headers=owner, json={"model_id": "test-model"}
        )
    ).json()["ok"] is True
    # Opting in is limited to configuration, not deletion, global routing or unrelated admin.
    assert (await client.delete(f"/api/admin/providers/{pid}", headers=owner)).status_code == 404
    assert (await client.get("/api/admin/users", headers=owner)).status_code == 404
    assert (
        await client.put(
            "/api/providers/active-model",
            headers=owner,
            json={"provider_name": "settings-test", "model": "test-model"},
        )
    ).status_code == 404
