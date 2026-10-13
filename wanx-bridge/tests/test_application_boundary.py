"""Real platform OIDC → scoped runtime exchange → native brainstorm boundary."""

import httpx
from test_auth import issue

from wanx_bridge.server import create_app
from wanx_bridge.upstream import OctopAdapter

pytest_plugins = ["test_auth", "test_upstream"]


async def test_real_platform_application_exchange_and_product_revocation(
    real_octop, oidc_server, setup_auth
):
    from wanx_runtime.application_exchange import install_application_exchange

    upstream, _, credentials = real_octop
    install_application_exchange(upstream._octop_app)
    auth, key, _ = setup_auth
    transport = httpx.ASGITransport(app=upstream._octop_app)
    adapter = OctopAdapter("http://127.0.0.1:18088", oidc_server, credentials, transport=transport)
    try:
        await adapter.initialize()
        parent = await auth.exchange(issue(auth, key), adapter)
        app = create_app(auth, adapter, http_transport=transport)
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://box"
            ) as client,
        ):
            headers = {"authorization": "Bearer " + parent["access_token"]}
            endpoint = "/api/auth/platform/application"
            # A marketplace install cannot silently grant use of a box product.
            denied = await client.post(
                endpoint, headers=headers, json={"application_id": "super-advisory"}
            )
            assert denied.status_code == 403
            definition = {
                "application_id": "super-advisory",
                "name": "Super Advisory",
                "description": "Test",
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
                    json={"enabled": True, "resource_bindings": {}, "configuration": {}},
                )
            ).status_code == 200
            uid = parent["user"]["id"]
            assert (
                await adapter._admin(
                    "PUT", base + "/access", json={"user_id": uid, "enabled": True}
                )
            ).status_code == 200
            response = await client.post(
                endpoint, headers=headers, json={"application_id": "super-advisory"}
            )
            assert response.status_code == 200, response.text
            scoped = response.json()
            assert scoped["user"]["id"] == uid
            assert scoped["user"]["application_id"] == "super-advisory"
            child_headers = {"authorization": "Bearer " + scoped["access_token"]}
            child = auth.authorize(scoped["access_token"])
            assert child.upstream_token not in response.text
            me = await client.get("/api/auth/me", headers=child_headers)
            assert me.status_code == 200
            assert me.json()["id"] == uid
            assert me.json()["application_id"] == "super-advisory"
            sessions = await client.get("/api/brainstorm/sessions", headers=child_headers)
            assert sessions.status_code == 200, sessions.text
            assert sessions.json() == []
            # Original WANX connection retains its own scope and cannot impersonate the app.
            assert (await client.get("/api/auth/me", headers=headers)).json()[
                "application_id"
            ] == "wanx"
            assert (
                await client.get("/api/brainstorm/sessions", headers=headers)
            ).status_code == 404
            assert (
                await client.get(
                    "/api/auth/me", headers={"authorization": "Bearer " + child.upstream_token}
                )
            ).status_code == 401
            # Reusing a valid, previously issued token cannot bypass product revocation.
            await adapter._admin("PUT", base + "/access", json={"user_id": uid, "enabled": False})
            assert (await client.get("/api/auth/me", headers=child_headers)).status_code == 403
            assert (
                await client.post(
                    endpoint, headers=headers, json={"application_id": "super-advisory"}
                )
            ).status_code == 403
            assert (await client.get("/api/auth/me", headers=headers)).status_code == 200
    finally:
        await adapter.close()
