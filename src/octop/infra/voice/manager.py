"""Resolve active voice providers and dispatch STT/TTS calls."""

from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal

from octop.infra.db.repos.settings import SettingsRepo
from octop.infra.db.repos.voice_providers import VoiceProviderRepo, VoiceProviderRow
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.voice import adapters
from octop.infra.voice.presets import is_builtin_preset


@dataclass(frozen=True)
class ResolvedVoiceProvider:
    name: str
    kind: str
    row: VoiceProviderRow | None


STT_MAX_AUDIO_BYTES = 2 * 1024 * 1024
SttAvailability = Literal[
    "ready", "browser_only", "not_configured", "disabled", "unsupported", "credentials_missing"
]


@dataclass(frozen=True)
class SttCapability:
    available: bool
    reason: SttAvailability
    provider_name: str | None
    provider_kind: str | None
    configuration_id: str | None
    external_processing: bool
    max_audio_bytes: int = STT_MAX_AUDIO_BYTES


def _configuration_id(resolved: ResolvedVoiceProvider) -> str:
    """Identify the destination and STT options without exposing credentials."""
    row = resolved.row
    extra = row.get_extra() if row else {}
    snapshot = {
        "name": resolved.name,
        "kind": resolved.kind,
        "id": row.id if row else None,
        "enabled": row.enabled if row else None,
        "capability": row.capability if row else None,
        "base_url": row.base_url if row else None,
        # A service-account change also revokes confirmation. Only the final
        # SHA-256 identity leaves this module; no credential material is returned.
        "credentials": [
            row.api_key if row else None,
            extra.get("secret_id"),
            extra.get("secret_key"),
        ],
        "options": {
            key: extra.get(key)
            for key in ("model", "region", "eng_service_type", "eng_service_type_en")
        },
    }
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()


def _stt_availability(resolved: ResolvedVoiceProvider) -> SttAvailability:
    if resolved.kind == "browser":
        return "browser_only"
    if resolved.kind not in {"openai", "tencent", "mimo"}:
        return "unsupported"
    row = resolved.row
    if row is None:
        return "not_configured"
    if not row.enabled:
        return "disabled"
    if row.capability not in {"stt", "both"}:
        return "unsupported"
    if resolved.kind == "tencent":
        try:
            adapters._parse_tencent_credentials(row)
        except ValueError:
            return "credentials_missing"
    elif not row.api_key:
        return "credentials_missing"
    return "ready"


class VoiceManager:
    _KEY_STT = "active_stt_provider"
    _KEY_TTS = "active_tts_provider"
    _DEFAULT = "browser"

    def __init__(
        self, *, settings_repo: SettingsRepo, voice_provider_repo: VoiceProviderRepo
    ) -> None:
        self._settings = settings_repo
        self._repo = voice_provider_repo

    def get_active(self) -> dict[str, str]:
        stt = self._settings.get(self._KEY_STT) or self._DEFAULT
        tts = self._settings.get(self._KEY_TTS) or self._DEFAULT
        return {"stt": stt, "tts": tts}

    def set_active(self, *, stt: str | None = None, tts: str | None = None) -> dict[str, str]:
        current = self.get_active()
        if stt is not None:
            self._validate_provider_name(stt, capability="stt")
            self._settings.set(self._KEY_STT, stt)
            current = {**current, "stt": stt}
        if tts is not None:
            self._validate_provider_name(tts, capability="tts")
            self._settings.set(self._KEY_TTS, tts)
            current = {**current, "tts": tts}
        return current

    def _validate_provider_name(self, name: str, *, capability: str) -> None:
        if is_builtin_preset(name):
            if name == "edge" and capability == "stt":
                raise OctopError(
                    ErrorCode.VOICE_CAPABILITY_MISMATCH, "Edge TTS does not support STT"
                )
            if name == "browser":
                return
            return
        row = self._repo.get_by_name(name)
        if row is None:
            raise OctopError(ErrorCode.NOT_FOUND, f"voice provider {name!r} not found")
        if not row.enabled:
            raise OctopError(
                ErrorCode.VOICE_PROVIDER_DISABLED, f"voice provider {name!r} is disabled"
            )
        cap = row.capability
        if cap != "both" and cap != capability:
            raise OctopError(
                ErrorCode.VOICE_CAPABILITY_MISMATCH,
                f"provider {name!r} does not support {capability.upper()}",
            )

    def resolve(self, name: str) -> ResolvedVoiceProvider:
        if is_builtin_preset(name):
            return ResolvedVoiceProvider(name=name, kind=name, row=self._repo.get_by_name(name))
        row = self._repo.get_by_name(name)
        if row is None:
            raise OctopError(ErrorCode.NOT_FOUND, f"voice provider {name!r} not found")
        if not row.enabled:
            raise OctopError(
                ErrorCode.VOICE_PROVIDER_DISABLED, f"voice provider {name!r} is disabled"
            )
        return ResolvedVoiceProvider(name=row.name, kind=row.kind, row=row)

    def media_type(self, provider_name: str | None) -> str:
        """HTTP content type of the synthesize() stream for the given provider."""
        name = provider_name or self.get_active()["tts"]
        kind = self.resolve(name).kind
        return "audio/wav" if kind == "mimo" else "audio/mpeg"

    def stt_capability(self) -> SttCapability:
        """Sanitized configuration readiness; this does not contact the provider."""
        name = self.get_active()["stt"]
        row = self._repo.get_by_name(name)
        kind = name if is_builtin_preset(name) else (row.kind if row else None)
        if kind is None:
            return SttCapability(False, "not_configured", name, None, None, False)
        resolved = ResolvedVoiceProvider(name, kind, row)
        reason = _stt_availability(resolved)
        available = reason == "ready"
        return SttCapability(
            available,
            reason,
            name,
            kind,
            _configuration_id(resolved) if available else None,
            kind in {"openai", "tencent", "mimo"},
        )

    async def transcribe(
        self,
        audio: bytes,
        *,
        mime: str,
        language: str = "zh-CN",
        provider_name: str | None = None,
        expected_configuration_id: str | None = None,
    ) -> adapters.STTResult:
        name = provider_name or self.get_active()["stt"]
        resolved = self.resolve(name)
        # Dispatch exactly the row checked here; do not re-resolve active STT.
        if expected_configuration_id is not None and (
            _stt_availability(resolved) != "ready"
            or _configuration_id(resolved) != expected_configuration_id
        ):
            raise OctopError.localized(ErrorCode.VOICE_CONFIGURATION_CHANGED)
        kind = resolved.kind
        if kind == "browser":
            raise OctopError(
                ErrorCode.VOICE_BROWSER_ONLY,
                "STT is handled by the browser Web Speech API",
                details={"provider": name},
            )
        row = resolved.row
        if kind == "openai":
            if row is None:
                raise OctopError(ErrorCode.NOT_FOUND, "OpenAI voice provider is not configured")
            return await adapters.transcribe_openai(row, audio, mime=mime, language=language)
        if kind == "tencent":
            if row is None:
                raise OctopError(ErrorCode.NOT_FOUND, "Tencent voice provider is not configured")
            return await adapters.transcribe_tencent(row, audio, mime=mime, language=language)
        if kind == "mimo":
            if row is None:
                raise OctopError(ErrorCode.NOT_FOUND, "Mimo voice provider is not configured")
            return await adapters.transcribe_mimo(row, audio, mime=mime, language=language)
        raise OctopError(ErrorCode.VOICE_KIND_UNSUPPORTED, f"unsupported STT kind {kind!r}")

    async def synthesize(
        self,
        text: str,
        *,
        voice_id: str | None = None,
        speed: float = 1.0,
        provider_name: str | None = None,
    ) -> AsyncIterator[bytes]:
        name = provider_name or self.get_active()["tts"]
        resolved = self.resolve(name)
        kind = resolved.kind
        if kind == "browser":
            raise OctopError(
                ErrorCode.VOICE_BROWSER_ONLY,
                "TTS is handled by the browser speechSynthesis API",
                details={"provider": name},
            )
        row = resolved.row
        if kind == "edge":
            source = row or VoiceProviderRow(
                id=0,
                name="edge",
                kind="edge",
                capability="tts",
                base_url=None,
                api_key=None,
                extra_json=None,
                note=None,
                enabled=1,
                created_at=0,
                updated_at=0,
            )
            async for chunk in adapters.synthesize_edge(
                source, text, voice_id=voice_id, speed=speed
            ):
                yield chunk
            return
        if kind == "openai":
            if row is None:
                raise OctopError(ErrorCode.NOT_FOUND, "OpenAI voice provider is not configured")
            async for chunk in adapters.synthesize_openai(
                row, text, voice_id=voice_id, speed=speed
            ):
                yield chunk
            return
        if kind == "tencent":
            if row is None:
                raise OctopError(ErrorCode.NOT_FOUND, "Tencent voice provider is not configured")
            async for chunk in adapters.synthesize_tencent(
                row, text, voice_id=voice_id, speed=speed
            ):
                yield chunk
            return
        if kind == "mimo":
            if row is None:
                raise OctopError(ErrorCode.NOT_FOUND, "Mimo voice provider is not configured")
            async for chunk in adapters.synthesize_mimo(row, text, voice_id=voice_id, speed=speed):
                yield chunk
            return
        raise OctopError(ErrorCode.VOICE_KIND_UNSUPPORTED, f"unsupported TTS kind {kind!r}")

    async def test_provider(
        self, provider_id: int, *, mode: str, locale: str = "en"
    ) -> dict[str, Any]:
        row = self._repo.get(provider_id)
        if row is None:
            raise OctopError(ErrorCode.NOT_FOUND, "voice provider not found")
        if mode == "stt":
            return await adapters.test_stt(row, row.kind, locale=locale)
        return await adapters.test_tts(row, row.kind, locale=locale)

    async def test_configuration(
        self,
        *,
        name: str,
        kind: str,
        capability: str,
        base_url: str | None,
        api_key: str | None,
        extra_json: str | None,
        mode: str,
        locale: str = "en",
    ) -> dict[str, Any]:
        row = VoiceProviderRow(
            id=0,
            name=name,
            kind=kind,
            capability=capability,
            base_url=base_url,
            api_key=api_key,
            extra_json=extra_json,
            note=None,
            enabled=1,
            created_at=0,
            updated_at=0,
        )
        if mode == "stt":
            return await adapters.test_stt(row, kind, locale=locale)
        return await adapters.test_tts(row, kind, locale=locale)
