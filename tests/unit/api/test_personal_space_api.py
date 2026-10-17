from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from octop.api.deps import current_user, get_server
from octop.api.routers.personal_space import router
from octop.infra.personal_space.service import CHUNK_SIZE


@pytest.mark.asyncio
async def test_api_identity_chunk_contract_and_application_boundary(tmp_path: Path) -> None:
    app = FastAPI()
    app.include_router(router, prefix="/api/personal-space")
    identity = SimpleNamespace(id=1, application_id="wanx")
    app.dependency_overrides[current_user] = lambda: identity
    app.dependency_overrides[get_server] = lambda: SimpleNamespace(
        paths=SimpleNamespace(root=tmp_path)
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/personal-space/overview")
        assert response.json()["protocolVersion"] == 1
        body = {"id": "a" * 32, "name": "report.txt", "size": 3}
        assert (
            await client.post("/api/personal-space/uploads", json={**body, "user_id": 2})
        ).status_code == 422
        assert (await client.post("/api/personal-space/uploads", json=body)).status_code == 200
        digest = hashlib.sha256(b"abc").hexdigest()
        response = await client.put(
            f"/api/personal-space/uploads/{'a' * 32}?offset=0",
            content=b"abc",
            headers={"x-content-sha256": digest},
        )
        assert response.json() == {"offset": 3}
        response = await client.post(
            f"/api/personal-space/uploads/{'a' * 32}/complete", json={"digest": digest}
        )
        assert response.json()["name"] == "report.txt"
        identity.id = 2
        assert (
            await client.get(f"/api/personal-space/files/{'a' * 32}/content")
        ).status_code == 404
        identity.id = 1
        response = await client.get(f"/api/personal-space/files/{'a' * 32}/content?length=3")
        assert response.content == b"abc"
        assert response.headers["x-content-sha256"] == digest
        response = await client.put(
            f"/api/personal-space/uploads/{'a' * 32}?offset=0", content=b"x" * (CHUNK_SIZE + 1)
        )
        assert response.status_code == 413
        identity.application_id = "zhijun"
        assert (await client.get("/api/personal-space/overview")).status_code == 200
        assert (
            await client.get(f"/api/personal-space/files/{'a' * 32}/content")
        ).status_code == 200
