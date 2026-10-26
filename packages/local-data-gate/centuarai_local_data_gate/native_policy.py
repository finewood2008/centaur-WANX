"""Finite public/private route classification; resource ownership stays in native domains."""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlsplit

from .observations import raw_target
from .protocol import DataProtocolError, need, validate_target

MIB = 1024 * 1024
ID = r"[A-Za-z0-9_-]{1,128}"
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
            "browser",
            "semantica",
            "platform",
        }
    ),
    "centaurai.wanx.ai-browser": frozenset({"identity", "assets", "agents", "chat", "browser"}),
    "centaurai.wanx.centaurloop": frozenset({"identity", "assets", "agents", "chat"}),
    "centaurai.wanx.superadvisors": frozenset({"identity", "assets", "agents", "chat", "dialogue"}),
    "centaurai.wanx.dialogue": frozenset({"identity", "assets", "dialogue"}),
    "centaurai.wanx.zhijun": frozenset({"identity", "assets", "agents", "chat"}),
    "centaurai.wanx.semantica": frozenset({"identity", "assets", "semantica"}),
    "centaurai.wanx.new-media-toolkit": frozenset({"identity", "assets", "agents", "chat"}),
    "centaurai.wanx.huohua-publisher": frozenset({"identity", "assets", "agents", "chat"}),
    "ai.wanx.studio": frozenset({"identity", "assets", "agents", "chat", "browser"}),
}

# method, anchored path, family, action, body cap. Host terminal/desktop/mobile,
# admin, provider/settings, login/OIDC/exchange and internal MCP are absent.
OCTOP_RULES = (
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
)

QUERY_KEYS = {
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
    "browser": frozenset({"agent_id", "session_id", "listen_only", "interactive"}),
}


def query_values(target):
    validate_target(target)
    query = {}
    for name, value in parse_qsl(urlsplit(target).query, keep_blank_values=True):
        need(name not in query, "LOCAL_DATA_ROUTE_DENIED")
        query[name] = value
    return query


def classify_octop(method, target, transport, application_id):
    validate_target(target)
    families = APPLICATION_FAMILIES.get(application_id)
    need(families is not None, "LOCAL_DATA_ROUTE_DENIED")
    path = urlsplit(target).path
    verb = "WS" if transport == "websocket" and method == "GET" else method
    need(transport in ("http", "websocket"), "LOCAL_DATA_ROUTE_DENIED")
    for allowed, pattern, family, action, body_limit in OCTOP_RULES:
        if (allowed == verb or method == "HEAD" and allowed == "GET") and re.fullmatch(
            pattern, path
        ):
            need(family in families, "LOCAL_DATA_ROUTE_DENIED")
            query = query_values(target)
            need(set(query) <= QUERY_KEYS[family], "LOCAL_DATA_ROUTE_DENIED")
            need(query.get("space_id", "personal") == "personal", "LOCAL_DATA_SCOPE_DENIED")
            return {
                "family": family,
                "resourceId": "space:personal"
                if family == "space"
                else None
                if family in ("identity", "assets", "platform")
                else "wanx",
                "action": action,
                "bodyLimit": body_limit,
            }
    raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED")


def check_octop_request(scope, claims):
    rule = classify_octop(
        scope.get("method", "GET"), raw_target(scope), scope["type"], claims["applicationId"]
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
    if rule["family"] == "space" and claims["serviceContext"]["clipboardScope"] is not None:
        accepted.add("clipboard")
    need(claims["resourceId"] in accepted, "LOCAL_DATA_SCOPE_DENIED")
    need(claims["headers"]["dataContext"] in (None, "personal"), "LOCAL_DATA_SCOPE_DENIED")
    return rule
