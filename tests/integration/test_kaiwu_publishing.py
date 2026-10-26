"""Publish fixed compiled fixtures through existing WANX HTTP contracts, without an LLM."""

from typing import Any
from uuid import uuid4

from tests.support.auth import create_user


async def test_kaiwu_publish_update_audience_and_unpublish(env: Any) -> None:
    client, _server, admin = env
    studio = client._octop_app.state.app_studio
    alice = await create_user(client, admin, username="kaiwu_alice")
    bob = await create_user(client, admin, username="kaiwu_bob")
    accounts = {"admin": admin, "alice": alice, "bob": bob}
    ids = {
        name: (await client.get("/api/auth/me", headers=auth)).json()["id"]
        for name, auth in accounts.items()
    }
    response = await client.post(
        "/api/app-studio/projects",
        headers=admin,
        json={"name": "开物发布合成验收", "goal": "固定样例发布验收", "operationId": uuid4().hex},
    )
    assert response.status_code == 200, response.text
    project = response.json()
    owner = f"wanx:{ids['admin']}"
    project = await studio.runner.example(owner, project["id"], uuid4().hex)
    artifact = project["artifacts"][-1]

    async def adopt(candidate: dict[str, Any]) -> None:
        result = await client.post(
            f"/api/app-studio/projects/{project['id']}/accept",
            headers=admin,
            json={
                "operationId": uuid4().hex,
                "artifactHash": candidate["hash"],
                "criteria": list(range(len(project["solution"]["acceptance"]))),
                "confirmedByUser": True,
            },
        )
        assert result.status_code == 200, result.text

    await adopt(artifact)
    response = await client.post(
        "/api/admin/applications",
        headers=admin,
        json={"application_id": project["appId"], "name": "开物发布合成验收"},
    )
    assert response.status_code == 201, response.text
    route = f"/api/admin/applications/{project['appId']}"

    async def publish(candidate: dict[str, Any], audience: str, selected: set[int]) -> None:
        deployment = {
            "enabled": False,
            "configuration": {
                "studio_team": {
                    "projectId": project["id"],
                    "artifactHash": candidate["hash"],
                    "audience": audience,
                }
            },
        }
        response = await client.put(route + "/deployment", headers=admin, json=deployment)
        assert response.status_code == 200, response.text
        for user_id in ids.values():
            response = await client.put(
                route + "/access",
                headers=admin,
                json={"user_id": user_id, "enabled": audience == "all" or user_id in selected},
            )
            assert response.status_code == 200, response.text
        response = await client.post(
            f"/api/app-studio/projects/{project['id']}/installed",
            headers=admin,
            json={
                "operationId": uuid4().hex,
                "artifactHash": candidate["hash"],
                "applicationId": project["appId"],
                "version": candidate["version"],
            },
        )
        assert response.status_code == 200, response.text
        deployment["enabled"] = True
        response = await client.put(route + "/deployment", headers=admin, json=deployment)
        assert response.status_code == 200, response.text

    async def open_runtime(auth: dict[str, str], candidate: dict[str, Any]) -> Any:
        return await client.post(
            f"/api/app-studio/apps/{project['appId']}/runtime",
            headers=auth,
            json={"artifactHash": candidate["hash"], "environment": "production"},
        )

    await publish(artifact, "selected", {ids["admin"], ids["alice"]})
    response = await open_runtime(alice, artifact)
    assert response.status_code == 200, response.text
    session = response.json()["session"]
    assert (await open_runtime(bob, artifact)).status_code != 200
    response = await client.post(
        f"/api/app-studio/runtime/{session}/invoke",
        headers=alice,
        json={"method": "data.put", "params": {"collection": "items", "value": {"title": "KEEP"}}},
    )
    assert response.status_code == 200, response.text
    row_id = response.json()["_id"]
    response = await client.put(route + "/deployment", headers=bob, json={"enabled": False})
    assert response.status_code == 403

    # A second trusted compile, with explicit fixed-fixture provenance.
    from wanx_studio.contracts import digest

    task_id = "kaiwu_fixed_update"

    def seed(current: dict[str, Any]) -> None:
        current["tasks"].append(
            {
                "id": task_id,
                "executor": "fixed-test-fixture",
                "state": "running",
                "solutionHash": digest(current["solution"]),
                "events": [],
            }
        )

    studio.store.mutate(owner, project["id"], uuid4().hex, {"action": "fixed-update"}, seed)
    _, previous = studio.artifact(owner, project["id"], artifact["hash"])
    files = dict(previous["files"])
    files["src/app.js"] += "\n// fixed Kaiwu publication update\n"
    updated = await studio.add_artifact(owner, project["id"], task_id, files)
    candidate = updated["artifacts"][-1]
    await adopt(candidate)
    await publish(candidate, "all", set(ids.values()))
    for auth in [alice, bob]:
        response = await open_runtime(auth, candidate)
        assert response.status_code == 200, response.text
        token = response.json()["session"]
        response = await client.post(
            f"/api/app-studio/runtime/{token}/invoke",
            headers=auth,
            json={"method": "data.get", "params": {"collection": "items", "id": row_id}},
        )
        assert response.status_code == 200, response.text
        assert response.json()["title"] == "KEEP"

    # Audience-only reseals exactly the current published hash, never a different version.
    await publish(candidate, "selected", {ids["admin"], ids["bob"]})
    assert (await open_runtime(alice, candidate)).status_code != 200
    assert (await open_runtime(bob, candidate)).status_code == 200
    deployment = (await client.get(route + "/deployment", headers=admin)).json()
    assert deployment["configuration"]["studio_team"]["artifactHash"] == candidate["hash"]
    disabled = {key: deployment[key] for key in ["enabled", "configuration", "resource_bindings"]}
    disabled["enabled"] = False
    assert (
        await client.put(route + "/deployment", headers=admin, json=disabled)
    ).status_code == 200
    assert (await open_runtime(bob, candidate)).status_code != 200
    assert len(studio.store.get(owner, project["id"])["artifacts"]) == 2
