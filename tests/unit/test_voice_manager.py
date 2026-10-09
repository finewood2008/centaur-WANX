"""Unit tests for VoiceManager."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.settings import SettingsRepo
from octop.infra.db.repos.voice_providers import VoiceProviderRepo, VoiceProviderRow
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.voice import adapters
from octop.infra.voice.manager import VoiceManager


@pytest.fixture
def voice_mgr(tmp_path: Path) -> VoiceManager:
    db = SqlitePool(tmp_path / "octop.db")
    run_migrations(db)
    settings = SettingsRepo(db)
    repo = VoiceProviderRepo(db)
    return VoiceManager(settings_repo=settings, voice_provider_repo=repo)


def test_default_active_is_browser(voice_mgr: VoiceManager) -> None:
    assert voice_mgr.get_active() == {"stt": "browser", "tts": "browser"}


def test_set_active_edge_tts_only(voice_mgr: VoiceManager) -> None:
    active = voice_mgr.set_active(tts="edge")
    assert active["tts"] == "edge"
    assert active["stt"] == "browser"


def test_edge_cannot_be_stt(voice_mgr: VoiceManager) -> None:
    with pytest.raises(OctopError) as exc:
        voice_mgr.set_active(stt="edge")
    assert exc.value.code == ErrorCode.VOICE_CAPABILITY_MISMATCH


@pytest.mark.asyncio
async def test_transcribe_browser_raises_browser_only(voice_mgr: VoiceManager) -> None:
    with pytest.raises(OctopError) as exc:
        await voice_mgr.transcribe(b"audio", mime="audio/webm")
    assert exc.value.code == ErrorCode.VOICE_BROWSER_ONLY


@pytest.mark.asyncio
async def test_synthesize_browser_raises_browser_only(voice_mgr: VoiceManager) -> None:
    with pytest.raises(OctopError) as exc:
        chunks = [c async for c in voice_mgr.synthesize("hello")]
        assert not chunks
    assert exc.value.code == ErrorCode.VOICE_BROWSER_ONLY


@pytest.mark.asyncio
async def test_configuration_probe_uses_unsaved_values(
    voice_mgr: VoiceManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured_row: VoiceProviderRow | None = None
    captured_kind = ""

    async def fake_test_stt(
        row: VoiceProviderRow | None, kind: str, *, locale: str = "en"
    ) -> dict[str, object]:
        nonlocal captured_row, captured_kind
        captured_row = row
        captured_kind = kind
        return {"ok": True}

    monkeypatch.setattr(adapters, "test_stt", fake_test_stt)

    result = await voice_mgr.test_configuration(
        name="draft",
        kind="openai",
        capability="both",
        base_url="https://example.test/v1",
        api_key="sk-draft",
        extra_json='{"model":"whisper-1"}',
        mode="stt",
    )

    assert result == {"ok": True}
    assert captured_kind == "openai"
    assert captured_row is not None
    assert captured_row.name == "draft"
    assert captured_row.api_key == "sk-draft"
    assert captured_row.base_url == "https://example.test/v1"


@pytest.mark.parametrize(
    ("name", "kind", "capability", "key", "extra", "enabled", "reason"),
    [
        ("openai", "openai", "stt", "fake", None, False, "disabled"),
        ("openai", "openai", "tts", "fake", None, True, "unsupported"),
        ("openai", "openai", "both", None, None, True, "credentials_missing"),
        (
            "tencent",
            "tencent",
            "stt",
            None,
            '{"secret_id":"synthetic-id","secret_key":"synthetic-key"}',
            True,
            "ready",
        ),
        ("custom", "tencent", "stt", "sid:", None, True, "credentials_missing"),
        ("custom", "mimo", "both", "fake", None, True, "ready"),
        ("custom", "edge", "tts", None, None, True, "unsupported"),
    ],
)
def test_stt_capability_checks_builtin_rows_and_effective_credentials(
    voice_mgr: VoiceManager,
    name: str,
    kind: str,
    capability: str,
    key: str | None,
    extra: str | None,
    enabled: bool,
    reason: str,
) -> None:
    pid = voice_mgr._repo.create(
        name=name, kind=kind, capability=capability, api_key=key, extra_json=extra
    )
    voice_mgr._repo.update(pid, enabled=enabled)
    voice_mgr._settings.set("active_stt_provider", name)
    result = voice_mgr.stt_capability()
    assert result.reason == reason
    assert result.available == (reason == "ready")
    assert (result.configuration_id is not None) == result.available


@pytest.mark.asyncio
async def test_stt_dispatches_same_confirmed_provider_snapshot(
    voice_mgr: VoiceManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    voice_mgr._repo.create(name="first", kind="openai", capability="stt", api_key="synthetic-first")
    voice_mgr._repo.create(
        name="second", kind="openai", capability="stt", api_key="synthetic-second"
    )
    voice_mgr.set_active(stt="first")
    configuration = voice_mgr.stt_capability().configuration_id
    resolve = voice_mgr.resolve

    def switching(name: str) -> Any:
        row = resolve(name)
        voice_mgr.set_active(stt="second")
        return row

    async def fake(
        row: VoiceProviderRow, audio: bytes, *, mime: str, language: str
    ) -> adapters.STTResult:
        assert row.name == "first"
        return adapters.STTResult("same snapshot")

    monkeypatch.setattr(voice_mgr, "resolve", switching)
    monkeypatch.setattr(adapters, "transcribe_openai", fake)
    assert (
        await voice_mgr.transcribe(
            b"audio", mime="audio/wav", expected_configuration_id=configuration
        )
    ).text == "same snapshot"
