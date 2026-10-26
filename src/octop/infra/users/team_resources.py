"""Explicit object publication and request-bound shared resource access."""

from __future__ import annotations

import re
from typing import Any, cast

from centuarai_local_data_gate.protocol import DataProtocolError
from centuarai_local_data_gate.team import team_resource

from octop.infra.errors import ErrorCode, OctopError
from octop.infra.users.team_authority import require_team_permission, team_context


def resource_record(services: Any, user: Any) -> dict[str, Any] | None:
    context = team_context(user)
    resource = context.claims["resourceId"]
    selected = team_resource(resource)
    if selected is None or selected[0] not in {"agent", "knowledge", "space"}:
        return None
    if selected[0] == "knowledge" and re.fullmatch(r"[A-Z0-9]{6}", selected[1]) is None:
        if re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", selected[1]):
            # Semantica warehouses are enforced by its separate native gate.
            # Identity/metadata requests here do not publish or open an Octop KB.
            return None
        raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")
    team = context.claims["team"]
    row = services.local_team_resource_repo.get(team["boxId"], team["ownershipEpoch"], resource)
    if row is None or row["kind"] != selected[0] or row["object_id"] != selected[1]:
        raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")
    context.check_cached()
    return cast(dict[str, Any], row)


def may_access(user: Any, kind: str, identifier: str, *, write: bool = False) -> bool:
    """Only the exact object validated by the native gate for this operation."""
    if getattr(user, "local_data", False) is not True:
        return False
    row = getattr(user, "local_resource", None)
    if row is None:
        return False
    context = team_context(user)
    context.check_cached()
    return bool(
        row["kind"] == kind
        and row["object_id"] == identifier
        and (not write or context.claims["action"] in {"write", "execute"})
    )


def publish(server: Any, user: Any, resource_id: str, name: str = "") -> dict[str, Any]:
    team = require_team_permission(user, "resources.manage")
    context = team_context(user)
    selected = team_resource(resource_id)
    if selected is None or selected[0] not in {"agent", "knowledge", "space"}:
        raise OctopError.localized(ErrorCode.FORBIDDEN)
    kind, identifier = selected
    if kind == "space":
        from octop.infra.personal_space.service import SpaceError
        from octop.infra.personal_space.team_scope import create_team_space

        try:
            create_team_space(
                server.paths.root / ".wanx-personal-space",
                user.id,
                identifier,
                name,
                context.require_live,
            )
        except SpaceError:
            raise OctopError.localized(ErrorCode.FORBIDDEN) from None
    context.require_live()
    try:
        return cast(
            dict[str, Any],
            server.services.local_team_resource_repo.publish(
                box_id=team["boxId"],
                epoch=team["ownershipEpoch"],
                resource_id=resource_id,
                kind=kind,
                object_id=identifier,
                owner_user_id=user.id,
                before_commit=context.check_cached,
            ),
        )
    except ValueError:
        raise OctopError.localized(ErrorCode.FORBIDDEN) from None
