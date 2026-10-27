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


async def invoke(runtime, body=None, headers=None, *, endpoint="chat/completions"):
    app = FastAPI()
    runtime.register_routes(app)
    key = runtime.entries["primary"]["key"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://local"
    ) as client:
        return await client.post(
            "/model-providers/primary/v1/" + endpoint,
            json=body if body is not None else {"model": "chat-model", "messages": []},
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


@pytest.mark.asyncio
async def test_v3_ack_only_after_install_and_failure_stops_forwarding():
    rt, catalog, admin = runtime()
    catalog.value["schemaVersion"] = 3
    acknowledgements = []

    async def applied():
        assert admin.rows and admin.rows[0]["enabled"]
        assert admin.active["model"] == "chat-model"
        assert rt.entries
        acknowledgements.append(True)
        if len(acknowledgements) == 2:
            raise BridgeAuthError("CONFIG_BINDING_CHANGED", 409)

    catalog.acknowledge_applied = applied
    catalog.clear = lambda: setattr(catalog, "expired", True)
    try:
        await rt.reconcile()
        assert acknowledgements == [True]
        with pytest.raises(BridgeAuthError):
            await rt.reconcile()
        assert not rt.entries and catalog.expired
    finally:
        await rt.close()


async def test_v3_models_are_refreshed_from_qeetoken_without_admin_policy_or_key_rotation():
    models = ["native-a"]
    requests = []

    def upstream(request):
        requests.append(request)
        assert request.url.path == "/v1/models"
        return httpx.Response(200, json={"data": [{"id": name} for name in models]})

    rt, catalog, admin = runtime(upstream)
    catalog.value["schemaVersion"] = 3
    catalog.value["providers"][0]["allowedModels"] = []

    async def applied():
        pass

    catalog.acknowledge_applied = applied
    try:
        await rt.reconcile()
        assert [m["id"] for m in admin.rows[0]["models"]] == ["native-a"]
        proxy_key = admin.rows[0]["api_key"]
        models[:] = ["native-b"]
        await rt.reconcile()
        assert [m["id"] for m in admin.rows[0]["models"]] == ["native-b"]
        assert admin.rows[0]["api_key"] == proxy_key
        assert len(requests) == 2
    finally:
        await rt.close()


@pytest.mark.asyncio
async def test_responses_preserves_function_calls_outputs_and_followup_input():
    requests = []
    outputs = [
        {
            "id": "resp_1",
            "object": "response",
            "status": "completed",
            "output": [
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "read_source",
                    "arguments": "{}",
                }
            ],
        },
        {
            "id": "resp_2",
            "object": "response",
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "done"}],
                }
            ],
        },
    ]

    async def handler(request):
        requests.append(request)
        return httpx.Response(
            200, json=outputs[len(requests) - 1], headers={"set-cookie": "upstream=secret"}
        )

    rt, _, admin = runtime(handler)
    try:
        await rt.reconcile()
        inputs = [{"role": "user", "content": [{"type": "input_text", "text": "read it"}]}]
        first = {
            "model": "chat-model",
            "input": inputs,
            "instructions": "Use the provided tools.",
            "tools": [
                {
                    "type": "function",
                    "name": "read_source",
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
            "reasoning": {"effort": "high"},
            "store": False,
            "stream": False,
        }
        second = {
            **first,
            "input": inputs
            + outputs[0]["output"]
            + [{"type": "function_call_output", "call_id": "call_1", "output": "source"}],
        }
        for body, expected in zip((first, second), outputs, strict=True):
            response = await invoke(
                rt,
                body,
                {
                    "Authorization": "Bearer " + rt.entries["primary"]["key"],
                    "Cookie": "local=secret",
                    "X-Injected": "bad",
                },
                endpoint="responses",
            )
            assert response.status_code == 200
            assert response.json() == expected
            assert "set-cookie" not in response.headers
        assert [request.url.path for request in requests] == ["/v1/responses", "/v1/responses"]
        assert [json.loads(request.content) for request in requests] == [first, second]
        assert all(
            request.headers["authorization"] == "Bearer supplier-secret-never-persist"
            for request in requests
        )
        assert all(
            "cookie" not in request.headers and "x-injected" not in request.headers
            for request in requests
        )
        # Enabling Builder Responses must not opt ordinary WANX chat into native tools.
        assert "native_tool_search" not in admin.rows[0]["models"][0]
    finally:
        await rt.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        [],
        {},
        {"model": 1, "input": []},
        {"model": "chat-model", "input": {}},
        {"model": "chat-model", "input": [], "stream": "true"},
    ],
)
async def test_responses_rejects_invalid_envelopes_without_calling_upstream(body):
    async def handler(request):
        pytest.fail("invalid Responses request reached upstream")

    rt, _, _ = runtime(handler)
    try:
        await rt.reconcile()
        response = await invoke(rt, body, endpoint="responses")
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "MODEL_PROVIDER_REQUEST_INVALID"
    finally:
        await rt.close()


@pytest.mark.asyncio
async def test_responses_reuses_credential_model_lease_and_owner_checks():
    async def handler(request):
        pytest.fail("unauthorized Responses request reached upstream")

    rt, catalog, _ = runtime(
        handler, authority_check=lambda snapshot: snapshot["ownerAccountId"] == "owner"
    )
    body = {"model": "chat-model", "input": "hello"}
    try:
        await rt.reconcile()
        assert (
            await invoke(rt, body, {"Authorization": "Bearer wrong"}, endpoint="responses")
        ).status_code == 401
        assert (
            await invoke(rt, {**body, "model": "unlisted"}, endpoint="responses")
        ).status_code == 403
        catalog.value["providers"][0]["enabled"] = False
        assert (await invoke(rt, body, endpoint="responses")).status_code == 403
        catalog.value["providers"][0]["enabled"] = True
        catalog.value["ownerAccountId"] = "other"
        assert (await invoke(rt, body, endpoint="responses")).status_code == 403
        catalog.expired = True
        assert (await invoke(rt, body, endpoint="responses")).status_code == 503
    finally:
        await rt.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 429, 500])
async def test_responses_upstream_errors_do_not_expose_supplier_credentials(status):
    async def handler(request):
        return httpx.Response(status, text="supplier-secret-never-persist credential rejected")

    rt, _, _ = runtime(handler)
    try:
        await rt.reconcile()
        response = await invoke(rt, {"model": "chat-model", "input": []}, endpoint="responses")
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "MODEL_PROVIDER_UPSTREAM_FAILED"
        assert "supplier-secret" not in response.text
    finally:
        await rt.close()


class ResponseEventStream(httpx.AsyncByteStream):
    first = b'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n'
    last = b'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n'

    def __init__(self):
        self.release = asyncio.Event()
        self.closed = False

    async def __aiter__(self):
        yield self.first
        await self.release.wait()
        yield self.last

    async def aclose(self):
        self.closed = True


def start_responses_stream(runtime, *, on_body=None):
    """Exercise ASGI delivery directly; httpx.ASGITransport buffers the stream."""
    app = FastAPI()
    runtime.register_routes(app)
    messages, first_delivered = [], asyncio.Event()
    raw = json.dumps({"model": "chat-model", "input": "hello", "stream": True}).encode()
    incoming = asyncio.Queue()
    incoming.put_nowait({"type": "http.request", "body": raw, "more_body": False})

    async def send(message):
        messages.append(message)
        if message["type"] == "http.response.body" and message.get("body"):
            first_delivered.set()
            if on_body is not None:
                on_body(message["body"])

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/model-providers/primary/v1/responses",
        "query_string": b"",
        "headers": [
            (b"authorization", ("Bearer " + runtime.entries["primary"]["key"]).encode()),
            (b"content-type", b"application/json"),
        ],
    }
    return asyncio.create_task(app(scope, incoming.get, send)), messages, first_delivered


@pytest.mark.asyncio
@pytest.mark.parametrize("finish", ["complete", "expired", "disabled", "owner", "rotate", "cancel"])
async def test_responses_sse_is_incremental_and_stops_on_revocation_or_cancel(finish):
    stream = ResponseEventStream()

    async def handler(request):
        assert request.url.path == "/v1/responses"
        assert request.headers["accept"] == "text/event-stream"
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=stream)

    rt, catalog, _ = runtime(handler)
    task = None
    try:
        await rt.reconcile()
        task, messages, delivered = start_responses_stream(rt)
        await asyncio.wait_for(delivered.wait(), 1)
        assert messages[0]["status"] == 200
        # The first event reaches the caller while the upstream remains open.
        assert not task.done() and not stream.closed
        chunks = [m["body"] for m in messages if m["type"] == "http.response.body"]
        assert b"".join(chunks) == stream.first
        if finish == "complete":
            stream.release.set()
        elif finish == "expired":
            catalog.expired = True
        elif finish == "disabled":
            catalog.value["providers"][0]["enabled"] = False
        elif finish == "owner":
            catalog.value["ownershipEpoch"] += 1
        elif finish == "rotate":
            catalog.value["providers"][0]["apiKey"] = "rotated-supplier-secret"
        else:
            task.cancel()
        result = await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 1)
        if finish == "cancel":
            assert isinstance(result[0], asyncio.CancelledError)
        else:
            assert result == [None]
        data = b"".join(m.get("body", b"") for m in messages)
        assert data == stream.first + (stream.last if finish == "complete" else b"")
        assert stream.closed and not rt.requests
    finally:
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await rt.close()


class RediscoveryResponseStream(ResponseEventStream):
    middle = b'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n'

    def __init__(self):
        super().__init__()
        self.continue_stream = asyncio.Event()

    async def __aiter__(self):
        yield self.first
        await self.continue_stream.wait()
        yield self.middle
        await self.release.wait()
        yield self.last


@pytest.mark.asyncio
async def test_v3_model_rediscovery_preserves_active_response_with_unchanged_authority():
    discovery_started, allow_discovery, checked_during_discovery = (
        asyncio.Event(),
        asyncio.Event(),
        asyncio.Event(),
    )
    middle_delivered = asyncio.Event()
    model_requests = 0
    stream = RediscoveryResponseStream()

    async def upstream(request):
        nonlocal model_requests
        if request.url.path == "/v1/models":
            model_requests += 1
            if model_requests > 1:
                discovery_started.set()
                await allow_discovery.wait()
            return httpx.Response(200, json={"data": [{"id": "chat-model"}]})
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=stream)

    def authority(snapshot):
        if discovery_started.is_set():
            checked_during_discovery.set()
        return True

    async def applied():
        pass

    rt, catalog, _ = runtime(upstream, authority_check=authority)
    catalog.value["schemaVersion"] = 3
    catalog.value["providers"][0]["allowedModels"] = []
    catalog.acknowledge_applied = applied
    tasks = []
    try:
        await rt.reconcile()
        previous_key = rt.entries["primary"]["key"]
        response, messages, delivered = start_responses_stream(
            rt, on_body=lambda chunk: middle_delivered.set() if chunk == stream.middle else None
        )
        tasks.append(response)
        await asyncio.wait_for(delivered.wait(), 1)
        refresh = asyncio.create_task(rt.reconcile())
        tasks.append(refresh)
        await asyncio.wait_for(discovery_started.wait(), 1)
        # Let the real periodic stream guard check the catalog while /models is blocked.
        await asyncio.wait_for(checked_during_discovery.wait(), 1)
        stream.continue_stream.set()
        middle = asyncio.create_task(middle_delivered.wait())
        tasks.append(middle)
        await asyncio.wait_for(
            asyncio.wait({middle, response}, return_when=asyncio.FIRST_COMPLETED), 1
        )
        assert middle_delivered.is_set(), "unchanged V3 discovery revoked the active response"
        assert not response.done() and not refresh.done()
        allow_discovery.set()
        await asyncio.wait_for(refresh, 1)
        assert rt.entries["primary"]["key"] == previous_key
        stream.release.set()
        await asyncio.wait_for(response, 1)
        assert (
            b"".join(message.get("body", b"") for message in messages)
            == stream.first + stream.middle + stream.last
        )
        assert stream.closed and not rt.requests
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await rt.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["failure", "removed", "key", "ownership"])
async def test_v3_model_rediscovery_still_revokes_invalid_active_response(change):
    discovery_started, allow_discovery = asyncio.Event(), asyncio.Event()
    row_update_started, allow_row_update = asyncio.Event(), asyncio.Event()
    model_requests = 0
    stream = ResponseEventStream()

    async def upstream(request):
        nonlocal model_requests
        if request.url.path == "/v1/models":
            model_requests += 1
            if model_requests > 1:
                discovery_started.set()
                await allow_discovery.wait()
                if change == "failure":
                    return httpx.Response(503, text="supplier-secret-never-persist")
                if change == "removed":
                    return httpx.Response(200, json={"data": [{"id": "replacement-model"}]})
            return httpx.Response(200, json={"data": [{"id": "chat-model"}]})
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=stream)

    async def applied():
        pass

    rt, catalog, admin = runtime(upstream)
    original_admin = admin._admin

    async def update_row(method, path, **kwargs):
        if change == "removed" and method == "PATCH" and "models" in kwargs.get("json", {}):
            row_update_started.set()
            await allow_row_update.wait()
        return await original_admin(method, path, **kwargs)

    admin._admin = update_row
    catalog.value["schemaVersion"] = 3
    catalog.value["providers"][0]["allowedModels"] = []
    catalog.acknowledge_applied = applied
    tasks = []
    try:
        await rt.reconcile()
        previous_key = rt.entries["primary"]["key"]
        response, messages, delivered = start_responses_stream(rt)
        tasks.append(response)
        await asyncio.wait_for(delivered.wait(), 1)
        if change == "key":
            catalog.value["providers"][0]["apiKey"] = "rotated-supplier-secret"
        elif change == "ownership":
            catalog.value["ownershipEpoch"] += 1
        refresh = asyncio.create_task(rt.reconcile())
        tasks.append(refresh)
        await asyncio.wait_for(discovery_started.wait(), 1)
        if change in {"key", "ownership"}:
            # True authorization changes revoke before slow discovery returns.
            await asyncio.wait_for(response, 1)
            assert not refresh.done() and "primary" not in rt.entries
        allow_discovery.set()
        if change == "failure":
            with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_MODELS_UNAVAILABLE"):
                await asyncio.wait_for(refresh, 1)
            assert "primary" not in rt.entries
            assert not admin.rows[0]["enabled"] and admin.rows[0]["models"] == []
        else:
            if change == "removed":
                await asyncio.wait_for(row_update_started.wait(), 1)
                await asyncio.wait_for(response, 1)
                assert not refresh.done()
                allow_row_update.set()
            await asyncio.wait_for(refresh, 1)
            if change == "removed":
                assert rt.entries["primary"]["key"] == previous_key
                assert [model["id"] for model in rt.entries["primary"]["models"]] == [
                    "replacement-model"
                ]
            else:
                assert rt.entries["primary"]["key"] != previous_key
        await asyncio.wait_for(response, 1)
        assert b"".join(message.get("body", b"") for message in messages) == stream.first
        assert stream.closed and not rt.requests
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await rt.close()
