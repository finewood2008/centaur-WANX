"""Application credentials remain opaque and bounded by their parent platform lease."""

import asyncio
import time

import httpx
import pytest
from test_auth import issue

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.server import create_app

pytest_plugins = ["test_auth"]


class Adapter:
    async def login(self, claims):
        return {
            "access_token": "wanx-upstream",
            "expires_at": time.time() + 3600,
            "user": {"id": 7, "role": claims["role"], "application_id": "wanx"},
        }

    async def application_session(self, token, application_id):
        assert token == "wanx-upstream"
        return {
            "access_token": "private-scoped-jwt",
            "expires_at": time.time() + 300,
            "user": {"id": 7, "role": "user", "application_id": application_id},
        }


@pytest.mark.asyncio
async def test_scoped_marker_has_same_identity_and_platform_revocation(setup_auth):
    auth, key, _ = setup_auth
    adapter = Adapter()
    parent = await auth.exchange(issue(auth, key), adapter)
    derived = await auth.application_session(parent["access_token"], "super-advisory", adapter)
    assert derived["access_token"] not in {
        "wanx-upstream",
        "private-scoped-jwt",
        parent["access_token"],
    }
    child = auth.authorize(derived["access_token"])
    original = auth.authorize(parent["access_token"])
    assert (child.key, child.sid) == (original.key, original.sid)
    assert child.expires_at <= original.expires_at
    assert child.upstream_token == "private-scoped-jwt"
    with pytest.raises(BridgeAuthError, match="SCOPE_FORBIDDEN"):
        await auth.application_session(derived["access_token"], "super-advisory", adapter)
    await auth.exchange(issue(auth, key, membership_version=2), adapter)
    with pytest.raises(BridgeAuthError):
        auth.authorize(derived["access_token"])
    with pytest.raises(BridgeAuthError):
        auth.assert_live(child)


@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [{"id": 8}, {"role": "admin"}, {"application_id": "wanx"}])
async def test_rejects_upstream_identity_or_scope_substitution(setup_auth, changes):
    auth, key, _ = setup_auth
    adapter = Adapter()
    parent = await auth.exchange(issue(auth, key), adapter)

    class BadAdapter(Adapter):
        async def application_session(self, token, application_id):
            value = await super().application_session(token, application_id)
            value["user"].update(changes)
            return value

    with pytest.raises(BridgeAuthError, match="SESSION_INVALID"):
        await auth.application_session(parent["access_token"], "super-advisory", BadAdapter())
    assert len(auth.sessions) == 1


@pytest.mark.asyncio
async def test_rechecks_parent_after_await_and_rejects_unknown_scope(setup_auth):
    auth, key, _ = setup_auth
    adapter = Adapter()
    parent = await auth.exchange(issue(auth, key), adapter)
    with pytest.raises(BridgeAuthError, match="SCOPE_FORBIDDEN"):
        await auth.application_session(parent["access_token"], "wanx", adapter)

    class SlowAdapter(Adapter):
        async def application_session(self, token, application_id):
            auth.sessions.clear()
            await asyncio.sleep(0)
            return await super().application_session(token, application_id)

    with pytest.raises(BridgeAuthError):
        await auth.application_session(parent["access_token"], "super-advisory", SlowAdapter())
    assert not auth.sessions


@pytest.mark.asyncio
async def test_http_exchange_requires_authority_and_never_returns_upstream_jwt(setup_auth):
    auth, key, _ = setup_auth
    adapter = Adapter()
    parent = await auth.exchange(issue(auth, key), adapter)
    app = create_app(auth, adapter)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://bridge"
    ) as client:
        endpoint = "/api/auth/platform/application"
        assert (
            await client.post(endpoint, json={"application_id": "super-advisory"})
        ).status_code == 401
        headers = {"Authorization": "Bearer " + parent["access_token"]}
        assert (
            await client.post(
                endpoint, headers=headers, json={"application_id": "super-advisory", "user_id": 8}
            )
        ).status_code == 400
        response = await client.post(
            endpoint, headers=headers, json={"application_id": "super-advisory"}
        )
        assert response.status_code == 200
        assert "private-scoped-jwt" not in response.text
        assert response.headers["cache-control"] == "no-store"
        assert (
            auth.authorize(response.json()["access_token"]).user["application_id"]
            == "super-advisory"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,code",
    [(403, "BOX_APPLICATION_ACCESS_DENIED"), (404, "BOX_APPLICATION_RUNTIME_UPDATE_REQUIRED")],
)
async def test_adapter_uses_only_bearer_upstream_api_and_preserves_safe_errors(
    tmp_path, status, code
):
    from wanx_bridge.upstream import BridgeUpstreamError, OctopAdapter

    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(status, json={"detail": "private server diagnostics"})

    adapter = OctopAdapter(
        "http://127.0.0.1:18088",
        None,
        tmp_path / "unused-credentials",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(BridgeUpstreamError, match=code):
            await adapter.application_session("parent-private-jwt", "super-advisory")
        assert seen[0].url.path == "/api/auth/application/exchange"
        assert seen[0].headers["authorization"] == "Bearer parent-private-jwt"
        assert "cookie" not in seen[0].headers
    finally:
        await adapter.close()
