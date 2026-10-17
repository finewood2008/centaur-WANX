"""Resource write calls must not replay internally after an authentication failure."""

import json

import httpx
import pytest

from wanx_bridge.admin_client import AdminClient, BridgeUpstreamError


@pytest.mark.parametrize("retry_auth", [False, True])
async def test_auth_retry_is_opt_out_without_changing_existing_callers(tmp_path, retry_auth):
    credentials = tmp_path / "credential.json"
    credentials.write_text(json.dumps({"username": "test", "password": "test-only"}))
    credentials.chmod(0o600)
    calls = []

    async def transport(request):
        calls.append((request.method, request.url.path))
        if request.url.path == "/api/auth/captcha":
            return httpx.Response(200, json={"provider": "slider"})
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200, json={"access_token": "renewed", "user": {"id": 1, "role": "admin"}}
            )
        if request.headers["authorization"] == "Bearer stale":
            return httpx.Response(401)
        return httpx.Response(201, json={"id": "created-once"})

    client = AdminClient(
        "http://127.0.0.1:18088", credentials, transport=httpx.MockTransport(transport)
    )
    client._admin_token = "stale"
    try:
        if retry_auth:
            # Omission intentionally retains bootstrap and other caller behavior.
            assert await client.request("POST", "/api/skill-packages", json={}) == {
                "id": "created-once"
            }
            assert calls.count(("POST", "/api/skill-packages")) == 2
            assert calls.count(("POST", "/api/auth/login")) == 1
        else:
            with pytest.raises(BridgeUpstreamError, match="BOX_UPSTREAM_AUTH_FAILED"):
                await client.request("POST", "/api/skill-packages", retry_auth=False, json={})
            assert calls == [("POST", "/api/skill-packages")]
    finally:
        await client.close()
