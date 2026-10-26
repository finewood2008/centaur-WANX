"""Team authority uses real signatures and the same bounded session engine."""

import pytest
from centuarai_local_data_gate.native_policy import check_octop_request
from test_local_data_sessions import Harness, nonce

from wanx_bridge import local_data_protocol as wire
from wanx_bridge.local_data_routes import application_policy, child_policy, route_policy
from wanx_bridge.local_resource_catalog import resolve_resource, validate_resource_grants


def harness():
    h = Harness()
    h.view["team"] = {
        "schemaVersion": 1,
        "boxId": h.view["boxId"],
        "ownershipEpoch": 1,
        "principalId": h.view["principalId"],
        "membershipId": nonce(33),
        "membershipRevision": 1,
        "roleId": "manager",
        "permissions": ["applications.manage", "members.read", "resources.manage"],
    }
    h.view["grants"] = [{"resourceId": "team:management", "actions": ["execute", "read", "write"]}]
    h.service.application_policy = application_policy
    h.service.route_policy = route_policy
    h.service.gateway_members_signer = lambda p: wire.sign_gateway_members(p, h.gateway)
    h.service.gateway_task_signer = lambda p: wire.sign_gateway_task(p, h.gateway)
    h.service.gateway_grants_signer = lambda p: wire.sign_gateway_grants(p, h.gateway)
    h.service.gateway_resources_signer = lambda p: wire.sign_gateway_resources(p, h.gateway)
    h.service.child_policy = child_policy
    h.service.authority.get_team_members = lambda *_: [
        {
            "membershipId": h.view["team"]["membershipId"],
            "principalId": h.view["principalId"],
            "status": "active",
            "revision": 1,
        }
    ]
    return h


@pytest.mark.asyncio
async def test_team_v2_members_and_exact_native_policy():
    h = harness()
    await h.start()
    assert "team" not in h.session["authorization"]  # existing desktop wire is unchanged
    op, proof = await h.operation(rawTarget="/api/admin/applications")
    claims = wire.verify_gateway_request(proof, wire.public_jwk(h.gateway), h.clock.wall)
    assert claims["schemaVersion"] == 2 and claims["team"] == h.view["team"]
    check_octop_request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/admin/applications",
            "raw_path": b"/api/admin/applications",
            "query_string": b"",
        },
        claims,
    )
    await h.native_start(op, proof)
    receipt = await h.service.native_team_members(h.native(op, n=11), audience="octop")
    value = wire.verify_gateway_members(receipt, wire.public_jwk(h.gateway), h.clock.wall)
    assert value["members"][0]["membershipId"] == nonce(33)
    assert value["teamDigest"] == wire.digest(h.view["team"])
    with pytest.raises(wire.DataProtocolError):
        await h.service.native_team_members(h.native(op, n=11), audience="octop")
    downgraded = {**claims, "schemaVersion": 1}
    with pytest.raises(wire.DataProtocolError):
        wire.sign_gateway_request(downgraded, h.gateway)


@pytest.mark.asyncio
@pytest.mark.parametrize("first", [251, 255])
async def test_membership_digest_leading_urlsafe_symbols_in_signed_request_and_roster(first):
    h = harness()
    membership = wire.encode(bytes([first]) + bytes(31))
    assert membership[0] in "-_"
    h.view["team"]["membershipId"] = membership
    await h.start()
    operation, signed = await h.operation(rawTarget="/api/admin/applications")
    claims = wire.verify_gateway_request(signed, wire.public_jwk(h.gateway), h.clock.wall)
    assert claims["team"]["membershipId"] == membership
    await h.native_start(operation, signed)
    signed = await h.service.native_team_members(h.native(operation, n=11), audience="octop")
    roster = wire.verify_gateway_members(signed, wire.public_jwk(h.gateway), h.clock.wall)
    assert roster["members"][0]["membershipId"] == membership
    # Same decoded bytes with nonzero padding bits are not canonical wire IDs.
    invalid = membership[:-1] + "B"
    claims["team"]["membershipId"] = invalid
    with pytest.raises(wire.DataProtocolError):
        wire.sign_gateway_request(claims, h.gateway)
    roster["members"][0]["membershipId"] = invalid
    with pytest.raises(wire.DataProtocolError):
        wire.sign_gateway_members(roster, h.gateway)


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["membershipRevision", "roleId", "permissions"])
async def test_membership_change_closes_existing_native_operation(change):
    h = harness()
    await h.start()
    op, proof = await h.operation(rawTarget="/api/admin/applications")
    await h.native_start(op, proof)
    h.view["authorizationVersion"] += 1
    h.view["team"][change] = {"membershipRevision": 2, "roleId": "member", "permissions": []}[
        change
    ]
    await h.service.invalidate_authority()
    with pytest.raises(wire.DataProtocolError):
        await h.service.native_check(h.native(op, n=12), audience="octop")
    assert h.closed and h.service._sessions[h.session["sessionId"]]["closed"]


@pytest.mark.asyncio
async def test_team_role_does_not_grant_an_unapproved_resource_or_global_users():
    h = harness()
    await h.start()
    for path in ("/api/users", "/api/settings/providers", "/api/admin/applications/a/releases"):
        with pytest.raises(wire.DataProtocolError):
            await h.operation(rawTarget=path)
    h.view["grants"] = [{"resourceId": "wanx", "actions": ["read", "write"]}]
    h.service._cache.clear()
    with pytest.raises(wire.DataProtocolError):
        await h.operation(rawTarget="/api/admin/applications")


@pytest.mark.asyncio
async def test_studio_task_survives_parent_response_but_not_session_revoke():
    h = harness()
    h.session = h.response(
        await h.service.create_session(await h.session_proof("ai.wanx.studio")), "session"
    )
    pid, tid = "a" * 32, "b" * 32
    op, proof = await h.operation(
        applicationId="ai.wanx.studio",
        method="POST",
        rawTarget=f"/api/app-studio/projects/{pid}/build",
    )
    await h.native_start(op, proof)
    body = h.native(op, n=20, projectId=pid, taskId=tid, taskPurpose="build")
    signed = await h.service.native_task_start(body, audience="octop")
    task = wire.verify_gateway_task(signed, wire.public_jwk(h.gateway), h.clock.wall)
    task_op = {"operationId": task["operationId"]}
    await h.service.native_closed(h.native(op, n=21, outcome="completed"), audience="octop")
    await h.service.finish_operation(op["operationId"], transport_closed=True)
    await h.service.native_task_check(h.native(task_op, n=22), audience="octop")
    h.view["team"]["membershipRevision"] += 1
    h.view["authorizationVersion"] += 1
    await h.service.invalidate_authority()
    with pytest.raises(wire.DataProtocolError):
        await h.service.native_task_check(h.native(task_op, n=23), audience="octop")
    record = h.service._operations[task["operationId"]]
    assert record["nativeClosed"] is False
    assert h.service._reserved(record)  # denied work still holds physical cleanup budget
    await h.service.native_task_close(
        h.native(task_op, n=24, outcome="cancelled"), audience="octop"
    )
    assert record["nativeClosed"] is True and not h.service._reserved(record)


def test_shared_namespace_is_box_epoch_scoped_and_never_principal_scoped():
    resource = "team:space:" + "a" * 32
    validate_resource_grants([{"resourceId": resource, "actions": ["read"]}])
    first = resolve_resource("principal:a", resource, box_id="box:a", ownership_epoch=1)
    assert first == resolve_resource("principal:b", resource, box_id="box:a", ownership_epoch=1)
    assert first != resolve_resource("principal:a", resource, box_id="box:a", ownership_epoch=2)
    with pytest.raises(Exception):
        resolve_resource("principal:a", resource)


def test_company_runtime_and_catalog_have_exact_application_resource():
    from centuarai_local_data_gate.native_policy import classify_octop

    app = "ai.wanx.selfmade." + "a" * 32
    resource = "team:application:" + app
    rule = classify_octop("POST", "/api/app-studio/apps/" + app + "/runtime", "http", app)
    assert rule["resourceId"] == resource and rule["action"] == "execute"
    rule = classify_octop(
        "GET", "/api/app-studio/apps/" + app + "/install", "http", "wanx-host", resource
    )
    assert rule["resourceId"] == resource and rule["action"] == "read"
    for method, path, client in (
        ("POST", "/api/app-studio/apps/ai.wanx.selfmade." + "b" * 32 + "/runtime", app),
        ("GET", "/api/admin/applications", app),
        ("GET", "/api/app-studio/projects", app),
        ("GET", "/api/users", app),
        ("GET", "/api/app-studio/apps/" + app + "/install", app),
    ):
        with pytest.raises(wire.DataProtocolError):
            classify_octop(method, path, "http", client, resource)


def test_shared_warehouse_route_stays_in_exact_box_epoch_resource():
    import json
    from uuid import UUID, uuid5

    h = harness()
    warehouse = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    resource = "team:knowledge:" + warehouse
    context = {
        **h.view,
        "applicationId": "wanx-host",
        "principalNamespace": nonce(14),
        "grants": [{"resourceId": resource, "actions": ["execute", "read", "write"]}],
    }
    observation = {
        "method": "GET",
        "transport": "http",
        "rawTarget": "/api/semantica/warehouses",
        "headers": {**{key: None for key in wire.HEADERS}, "dataContext": resource},
        "bodyBytes": 0,
        "bodySha256": nonce(15),
    }
    route = route_policy(context, observation)
    for method in ("GET", "HEAD"):
        identity = route_policy(
            context, {**observation, "method": method, "rawTarget": "/api/auth/me"}
        )
        assert identity["audience"] == "octop"
        assert identity["resourceId"] == resource and identity["action"] == "read"
    for method, path, selected in (
        ("PATCH", "/api/auth/me", resource),
        ("GET", "/api/auth/me/avatar", resource),
        ("GET", "/api/auth/me", "team:knowledge:ABC123"),
        ("GET", "/api/auth/me", "team:knowledge:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        ("GET", "/api/auth/me", "team:agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        ("GET", "/api/knowledge-bases", resource),
    ):
        with pytest.raises(wire.DataProtocolError):
            route_policy(
                context,
                {
                    **observation,
                    "method": method,
                    "rawTarget": path,
                    "headers": {**observation["headers"], "dataContext": selected},
                },
            )
    expected = str(
        uuid5(
            UUID("8ae54f40-4054-4bba-a2e2-06e1c43d7514"),
            json.dumps(
                [context["boxId"], "semantica", "team:1:knowledge:" + warehouse],
                separators=(",", ":"),
            ),
        )
    )
    assert route["resourceId"] == resource and route["serviceContext"]["workspaceId"] == expected
    assert route["serviceContext"]["warehouseId"] == warehouse
    alias = route_policy(
        context,
        {
            **observation,
            "rawTarget": "/api/semantica/warehouses/" + warehouse + "/documents?limit=10",
        },
    )
    assert alias["upstreamPath"] == "/api/integration/documents?limit=10"
    assert alias["resourceId"] == resource
    for path in (
        "/api/semantica/owner/graph",
        "/api/semantica/warehouses/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ):
        with pytest.raises(wire.DataProtocolError):
            route_policy(context, {**observation, "rawTarget": path})


@pytest.mark.asyncio
async def test_studio_task_child_reads_only_frozen_exact_sources_and_rechecks_acl():
    import hashlib

    h = harness()
    resource = "team:knowledge:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    other = "team:knowledge:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    h.view["grants"] = sorted(
        h.view["grants"]
        + [
            {"resourceId": resource, "actions": ["read", "write"]},
            {"resourceId": other, "actions": ["read"]},
        ],
        key=lambda value: value["resourceId"],
    )
    h.session = h.response(
        await h.service.create_session(await h.session_proof("ai.wanx.studio")), "session"
    )
    project = "a" * 32
    parent, proof = await h.operation(
        applicationId="ai.wanx.studio",
        method="POST",
        rawTarget=f"/api/app-studio/projects/{project}/build",
    )
    await h.native_start(parent, proof)
    frozen = [{"resourceId": resource, "actions": ["read"]}]
    await h.service.native_authorize_resources(
        h.native(parent, n=20, grants=frozen), audience="octop"
    )
    receipt = await h.service.native_task_start(
        h.native(parent, n=21, projectId=project, taskId="b" * 32, taskPurpose="build"),
        audience="octop",
    )
    task = wire.verify_gateway_task(receipt, wire.public_jwk(h.gateway), h.clock.wall)
    assert task["grants"] == frozen
    observation = {
        "parentOperationId": task["operationId"],
        "nativeGateGeneration": nonce(9),
        "gateNonce": nonce(22),
        "audience": "semantica",
        "transport": "http",
        "method": "GET",
        "rawTarget": "/api/integration/documents",
        "bodyBytes": 0,
        "bodySha256": wire.encode(hashlib.sha256(b"").digest()),
        "headers": {**{key: None for key in wire.HEADERS}, "dataContext": resource},
    }
    child = await h.service.child_hop(observation, audience="octop")
    claims = wire.verify_gateway_request(child, wire.public_jwk(h.gateway), h.clock.wall)
    assert claims["resourceId"] == resource and claims["action"] == "read"
    assert claims["parentOperationId"] == task["operationId"]
    for index, path in enumerate(("/graph", "/evidence/fact-1"), start=26):
        child = await h.service.child_hop(
            {**observation, "gateNonce": nonce(index), "rawTarget": "/api/integration" + path},
            audience="octop",
        )
        claims = wire.verify_gateway_request(child, wire.public_jwk(h.gateway), h.clock.wall)
        assert claims["resourceId"] == resource and claims["action"] == "read"
        with pytest.raises(wire.DataProtocolError):
            await h.service.child_hop(
                {
                    **observation,
                    "gateNonce": nonce(index + 2),
                    "rawTarget": "/api/integration" + path,
                    "headers": {**observation["headers"], "dataContext": other},
                },
                audience="octop",
            )
    with pytest.raises(wire.DataProtocolError):
        await h.service.child_hop(
            {
                **observation,
                "gateNonce": nonce(23),
                "headers": {**observation["headers"], "dataContext": other},
            },
            audience="octop",
        )
    with pytest.raises(wire.DataProtocolError):
        await h.service.child_hop(
            {**observation, "gateNonce": nonce(24), "method": "POST"}, audience="octop"
        )
    h.view["grants"] = [value for value in h.view["grants"] if value["resourceId"] != resource]
    h.view["authorizationVersion"] += 1
    h.clock.advance(1001)
    with pytest.raises(wire.DataProtocolError):
        await h.service.native_task_check(
            h.native({"operationId": task["operationId"]}, n=25), audience="octop"
        )


@pytest.mark.asyncio
async def test_resource_roster_is_current_session_ceiling_and_http_needs_only_grow():
    h = harness()
    h.view["grants"] = [
        {"resourceId": "semantica", "actions": ["read"]},
        *h.view["grants"],
        {"resourceId": "wanx", "actions": ["read", "write"]},
    ]
    await h.start()
    parent, proof = await h.operation(rawTarget="/api/app-studio/context/sources")
    await h.native_start(parent, proof)
    roster = await h.service.native_resource_grants(h.native(parent, n=20), audience="octop")
    assert (
        wire.verify_gateway_grants(roster, wire.public_jwk(h.gateway), h.clock.wall)["grants"]
        == h.view["grants"]
    )
    first = [{"resourceId": "semantica", "actions": ["read"]}]
    second = [{"resourceId": "wanx", "actions": ["read"]}]
    await h.service.native_authorize_resources(
        h.native(parent, n=21, grants=first), audience="octop"
    )
    signed = await h.service.native_authorize_resources(
        h.native(parent, n=22, grants=second), audience="octop"
    )
    assert (
        wire.verify_gateway_resources(signed, wire.public_jwk(h.gateway), h.clock.wall)["grants"]
        == first + second
    )
    with pytest.raises(wire.DataProtocolError):
        await h.service.native_authorize_resources(
            h.native(parent, n=23, grants=[{"resourceId": "wanx", "actions": ["write"]}]),
            audience="octop",
        )
    assert h.service._operations[parent["operationId"]]["requiredGrants"] == first + second
