"""Native local identity integration; no native token is issued in required mode."""

from __future__ import annotations

import asyncio
import os
import re
from dataclasses import replace
from pathlib import Path
from typing import Any, cast
from urllib.parse import parse_qs

from centuarai_local_data_gate import (
    GateConfig,
    LocalDataGateMiddleware,
    get_context,
    load_required_policy,
)
from centuarai_local_data_gate.protocol import DataProtocolError

from octop.infra.errors import ErrorCode, OctopError
from octop.infra.users.identity import User

LOCAL_DATA_GATE_VERSION = 1
DEFAULT_CONFIG = Path("/etc/centuarai/local-trust/octop-gate.json")
_PERSONAL_PERMISSIONS = ["channels", "connectors", "skill_packages", "knowledge_bases"]
_EXECUTE_PERMISSIONS = ["browser", "terminal", "desktop", "mobile"]


def required(connection: Any) -> bool:
    return bool(
        getattr(connection.app.state, "local_data_required", False)
        or getattr(connection, "scope", {}).get("state", {}).get("local_data_required")
    )


def local_user(connection: Any) -> User | None:
    if not required(connection):
        return None
    context = get_context(connection.scope)
    user = connection.scope.get("state", {}).get("octop_user")
    if context is None or not isinstance(user, User) or user.is_admin:
        raise OctopError(ErrorCode.AUTH_FAILED, "local data proof required")
    try:
        context.check_cached()
    except DataProtocolError:
        raise OctopError(ErrorCode.AUTH_FAILED, "local data session closed") from None
    return user


def resolve_connection_user(connection: Any, server: Any, token: str | None = None) -> User:
    user = local_user(connection)
    if user is not None:
        return user
    from octop.api.deps import resolve_user_from_token

    if not token:
        raise OctopError(ErrorCode.AUTH_FAILED, "missing credentials")
    return resolve_user_from_token(server, token)


def _resolve(server: Any, context: Any) -> User:
    claims = context.claims
    uid = server.services.local_data_principal_repo.resolve(
        context.principal_namespace,
        claims["boxKeyThumbprint"],
        claims["ownershipEpoch"],
        claims["principalId"],
    )
    user = server.user_manager.get_by_id(uid)
    if user is None:
        row = server.services.user_repo.get(uid)
        user = User(
            id=uid,
            username=row.username,
            role="user",
            display_name=row.display_name,
            locale=row.locale,
            permissions=[],
        )
        server.user_manager.register_cached_user(user)
    if user.is_admin or user.username != "local_" + context.principal_namespace:
        raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
    permissions = list(_PERSONAL_PERMISSIONS) if claims["resourceId"] == "wanx" else []
    if re.fullmatch(r"team:knowledge:[A-Z0-9]{6}", claims["resourceId"]) and claims["action"] in {
        "write",
        "execute",
    }:
        permissions.append("knowledge_bases")
    if claims["action"] == "execute":
        permissions += _EXECUTE_PERMISSIONS
    app = {"centaurai.wanx.zhijun": "zhijun", "centaurai.wanx.superadvisors": "super-advisory"}.get(
        claims["applicationId"], "wanx"
    )
    return cast(
        User,
        replace(
            user,
            role="user",
            permissions=permissions,
            application_id=app,
            local_data=True,
            local_team=claims.get("team"),
            local_team_context=context if claims.get("team") else None,
        ),
    )


async def protocol_error(_request: Any, error: Any) -> Any:
    from fastapi.responses import JSONResponse

    return JSONResponse(
        {"code": error.code}, status_code=403, headers={"Cache-Control": "no-store"}
    )


def install(app: Any, server: Any) -> None:
    mode = os.getenv("OCTOP_LOCAL_DATA_MODE", "")
    filename = Path(os.getenv("OCTOP_LOCAL_DATA_GATE_CONFIG", str(DEFAULT_CONFIG)))
    policy = load_required_policy()
    if policy is not None and mode != "required":
        raise DataProtocolError("LOCAL_DATA_REQUIRED")
    if not mode and not filename.exists():
        return
    if mode not in {"", "required"}:
        raise DataProtocolError("LOCAL_DATA_REQUIRED")
    config = GateConfig.load(filename, audience="octop")
    if policy and (policy["boxId"] != config.box_id or policy["gatewayId"] != config.gateway_id):
        raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
    app.state.local_data_required = True
    app.add_exception_handler(DataProtocolError, protocol_error)

    async def authorize(scope: dict[str, Any], context: Any) -> None:
        # Gateway already classified the fixed route. Native still checks its
        # actual request and resource, then supplies only its own mapped user.
        from centuarai_local_data_gate.native_policy import check_octop_request

        check_octop_request(scope, context.claims)
        user = await asyncio.to_thread(_resolve, server, context)
        if user.local_team is not None:
            from types import MappingProxyType

            from octop.infra.users.team_resources import resource_record

            record = await asyncio.to_thread(resource_record, server.services, user)
            if record is not None:
                user = replace(user, local_resource=MappingProxyType(record))
        await _check_configuration(scope, context, server, user)
        await asyncio.to_thread(_check_private_resources, server, scope, context, user)
        scope.setdefault("state", {})["octop_user"] = user
        from octop.infra.agents.middleware.local_data import local_data_live_check

        local_data_live_check.set(context.require_live)

    app.add_middleware(LocalDataGateMiddleware, config=config, authorize=authorize)


def _check_private_resources(server: Any, scope: dict[str, Any], context: Any, user: User) -> None:
    """Legacy sharing is not authority to cross a local principal's namespace."""
    from octop.api.common.agent import assert_agent_owner

    path = scope["path"]
    clipboard = context.claims["serviceContext"].get("clipboardScope")
    if clipboard is not None:
        if context.claims["parentOperationId"] is None:
            raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")
        method = scope.get("method", "GET")
        allowed = (method, path) in {
            ("GET", "/api/auth/me"),
            ("POST", "/api/personal-space/app-folders"),
            ("POST", "/api/personal-space/connection-access"),
            ("POST", "/api/personal-space/uploads"),
        }
        allowed = allowed or (
            method in {"GET", "PATCH", "DELETE"}
            and re.fullmatch(r"/api/personal-space/files/[a-f0-9]{32}", path) is not None
        )
        allowed = allowed or (
            method == "GET"
            and re.fullmatch(r"/api/personal-space/files/[a-f0-9]{32}/content", path) is not None
        )
        allowed = allowed or (
            method in {"GET", "PUT", "DELETE"}
            and re.fullmatch(r"/api/personal-space/uploads/[a-f0-9]{32}", path) is not None
        )
        allowed = allowed or (
            method == "POST"
            and re.fullmatch(r"/api/personal-space/uploads/[a-f0-9]{32}/complete", path) is not None
        )
        if not allowed:
            raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")
    elif context.claims["resourceId"] == "clipboard":
        raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")
    query = parse_qs(scope.get("query_string", b"").decode("ascii"), keep_blank_values=True)
    identifiers = list(query.get("agent_id", []))
    if context.claims["headers"]["agentId"]:
        identifiers.append(context.claims["headers"]["agentId"])
    match = re.fullmatch(r"/api/agents/([^/]+)(?:/.*)?", path)
    if match and match[1] != "from-expert":
        identifiers.append(match[1])
    for identifier in identifiers:
        row = server.app_runtime.agent_registry.get_row(identifier)
        if row is None:
            raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")
        try:
            from octop.infra.users.team_resources import may_access

            shared = may_access(user, "agent", identifier, write=context.claims["action"] != "read")
            if shared:
                assert user.local_resource is not None
                if row.user_id != user.local_resource["owner_user_id"]:
                    raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")
            if not shared:
                assert_agent_owner(row, user)
        except OctopError:
            raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED") from None
    knowledge = re.fullmatch(r"/api/knowledge-bases/([A-Z0-9]{6})(?:/.*)?", path)
    if knowledge:
        row = server.services.knowledge_repo.get_base(knowledge[1], application_id=None)
        from octop.infra.users.team_resources import may_access

        if (
            row is None
            or row.application_id != user.application_id
            or (
                row.owner_user_id != user.id
                and not may_access(
                    user, "knowledge", knowledge[1], write=context.claims["action"] != "read"
                )
            )
        ):
            raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")
        if (
            user.local_resource is not None
            and row.owner_user_id != user.local_resource["owner_user_id"]
        ):
            raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")


async def _check_configuration(
    scope: dict[str, Any], context: Any, server: Any, user: User
) -> None:
    """Local accounts cannot turn private agent configuration into host access."""
    path = scope["path"]
    assistant_context = path == "/api/assistant/context/validate" or (
        scope.get("method") == "PATCH"
        and re.fullmatch(r"/api/assistant/conversations/[^/]+", path) is not None
    )
    if scope.get("method") not in {"POST", "PATCH", "PUT"} or not (
        assistant_context
        or path == "/api/agents"
        or re.fullmatch(r"/api/agents/[^/]+", path)
        or path.startswith("/api/knowledge-bases")
    ):
        return
    import json

    try:
        value = json.loads(await context.read_body(2 * 1024 * 1024))
        if not isinstance(value, dict):
            raise ValueError()
        if assistant_context:
            selected = value if path.endswith("/context/validate") else value.get("context")
            if selected is not None:
                if not isinstance(selected, dict):
                    raise ValueError()
                for family in ("space", "knowledge"):
                    choice = selected.get(family, {})
                    if not isinstance(choice, dict) or choice.get("enabled", False) is not False:
                        raise ValueError()
            return
        if value.get("is_shared") or value.get("shared"):
            raise ValueError()
        if path.startswith("/api/agents"):
            if any(value.get(key) for key in ("mcp_servers", "skill_package_ids", "template_name")):
                raise ValueError()

            def check_knowledge() -> None:
                for identifier in value.get("knowledge_base_ids") or []:
                    row = server.services.knowledge_repo.get_base(identifier, application_id=None)
                    if (
                        row is None
                        or row.owner_user_id != user.id
                        or row.application_id != user.application_id
                    ):
                        raise ValueError()

            await asyncio.to_thread(check_knowledge)
            config = value.get("config") or {}
            # Server-owned default workspace and runtime are retained. Profiles
            # may change language/style, not executable/provider storage inputs.
            if not isinstance(config, dict) or set(config) - {
                "interaction",
                "welcome_message",
                "persona",
            }:
                raise ValueError()
    except (ValueError, TypeError):
        raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED") from None
