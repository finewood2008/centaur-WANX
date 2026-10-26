"""Owner-private assistant bootstrap and reuse, with no real model calls."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from octop.infra.agents.assistant_profile import PREFERENCE_KEY, AssistantProfiles
from octop.infra.agents.experts.catalog import build_create_spec_from_expert
from octop.infra.errors import OctopError
from octop.infra.users.identity import User
from tests.support.auth import create_agent, create_provider, create_user, resolve_user_id
from tests.support.http import chat_ws_path, ws_connect


async def test_assistant_is_authenticated_private_and_concurrent(env_with_provider: Any) -> None:
    client, server, admin = env_with_provider
    assert (await client.post("/api/assistant/profile")).status_code == 401
    alice = await create_user(client, admin, username="assistant-alice", permissions=[])
    uid = await resolve_user_id(client, admin, "assistant-alice")
    server.services.user_repo.set_preferences_json(uid, '{"timezone":"Asia/Singapore"}')
    responses = await asyncio.gather(
        *(client.post("/api/assistant/profile", headers=alice) for _ in range(6))
    )
    assert all(r.status_code == 200 for r in responses), [r.text for r in responses]
    aid = responses[0].json()["agent_id"]
    assert {r.json()["agent_id"] for r in responses} == {aid}
    assert responses[0].json()["template_id"] == "default"
    row = server.services.agent_repo.get(aid)
    assert row.user_id == uid and row.template_name == "default" and not row.is_shared
    prefs = json.loads(server.services.user_repo.get(uid).preferences_json)
    assert prefs == {"timezone": "Asia/Singapore", PREFERENCE_KEY: aid}
    assert len(server.services.agent_repo.list_by_user(uid)) == 1
    server.services.user_repo.set_preferences_json(uid, "")
    recovered = await client.post("/api/assistant/profile", headers=alice)
    assert recovered.json()["agent_id"] == aid
    bob = await create_user(client, admin, username="assistant-bob")
    other = await client.post("/api/assistant/profile", headers=bob)
    assert other.json()["agent_id"] != aid
    assert (await client.get(f"/api/agents/{aid}/threads", headers=bob)).status_code == 403
    schema = client._octop_app.openapi()
    assert schema["paths"]["/api/assistant/profile"]["post"]["summary"]


async def test_assistant_reuses_oldest_owned_default_and_repairs_stale_binding(
    env_with_provider: Any,
) -> None:
    client, server, admin = env_with_provider
    auth = await create_user(client, admin, username="assistant-reuse")
    uid = await resolve_user_id(client, admin, "assistant-reuse")
    registry = server.app_runtime.agent_registry
    expert = server.expert_catalog.get("default")
    for aid in ("private-older", "private-newer"):
        await registry.create(
            build_create_spec_from_expert(
                expert_id="default",
                expert=expert,
                user_id=uid,
                name=aid,
                agent_id=aid,
            )
        )
    candidates = server.services.agent_repo.list_by_user(uid)
    expected = min(candidates, key=lambda r: (r.created_at, r.agent_id)).agent_id
    server.services.user_repo.set_preferences_json(uid, json.dumps({PREFERENCE_KEY: "missing"}))
    result = await client.post("/api/assistant/profile", headers=auth)
    assert result.status_code == 200, result.text
    assert result.json()["agent_id"] == expected
    assert len(server.services.agent_repo.list_by_user(uid)) == 2

    server.services.agent_repo.set_enabled(expected, False)
    assert (await client.post("/api/assistant/profile", headers=auth)).status_code == 403
    assert len(server.services.agent_repo.list_by_user(uid)) == 2


async def test_assistant_native_model_switch_attachment_and_scope(env_with_provider: Any) -> None:
    client, server, admin = env_with_provider
    auth = await create_user(client, admin, username="assistant-native", permissions=[])
    uid = await resolve_user_id(client, admin, "assistant-native")
    await create_provider(
        client,
        admin,
        name="second",
        kind="openai",
        api_key="synthetic-only",
        base_url="https://synthetic.invalid/v1",
        models=[{"id": "model-b", "name": "Model B", "enabled": True, "input": ["text"]}],
    )
    before = (await client.get("/api/providers/active-model", headers=admin)).json()
    profile = (await client.post("/api/assistant/profile", headers=auth)).json()
    aid = profile["agent_id"]
    registry = server.app_runtime.agent_registry
    await registry.update(aid, default_model="openai/gpt-4o")
    agent = registry.get_agent(aid)
    agent.chunks = [{"type": "token", "content": "synthetic answer"}]
    uploaded = await client.post(
        f"/api/agents/{aid}/upload",
        headers=auth,
        files={"file": ("synthetic.txt", b"Synthetic QA material", "text/plain")},
    )
    assert uploaded.status_code == 200, uploaded.text
    file = uploaded.json()
    tid = (await client.post(f"/api/agents/{aid}/threads", headers=auth)).json()["thread_id"]
    async with ws_connect(client._octop_app, chat_ws_path(aid, auth)) as ws:
        for model in ("openai/gpt-4o", "second/model-b"):
            await ws.send_json(
                {
                    "type": "user_turn",
                    "thread_id": tid,
                    "model": model,
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": f"Continue synthetic task with {model}"},
                                {
                                    "type": "file",
                                    "filename": file["filename"],
                                    "workspace_path": file["workspace_path"],
                                    "media_type": file["media_type"],
                                },
                            ],
                        }
                    ],
                }
            )
            frames = await ws.drain_turn()
            assert any(f.get("type") == "token" for f in frames), frames
    history = (await client.get(f"/api/agents/{aid}/threads/{tid}/history", headers=auth)).json()
    users = [m for m in history["messages"] if m["role"] == "user"]
    assert [m["composer_context"]["model"] for m in users] == ["openai/gpt-4o", "second/model-b"]
    assert history["model_ref"] == "second/model-b"
    assert server.services.agent_repo.get(aid).default_model == "openai/gpt-4o"
    assert (await client.get("/api/providers/active-model", headers=admin)).json() == before
    with pytest.raises(OctopError):
        await AssistantProfiles(server).ensure(
            User(
                id=uid,
                username="assistant-native",
                role="user",
                display_name=None,
                application_id="zhijun",
            )
        )


async def test_assistant_preserves_workspace_policy_quota_and_existing_names(
    env_with_provider: Any,
    tmp_path: Path,
) -> None:
    client, server, admin = env_with_provider
    auth = await create_user(client, admin, username="assistant-policy", permissions=[])
    uid = await resolve_user_id(client, admin, "assistant-policy")
    existing = await create_agent(client, auth, name="通用专家")
    root = tmp_path / "private-workspace"
    root.mkdir()
    server.services.user_policy_repo.set(uid, "workspace_root_dir", str(root))
    server.services.user_policy_repo.set(uid, "max_agents", "1")
    denied = await client.post("/api/assistant/profile", headers=auth)
    assert denied.status_code != 200
    assert len(server.services.agent_repo.list_by_user(uid)) == 1
    server.services.user_policy_repo.set(uid, "max_agents", "2")
    result = await client.post("/api/assistant/profile", headers=auth)
    assert result.status_code == 200, result.text
    row = server.services.agent_repo.get(result.json()["agent_id"])
    assert row.agent_id != existing and row.template_name == "default"
    assert row.name != "通用专家"
    assert json.loads(row.config_json)["backend"]["root_dir"] == str(root)
