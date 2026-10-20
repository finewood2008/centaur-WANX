"""Existing leases recover only a missing owned companion profile, once."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from test_zhijun_bootstrap import AID, UID, Adapter, expert

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.server import create_app


class JsonStream(httpx.AsyncByteStream):
    def __init__(self, body):
        self.body = json.dumps(body).encode()
        self.closed = False

    async def __aiter__(self):
        yield self.body

    async def aclose(self):
        self.closed = True


def upstream_response(status, code):
    return httpx.Response(
        status,
        stream=JsonStream({"error": {"code": code}}),
        headers={"content-type": "application/json"},
    )


@pytest.mark.parametrize(
    "status,code,method,suffix,row,other",
    [
        (403, "NOT_FOUND", "GET", "", expert(zhijun_primary=False), None),
        (500, "NOT_FOUND", "GET", "", expert(zhijun_primary=False), None),
        (404, "AGENT_NOT_FOUND", "GET", "", expert(zhijun_primary=False), None),
        (404, "NOT_FOUND", "POST", "/prepare", expert(zhijun_primary=False), None),
        (404, "NOT_FOUND", "GET", "/context/thread", expert(zhijun_primary=False), None),
        (404, "NOT_FOUND", "GET", "", expert(zhijun_primary=False, user_id=99), None),
        (404, "NOT_FOUND", "GET", "", expert(zhijun_primary=False, is_shared=True), None),
        (404, "NOT_FOUND", "GET", "", expert(zhijun_primary=False, kind="team"), None),
        (404, "NOT_FOUND", "GET", "", expert(zhijun_primary=False, application_id="other"), None),
        (404, "NOT_FOUND", "GET", "", expert(), None),
        (404, "NOT_FOUND", "GET", "", expert(zhijun_primary=True), None),
        (
            404,
            "NOT_FOUND",
            "GET",
            "",
            expert(zhijun_primary=False),
            expert(agent_id="chosen", zhijun_primary=True),
        ),
        (404, "NOT_FOUND", "GET", "", expert(agent_id="unrelated", zhijun_primary=False), None),
    ],
)
async def test_unrelated_errors_or_agents_are_never_repaired(
    status, code, method, suffix, row, other
):
    adapter = Adapter(rows=[row] + ([other] if other else []), created=row)
    calls = []

    async def handler(request):
        calls.append(request)
        assert request.headers["authorization"] == "Bearer user-session"
        return upstream_response(status, code)

    auth = SimpleNamespace(
        authorize=AsyncMock(return_value={"user": {"id": UID}, "upstream_token": "user-session"}),
        assert_live=AsyncMock(),
    )
    app = create_app(auth, adapter, http_transport=httpx.MockTransport(handler))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://box"
        ) as client:
            response = await client.request(
                method,
                f"/api/agents/{row['agent_id']}/ontology{suffix}",
                headers={"Authorization": "Bearer lease"},
            )
    assert response.status_code == status
    assert response.json() == {"error": {"code": code}}
    assert len(calls) == 1
    assert all(method == "GET" for method, _, _ in adapter.calls)


@pytest.mark.parametrize("revoke", [False, True])
async def test_recovery_checks_live_lease_and_never_retries_twice(revoke):
    row = expert(zhijun_primary=False)
    adapter = Adapter(rows=[row], created=row)
    calls = []
    expired = False
    original = adapter._request

    async def adapter_request(method, path, **kwargs):
        nonlocal expired
        result = await original(method, path, **kwargs)
        if revoke and method == "GET":
            expired = True
        return result

    adapter._request = adapter_request

    async def live(session):
        if expired:
            raise BridgeAuthError("BOX_PLATFORM_SESSION_EXPIRED", 401)

    async def handler(request):
        calls.append(request)
        return upstream_response(404, "NOT_FOUND")

    auth = SimpleNamespace(
        authorize=AsyncMock(return_value={"user": {"id": UID}, "upstream_token": "user-session"}),
        assert_live=live,
    )
    app = create_app(auth, adapter, http_transport=httpx.MockTransport(handler))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://box"
        ) as client:
            response = await client.get(
                f"/api/agents/{AID}/ontology", headers={"Authorization": "Bearer lease"}
            )
    assert response.status_code == (401 if revoke else 404)
    assert len(calls) == (1 if revoke else 2)
    assert len([call for call in adapter.calls if call[0] == "PUT"]) == (0 if revoke else 1)


async def test_lease_revoked_when_retry_finishes_closes_second_response():
    row = expert(zhijun_primary=False)
    adapter = Adapter(rows=[row], created=row)
    responses = []
    retry_returned = asyncio.Event()
    revoked = asyncio.Event()

    async def handler(request):
        result = upstream_response(404, "NOT_FOUND")
        responses.append(result)
        if len(responses) == 2:
            retry_returned.set()
        return result

    async def live(session):
        # Only the watcher waits; ordinary request checks remain deterministic.
        if asyncio.current_task().get_coro().__name__ == "watch":
            await retry_returned.wait()
            revoked.set()
            raise BridgeAuthError("BOX_PLATFORM_SESSION_EXPIRED", 401)

    auth = SimpleNamespace(
        authorize=AsyncMock(return_value={"user": {"id": UID}, "upstream_token": "user-session"}),
        assert_live=live,
    )
    app = create_app(auth, adapter, http_transport=httpx.MockTransport(handler))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://box"
        ) as client:
            result = await client.get(
                f"/api/agents/{AID}/ontology", headers={"Authorization": "Bearer lease"}
            )
    assert revoked.is_set()
    assert result.status_code == 401
    assert len(responses) == 2
    assert all(result.is_closed for result in responses)
