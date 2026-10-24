import hashlib
import hmac
import json
import time
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from octop.infra.semantica import models
from octop.infra.semantica.client import SemanticaError


@pytest.fixture
def fixture(tmp_path):
    config = {
        "service_token": "s" * 48,
        "box_id": "box",
        "application_id": "app",
        "service_url": "http://127.0.0.1:8090",
    }
    (tmp_path / "semantica.json").write_text(json.dumps(config))
    row = SimpleNamespace(
        id=1,
        name="fixture",
        kind="openai",
        base_url="http://127.0.0.1:11434/v1",
        api_key="fixture-key",
        extra_json=None,
        enabled=True,
        get_models=lambda: [{"id": "fixture-model", "enabled": True}],
    )
    services = SimpleNamespace(
        paths=SimpleNamespace(root=tmp_path),
        provider_repo=SimpleNamespace(list_all=lambda: [row]),
        user_repo=SimpleNamespace(
            get=lambda _: SimpleNamespace(
                username="fixture", disabled=False, role="admin", permissions=[]
            )
        ),
        audit_repo=SimpleNamespace(write=Mock()),
    )

    def signed(action="catalog", **extra):
        raw = json.dumps(
            {"action": action, "owner": json.dumps(["box", "app", "wanx:1"]), **extra}
        ).encode()
        stamp = str(int(time.time()))
        nonce = uuid.uuid4().hex
        signature = hmac.new(
            config["service_token"].encode(),
            stamp.encode() + b"." + nonce.encode() + b"." + raw,
            hashlib.sha256,
        ).hexdigest()
        return raw, {
            "x-starklink-time": stamp,
            "x-starklink-nonce": nonce,
            "x-starklink-signature": signature,
        }

    return services, row, signed


@pytest.mark.asyncio
async def test_catalog_no_keys_and_replay_denied(fixture):
    services, row, signed = fixture
    raw, headers = signed()
    result = await models.internal(raw, headers, services, AsyncMock(return_value=False))
    assert result["items"][0]["location"] == "local"
    assert row.api_key not in json.dumps(result)
    with pytest.raises(SemanticaError, match="MODEL_REPLAY_DENIED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))


@pytest.mark.asyncio
async def test_revision_change_prevents_inference(fixture, monkeypatch):
    services, row, signed = fixture
    selected = models._catalog(services)[0][0]
    row.base_url = "https://changed.example/v1"
    generate = AsyncMock()
    monkeypatch.setattr(models, "_generate", generate)
    raw, headers = signed("check", selection=selected)
    with pytest.raises(SemanticaError, match="MODEL_CONFIG_CHANGED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))
    generate.assert_not_called()


@pytest.mark.asyncio
async def test_disabled_user_and_bad_signature(fixture):
    services, row, signed = fixture
    raw, headers = signed()
    headers["x-starklink-signature"] = "0" * 64
    with pytest.raises(SemanticaError, match="MODEL_AUTH_REQUIRED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))
    services.user_repo.get = lambda _: None
    raw, headers = signed()
    with pytest.raises(SemanticaError, match="MODEL_AUTH_REQUIRED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))


@pytest.mark.asyncio
async def test_team_callback_requires_a_real_wanx_administrator(fixture):
    services, _, signed = fixture
    owner = json.dumps(["box", "app", "team:wanx"])
    raw, headers = signed(owner=owner, actor_id="wanx:1")
    assert (await models.internal(raw, headers, services, AsyncMock(return_value=False)))["items"]
    for actor in ("", "access-key:key-1", "semantica:1"):
        raw, headers = signed(owner=owner, actor_id=actor)
        with pytest.raises(SemanticaError, match="MODEL_AUTH_REQUIRED"):
            await models.internal(raw, headers, services, AsyncMock(return_value=False))
    services.user_repo.get = lambda _: SimpleNamespace(
        username="member", disabled=False, role="user", permissions=["knowledge_bases"]
    )
    raw, headers = signed(owner=owner, actor_id="wanx:1")
    with pytest.raises(SemanticaError, match="MODEL_AUTH_REQUIRED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "grants", [[{}], [{"authorized": False}], [{"authorized": True}, {"authorized": False}]]
)
async def test_team_inference_stops_when_task_authorization_is_denied(fixture, monkeypatch, grants):
    services, _, signed = fixture
    selected = models._catalog(services)[0][0]
    authorize = AsyncMock(side_effect=grants)
    generate = AsyncMock(return_value={"text": "{}", "usage": None})
    monkeypatch.setattr(models.SemanticaClient, "request", authorize)
    monkeypatch.setattr(models, "_generate", generate)
    raw, headers = signed(
        "infer",
        owner=json.dumps(["box", "app", "team:wanx"]),
        actor_id="wanx:1",
        selection=selected,
        job_id="team-job",
        purpose="extraction",
        text="synthetic",
        schema={},
    )
    with pytest.raises(SemanticaError, match="MODEL_TASK_REVOKED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))
    generate.assert_not_called()
    assert authorize.await_count == len(grants)


@pytest.mark.asyncio
async def test_check_only_synthetic_text_and_unknown_usage_preserved(fixture, monkeypatch):
    services, row, signed = fixture
    selected = models._catalog(services)[0][0]

    async def generate(row, selection, text, schema, record):
        assert "合成" in text and "private text" not in text
        await record(None)
        return {"text": '{"ok":true}', "usage": None}

    monkeypatch.setattr(models, "_generate", generate)
    raw, headers = signed("check", selection=selected, text="private text")
    result = await models.internal(raw, headers, services, AsyncMock(return_value=False))
    assert result["usage"] is None
    payload = json.loads(services.audit_repo.write.call_args.kwargs["payload"])
    assert payload["accounting"] == "not_returned" and payload["usage"] is None
    assert "private text" not in json.dumps(payload)


@pytest.mark.parametrize(
    "address,local",
    [
        ("http://localhost:11434/v1", True),
        ("http://127.0.0.1:11434/v1", True),
        ("http://192.168.1.2/v1", False),
        ("https://api.example/v1", False),
    ],
)
def test_location_uses_endpoint_not_model_name(address, local):
    assert models._local(address) == local
