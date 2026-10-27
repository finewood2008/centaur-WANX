"""Project trusted device leases into the shared provider configuration.

Credentials supplied here are local proxy tokens. The device runtime retains
the upstream credentials and owns lease validation and synchronization.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from octop.i18n.domains.errors import error_message
from octop.infra.agents.providers.reasoning import reasoning_capability
from octop.infra.agents.providers.store import clear_stale_pins_for_provider
from octop.infra.db.services import SharedServices
from octop.infra.errors import ErrorCode, OctopError

if TYPE_CHECKING:
    from octop.infra.db.repos.providers import ProviderRow


def _provider_data(row: ProviderRow) -> dict[str, Any]:
    models = []
    for stored in row.get_models():
        model = dict(stored)
        capability = reasoning_capability(model, base_url=row.base_url)
        if capability is not None:
            model["reasoning"] = True
            model["reasoning_config"] = capability
        models.append(model)
    return {
        "id": row.id,
        "name": row.name,
        "kind": row.kind,
        "base_url": row.base_url,
        "api_key": row.api_key,
        "models": models,
        "note": row.note,
        "enabled": bool(row.enabled),
    }


class DeviceProviderProjection:
    def __init__(
        self,
        services: SharedServices,
        on_changed: Callable[..., Awaitable[None]] | None = None,
    ) -> None:
        self._services = services
        self._on_changed = on_changed

    async def list_providers(self) -> list[dict[str, Any]]:
        return await asyncio.get_running_loop().run_in_executor(
            None, lambda: [_provider_data(row) for row in self._services.provider_repo.list_all()]
        )

    async def get_active_model(self) -> dict[str, str]:
        name, model = await asyncio.get_running_loop().run_in_executor(
            None, self._services.settings_repo.get_active_model
        )
        return {"provider_name": name, "model": model}

    async def set_active_model(self, body: dict[str, Any]) -> dict[str, str]:
        name, model = body["provider_name"], body["model"]
        await asyncio.get_running_loop().run_in_executor(
            None, self._services.settings_repo.set_active_model, name, model
        )
        if self._on_changed is not None:
            await self._on_changed(active_model_changed=True)
        return {"provider_name": name, "model": model}

    async def create_provider(self, body: dict[str, Any]) -> dict[str, Any]:
        result = await asyncio.get_running_loop().run_in_executor(None, self._create_provider, body)
        if self._on_changed is not None:
            await self._on_changed(provider_name=result["name"])
        return result

    async def update_provider(self, provider_id: int, body: dict[str, Any]) -> dict[str, Any]:
        result = await asyncio.get_running_loop().run_in_executor(
            None, self._update_provider, provider_id, body
        )
        if self._on_changed is not None:
            await self._on_changed(provider_name=result["name"])
        return result

    def _create_provider(self, body: dict[str, Any]) -> dict[str, Any]:
        provider_id = self._services.provider_repo.create(
            name=body["name"],
            kind=body["kind"],
            base_url=body.get("base_url"),
            api_key=body.get("api_key"),
            extra_json=body.get("extra_json"),
            models_json=json.dumps(body["models"]) if body.get("models") is not None else None,
            note=body.get("note"),
        )
        row = self._services.provider_repo.get(provider_id)
        assert row is not None
        return _provider_data(row)

    def _update_provider(self, provider_id: int, body: dict[str, Any]) -> dict[str, Any]:
        row = self._services.provider_repo.get(provider_id)
        if row is None:
            raise OctopError(ErrorCode.NOT_FOUND, error_message(ErrorCode.NOT_FOUND))
        models = body.get("models")
        self._services.provider_repo.update(
            provider_id,
            kind=body.get("kind"),
            base_url=body.get("base_url"),
            api_key=body.get("api_key"),
            extra_json=body.get("extra_json"),
            models_json=json.dumps(models) if models is not None else None,
            note=body.get("note"),
            enabled=body.get("enabled"),
        )
        if models is not None:
            clear_stale_pins_for_provider(
                agent_repo=self._services.agent_repo,
                settings_repo=self._services.settings_repo,
                provider_name=row.name,
                models=models,
            )
        updated = self._services.provider_repo.get(provider_id)
        assert updated is not None
        return _provider_data(updated)
