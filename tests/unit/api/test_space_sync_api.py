"""HTTP agent context gates cannot be bypassed by calling the file API directly."""

from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from octop.api.deps import current_user, get_server
from octop.api.routers import personal_space, space_links


@pytest.mark.asyncio
async def test_task_sync_api_scopes_policies_and_openapi(tmp_path):
    app = FastAPI()
    app.include_router(personal_space.router, prefix="/api/personal-space")
    app.include_router(space_links.router, prefix="/api/personal-space")
    user = SimpleNamespace(id=1)
    app.dependency_overrides[current_user] = lambda: user
    app.dependency_overrides[get_server] = lambda: SimpleNamespace(
        paths=SimpleNamespace(root=tmp_path)
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://box"
    ) as client:
        base = "/api/personal-space"
        agents = []
        for profile in ["A", "B"]:
            response = await client.post(
                base + "/connections",
                json={
                    "profile": profile,
                    "name": "Agent",
                    "sync_policy": {"context": True, "progress": True, "outcome": True},
                },
            )
            assert response.status_code == 200
            agents.append(response.json())
        a, b = agents
        headers = {"X-Space-Link": a["token"]}
        assert (
            await client.post(base + "/connection-access", headers=headers, json={"action": "list"})
        ).status_code == 409
        args = {
            "action": "task-begin",
            "request_id": "stable",
            "title": "synthetic",
            "policy_revision": 1,
            "categories": {"context": {"status": "provided", "summary": "synthetic only"}},
        }
        response = await client.post(base + "/connection-access", headers=headers, json=args)
        assert response.status_code == 200
        task = response.json()
        assert (
            await client.post(base + "/connection-access", headers=headers, json=args)
        ).json() == task
        state = (await client.get(base + f"/connections/{a['id']}/sync")).json()
        assert state["tasks"][0]["record_count"] == 1
        response = await client.post(
            base + "/connection-access",
            headers={"X-Space-Link": b["token"]},
            json={"action": "task-records", "task_id": task["task_id"]},
        )
        assert response.status_code == 403
        # Neither tool input nor an extra file grant is an owner policy management channel.
        assert (
            await client.post(
                base + "/connection-access",
                headers=headers,
                json={"action": "sync-policy", "options": {}},
            )
        ).status_code == 422
        assert (
            await client.post(
                base + f"/connections/{a['id']}/sync", json={"options": {}, "expected": 0}
            )
        ).status_code == 409
        assert (
            await client.post(
                base + "/connection-access", headers=headers, json=args | {"owner": 2}
            )
        ).status_code == 422
        user.id = 2
        assert (await client.get(base + f"/connections/{a['id']}/sync")).status_code == 404
        user.id = 1
        spec = (await client.get("/openapi.json")).json()
        assert spec["paths"][base + "/connections/{connection}/sync"]["post"]["summary"]
        assert (
            "task-begin"
            in spec["components"]["schemas"]["AgentOperation"]["properties"]["action"]["enum"]
        )
