"""Real WANX identity, publication and runtime routes with a deterministic model adapter."""

from typing import Any
from uuid import uuid4

from tests.support.auth import create_user


async def test_finished_model_binding_keeps_member_identity_and_public_contracts(env: Any) -> None:
    client, _server, admin = env
    svc = client._octop_app.state.app_studio
    calls = []

    class Models:
        def runtime_catalog(self):
            return {
                "models": [{"id": "configured", "name": "Configured", "provider": "WANX"}],
                "defaultId": None,
            }

        def for_runtime(self, model_id):
            assert model_id == "configured"

            async def generate(owner, body):
                calls.append((owner, "configured"))
                return {"choices": [{"message": {"content": "configured"}}]}

            return generate

        async def __call__(self, owner, body):
            calls.append((owner, "default"))
            return {"choices": [{"message": {"content": "default"}}]}

    svc.model = Models()
    alice = await create_user(client, admin, username="kaiwu_model_member")
    aid = (await client.get("/api/auth/me", headers=admin)).json()["id"]
    uid = (await client.get("/api/auth/me", headers=alice)).json()["id"]
    owner = f"wanx:{aid}"
    response = await client.post(
        "/api/app-studio/projects",
        headers=admin,
        json={"name": "成品主模型合成验收", "goal": "用户主动生成", "operationId": uuid4().hex},
    )
    assert response.status_code == 200, response.text
    p = await svc.runner.example(owner, response.json()["id"], uuid4().hex)
    a = p["artifacts"][-1]
    route = f"/api/app-studio/_client/projects/{p['id']}/runtime-model"
    before = (await client.get(f"/api/app-studio/projects/{p['id']}", headers=admin)).json()
    response = await client.put(
        route,
        headers=admin,
        json={"operationId": uuid4().hex, "expectedRevision": 0, "modelId": "configured"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["revision"] == 1
    assert (await client.get(route, headers=alice)).status_code == 403
    assert (
        await client.put(
            route,
            headers=alice,
            json={"operationId": uuid4().hex, "expectedRevision": 1, "modelId": None},
        )
    ).status_code == 403
    after = (await client.get(f"/api/app-studio/projects/{p['id']}", headers=admin)).json()
    for key in ["solution", "solutionHash", "artifacts", "tasks", "engine", "versioning"]:
        assert before.get(key) == after.get(key)
    assert "_runtimeModel" not in after
    response = await client.post(
        f"/api/app-studio/projects/{p['id']}/accept",
        headers=admin,
        json={
            "operationId": uuid4().hex,
            "artifactHash": a["hash"],
            "criteria": list(range(len(p["solution"]["acceptance"]))),
            "confirmedByUser": True,
        },
    )
    assert response.status_code == 200, response.text
    assert (
        await client.post(
            "/api/admin/applications",
            headers=admin,
            json={"application_id": p["appId"], "name": p["name"]},
        )
    ).status_code == 201
    deployment = {
        "enabled": False,
        "configuration": {
            "studio_team": {"projectId": p["id"], "artifactHash": a["hash"], "audience": "all"}
        },
    }
    product_route = f"/api/admin/applications/{p['appId']}"
    assert (
        await client.put(product_route + "/deployment", headers=admin, json=deployment)
    ).status_code == 200
    response = await client.post(
        f"/api/app-studio/projects/{p['id']}/installed",
        headers=admin,
        json={
            "operationId": uuid4().hex,
            "artifactHash": a["hash"],
            "applicationId": p["appId"],
            "version": a["version"],
        },
    )
    assert response.status_code == 200, response.text
    deployment["enabled"] = True
    assert (
        await client.put(product_route + "/deployment", headers=admin, json=deployment)
    ).status_code == 200
    response = await client.post(
        f"/api/app-studio/apps/{p['appId']}/runtime",
        headers=alice,
        json={"artifactHash": a["hash"], "environment": "production"},
    )
    assert response.status_code == 200, response.text
    token = response.json()["session"]
    response = await client.post(
        f"/api/app-studio/runtime/{token}/invoke",
        headers=alice,
        json={"method": "model.generate", "params": {"prompt": "synthetic check"}},
    )
    assert response.status_code == 200, response.text
    assert response.json()["text"] == "configured"
    assert calls == [(f"wanx:{uid}", "configured")]
    response = await client.put(
        route,
        headers=admin,
        json={"operationId": uuid4().hex, "expectedRevision": 1, "modelId": None},
    )
    assert response.status_code == 200
    response = await client.post(
        f"/api/app-studio/runtime/{token}/invoke",
        headers=alice,
        json={"method": "model.generate", "params": {"prompt": "synthetic check"}},
    )
    assert response.json()["text"] == "default"
    assert calls[-1] == (f"wanx:{uid}", "default")
