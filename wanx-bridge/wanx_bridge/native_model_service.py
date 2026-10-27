"""Loopback inference host for the native WANX process.

Provider projection calls the domain adapter directly. No Bridge login, SSO or
administrative HTTP surface is started by this service.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import socket
from collections.abc import AsyncIterator, Callable, Iterator
from typing import Any, Protocol

import httpx
import uvicorn
from fastapi import FastAPI

from .model_provider_catalog import ModelProviderCatalog, ModelProviderConfig
from .model_provider_runtime import ModelProviderRuntime

logger = logging.getLogger(__name__)


class ProviderProjection(Protocol):
    async def list_providers(self) -> list[dict[str, Any]]: ...

    async def create_provider(self, body: dict[str, Any]) -> dict[str, Any]: ...

    async def update_provider(self, provider_id: int, body: dict[str, Any]) -> dict[str, Any]: ...

    async def get_active_model(self) -> dict[str, Any]: ...

    async def set_active_model(self, body: dict[str, Any]) -> dict[str, Any]: ...


class NativeAdminAdapter:
    """Only the five internal operations used by ModelProviderRuntime."""

    def __init__(self, projection: ProviderProjection) -> None:
        self.projection = projection

    async def _admin(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        if method == "GET" and not kwargs and path == "/api/admin/providers":
            value = await self.projection.list_providers()
        elif method == "GET" and not kwargs and path == "/api/providers/active-model":
            value = await self.projection.get_active_model()
        elif set(kwargs) == {"json"} and isinstance(kwargs["json"], dict):
            body = kwargs["json"]
            match = re.fullmatch(r"/api/admin/providers/([1-9][0-9]*)", path)
            if method == "POST" and path == "/api/admin/providers":
                value = await self.projection.create_provider(body)
            elif method == "PATCH" and match:
                value = await self.projection.update_provider(int(match[1]), body)
            elif method == "PUT" and path == "/api/providers/active-model":
                value = await self.projection.set_active_model(body)
            else:
                raise ValueError("MODEL_PROVIDER_PROJECTION_OPERATION_DENIED")
        else:
            raise ValueError("MODEL_PROVIDER_PROJECTION_OPERATION_DENIED")
        return httpx.Response(201 if method == "POST" else 200, json=value)

    async def close(self) -> None:
        # The parent Octop lifespan owns the domain services, not this adapter.
        pass


class NativeServer(uvicorn.Server):
    @contextlib.contextmanager
    def capture_signals(self) -> Iterator[None]:
        # Octop's outer server owns process signals.
        yield


async def _serve(server: NativeServer, listener: socket.socket) -> None:
    try:
        await server.serve(sockets=[listener])
    except (SystemExit, Exception):
        raise RuntimeError("MODEL_PROVIDER_LISTENER_FAILED") from None


async def _ready(server: NativeServer, task: asyncio.Task[None]) -> None:
    async with asyncio.timeout(10):
        while not server.started:
            if task.done():
                await task
                raise RuntimeError("MODEL_PROVIDER_LISTENER_FAILED")
            await asyncio.sleep(0.01)
        if task.done():
            await task
            raise RuntimeError("MODEL_PROVIDER_LISTENER_FAILED")


@contextlib.asynccontextmanager
async def native_model_service(
    config: ModelProviderConfig,
    projection: ProviderProjection,
    *,
    authority_check: Callable[[dict[str, Any]], Any] | None = None,
    port: int = 18089,
    catalog: ModelProviderCatalog | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> AsyncIterator[ModelProviderRuntime]:
    """Serve private inference and poll device configuration until lifespan exit.

    Readiness covers only the loopback listener. Admin network synchronization
    starts immediately in the background and cannot delay the main application.
    The yielded runtime is closed if either background task exits unexpectedly.
    """
    owned_catalog = catalog if catalog is not None else ModelProviderCatalog(config)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    runtime: ModelProviderRuntime | None = None
    server: NativeServer | None = None
    listener_task: asyncio.Task[None] | None = None
    poll_task: asyncio.Task[None] | None = None
    monitor_task: asyncio.Task[None] | None = None
    shutdown_task: asyncio.Task[None] | None = None
    stopping = False
    background_failed = False

    async def shutdown() -> None:
        try:
            if poll_task is not None:
                poll_task.cancel()
                await asyncio.gather(poll_task, return_exceptions=True)
            if runtime is not None:
                await runtime.close()
            else:
                await owned_catalog.close()
        finally:
            try:
                if server is not None:
                    server.should_exit = True
                if listener_task is not None:
                    done, _ = await asyncio.wait((listener_task,), timeout=5)
                    if not done:
                        listener_task.cancel()
                    await asyncio.gather(listener_task, return_exceptions=True)
                if server is not None and any(
                    acceptor.is_serving() for acceptor in getattr(server, "servers", ())
                ):
                    # serve() does not run Uvicorn shutdown when its main loop
                    # fails. Close its acceptors and connections as well.
                    await server.shutdown(sockets=[listener])
            finally:
                listener.close()

    async def close() -> None:
        nonlocal shutdown_task
        if shutdown_task is None:
            shutdown_task = asyncio.create_task(shutdown(), name="native-model-shutdown")
        await asyncio.shield(shutdown_task)

    async def monitor() -> None:
        nonlocal background_failed
        assert listener_task is not None and poll_task is not None and runtime is not None
        await asyncio.wait((listener_task, poll_task), return_when=asyncio.FIRST_COMPLETED)
        if not stopping:
            background_failed = True
            runtime.last_error = "MODEL_PROVIDER_SERVICE_STOPPED"
            logger.warning("MODEL_PROVIDER_SERVICE_STOPPED")
        await close()

    try:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", port))
        listener.listen(128)
        listener.setblocking(False)
        actual_port = listener.getsockname()[1]
        runtime = ModelProviderRuntime(
            owned_catalog,
            NativeAdminAdapter(projection),
            f"http://127.0.0.1:{actual_port}",
            authority_check=authority_check,
            transport=transport,
        )
        app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
        runtime.register_routes(app)
        server = NativeServer(
            uvicorn.Config(
                app,
                host="127.0.0.1",
                port=actual_port,
                lifespan="off",
                access_log=False,
                log_level="warning",
                server_header=False,
                timeout_graceful_shutdown=1,
            )
        )
        listener_task = asyncio.create_task(_serve(server, listener), name="native-model-listener")
        await _ready(server, listener_task)
        poll_task = asyncio.create_task(runtime.poll(), name="native-model-poll")
        monitor_task = asyncio.create_task(monitor(), name="native-model-monitor")
        yield runtime
        if background_failed:
            raise RuntimeError("MODEL_PROVIDER_SERVICE_STOPPED")
    finally:
        stopping = True
        try:
            await close()
        finally:
            if monitor_task is not None:
                monitor_task.cancel()
                await asyncio.gather(monitor_task, return_exceptions=True)
