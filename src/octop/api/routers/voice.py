"""Voice STT/TTS router."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from octop.api.common.upload_limit import read_upload_capped
from octop.api.deps import current_user, get_server, require_permission
from octop.i18n import tr
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.locale import resolve_request_locale
from octop.infra.voice.manager import STT_MAX_AUDIO_BYTES, SttAvailability, VoiceManager
from octop.infra.voice.presets import load_voice_presets

router = APIRouter()
admin_router = APIRouter()


def _voice_manager(server: Any) -> VoiceManager:
    return VoiceManager(
        settings_repo=server.services.settings_repo,
        voice_provider_repo=server.services.voice_provider_repo,
    )


def _row_to_dict(r: Any) -> dict[str, Any]:
    return {
        "id": r.id,
        "name": r.name,
        "kind": r.kind,
        "capability": r.capability,
        "base_url": r.base_url,
        "api_key": r.api_key,
        "extra": r.get_extra(),
        "note": r.note,
        "enabled": bool(r.enabled),
    }


class VoiceProviderCreateBody(BaseModel):
    name: str
    kind: str
    capability: str
    base_url: str | None = None
    api_key: str | None = None
    extra_json: str | None = None
    note: str | None = None


class VoiceProviderPatchBody(BaseModel):
    kind: str | None = None
    capability: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    extra_json: str | None = None
    note: str | None = None
    enabled: bool | None = None


class ActiveVoiceBody(BaseModel):
    stt: str | None = None
    tts: str | None = None


class TTSBody(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    voice_id: str | None = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    provider: str | None = None


class VoiceTestBody(BaseModel):
    mode: Literal["stt", "tts"] = "tts"


class VoiceConfigurationTestBody(VoiceProviderCreateBody):
    mode: Literal["stt", "tts"] = "tts"


class SttCapabilityResponse(BaseModel):
    available: bool = Field(
        description="Configuration is usable; no provider network probe is run."
    )
    reason: SttAvailability
    message: str | None = Field(
        description="Localized explanation when transcription is unavailable."
    )
    provider_name: str | None = Field(
        description="Configured transcription service display name; no credentials or endpoint."
    )
    provider_kind: str | None = Field(
        description="Native service type, for example openai, tencent, or mimo."
    )
    configuration_id: str | None = Field(
        description="Opaque destination/options identity. Zhijun must submit this after the user confirms the service; a changed configuration is rejected."
    )
    external_processing: bool = Field(
        description="The configured adapter sends audio to an external transcription service."
    )
    max_audio_bytes: int = Field(description="Maximum accepted audio upload size in bytes.")


class SttResponse(BaseModel):
    text: str = Field(
        description="Transcription only; the client places it in an editable draft without sending a chat message."
    )
    confidence: float | None = None


@router.get("/presets")
async def list_voice_presets(_: Any = Depends(current_user)) -> list[dict[str, Any]]:
    return load_voice_presets()


@router.get("/providers")
async def list_voice_providers(
    _: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> list[dict[str, Any]]:
    return [_row_to_dict(r) for r in server.services.voice_provider_repo.list_all()]


@router.get("/active")
async def get_active_voice(
    _: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, str]:
    return _voice_manager(server).get_active()


@router.put("/active")
async def set_active_voice(
    body: ActiveVoiceBody,
    _: Any = Depends(require_permission("voice")),
    server: Any = Depends(get_server),
) -> dict[str, str]:
    return _voice_manager(server).set_active(stt=body.stt, tts=body.tts)


@router.get(
    "/stt/capability",
    response_model=SttCapabilityResponse,
    summary="Read transcription availability and destination",
    description="Authenticated WANX and Zhijun accounts may read this sanitized status. It exposes no keys, endpoint URLs, or provider configuration, and does not test network connectivity. Zhijun requires explicit confirmation of the external destination before recording; browser-only STT is unavailable in Zhijun.",
)
async def get_stt_capability(
    request: Request,
    _: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> SttCapabilityResponse:
    capability = _voice_manager(server).stt_capability()
    return SttCapabilityResponse(
        available=capability.available,
        reason=capability.reason,
        message=None
        if capability.available
        else tr(f"voice.stt.{capability.reason}", resolve_request_locale(request)),
        provider_name=capability.provider_name,
        provider_kind=capability.provider_kind,
        configuration_id=capability.configuration_id,
        external_processing=capability.external_processing,
        max_audio_bytes=capability.max_audio_bytes,
    )


@router.post(
    "/stt",
    response_model=SttResponse,
    summary="Transcribe a recorded audio clip",
    description="Uses the configured native STT adapter, with a 2 MiB upload limit. Zhijun cannot override the provider and must supply the confirmed configuration_id as expected_configuration_id; a destination/options change rejects the upload before external dispatch. Audio is not written to workspace or memory; only a subsequently sent chat draft enters conversation history.",
)
async def transcribe_audio(
    audio: UploadFile = File(...),
    language: str = Form(default="zh-CN"),
    provider: str | None = Form(default=None),
    expected_configuration_id: str | None = Form(
        default=None, description="Confirmed capability configuration_id; required for Zhijun."
    ),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> SttResponse:
    if getattr(user, "application_id", "wanx") == "zhijun":
        if provider is not None:
            raise OctopError.localized(ErrorCode.SLASH_BAD_ARGS)
        if not expected_configuration_id:
            raise OctopError.localized(ErrorCode.VOICE_CONFIGURATION_CHANGED)
    data = await read_upload_capped(audio, max_bytes=STT_MAX_AUDIO_BYTES)
    if not data:
        raise OctopError(ErrorCode.SLASH_BAD_ARGS, "audio file is empty")
    mime = audio.content_type or "audio/webm"
    result = await _voice_manager(server).transcribe(
        data,
        mime=mime,
        language=language,
        provider_name=provider,
        expected_configuration_id=expected_configuration_id,
    )
    return SttResponse(text=result.text, confidence=result.confidence)


@router.post("/tts")
async def synthesize_speech(
    body: TTSBody,
    _: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> StreamingResponse:
    mgr = _voice_manager(server)

    async def _stream() -> AsyncIterator[bytes]:
        async for chunk in mgr.synthesize(
            body.text,
            voice_id=body.voice_id,
            speed=body.speed,
            provider_name=body.provider,
        ):
            yield chunk

    # Mimo streams a live WAV (24kHz PCM16LE); other providers stream MP3.
    return StreamingResponse(_stream(), media_type=mgr.media_type(body.provider))


@admin_router.get("")
async def admin_list_voice_providers(
    _: Any = Depends(require_permission("voice")),
    server: Any = Depends(get_server),
) -> list[dict[str, Any]]:
    return [_row_to_dict(r) for r in server.services.voice_provider_repo.list_all()]


@admin_router.post("", status_code=201)
async def admin_create_voice_provider(
    body: VoiceProviderCreateBody,
    _: Any = Depends(require_permission("voice")),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    repo = server.services.voice_provider_repo
    if repo.get_by_name(body.name):
        raise OctopError(
            ErrorCode.PROVIDER_NAME_TAKEN, f"voice provider {body.name!r} already exists"
        )
    pid = repo.create(
        name=body.name,
        kind=body.kind,
        capability=body.capability,
        base_url=body.base_url,
        api_key=body.api_key,
        extra_json=body.extra_json,
        note=body.note,
    )
    created = repo.get(pid)
    assert created is not None
    return _row_to_dict(created)


@admin_router.patch("/{provider_id}")
async def admin_patch_voice_provider(
    provider_id: int,
    body: VoiceProviderPatchBody,
    _: Any = Depends(require_permission("voice")),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    repo = server.services.voice_provider_repo
    row = repo.get(provider_id)
    if row is None:
        raise OctopError(ErrorCode.NOT_FOUND, "voice provider not found")
    repo.update(
        provider_id,
        kind=body.kind,
        capability=body.capability,
        base_url=body.base_url,
        api_key=body.api_key,
        extra_json=body.extra_json,
        note=body.note,
        enabled=body.enabled,
    )
    updated = repo.get(provider_id)
    assert updated is not None
    return _row_to_dict(updated)


@admin_router.delete("/{provider_id}", status_code=204)
async def admin_delete_voice_provider(
    provider_id: int,
    _: Any = Depends(require_permission("voice")),
    server: Any = Depends(get_server),
) -> None:
    repo = server.services.voice_provider_repo
    row = repo.get(provider_id)
    if row is None:
        raise OctopError(ErrorCode.NOT_FOUND, "voice provider not found")
    active = _voice_manager(server).get_active()
    if row.name in {active["stt"], active["tts"]}:
        raise OctopError(
            ErrorCode.PROVIDER_REFERENCED,
            f"voice provider {row.name!r} is currently active",
        )
    repo.delete(provider_id)


@admin_router.post("/{provider_id}/test")
async def admin_test_voice_provider(
    provider_id: int,
    body: VoiceTestBody,
    request: Request,
    _: Any = Depends(require_permission("voice")),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    return await _voice_manager(server).test_provider(
        provider_id, mode=body.mode, locale=resolve_request_locale(request)
    )


@admin_router.post("/test-configuration")
async def admin_test_voice_configuration(
    body: VoiceConfigurationTestBody,
    request: Request,
    _: Any = Depends(require_permission("voice")),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    return await _voice_manager(server).test_configuration(
        name=body.name,
        kind=body.kind,
        capability=body.capability,
        base_url=body.base_url,
        api_key=body.api_key,
        extra_json=body.extra_json,
        mode=body.mode,
        locale=resolve_request_locale(request),
    )
