"""Thin HTTP adapters for WANX product management and product-user lifecycle."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query

from octop.api.deps import current_user, get_server
from octop.infra.applications.models import (
    AccessBody,
    AccessResponse,
    CompatibleReleaseResponse,
    DeploymentBody,
    DeploymentResponse,
    ProductDefinition,
    ProductManifest,
    ProductPatch,
    ProductResponse,
    ProfileResponse,
    RecommendBody,
    ReleaseBody,
    ReleaseResponse,
)
from octop.infra.applications.service import ApplicationService
from octop.infra.users.identity import User

router = APIRouter()


def application_service(server: Any = Depends(get_server)) -> ApplicationService:
    return ApplicationService(server.services)


@router.get(
    "/admin/applications", summary="List managed products", response_model=list[ProductResponse]
)
def list_products(
    user: User = Depends(current_user), service: ApplicationService = Depends(application_service)
) -> list[ProductResponse]:
    return service.list_products(user)


@router.post(
    "/admin/applications",
    summary="Register a product",
    status_code=201,
    response_model=ProductResponse,
)
def create_product(
    body: ProductDefinition,
    user: User = Depends(current_user),
    service: ApplicationService = Depends(application_service),
) -> ProductResponse:
    return service.create(user, body)


@router.get(
    "/admin/applications/{application_id}",
    summary="Product metadata",
    response_model=ProductResponse,
)
def get_product(
    application_id: str,
    user: User = Depends(current_user),
    service: ApplicationService = Depends(application_service),
) -> ProductResponse:
    return service.get(user, application_id)


@router.patch(
    "/admin/applications/{application_id}",
    summary="Update product definition",
    response_model=ProductResponse,
    description="Template changes apply to newly created user instances, never overwrite existing private profiles.",
)
def update_product(
    application_id: str,
    body: ProductPatch,
    user: User = Depends(current_user),
    service: ApplicationService = Depends(application_service),
) -> ProductResponse:
    return service.update(user, application_id, body)


@router.get(
    "/admin/applications/{application_id}/deployment",
    summary="Box product deployment",
    response_model=DeploymentResponse,
)
def get_deployment(
    application_id: str,
    user: User = Depends(current_user),
    service: ApplicationService = Depends(application_service),
) -> DeploymentResponse:
    return service.deployment(user, application_id)


@router.put(
    "/admin/applications/{application_id}/deployment",
    summary="Configure or disable product deployment",
    response_model=DeploymentResponse,
    description="Disabling immediately rejects product tokens without deleting user Agents or memory.",
)
def put_deployment(
    application_id: str,
    body: DeploymentBody,
    user: User = Depends(current_user),
    service: ApplicationService = Depends(application_service),
) -> DeploymentResponse:
    return service.put_deployment(user, application_id, body)


@router.get(
    "/admin/applications/{application_id}/releases",
    summary="Client release catalog",
    response_model=list[ReleaseResponse],
)
def list_releases(
    application_id: str,
    user: User = Depends(current_user),
    service: ApplicationService = Depends(application_service),
) -> list[ReleaseResponse]:
    return service.releases(user, application_id)


@router.post(
    "/admin/applications/{application_id}/releases",
    summary="Register externally hosted installer",
    status_code=201,
    response_model=ReleaseResponse,
)
def create_release(
    application_id: str,
    body: ReleaseBody,
    user: User = Depends(current_user),
    service: ApplicationService = Depends(application_service),
) -> ReleaseResponse:
    return service.create_release(user, application_id, body)


@router.post(
    "/admin/applications/{application_id}/releases/{version}/recommend",
    summary="Set recommended release per OS and architecture",
    response_model=ReleaseResponse,
)
def recommend_release(
    application_id: str,
    version: str,
    body: RecommendBody,
    user: User = Depends(current_user),
    service: ApplicationService = Depends(application_service),
) -> ReleaseResponse:
    return service.recommend(user, application_id, version, body.platform, body.arch)


@router.get(
    "/admin/applications/{application_id}/access",
    summary="Product access metadata",
    response_model=list[AccessResponse],
)
def list_access(
    application_id: str,
    user: User = Depends(current_user),
    service: ApplicationService = Depends(application_service),
) -> list[AccessResponse]:
    return service.access(user, application_id)


@router.put(
    "/admin/applications/{application_id}/access",
    summary="Grant or revoke product access",
    response_model=AccessResponse,
)
def put_access(
    application_id: str,
    body: AccessBody,
    user: User = Depends(current_user),
    service: ApplicationService = Depends(application_service),
) -> AccessResponse:
    return service.put_access(user, application_id, body.user_id, body.enabled)


@router.get(
    "/admin/applications/{application_id}/manifest",
    summary="Export credential-free product manifest",
    response_model=ProductManifest,
)
def get_manifest(
    application_id: str,
    user: User = Depends(current_user),
    service: ApplicationService = Depends(application_service),
) -> ProductManifest:
    return service.manifest(user, application_id)


@router.get(
    "/applications/{application_id}/release",
    summary="Compatible recommended product client",
    response_model=CompatibleReleaseResponse,
)
def compatible_release(
    application_id: str,
    platform: Literal["macos", "windows"],
    arch: Literal["arm64", "x64"],
    current_version: str = Query("0.0.0"),
    sdk_version: str = Query("0.1.0-alpha.2"),
    user: User = Depends(current_user),
    service: ApplicationService = Depends(application_service),
) -> CompatibleReleaseResponse:
    return service.compatible_release(
        user,
        application_id,
        platform=platform,
        arch=arch,
        current_version=current_version,
        sdk_version=sdk_version,
    )


@router.get(
    "/applications/{application_id}/profile",
    summary="Own private product instance",
    response_model=ProfileResponse,
)
def get_profile(
    application_id: str,
    user: User = Depends(current_user),
    service: ApplicationService = Depends(application_service),
) -> ProfileResponse:
    return service.profile(user, application_id)


@router.post(
    "/applications/{application_id}/profile",
    summary="Create private Agent from product template",
    status_code=201,
    response_model=ProfileResponse,
)
async def create_profile(
    application_id: str,
    user: User = Depends(current_user),
    service: ApplicationService = Depends(application_service),
    server: Any = Depends(get_server),
) -> ProfileResponse:
    return await service.create_profile(user, application_id, server.app_runtime.agent_registry)
