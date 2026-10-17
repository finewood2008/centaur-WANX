from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import httpx

from octop.infra.dialogue.contracts import event
from octop.infra.dialogue.service import DialogueService
from tests.support.auth import auth_header, create_user


async def test_dialogue_routes_real_auth_and_private_provider_catalog(env: Any) -> None:
    client, server, auth = env
    user = (await client.get("/api/auth/me", headers=auth)).json()
    # Auth profile uses id in the current API.
    uid = user.get("id") or user.get("user_id")
    if uid is None:
        uid = server.services.user_repo.get_by_username("admin").id
    pid = server.services.provider_repo.create(
        name="private dialogue gateway",
        kind="openai",
        base_url="https://platform.test/v1",
        api_key="must-never-reach-model-catalog",
        extra_json='{"dialogue_gateway":true}',
        models_json='[{"id":"private-account-model"}]',
    )
    server.services.settings_repo.set(f"dialogue.provider:dialogue:{uid}", str(pid))
    calls = []

    async def upstream(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(
                200,
                json={
                    "models": [
                        {
                            "id": "a",
                            "name": "Model A",
                            "max_input_bytes": 24000,
                            "api_key": "should-be-stripped",
                        }
                    ]
                },
            )
        if request.url.path.endswith("/quota"):
            return httpx.Response(200, json={"remaining": 5000, "budget": 5000})
        calls.append(json.loads(request.content))
        return httpx.Response(
            200, text=event({"type": "delta", "text": "answer"}) + event({"type": "done"})
        )

    svc = DialogueService(
        server.services, httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    )
    client._transport.app.state.dialogue_service = svc
    try:
        assert (await client.get("/api/dialogue/models")).status_code == 401
        catalog = await client.get("/api/dialogue/models", headers=auth)
        assert catalog.status_code == 200 and "api_key" not in catalog.text
        public = await client.get("/api/providers", headers=auth)
        assert "must-never-reach-model-catalog" not in public.text
        resolved = await client.get("/api/providers/resolved", headers=auth)
        assert "private-account-model" not in resolved.text
        body = {"request_id": uuid.uuid4().hex, "prompt": "question", "models": ["a"]}
        created = await client.post("/api/dialogue/sessions", headers=auth, json=body)
        assert created.status_code == 200, created.text
        sid = created.json()["id"]
        assert (await client.post("/api/dialogue/sessions", headers=auth, json=body)).json()[
            "id"
        ] == sid
        await asyncio.gather(*list(svc.tasks.values()))
        response = await client.get(f"/api/dialogue/sessions/{sid}/events", headers=auth)
        assert (
            response.status_code == 200
            and "snapshot" in response.text
            and "answer" in response.text
        )
        assert len(calls) == 1
        await create_user(client, auth, username="dialogue-other", password="Password123!")
        other = await auth_header(client, username="dialogue-other", password="Password123!")
        assert (await client.get(f"/api/dialogue/sessions/{sid}", headers=other)).status_code == 404
        assert (
            await client.delete(f"/api/dialogue/sessions/{sid}", headers=other)
        ).status_code == 404
        assert (await client.get("/api/dialogue/sessions", headers=other)).json() == {
            "sessions": []
        }
        assert (
            await client.delete(f"/api/dialogue/sessions/{sid}", headers=auth)
        ).status_code == 200
        assert (await client.get(f"/api/dialogue/sessions/{sid}", headers=auth)).status_code == 404
    finally:
        await svc.close()
