"""Company-application boundaries anchored in verified local team authority."""

from __future__ import annotations

from typing import Any

from centuarai_local_data_gate.protocol import principal_namespace

from octop.infra.errors import ErrorCode, OctopError
from octop.infra.users.team_authority import require_team_permission, team_context


def management_scope(user: Any) -> tuple[str, int]:
    team = require_team_permission(user, "applications.manage")
    team_context(user).require_live()
    return str(team["boxId"]), int(team["ownershipEpoch"])


def require_application(services: Any, user: Any, application_id: str) -> None:
    context = team_context(user)
    team = context.claims["team"]
    row = services.team_application_repo.get(application_id)
    if row is None or (row["box_id"], row["ownership_epoch"]) != (
        team["boxId"],
        team["ownershipEpoch"],
    ):
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    context.check_cached()


def current_member_ids(services: Any, user: Any) -> dict[int, str]:
    """Read only existing native mappings for the current signed roster."""
    context = team_context(user)
    members = context.team_members_sync()
    claims = context.claims
    result = {}
    for member in members:
        namespace = principal_namespace(
            claims["boxKeyThumbprint"], claims["ownershipEpoch"], member["principalId"]
        )
        row = services.user_repo.get_by_username("local_" + namespace)
        if row is None:
            continue
        # Existing mappings must pass the same marker/no-password/no-SSO check
        # as a real data request. A matching username alone is not authority.
        uid = services.local_data_principal_repo.resolve(
            namespace, claims["boxKeyThumbprint"], claims["ownershipEpoch"], member["principalId"]
        )
        result[int(uid)] = str(member["membershipId"])
    context.require_live()
    return result
