"""Request-bound team capabilities. Cloud roles and native admins grant none."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from centuarai_local_data_gate.client import GateContext
from centuarai_local_data_gate.protocol import DataProtocolError, principal_namespace

from octop.infra.errors import ErrorCode, OctopError


def team_context(user: Any) -> GateContext:
    context = getattr(user, "local_team_context", None)
    team = getattr(user, "local_team", None)
    if (
        getattr(user, "local_data", False) is not True
        or user.is_admin
        or not isinstance(context, GateContext)
        or team is None
        or team is not context.claims.get("team")
        or user.username != "local_" + context.principal_namespace
    ):
        raise OctopError.localized(ErrorCode.FORBIDDEN)
    try:
        context.check_cached()
    except DataProtocolError:
        raise OctopError.localized(ErrorCode.FORBIDDEN) from None
    return context


def require_team_permission(user: Any, permission: str) -> Mapping[str, Any]:
    """Check current, verified native request capability immediately before work."""
    context = team_context(user)
    team = context.claims["team"]
    if context.claims["resourceId"] != "team:management" or permission not in team["permissions"]:
        raise OctopError.localized(ErrorCode.FORBIDDEN)
    return cast(Mapping[str, Any], team)


def team_profile(user: Any) -> dict[str, Any] | None:
    if getattr(user, "local_team", None) is None:
        return None
    context = team_context(user)
    return {
        name: list(value) if name == "permissions" else value
        for name, value in context.claims["team"].items()
    }


def resolve_team_member(services: Any, user: Any, membership_id: str) -> int:
    """Map only a current authority member, never an arbitrary supplied native UID."""
    require_team_permission(user, "applications.manage")
    context = team_context(user)
    members = context.team_members_sync()
    member = next((item for item in members if item["membershipId"] == membership_id), None)
    if member is None:
        raise OctopError.localized(ErrorCode.FORBIDDEN)
    claims = context.claims
    namespace = principal_namespace(
        claims["boxKeyThumbprint"], claims["ownershipEpoch"], member["principalId"]
    )
    uid = services.local_data_principal_repo.resolve(
        namespace, claims["boxKeyThumbprint"], claims["ownershipEpoch"], member["principalId"]
    )
    context.require_live()
    return int(uid)
