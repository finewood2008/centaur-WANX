"""Finite public/private route classification; resource ownership stays in native domains."""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlsplit

from .observations import raw_target
from .protocol import DataProtocolError, need, validate_target
from .team import team_resource

MIB = 1024 * 1024
ID = r"[A-Za-z0-9_-]{1,128}"
APPLICATION_ID = r"[a-z][a-z0-9.-]{0,127}"
FILE = r"[0-9a-f]{32}"
APPLICATION_FAMILIES = {
    "wanx-host": frozenset(
        {
            "identity",
            "assets",
            "space",
            "clipboard",
            "agents",
            "chat",
            "dialogue",
            "assistant",
            "browser",
            "semantica",
            "platform",
            "team-management",
            "team-resources",
            "studio",
            "knowledge",
            "company-catalog",
        }
    ),
    "centaurai.wanx.ai-browser": frozenset({"identity", "assets", "agents", "chat", "browser"}),
    "centaurai.wanx.centaurloop": frozenset({"identity", "assets", "agents", "chat"}),
    "centaurai.wanx.superadvisors": frozenset({"identity", "assets", "agents", "chat", "dialogue"}),
    "centaurai.wanx.dialogue": frozenset(
        {"identity", "assets", "dialogue", "assistant", "agents", "chat"}
    ),
    "centaurai.wanx.zhijun": frozenset({"identity", "assets", "agents", "chat"}),
    "centaurai.wanx.semantica": frozenset({"identity", "assets", "semantica"}),
    "centaurai.wanx.new-media-toolkit": frozenset({"identity", "assets", "agents", "chat"}),
    "centaurai.wanx.huohua-publisher": frozenset({"identity", "assets", "agents", "chat"}),
    "ai.wanx.studio": frozenset(
        {
            "identity",
            "assets",
            "agents",
            "chat",
            "browser",
            "studio",
            "team-management",
            "knowledge",
            "company-catalog",
            "company-runtime",
        }
    ),
}


def application_families(application_id):
    if type(application_id) is str and re.fullmatch(
        r"ai\.wanx\.selfmade\.[a-f0-9]{32}", application_id
    ):
        return frozenset({"identity", "company-runtime"})
    return APPLICATION_FAMILIES.get(application_id)


# method, anchored path, family, action, body cap. Host terminal/desktop/mobile,
# admin, provider configuration, login/OIDC/exchange and internal MCP are absent.
# Assistant metadata exposes only model identifiers and timezone, never credentials.
# Local chat cannot acquire MCP, external knowledge or channel authority.
OCTOP_RULES = (
    ("GET", r"/api/app-studio/(?:engines|preflight|_client/launch/sources)", "studio", "read", 0),
    ("GET", rf"/api/app-studio/_client/projects/{FILE}/runtime-model", "studio", "read", 0),
    ("PUT", rf"/api/app-studio/_client/projects/{FILE}/runtime-model", "studio", "write", MIB),
    ("PUT", r"/api/app-studio/engines/default", "studio", "write", MIB),
    ("POST", r"/api/app-studio/engines/check", "studio", "execute", MIB),
    ("PUT", rf"/api/app-studio/projects/{FILE}/engine", "studio", "write", MIB),
    ("POST", r"/api/app-studio/_client/launch/(?:suggest|configure)", "studio", "write", 2 * MIB),
    ("POST", rf"/api/app-studio/_client/launch/{FILE}/start", "studio", "execute", 2 * MIB),
    (
        "POST",
        rf"/api/app-studio/_client/launch/{FILE}/archive/[a-f0-9]{{64}}",
        "studio",
        "write",
        2 * MIB,
    ),
    ("POST", rf"/api/app-studio/projects/{FILE}/runtime", "studio", "execute", 2 * MIB),
    (
        "GET",
        r"/api/app-studio/apps/ai\.wanx\.selfmade\.[a-f0-9]{32}(?:/install)?",
        "company-catalog",
        "read",
        0,
    ),
    (
        "POST",
        r"/api/app-studio/apps/ai\.wanx\.selfmade\.[a-f0-9]{32}/runtime",
        "company-runtime",
        "execute",
        2 * MIB,
    ),
    (
        "POST",
        rf"/api/app-studio/runtime/{ID}/(?:invoke|files)",
        "company-runtime",
        "execute",
        2 * MIB,
    ),
    ("DELETE", rf"/api/app-studio/runtime/{ID}", "company-runtime", "execute", 0),
    ("GET", r"/api/admin/applications", "team-management", "read", 0),
    ("POST", r"/api/admin/applications", "team-management", "write", 2 * MIB),
    (
        "GET",
        rf"/api/admin/applications/{APPLICATION_ID}(?:/(?:deployment|access|manifest))?",
        "team-management",
        "read",
        0,
    ),
    ("PATCH", rf"/api/admin/applications/{APPLICATION_ID}", "team-management", "write", 2 * MIB),
    (
        "PUT",
        rf"/api/admin/applications/{APPLICATION_ID}/(?:deployment|access)",
        "team-management",
        "write",
        2 * MIB,
    ),
    ("GET", r"/api/team/resources", "team-resources", "read", 0),
    ("POST", r"/api/team/resources", "team-resources", "write", MIB),
    (
        "GET",
        r"/api/app-studio/(?:context|capabilities|context/sources|projects|files|_builder/context)",
        "studio",
        "read",
        0,
    ),
    ("POST", r"/api/app-studio/projects", "studio", "write", MIB),
    (
        "GET",
        rf"/api/app-studio/projects/{FILE}(?:/(?:intake|context|capabilities|interview|interview/events|intake/events|versions|events))?",
        "studio",
        "read",
        0,
    ),
    (
        "GET",
        rf"/api/app-studio/projects/{FILE}/(?:tasks/{FILE}/events|versions/[a-f0-9]{{64}}(?:/restore-check)?|install/[a-f0-9]{{64}})",
        "studio",
        "read",
        0,
    ),
    (
        "POST",
        rf"/api/app-studio/projects/{FILE}/(?:intake|context/read|context/search|capabilities/decisions|capabilities/check|intake/handoff|chat|interview/start|decisions|confirm|adopt|restore-version|accept|installed|iterations|tasks/{FILE}/cancel)",
        "studio",
        "write",
        2 * MIB,
    ),
    (
        "PUT",
        rf"/api/app-studio/projects/{FILE}/(?:metadata|solution|feedback|context)",
        "studio",
        "write",
        2 * MIB,
    ),
    (
        "POST",
        rf"/api/app-studio/(?:_builder/)?projects/{FILE}/(?:build|interview/turns|edits|edits/{FILE}/(?:answer|retry))",
        "studio",
        "execute",
        2 * MIB,
    ),
    (
        "POST",
        rf"/api/app-studio/_builder/projects/{FILE}/(?:restore-version|edits/heartbeat|edits/stop|edits/{FILE}/stop)",
        "studio",
        "write",
        2 * MIB,
    ),
    ("GET", rf"/api/app-studio/_builder/projects/{FILE}/(?:proposal|edits)", "studio", "read", 0),
    ("GET", r"/api/knowledge-bases", "knowledge", "read", 0),
    ("POST", r"/api/knowledge-bases", "knowledge", "write", 2 * MIB),
    (
        "GET",
        r"/api/knowledge-bases/[A-Z0-9]{6}(?:/(?:documents|documents/page|documents/[A-Za-z0-9_-]+/(?:preview|file|content|text/page)))?",
        "knowledge",
        "read",
        0,
    ),
    ("PATCH", r"/api/knowledge-bases/[A-Z0-9]{6}", "knowledge", "write", 2 * MIB),
    ("POST", r"/api/knowledge-bases/[A-Z0-9]{6}/documents", "knowledge", "write", 100 * MIB),
    (
        "POST",
        r"/api/knowledge-bases/[A-Z0-9]{6}/(?:reindex|documents/[A-Za-z0-9_-]+/reindex)",
        "knowledge",
        "execute",
        MIB,
    ),
    (
        "DELETE",
        r"/api/knowledge-bases/[A-Z0-9]{6}(?:/documents/[A-Za-z0-9_-]+)?",
        "knowledge",
        "write",
        0,
    ),
    ("GET", r"/api/auth/me", "identity", "read", 0),
    ("PATCH", r"/api/auth/me", "identity", "write", MIB),
    ("POST", r"/api/auth/me/avatar", "identity", "write", 8 * MIB),
    ("DELETE", r"/api/auth/me/avatar", "identity", "write", 0),
    ("GET", r"/api/preferences", "identity", "read", 0),
    ("PATCH", r"/api/preferences", "identity", "write", MIB),
    ("POST", r"/api/platform/applications/readiness", "platform", "read", MIB),
    (
        "POST",
        r"/api/platform/applications/(?:prepare|candidates/prepare)",
        "platform",
        "write",
        MIB,
    ),
    ("GET", r"/(?:assets/[A-Za-z0-9_./-]+|favicon\.ico|manifest\.json)?", "assets", "read", 0),
    ("GET", r"/api/personal-space/(?:overview|files|spaces|agent-links)", "space", "read", 0),
    (
        "GET",
        rf"/api/personal-space/(?:files/{FILE}(?:/content)?|uploads/{FILE}|agent-links/{ID}/audit)",
        "space",
        "read",
        0,
    ),
    (
        "POST",
        r"/api/personal-space/(?:folders|uploads|app-folders|agent-links)",
        "space",
        "write",
        MIB,
    ),
    ("POST", r"/api/personal-space/(?:agent-access|connection-access)", "space", "read", MIB),
    (
        "POST",
        rf"/api/personal-space/(?:uploads/{FILE}/complete|files/{FILE}/previous|trash/{FILE}/restore)",
        "space",
        "write",
        MIB,
    ),
    ("PATCH", rf"/api/personal-space/files/{FILE}", "space", "write", MIB),
    ("PUT", rf"/api/personal-space/uploads/{FILE}", "space", "write", 4 * MIB),
    (
        "DELETE",
        rf"/api/personal-space/(?:files/{FILE}|uploads/{FILE}|trash/{FILE}|agent-links/{ID})",
        "space",
        "write",
        0,
    ),
    ("GET", r"/api/agents", "agents", "read", 0),
    ("POST", r"/api/agents", "agents", "write", 2 * MIB),
    (
        "GET",
        rf"/api/agents/{ID}(?:/(?:avatar|status|interaction-preferences|tool-settings))?",
        "agents",
        "read",
        0,
    ),
    ("PATCH", rf"/api/agents/{ID}", "agents", "write", 2 * MIB),
    ("DELETE", rf"/api/agents/{ID}(?:/(?:avatar|interaction-preferences))?", "agents", "write", 0),
    ("POST", rf"/api/agents/{ID}/(?:start|stop|reload)", "agents", "execute", MIB),
    ("POST", rf"/api/agents/{ID}/read", "agents", "read", MIB),
    ("POST", rf"/api/agents/{ID}/avatar", "agents", "write", 8 * MIB),
    (
        "PUT",
        rf"/api/agents/{ID}/(?:interaction-preferences|zhijun-profile|tool-settings)",
        "agents",
        "write",
        2 * MIB,
    ),
    (
        "GET",
        rf"/api/agents/{ID}/(?:workspace/(?:tree|file|doc|glob|grep|archive|download)|media/preview|upload/source)",
        "agents",
        "read",
        0,
    ),
    ("PUT", rf"/api/agents/{ID}/workspace/(?:file|doc)", "agents", "write", 100 * MIB),
    ("POST", rf"/api/agents/{ID}/workspace/(?:mkdir|move)", "agents", "write", 2 * MIB),
    ("POST", rf"/api/agents/{ID}/(?:workspace/upload|upload)", "agents", "write", 100 * MIB),
    ("POST", rf"/api/agents/{ID}/workspace/archive", "agents", "write", 200 * MIB),
    ("DELETE", rf"/api/agents/{ID}/workspace/file", "agents", "write", 0),
    ("GET", rf"/api/agents/{ID}/(?:threads|chat/welcome)", "chat", "read", 0),
    (
        "GET",
        rf"/api/agents/{ID}/threads/{ID}/(?:context-usage|history(?:/export)?|trajectory(?:/(?:metrics|stream|export|events/{ID}))?)",
        "chat",
        "read",
        0,
    ),
    ("POST", rf"/api/agents/{ID}/threads(?:/{ID}/fork)?", "chat", "write", 2 * MIB),
    ("POST", rf"/api/agents/{ID}/threads/{ID}/read", "chat", "read", MIB),
    ("PATCH", rf"/api/agents/{ID}/(?:session|threads/{ID})", "chat", "write", MIB),
    ("DELETE", rf"/api/agents/{ID}/threads/{ID}", "chat", "write", 0),
    ("POST", rf"/api/agents/{ID}/chat/(?:hitl/resume|polish)", "chat", "execute", 2 * MIB),
    ("WS", rf"/api/agents/{ID}/chat/ws", "chat", "execute", 0),
    ("WS", r"/api/notifications/ws", "chat", "read", 0),
    ("GET", r"/api/dialogue/(?:models|quota|sessions)", "dialogue", "read", 0),
    ("GET", rf"/api/dialogue/sessions/{ID}(?:/events)?", "dialogue", "read", 0),
    ("POST", r"/api/dialogue/sessions", "dialogue", "write", 2 * MIB),
    ("DELETE", rf"/api/dialogue/sessions/{ID}", "dialogue", "write", 0),
    (
        "POST",
        rf"/api/dialogue/sessions/{ID}/(?:groups/{ID}/answers|answers/{ID}/(?:continue|retry|stop))",
        "dialogue",
        "execute",
        2 * MIB,
    ),
    ("GET", r"/api/browser/control-capabilities", "browser", "read", 0),
    ("GET", r"/api/providers/(?:resolved|active-model)", "assistant", "read", 0),
    ("GET", r"/api/settings/timezone", "assistant", "read", 0),
    ("POST", r"/api/assistant/profile", "assistant", "execute", 0),
    ("GET", r"/api/assistant/(?:conversations|history)", "assistant", "read", 0),
    ("GET", rf"/api/assistant/conversations/{ID}", "assistant", "read", 0),
    ("POST", r"/api/assistant/(?:context/validate|history)", "assistant", "write", MIB),
    ("PATCH", rf"/api/assistant/conversations/{ID}", "assistant", "write", MIB),
    ("POST", rf"/api/assistant/conversations/{ID}/(?:open|versions)", "assistant", "write", MIB),
)

QUERY_KEYS = {
    "company-catalog": frozenset(),
    "company-runtime": frozenset(),
    "team-management": frozenset(),
    "team-resources": frozenset(),
    "studio": frozenset({"after", "cursor", "limit", "parent", "offset"}),
    "knowledge": frozenset({"limit", "offset", "prefix", "page", "page_size"}),
    "identity": frozenset(),
    "assets": frozenset({"v"}),
    "platform": frozenset(),
    "space": frozenset({"parent", "trash", "space_id", "offset", "length", "limit", "cursor"}),
    "agents": frozenset(
        {
            "path",
            "depth",
            "recursive",
            "overwrite",
            "query",
            "pattern",
            "glob",
            "case_sensitive",
            "max_results",
            "limit",
            "offset",
            "format",
            "download",
            "inline",
            "source",
            "file",
        }
    ),
    "chat": frozenset(
        {
            "limit",
            "offset",
            "cursor",
            "before",
            "after",
            "format",
            "include_tools",
            "include_system",
            "run_id",
            "after_sequence",
        }
    ),
    "dialogue": frozenset({"limit", "offset", "cursor", "after", "after_sequence"}),
    "assistant": frozenset(),
    "browser": frozenset({"agent_id", "session_id", "listen_only", "interactive"}),
}


def query_values(target):
    validate_target(target)
    query = {}
    for name, value in parse_qsl(urlsplit(target).query, keep_blank_values=True):
        need(name not in query, "LOCAL_DATA_ROUTE_DENIED")
        query[name] = value
    return query


def classify_octop(method, target, transport, application_id, data_context=None):
    validate_target(target)
    families = application_families(application_id)
    need(families is not None, "LOCAL_DATA_ROUTE_DENIED")
    path = urlsplit(target).path
    verb = "WS" if transport == "websocket" and method == "GET" else method
    need(transport in ("http", "websocket"), "LOCAL_DATA_ROUTE_DENIED")
    for allowed, pattern, family, action, body_limit in OCTOP_RULES:
        if (allowed == verb or method == "HEAD" and allowed == "GET") and re.fullmatch(
            pattern, path
        ):
            need(family in families, "LOCAL_DATA_ROUTE_DENIED")
            if (
                "company-runtime" in families
                and application_id != "ai.wanx.studio"
                and family == "identity"
            ):
                need(
                    path == "/api/auth/me" and method in {"GET", "HEAD"}, "LOCAL_DATA_ROUTE_DENIED"
                )
            query = query_values(target)
            allowed_query = QUERY_KEYS[family]
            if (
                family == "studio"
                and method in {"GET", "HEAD"}
                and re.fullmatch(
                    rf"/api/app-studio/projects/{FILE}/versions/[a-f0-9]{{64}}/restore-check", path
                )
            ):
                allowed_query = allowed_query | {"comparisonHash"}
                if "comparisonHash" in query:
                    need(
                        re.fullmatch(r"[a-f0-9]{64}", query["comparisonHash"]) is not None,
                        "LOCAL_DATA_ROUTE_DENIED",
                    )
            need(set(query) <= allowed_query, "LOCAL_DATA_ROUTE_DENIED")
            selected = team_resource(data_context)
            need(
                data_context in (None, "personal") or selected is not None,
                "LOCAL_DATA_SCOPE_DENIED",
            )
            resource = (
                "team:management"
                if family in {"team-management", "team-resources", "studio"}
                else None
            )
            if family == "company-runtime":
                resource = (
                    "team:management"
                    if application_id == "ai.wanx.studio"
                    else "team:application:" + application_id
                )
                if path.startswith("/api/app-studio/apps/"):
                    need(
                        application_id != "ai.wanx.studio"
                        and path == "/api/app-studio/apps/" + application_id + "/runtime",
                        "LOCAL_DATA_SCOPE_DENIED",
                    )
            if family == "company-catalog":
                resource = "team:application:" + path.split("/")[4]
                need(data_context == resource, "LOCAL_DATA_SCOPE_DENIED")
            if selected is not None:
                kind, identifier = selected
                need(
                    (
                        family == "company-runtime"
                        and kind == "application"
                        and identifier == application_id
                    )
                    or (family == "company-catalog" and data_context == resource)
                    or family == "identity"
                    and kind == "application"
                    and identifier == application_id
                    or (
                        family == "identity"
                        and path == "/api/auth/me"
                        and method in {"GET", "HEAD"}
                        and kind == "knowledge"
                        and re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", identifier)
                        is not None
                    )
                    or (family == "space" and kind == "space")
                    or (
                        family in {"agents", "chat"}
                        and kind == "agent"
                        and re.fullmatch(rf"/api/agents/{re.escape(identifier)}(?:/.*)?", path)
                    )
                    or (
                        family == "knowledge"
                        and kind == "knowledge"
                        and re.fullmatch(r"[A-Z0-9]{6}", identifier) is not None
                        and (
                            path == "/api/knowledge-bases"
                            or path.startswith("/api/knowledge-bases/" + identifier + "/")
                            or path == "/api/knowledge-bases/" + identifier
                        )
                    ),
                    "LOCAL_DATA_SCOPE_DENIED",
                )
                resource = data_context
                if family == "space":
                    need(
                        re.fullmatch(
                            r"/api/personal-space/(?:files(?:/.*)?|folders|uploads(?:/.*)?|trash/.*|spaces)",
                            path,
                        )
                        is not None,
                        "LOCAL_DATA_SCOPE_DENIED",
                    )
            if family == "space":
                need(
                    query.get("space_id", selected[1] if selected else "personal")
                    == (selected[1] if selected else "personal"),
                    "LOCAL_DATA_SCOPE_DENIED",
                )
            return {
                "family": family,
                "resourceId": resource
                or (
                    "space:personal"
                    if family == "space"
                    else None
                    if family in ("identity", "assets", "platform")
                    else "wanx"
                ),
                "action": action,
                "bodyLimit": body_limit,
            }
    raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED")


def check_octop_request(scope, claims):
    rule = classify_octop(
        scope.get("method", "GET"),
        raw_target(scope),
        scope["type"],
        claims["applicationId"],
        claims["headers"]["dataContext"],
    )
    need(
        claims["audience"] == "octop"
        and claims["action"] == rule["action"]
        and claims["bodyBytes"] <= rule["bodyLimit"],
        "LOCAL_DATA_SCOPE_DENIED",
    )
    accepted = (
        {"wanx", "space", "space:personal"}
        if rule["resourceId"] == "space:personal"
        else {rule["resourceId"]}
    )
    if rule["resourceId"] is None:
        accepted = {"wanx", "space", "space:personal", "clipboard", "semantica"}
        if claims.get("team") is not None and team_resource(claims["resourceId"]):
            accepted.add(claims["resourceId"])
    if rule["family"] == "space" and claims["serviceContext"]["clipboardScope"] is not None:
        accepted.add("clipboard")
    need(claims["resourceId"] in accepted, "LOCAL_DATA_SCOPE_DENIED")
    if team_resource(claims["resourceId"]):
        need(claims.get("team") is not None, "LOCAL_DATA_SCOPE_DENIED")
    permission = (
        "resources.manage"
        if rule["family"] == "team-resources"
        else "applications.manage"
        if rule["family"] in {"team-management", "studio"}
        or rule["family"] == "company-runtime"
        and rule["resourceId"] == "team:management"
        else None
    )
    if permission:
        need(permission in claims.get("team", {}).get("permissions", []), "LOCAL_DATA_SCOPE_DENIED")
    return rule
