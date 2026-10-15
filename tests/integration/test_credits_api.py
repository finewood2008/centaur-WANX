"""Exercise the real auth middleware, account mapping and application billing boundary."""

from __future__ import annotations

import hashlib
import json

import pytest

from octop.api.deps import sign_token
from tests.support.auth import bearer

ISSUER = "https://accounts.wanx.test"
APP_KEY = "test-only-application-service-key-0123456789"


@pytest.fixture
async def credits_env(env, monkeypatch):
    client, server, auth = env
    monkeypatch.setenv("WANX_CREDITS_AUTHORITY", "1")
    monkeypatch.setenv("WANX_CREDITS_ISSUER", ISSUER)
    monkeypatch.setenv(
        "WANX_CREDITS_APP_KEY_HASHES",
        json.dumps({"zhijun": hashlib.sha256(APP_KEY.encode()).hexdigest()}),
    )
    services = server.services
    admin = server.user_manager.get("admin")
    provider = services.sso_repo.upsert_provider(
        enabled=True,
        display_name="WANX",
        issuer=ISSUER,
        client_id="central-ledger",
        client_secret_enc=None,
        scopes="openid",
        dashboard_origin=None,
    )
    services.user_repo.upsert_sso_identity(
        admin.id, provider_id=provider.id, subject="account-from-verified-sso"
    )
    scoped = bearer(
        sign_token(
            services.secret_repo.get("jwt"),
            sub=admin.id,
            uname=admin.username,
            role=admin.role,
            application_id="zhijun",
        )
    )
    yield client, server, auth, scoped, admin, provider


def grant_body(user_id, **overrides):
    return dict(
        request_id="payment-1",
        user_id=user_id,
        kind="paid",
        credits=100,
        source_ref="payment:order-1",
        reason="Operator verified payment",
        **overrides,
    )


def reserve_body(**overrides):
    value = {
        "request_id": "authorize-1",
        "application_id": "zhijun",
        "task_id": "task-1",
        "description": "User approved quoted task",
        "budget": 80,
        "ttl_seconds": 900,
    }
    value.update(overrides)
    return value


async def test_disabled_by_default_and_auth_is_required(env, monkeypatch):
    client, _, auth = env
    monkeypatch.delenv("WANX_CREDITS_AUTHORITY", raising=False)
    assert (await client.get("/api/credits/balance")).status_code == 401
    response = await client.get("/api/credits/balance", headers=auth)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "CREDITS_DISABLED"


async def test_paid_post_authorize_settle_refund_and_retry(credits_env):
    client, _, auth, scoped, admin, _ = credits_env
    posted = await client.post("/api/admin/credits/grants", headers=auth, json=grant_body(admin.id))
    assert posted.status_code == 200, posted.text
    again = await client.post("/api/admin/credits/grants", headers=auth, json=grant_body(admin.id))
    assert again.json() == posted.json()
    result = await client.post("/api/credits/reservations", headers=auth, json=reserve_body())
    assert result.status_code == 200, result.text
    rid = result.json()["reservation"]["reservation_id"]
    service_auth = {**scoped, "X-WANX-Application-Key": APP_KEY}
    base = "/api/credits/reservations/" + rid
    started = await client.post(
        base + "/start", headers=service_auth, json={"request_id": "start-1"}
    )
    assert started.status_code == 200, started.text
    charged = await client.post(
        base + "/settle", headers=service_auth, json={"request_id": "settle-1", "credits": 45}
    )
    assert charged.status_code == 200, charged.text
    assert charged.json()["balance"]["available"] == 55
    assert charged.json()["balance"]["held"] == 0
    again = await client.post(
        base + "/settle", headers=service_auth, json={"request_id": "settle-1", "credits": 45}
    )
    assert charged.json() == again.json()
    returned = await client.post(
        base + "/refund",
        headers=service_auth,
        json={"request_id": "refund-1", "credits": 20, "reason": "Application failed partially"},
    )
    assert returned.status_code == 200, returned.text
    assert returned.json()["balance"]["available"] == 75
    balance = await client.get("/api/credits/balance", headers=auth)
    assert balance.json()["account_id"] == "account-from-verified-sso"
    assert balance.headers["cache-control"] == "no-store"
    own = (await client.get("/api/credits/transactions", headers=auth)).json()
    app = (await client.get("/api/credits/transactions", headers=scoped)).json()
    assert len(own) == 5 and len(app) == 4
    assert all(row["application_id"] == "zhijun" for row in app)
    cursor = own[1]["sequence"]
    tail = (
        await client.get("/api/credits/transactions", headers=auth, params={"after": cursor})
    ).json()
    assert tail == own[2:]


async def test_app_cannot_grant_authorize_or_charge_with_just_a_user_token(credits_env):
    client, _, auth, scoped, admin, _ = credits_env
    result = await client.post(
        "/api/admin/credits/grants", headers=scoped, json=grant_body(admin.id)
    )
    assert result.status_code == 404  # App-scoped admin is not a platform administrator.
    await client.post("/api/admin/credits/grants", headers=auth, json=grant_body(admin.id))
    assert (
        await client.post("/api/credits/reservations", headers=scoped, json=reserve_body())
    ).status_code == 404
    hold = await client.post("/api/credits/reservations", headers=auth, json=reserve_body())
    rid = hold.json()["reservation"]["reservation_id"]
    base = "/api/credits/reservations/" + rid
    for headers in [
        scoped,
        {**scoped, "X-WANX-Application-Key": "wrong"},
        {**auth, "X-WANX-Application-Key": APP_KEY},
    ]:
        result = await client.post(base + "/start", headers=headers, json={"request_id": "start"})
        assert result.status_code == 403
    release = await client.post(
        base + "/release", headers=auth, json={"request_id": "cancel", "reason": "Before execution"}
    )
    assert release.status_code == 200
    assert release.json()["balance"]["available"] == 100


async def test_local_ids_untrusted_issuers_disabled_provider_and_body_account_are_rejected(
    credits_env, monkeypatch
):
    client, server, auth, _, admin, provider = credits_env
    server.services.user_repo.remove_sso_identity(admin.id, provider_id=provider.id)
    response = await client.get("/api/credits/balance", headers=auth)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "CREDITS_IDENTITY"
    server.services.user_repo.upsert_sso_identity(
        admin.id, provider_id=provider.id, subject="same-account"
    )
    monkeypatch.setenv("WANX_CREDITS_ISSUER", "https://different-authority.test")
    assert (await client.get("/api/credits/balance", headers=auth)).status_code == 403
    monkeypatch.setenv("WANX_CREDITS_ISSUER", ISSUER)
    with server.services.db.transaction() as conn:
        conn.execute("UPDATE sso_providers SET enabled=0 WHERE id=?", (provider.id,))
    assert (await client.get("/api/credits/balance", headers=auth)).status_code == 403
    response = await client.post(
        "/api/credits/reservations", headers=auth, json=reserve_body(account_id="victim-account")
    )
    assert response.status_code == 422


@pytest.mark.parametrize("value", [True, 1.5, -1, 0, 9_000_000_000_001])
async def test_invalid_amounts_never_post_credits(credits_env, value):
    client, _, auth, _, admin, _ = credits_env
    body = grant_body(admin.id)
    body["credits"] = value
    result = await client.post("/api/admin/credits/grants", headers=auth, json=body)
    assert result.status_code == 422
    assert (await client.get("/api/credits/balance", headers=auth)).json()["available"] == 0


async def test_cross_account_hold_is_hidden(credits_env):
    client, server, auth, _, admin, provider = credits_env
    await client.post("/api/admin/credits/grants", headers=auth, json=grant_body(admin.id))
    hold = await client.post("/api/credits/reservations", headers=auth, json=reserve_body())
    rid = hold.json()["reservation"]["reservation_id"]
    from tests.support.auth import auth_header, create_user

    await create_user(client, auth, username="other-user")
    other = server.user_manager.get("other-user")
    server.services.user_repo.upsert_sso_identity(
        other.id, provider_id=provider.id, subject="other-wanx-account"
    )
    other_auth = await auth_header(client, username="other-user")
    assert (
        await client.get("/api/credits/reservations/" + rid, headers=other_auth)
    ).status_code == 404
    assert (
        await client.post(
            "/api/admin/credits/grants", headers=other_auth, json=grant_body(other.id)
        )
    ).status_code == 403
    assert (await client.get("/api/credits/balance", headers=other_auth)).json()["available"] == 0


async def test_registered_apps_cannot_touch_other_apps_and_revocation_is_immediate(
    credits_env, monkeypatch
):
    client, server, auth, _, admin, _ = credits_env
    services = server.services
    app_id = "other-app"
    repo = services.application_repo
    repo.create(
        {
            "application_id": app_id,
            "name": "Other app",
            "description": "Test application",
            "capabilities": [],
            "agent_template": {},
            "resource_requirements": {},
        },
        created_by=admin.id,
    )
    repo.put_deployment(app_id, {"enabled": True, "resource_bindings": {}, "configuration": {}})
    repo.put_access(app_id, admin.id, True)
    monkeypatch.setenv(
        "WANX_CREDITS_APP_KEY_HASHES",
        json.dumps(
            {name: hashlib.sha256(APP_KEY.encode()).hexdigest() for name in ["zhijun", app_id]}
        ),
    )
    app_auth = {
        **bearer(
            sign_token(
                services.secret_repo.get("jwt"),
                sub=admin.id,
                uname=admin.username,
                role=admin.role,
                application_id=app_id,
            )
        ),
        "X-WANX-Application-Key": APP_KEY,
    }
    await client.post("/api/admin/credits/grants", headers=auth, json=grant_body(admin.id))
    hold = await client.post("/api/credits/reservations", headers=auth, json=reserve_body())
    base = "/api/credits/reservations/" + hold.json()["reservation"]["reservation_id"]
    assert (await client.get(base, headers=app_auth)).status_code == 404
    assert (
        await client.post(base + "/start", headers=app_auth, json={"request_id": "other-start"})
    ).status_code == 404
    assert (await client.get("/api/credits/transactions", headers=app_auth)).json() == []
    own = await client.post(
        "/api/credits/reservations",
        headers=auth,
        json=reserve_body(request_id="other-hold", application_id=app_id, budget=20),
    )
    assert own.status_code == 200, own.text
    own_base = "/api/credits/reservations/" + own.json()["reservation"]["reservation_id"]
    assert (
        await client.post(own_base + "/start", headers=app_auth, json={"request_id": "other-start"})
    ).status_code == 200
    repo.put_access(app_id, admin.id, False)
    assert (
        await client.post(
            own_base + "/settle",
            headers=app_auth,
            json={"request_id": "other-settle", "credits": 10},
        )
    ).status_code == 403
    assert (await client.get("/api/credits/balance", headers=auth)).json()["held"] == 100


async def test_financial_routes_reject_query_tokens_even_with_a_bearer_header(credits_env):
    client, _, auth, _, _, _ = credits_env
    token = next(iter(auth.values())).removeprefix("Bearer ")
    for headers in [{}, auth]:
        result = await client.get(
            "/api/credits/balance", headers=headers, params={"access_token": token}
        )
        assert result.status_code == 403


async def test_openapi_documents_typed_credit_contracts(env):
    from dataclasses import replace

    import httpx

    from octop.api.app import build_app

    _, server, _ = env
    server.services = replace(
        server.services, config=replace(server.services.config, enable_api_docs=True)
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=build_app(server)), base_url="http://testserver"
    ) as client:
        assert (await client.get("/api/docs")).status_code == 200
        response = await client.get("/api/openapi.json")
        assert response.status_code == 200
        schema = response.json()
    paths = schema["paths"]
    assert paths["/api/credits/reservations"]["post"]["summary"]
    assert paths["/api/credits/balance"]["get"]["responses"]["200"]["content"]["application/json"][
        "schema"
    ]["$ref"].endswith("/Balance")
    assert paths["/api/admin/credits/grants"]["post"]["requestBody"]["content"]["application/json"][
        "schema"
    ]["$ref"].endswith("/Grant")
