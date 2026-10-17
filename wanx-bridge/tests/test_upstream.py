"""Real unmodified Octop public-API contract and private OIDC security tests."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from wanx_bridge.oidc import OidcError, OidcProvider, loopback_origin
from wanx_bridge.upstream import BridgeUpstreamError, OctopAdapter


def make_provider(issuer="http://127.0.0.1:19089"):
    return OidcProvider(issuer, "wanx-test", "s" * 48, ec.generate_private_key(ec.SECP256R1()))


def issue(provider):
    verifier = "v" * 64
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    )
    redirect = "http://127.0.0.1:18088/api/auth/oidc/callback"
    code = provider.issue("account-1", "甲用户", "n" * 32, challenge, redirect)
    return {
        "client_id": provider.client_id,
        "client_secret": provider.client_secret,
        "grant_type": "authorization_code",
        "code": code,
        "code_verifier": verifier,
        "redirect_uri": redirect,
    }


def test_oidc_signature_claims_and_one_use():
    provider = make_provider()
    form = issue(provider)
    response = provider.exchange(form)
    key = jwt.PyJWK.from_dict(provider.jwks()["keys"][0]).key
    claims = jwt.decode(
        response["id_token"],
        key,
        algorithms=["ES256"],
        issuer=provider.issuer,
        audience=provider.client_id,
    )
    assert claims["sub"] == "account-1"
    assert claims["name"] == "甲用户"
    assert claims["nonce"] == "n" * 32
    assert claims["exp"] - claims["iat"] == 60
    with pytest.raises(OidcError, match="invalid_grant"):
        provider.exchange(form)


@pytest.mark.parametrize(
    "field,value,error",
    [
        ("client_secret", "bad", "invalid_client"),
        ("client_id", "other", "invalid_client"),
        ("code_verifier", "wrong" * 12, "invalid_grant"),
        ("redirect_uri", "http://127.0.0.1:1/api/auth/oidc/callback", "invalid_grant"),
        ("grant_type", "password", "unsupported_grant_type"),
    ],
)
def test_oidc_rejects_wrong_binding(field, value, error):
    provider = make_provider()
    form = issue(provider)
    form[field] = value
    with pytest.raises(OidcError, match=error):
        provider.exchange(form)


def test_oidc_expired_code(monkeypatch):
    provider = make_provider()
    form = issue(provider)
    monkeypatch.setattr("wanx_bridge.oidc.time.time", lambda: 99999999999)
    with pytest.raises(OidcError, match="invalid_grant"):
        provider.exchange(form)


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:88",
        "http://192.168.0.102:88",
        "https://127.0.0.1",
        "http://127.0.0.1/a",
        "http://x@127.0.0.1",
        "http://127.0.0.1?x",
        "http://127.0.0.1:bad",
    ],
)
def test_only_literal_loopback_origin(url):
    with pytest.raises(ValueError):
        loopback_origin(url)


@pytest.fixture
def oidc_server():
    """Octop executes real HTTP discovery/token/JWKS calls against this server."""
    provider = None

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, value):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/.well-known/openid-configuration":
                self.reply(200, provider.discovery())
            elif self.path == "/jwks":
                self.reply(200, provider.jwks())
            else:
                self.reply(404, {})

        def do_POST(self):
            assert self.path == "/token"
            data = self.rfile.read(int(self.headers["Content-Length"]))
            form = {k: v[0] for k, v in parse_qs(data.decode()).items()}
            try:
                self.reply(200, provider.exchange(form))
            except OidcError as exc:
                self.reply(400, {"error": exc.code})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    provider = make_provider(f"http://127.0.0.1:{server.server_port}")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield provider
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.fixture
async def real_octop(tmp_path, monkeypatch):
    # Test-only imports; production bridge never imports Octop.
    from tests.support.app import octop_client
    from tests.support.auth import TEST_PASSWORD, bootstrap_admin

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    for name in ("OCTOP_CAPTCHA_PROVIDER", "OCTOP_CAPTCHA_SITE_KEY", "OCTOP_CAPTCHA_SECRET"):
        monkeypatch.delenv(name, raising=False)
    home = tmp_path / "octop"
    home.mkdir()
    async with octop_client(home) as (client, srv):
        await bootstrap_admin(client, home)
        credentials = tmp_path / "credentials.json"
        credentials.write_text(json.dumps({"username": "admin", "password": TEST_PASSWORD}))
        credentials.chmod(0o600)
        yield client, srv, credentials


async def test_unmodified_octop_real_oidc_isolation_and_roles(real_octop, oidc_server):
    from tests.support.auth import bearer, login

    client, _server, credentials = real_octop
    admin_headers = bearer(await login(client))
    provider = await client.post(
        "/api/admin/providers",
        headers=admin_headers,
        json={
            "name": "preconfigured-local",
            "kind": "openai",
            "base_url": "http://127.0.0.1:11434/v1",
            "api_key": "ollama",
            "models": [{"id": "local-chat", "name": "local-chat", "input": ["text"]}],
        },
    )
    assert provider.status_code == 201
    preferred_model = {"provider_name": "preconfigured-local", "model": "local-chat"}
    assert (
        await client.put("/api/providers/active-model", headers=admin_headers, json=preferred_model)
    ).status_code == 200

    async def private_companions(session):
        response = await client.get(
            "/api/agents?scope=mine",
            headers={"Authorization": "Bearer " + session["access_token"]},
        )
        assert response.status_code == 200
        rows = [row for row in response.json() if "知君" in row["name"]]
        assert len(rows) == 1
        assert rows[0]["user_id"] == session["user"]["id"]
        assert rows[0]["is_shared"] is False
        assert rows[0]["default_model"] == "preconfigured-local/local-chat"
        return rows

    adapter = OctopAdapter(
        "http://127.0.0.1:18088",
        oidc_server,
        credentials,
        transport=httpx.ASGITransport(app=client._octop_app),
    )
    try:
        await adapter.initialize()
        owner = await adapter.login({"sub": "account-A", "display_name": "甲", "role": "admin"})
        guest = await adapter.login({"sub": "account-B", "display_name": "乙", "role": "user"})
        again = await adapter.login({"sub": "account-A", "display_name": "甲", "role": "user"})
        assert owner["user"]["id"] != guest["user"]["id"]
        assert owner["user"]["role"] == "admin"
        assert guest["user"]["role"] == "user"
        assert again["user"]["id"] == owner["user"]["id"]
        assert again["user"]["role"] == "user"
        assert again["user"]["has_password"] is False
        assert again["user"]["sso_identities"] == [{"kind": "oidc"}]
        owner_companions = await private_companions(again)
        guest_companions = await private_companions(guest)
        assert owner_companions[0]["agent_id"] != guest_companions[0]["agent_id"]
        denied = await client.get(
            "/api/agents/" + guest_companions[0]["agent_id"],
            headers={"Authorization": "Bearer " + again["access_token"]},
        )
        assert denied.status_code in {403, 404}
        active = await client.get("/api/providers/active-model", headers=admin_headers)
        assert active.json() == preferred_model
        response = await client.get(
            "/api/auth/me", headers={"Authorization": "Bearer " + owner["access_token"]}
        )
        assert response.json()["role"] == "user"  # Existing JWT obeys current row role.
        assert again["expires_at"] > 0
        results = await asyncio.gather(
            adapter.login({"sub": "account-C", "display_name": "丙", "role": "user"}),
            adapter.login({"sub": "account-D", "display_name": "丁", "role": "user"}),
        )
        assert len({result["user"]["id"] for result in results}) == 2
    finally:
        await adapter.close()
    restarted = OctopAdapter(
        "http://127.0.0.1:18088",
        oidc_server,
        credentials,
        transport=httpx.ASGITransport(app=client._octop_app),
    )
    try:
        await restarted.initialize()
        restored = await restarted.login({"sub": "account-A", "display_name": "甲", "role": "user"})
        assert restored["user"]["id"] == owner["user"]["id"]
        assert (await private_companions(restored))[0]["agent_id"] == owner_companions[0][
            "agent_id"
        ]
    finally:
        await restarted.close()


async def test_owned_shared_source_does_not_block_real_oidc_login(
    real_octop, oidc_server, monkeypatch
):
    from wanx_bridge import upstream

    client, _server, credentials = real_octop
    adapter = OctopAdapter(
        "http://127.0.0.1:18088",
        oidc_server,
        credentials,
        transport=httpx.ASGITransport(app=client._octop_app),
    )
    original = upstream.ensure_private_expert

    async def before_bootstrap(*args):
        pass

    try:
        await adapter.initialize()
        monkeypatch.setattr(upstream, "ensure_private_expert", before_bootstrap)
        first = await adapter.login({"sub": "existing-shared-owner", "role": "user"})
        monkeypatch.setattr(upstream, "ensure_private_expert", original)
        headers = {"Authorization": "Bearer " + first["access_token"]}
        source = await client.post(
            "/api/agents/from-expert/zhijun-personal-companion",
            headers=headers,
            json={"agent_id": "existing-shared-source", "name": "知君 · 私人伙伴"},
        )
        assert source.status_code == 201
        shared = await client.patch(
            "/api/agents/existing-shared-source", headers=headers, json={"is_shared": True}
        )
        assert shared.status_code == 200
        # Reproduce the production sequence against the real Octop API.
        reserved_id = f"centuarai-zhijun-{first['user']['id']}"
        conflict = await client.post(
            "/api/agents/from-expert/zhijun-personal-companion",
            headers=headers,
            json={"agent_id": reserved_id, "name": "知君 · 私人伙伴"},
        )
        assert conflict.status_code == 409
        assert conflict.json()["error"]["code"] == "AGENT_NAME_TAKEN"
        assert (await client.get(f"/api/agents/{reserved_id}", headers=headers)).status_code == 404
        again = await adapter.login({"sub": "existing-shared-owner", "role": "user"})
        assert again["user"]["id"] == first["user"]["id"]
        rows = (await client.get("/api/agents?scope=mine", headers=headers)).json()
        assert len(rows) == 1
        assert rows[0]["agent_id"] == "existing-shared-source"
        assert rows[0]["is_shared"] is True
    finally:
        await adapter.close()


async def test_companion_failure_does_not_reject_verified_box_login(
    real_octop, oidc_server, monkeypatch, caplog
):
    async def unavailable(*args):
        raise BridgeUpstreamError("BOX_ZHIJUN_INITIALIZATION_FAILED")

    monkeypatch.setattr("wanx_bridge.upstream.ensure_private_expert", unavailable)
    client, _server, credentials = real_octop
    adapter = OctopAdapter(
        "http://127.0.0.1:18088",
        oidc_server,
        credentials,
        transport=httpx.ASGITransport(app=client._octop_app),
    )
    try:
        await adapter.initialize()
        result = await adapter.login({"sub": "account-with-unavailable-companion", "role": "user"})
        assert result["user"]["role"] == "user"
        response = await client.get(
            "/api/auth/me", headers={"Authorization": "Bearer " + result["access_token"]}
        )
        assert response.status_code == 200
        assert response.json()["id"] == result["user"]["id"]
        assert "BOX_ZHIJUN_INITIALIZATION_FAILED" in caplog.text
        assert result["access_token"] not in caplog.text
    finally:
        await adapter.close()


async def test_box_application_policy_grants_only_verified_opener(real_octop, oidc_server):
    from tests.support.auth import bearer, login

    client, _server, credentials = real_octop
    headers = bearer(await login(client))
    path = "/api/admin/applications/super-advisory"
    response = await client.post(
        "/api/admin/applications",
        headers=headers,
        json={
            "application_id": "super-advisory",
            "name": "超级参谋团",
            "capabilities": ["chat", "teams", "brainstorm", "zhijun_context"],
        },
    )
    assert response.status_code == 201
    response = await client.put(
        path + "/deployment",
        headers=headers,
        json={"enabled": True, "configuration": {"auto_grant_box_users": True}},
    )
    assert response.status_code == 200
    adapter = OctopAdapter(
        "http://127.0.0.1:18088",
        oidc_server,
        credentials,
        transport=httpx.ASGITransport(app=client._octop_app),
    )
    try:
        await adapter.initialize()
        first = await adapter.login({"sub": "app-first", "role": "user"})
        second = await adapter.login({"sub": "app-second", "role": "user"})
        assert (await client.get(path + "/access", headers=headers)).json() == []
        scoped = await adapter.application_session(first["access_token"], "super-advisory")
        assert scoped["user"]["id"] == first["user"]["id"]
        assert scoped["user"]["application_id"] == "super-advisory"
        grants = (await client.get(path + "/access", headers=headers)).json()
        assert [(g["user_id"], g["enabled"]) for g in grants] == [(first["user"]["id"], True)]
        await adapter.application_session(first["access_token"], "super-advisory")
        assert (await client.get(path + "/access", headers=headers)).json() == grants
        # A new account arriving after deployment gets its own grant when opening.
        other = await adapter.application_session(second["access_token"], "super-advisory")
        assert other["user"]["id"] == second["user"]["id"]
        response = await client.put(
            path + "/access",
            headers=headers,
            json={"user_id": first["user"]["id"], "enabled": False},
        )
        assert response.status_code == 200
        with pytest.raises(BridgeUpstreamError, match="BOX_APPLICATION_ACCESS_DENIED"):
            await adapter.application_session(first["access_token"], "super-advisory")
        response = await client.get(
            "/api/auth/me", headers={"Authorization": "Bearer " + scoped["access_token"]}
        )
        assert response.status_code in {401, 403}
        # Deployment disable must still reject previously authorized accounts.
        response = await client.put(
            path + "/deployment",
            headers=headers,
            json={"enabled": False, "configuration": {"auto_grant_box_users": True}},
        )
        assert response.status_code == 200
        with pytest.raises(BridgeUpstreamError, match="BOX_APPLICATION_ACCESS_DENIED"):
            await adapter.application_session(second["access_token"], "super-advisory")
    finally:
        await adapter.close()


async def test_refuses_existing_enterprise_oidc(real_octop, oidc_server):
    from tests.support.auth import bearer, login

    client, _server, credentials = real_octop
    auth = bearer(await login(client))
    response = await client.put(
        "/api/auth/oidc/config",
        headers=auth,
        json={"issuer": "https://enterprise.example", "client_id": "existing", "enabled": False},
    )
    assert response.status_code == 200
    adapter = OctopAdapter(
        "http://127.0.0.1:18088",
        oidc_server,
        credentials,
        transport=httpx.ASGITransport(app=client._octop_app),
    )
    try:
        with pytest.raises(BridgeUpstreamError, match="BOX_UPSTREAM_OIDC_CONFLICT"):
            await adapter.initialize()
        response = await client.get("/api/auth/oidc/config", headers=auth)
        assert response.json()["issuer"] == "https://enterprise.example"
    finally:
        await adapter.close()


async def test_strong_captcha_is_not_disabled(tmp_path, oidc_server):
    paths = []

    def handler(request):
        paths.append(request.url.path)
        return httpx.Response(200, json={"provider": "turnstile"})

    adapter = OctopAdapter(
        "http://127.0.0.1:18088",
        oidc_server,
        tmp_path / "missing",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(BridgeUpstreamError, match="BOX_UPSTREAM_CAPTCHA_REQUIRED"):
            await adapter.initialize()
        assert paths == ["/api/auth/captcha"]
    finally:
        await adapter.close()


@pytest.mark.skipif(__import__("os").name != "posix", reason="POSIX file permission contract")
async def test_rejects_world_readable_credentials(tmp_path, oidc_server):
    credentials = tmp_path / "credentials.json"
    credentials.write_text('{"username":"admin","password":"secret"}')
    credentials.chmod(0o644)
    adapter = OctopAdapter(
        "http://127.0.0.1:18088",
        oidc_server,
        credentials,
        transport=httpx.MockTransport(lambda _r: httpx.Response(200, json={"provider": "slider"})),
    )
    try:
        with pytest.raises(BridgeUpstreamError, match="BOX_UPSTREAM_CREDENTIALS_INVALID"):
            await adapter.initialize()
    finally:
        await adapter.close()


@pytest.mark.parametrize("mutation", ["issuer", "state", "cookie", "redirect", "duplicate", "pkce"])
async def test_rejects_untrusted_oidc_start_without_following_it(tmp_path, mutation):
    provider = make_provider()
    seen = []

    def handler(request):
        seen.append(request.url.path)
        fields = {
            "client_id": provider.client_id,
            "response_type": "code",
            "state": "s" * 32,
            "nonce": "n" * 32,
            "code_challenge_method": "S256",
            "code_challenge": "c" * 43,
            "redirect_uri": "http://127.0.0.1:18088/api/auth/oidc/callback",
        }
        origin = provider.issuer
        cookie = fields["state"]
        if mutation == "issuer":
            origin = "http://192.168.0.102"
        elif mutation == "state":
            fields["state"] = "attacker"
        elif mutation == "cookie":
            cookie = "attacker"
        elif mutation == "redirect":
            fields["redirect_uri"] = "http://192.168.0.102/api/auth/oidc/callback"
        elif mutation == "pkce":
            fields["code_challenge_method"] = "plain"
        url = origin + "/authorize?" + urlencode(fields)
        if mutation == "duplicate":
            url += "&state=attacker"
        return httpx.Response(
            200,
            json={"state": "s" * 32, "authorization_url": url},
            headers={"Set-Cookie": "octop_sso_state=" + cookie + "; Path=/api/auth"},
        )

    adapter = OctopAdapter(
        "http://127.0.0.1:18088",
        provider,
        tmp_path / "unused",
        transport=httpx.MockTransport(handler),
    )
    adapter._initialized = True
    try:
        with pytest.raises(BridgeUpstreamError, match="BOX_UPSTREAM_OIDC_INVALID"):
            await adapter.login({"sub": "account", "role": "user"})
        assert seen == ["/api/auth/oidc/start"]
    finally:
        await adapter.close()
