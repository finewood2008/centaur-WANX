from __future__ import annotations

import base64
import hashlib
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from octop.api.deps import current_user, get_server
from octop.api.routers import personal_space, space_links


@pytest.mark.asyncio
async def test_scoped_api_typed_contract_and_owner_identity(tmp_path: Path) -> None:
    app = FastAPI()
    app.include_router(personal_space.router, prefix="/api/personal-space")
    app.include_router(space_links.router, prefix="/api/personal-space")
    identity = SimpleNamespace(id=1)
    app.dependency_overrides[current_user] = lambda: identity
    app.dependency_overrides[get_server] = lambda: SimpleNamespace(
        paths=SimpleNamespace(root=tmp_path)
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://box"
    ) as client:
        base = "/api/personal-space"
        folder = (await client.post(base + "/folders", json={"name": "test"})).json()
        link = (await client.post(base + "/agent-links", json={"root": folder["id"]})).json()
        headers = {"X-Space-Link": link["token"]}

        async def op(**body: object) -> httpx.Response:
            return await client.post(base + "/agent-access", json=body, headers=headers)

        assert (
            await client.post(base + "/agent-access", json={"action": "describe"})
        ).status_code == 422
        assert (await op(action="describe", owner=2)).status_code == 422
        uid = "1" * 32
        assert (
            await op(action="begin-write", upload_id=uid, size=3, name="a.txt")
        ).status_code == 200
        assert (await op(action="write-chunk", upload_id=uid, data="!")).status_code == 400
        digest = hashlib.sha256(b"abc").hexdigest()
        assert (
            await op(
                action="write-chunk",
                upload_id=uid,
                data=base64.b64encode(b"abc").decode(),
                digest=digest,
            )
        ).status_code == 200
        entry = (await op(action="commit-write", upload_id=uid, digest=digest)).json()
        read = await op(action="read", target=entry["id"], expected=entry["version"])
        assert read.content == b"abc" and read.headers["X-Content-SHA256"] == digest
        identity.id = 2
        assert (await op(action="describe")).status_code == 403
        identity.id = 1
        assert (await client.delete(base + "/agent-links/" + link["id"])).status_code == 204
        assert (await op(action="describe")).status_code == 403
        spec = (await client.get("/openapi.json")).json()
        assert spec["paths"][base + "/agent-access"]["post"]["summary"]
