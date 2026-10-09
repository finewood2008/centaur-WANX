"""Versioned personal self-model API; explicit ownership, no admin impersonation."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, StrictInt

from octop.api.common.memory_client import _open_memory_for_agent
from octop.api.deps import current_user, get_server
from octop.infra.agents.self_model.service import Review, SelfModelService, VersionConflict
from octop.infra.errors import ErrorCode, OctopError

router = APIRouter(prefix="/agents/{agent_id}/memory/self-model")


class EvidenceView(BaseModel):
    event_id: str
    quote: str
    start: int
    end: int
    timestamp: str
    thread_id: str | None


class ClaimView(BaseModel):
    id: str
    version: int
    content: str
    section: str
    framing: Literal["long_term", "context_only", "aspirational"]
    conditions: str
    exceptions: str
    source_nature: str
    source_id: str
    source_ref: str | None = None
    source_snapshot: dict[str, Any] | None = None
    entity_id: str | None = None
    state: Literal["candidate", "confirmed", "rejected", "retracted", "superseded"]
    rating: int | None = None
    calibrated_version: int | None = None
    deferred: bool = False
    evidence_valid: bool = False
    needs_recalibration: bool = True
    usage: str = "unconfirmed"
    evidence: list[EvidenceView]
    created_at: str
    updated_at: str


class SettingsView(BaseModel):
    enabled: bool
    version: int
    guarded: bool


class JobView(BaseModel):
    id: str
    state: Literal["running", "completed", "failed"]
    processed: int
    added: int
    skipped: int
    error: str | None = None
    created_at: str
    updated_at: str | None = None


class ProfileMemoryView(BaseModel):
    id: str
    entity_id: str
    assertion: str
    verbatim_quote: str
    quote_event_id: str
    section: str
    kind: str | None = None
    confidence: str
    importance: str
    created_at: str
    occurred_at: str | None = None


class ProfileEntityView(BaseModel):
    id: str
    canonical_name: str
    entity_type: str
    atom_count: int


class ProfileView(BaseModel):
    groups: list[str]
    memories: list[ProfileMemoryView]
    entities: list[ProfileEntityView]
    records: list[dict[str, Any]] = Field(default_factory=list)
    coverage: dict[str, Any] = Field(default_factory=dict)
    counts: dict[str, Any] | None
    error: str | None = None


class ExtractionBody(BaseModel):
    source_ids: list[str] | None = Field(default=None, min_length=1, max_length=100)


class CorrectionView(BaseModel):
    target_id: str
    content: str
    framing: str
    conditions: str
    exceptions: str


class ReflectionView(BaseModel):
    id: str
    text: str
    message: str
    cited_ids: list[str]
    proposals: list[CorrectionView]
    created_at: str
    stale: bool
    target_id: str | None = None
    target_content: str | None = None


class SnapshotView(BaseModel):
    agent_name: str
    settings: SettingsView
    claims: list[ClaimView]
    job: JobView | None
    profile: ProfileView
    reflections: list[ReflectionView] = Field(default_factory=list)


class SettingsBody(BaseModel):
    enabled: bool
    version: int = Field(ge=0)


class CalibrationBody(BaseModel):
    version: int = Field(ge=1)
    value: StrictInt = Field(ge=0, le=4)


async def service(server: Any = Depends(get_server)) -> SelfModelService:
    cached = getattr(server, "self_model_service", None)
    if cached is None:
        cached = SelfModelService(
            server.services.repos.self_model_repo,
            server.app_runtime.agent_registry,
            lambda aid: _open_memory_for_agent(server, aid)[0],
        )
        server.self_model_service = cached
    return cached


@router.get(
    "",
    response_model=SnapshotView,
    summary="Personal self-model, calibration and extraction status",
)
def snapshot(
    agent_id: str, user: Any = Depends(current_user), svc: SelfModelService = Depends(service)
) -> dict[str, Any]:
    return svc.snapshot(agent_id, user.id)


@router.put(
    "/settings",
    response_model=SettingsView,
    summary="Explicitly enable or disable a personal self-model",
)
def settings(
    agent_id: str,
    body: SettingsBody,
    user: Any = Depends(current_user),
    svc: SelfModelService = Depends(service),
) -> dict[str, Any]:
    svc.require(agent_id, user.id)
    try:
        return svc.repo.enable(agent_id, user.id, body.enabled, body.version)
    except VersionConflict as exc:
        raise OctopError(ErrorCode.SELF_MODEL_CONFLICT, "Reload the current version") from exc


@router.get(
    "/claims/{claim_id}",
    response_model=ClaimView,
    summary="Personal understanding with original evidence",
)
def detail(
    agent_id: str,
    claim_id: str,
    user: Any = Depends(current_user),
    svc: SelfModelService = Depends(service),
) -> dict[str, Any]:
    for claim in svc.snapshot(agent_id, user.id)["claims"]:
        if claim["id"] == claim_id:
            return dict(claim)
    raise OctopError(ErrorCode.NOT_FOUND, "Claim not found")


@router.post(
    "/claims/{claim_id}/review",
    response_model=ClaimView,
    summary="Owner review of a specific claim version",
)
def review(
    agent_id: str,
    claim_id: str,
    body: Review,
    user: Any = Depends(current_user),
    svc: SelfModelService = Depends(service),
) -> dict[str, Any]:
    try:
        svc.review(agent_id, user.id, claim_id, body)
        return detail(agent_id, claim_id, user, svc)
    except VersionConflict as exc:
        raise OctopError(ErrorCode.SELF_MODEL_CONFLICT, "Reload the current version") from exc


@router.post(
    "/claims/{claim_id}/calibration",
    response_model=ClaimView,
    summary="Owner-supplied alignment; never a personality score",
)
def calibrate(
    agent_id: str,
    claim_id: str,
    body: CalibrationBody,
    user: Any = Depends(current_user),
    svc: SelfModelService = Depends(service),
) -> dict[str, Any]:
    try:
        svc.calibrate(agent_id, user.id, claim_id, body.version, body.value)
        return detail(agent_id, claim_id, user, svc)
    except VersionConflict as exc:
        raise OctopError(ErrorCode.SELF_MODEL_CONFLICT, "Reload the current version") from exc


@router.post(
    "/jobs",
    status_code=202,
    response_model=JobView,
    summary="Incrementally propose understandings from existing memories",
)
async def start(
    agent_id: str,
    body: ExtractionBody | None = None,
    user: Any = Depends(current_user),
    svc: SelfModelService = Depends(service),
) -> dict[str, Any]:
    return svc.start(agent_id, user.id, body.source_ids if body else None)


@router.get(
    "/jobs/{job_id}",
    response_model=JobView,
    summary="Extraction progress or bounded failure reason",
)
def job(
    agent_id: str,
    job_id: str,
    user: Any = Depends(current_user),
    svc: SelfModelService = Depends(service),
) -> dict[str, Any]:
    svc.require(agent_id, user.id)
    result = svc.repo.job(agent_id, user.id, job_id)
    if result is None:
        raise OctopError(ErrorCode.NOT_FOUND, "Job not found")
    return result


class ReflectionBody(BaseModel):
    message: str = Field(default="", max_length=4000)
    target_id: str | None = Field(
        default=None,
        max_length=200,
        description="Optional selected claim or source ID. Corrections are restricted to this point.",
    )
    target_version: int | None = Field(
        default=None,
        ge=0,
        description="Selected claim version; use 0 for a source record. A stale selection returns a conflict.",
    )


class ApplyCorrectionBody(BaseModel):
    index: int = Field(ge=0, le=4)


@router.post(
    "/reflection",
    response_model=ReflectionView,
    summary="AI impression or conversational correction proposal; no automatic confirmation",
)
async def reflection(
    agent_id: str,
    body: ReflectionBody,
    user: Any = Depends(current_user),
    svc: SelfModelService = Depends(service),
) -> dict[str, Any]:
    from octop.infra.agents.self_model.reflection import reflect

    try:
        return await reflect(
            svc, agent_id, user.id, body.message, body.target_id, body.target_version
        )
    except VersionConflict as exc:
        raise OctopError(
            ErrorCode.SELF_MODEL_CONFLICT, "Memory changed; regenerate the impression"
        ) from exc


@router.post(
    "/reflection/{reflection_id}/apply",
    response_model=ClaimView,
    summary="Owner accepts one source-bound correction from the dialogue",
)
def apply_reflection(
    agent_id: str,
    reflection_id: str,
    body: ApplyCorrectionBody,
    user: Any = Depends(current_user),
    svc: SelfModelService = Depends(service),
) -> dict[str, Any]:
    from octop.infra.agents.self_model.reflection import apply_correction

    try:
        result = apply_correction(svc, agent_id, user.id, reflection_id, body.index)
        return detail(agent_id, result["id"], user, svc)
    except VersionConflict as exc:
        raise OctopError(
            ErrorCode.SELF_MODEL_CONFLICT, "Memory changed; regenerate the correction"
        ) from exc
