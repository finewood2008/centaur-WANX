"""Application and resource boundaries, including broker-only storage attenuation."""

import copy
import hashlib

import pytest
from centuarai_local_data_gate.native_policy import check_octop_request

from wanx_bridge import local_data_protocol as wire
from wanx_bridge.local_data_routes import (
    application_policy,
    business_object,
    child_policy,
    route_policy,
)


def context(resource="wanx", actions=None, app="wanx-host"):
    return {
        "boxId": "box:test",
        "principalNamespace": "a" * 43,
        "applicationId": app,
        "grants": [{"resourceId": resource, "actions": actions or ["execute", "read", "write"]}],
    }


def observed(path, method="GET", **extra):
    return {
        "transport": "http",
        "method": method,
        "rawTarget": path,
        "headers": {name: None for name in wire.HEADERS},
        "bodySha256": wire.encode(hashlib.sha256(b"").digest()),
        "bodyBytes": 0,
        **extra,
    }


@pytest.mark.parametrize("resource", ["space", "space:personal", "wanx"])
def test_personal_space_aliases_never_authorize_shared_space(resource):
    value = context(resource, ["read"])
    assert (
        route_policy(value, observed("/api/personal-space/files"))["resourceId"] == "space:personal"
    )
    for path in (
        "/api/personal-space/files?space_id=team",
        "/api/personal-space/files?space_id=personal&space_id=team",
    ):
        with pytest.raises(wire.DataProtocolError):
            route_policy(value, observed(path))
    with pytest.raises(wire.DataProtocolError):
        route_policy(value, observed("/api/personal-space/uploads", "POST"))


def test_semantica_only_principal_can_prepare_but_cannot_use_wanx_or_unknown_apps():
    value = context("semantica", ["read", "write"])
    assert application_policy("wanx-host", "launch", value) == value["grants"]
    assert (
        route_policy(value, observed("/api/platform/applications/prepare", "POST"))["resourceId"]
        == "semantica"
    )
    with pytest.raises(wire.DataProtocolError):
        route_policy(value, observed("/api/agents"))
    with pytest.raises(wire.DataProtocolError):
        application_policy("arbitrary.app", "launch", value)
    child_app = {**value, "applicationId": "centaurai.wanx.semantica"}
    with pytest.raises(wire.DataProtocolError):
        route_policy(child_app, observed("/api/platform/applications/prepare", "POST"))


@pytest.mark.parametrize(
    "path,method",
    [
        ("/api/auth/login", "POST"),
        ("/api/auth/platform/exchange", "POST"),
        ("/api/settings", "GET"),
        ("/api/internal/mcp", "POST"),
        ("/api/desktop/stream", "GET"),
        ("/api/terminal", "GET"),
        ("/api/mobile/stream", "GET"),
        ("/api/browser-stream/ws", "GET"),
        ("/api/personal-space/agent-access", "POST"),
        ("/api/personal-space/connection-access", "POST"),
    ],
)
def test_private_resource_never_implies_host_admin_or_capability_fallback(path, method):
    with pytest.raises(wire.DataProtocolError):
        route_policy(context(), observed(path, method))


def test_upload_limits_are_exact_route_caps_not_generic_unknown_allowance():
    assert (
        route_policy(context(), observed("/api/agents/test/workspace/archive", "POST"))["bodyLimit"]
        == 200 * 1024**2
    )
    assert (
        route_policy(context(), observed("/api/agents/test/workspace/upload", "POST"))["bodyLimit"]
        == 100 * 1024**2
    )
    assert (
        route_policy(context(), observed("/api/personal-space/uploads/" + "1" * 32, "PUT"))[
            "bodyLimit"
        ]
        == 4 * 1024**2
    )
    with pytest.raises(wire.DataProtocolError):
        route_policy(context(), observed("/api/anything/archive", "POST"))


def test_child_clipboard_scope_is_derived_from_parent_export_plan():
    ctx = context("clipboard")
    parent = {
        "context": ctx,
        "route": route_policy(ctx, observed("/api/clipboard/v1/" + "2" * 32 + "/export", "POST")),
        "constraints": {
            "clipboardScope": {
                "application": "wanx.clipboard",
                "exportId": "3" * 32,
                "parent": "4" * 32,
            }
        },
    }
    body = {**observed("/api/personal-space/uploads", "POST"), "audience": "octop"}
    route = child_policy(parent, body)
    assert (
        route["resourceId"] == "clipboard"
        and route["serviceContext"]["clipboardScope"] == parent["constraints"]["clipboardScope"]
    )
    claims = {**body, **route}
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/personal-space/uploads",
        "raw_path": b"/api/personal-space/uploads",
        "query_string": b"",
    }
    check_octop_request(scope, {**claims, "applicationId": "wanx-host"})
    forged = copy.deepcopy(claims)
    forged["serviceContext"]["clipboardScope"] = None
    with pytest.raises(wire.DataProtocolError):
        check_octop_request(scope, {**forged, "applicationId": "wanx-host"})
    parent["route"]["action"] = "read"
    with pytest.raises(wire.DataProtocolError):
        child_policy(parent, body)


def test_semantica_mcp_child_cannot_switch_tool_or_workspace_scope():
    ctx = context("semantica", ["read"])
    route = route_policy(ctx, observed("/api/semantica/mcp", "POST"))
    route["serviceContext"]["operation"] = "search_knowledge"
    parent = {"context": ctx, "route": route, "constraints": {}}
    body = {**observed("/api/integration/search", "POST"), "audience": "semantica"}
    child = child_policy(parent, body)
    assert child["serviceContext"]["workspaceId"] == route["serviceContext"]["workspaceId"]
    for target in ("/api/integration/search/workspaces", "/api/integration/documents"):
        with pytest.raises(wire.DataProtocolError):
            child_policy(parent, {**body, "rawTarget": target})


def test_staged_json_accepts_actual_unicode_but_rejects_ambiguity():
    assert business_object('{"note":"中文"}'.encode())["note"] == "中文"
    for raw in (b'{"id":1,"id":2}', b'{"x":NaN}', b'{"x":1e999}'):
        with pytest.raises(wire.DataProtocolError):
            business_object(raw)
