"""Real HTTP round trip: ingress -> independent service -> ingress -> unchanged core."""

from contextlib import AsyncExitStack
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from test_gateway import Auth, live_server

from wanx_bridge.server import create_app


async def test_note_save_and_agent_read_through_one_authenticated_ingress(tmp_path):
    business_module = pytest.importorskip("wanx_clipboard.app")
    from octop.api.deps import current_user, get_server
    from octop.api.routers.personal_space import router
    from octop.api.routers.space_links import router as links_router

    core = FastAPI()
    core.include_router(router, prefix="/api/personal-space")
    core.include_router(links_router, prefix="/api/personal-space")

    def user(request: Request):
        if request.headers.get("authorization") != "Bearer private.upstream.jwt":
            raise HTTPException(401)
        return SimpleNamespace(id=1, application_id="wanx")

    core.dependency_overrides[current_user] = user
    core.dependency_overrides[get_server] = lambda: SimpleNamespace(
        paths=SimpleNamespace(root=tmp_path / "core")
    )

    @core.get("/api/auth/me")
    def me(request: Request):
        return {"id": user(request).id}

    auth = Auth()
    auth.session.user = {"id": 1, "application_id": "wanx"}
    async with AsyncExitStack() as stack:
        core_url = await stack.enter_async_context(live_server(core))
        business = business_module.create_app(tmp_path / "business", "http://127.0.0.1:1")
        business_url = await stack.enter_async_context(live_server(business))
        ingress = create_app(auth, None, upstream_url=core_url, clipboard_url=business_url)
        url = await stack.enter_async_context(live_server(ingress))
        # Allocate both ephemeral listeners before wiring the test service's upstream.
        business.state.wanx.base_url = url
        async with httpx.AsyncClient(
            base_url=url, headers={"authorization": "Bearer opaque-marker", "origin": url}
        ) as c:
            route = "/api/clipboard/v1/note"
            original = await c.get(route)
            assert original.status_code == 200
            assert original.json()["revision"] == 0
            blocks = [{"type": "text", "text": "便签往返验收\nASCII + 中文"}]
            payload = {"expected": 0, "operation": uuid4().hex, "blocks": blocks}
            saved = await c.put(route, json=payload)
            assert saved.status_code == 200, saved.text
            assert (await c.put(route, json=payload)).json()["revision"] == 1
            assert (await c.get(route)).json()["blocks"] == blocks
            assert (
                await c.put(route, json={**payload, "operation": uuid4().hex})
            ).status_code == 409
            approved = await c.post(
                "/api/personal-space/connections", json={"profile": "note-test", "name": "Agent"}
            )
            assert approved.status_code == 200, approved.text
            agent = approved.json()
            read = {"action": "clipboard-read", "target": "note", "expected": 1}
            headers = {"x-space-link": agent["token"]}
            result = await c.post("/api/clipboard/v1/agent-access", json=read, headers=headers)
            assert result.status_code == 200, result.text
            assert result.json()["blocks"] == blocks
            for action, status in [("pause", 403), ("resume", 200), ("disconnect", 403)]:
                managed = await c.post(
                    f"/api/personal-space/connections/{agent['id']}/manage", json={"action": action}
                )
                assert managed.status_code == 200
                assert (
                    await c.post("/api/clipboard/v1/agent-access", json=read, headers=headers)
                ).status_code == status
