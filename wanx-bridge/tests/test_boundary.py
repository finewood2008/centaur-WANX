"""Composition contracts against the unchanged Octop application."""

import ast
from pathlib import Path

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from test_upstream import oidc_server, real_octop  # noqa: F401 -- shared real-service fixtures

from wanx_bridge.auth import PlatformAuthService, fingerprint
from wanx_bridge.config import PlatformConfig
from wanx_bridge.server import create_app
from wanx_bridge.upstream import OctopAdapter


def test_production_bridge_does_not_import_octop():
    for path in Path(__file__).parents[1].joinpath("wanx_bridge").glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                names = [node.module or ""]
            assert all(name != "octop" and not name.startswith("octop.") for name in names), path


async def test_signed_platform_exchange_through_bridge_to_unmodified_octop(
    real_octop,  # noqa: F811 -- pytest fixture injection
    oidc_server,  # noqa: F811 -- pytest fixture injection
    tmp_path,
):
    octop_client, _, credentials = real_octop
    platform_key = Ed25519PrivateKey.generate()
    box_key = Ed25519PrivateKey.generate()
    auth = PlatformAuthService(
        PlatformConfig(
            "box", "nexusaos-platform", box_key, platform_key.public_key(), tmp_path / "bridge"
        )
    )
    transport = httpx.ASGITransport(app=octop_client._octop_app)
    adapter = OctopAdapter("http://127.0.0.1:18088", oidc_server, credentials, transport=transport)
    try:
        await adapter.initialize()
        app = create_app(auth, adapter, http_transport=transport)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://box"
            ) as client:

                async def exchange(account, role):
                    response = await client.post(
                        "/api/auth/platform/challenge",
                        json={
                            "accountId": account,
                            "clientId": "client",
                            "networkSessionId": "network",
                        },
                    )
                    assert response.status_code == 200
                    proof = jwt.decode(
                        response.json()["challengeReceipt"],
                        box_key.public_key(),
                        algorithms=["EdDSA"],
                        options={"verify_aud": False},
                    )
                    claims = {
                        **proof,
                        "iss": "nexusaos-platform",
                        "aud": "wanx-p2p-login",
                        "ownership_epoch": 1,
                        "authorization_version": 1,
                        "account_auth_version": 0,
                        "client_session_version": 0,
                        "membership_id": "membership-" + account,
                        "membership_version": 1,
                        "role": role,
                        "display_name": account,
                        "lease_exp": proof["iat"] + 120,
                    }
                    grant = jwt.encode(
                        claims,
                        platform_key,
                        algorithm="EdDSA",
                        headers={"kid": fingerprint(platform_key.public_key())},
                    )
                    result = await client.post("/api/auth/platform/exchange", json={"grant": grant})
                    assert result.status_code == 200, result.text
                    assert (
                        await client.post("/api/auth/platform/exchange", json={"grant": grant})
                    ).status_code == 401
                    return result.json()

                owner = await exchange("owner", "admin")
                member = await exchange("member", "user")
                assert owner["user"]["id"] != member["user"]["id"]
                for result, role in ((owner, "admin"), (member, "user")):
                    token = result["access_token"]
                    response = await client.get(
                        "/api/auth/me", headers={"authorization": "Bearer " + token}
                    )
                    assert response.status_code == 200
                    assert response.json()["role"] == role
                    assert "x-octop-access-token" not in response.headers
                    assert "set-cookie" not in response.headers
                    upstream_token = auth.authorize(token).upstream_token
                    assert upstream_token != token
                    assert (
                        await client.get(
                            "/api/auth/me", headers={"authorization": "Bearer " + upstream_token}
                        )
                    ).status_code == 401
                assert (await client.get("/api/auth/me")).status_code == 401
                assert (
                    await client.get(
                        "/api/auth/oidc/config",
                        headers={"authorization": "Bearer " + owner["access_token"]},
                    )
                ).status_code == 403
    finally:
        await adapter.close()
        auth.close()
