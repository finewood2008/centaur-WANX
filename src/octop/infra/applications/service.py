"""Product governance; resource data continues to belong to native WANX modules."""

from __future__ import annotations

import asyncio
from dataclasses import asdict
from typing import TYPE_CHECKING

from packaging.version import InvalidVersion, Version
from pydantic import ValidationError

from octop import __version__
from octop.infra.applications.models import (
    AccessResponse,
    CompatibleReleaseResponse,
    ConnectionIdentity,
    DeploymentBody,
    DeploymentResponse,
    ProductDefinition,
    ProductManifest,
    ProductPatch,
    ProductResponse,
    ProfileResponse,
    ReleaseBody,
    ReleaseResponse,
)
from octop.infra.db.services import SharedServices
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.users.identity import User
from octop.infra.users.permissions import user_has_permission

if TYPE_CHECKING:
    from octop.infra.agents.manager import AgentManager


def assert_product_login(services: SharedServices, user_id: int, application_id: str) -> None:
    """Re-read deployment and access on every token resolution; never trust JWT alone."""
    if application_id == "wanx":
        return
    product = services.application_repo.get(application_id)
    if product is None:
        if application_id == "zhijun":
            return  # Existing private profiles need no registry migration to keep working.
        raise OctopError.localized(ErrorCode.AUTH_FAILED)
    deployment = services.application_repo.deployment(application_id)
    access = services.application_repo.user_access(application_id, user_id)
    if not deployment or not deployment["enabled"] or access is False:
        raise OctopError.localized(ErrorCode.FORBIDDEN)
    if application_id != "zhijun" and access is not True:
        raise OctopError.localized(ErrorCode.FORBIDDEN)


class ApplicationService:
    def __init__(self, services: SharedServices) -> None:
        self.services = services
        self.repo = services.application_repo

    def _manage(self, user: User, application_id: str | None = None) -> None:
        if user.application_id != "wanx":
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        if user_has_permission(user, "applications_manage"):
            return
        if not user_has_permission(user, "applications_develop"):
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        if application_id is not None:
            row = self.repo.get(application_id)
            if row is None or row.created_by != user.id:
                raise OctopError.localized(ErrorCode.NOT_FOUND)

    def _response(self, application_id: str) -> ProductResponse:
        row = self.repo.get(application_id)
        if row is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        return ProductResponse(
            **asdict(row), connection_identity=ConnectionIdentity(application_id=application_id)
        )

    def _audit(self, user: User, action: str, application_id: str) -> None:
        self.services.audit_repo.write(actor=user.username, action=action, target=application_id)

    def list_products(self, user: User) -> list[ProductResponse]:
        self._manage(user)
        rows = self.repo.list_all()
        if not user_has_permission(user, "applications_manage"):
            rows = [row for row in rows if row.created_by == user.id]
        return [self._response(row.application_id) for row in rows]

    def create(self, user: User, body: ProductDefinition) -> ProductResponse:
        self._manage(user)
        if body.application_id == "wanx":
            raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
        if self.repo.get(body.application_id) is not None:
            raise OctopError.localized(ErrorCode.APPLICATION_CONFLICT)
        if self.repo.create(body.model_dump(), created_by=user.id) is None:
            raise OctopError.localized(ErrorCode.APPLICATION_CONFLICT)
        self._audit(user, "application.create", body.application_id)
        return self._response(body.application_id)

    def get(self, user: User, application_id: str) -> ProductResponse:
        self._manage(user, application_id)
        return self._response(application_id)

    def update(self, user: User, application_id: str, patch: ProductPatch) -> ProductResponse:
        self._manage(user, application_id)
        current = self._response(application_id)
        data = ProductDefinition.model_validate(
            current.model_dump(include=set(ProductDefinition.model_fields))
        )
        try:
            updated = ProductDefinition.model_validate(
                {**data.model_dump(), **patch.model_dump(exclude_unset=True)}
            )
        except ValidationError as exc:
            raise OctopError.localized(ErrorCode.APPLICATION_INVALID) from exc
        self.repo.update(application_id, updated.model_dump())
        self._audit(user, "application.update", application_id)
        return self._response(application_id)

    def deployment(self, user: User, application_id: str) -> DeploymentResponse:
        self.get(user, application_id)
        return DeploymentResponse.model_validate(self.repo.deployment(application_id))

    def put_deployment(
        self, user: User, application_id: str, body: DeploymentBody
    ) -> DeploymentResponse:
        self.get(user, application_id)
        product = self._response(application_id)
        self._validate_bindings(product, body)
        row = self.repo.put_deployment(application_id, body.model_dump())
        self._audit(user, "application.deployment.update", application_id)
        return DeploymentResponse.model_validate(row)

    def _validate_model(self, ref: str) -> None:
        name, separator, model = ref.partition("/")
        if not separator:
            name, separator, model = ref.partition(":")
        provider = self.services.provider_repo.get_by_name(name)
        if (
            not separator
            or not provider
            or not provider.enabled
            or not any(
                str(item.get("id")) == model and item.get("enabled", True)
                for item in provider.get_models()
            )
        ):
            raise OctopError.localized(ErrorCode.APPLICATION_INVALID)

    def _validate_bindings(self, product: ProductResponse, body: DeploymentBody) -> None:
        from octop_harness.plugins import PluginRegistry

        requirements = product.resource_requirements
        default_kinds = {
            "default_model": "model",
            "provider": "provider",
            "storage_backend": "storage",
        }
        for name, requirement in requirements.items():
            if (
                body.enabled
                and requirement.get("required", True)
                and name not in body.resource_bindings
            ):
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
        for name, ref in body.resource_bindings.items():
            kind = requirements.get(name, {}).get("kind", default_kinds.get(name))
            if not kind or not isinstance(ref, str) or not ref:
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            if kind == "model":
                self._validate_model(ref)
            elif kind == "provider":
                provider = self.services.provider_repo.get_by_name(ref)
                if provider is None or not provider.enabled:
                    raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            elif kind == "storage":
                storage = self.services.storage_backend_repo.get_by_name(ref)
                if storage is None or not storage.enabled:
                    raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            elif kind == "skill":
                if self.services.skill_package_repo.get(ref) is None:
                    raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            elif kind == "plugin" and not any(
                plugin.manifest.id == ref for plugin in PluginRegistry().list_plugins()
            ):
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
        template_model = product.agent_template.get("default_model")
        if body.enabled and template_model:
            self._validate_model(str(template_model))

    def releases(self, user: User, application_id: str) -> list[ReleaseResponse]:
        self.get(user, application_id)
        return [ReleaseResponse.model_validate(row) for row in self.repo.releases(application_id)]

    def create_release(self, user: User, application_id: str, body: ReleaseBody) -> ReleaseResponse:
        rows = self.releases(user, application_id)
        if any(
            (row.version, row.platform, row.arch) == (body.version, body.platform, body.arch)
            for row in rows
        ):
            raise OctopError.localized(ErrorCode.APPLICATION_CONFLICT)
        if not self.repo.create_release(application_id, body.model_dump()):
            raise OctopError.localized(ErrorCode.APPLICATION_CONFLICT)
        if body.recommended:
            self.repo.recommend(application_id, body.version, body.platform, body.arch)
        self._audit(user, "application.release.create", application_id)
        return next(
            row
            for row in self.releases(user, application_id)
            if (row.version, row.platform, row.arch) == (body.version, body.platform, body.arch)
        )

    def recommend(
        self, user: User, application_id: str, version: str, platform: str, arch: str
    ) -> ReleaseResponse:
        rows = self.releases(user, application_id)
        if not any(
            (row.version, row.platform, row.arch) == (version, platform, arch) for row in rows
        ):
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        self.repo.recommend(application_id, version, platform, arch)
        self._audit(user, "application.release.recommend", application_id)
        return next(
            row
            for row in self.releases(user, application_id)
            if row.recommended and (row.platform, row.arch) == (platform, arch)
        )

    def access(self, user: User, application_id: str) -> list[AccessResponse]:
        self.get(user, application_id)
        return [AccessResponse.model_validate(row) for row in self.repo.access(application_id)]

    def put_access(
        self, user: User, application_id: str, user_id: int, enabled: bool
    ) -> AccessResponse:
        self.get(user, application_id)
        if self.services.user_repo.get(user_id) is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        self.repo.put_access(application_id, user_id, enabled)
        self._audit(user, "application.access.update", application_id)
        return next(row for row in self.access(user, application_id) if row.user_id == user_id)

    def manifest(self, user: User, application_id: str) -> ProductManifest:
        product = self.get(user, application_id)
        deployment = self.deployment(user, application_id)
        return ProductManifest(
            product=ProductDefinition.model_validate(
                product.model_dump(include=set(ProductDefinition.model_fields))
            ),
            deployment=DeploymentBody.model_validate(
                deployment.model_dump(include=set(DeploymentBody.model_fields))
            ),
        )

    def _product_user(self, user: User, application_id: str) -> ProductResponse:
        if user.application_id != application_id:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        assert_product_login(self.services, user.id, application_id)
        return self._response(application_id)

    def compatible_release(
        self,
        user: User,
        application_id: str,
        *,
        platform: str,
        arch: str,
        current_version: str,
        sdk_version: str,
    ) -> CompatibleReleaseResponse:
        self._product_user(user, application_id)
        try:
            current = Version(current_version)
            sdk = Version(sdk_version)
        except InvalidVersion as exc:
            raise OctopError.localized(ErrorCode.APPLICATION_INVALID) from exc
        release = next(
            (
                ReleaseResponse.model_validate(row)
                for row in self.repo.releases(application_id)
                if row["recommended"]
                and row["platform"] == platform
                and row["arch"] == arch
                and Version(row["min_wanx_version"]) <= Version(__version__)
                and Version(row["min_sdk_version"]) <= sdk
            ),
            None,
        )
        return CompatibleReleaseResponse(
            application_id=application_id,
            current_version=current_version,
            release=release,
            update_available=release is not None and Version(release.version) > current,
        )

    def profile(self, user: User, application_id: str) -> ProfileResponse:
        self._product_user(user, application_id)
        row = self.services.agent_repo.get_application_profile(user.id, application_id)
        return ProfileResponse(
            application_id=application_id, agent_id=row.agent_id if row else None
        )

    async def create_profile(
        self, user: User, application_id: str, registry: AgentManager
    ) -> ProfileResponse:
        from octop.infra.agents.manager import AgentCreateSpec

        loop = asyncio.get_running_loop()
        product = await loop.run_in_executor(None, self._product_user, user, application_id)
        if application_id == "super-advisory":
            from octop.infra.agents.teams.brainstorm import service_for
            from octop.infra.agents.teams.brainstorm_types import ProfileConfigure

            profile = await service_for(registry).configure(user, ProfileConfigure())
            return ProfileResponse(application_id=application_id, agent_id=profile.team_id)
        existing = await loop.run_in_executor(None, self.profile, user, application_id)
        if existing.agent_id:
            return existing
        if application_id == "zhijun":
            from octop.infra.agents.zhijun import get_or_create_profile

            row = await get_or_create_profile(registry, user.id)
            return ProfileResponse(application_id=application_id, agent_id=row.agent_id)
        template = product.agent_template
        deployment = await loop.run_in_executor(None, self.repo.deployment, application_id)
        assert deployment is not None
        await loop.run_in_executor(
            None,
            self._validate_bindings,
            product,
            DeploymentBody.model_validate(
                {key: deployment[key] for key in DeploymentBody.model_fields}
            ),
        )
        bindings = deployment["resource_bindings"]
        model = bindings.get("default_model") or next(
            (
                bindings[name]
                for name, requirement in product.resource_requirements.items()
                if requirement["kind"] == "model" and name in bindings
            ),
            template.get("default_model"),
        )
        row = await registry.create(
            AgentCreateSpec(
                name=str(template.get("name", product.name)),
                user_id=user.id,
                application_id=application_id,
                description=str(template.get("description", product.description)),
                default_model=str(model) if model else None,
                system_prompt=template.get("system_prompt"),
                welcome_message=template.get("welcome_message"),
                is_shared=False,
            )
        )
        return ProfileResponse(application_id=application_id, agent_id=row.agent_id)
