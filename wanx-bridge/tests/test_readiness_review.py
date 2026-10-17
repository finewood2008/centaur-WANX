"""Review the new diagnostic against real public Octop API responses."""

import copy

import httpx
from test_auth import issue
from test_readiness import requirements

from wanx_bridge.server import create_app
from wanx_bridge.upstream import OctopAdapter

pytest_plugins = ["test_auth", "test_upstream"]


class ReadOnlyTransport(httpx.AsyncBaseTransport):
    def __init__(self, app):
        self.transport = httpx.ASGITransport(app=app)
        self.calls = []

    async def handle_async_request(self, request):
        self.calls.append((request.method, request.url.path))
        assert request.method == "GET", "Readiness may not bootstrap or grant access"
        assert request.url.path in {"/api/auth/me", "/api/agents"}
        assert "cookie" not in request.headers
        return await self.transport.handle_async_request(request)


async def test_real_readiness_preserves_unknown_experts_and_checks_scoped_revocation(
    real_octop, oidc_server, setup_auth
):
    upstream, _, credentials = real_octop
    auth, key, _ = setup_auth
    public = httpx.ASGITransport(app=upstream._octop_app)
    readonly = ReadOnlyTransport(upstream._octop_app)
    adapter = OctopAdapter("http://127.0.0.1:18088", oidc_server, credentials, transport=public)
    try:
        await adapter.initialize()
        parent = await auth.exchange(issue(auth, key), adapter)
        app = create_app(auth, adapter, http_transport=readonly)
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://review-box"
            ) as client,
        ):
            endpoint = "/api/platform/applications/readiness"
            headers = {"authorization": "Bearer " + parent["access_token"]}
            result = await client.post(endpoint, headers=headers, json=requirements(experts=False))
            assert result.status_code == 200, result.text
            assert result.json()["status"] == "ready"
            assert result.json()["deviceId"] == auth.config.device_id
            assert result.headers["cache-control"] == "no-store"

            before = await client.get("/api/agents?scope=mine", headers=headers)
            checked = await client.post(endpoint, headers=headers, json=requirements())
            after = await client.get("/api/agents?scope=mine", headers=headers)
            assert checked.status_code == 200, checked.text
            assert checked.json()["status"] == "blocked"
            assert checked.json()["experts"][0]["code"] in {
                "EXPERT_VERSION_UNKNOWN",
                "EXPERT_NOT_PREPARED",
            }
            assert before.json() == after.json()

            scoped_body = copy.deepcopy(requirements(experts=False))
            scoped_body["applicationId"] = "centaurai.wanx.superadvisors"
            scoped_body["compatibility"]["backendProductId"] = "super-advisory"
            parent_result = await client.post(endpoint, headers=headers, json=scoped_body)
            assert parent_result.json()["authorization"]["code"] == "APP_AUTHORIZATION_UNVERIFIED"

            definition = {
                "application_id": "super-advisory",
                "name": "Review app",
                "description": "Review",
                "capabilities": ["chat", "teams", "brainstorm", "zhijun_context"],
                "agent_template": {},
                "resource_requirements": {},
            }
            assert (
                await adapter._admin("POST", "/api/admin/applications", json=definition)
            ).status_code == 201
            base = "/api/admin/applications/super-advisory"
            assert (
                await adapter._admin(
                    "PUT",
                    base + "/deployment",
                    json={
                        "enabled": True,
                        "resource_bindings": {},
                        "configuration": {},
                    },
                )
            ).status_code == 200
            access = {"user_id": parent["user"]["id"], "enabled": True}
            assert (await adapter._admin("PUT", base + "/access", json=access)).status_code == 200
            scoped = await auth.application_session(
                parent["access_token"], "super-advisory", adapter
            )
            scoped_headers = {"authorization": "Bearer " + scoped["access_token"]}
            ready = await client.post(endpoint, headers=scoped_headers, json=scoped_body)
            assert ready.json()["status"] == "ready", ready.text

            await adapter._admin("PUT", base + "/access", json={**access, "enabled": False})
            denied = await client.post(endpoint, headers=scoped_headers, json=scoped_body)
            assert denied.json()["status"] == "blocked"
            assert denied.json()["authorization"]["code"] == "APP_ENTITLEMENT_REQUIRED"
            assert all(method == "GET" for method, _ in readonly.calls)
    finally:
        await adapter.close()
