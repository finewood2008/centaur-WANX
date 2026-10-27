import asyncio
import copy
import json
import signal
import socket
from types import SimpleNamespace

import httpx
import pytest

from wanx_bridge import native_model_service as service


class Catalog:
    def __init__(self):
        self.config = SimpleNamespace(device_id="box-native", interval=0.02)
        self.closed = False
        self.refresh_started = asyncio.Event()
        self.refresh_gate = None
        self.value = {
            "deviceId": "box-native",
            "bindingId": "binding",
            "ownerAccountId": "owner",
            "ownershipEpoch": 1,
            "authVersion": 1,
            "providers": [
                {
                    "providerId": "qeetoken",
                    "displayName": "QeeToken",
                    "enabled": True,
                    "configVersion": "1",
                    "protocol": "openai-compatible",
                    "baseUrl": "https://models.example.com/v1",
                    "apiKey": "supplier-private-key",
                    "allowedProducts": ["wanxiang"],
                    "allowedModels": ["gpt-test"],
                }
            ],
        }

    async def refresh(self):
        self.refresh_started.set()
        if self.refresh_gate is not None:
            await self.refresh_gate.wait()

    def active(self):
        return copy.deepcopy(self.value)

    async def close(self):
        self.closed = True


class Projection:
    def __init__(self):
        self.rows = []
        self.active = {"provider_name": "", "model": ""}
        self.calls = []

    async def list_providers(self):
        self.calls.append(("list",))
        return copy.deepcopy(self.rows)

    async def create_provider(self, body):
        self.calls.append(("create", copy.deepcopy(body)))
        row = {**copy.deepcopy(body), "id": len(self.rows) + 1, "enabled": True}
        self.rows.append(row)
        return copy.deepcopy(row)

    async def update_provider(self, ident, body):
        self.calls.append(("update", ident, copy.deepcopy(body)))
        row = next(row for row in self.rows if row["id"] == ident)
        row.update(body)
        return copy.deepcopy(row)

    async def get_active_model(self):
        self.calls.append(("get-active",))
        return copy.deepcopy(self.active)

    async def set_active_model(self, body):
        self.calls.append(("set-active", copy.deepcopy(body)))
        self.active = copy.deepcopy(body)
        return copy.deepcopy(self.active)


async def wait_for(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_private_native_service_syncs_and_serves_responses_without_auth_routes():
    catalog, projection, seen = Catalog(), Projection(), []

    async def upstream(request):
        seen.append(request)
        return httpx.Response(
            200,
            content=b'event: response.completed\ndata: {"type":"response.completed"}\n\n',
            headers={"content-type": "text/event-stream"},
        )

    signals = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
    async with service.native_model_service(
        catalog.config, projection, port=0, catalog=catalog, transport=httpx.MockTransport(upstream)
    ) as runtime:
        assert runtime.origin.startswith("http://127.0.0.1:")
        assert not runtime.origin.endswith(":0")
        await wait_for(lambda: bool(runtime.entries))
        assert projection.active == {"provider_name": "admin-managed-qeetoken", "model": "gpt-test"}
        row = projection.rows[0]
        assert row["base_url"] == runtime.origin + "/model-providers/qeetoken/v1"
        assert "supplier-private-key" not in json.dumps(projection.rows)
        async with httpx.AsyncClient(base_url=runtime.origin, trust_env=False) as client:
            for route in (
                "/docs",
                "/redoc",
                "/openapi.json",
                "/api/admin/providers",
                "/api/auth/login",
                "/login",
                "/authorize",
            ):
                assert (await client.get(route)).status_code == 404
            response = await client.post(
                "/model-providers/qeetoken/v1/responses",
                json={"model": "gpt-test", "input": "hello", "stream": True},
                headers={"Authorization": "Bearer " + row["api_key"]},
            )
            assert response.status_code == 200
            assert "response.completed" in response.text
            assert (
                await client.post(
                    "/model-providers/qeetoken/v1/responses",
                    json={"model": "gpt-test", "input": "hello"},
                )
            ).status_code == 401
        assert str(seen[0].url) == "https://models.example.com/v1/responses"
        assert seen[0].headers["authorization"] == "Bearer supplier-private-key"
        assert signals == {sig: signal.getsignal(sig) for sig in signals}
        origin = runtime.origin
    assert runtime.closed and runtime.client.is_closed and catalog.closed
    assert not runtime.entries and not runtime.requests
    async with httpx.AsyncClient(trust_env=False, timeout=0.2) as client:
        with pytest.raises(httpx.ConnectError):
            await client.get(origin + "/docs")


@pytest.mark.asyncio
async def test_listener_start_does_not_wait_for_catalog_network_and_exit_cancels_poll():
    catalog, projection = Catalog(), Projection()
    catalog.refresh_gate = asyncio.Event()
    async with asyncio.timeout(2):
        async with service.native_model_service(
            catalog.config, projection, port=0, catalog=catalog
        ) as runtime:
            await catalog.refresh_started.wait()
            assert not runtime.entries
            async with httpx.AsyncClient(trust_env=False) as client:
                assert (await client.get(runtime.origin + "/docs")).status_code == 404
    assert catalog.closed and runtime.closed and runtime.client.is_closed


@pytest.mark.asyncio
async def test_projection_adapter_allows_only_runtime_operations():
    projection = Projection()
    adapter = service.NativeAdminAdapter(projection)
    body = {"name": "admin-managed-qeetoken"}
    created = await adapter._admin("POST", "/api/admin/providers", json=body)
    assert created.status_code == 201 and created.json()["name"] == body["name"]
    assert (await adapter._admin("GET", "/api/admin/providers")).json()[0]["id"] == 1
    patched = await adapter._admin("PATCH", "/api/admin/providers/1", json={"enabled": False})
    assert patched.json()["enabled"] is False
    selected = {"provider_name": body["name"], "model": "gpt-test"}
    assert (
        await adapter._admin("PUT", "/api/providers/active-model", json=selected)
    ).json() == selected
    assert (await adapter._admin("GET", "/api/providers/active-model")).json() == selected
    count = len(projection.calls)
    for method, path, kwargs in [
        ("DELETE", "/api/admin/providers/1", {}),
        ("GET", "/api/auth/login", {}),
        ("PATCH", "/api/admin/providers/../1", {"json": {}}),
        ("POST", "/api/admin/providers", {}),
        ("GET", "/api/admin/providers", {"headers": {}}),
    ]:
        with pytest.raises(ValueError, match="PROJECTION_OPERATION_DENIED"):
            await adapter._admin(method, path, **kwargs)
    await adapter.close()
    assert len(projection.calls) == count


@pytest.mark.asyncio
async def test_bind_failure_closes_catalog_without_projecting_an_unreachable_url():
    catalog, projection = Catalog(), Projection()
    with socket.socket() as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen()
        with pytest.raises(OSError):
            async with service.native_model_service(
                catalog.config, projection, port=occupied.getsockname()[1], catalog=catalog
            ):
                pytest.fail("bound a busy port")
    assert catalog.closed and not projection.calls


@pytest.mark.asyncio
async def test_listener_start_failure_closes_runtime_transport_and_catalog(monkeypatch):
    catalog, projection = Catalog(), Projection()

    class Transport(httpx.AsyncBaseTransport):
        closed = False

        async def aclose(self):
            self.closed = True

    transport = Transport()

    async def fail_start(self, sockets=None):
        raise SystemExit(1)

    monkeypatch.setattr(service.NativeServer, "serve", fail_start)
    with pytest.raises(RuntimeError, match="MODEL_PROVIDER_LISTENER_FAILED"):
        async with service.native_model_service(
            catalog.config, projection, port=0, catalog=catalog, transport=transport
        ):
            pytest.fail("started a failed listener")
    assert catalog.closed and transport.closed and not projection.calls


@pytest.mark.asyncio
@pytest.mark.parametrize("raises", [False, True])
async def test_unexpected_listener_exit_stops_projection_and_closes_runtime(
    monkeypatch, caplog, raises
):
    catalog, projection, failed = Catalog(), Projection(), asyncio.Event()
    servers = []

    async def exit_loop(self):
        servers.append(self)
        await failed.wait()
        if raises:
            raise RuntimeError("upstream-private-secret")

    monkeypatch.setattr(service.NativeServer, "main_loop", exit_loop)
    with pytest.raises(RuntimeError, match="MODEL_PROVIDER_SERVICE_STOPPED"):
        async with service.native_model_service(
            catalog.config, projection, port=0, catalog=catalog
        ) as runtime:
            await wait_for(lambda: bool(runtime.entries))
            failed.set()
            await wait_for(lambda: runtime.closed and catalog.closed)
            count = len(projection.calls)
            await asyncio.sleep(0.06)
            assert len(projection.calls) == count
            assert runtime.client.is_closed and not runtime.entries
    assert "MODEL_PROVIDER_SERVICE_STOPPED" in caplog.text
    assert "upstream-private-secret" not in caplog.text
    assert all(not listener.is_serving() for server in servers for listener in server.servers)
    assert not [task for task in asyncio.all_tasks() if task.get_name().startswith("native-model-")]


@pytest.mark.asyncio
async def test_unexpected_poll_failure_stops_listener_without_logging_sensitive_error(caplog):
    catalog, projection, failed = Catalog(), Projection(), asyncio.Event()
    list_providers = projection.list_providers

    async def list_or_fail():
        if failed.is_set():
            raise RuntimeError("provider-private-secret")
        return await list_providers()

    projection.list_providers = list_or_fail
    with pytest.raises(RuntimeError, match="MODEL_PROVIDER_SERVICE_STOPPED"):
        async with service.native_model_service(
            catalog.config, projection, port=0, catalog=catalog
        ) as runtime:
            await wait_for(lambda: bool(runtime.entries))
            failed.set()
            await wait_for(lambda: runtime.closed and catalog.closed)
            assert runtime.client.is_closed and not runtime.entries
    assert "MODEL_PROVIDER_SERVICE_STOPPED" in caplog.text
    assert "provider-private-secret" not in caplog.text
    assert not [task for task in asyncio.all_tasks() if task.get_name().startswith("native-model-")]
    async with httpx.AsyncClient(trust_env=False, timeout=0.2) as client:
        with pytest.raises(httpx.ConnectError):
            await client.get(runtime.origin + "/docs")


@pytest.mark.asyncio
async def test_exit_closes_live_upstream_stream_and_request_tasks():
    catalog, projection, reading = Catalog(), Projection(), asyncio.Event()

    class Stream(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self):
            yield b'event: response.created\ndata: {"type":"response.created"}\n\n'
            reading.set()
            await asyncio.Event().wait()

        async def aclose(self):
            self.closed = True

    upstream = Stream()

    async def respond(request):
        return httpx.Response(200, stream=upstream, headers={"content-type": "text/event-stream"})

    async with httpx.AsyncClient(trust_env=False, timeout=3) as client:
        async with service.native_model_service(
            catalog.config,
            projection,
            port=0,
            catalog=catalog,
            transport=httpx.MockTransport(respond),
        ) as runtime:
            await wait_for(lambda: bool(runtime.entries))
            request = asyncio.create_task(
                client.post(
                    runtime.origin + "/model-providers/qeetoken/v1/responses",
                    json={"model": "gpt-test", "input": "hello", "stream": True},
                    headers={"Authorization": "Bearer " + projection.rows[0]["api_key"]},
                )
            )
            await asyncio.wait_for(reading.wait(), timeout=2)
            assert runtime.requests
        response = await asyncio.wait_for(request, timeout=2)
        assert response.status_code == 200 and "response.created" in response.text
    assert upstream.closed and not runtime.requests
    assert catalog.closed and runtime.client.is_closed


@pytest.mark.asyncio
async def test_context_cancellation_closes_listener_and_owned_runtime():
    catalog, projection, started = Catalog(), Projection(), asyncio.Event()
    active = []

    async def run():
        async with service.native_model_service(
            catalog.config, projection, port=0, catalog=catalog
        ) as runtime:
            active.append(runtime)
            started.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(run())
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert catalog.closed and active[0].closed and active[0].client.is_closed
    assert not [task for task in asyncio.all_tasks() if task.get_name().startswith("native-model-")]
    async with httpx.AsyncClient(trust_env=False, timeout=0.2) as client:
        with pytest.raises(httpx.ConnectError):
            await client.get(active[0].origin + "/docs")
