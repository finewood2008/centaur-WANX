"""The service talks only HTTP, even in tests against the real core router."""

import uuid
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from wanx_clipboard.app import create_app

from octop.api.deps import current_user, get_server
from octop.api.routers import personal_space, space_links


@pytest.fixture
def environment(tmp_path):
    core = FastAPI()
    core.include_router(personal_space.router, prefix="/api/personal-space")
    core.include_router(space_links.router, prefix="/api/personal-space")

    def user(request: Request):
        auth = request.headers.get("authorization", "")
        if auth not in {"Bearer owner-1", "Bearer owner-2"}:
            raise HTTPException(401)
        return SimpleNamespace(id=int(auth[-1]), application_id="wanx")

    core.dependency_overrides[current_user] = user
    core.dependency_overrides[get_server] = lambda: SimpleNamespace(
        paths=SimpleNamespace(root=tmp_path / "core")
    )

    @core.get("/api/auth/me")
    def me(request: Request):
        return {"id": user(request).id}

    client = TestClient(core, headers={"authorization": "Bearer owner-1"})
    calls = []
    fault = {"after": None}

    def handle(request):
        calls.append((request.method, request.url.path))
        response = client.request(
            request.method, str(request.url), content=request.content, headers=request.headers
        )
        if fault["after"]:
            fault["after"](request, response)
        return httpx.Response(
            response.status_code, content=response.content, headers=response.headers
        )

    transport = httpx.MockTransport(handle)
    app = create_app(tmp_path / "business", "http://core", transport=transport)
    business = TestClient(app, headers={"authorization": "Bearer owner-1"})
    yield SimpleNamespace(
        core=core,
        owner=client,
        app=app,
        business=business,
        path=tmp_path,
        calls=calls,
        transport=transport,
        fault=fault,
    )
    business.close()
    client.close()
    app.state.wanx.close()


def descriptor(data=b"synthetic", **fields):
    import hashlib

    return {
        "id": uuid.uuid4().hex,
        "kind": "text",
        "name": "中文 空格 #%.txt",
        "mime": "text/plain",
        "size": len(data),
        "digest": hashlib.sha256(data).hexdigest(),
        "device": "independent-test",
        **fields,
    }
