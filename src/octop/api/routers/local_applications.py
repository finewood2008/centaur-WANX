"""Native local-identity application resource preparation."""

from __future__ import annotations

from typing import Any, Literal

from centuarai_local_data_gate import get_context
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from octop.api.deps import current_user, get_server
from octop.infra.applications.local_catalog import LocalResourceCatalog
from octop.infra.applications.local_contract import LocalResourceError
from octop.infra.applications.local_resources import LocalApplicationResources

router = APIRouter(prefix="/api/platform/applications", tags=["applications"])


class PreparationBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schemaVersion: Literal[1]
    applicationId: str = Field(min_length=2, max_length=64)
    artifactId: str = Field(pattern=r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")


class CandidatePreparationBody(PreparationBody):
    schemaVersion: Literal[2]  # type: ignore[assignment]
    operationId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")


class ReadinessBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schemaVersion: Literal[1, 2]
    applicationId: str = Field(min_length=2, max_length=64)
    artifactId: str = Field(pattern=r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
    compatibility: dict[str, Any] = Field(
        description="Must exactly match the independently verified installed descriptor"
    )
    bindingSetId: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class PreparationResult(BaseModel):
    schemaVersion: Literal[1, 2]
    applicationId: str
    artifactId: str
    deviceId: str
    backendProductId: str
    productId: str
    status: Literal["ready"]
    observedAt: str
    readOnly: bool
    authorization: dict[str, str]
    contracts: list[dict[str, Any]]
    resources: list[dict[str, Any]]
    bindings: list[dict[str, Any]]
    bindingScope: dict[str, Any]
    bindingSetId: str
    operationId: str
    checks: list[dict[str, Any]]


async def _handle(operation: str, body: BaseModel, request: Request, user: Any, server: Any) -> Any:
    context = get_context(request.scope)
    if context is None or not getattr(user, "local_data", False) or user.is_admin:
        return JSONResponse({"code": "LOCAL_DATA_REQUIRED"}, status_code=403)
    if server.app_runtime is None:
        return JSONResponse({"code": "RESOURCE_PREPARATION_UNAVAILABLE"}, status_code=503)
    resources = LocalApplicationResources(
        services=server.services,
        registry=server.app_runtime.agent_registry,
        catalog=LocalResourceCatalog.from_environment(),
    )
    try:
        return await resources.handle(
            operation, body.model_dump(exclude_none=True), user=user, context=context
        )
    except LocalResourceError as exc:
        return JSONResponse({"code": exc.code}, status_code=exc.status)


@router.post(
    "/prepare",
    response_model=PreparationResult,
    summary="Prepare signed resources for the current local principal",
)
async def prepare(
    body: PreparationBody,
    request: Request,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> Any:
    return await _handle("prepare", body, request, user, server)


@router.post(
    "/candidates/prepare",
    response_model=PreparationResult,
    summary="Prepare a scoped application candidate",
)
async def prepare_candidate(
    body: CandidatePreparationBody,
    request: Request,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> Any:
    return await _handle("candidate", body, request, user, server)


@router.post(
    "/readiness",
    response_model=PreparationResult,
    summary="Inspect current local resource bindings without creating resources",
)
async def readiness(
    body: ReadinessBody,
    request: Request,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> Any:
    return await _handle("readiness", body, request, user, server)
