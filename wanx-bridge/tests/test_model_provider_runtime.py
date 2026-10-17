import asyncio
import copy
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.model_provider_runtime import ModelProviderRuntime, PublicPinnedTransport


class Catalog:
    def __init__(self):
        self.config = SimpleNamespace(device_id="box", interval=1)
        self.value = {
            "deviceId": "box",
            "bindingId": "binding",
            "ownerAccountId": "owner",
            "ownershipEpoch": 1,
            "authVersion": 1,
            "issuedAt": "now",
            "expiresAt": "later",
            "providers": [
                {
                    "providerId": "primary",
                    "displayName": "Primary",
                    "enabled": True,
                    "configVersion": "1",
                    "protocol": "openai-compatible",
                    "baseUrl": "https://models.example.com/v1",
                    "apiKey": "supplier-secret-never-persist",
                    "allowedProducts": ["wanxiang"],
                    "allowedModels": ["chat-model"],
                }
            ],
        }
        self.error = None
        self.expired = False

    async def refresh(self):
        if self.error:
            raise BridgeAuthError(self.error, 503)
        return self.active()

    def active(self):
        if self.expired:
            raise BridgeAuthError("MODEL_PROVIDER_LEASE_EXPIRED", 503)
        return copy.deepcopy(self.value)

    async def close(self):
        self.expired = True


class Admin:
    def __init__(self):
        self.rows = []
        self.active = {"provider_name": "", "model": ""}
        self.writes = []

    async def _admin(self, method, path, **kwargs):
        body = copy.deepcopy(kwargs.get("json"))
        if method != "GET":
            self.writes.append((method, path, body))
        if path == "/api/providers/active-model":
            if method == "PUT":
                self.active = body
            value = self.active
        elif method == "GET":
            value = self.rows
        elif method == "POST":
            value = {**body, "id": len(self.rows) + 1, "enabled": True}
            self.rows.append(value)
        else:
            value = next(row for row in self.rows if str(row["id"]) == path.rsplit("/", 1)[1])
            value.update(body)
        return httpx.Response(200, json=copy.deepcopy(value))

    async def close(self):
        pass


def runtime(handler=None, **kwargs):
    catalog, admin = Catalog(), Admin()

    async def default(request):
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    result = ModelProviderRuntime(
        catalog,
        admin,
        "http://127.0.0.1:18089",
        transport=httpx.MockTransport(handler or default),
        **kwargs,
    )
    return result, catalog, admin


async def invoke(runtime, body=None, headers=None):
    app = FastAPI()
    runtime.register_routes(app)
    key = runtime.entries["primary"]["key"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://local"
    ) as client:
        return await client.post(
            "/model-providers/primary/v1/chat/completions",
            json=body or {"model": "chat-model", "messages": []},
            headers=headers or {"Authorization": "Bearer " + key},
        )


@pytest.mark.asyncio
async def test_sync_is_idempotent_and_persists_only_proxy_credential():
    rt, catalog, admin = runtime()
    try:
        await rt.reconcile()
        assert len(admin.rows) == 1
        row = admin.rows[0]
        assert row["api_key"] != catalog.value["providers"][0]["apiKey"]
        assert "supplier-secret" not in json.dumps(admin.rows)
        assert row["base_url"] == "http://127.0.0.1:18089/model-providers/primary/v1"
        assert admin.active == {"provider_name": "admin-managed-primary", "model": "chat-model"}
        writes = len(admin.writes)
        catalog.value["expiresAt"] = "renewed"
        await rt.reconcile()
        assert len(admin.writes) == writes
        previous = row["api_key"]
        catalog.value["providers"][0]["configVersion"] = "2"
        await rt.reconcile()
        assert row["api_key"] != previous
    finally:
        await rt.close()


@pytest.mark.asyncio
async def test_manual_default_and_provider_are_preserved_and_conflict_denied():
    rt, _, admin = runtime()
    admin.rows = [
        {
            "id": 40,
            "name": "manual",
            "kind": "openai",
            "base_url": "https://manual.example.com",
            "api_key": "manual-key",
            "enabled": True,
            "models": [{"id": "manual-chat"}],
        }
    ]
    admin.active = {"provider_name": "manual", "model": "manual-chat"}
    try:
        await rt.reconcile()
        assert admin.active["provider_name"] == "manual"
        assert admin.rows[0]["api_key"] == "manual-key"
        managed = admin.rows[1]
        managed["note"] = "user-created"
        before = len(admin.writes)
        with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_NAME_CONFLICT"):
            await rt.reconcile()
        assert len(admin.writes) == before
    finally:
        await rt.close()


@pytest.mark.asyncio
async def test_expiry_disables_managed_rows_but_transient_outage_keeps_valid_lease():
    rt, catalog, admin = runtime()
    try:
        await rt.reconcile()
        catalog.error = "MODEL_PROVIDER_TEMPORARILY_UNAVAILABLE"
        await rt.reconcile()
        assert admin.rows[0]["enabled"] is True
        catalog.expired = True
        await rt.reconcile()
        assert admin.rows[0]["enabled"] is False
        assert admin.rows[0]["models"] == []
        assert not rt.entries
    finally:
        await rt.close()


@pytest.mark.asyncio
async def test_model_discovery_filters_nonchat_and_preserves_metadata():
    async def handler(request):
        assert request.method == "GET" and request.url.path == "/v1/models"
        assert request.headers["authorization"] == "Bearer supplier-secret-never-persist"
        return httpx.Response(
            200,
            json={
                "data": [
                    {"id": "chat-model", "context_window": 65536, "reasoning": True},
                    {"id": "text-embedding-3"},
                    {"id": "whisper-1"},
                ]
            },
        )

    rt, catalog, admin = runtime(handler)
    catalog.value["providers"][0]["allowedModels"] = []
    try:
        await rt.reconcile()
        assert admin.rows[0]["models"] == [
            {
                "id": "chat-model",
                "name": "chat-model",
                "enabled": True,
                "context_window": 65536,
                "reasoning": True,
            }
        ]
    finally:
        await rt.close()


@pytest.mark.asyncio
async def test_proxy_preserves_tools_reasoning_and_drops_untrusted_headers():
    seen = []

    async def handler(request):
        seen.append(request)
        return httpx.Response(
            200,
            headers={"set-cookie": "secret=cookie", "x-secret": "supplier-only"},
            json={"choices": [{"message": {"content": "ok"}}]},
        )

    rt, _, _ = runtime(handler)
    try:
        await rt.reconcile()
        body = {
            "model": "chat-model",
            "messages": [{"role": "assistant", "content": "hello", "reasoning_content": "reason"}],
            "tools": [{"type": "function", "function": {"name": "tool"}}],
            "max_completion_tokens": 42,
        }
        response = await invoke(
            rt,
            body,
            {
                "Authorization": "Bearer " + rt.entries["primary"]["key"],
                "Cookie": "session=secret",
                "X-Injected": "bad",
            },
        )
        assert response.status_code == 200
        assert json.loads(seen[0].content) == body
        assert seen[0].headers["authorization"] == "Bearer supplier-secret-never-persist"
        assert "cookie" not in seen[0].headers and "x-injected" not in seen[0].headers
        assert "set-cookie" not in response.headers and "x-secret" not in response.headers
    finally:
        await rt.close()


@pytest.mark.asyncio
async def test_proxy_rejects_changed_authority_model_and_credential():
    rt, catalog, _ = runtime(authority_check=lambda snapshot: snapshot["ownerAccountId"] == "owner")
    try:
        await rt.reconcile()
        assert (await invoke(rt, headers={"Authorization": "Bearer wrong"})).status_code == 401
        assert (await invoke(rt, {"model": "unlisted", "messages": []})).status_code == 403
        catalog.value["ownerAccountId"] = "other"
        assert (await invoke(rt)).status_code == 403
        catalog.expired = True
        assert (await invoke(rt)).status_code == 503
    finally:
        await rt.close()


@pytest.mark.asyncio
async def test_upstream_raw_error_is_not_returned():
    async def handler(request):
        return httpx.Response(401, text="supplier-secret-never-persist credential rejected")

    rt, _, _ = runtime(handler)
    try:
        await rt.reconcile()
        response = await invoke(rt)
        assert response.status_code == 503
        assert "supplier-secret" not in response.text
    finally:
        await rt.close()


@pytest.mark.asyncio
async def test_guard_revokes_pending_upstream_before_response():
    cancelled = asyncio.Event()

    async def handler(request):
        try:
            await asyncio.sleep(10)
        finally:
            cancelled.set()

    rt, catalog, _ = runtime(handler)
    try:
        await rt.reconcile()
        task = asyncio.create_task(invoke(rt))
        await asyncio.sleep(0.05)
        catalog.expired = True
        response = await asyncio.wait_for(task, 1)
        assert response.status_code == 503
        assert cancelled.is_set()
        assert not rt.requests
    finally:
        await rt.close()


class DelayedStream(httpx.AsyncByteStream):
    def __init__(self, catalog):
        self.catalog, self.closed = catalog, False

    async def __aiter__(self):
        yield b'data: {"choices": []}\n\n'
        self.catalog.expired = True
        await asyncio.sleep(10)
        yield b"data: forbidden\n\n"

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
async def test_guard_stops_silent_stream_and_closes_connection():
    rt, catalog, _ = runtime()
    stream = DelayedStream(catalog)

    async def handler(request):
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=stream)

    await rt.client.aclose()
    rt.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        await rt.reconcile()
        response = await asyncio.wait_for(
            invoke(rt, {"model": "chat-model", "messages": [], "stream": True}), 1
        )
        assert response.content == b'data: {"choices": []}\n\n'
        assert stream.closed
        assert not rt.requests
    finally:
        await rt.close()


@pytest.mark.asyncio
async def test_production_transport_rejects_private_dns(monkeypatch):
    transport = PublicPinnedTransport()

    async def lookup(*args, **kwargs):
        return [(2, 1, 6, "", ("127.0.0.1", 443))]

    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", lookup)
    try:
        with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_DESTINATION_DENIED"):
            await transport.handle_async_request(
                httpx.Request("GET", "https://models.example.com/v1/models")
            )
    finally:
        await transport.aclose()


@pytest.mark.asyncio
async def test_production_transport_pins_ip_preserving_host_and_tls_name(monkeypatch):
    transport = PublicPinnedTransport()
    calls = []

    async def lookup(*args, **kwargs):
        calls.append(args)
        return [(2, 1, 6, "", ("8.8.8.8", 443))]

    async def handle(request):
        assert request.url.host == "8.8.8.8"
        assert request.headers["host"] == "models.example.com"
        assert request.extensions["sni_hostname"] == "models.example.com"
        return httpx.Response(200, json={})

    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", lookup)
    monkeypatch.setattr(transport.transport, "handle_async_request", handle)
    try:
        await transport.handle_async_request(
            httpx.Request("GET", "https://models.example.com/v1/models")
        )
        assert len(calls) == 1
    finally:
        await transport.aclose()


@pytest.mark.asyncio
async def test_wanx_inferred_metadata_does_not_trigger_repeated_reload():
    rt, _, admin = runtime()
    try:
        await rt.reconcile()
        admin.rows[0]["models"][0]["reasoning_config"] = {"supported": True}
        before = len(admin.writes)
        await rt.reconcile()
        assert len(admin.writes) == before
    finally:
        await rt.close()


@pytest.mark.asyncio
async def test_owner_change_rotates_key_and_disabled_provider_stops_calls():
    rt, catalog, admin = runtime()
    try:
        await rt.reconcile()
        previous = rt.entries["primary"]["key"]
        catalog.value["ownerAccountId"] = "new-owner"
        catalog.value["ownershipEpoch"] = 2
        await rt.reconcile()
        assert rt.entries["primary"]["key"] != previous
        response = await invoke(rt, headers={"Authorization": "Bearer " + previous})
        assert response.status_code == 401
        catalog.value["providers"][0]["enabled"] = False
        await rt.reconcile()
        assert admin.rows[0]["enabled"] is False
        assert admin.rows[0]["models"] == []
    finally:
        await rt.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy_products", [["zhijun"], [], ["wanxiang", "zhijun"]])
async def test_enabled_provider_serves_box_apps_without_product_grant(legacy_products):
    rt, catalog, admin = runtime()
    catalog.value["providers"][0]["allowedProducts"] = legacy_products
    try:
        await rt.reconcile()
        assert admin.rows[0]["enabled"] is True
        response = await invoke(rt)
        assert response.status_code == 200
    finally:
        await rt.close()


@pytest.mark.asyncio
async def test_failed_discovery_does_not_invent_model_or_persist_secret():
    async def handler(request):
        return httpx.Response(404, text="supplier-secret-never-persist")

    rt, catalog, admin = runtime(handler)
    catalog.value["providers"][0]["allowedModels"] = []
    try:
        with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_MODELS_UNAVAILABLE"):
            await rt.reconcile()
        assert admin.rows == []
        assert rt.entries == {}
    finally:
        await rt.close()


@pytest.mark.asyncio
async def test_close_cancels_pending_inference():
    started = asyncio.Event()
    stopped = asyncio.Event()

    async def handler(request):
        started.set()
        try:
            await asyncio.sleep(10)
        finally:
            stopped.set()

    rt, _, _ = runtime(handler)
    await rt.reconcile()
    task = asyncio.create_task(invoke(rt))
    await started.wait()
    await rt.close()
    await asyncio.gather(task, return_exceptions=True)
    assert stopped.is_set()
    assert rt.entries == {}
    assert not rt.requests


@pytest.mark.asyncio
async def test_discovery_failure_disables_old_provider_and_continues_other_provider():
    async def handler(request):
        return httpx.Response(503, text="supplier-secret-never-persist")

    rt, catalog, admin = runtime(handler)
    try:
        await rt.reconcile()
        first = catalog.value["providers"][0]
        first["configVersion"] = "2"
        first["allowedModels"] = []
        second = {**first, "providerId": "backup", "allowedModels": ["backup-chat"]}
        catalog.value["providers"].append(second)
        with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_MODELS_UNAVAILABLE"):
            await rt.reconcile()
        assert admin.rows[0]["enabled"] is False
        assert admin.rows[0]["models"] == []
        assert admin.rows[1]["name"] == "admin-managed-backup"
        assert admin.rows[1]["enabled"] is True
        assert admin.active == {"provider_name": "admin-managed-backup", "model": "backup-chat"}
        assert set(rt.entries) == {"backup"}
    finally:
        await rt.close()


@pytest.mark.asyncio
async def test_observed_authority_change_disables_old_catalog_without_owner_online():
    changed = False
    rt, _, admin = runtime(authority_check=lambda snapshot: not changed)
    try:
        await rt.reconcile()
        changed = True
        await rt.reconcile()
        assert admin.rows[0]["enabled"] is False
        assert admin.rows[0]["models"] == []
        assert not rt.entries
        assert rt.last_error == "MODEL_PROVIDER_AUTHORIZATION_CHANGED"
    finally:
        await rt.close()
