"""Native MBTI selection changes expression, preserving Zhijun's personal rules."""

import asyncio
import json
from dataclasses import replace
from pathlib import Path
from typing import Any
from unittest.mock import patch

from octop.infra.agents.persona import get_all_profiles, get_profile
from tests.integration.test_zhijun_profile import zhijun_auth
from tests.support.auth import create_agent


async def profile(env: Any) -> tuple[Any, Any, dict[str, str], str]:
    client, server, _ = env
    auth = await zhijun_auth(client)
    aid = (await client.post("/api/zhijun/profile", headers=auth)).json()["profile"]["agent_id"]
    return client, server, {**auth, "X-Octop-Agent-Id": aid}, aid


async def test_all_native_styles_reach_runtime_without_replacing_personal_rules(
    env_with_provider: Any,
) -> None:
    client, server, auth, aid = await profile(env_with_provider)
    registry = server.app_runtime.agent_registry
    registry._repos.agent_repo.update_config(aid, system_prompt="保留的个人规则与记忆边界。")
    before = registry.get_row(aid)
    workspace = registry.get_agent(aid)._workspace_dir
    files = {p.name: p.read_bytes() for p in Path(workspace).glob("*.md")}
    others = {
        r.agent_id: (r.persona_mbti, r.system_prompt, r.config_json)
        for r in registry.list_rows()
        if r.agent_id != aid
    }
    listed = await client.get("/api/mbti/types", headers=auth)
    assert listed.status_code == 200, listed.text
    assert len(listed.json()) == 16
    assert (await client.get("/api/mbti/current", headers=auth)).json() == {
        "code": "",
        "configured": False,
    }
    for preset in get_all_profiles():
        saved = await client.post(
            "/api/mbti/apply", headers=auth, json={"code": preset.code.lower()}
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["success"]
        assert (await client.get("/api/mbti/current", headers=auth)).json() == {
            "code": preset.code,
            "configured": True,
        }
        entry = registry._harness_manager.get_agent(aid)
        assert entry.config.system_prompt.startswith(before.system_prompt)
        assert preset.behavior.answer_style_zh in entry.config.system_prompt
        assert preset.behavior.emotion_zh in entry.config.system_prompt
        assert "不是对用户人格的判断" in entry.config.system_prompt
        assert registry.get_row(aid).system_prompt == before.system_prompt
        assert {p.name: p.read_bytes() for p in Path(workspace).glob("*.md")} == files
        cfg = json.loads(registry.get_row(aid).config_json)
        assert {k: v for k, v in cfg.items() if k != "persona"} == json.loads(before.config_json)
    reset = await client.post("/api/mbti/apply", headers=auth, json={"code": "_default"})
    assert reset.status_code == 200, reset.text
    assert (await client.get("/api/mbti/current", headers=auth)).json() == {
        "code": "",
        "configured": False,
    }
    assert registry._harness_manager.get_agent(aid).config.system_prompt == before.system_prompt
    assert json.loads(registry.get_row(aid).config_json) == json.loads(before.config_json)
    assert {
        r.agent_id: (r.persona_mbti, r.system_prompt, r.config_json)
        for r in registry.list_rows()
        if r.agent_id != aid
    } == others


async def test_busy_style_change_cannot_interrupt_or_mutate_a_turn(env_with_provider: Any) -> None:
    client, server, auth, aid = await profile(env_with_provider)
    registry = server.app_runtime.agent_registry
    before = registry.get_row(aid)
    await registry._begin_invocation(aid)
    try:
        response = await client.post("/api/mbti/apply", headers=auth, json={"code": "INFJ"})
        assert response.status_code == 409, response.text
        assert registry.get_row(aid).config_json == before.config_json
        assert registry.get_row(aid).persona_mbti == before.persona_mbti
    finally:
        registry._end_invocation(aid)


async def test_new_turn_waits_for_style_reload_and_failed_reload_restores_config(
    env_with_provider: Any,
) -> None:
    client, server, auth, aid = await profile(env_with_provider)
    registry = server.app_runtime.agent_registry
    before = registry.get_row(aid)
    entered, finish = asyncio.Event(), asyncio.Event()
    real_reload = registry._reload_agent

    async def delayed_reload(agent_id: str) -> None:
        entered.set()
        await finish.wait()
        await real_reload(agent_id)

    with patch.object(registry, "_reload_agent", side_effect=delayed_reload):
        save = asyncio.create_task(
            client.post("/api/mbti/apply", headers=auth, json={"code": "INFJ"})
        )
        await entered.wait()
        turn = asyncio.create_task(registry._begin_invocation(aid))
        await asyncio.sleep(0)
        assert not turn.done()
        finish.set()
        assert (await save).status_code == 200
        await turn
        registry._end_invocation(aid)
    original = registry.get_row(aid)
    calls = 0

    async def failed_once(agent_id: str) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("synthetic reload failure")
        await real_reload(agent_id)

    with patch.object(registry, "_reload_agent", side_effect=failed_once):
        response = await client.post("/api/mbti/apply", headers=auth, json={"code": "ESTJ"})
    assert response.status_code == 500
    assert registry.get_row(aid).config_json == original.config_json
    assert registry.get_row(aid).persona_mbti == "INFJ"
    assert (
        get_profile("INFJ").behavior.answer_style_zh
        in registry._harness_manager.get_agent(aid).config.system_prompt
    )
    assert not registry._history_backfills
    assert registry.get_row(aid).system_prompt == before.system_prompt


async def test_mbti_routes_preserve_application_and_owner_boundaries(
    env_with_provider: Any,
) -> None:
    client, server, auth, aid = await profile(env_with_provider)
    wanx_auth = env_with_provider[2]
    wanx = await create_agent(client, wanx_auth)
    assert (
        await client.post(
            "/api/mbti/apply", headers={**auth, "X-Octop-Agent-Id": wanx}, json={"code": "INFJ"}
        )
    ).status_code == 404
    assert (
        await client.get("/api/mbti/current", headers={**wanx_auth, "X-Octop-Agent-Id": aid})
    ).status_code == 404
    assert (
        await client.post("/api/mbti/apply", headers=auth, json={"code": "INVALID"})
    ).status_code == 404
    assert (
        await client.get(
            "/api/mbti/current", headers={k: v for k, v in auth.items() if k != "X-Octop-Agent-Id"}
        )
    ).status_code == 422
    assert (await client.get("/api/mbti/preview/INFJ", headers=auth)).status_code == 404
    assert (await client.get("/api/mbti/test/questions", headers=auth)).status_code == 200
    registry = server.app_runtime.agent_registry
    other_owner = replace(registry.get_row(aid), user_id=2)
    with patch.object(registry, "get_row", return_value=other_owner):
        assert (
            await client.post("/api/mbti/apply", headers=auth, json={"code": "INFJ"})
        ).status_code == 403
