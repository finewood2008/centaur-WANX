"""Private callback contract; no real Semantica, Octop or model inference."""

import asyncio
import base64
import hashlib
import hmac
import json
import sqlite3
import time
import uuid
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from test_semantica_desktop_contract import CONFIG, claims

from wanx_bridge.semantica.model_relay import ModelRelay

PATH = "/internal/starklink/models"
OWNER = json.dumps([CONFIG["box_id"], CONFIG["application_id"], "wanx:7"])
SCHEMA = {"type": "object", "properties": {"ok": {"const": True}}, "required": ["ok"]}


def signed(body, *, stamp=None, nonce=None):
    raw = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    stamp = str(int(time.time())) if stamp is None else stamp
    nonce = uuid.uuid4().hex if nonce is None else nonce
    signature = hmac.new(
        CONFIG["service_token"].encode(),
        stamp.encode() + b"." + nonce.encode() + b"." + raw,
        hashlib.sha256,
    ).hexdigest()
    return {
        "content": raw,
        "headers": {
            "content-type": "application/json",
            "x-starklink-time": stamp,
            "x-starklink-nonce": nonce,
            "x-starklink-signature": signature,
        },
    }


@pytest.fixture
async def relay(tmp_path):
    config = tmp_path / "semantica.json"
    config.write_text(json.dumps(CONFIG), encoding="utf8")
    state = SimpleNamespace(
        user={"id": 7, "role": "user", "permissions": ["knowledge_bases"]},
        provider={
            "id": "local",
            "name": "Test",
            "kind": "openai",
            "enabled": True,
            "base_url": "http://model/v1",
            "api_key": "synthetic-provider-key",
        },
        model={"provider_id": "local", "model": "test-model", "input": ["text"]},
        authorized={"authorized": True},
        authorize_status=200,
        calls=[],
        handler=None,
        output={
            "choices": [{"message": {"content": '{"ok":true}'}}],
            "usage": {"prompt_tokens": 9, "completion_tokens": 4, "total_tokens": 13},
        },
    )

    class Admin:
        async def _admin(self, method, path):
            assert method == "GET"
            data = {
                "/api/users": [state.user],
                "/api/admin/providers": [state.provider],
                "/api/providers/resolved": [state.model],
            }
            return httpx.Response(200, json=data[path])

    async def handle(request):
        state.calls.append(request)
        assert "cookie" not in request.headers
        if request.url.host == "semantica":
            assert request.url.path == "/api/integration/processing/authorize"
            if "x-semantica-signature" in request.headers:
                assert request.headers["authorization"] == "Bearer " + CONFIG["service_token"]
                assert claims(request)["actor_id"] == "wanx:7"
            else:
                assert "authorization" not in request.headers
                encoded = request.headers["x-semantica-scope"]
                assert (
                    json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))[
                        "actor_id"
                    ]
                    == "wanx:7"
                )
            return httpx.Response(
                state.authorize_status,
                json=state.authorized,
                headers={"set-cookie": "service=private"},
            )
        assert request.url.host == "model"
        assert request.headers["authorization"] == "Bearer synthetic-provider-key"
        assert "x-semantica-scope" not in request.headers
        if state.handler:
            return await state.handler(request)
        return httpx.Response(200, json=state.output, headers={"set-cookie": "model=private"})

    callback = ModelRelay(Admin(), config, tmp_path, transport=httpx.MockTransport(handle))
    app = FastAPI()
    callback.register(app)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://private"
    ) as client:
        state.callback, state.client, state.app = callback, client, app
        yield state
    await callback.close()


async def selection(relay):
    response = await relay.client.post(PATH, **signed({"action": "catalog", "owner": OWNER}))
    assert response.status_code == 200, response.text
    return response.json()["items"][0]


async def call(relay, action="infer", **fields):
    body = {
        "action": action,
        "owner": OWNER,
        "selection": await selection(relay),
        "job_id": "job-1",
        "purpose": "extraction",
        "text": "synthetic text",
        "schema": SCHEMA,
    }
    return await relay.client.post(PATH, **signed({**body, **fields}))


def usage_rows(relay):
    with sqlite3.connect(relay.callback.ledger.path) as db:
        return [json.loads(row[0]) for row in db.execute("SELECT payload FROM usage")]


async def test_catalog_redacts_credentials_and_marks_unsupported(relay):
    item = await selection(relay)
    assert item["id"] == "local:test-model" and item["available"] is True
    assert "synthetic-provider-key" not in json.dumps(item)
    assert "http://model" not in json.dumps(item)
    assert relay.calls == []
    relay.provider["kind"] = "anthropic"
    item = await selection(relay)
    assert item["available"] is False and item["capabilities"] == []


async def test_unsigned_standalone_callback_without_shared_configuration(relay, tmp_path):
    (tmp_path / "semantica.json").unlink()
    relay.callback.box_id = CONFIG["box_id"]
    relay.callback.service_url = CONFIG["service_url"]

    async def unsigned(body):
        request = signed(body)
        del request["headers"]["x-starklink-signature"]
        return await relay.client.post(PATH, **request)

    result = await unsigned({"action": "catalog", "owner": OWNER})
    assert result.status_code == 200, result.text
    selected = result.json()["items"][0]
    result = await unsigned(
        {
            "action": "infer",
            "owner": OWNER,
            "selection": selected,
            "job_id": "job-1",
            "purpose": "extraction",
            "text": "synthetic",
            "schema": SCHEMA,
        }
    )
    assert result.status_code == 200, result.text
    assert len([r for r in relay.calls if r.url.host == "semantica"]) >= 2
    relay.user["permissions"] = []
    result = await unsigned({"action": "catalog", "owner": OWNER})
    assert result.status_code == 403


@pytest.mark.parametrize("client", [("198.51.100.1", 1000), ("::ffff:198.51.100.1", 1000), None])
async def test_unsigned_callback_rejects_non_loopback_even_with_forwarded_headers(relay, client):
    request = signed({"action": "catalog", "owner": OWNER})
    del request["headers"]["x-starklink-signature"]
    request["headers"]["x-forwarded-for"] = "127.0.0.1"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=relay.app, client=client), base_url="http://private"
    ) as remote:
        response = await remote.post(PATH, **request)
    assert response.status_code == 403
    assert relay.calls == []


@pytest.mark.parametrize(
    "override",
    [
        {"x-starklink-signature": "bad"},
        {"x-starklink-time": "1"},
        {"x-starklink-nonce": "bad"},
        {"origin": "https://caller"},
    ],
)
async def test_bad_signatures_and_browser_requests_rejected(relay, override):
    request = signed({"action": "catalog", "owner": OWNER})
    request["headers"].update(override)
    response = await relay.client.post(PATH, **request)
    assert response.status_code == 403
    assert relay.calls == []


async def test_stale_signature_and_restart_replay(relay, tmp_path):
    body = {"action": "catalog", "owner": OWNER}
    response = await relay.client.post(PATH, **signed(body, stamp=str(int(time.time()) - 61)))
    assert response.status_code == 403
    request = signed(body)
    assert (await relay.client.post(PATH, **request)).status_code == 200
    second = ModelRelay(relay.callback.admin, tmp_path / "semantica.json", tmp_path)
    app = FastAPI()
    second.register(app)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://private"
        ) as client:
            replay = await client.post(PATH, **request)
        assert replay.status_code == 409 and replay.json()["code"] == "MODEL_REPLAY_DENIED"
    finally:
        await second.close()


@pytest.mark.parametrize(
    "owner",
    [
        json.dumps(["other-box", CONFIG["application_id"], "wanx:7"]),
        json.dumps([CONFIG["box_id"], "other-app", "wanx:7"]),
        json.dumps([CONFIG["box_id"], CONFIG["application_id"], "wanx:8"]),
        json.dumps([CONFIG["box_id"], CONFIG["application_id"], "zhijun:7"]),
    ],
)
async def test_owner_must_belong_to_connected_identity(relay, owner):
    response = await relay.client.post(PATH, **signed({"action": "catalog", "owner": owner}))
    assert response.status_code == 403


@pytest.mark.parametrize("change", [{"disabled": True}, {"permissions": []}])
async def test_permissions_are_current(relay, change):
    relay.user.update(change)
    response = await relay.client.post(PATH, **signed({"action": "catalog", "owner": OWNER}))
    assert response.status_code == 403


async def test_changed_revision_denied_before_inference(relay):
    item = await selection(relay)
    relay.provider["base_url"] = "http://different/v1"
    response = await relay.client.post(
        PATH, **signed({"action": "check", "owner": OWNER, "selection": item})
    )
    assert response.status_code == 409
    assert response.json()["code"] == "MODEL_CONFIG_CHANGED"
    assert relay.calls == []


async def test_check_uses_synthetic_prompt_and_records_counters_only(relay):
    relay.output["usage"]["prompt"] = "must not be recorded"
    response = await call(relay, "check", text="must not be sent", schema={"type": "string"})
    assert response.status_code == 200, response.text
    assert json.loads(response.json()["text"]) == {"ok": True}
    assert len(relay.calls) == 1
    assert "must not be sent" not in relay.calls[0].content.decode()
    assert "不含用户资料" in relay.calls[0].content.decode()
    rows = usage_rows(relay)
    assert rows[0]["usage"]["total_tokens"] == 13
    assert rows[0]["purpose"] == "check" and rows[0]["job_id"] is None
    assert "must not be recorded" not in json.dumps(rows)
    assert "set-cookie" not in response.headers


async def test_infer_requires_matching_job_and_selection(relay):
    response = await call(relay)
    assert response.status_code == 200, response.text
    authorize = [r for r in relay.calls if r.url.host == "semantica"]
    assert len(authorize) >= 2
    sent = json.loads(authorize[0].content)
    assert sent["job_id"] == "job-1" and sent["purpose"] == "extraction"
    assert sent["model_id"] == "local:test-model"
    assert len(sent["model_revision"]) == 64
    assert usage_rows(relay)[0]["job_id"] == "job-1"
    assert relay.callback.pending == 0 and relay.callback.users == {}


@pytest.mark.parametrize("authorized", [{}, {"authorized": False}, {"authorized": "true"}])
async def test_job_requires_explicit_positive_authorization(relay, authorized):
    relay.authorized = authorized
    response = await call(relay)
    assert response.status_code == 403
    assert response.json()["code"] == "MODEL_TASK_REVOKED"
    assert all(r.url.host == "semantica" for r in relay.calls)


@pytest.mark.parametrize("content", [None, "[]", '{"ok":false}', "not json", '{"ok":NaN}'])
async def test_invalid_model_output_is_bounded_error_and_usage_recorded(relay, content):
    relay.output["choices"][0]["message"]["content"] = content
    response = await call(relay, "check")
    assert response.status_code == 502
    assert response.json()["code"] == "MODEL_INVALID_OUTPUT"
    assert len(usage_rows(relay)) == 1


@pytest.mark.parametrize("schema", [{"$ref": "https://never-fetch/schema"}, {"type": 3}])
async def test_invalid_and_remote_schemas_never_call_model(relay, schema):
    response = await call(relay, schema=schema)
    assert response.status_code == 422
    assert all(r.url.host == "semantica" for r in relay.calls)


async def test_ollama_protocol(relay):
    relay.provider.update(kind="ollama", base_url="http://model")
    relay.output = {"message": {"content": '{"ok":true}'}, "prompt_eval_count": 9, "eval_count": 4}
    response = await call(relay, "check")
    assert response.status_code == 200
    request = relay.calls[0]
    assert request.url.path == "/api/chat"
    assert json.loads(request.content)["format"]["type"] == "object"
    assert usage_rows(relay)[0]["usage"] == {"prompt_eval_count": 9, "eval_count": 4}


@pytest.mark.parametrize("revoke", ["user", "job", "model"])
async def test_long_request_cancelled_on_revocation(relay, revoke):
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def wait(request):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    relay.handler = wait
    task = asyncio.create_task(call(relay))
    try:
        await asyncio.wait_for(started.wait(), 2)
        if revoke == "user":
            relay.user["disabled"] = True
        elif revoke == "job":
            relay.authorized = {"authorized": False}
        else:
            relay.provider["enabled"] = False
        response = await asyncio.wait_for(task, 3)
        assert response.status_code in {403, 409}
        assert cancelled.is_set()
        assert relay.callback.pending == 0 and relay.callback.users == {}
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_private_callback_excluded_from_docs(relay):
    assert PATH not in relay.app.openapi()["paths"]
