"""SDK bridge contracts: identity, product scope, fixed actions and errors."""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from octop.api.deps import current_user
from octop.api.routers.box_management import mount_box_management
from octop.infra.boxes.management import BoxManagementError, BoxManagementService
from octop.infra.users.identity import User


class RecordingService:
    def __init__(self) -> None:
        self.calls = []
        self.error = None

    async def action(self, actor, action, payload):
        self.calls.append((actor, action, payload))
        if self.error:
            raise BoxManagementError(self.error)
        return {"identity": None}


def make_app(application_id="wanx"):
    app = FastAPI()
    mount_box_management(app)
    service = RecordingService()
    app.state.box_management = service
    app.dependency_overrides[current_user] = lambda: User(
        id=7,
        username="test",
        role="user",
        display_name=None,
        application_id=application_id,
    )
    return app, service


async def test_actor_comes_from_authenticated_wanx_user():
    app, service = make_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/box-management/action", json={"action": "state", "input": {"actor": 999}}
        )
    assert response.status_code == 200
    assert service.calls[0][0] == 7


async def test_product_sessions_cannot_manage_platform_boxes():
    app, service = make_app("zhijun")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post("/api/box-management/action", json={"action": "devices.list"})
    assert response.status_code == 403
    assert service.calls == []


async def test_no_arbitrary_sdk_method_or_actor_override():
    app, service = make_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        for body in [
            {"action": "fetch", "input": {"url": "http://evil"}},
            {"action": "state", "actor": 999},
        ]:
            response = await client.post("/api/box-management/action", json=body)
            assert response.status_code == 422
    assert service.calls == []


async def test_errors_are_safe_and_do_not_invalidate_wanx_login():
    app, service = make_app()
    service.error = "LOGIN_REQUIRED"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post("/api/box-management/action", json={"action": "devices.list"})
    assert response.status_code == 400
    assert response.json() == {"detail": "LOGIN_REQUIRED"}


async def test_real_sdk_worker_state_and_shutdown():
    service = BoxManagementService()
    try:
        state = await service.action(1, "state", {})
        assert state["sdkVersion"] == "1.0.1"
        assert state["identity"] is None
        try:
            await service.action(1, "devices.list", {})
        except BoxManagementError as error:
            assert str(error) == "LOGIN_REQUIRED"
        else:
            raise AssertionError("unauthenticated SDK operation succeeded")
    finally:
        await service.close()
    assert service._process is None
