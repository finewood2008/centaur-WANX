"""Device leases project into the providers used by ordinary models and Builder."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from octop.config import OctopConfig
from octop.infra.agents.providers.device_projection import DeviceProviderProjection
from octop.infra.agents.providers.store import ProviderStore
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.services import SharedServices, build_shared_services
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.paths import PathLayout


@pytest.fixture
def services(tmp_path: Path) -> Iterator[SharedServices]:
    paths = PathLayout(tmp_path / "octop")
    paths.ensure_root()
    db = SqlitePool(paths.db)
    run_migrations(db)
    try:
        yield build_shared_services(db=db, paths=paths, config=OctopConfig())
    finally:
        db.close()


def device_provider() -> dict[str, Any]:
    return {
        "name": "admin-managed-qeetoken",
        "kind": "openai",
        "base_url": "http://127.0.0.1:8123/model-providers/qeetoken/v1",
        "api_key": "local-proxy-token",
        "note": "wanx-admin-model-provider-v1:device-1",
        "models": [{"id": "gpt-builder", "name": "Builder GPT", "enabled": True}],
    }


async def test_create_makes_device_provider_available_and_notifies_after_persisting(
    services: SharedServices,
) -> None:
    notifications = []

    async def changed(**event: Any) -> None:
        notifications.append((event, await projection.list_providers()))

    projection = DeviceProviderProjection(services, on_changed=changed)
    assert await projection.list_providers() == []
    created = await projection.create_provider(device_provider())
    assert created == {"id": created["id"], "enabled": True, **device_provider()}
    assert await projection.list_providers() == [created]
    assert notifications == [({"provider_name": "admin-managed-qeetoken"}, [created])]
    runtime = ProviderStore(services.provider_repo).build_harness_configs()
    assert len(runtime) == 1
    assert runtime[0].base_url == "http://127.0.0.1:8123/model-providers/qeetoken/v1"
    assert runtime[0].api_key == "local-proxy-token"
    assert [model.id for model in runtime[0].models] == ["gpt-builder"]


async def test_projection_preserves_manual_provider_and_active_selection(
    services: SharedServices,
) -> None:
    notifications = []

    async def changed(**event: Any) -> None:
        notifications.append(event)

    projection = DeviceProviderProjection(services, on_changed=changed)
    assert await projection.get_active_model() == {"provider_name": "", "model": ""}
    manual = await projection.create_provider(
        {
            "name": "manual",
            "kind": "openai",
            "base_url": "https://models.example/v1",
            "api_key": "manual-key",
            "models": [{"id": "manual-chat"}],
        }
    )
    active = {"provider_name": "manual", "model": "manual-chat"}
    assert await projection.set_active_model(active) == active
    await projection.create_provider(device_provider())
    assert await projection.get_active_model() == active
    assert manual in await projection.list_providers()
    assert notifications == [
        {"provider_name": "manual"},
        {"active_model_changed": True},
        {"provider_name": "admin-managed-qeetoken"},
    ]


async def test_model_update_clears_only_stale_pins_before_notifying(
    services: SharedServices,
) -> None:
    notifications = []

    async def changed(**event: Any) -> None:
        notifications.append((event, await projection.get_active_model()))

    projection = DeviceProviderProjection(services, on_changed=changed)
    body = device_provider()
    body["models"] = [{"id": "gpt-keep"}, {"id": "gpt-gone"}]
    created = await projection.create_provider(body)
    for agent_id, model in (
        ("KEEP", "admin-managed-qeetoken/gpt-keep"),
        ("GONE", "admin-managed-qeetoken/gpt-gone"),
        ("MANUAL", "manual/chat"),
    ):
        services.agent_repo.create(
            agent_id=agent_id, user_id=None, name=agent_id, default_model=model
        )
    await projection.set_active_model(
        {"provider_name": "admin-managed-qeetoken", "model": "gpt-gone"}
    )
    notifications.clear()
    updated = await projection.update_provider(
        created["id"],
        {"models": [{"id": "gpt-keep"}], "api_key": "rotated-local-token"},
    )
    assert updated["api_key"] == "rotated-local-token"
    assert updated["models"] == [{"id": "gpt-keep"}]
    assert await projection.list_providers() == [updated]
    assert {row.agent_id: row.default_model for row in services.agent_repo.list_all()} == {
        "KEEP": "admin-managed-qeetoken/gpt-keep",
        "GONE": None,
        "MANUAL": "manual/chat",
    }
    assert await projection.get_active_model() == {"provider_name": "", "model": ""}
    assert notifications == [
        ({"provider_name": "admin-managed-qeetoken"}, {"provider_name": "", "model": ""})
    ]


async def test_builder_observes_rotation_disable_and_restore(
    services: SharedServices, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(Path(__file__).parents[3] / "wanx-studio" / "backend"))
    from wanx_studio.wanx import WanxModels

    monkeypatch.setenv("WANX_MODEL_PROVIDERS_ENABLED", "1")
    projection = DeviceProviderProjection(services)
    models = WanxModels(services)
    assert models.codex_provider() is None
    created = await projection.create_provider(device_provider())
    await projection.set_active_model(
        {"provider_name": "admin-managed-qeetoken", "model": "gpt-builder"}
    )
    assert models.codex_provider() == {
        "model": "gpt-builder",
        "base_url": "http://127.0.0.1:8123/model-providers/qeetoken/v1",
        "api_key": "local-proxy-token",
        "reasoning": False,
        "reasoning_effort": None,
    }
    updated = await projection.update_provider(created["id"], {"api_key": "rotated-local-token"})
    assert updated["models"] == device_provider()["models"]
    assert models.codex_provider()["api_key"] == "rotated-local-token"
    disabled = await projection.update_provider(created["id"], {"enabled": False, "models": []})
    assert disabled["enabled"] is False
    assert models.codex_provider() is None
    assert ProviderStore(services.provider_repo).build_harness_configs() == []
    assert await projection.get_active_model() == {"provider_name": "", "model": ""}
    await projection.update_provider(
        created["id"], {"enabled": True, "models": device_provider()["models"]}
    )
    assert models.codex_provider()["model"] == "gpt-builder"


async def test_missing_provider_update_does_not_notify_or_change_configuration(
    services: SharedServices,
) -> None:
    notifications = []

    async def changed(**event: Any) -> None:
        notifications.append(event)

    projection = DeviceProviderProjection(services, on_changed=changed)
    with pytest.raises(OctopError) as caught:
        await projection.update_provider(404, {"enabled": False})
    assert caught.value.code == ErrorCode.NOT_FOUND
    assert notifications == []
    assert await projection.list_providers() == []
