"""Safe native STT reuse without provider secrets or cross-app configuration access."""

from typing import Any

import pytest

from octop.infra.voice import adapters
from tests.integration.test_zhijun_profile import zhijun_auth


async def test_zhijun_stt_capability_is_sanitized_and_configuration_only(env: Any) -> None:
    client, server, _ = env
    auth = await zhijun_auth(client)
    before = server.services.agent_repo.list_all()
    response = await client.get(
        "/api/voice/stt/capability", headers={**auth, "Accept-Language": "zh"}
    )
    assert response.status_code == 200
    result = response.json()
    assert result["reason"] == "browser_only"
    assert not result["available"]
    assert result["configuration_id"] is None
    assert "浏览器" in result["message"]
    assert server.services.agent_repo.list_all() == before

    server.services.voice_provider_repo.create(
        name="合成转写服务",
        kind="openai",
        capability="stt",
        base_url="https://synthetic.example.test/v1/private-destination",
        api_key="synthetic-secret-never-returned",
    )
    server.services.settings_repo.set("active_stt_provider", "合成转写服务")
    response = await client.get("/api/voice/stt/capability", headers=auth)
    assert response.status_code == 200
    result = response.json()
    assert result["available"] and result["external_processing"]
    assert result["provider_name"] == "合成转写服务"
    assert result["provider_kind"] == "openai"
    assert len(result["configuration_id"]) == 64
    assert "synthetic-secret" not in response.text
    assert "synthetic.example" not in response.text
    assert "api_key" not in result and "extra" not in result
    for path in (
        "/api/voice/providers",
        "/api/voice/active",
        "/api/admin/voice/providers",
        "/api/voice/presets",
    ):
        assert (await client.get(path, headers=auth)).status_code == 404
    assert (
        await client.put("/api/voice/active", headers=auth, json={"stt": "browser"})
    ).status_code == 404
    assert (
        await client.post("/api/voice/tts", headers=auth, json={"text": "合成"})
    ).status_code == 404


async def test_zhijun_stt_requires_confirmation_and_only_returns_text(
    env: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, server, wanx_auth = env
    auth = await zhijun_auth(client)
    repo = server.services.voice_provider_repo
    provider_id = repo.create(
        name="voice-test", kind="openai", capability="both", api_key="fake-stt-key"
    )
    server.services.settings_repo.set("active_stt_provider", "voice-test")
    called: list[bytes] = []

    async def fake(row: Any, audio: bytes, *, mime: str, language: str) -> adapters.STTResult:
        assert row.id == provider_id and mime == "audio/wav" and language == "zh-CN"
        called.append(audio)
        return adapters.STTResult("合成语音的文字", 0.9)

    monkeypatch.setattr(adapters, "transcribe_openai", fake)
    configuration = (await client.get("/api/voice/stt/capability", headers=auth)).json()[
        "configuration_id"
    ]
    files = {"audio": ("recording.wav", b"synthetic-audio", "audio/wav")}
    response = await client.post("/api/voice/stt", headers=auth, files=files)
    assert response.status_code == 409
    assert not called
    response = await client.post(
        "/api/voice/stt",
        headers=auth,
        files=files,
        data={"provider": "voice-test", "expected_configuration_id": configuration},
    )
    assert response.status_code == 400
    assert not called
    before_threads = [
        server.services.thread_repo.list_by_agent(agent_id=row.agent_id)
        for row in server.services.agent_repo.list_all()
    ]
    response = await client.post(
        "/api/voice/stt",
        headers=auth,
        files=files,
        data={"expected_configuration_id": configuration},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"text": "合成语音的文字", "confidence": 0.9}
    assert called == [b"synthetic-audio"]
    assert [
        server.services.thread_repo.list_by_agent(agent_id=row.agent_id)
        for row in server.services.agent_repo.list_all()
    ] == before_threads
    # Existing WANX callers do not need the new confirmation form field.
    assert (await client.post("/api/voice/stt", headers=wanx_auth, files=files)).status_code == 200
    repo.update(provider_id, api_key="different-fake-account")
    response = await client.post(
        "/api/voice/stt",
        headers=auth,
        files=files,
        data={"expected_configuration_id": configuration},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "VOICE_CONFIGURATION_CHANGED"
    assert len(called) == 2


async def test_zhijun_stt_upload_limit_does_not_dispatch(
    env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, server, _ = env
    auth = await zhijun_auth(client)
    server.services.voice_provider_repo.create(
        name="voice-test", kind="openai", capability="stt", api_key="fake"
    )
    server.services.settings_repo.set("active_stt_provider", "voice-test")
    capability = (await client.get("/api/voice/stt/capability", headers=auth)).json()

    async def unexpected(*args: Any, **kwargs: Any) -> adapters.STTResult:
        raise AssertionError("oversized audio must not leave the server")

    monkeypatch.setattr(adapters, "transcribe_openai", unexpected)
    response = await client.post(
        "/api/voice/stt",
        headers=auth,
        files={"audio": ("recording.wav", b"a" * (capability["max_audio_bytes"] + 1), "audio/wav")},
        data={"expected_configuration_id": capability["configuration_id"]},
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "ATTACHMENT_TOO_LARGE"


async def test_voice_openapi_is_typed(env: Any) -> None:
    from octop.api.app import build_app

    _, server, _ = env
    schema = build_app(server).openapi()
    for path, method, model in (
        ("/api/voice/stt/capability", "get", "SttCapabilityResponse"),
        ("/api/voice/stt", "post", "SttResponse"),
    ):
        operation = schema["paths"][path][method]
        assert operation["summary"] and operation["description"]
        assert operation["responses"]["200"]["content"]["application/json"]["schema"][
            "$ref"
        ].endswith(model)
    assert schema["components"]["schemas"]["SttCapabilityResponse"]["properties"][
        "configuration_id"
    ]["description"]
