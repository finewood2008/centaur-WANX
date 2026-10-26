"""Actual native gate/dependencies and SQLite identities, with signed local broker fixtures."""

import hashlib
import time
from dataclasses import replace

import httpx
import pytest
from centuarai_local_data_gate.protocol import encode
from fastapi import Depends
from octop.api.deps import current_user
from octop.infra.errors import OctopError
from octop.infra.personal_space.service import SpaceError
from octop.infra.personal_space.team_scope import TeamSpace
from octop.infra.personal_space.workspaces import Workspaces
from octop.infra.users.team_authority import require_team_permission
from test_local_data_gate import native as native
from test_local_data_octop_native import headers as original_headers
from test_local_data_octop_native import installed as installed


def headers(proof, key):
    now = int(time.time() * 1000)
    proof.update(issuedAtMs=now, expiresAtMs=now + 2000)
    result = original_headers(proof, key)
    if proof["headers"]["dataContext"] is not None:
        result["X-Wanx-Data-Context"] = proof["headers"]["dataContext"]
    return result


def team(proof):
    proof["schemaVersion"] = 2
    proof["team"] = {
        "schemaVersion": 1,
        "boxId": proof["boxId"],
        "ownershipEpoch": proof["ownershipEpoch"],
        "principalId": proof["principalId"],
        "membershipId": encode(bytes(32)),
        "membershipRevision": 1,
        "roleId": "manager",
        "permissions": ["applications.manage", "members.read", "resources.manage"],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("first", [251, 255])
async def test_native_team_capability_never_promotes_admin_or_accepts_bare_dto(installed, first):
    app, server, rows, proof, key, db = installed
    captured = []

    @app.get("/api/admin/applications")
    async def products(user=Depends(current_user)):
        cap = require_team_permission(user, "applications.manage")
        captured.append(user)
        return {"membership": cap["membershipId"], "role": user.role}

    team(proof)
    membership = encode(bytes([first]) + bytes(31))
    proof["team"]["membershipId"] = membership
    proof.update(rawTarget="/api/admin/applications", resourceId="team:management")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://native"
    ) as client:
        response = await client.get(proof["rawTarget"], headers=headers(proof, key))
        assert response.status_code == 200, response.text
        assert response.json() == {"membership": membership, "role": "user"}
        assert (
            await client.get(proof["rawTarget"], headers={"Authorization": "Bearer cloud-token"})
        ).status_code == 403
        proof["team"]["permissions"] = []
        assert (
            await client.get(proof["rawTarget"], headers=headers(proof, key))
        ).status_code == 403
    with pytest.raises(OctopError):
        require_team_permission(
            replace(captured[0], local_team_context=None), "applications.manage"
        )
    with pytest.raises(OctopError):
        require_team_permission(captured[0], "applications.manage")  # response already closed
    with db.connect() as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM users WHERE role!='user' OR password_hash IS NOT NULL"
            ).fetchone()[0]
            == 0
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("selected", [False, True])
@pytest.mark.parametrize(
    ("identifier", "status"),
    [("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 200), ("ABC123", 403), ("not-a-warehouse", 403)],
)
async def test_native_identity_distinguishes_sem_warehouse_from_published_octop_kb(
    installed, identifier, status, selected
):
    from octop.infra.db.repos.local_team_resources import LocalTeamResourceRepo

    app, server, _, proof, key, db = installed
    server.services.local_team_resource_repo = LocalTeamResourceRepo(db)
    team(proof)
    proof["resourceId"] = "team:knowledge:" + identifier
    if selected:
        proof["headers"]["dataContext"] = proof["resourceId"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://native"
    ) as client:
        response = await client.get("/api/auth/me", headers=headers(proof, key))
        assert response.status_code == status, response.text
        # A warehouse grant never becomes access to Octop's knowledge table,
        # a sibling native KB, or a new legacy Semantica proxy entry point.
        proof["headers"]["dataContext"] = proof["resourceId"]
        for path in (
            "/api/knowledge-bases",
            "/api/knowledge-bases/ZZZ999",
            "/api/semantica/warehouses/" + identifier,
        ):
            proof["rawTarget"] = path
            assert (await client.get(path, headers=headers(proof, key))).status_code == 403


def test_shared_space_cannot_read_private_sibling_or_retarget_upload(tmp_path):
    root = tmp_path / "space"
    owner = Workspaces(root, 11)
    published = owner.approve("shared", "Team")
    private = owner.mkdir("", "private")
    other = owner.approve("other", "Other")
    live = {"value": True}

    def check():
        if not live["value"]:
            raise SpaceError("SPACE_LINK_SCOPE", 403)

    scope = TeamSpace(root, 11, space_id=published["space_id"], live=check)
    folder = scope.mkdir(published["root"], "shared", published["space_id"])
    assert scope.metadata(folder["id"])["name"] == "shared"
    for identifier in (private["id"], other["root"]):
        with pytest.raises(SpaceError):
            scope.metadata(identifier)
    owner.upload_create(other["root"], "sibling", 1, "a" * 32, other["space_id"])
    with pytest.raises(SpaceError):
        scope.upload_chunk("a" * 32, 0, b"x", hashlib.sha256(b"x").hexdigest())
    live["value"] = False
    with pytest.raises(SpaceError):
        scope.mkdir(published["root"], "after-revoke", published["space_id"])
    assert not any(
        item["name"] == "after-revoke"
        for item in owner.listing(space_id=published["space_id"])["items"]
    )


@pytest.mark.asyncio
async def test_uncertain_worker_never_reports_native_closed_or_releases_budget(native):
    from centuarai_local_data_gate import LocalDataGateMiddleware, get_context
    from centuarai_local_data_gate.protocol import sign_gateway_request

    config, key, proof, state, _, broker = native

    async def application(scope, receive, send):
        context = get_context(scope)
        context.mark_physical_close_uncertain()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"uncertain"})

    gate = LocalDataGateMiddleware(application, config=config, broker=broker)
    now = int(time.time() * 1000)
    proof.update(issuedAtMs=now, expiresAtMs=now + 2000)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=gate), base_url="http://native"
    ) as client:
        response = await client.post(
            "/api/echo",
            content=b"data",
            headers={
                "content-type": "application/octet-stream",
                "X-Centuarai-Gateway-Proof": sign_gateway_request(proof, key),
            },
        )
    assert response.status_code == 403
    assert state["outcomes"] == []
    assert proof["operationId"] in gate._operations
    assert gate.active == 1 and gate.reserved == 4
