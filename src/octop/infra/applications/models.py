"""Versioned, credential-free application management contracts."""

from __future__ import annotations

import re
from typing import Any, Literal
from urllib.parse import urlsplit

from packaging.version import InvalidVersion, Version
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SUPPORTED_CAPABILITIES = frozenset(
    {
        "chat",
        "memory",
        "knowledge",
        "upload",
        "voice",
        "teams",
        "zhijun_context",
        "brainstorm",
        "model_settings",
    }
)
_SECRET_KEYS = frozenset(
    {
        "password",
        "secret",
        "token",
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "client_secret",
        "secret_key",
        "access_key",
        "clientsecret",
        "privatekey",
        "accesskey",
        "secretkey",
        "private_key",
        "credentials",
        "authorization",
    }
)


def credential_free(value: Any) -> Any:
    """Manifests contain logical references, never credentials or private user data."""
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).lower().replace("-", "_")
            if normalized in _SECRET_KEYS or normalized.endswith(
                ("_secret", "_password", "_token", "_private_key")
            ):
                raise ValueError("credentials must be stored in WANX secret settings")
            credential_free(child)
    elif isinstance(value, list):
        for child in value:
            credential_free(child)
    return value


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProductDefinition(Contract):
    application_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9.-]*$")
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=4000)
    capabilities: list[str] = Field(
        default_factory=list,
        description="Declared native capabilities: chat, memory, knowledge, upload, voice, teams, zhijun_context, brainstorm, model_settings. Model settings still require the account's providers permission.",
    )
    agent_template: dict[str, Any] = Field(
        default_factory=dict,
        description="New private instance template. String fields: name, description, default_model, system_prompt, welcome_message. Existing instances are never overwritten.",
    )
    resource_requirements: dict[str, Any] = Field(
        default_factory=dict,
        description="Logical binding slots, each {kind: model|provider|storage|skill|plugin, required?: boolean}. Private Agent/knowledge resources and credentials are forbidden.",
    )

    @field_validator("capabilities")
    @classmethod
    def validate_capabilities(cls, value: list[str]) -> list[str]:
        if set(value) - SUPPORTED_CAPABILITIES:
            raise ValueError("unsupported application capability")
        return list(dict.fromkeys(value))

    @field_validator("agent_template", "resource_requirements")
    @classmethod
    def no_secrets(cls, value: dict[str, Any]) -> dict[str, Any]:
        credential_free(value)
        return value

    @field_validator("agent_template")
    @classmethod
    def validate_template(cls, value: dict[str, Any]) -> dict[str, Any]:
        allowed = {"name", "description", "default_model", "system_prompt", "welcome_message"}
        if set(value) - allowed or any(not isinstance(item, str) for item in value.values()):
            raise ValueError("unsupported agent template field")
        return value

    @field_validator("resource_requirements")
    @classmethod
    def validate_requirements(cls, value: dict[str, Any]) -> dict[str, Any]:
        for requirement in value.values():
            if (
                not isinstance(requirement, dict)
                or requirement.get("kind")
                not in {"model", "provider", "storage", "skill", "plugin"}
                or set(requirement) - {"kind", "required"}
            ):
                raise ValueError("resources require kind and optional required flag")
            if "required" in requirement and not isinstance(requirement["required"], bool):
                raise ValueError("required must be boolean")
        return value


class ProductPatch(Contract):
    name: str | None = None
    description: str | None = None
    capabilities: list[str] | None = None
    agent_template: dict[str, Any] | None = None
    resource_requirements: dict[str, Any] | None = None


class ConnectionIdentity(Contract):
    status: Literal["pending"] = "pending"
    application_id: str
    remote_enabled: Literal[False] = False


class ProductResponse(ProductDefinition):
    created_by: int
    created_at: int
    updated_at: int
    connection_identity: ConnectionIdentity


class DeploymentBody(Contract):
    enabled: bool = False
    resource_bindings: dict[str, Any] = Field(
        default_factory=dict,
        description="Binding slot to server-owned resource reference: provider/model for models, configured names for providers/storage, package or plugin IDs otherwise. References are verified before enabling.",
    )
    configuration: dict[str, Any] = Field(
        default_factory=dict,
        description="Credential-free deployment configuration; secret values remain in native WANX settings.",
    )

    @field_validator("resource_bindings", "configuration")
    @classmethod
    def no_secrets(cls, value: dict[str, Any]) -> dict[str, Any]:
        credential_free(value)
        return value


class DeploymentResponse(DeploymentBody):
    application_id: str
    updated_at: int


class ReleaseBody(Contract):
    version: str = Field(min_length=1, max_length=64)
    platform: Literal["macos", "windows"]
    arch: Literal["arm64", "x64"]
    url: str = Field(max_length=4096)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    min_wanx_version: str = "1.0.2b4"
    min_sdk_version: str = "0.1.0-alpha.2"
    recommended: bool = False

    @field_validator("version", "min_wanx_version", "min_sdk_version")
    @classmethod
    def validate_version(cls, value: str) -> str:
        if not re.fullmatch(r"[0-9A-Za-z.+_-]+", value):
            raise ValueError("invalid version")
        try:
            Version(value)
        except InvalidVersion as exc:
            raise ValueError("invalid version") from exc
        return value

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("installer URL must be HTTPS without credentials")
        return value

    @model_validator(mode="after")
    def validate_windows(self) -> ReleaseBody:
        self.sha256 = self.sha256.lower()
        return self


class ReleaseResponse(ReleaseBody):
    created_at: int


class RecommendBody(Contract):
    platform: Literal["macos", "windows"]
    arch: Literal["arm64", "x64"]


class AccessBody(Contract):
    user_id: int = Field(gt=0)
    enabled: bool


class AccessResponse(AccessBody):
    username: str
    updated_at: int


class ProductManifest(Contract):
    schema_version: Literal[1] = 1
    product: ProductDefinition
    deployment: DeploymentBody


class CompatibleReleaseResponse(Contract):
    application_id: str
    current_version: str
    release: ReleaseResponse | None
    update_available: bool


class ProfileResponse(Contract):
    application_id: str
    agent_id: str | None
