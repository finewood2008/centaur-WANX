"""Required-mode routes. Unknown applications, scopes and operations are denied."""

from __future__ import annotations

import copy
import json
import math
import re
from urllib.parse import urlsplit
from uuid import UUID, uuid5

from centuarai_local_data_gate.native_policy import (
    FILE,
    ID,
    MIB,
    application_families,
    classify_octop,
    query_values,
)
from centuarai_local_data_gate.team import resource_binding_route, team_resource

from .local_data_protocol import DataProtocolError, grants, need

METADATA_PATHS = frozenset({"/api/platform/assets/manifest", "/api/platform/version"})
RESOURCES = frozenset({"wanx", "space", "space:personal", "clipboard", "semantica"})
MCP_OPERATIONS = {
    "initialize": "mcp_initialize",
    "notifications/initialized": "mcp_initialized",
    "ping": "mcp_ping",
    "tools/list": "mcp_tools_list",
}
MCP_TOOLS = frozenset({"search_knowledge", "search_workspaces", "get_evidence", "retrieval_status"})
SEMANTICA_RULES = (
    ("GET", "/capabilities", "get_capabilities", "read"),
    ("GET", "/status", "get_status", "read"),
    ("GET", "/documents", "list_documents", "read"),
    ("GET", "/jobs", "list_jobs", "read"),
    ("GET", "/retrieval/status", "retrieval_status", "read"),
    ("POST", "/retrieval/indexes", "build_index", "write"),
    ("POST", "/documents", "upload_document", "write"),
    ("GET", rf"/documents/{ID}", "get_document", "read"),
    ("GET", rf"/documents/{ID}/text", "get_document_text", "read"),
    ("GET", rf"/documents/{ID}/blob", "get_document_blob", "read"),
    ("PUT", rf"/documents/{ID}/text", "replace_text_document", "write"),
    ("POST", rf"/documents/{ID}/extraction", "reextract_document", "write"),
    ("DELETE", rf"/documents/{ID}", "delete_document", "write"),
    ("GET", rf"/operations/{ID}", "get_operation_result", "read"),
    ("GET", rf"/jobs/{ID}", "get_job", "read"),
    ("POST", rf"/jobs/{ID}/retry", "retry_job", "write"),
    ("POST", rf"/jobs/{ID}/cancel", "cancel_job", "write"),
    ("POST", "/imports", "begin_import", "write"),
    ("PATCH", rf"/imports/{ID}", "append_import", "write"),
    ("POST", rf"/imports/{ID}/commit", "commit_import", "write"),
    ("POST", "/search", "search_knowledge", "read"),
    ("POST", "/search/workspaces", "search_workspaces", "read"),
    ("GET", rf"/evidence/{ID}", "get_evidence", "read"),
    ("GET", "/graph", "get_graph", "read"),
    ("GET", "/owner/graph", "owner_graph", "read"),
    ("GET", "/ontologies", "list_ontologies", "read"),
    ("POST", "/ontologies", "create_ontology", "write"),
    ("POST", rf"/ontologies/{ID}/publish", "publish_ontology", "write"),
)
CLIPBOARD_RULES = (
    ("GET", r"(?:/note)?", "read", 0),
    ("PUT", r"/note", "write", 2 * MIB),
    ("POST", r"/(?:batches|manage)", "write", 2 * MIB),
    ("GET", rf"/{FILE}(?:/content)?", "read", 0),
    ("PUT", rf"/{FILE}/content", "write", 4 * MIB),
    ("POST", rf"/{FILE}/(?:complete|export)", "write", MIB),
    ("POST", r"/agent-access", "read", MIB),
)


def business_object(raw):
    def pairs(items):
        value = {}
        for name, item in items:
            need(name not in value)
            value[name] = item
        return value

    def constant(_):
        raise DataProtocolError()

    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
        need(type(value) is dict)

        def depth(item, level=0):
            need(level <= 32)
            need(type(item) is not float or math.isfinite(item))
            for child in (
                item.values() if type(item) is dict else item if type(item) is list else ()
            ):
                depth(child, level + 1)

        depth(value)
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise DataProtocolError() from None


def _allows(values, resource, action):
    aliases = {"space", "space:personal"}
    return any(
        action in item["actions"]
        and (
            item["resourceId"] == resource
            or item["resourceId"] in aliases
            and resource in aliases
            or item["resourceId"] == "wanx"
            and resource in {"space", "space:personal", "clipboard"}
        )
        for item in values
    )


def _resource(context, resource, action):
    if resource is None:
        resource = next(
            (
                item["resourceId"]
                for item in context["grants"]
                if (
                    item["resourceId"] in RESOURCES
                    or context.get("team")
                    and team_resource(item["resourceId"])
                )
                and action in item["actions"]
            ),
            None,
        )
    need(
        resource is not None and _allows(context["grants"], resource, action),
        "LOCAL_DATA_FORBIDDEN",
    )
    return resource


def application_policy(application_id, launch_id, view):
    families = application_families(application_id)
    need(families is not None, "LOCAL_DATA_ROUTE_DENIED")
    allowed = (
        RESOURCES
        if application_id == "wanx-host"
        else {"semantica"}
        if "semantica" in families
        else {"wanx"}
    )
    if re.fullmatch(r"ai\.wanx\.selfmade\.[a-f0-9]{32}", application_id):
        need(
            view.get("team") is not None
            and any(
                value["resourceId"] == "team:application:" + application_id
                for value in view["grants"]
            ),
            "LOCAL_DATA_FORBIDDEN",
        )
        result = []
        for value in view["grants"]:
            if not view.get("team"):
                continue
            if value["resourceId"] == "team:application:" + application_id:
                result.append(copy.deepcopy(value))
            elif "read" in value["actions"] and (
                value["resourceId"] in {"semantica", "wanx"}
                or (team_resource(value["resourceId"]) or (None,))[0] == "knowledge"
            ):
                # No direct data route exists for this application family.
                # Native published-manifest resolution must further freeze the
                # exact sources before the broker permits any read child hop.
                result.append({"resourceId": value["resourceId"], "actions": ["read"]})
        grants(result)
        return result
    result = [
        copy.deepcopy(value)
        for value in view["grants"]
        if value["resourceId"] in allowed
        or view.get("team")
        and team_resource(value["resourceId"])
        and (
            application_id in {"wanx-host", "ai.wanx.studio"}
            or "semantica" in families
            and value["resourceId"].startswith("team:knowledge:")
        )
    ]
    grants(result)
    return result


def _warehouse(context, operation, resource=None):
    selected = team_resource(resource)
    name = json.dumps(
        [
            context["boxId"],
            "semantica",
            "team:" + str(context["ownershipEpoch"]) + ":knowledge:" + selected[1]
            if selected
            else "local:" + context["principalNamespace"],
        ],
        separators=(",", ":"),
    )
    return {
        "kind": "warehouse",
        "principalNamespace": context["principalNamespace"],
        "workspaceId": str(uuid5(UUID("8ae54f40-4054-4bba-a2e2-06e1c43d7514"), name)),
        "warehouseId": selected[1] if selected else None,
        "operation": operation,
    }


def _result(context, audience, resource, action, limit, target, service):
    return {
        "audience": audience,
        "resourceId": _resource(context, resource, action),
        "action": action,
        "bodyLimit": limit,
        "upstreamPath": target,
        "serviceContext": service,
    }


def _semantica(context, observation, *, native=False):
    target = observation["rawTarget"]
    path = urlsplit(target).path
    prefix = "/api/integration" if native else "/api/semantica"
    suffix = path[len(prefix) :]
    resource = observation["headers"]["dataContext"]
    selected = team_resource(resource)
    if selected:
        need(
            selected[0] == "knowledge" and context.get("team") is not None,
            "LOCAL_DATA_SCOPE_DENIED",
        )
        need(
            re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", selected[1]) is not None,
            "LOCAL_DATA_SCOPE_DENIED",
        )
    else:
        resource = "semantica"
    query = query_values(target)
    need(
        set(query)
        <= {
            "limit",
            "offset",
            "entity_id",
            "segment_offset",
            "segment_limit",
            "version_id",
            "start",
            "end",
            "length",
            "page_number",
            "expected_sha256",
            "expected_origin_revision",
            "expected_version_id",
            "warehouse_id",
        },
        "LOCAL_DATA_ROUTE_DENIED",
    )
    if "warehouse_id" in query:
        need(
            selected is not None and query["warehouse_id"] == selected[1], "LOCAL_DATA_SCOPE_DENIED"
        )
    alias = False
    if selected and suffix.startswith("/warehouses/"):
        match = re.fullmatch(r"/warehouses/([^/]+)(/.*)?", suffix)
        need(match is not None and match[1] == selected[1], "LOCAL_DATA_SCOPE_DENIED")
        remainder = match[2] or ""
        if remainder and remainder not in {
            "/clear",
            "/clear/prepare",
            "/delete",
            "/delete/prepare",
        }:
            # Existing warehouse UI aliases map only onto the same finite
            # integration operations. No alias introduces a key/settings API.
            suffix = remainder
            alias = True
    warehouse_rules = (
        (
            ("GET", "/warehouses", "list_warehouses", "read"),
            ("POST", "/warehouses", "create_warehouse", "execute"),
            ("GET", rf"/warehouses/{re.escape(selected[1])}", "get_warehouse", "read"),
            (
                "POST",
                rf"/warehouses/{re.escape(selected[1])}/clear/prepare",
                "prepare_clear_warehouse",
                "execute",
            ),
            ("POST", rf"/warehouses/{re.escape(selected[1])}/clear", "clear_warehouse", "execute"),
            (
                "POST",
                rf"/warehouses/{re.escape(selected[1])}/delete/prepare",
                "prepare_delete_warehouse",
                "execute",
            ),
            (
                "POST",
                rf"/warehouses/{re.escape(selected[1])}/delete",
                "delete_warehouse",
                "execute",
            ),
        )
        if selected
        else ()
    )
    for method, pattern, operation, action in SEMANTICA_RULES + (() if alias else warehouse_rules):
        if method == observation["method"] and re.fullmatch(pattern, suffix):
            if selected:
                need(operation != "owner_graph", "LOCAL_DATA_SCOPE_DENIED")
                if operation in {"build_index", "create_ontology", "publish_ontology"}:
                    action = "execute"
            upstream = target if native else "/api/integration" + target[len(prefix) :]
            if alias:
                upstream = "/api/integration" + suffix
                raw_query = urlsplit(target).query
                if raw_query:
                    upstream += "?" + raw_query
            return _result(
                context,
                "semantica",
                resource,
                action,
                0 if method == "GET" else 2 * MIB,
                upstream,
                _warehouse(context, operation, resource),
            )
    raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED")


def route_policy(context, observation):
    target, method = observation["rawTarget"], observation["method"]
    path = urlsplit(target).path
    query = query_values(target)
    families = application_families(context["applicationId"]) or frozenset()
    selector = observation["headers"]["dataContext"]
    need(
        selector in (None, "personal")
        or team_resource(selector) is not None
        and context.get("team") is not None,
        "LOCAL_DATA_SCOPE_DENIED",
    )
    principal = {
        "kind": "principal",
        "principalNamespace": context["principalNamespace"],
        "clipboardScope": None,
    }
    if path in METADATA_PATHS:
        need(
            "platform" in families
            and method == "GET"
            and observation["transport"] == "http"
            and not query,
            "LOCAL_DATA_ROUTE_DENIED",
        )
        return _result(context, "octop", None, "read", 0, target, principal)
    if path.startswith("/api/clipboard/v1"):
        need(
            "clipboard" in families and observation["transport"] == "http",
            "LOCAL_DATA_ROUTE_DENIED",
        )
        need(
            set(query) <= {"kind", "q", "offset", "trash", "since", "length", "expected", "after"},
            "LOCAL_DATA_ROUTE_DENIED",
        )
        for verb, pattern, action, cap in CLIPBOARD_RULES:
            if method == verb and re.fullmatch("/api/clipboard/v1" + pattern, path):
                return _result(
                    context,
                    "clipboard",
                    "clipboard",
                    action,
                    cap,
                    target,
                    {
                        "kind": "clipboard",
                        "principalNamespace": context["principalNamespace"],
                        "applicationId": context["applicationId"],
                    },
                )
        raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED")
    if path == "/api/semantica/mcp":
        need(
            "semantica" in families
            and method == "POST"
            and observation["transport"] == "http"
            and not query,
            "LOCAL_DATA_ROUTE_DENIED",
        )
        resource = selector if team_resource(selector) else "semantica"
        if resource != "semantica":
            selected = team_resource(resource)
            need(
                selected[0] == "knowledge"
                and re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", selected[1])
                is not None,
                "LOCAL_DATA_SCOPE_DENIED",
            )
        return _result(
            context,
            "semantica-mcp",
            resource,
            "read",
            2 * MIB,
            "/mcp",
            _warehouse(context, "mcp_pending", resource),
        )
    if path.startswith("/api/semantica/"):
        need(
            "semantica" in families and observation["transport"] == "http",
            "LOCAL_DATA_ROUTE_DENIED",
        )
        return _semantica(context, observation)
    # Direct capability access routes carry body-dependent actions. Until their
    # dedicated native resolver exists, only the fixed clipboard child may use them.
    need(
        path not in {"/api/personal-space/agent-access", "/api/personal-space/connection-access"},
        "LOCAL_DATA_ROUTE_DENIED",
    )
    rule = classify_octop(
        method, target, observation["transport"], context["applicationId"], selector
    )
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
        need(
            permission in context.get("team", {}).get("permissions", []), "LOCAL_DATA_SCOPE_DENIED"
        )
    return _result(
        context, "octop", rule["resourceId"], rule["action"], rule["bodyLimit"], target, principal
    )


async def validate_staged(sessions, operation, staging):
    route = operation["route"]
    path = urlsplit(route["upstreamPath"]).path
    if route["audience"] == "clipboard" and re.fullmatch(rf"/api/clipboard/v1/{FILE}/export", path):
        body = business_object(await staging.read(MIB))
        need(
            set(body) <= {"expected", "id", "parent", "space_id"}
            and {"expected", "id"} <= set(body)
            and type(body["expected"]) is int
            and body["expected"] > 0
            and body.get("space_id", "personal") == "personal",
            "LOCAL_DATA_SCOPE_DENIED",
        )
        await sessions.bind_clipboard_export(
            operation["operationId"], export_id=body["id"], parent=body.get("parent", "")
        )
    if route["audience"] == "semantica-mcp":
        body = business_object(await staging.read(2 * MIB))
        need(
            body.get("jsonrpc") == "2.0" and set(body) <= {"jsonrpc", "id", "method", "params"},
            "LOCAL_DATA_ROUTE_DENIED",
        )
        if body.get("method") == "tools/call":
            params = body.get("params")
            need(
                type(params) is dict
                and set(params) <= {"name", "arguments"}
                and type(params.get("name")) is str
                and params.get("name") in MCP_TOOLS
                and type(params.get("arguments", {})) is dict,
                "LOCAL_DATA_ROUTE_DENIED",
            )
            operation_name = params["name"]
        else:
            need(type(body.get("method")) is str, "LOCAL_DATA_ROUTE_DENIED")
            operation_name = MCP_OPERATIONS.get(body.get("method"))
            need(operation_name is not None, "LOCAL_DATA_ROUTE_DENIED")
        await sessions.bind_mcp_operation(operation["operationId"], operation_name)


def child_policy(parent, body):
    context = parent["context"]
    route = parent["route"]
    target = body["rawTarget"]
    path = urlsplit(target).path
    need(body["transport"] == "http", "LOCAL_DATA_ROUTE_DENIED")
    if route["audience"] == "octop" and body["audience"] == "semantica":
        need(
            (
                context["applicationId"] in {"wanx-host", "ai.wanx.studio"}
                and route["resourceId"] == "team:management"
                and "applications.manage" in context.get("team", {}).get("permissions", [])
                and resource_binding_route(parent["observation"]["method"], route["upstreamPath"])
            )
            or (
                re.fullmatch(r"ai\.wanx\.selfmade\.[a-f0-9]{32}", context["applicationId"])
                is not None
                and route["resourceId"] == "team:application:" + context["applicationId"]
                and parent["observation"]["method"] == "POST"
                and re.fullmatch(
                    r"/api/app-studio/runtime/[A-Za-z0-9_-]{1,128}/invoke", route["upstreamPath"]
                )
                is not None
            ),
            "LOCAL_DATA_ROUTE_DENIED",
        )
        resolved = _semantica(context, body, native=True)
        need(
            resolved["action"] == "read"
            and resolved["serviceContext"]["operation"]
            in {
                "list_warehouses",
                "get_warehouse",
                "list_documents",
                "get_document",
                "get_document_text",
                "search_knowledge",
                "search_workspaces",
                "get_evidence",
                "get_graph",
            }
            and _allows(parent.get("requiredGrants") or [], resolved["resourceId"], "read"),
            "LOCAL_DATA_SCOPE_DENIED",
        )
        return resolved
    if route["audience"] == "semantica-mcp" and body["audience"] == "semantica":
        resolved = _semantica(context, body, native=True)
        need(
            resolved["serviceContext"]["operation"] == route["serviceContext"]["operation"]
            and resolved["resourceId"] == route["resourceId"]
            and resolved["serviceContext"]["workspaceId"] == route["serviceContext"]["workspaceId"]
            and resolved["action"] == "read"
            and route["serviceContext"]["operation"] in MCP_TOOLS,
            "LOCAL_DATA_ROUTE_DENIED",
        )
        return resolved
    need(
        route["audience"] == "clipboard" and body["audience"] == "octop", "LOCAL_DATA_ROUTE_DENIED"
    )
    allowed = (
        ("POST", r"/api/personal-space/(?:app-folders|uploads)", "write", MIB),
        ("GET", rf"/api/personal-space/(?:uploads/{FILE}|files/{FILE}(?:/content)?)", "read", 0),
        ("PUT", rf"/api/personal-space/uploads/{FILE}", "write", 4 * MIB),
        ("POST", rf"/api/personal-space/uploads/{FILE}/complete", "write", MIB),
        (
            "DELETE",
            rf"/api/personal-space/(?:uploads/{FILE}|files/{FILE}|trash/{FILE})",
            "write",
            0,
        ),
        ("POST", r"/api/personal-space/connection-access", "read", MIB),
    )
    for method, pattern, action, cap in allowed:
        if body["method"] == method and re.fullmatch(pattern, path):
            need(set(query_values(target)) <= {"offset", "length"}, "LOCAL_DATA_ROUTE_DENIED")
            # Parent mutations may read their own source and perform the narrow
            # storage callbacks below. Read parents never write/delete uploads.
            need(action == "read" or route["action"] == "write", "LOCAL_DATA_ROUTE_DENIED")
            if path.endswith("/connection-access"):
                need(
                    route["upstreamPath"] == "/api/clipboard/v1/agent-access"
                    and body["headers"]["spaceLink"] is not None,
                    "LOCAL_DATA_SCOPE_DENIED",
                )
            clipboard_scope = parent["constraints"].get("clipboardScope") or {
                "application": "wanx.clipboard",
                "exportId": None,
                "parent": None,
            }
            return _result(
                context,
                "octop",
                route["resourceId"],
                action,
                cap,
                target,
                {
                    "kind": "principal",
                    "principalNamespace": context["principalNamespace"],
                    "clipboardScope": clipboard_scope,
                },
            )
    raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED")
