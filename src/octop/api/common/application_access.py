"""Transport allowlists for isolated product tokens and legacy Zhijun clients."""

from __future__ import annotations

import re
from typing import Any

from octop.infra.agents.application import application_id, assert_same_application
from octop.infra.errors import ErrorCode, OctopError

_AGENT_PATH = re.compile(r"^/api/agents/([^/]+)(?:/(.*))?$")
_ZHIJUN_EXACT = {
    ("GET", "/api/auth/me"),
    ("POST", "/api/auth/logout"),
    ("GET", "/api/settings/timezone"),
    ("GET", "/api/settings/upload"),
    ("GET", "/api/providers/resolved"),
    ("GET", "/api/mbti/types"),
    ("GET", "/api/mbti/current"),
    ("POST", "/api/mbti/apply"),
    ("GET", "/api/mbti/test/questions"),
    ("POST", "/api/mbti/test/submit"),
    ("GET", "/api/voice/stt/capability"),
    ("POST", "/api/voice/stt"),
    ("GET", "/api/knowledge-bases"),
    ("POST", "/api/knowledge-bases"),
    ("POST", "/api/knowledge-bases/personal"),
    ("GET", "/api/knowledge-bases/capability"),
    ("GET", "/api/knowledge-bases/default-open"),
    ("GET", "/api/zhijun/profile"),
    ("POST", "/api/zhijun/profile"),
    ("POST", "/api/zhijun/response-options"),
    ("POST", "/api/zhijun/response-origin"),
    ("GET", "/api/zhijun/ontology"),
    ("GET", "/api/zhijun/ontology/candidates"),
    ("GET", "/api/zhijun/ontology/context"),
    ("POST", "/api/zhijun/ontology:nodes"),
    ("POST", "/api/zhijun/ontology/context-nodes"),
    ("POST", "/api/zhijun/ontology:relation"),
    ("POST", "/api/zhijun/ontology:generate"),
    ("GET", "/api/zhijun/understanding"),
    ("PUT", "/api/zhijun/understanding"),
    ("POST", "/api/zhijun/understanding:run"),
    ("POST", "/api/zhijun/understanding:pause"),
    ("GET", "/api/zhijun/maintenance"),
    ("POST", "/api/zhijun/maintenance:preview"),
    ("POST", "/api/zhijun/maintenance"),
    ("POST", "/api/zhijun/maintenance:archive"),
    ("GET", "/api/zhijun/notification-channels"),
    ("PUT", "/api/zhijun/notification-channels"),
    ("GET", "/api/zhijun/decisions"),
    ("POST", "/api/zhijun/decisions"),
}
# Workspace writes, config, shared agents and general tools remain unavailable.
_ZHIJUN_AGENT = {
    ("GET", ""),
    ("GET", "status"),
    ("GET", "proactive-care"),
    ("PUT", "proactive-care"),
    ("GET", "channels"),
    ("POST", "channels/weixin/qrcode/generate"),
    ("POST", "channels/weixin/qrcode/poll"),
    ("POST", "start"),
    ("POST", "read"),
    ("GET", "history-migration/status"),
    ("GET", "threads"),
    ("POST", "threads"),
    ("PATCH", "session"),
    ("GET", "chat/welcome"),
    ("POST", "chat/hitl/resume"),
    ("POST", "upload"),
    ("GET", "upload/source"),
}
_ZHIJUN_THREAD = re.compile(
    r"^threads/[^/]+(?:/(?:history|history-migration|read|turn-status|hitl|trajectory"
    r"|context-usage|turns(?:/[^/]+)?|artifacts|fork))?$"
)
_ZHIJUN_KNOWLEDGE = re.compile(r"^/api/knowledge-bases/([A-Z0-9]{6})(?:/(.*))?$")


def assert_application_request(
    server: Any,
    user: Any,
    *,
    path: str,
    method: str,
    legacy_agent_id: str | None = None,
    query_agent_id: str | None = None,
) -> None:
    """Reject cross-application ids before routing, including legacy selectors.

    Resource ownership is additionally checked by route helpers. Application
    scope is signed into the token; request headers cannot select it.
    """
    path = path.rstrip("/")
    app_id = application_id(user)
    registered = app_id not in {"wanx", "zhijun"}
    if registered:
        _assert_registered_request(server, user, path=path, method=method)
    if path.startswith("/api/zhijun") and app_id != "zhijun":
        raise OctopError(ErrorCode.NOT_FOUND, "application resource not found")

    # This collection action precedes the dynamic agent route in FastAPI.
    # Its expert template id is not an existing Agent id.
    match = None if path.startswith("/api/agents/from-expert/") else _AGENT_PATH.fullmatch(path)
    agent_ids = [value for value in (legacy_agent_id, query_agent_id) if value]
    if match:
        agent_ids.append(match.group(1))
    if agent_ids:
        registry = server.app_runtime.agent_registry
        for agent_id in agent_ids:
            row = registry.get_row(agent_id)
            if row is None and match and match.group(2) == "terminal/ws" and app_id == "wanx":
                # The terminal route supports short ids and validates its resolved row.
                continue
            if row is None:
                raise OctopError(ErrorCode.AGENT_NOT_FOUND, "agent not found")
            assert_same_application(row, user)
            if registered and row.user_id != user.id:
                raise OctopError.localized(ErrorCode.FORBIDDEN)

    knowledge = _ZHIJUN_KNOWLEDGE.fullmatch(path)
    if knowledge:
        base = server.services.knowledge_repo.get_base(knowledge.group(1), application_id=None)
        if base is None or getattr(base, "application_id", "wanx") != app_id:
            raise OctopError.localized(ErrorCode.KNOWLEDGE_NOT_FOUND)

    if registered:
        return

    if app_id != "zhijun":
        if path.startswith("/api/admin/backup/"):
            rows = server.services.agent_repo.list_all(include_disabled=True)
            if any(application_id(row) != "wanx" for row in rows):
                raise OctopError(ErrorCode.NOT_FOUND, "host backup requires local administration")
        return
    allowed = (
        (method, path) in _ZHIJUN_EXACT
        or (
            method == "POST"
            and re.fullmatch(r"/api/zhijun/decisions/[^/]+:review", path) is not None
        )
        or (
            method == "POST"
            and re.fullmatch(r"/api/zhijun/ontology/context-nodes/[^/]+:edit", path) is not None
        )
        or (
            method == "POST"
            and re.fullmatch(
                r"/api/zhijun/ontology/[^/]+:(?:review|edit|admission|conversation)", path
            )
            is not None
        )
        or (
            method == "POST"
            and re.fullmatch(
                r"/api/zhijun/understanding/invitations/[^/]+:(?:review|conversation)", path
            )
            is not None
        )
        or (method == "GET" and path == "/api/settings/capabilities")
    )
    if path.startswith("/api/zhijun/digital-self"):
        base = "/api/zhijun/digital-self"
        allowed = (
            (path == base and method == "GET")
            or (path == base + "/me" and method in {"GET", "PUT"})
            or (path == base + "/me/sources" and method == "GET")
            or (path in {base + "/me/preview", base + "/me/access"} and method == "POST")
            or (re.fullmatch(base + r"/me/visitors/[0-9]+", path) is not None and method == "GET")
            or (re.fullmatch(base + r"/[A-Z0-9]{26}", path) is not None and method == "GET")
            or (re.fullmatch(base + r"/[A-Z0-9]{26}/access", path) is not None and method == "POST")
            or (
                re.fullmatch(base + r"/[A-Z0-9]{26}/sources/[^/]+", path) is not None
                and method == "GET"
            )
            or (
                re.fullmatch(base + r"/[A-Z0-9]{26}/conversation", path) is not None
                and method in {"GET", "POST", "DELETE"}
            )
        )
    if re.fullmatch(r"/api/applications/zhijun/(?:release|profile)", path):
        allowed = method == "GET" or (path.endswith("/profile") and method == "POST")
    if knowledge:
        # Native knowledge handlers enforce application scope and private ownership.
        suffix = knowledge.group(2) or ""
        allowed = (
            (not suffix and method in {"GET", "PATCH", "DELETE"})
            or (suffix == "documents" and method in {"GET", "POST"})
            or (suffix == "documents/page" and method == "GET")
            or (suffix == "reindex" and method == "POST")
            or (
                method == "GET"
                and re.fullmatch(r"documents/[^/]+/(?:preview|file|content|text/page)", suffix)
                is not None
            )
            or (method == "POST" and re.fullmatch(r"documents/[^/]+/reindex", suffix) is not None)
            or (method == "DELETE" and re.fullmatch(r"documents/[^/]+", suffix) is not None)
        )
    if match:
        suffix = match.group(2) or ""
        allowed = (method, suffix) in _ZHIJUN_AGENT
        if method == "WEBSOCKET":
            allowed = suffix == "chat/ws"
        elif re.fullmatch(r"channels/[^/]+", suffix):
            allowed = method in {"GET", "PATCH"}
        elif suffix.startswith("memory/"):
            allowed = (
                (method == "PUT" and suffix == "memory/extract-config")
                or (method == "POST" and suffix == "memory/atoms")
                or (
                    method == "GET"
                    and re.fullmatch(
                        r"memory/(?:(?:raw_events|candidates|atoms|entities|episodes)/[^/]+"
                        r"|stats/(?:counts|growth|atom_kinds)|journal/recent"
                        r"|terminal/(?:about_me|current_focus|things_you_told_me|recent_stories|entities)"
                        r"|extract-config)",
                        suffix,
                    )
                    is not None
                )
                or (
                    method == "POST"
                    and re.fullmatch(
                        r"memory/(?:(?:atoms|raw_events|entities|episodes|journal|candidates)/list"
                        r"|candidates/[^/]+:(?:promote|reject)|atoms/[^/]+:(?:replace|deprecate))",
                        suffix,
                    )
                    is not None
                )
            )
        elif _ZHIJUN_THREAD.fullmatch(suffix):
            allowed = method in {"GET", "POST", "PATCH", "DELETE"}
    if method == "WEBSOCKET" and path == "/api/notifications/ws":
        allowed = True
    if not allowed:
        raise OctopError(ErrorCode.NOT_FOUND, "application resource not found")


def _assert_registered_request(server: Any, user: Any, *, path: str, method: str) -> None:
    from octop.infra.applications.service import assert_product_login

    app_id = application_id(user)
    assert_product_login(server.services, user.id, app_id)
    product = server.services.application_repo.get(app_id)
    if product is None:
        raise OctopError.localized(ErrorCode.AUTH_FAILED)
    caps = set(product.capabilities)
    if "model_settings" in caps and (
        (method, path)
        in {
            ("GET", "/api/providers/presets"),
            ("GET", "/api/providers/resolved"),
            ("GET", "/api/admin/providers"),
            ("POST", "/api/admin/providers"),
            ("POST", "/api/admin/providers/test-draft"),
        }
        or (method == "PATCH" and re.fullmatch(r"/api/admin/providers/\d+", path))
        or (method == "POST" and re.fullmatch(r"/api/admin/providers/\d+/test", path))
    ):
        # Native provider routes retain their existing account permission checks.
        return
    if "teams" in caps:
        if re.fullmatch(r"/api/teams(?:/[^/]+)?", path) and method in {
            "GET",
            "POST",
            "PATCH",
            "DELETE",
        }:
            if path not in {"/api/teams", "/api/teams/template"}:
                row = server.app_runtime.agent_registry.get_row(path.rsplit("/", 1)[-1])
                if row is None or application_id(row) != app_id or row.user_id != user.id:
                    raise OctopError.localized(ErrorCode.NOT_FOUND)
            return
        if path == "/api/agents" and method in {"GET", "POST"}:
            return
        if path == "/api/providers/resolved" and method == "GET":
            return
        agent_match = _AGENT_PATH.fullmatch(path)
        if agent_match and not agent_match.group(2) and method == "PATCH":
            return
    if "brainstorm" in caps and re.fullmatch(
        r"/api/brainstorm(?:/profile|/experts/[^/]+/import|/sessions(?:/[^/]+(?:/control|/sources|/report(?:/document)?)?)?)",
        path,
    ):
        return
    if (
        "brainstorm" in caps
        and method == "GET"
        and re.fullmatch(r"/api/experts/hub(?:/[^/]+)?", path)
    ):
        return
    allowed = (method, path) in {
        ("GET", "/api/auth/me"),
        ("POST", "/api/auth/logout"),
        ("GET", "/api/settings/timezone"),
        ("GET", "/api/settings/capabilities"),
    }
    if path == f"/api/applications/{app_id}/release":
        allowed = method == "GET"
    if path == f"/api/applications/{app_id}/profile":
        allowed = method in {"GET", "POST"}
    if "upload" in caps and (method, path) == ("GET", "/api/settings/upload"):
        allowed = True
    if "voice" in caps and (method, path) in {
        ("GET", "/api/voice/stt/capability"),
        ("POST", "/api/voice/stt"),
    }:
        allowed = True
    if "knowledge" in caps:
        if path in {
            "/api/knowledge-bases",
            "/api/knowledge-bases/capability",
            "/api/knowledge-bases/default-open",
        }:
            allowed = method == "GET" or (path == "/api/knowledge-bases" and method == "POST")
        knowledge = _ZHIJUN_KNOWLEDGE.fullmatch(path)
        if knowledge:
            base = server.services.knowledge_repo.get_base(knowledge.group(1), application_id=None)
            if base is None or base.application_id != app_id or base.owner_user_id != user.id:
                raise OctopError.localized(ErrorCode.KNOWLEDGE_NOT_FOUND)
            suffix = knowledge.group(2) or ""
            allowed = (
                (not suffix and method in {"GET", "PATCH", "DELETE"})
                or (suffix == "documents" and method in {"GET", "POST"})
                or (suffix == "documents/page" and method == "GET")
                or (suffix == "reindex" and method == "POST")
                or (
                    method == "GET"
                    and re.fullmatch(r"documents/[^/]+/(?:preview|file|content|text/page)", suffix)
                    is not None
                )
                or (
                    method == "POST"
                    and re.fullmatch(r"documents/[^/]+/reindex", suffix) is not None
                )
                or (method == "DELETE" and re.fullmatch(r"documents/[^/]+", suffix) is not None)
            )
    match = _AGENT_PATH.fullmatch(path)
    if match:
        suffix = match.group(2) or ""
        if (method, suffix) in {("GET", ""), ("GET", "status"), ("POST", "start")}:
            allowed = True
        elif suffix.startswith("memory/"):
            allowed = "memory" in caps and method in {"GET", "POST", "PUT", "DELETE"}
        elif suffix.startswith("upload"):
            allowed = "upload" in caps and (method, suffix) in {
                ("POST", "upload"),
                ("GET", "upload/source"),
            }
        elif "chat" in caps:
            allowed = (
                ((method, suffix) in _ZHIJUN_AGENT and "upload" not in suffix)
                or (
                    method in {"GET", "POST", "PATCH", "DELETE"}
                    and _ZHIJUN_THREAD.fullmatch(suffix) is not None
                )
                or (method == "WEBSOCKET" and suffix == "chat/ws")
            )
    if method == "WEBSOCKET" and path == "/api/notifications/ws":
        allowed = "chat" in caps
    if not allowed:
        raise OctopError.localized(ErrorCode.NOT_FOUND)
