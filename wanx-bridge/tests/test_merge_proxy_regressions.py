"""Semantica forwarding and Octop profile recovery coexist after integration."""

import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest
from test_gateway import Auth
from test_ontology_recovery import upstream_response

from wanx_bridge import server
from wanx_bridge.semantica import PREFIX


async def test_native_ontology_not_found_does_not_recover_octop_profile(monkeypatch):
    recover = AsyncMock()
    monkeypatch.setattr(server, "recover_private_profile", recover)
    seen = []

    async def handle(request):
        seen.append(request)
        if request.url.path == "/api/auth/me":
            return httpx.Response(200, json={"id": "mapped-user", "role": "admin"})
        return upstream_response(404, "NOT_FOUND")

    app = server.create_app(
        Auth(),
        object(),
        semantica_url="http://semantica:8090",
        http_transport=httpx.MockTransport(handle),
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://box"
        ) as client:
            response = await client.get(
                PREFIX + "/ontologies/missing",
                headers={"authorization": "Bearer opaque-marker"},
            )
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "NOT_FOUND"}}
    assert response.headers["cache-control"] == "no-store"
    assert [request.url.path for request in seen] == ["/api/auth/me", "/api/ontologies/missing"]
    assert seen[-1].url.host == "semantica"
    recover.assert_not_called()


@pytest.mark.parametrize("phase", ["recovery", "retry"])
async def test_ontology_disconnect_cancels_recovery_or_retry(monkeypatch, phase):
    started = asyncio.Event()
    cancelled = asyncio.Event()
    disconnected = asyncio.Event()
    responses = []
    calls = 0

    async def block_until_cancelled():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async def recover(*args):
        if phase == "recovery":
            await block_until_cancelled()
        return True

    monkeypatch.setattr(server, "recover_private_profile", recover)

    async def handle(request):
        nonlocal calls
        await request.aread()
        calls += 1
        if calls == 2:
            await block_until_cancelled()
        response = upstream_response(404, "NOT_FOUND")
        responses.append(response)
        return response

    app = server.create_app(Auth(), object(), http_transport=httpx.MockTransport(handle))
    body_delivered = False
    messages = []

    async def receive():
        nonlocal body_delivered
        if not body_delivered:
            body_delivered = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await disconnected.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/agents/owned-agent/ontology",
        "query_string": b"",
        "root_path": "",
        "headers": [(b"authorization", b"Bearer opaque-marker")],
        "client": ("127.0.0.1", 1),
        "server": ("box", 80),
    }
    async with app.router.lifespan_context(app):
        task = asyncio.create_task(app(scope, receive, send))
        try:
            await asyncio.wait_for(started.wait(), 2)
            disconnected.set()
            await asyncio.wait_for(cancelled.wait(), 2)
            await asyncio.wait_for(task, 2)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    assert calls == (1 if phase == "recovery" else 2)
    assert responses and all(response.is_closed for response in responses)
    assert [
        message["status"] for message in messages if message["type"] == "http.response.start"
    ] == [499]
