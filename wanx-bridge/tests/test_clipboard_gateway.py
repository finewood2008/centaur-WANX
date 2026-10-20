"""Business ingress shares the platform lease but never the core implementation."""

import asyncio
import time

import httpx
import pytest
from test_gateway import Auth, live_server

from wanx_bridge.server import _allowed, create_app


class Body(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b'{"ok":true}'


@pytest.mark.parametrize("suffix", ["/note", "/agent-access", "/batches", "/abcd/content"])
async def test_clipboard_uses_private_service_and_revalidated_lease(suffix):
    seen = []

    async def target(request):
        seen.append(request)
        return httpx.Response(
            200,
            stream=Body(),
            headers={"x-octop-access-token": "private", "set-cookie": "secret=private"},
        )

    auth = Auth()
    app = create_app(auth, None, http_transport=httpx.MockTransport(target))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://box"
        ) as c:
            headers = {
                "authorization": "Bearer opaque-marker",
                "origin": "http://box",
                "x-space-link": "independent-agent-credential",
                "x-content-sha256": "digest",
            }
            path = "/api/clipboard/v1" + suffix
            response = await c.put(path, headers=headers, content=b"chunk")
            assert response.status_code == 200
            assert "x-octop-access-token" not in response.headers
            assert "set-cookie" not in response.headers
            assert seen[-1].url.host == "127.0.0.1"
            assert seen[-1].url.port == 8092
            assert seen[-1].url.path == path
            assert seen[-1].content == b"chunk"
            assert seen[-1].headers["authorization"] == "Bearer opaque-marker"
            assert seen[-1].headers["x-space-link"] == "independent-agent-credential"
            assert "origin" not in seen[-1].headers
            assert (await c.get("/api/personal-space/files", headers=headers)).status_code == 200
            assert seen[-1].url.port == 18088
            n = len(seen)
            assert (await c.get(path)).status_code == 401
            auth.session.user["application_id"] = "other-app"
            assert (await c.get(path, headers=headers)).status_code == 403
            auth.session.user["application_id"] = "wanx"
            auth.deadline = time.monotonic() - 1
            assert (await c.get(path, headers=headers)).status_code == 401
            assert len(seen) == n


async def test_clipboard_service_unavailable_never_falls_back_to_core_or_another_host():
    seen = []

    def unavailable(request):
        seen.append(request.url)
        raise httpx.ConnectError("offline", request=request)

    for url, status in [(None, 503), ("http://127.0.0.1:8092", 502)]:
        app = create_app(
            Auth(), None, clipboard_url=url, http_transport=httpx.MockTransport(unavailable)
        )
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://box"
            ) as c:
                response = await c.get(
                    "/api/clipboard/v1/note", headers={"authorization": "Bearer opaque-marker"}
                )
                assert response.status_code == status
    assert len(seen) == 1 and seen[0].port == 8092
    for url in [
        "http://remote:8092",
        "http://user@localhost:8092",
        "http://127.0.0.1:8092/path",
        "http://127.0.0.1:8092?token=x",
    ]:
        with pytest.raises(ValueError, match="loopback"):
            create_app(Auth(), None, clipboard_url=url)
    assert not _allowed("/api/clipboard/v1/note", "WEBSOCKET")


async def test_lease_expiry_cancels_inflight_business_write():
    import contextlib

    from fastapi import FastAPI, Request

    service = FastAPI()
    started, released = asyncio.Event(), asyncio.Event()

    @service.put("/api/clipboard/v1/note")
    async def save(request: Request):
        await request.body()
        started.set()
        await released.wait()
        return {"ok": True}

    auth = Auth()
    async with live_server(service) as service_url:
        bridge = create_app(auth, None, clipboard_url=service_url, lease_check_interval=0.01)
        async with live_server(bridge) as url:
            async with httpx.AsyncClient(base_url=url) as c:
                pending = asyncio.create_task(
                    c.put(
                        "/api/clipboard/v1/note",
                        headers={"authorization": "Bearer opaque-marker"},
                        json={},
                    )
                )
                try:
                    await asyncio.wait_for(started.wait(), 2)
                    auth.deadline = time.monotonic() - 1
                    response = await asyncio.wait_for(pending, 2)
                    assert response.status_code == 401
                finally:
                    released.set()
                    with contextlib.suppress(Exception):
                        await pending
