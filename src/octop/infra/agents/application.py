"""Application ownership shared by Agent runtime and transport adapters."""

from __future__ import annotations

from typing import Any

from octop.infra.errors import ErrorCode, OctopError

ApplicationId = str


def application_id(value: Any) -> ApplicationId:
    """Legacy rows and identities belong to WANX."""
    value_id = getattr(value, "application_id", "wanx")
    return value_id if isinstance(value_id, str) and value_id else "wanx"


def assert_same_application(row: Any, user: Any) -> None:
    """Hide cross-application resources, including from application admins."""
    if application_id(row) != application_id(user):
        raise OctopError(ErrorCode.AGENT_NOT_FOUND, "agent not found")
