"""Actual ledger routes with an isolated online-identity authority transport."""

import hashlib

import httpx
import pytest

from octop.infra.credits import consumer
from octop.infra.credits.service import CreditService

BASE = "https://consumer.wanx.test/prod-api"
HEADERS = {
    "Authorization": "Bearer test-only-token",
    "X-Nexus-Client-Id": "client-one",
    "X-Nexus-Timestamp": "1700000000",
    "X-Nexus-Nonce": "unique-proof",
    "X-Nexus-Body-SHA256": hashlib.sha256(b"").hexdigest(),
    "X-Nexus-Signature": "authority-validated-proof",
    "X-Nexus-Signature-Version": "NEXUSAOS-CONSUMER-APP-V1",
}


@pytest.fixture
async def consumer_env(env, monkeypatch):
    client, server, _ = env
    monkeypatch.setenv("WANX_CREDITS_AUTHORITY", "1")
    monkeypatch.setenv("WANX_CREDITS_ISSUER", BASE)
    monkeypatch.setenv("WANX_CREDITS_CONSUMER_URL", BASE)
    state = {"subject": "account-one", "status": 200, "active": True}
    original = httpx.AsyncClient

    def handle(req):
        assert str(req.url) == BASE + consumer.BOOTSTRAP
        assert req.headers["authorization"] == HEADERS["Authorization"]
        return httpx.Response(
            state["status"],
            json={
                "success": state["status"] == 200,
                "data": {
                    "account": {
                        "accountId": state["subject"],
                        "accountStatus": "active",
                        "currentClient": {
                            "clientId": "client-one",
                            "clientStatus": "active",
                            "isCurrent": True,
                            "hasActiveSession": state["active"],
                        },
                    }
                },
            },
        )

    monkeypatch.setattr(
        consumer.httpx,
        "AsyncClient",
        lambda **kw: original(**kw, transport=httpx.MockTransport(handle)),
    )
    yield client, server, state


async def test_real_zero_then_ledger_and_task_details_are_account_scoped(consumer_env):
    client, server, state = consumer_env
    response = await client.get("/api/credits/account/balance", headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["available"] == 0
    assert response.headers["cache-control"] == "no-store"
    service = CreditService(server.services, BASE, "account-one")
    service.grant(
        request_id="test-gift",
        kind="gift",
        credits=100,
        expires_at=None,
        source_ref="test:gift",
        reason="Isolated fixture",
        actor="test",
    )
    reserved = service.reserve(
        request_id="test-task",
        application_id="zhijun",
        task_id="t1",
        description="Test task",
        budget=40,
        ttl_seconds=900,
    )
    rid = reserved["reservation"]["reservation_id"]
    response = await client.get(
        "/api/credits/account/transactions?after=0&limit=50", headers=HEADERS
    )
    assert [e["kind"] for e in response.json()] == ["gift_credited", "reserved"]
    assert (await client.get(f"/api/credits/account/reservations/{rid}", headers=HEADERS)).json()[
        "budget"
    ] == 40
    service.transition(
        request_id="start", reservation_id=rid, action="start", application_id="zhijun"
    )
    service.transition(
        request_id="settle",
        reservation_id=rid,
        action="settle",
        application_id="zhijun",
        credits=25,
    )
    assert (await client.get("/api/credits/account/balance", headers=HEADERS)).json()[
        "available"
    ] == 75
    events = (await client.get("/api/credits/account/transactions?after=2", headers=HEADERS)).json()
    assert [event["kind"] for event in events] == ["started", "settled"]
    assert (await client.get(f"/api/credits/account/reservations/{rid}", headers=HEADERS)).json()[
        "charged"
    ] == 25
    state["subject"] = "account-two"
    assert (await client.get("/api/credits/account/balance", headers=HEADERS)).json()[
        "available"
    ] == 0
    assert (await client.get("/api/credits/account/transactions", headers=HEADERS)).json() == []
    assert (
        await client.get(f"/api/credits/account/reservations/{rid}", headers=HEADERS)
    ).status_code == 404


async def test_missing_revoked_and_wrong_client_proofs_do_not_get_account_data(consumer_env):
    client, _, state = consumer_env
    path = "/api/credits/account/balance"
    assert (await client.get(path)).status_code == 403
    assert (
        await client.get(path, headers={**HEADERS, "X-Nexus-Client-Id": "wrong"})
    ).status_code == 403
    state["active"] = False
    assert (await client.get(path, headers=HEADERS)).status_code == 403
    state["status"] = 401
    assert (await client.get(path, headers=HEADERS)).status_code == 403
    state["status"] = 503
    assert (await client.get(path, headers=HEADERS)).status_code == 503
    assert (await client.get(path + "?access_token=x", headers=HEADERS)).status_code == 403
    assert (await client.post(path, headers=HEADERS, json={})).status_code == 401
    assert (
        await client.post("/api/credits/reservations", headers=HEADERS, json={})
    ).status_code == 401


async def test_shadow_session_and_task_views_never_cross_accounts(consumer_env):
    from octop.infra.credits.metering import Meter
    from octop.infra.db.repos.metering import MeterRepo

    client, server, state = consumer_env
    response = await client.get(
        "/api/credits/account/meter-session?application_id=centaurai.wanx.zhijun", headers=HEADERS
    )
    assert response.status_code == 200
    meter = Meter(MeterRepo(server.services.db))
    identity = meter.identity(response.json()["token"])
    quote = meter.create_task(identity["account_key"], identity["application_id"], "test-task")
    meter.start(quote["id"])
    meter.begin_call(quote["id"], "server-call", "deepseek-flash", "deepseek", 1000, 100)
    meter.finish_call(
        quote["id"], "server-call", {"uncached_input_tokens": 1000, "output_tokens": 100}
    )
    meter.finish(quote["id"])
    rows = (await client.get("/api/credits/account/tasks", headers=HEADERS)).json()
    assert rows[0]["charged"] == 0
    assert rows[0]["mode"] == "shadow"
    assert "account_key" not in rows[0] and "total_cost" not in rows[0]
    detail = await client.get("/api/credits/account/tasks/" + quote["id"], headers=HEADERS)
    assert detail.json()["call_count"] == 1
    state["subject"] = "different-account"
    assert (await client.get("/api/credits/account/tasks", headers=HEADERS)).json() == []
    assert (
        await client.get("/api/credits/account/tasks/" + quote["id"], headers=HEADERS)
    ).status_code == 404
    assert (
        await client.get(
            "/api/credits/account/meter-session?application_id=unknown", headers=HEADERS
        )
    ).status_code == 400
    assert (await client.get("/api/credits/account/tasks")).status_code in (401, 403)


async def test_retired_budget_routes_are_not_available(env):
    client, _, auth = env
    for path in (
        "/api/credits/meter/quotes",
        "/api/credits/meter/tasks/" + "a" * 32 + "/authorize",
        "/api/credits/meter/automatic-budget",
        "/api/credits/gateway-scheduler",
    ):
        assert (await client.post(path, headers=auth, json={})).status_code in (404, 405)
