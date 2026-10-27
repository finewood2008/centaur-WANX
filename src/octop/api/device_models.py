"""Compose private device inference with the required-mode WANX lifecycle."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from importlib import import_module
from typing import Any

from fastapi import FastAPI

from octop.infra.agents.providers.device_projection import DeviceProviderProjection

logger = logging.getLogger(__name__)


@asynccontextmanager
async def device_model_lifespan(app: FastAPI, server: Any) -> AsyncIterator[None]:
    # Legacy deployments already own this service in their separate Bridge.
    if not getattr(app.state, "local_data_required", False) or not getattr(
        server, "database_bound", False
    ):
        yield
        return
    try:
        catalog = import_module("wanx_bridge.model_provider_catalog")
        errors = import_module("wanx_bridge.config")
        native = import_module("wanx_bridge.native_model_service")
    except ModuleNotFoundError:
        logger.warning("MODEL_PROVIDER_SERVICE_UNAVAILABLE")
        yield
        return

    async with AsyncExitStack() as stack:
        app.state.device_model_runtime = None
        try:
            config = await asyncio.get_running_loop().run_in_executor(
                None, catalog.ModelProviderConfig.from_env
            )
            if config is not None:
                gate = app.state.local_data_gate_config
                policy = app.state.local_data_required_policy
                # Registry and physical box IDs may differ. Bind the configured
                # physical identity to the same root-controlled native policy.
                if (
                    policy is None
                    or config.identity_device_id != gate.box_id
                    or gate.box_id != policy["boxId"]
                ):
                    raise errors.BridgeAuthError("MODEL_PROVIDER_DEVICE_IDENTITY_MISMATCH", 503)
                projection = DeviceProviderProjection(
                    server.services, server.app_runtime.agent_registry.on_provider_changed
                )
                app.state.device_model_runtime = await stack.enter_async_context(
                    native.native_model_service(config, projection)
                )
        except (errors.BridgeAuthError, OSError, TimeoutError, RuntimeError) as error:
            # Provider setup must not disable local login or user data access.
            # Exception text may contain upstream credentials; log only a code.
            logger.warning("%s", getattr(error, "code", "MODEL_PROVIDER_SERVICE_UNAVAILABLE"))
        try:
            yield
        finally:
            app.state.device_model_runtime = None
