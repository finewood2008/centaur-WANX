"""Independent archive creation and native memory without importing WANX data."""

import asyncio
from typing import Any

from tests.support.auth import TEST_PASSWORD


async def zhijun_auth(client: Any) -> dict[str, str]:
    response = await client.post(
        "/api/auth/login",
        json={"username": "admin", "password": TEST_PASSWORD, "application_id": "zhijun"},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


async def test_profile_extraction_settings_save_without_changing_storage(
    env_with_provider: Any,
) -> None:
    import json

    client, server, wanx_auth = env_with_provider
    auth = await zhijun_auth(client)
    aid = (await client.post("/api/zhijun/profile", headers=auth)).json()["profile"]["agent_id"]
    registry = server.app_runtime.agent_registry
    before = json.loads(registry.get_row(aid).config_json)
    other = {row.agent_id: row.config_json for row in registry.list_rows() if row.agent_id != aid}
    path = f"/api/agents/{aid}/memory/extract-config"
    submitted = {
        "memory_enabled": True,
        "extract_on_session_end": True,
        "extract_trigger_mode": "idle",
        "extract_idle_seconds": 60,
        "extract_interval_seconds": 300,
        "aux_model": "",
    }
    saved = await client.put(path, headers=auth, json=submitted)
    assert saved.status_code == 200, saved.text
    actual = (await client.get(path, headers=auth)).json()
    assert actual == {**submitted, "aux_model": None}
    after = json.loads(registry.get_row(aid).config_json)
    assert {key: value for key, value in after.items() if key != "memory"} == {
        key: value for key, value in before.items() if key != "memory"
    }
    assert {
        row.agent_id: row.config_json for row in registry.list_rows() if row.agent_id != aid
    } == other
    assert (await client.put(path, headers=wanx_auth, json=submitted)).status_code == 404
    protected = {
        **after,
        "memory": {**after["memory"], "backend": {"type": "sqlite", "db_path": "other"}},
    }
    from octop.infra.errors import ErrorCode, OctopError

    try:
        await registry.update_memory_extract_config(aid, {"backend": {"type": "sqlite"}})
    except OctopError as error:
        assert error.code == ErrorCode.FORBIDDEN
    else:
        raise AssertionError("the extraction update must reject storage controls")
    assert json.loads(registry.get_row(aid).config_json) == after

    try:
        await registry.update(aid, config_json=json.dumps(protected))
    except OctopError as error:
        assert error.code == ErrorCode.FORBIDDEN
    else:
        raise AssertionError("generic updates must still reject memory storage changes")


async def test_create_blank_profile_is_explicit_and_recovers_identity(
    env_with_provider: Any,
) -> None:
    client, server, wanx_auth = env_with_provider
    auth = await zhijun_auth(client)
    before = server.app_runtime.agent_registry.list_rows()
    response = await client.get("/api/zhijun/profile", headers=auth)
    assert response.json() == {"profile": None}
    assert server.app_runtime.agent_registry.list_rows() == before
    assert (await client.get("/api/zhijun/profile", headers=wanx_auth)).status_code == 404

    responses = await asyncio.gather(
        *[client.post("/api/zhijun/profile", headers=auth, json={}) for _ in range(4)]
    )
    assert all(response.status_code == 200 for response in responses)
    profiles = [response.json()["profile"] for response in responses]
    aid = profiles[0]["agent_id"]
    assert {profile["agent_id"] for profile in profiles} == {aid}
    assert profiles[0]["application_id"] == "zhijun"
    assert profiles[0]["user_id"] == 1
    assert profiles[0]["knowledge_base_ids"] == []
    assert profiles[0]["mcp_servers"] == []
    assert profiles[0]["skill_package_ids"] == []
    assert not profiles[0]["is_shared"]
    auth = await zhijun_auth(client)
    assert (await client.get("/api/zhijun/profile", headers=auth)).json()["profile"][
        "agent_id"
    ] == aid
    assert (await client.post("/api/zhijun/profile", headers=auth)).json()["profile"][
        "agent_id"
    ] == aid
    assert (await client.get(f"/api/agents/{aid}/threads", headers=auth)).json() == []

    for body in ({"agent_id": before[0].agent_id}, {"workspace_dir": "/existing"}):
        assert (
            await client.post("/api/zhijun/profile", headers=auth, json=body)
        ).status_code == 422
    assert (await client.get(f"/api/agents/{aid}", headers=wanx_auth)).status_code == 404
    assert aid not in {
        item["agent_id"] for item in (await client.get("/api/agents", headers=wanx_auth)).json()
    }


async def test_profile_start_failure_retains_same_archive(env: Any) -> None:
    client, server, _wanx_auth = env
    auth = await zhijun_auth(client)
    first = (await client.post("/api/zhijun/profile", headers=auth)).json()["profile"]
    assert first["state"] == "failed"
    assert first["last_error"]
    second = (await client.post("/api/zhijun/profile", headers=auth)).json()["profile"]
    assert second["agent_id"] == first["agent_id"]
    assert (
        len(
            [
                row
                for row in server.app_runtime.agent_registry.list_rows()
                if row.application_id == "zhijun"
            ]
        )
        == 1
    )


async def test_native_memory_mutations_stay_in_profile(env_with_provider: Any) -> None:
    from octop.api.common.memory_client import _open_memory_for_agent, invalidate_cached_memory
    from tests.integration.test_memory_api import _seed_memory

    client, server, wanx_auth = env_with_provider
    auth = await zhijun_auth(client)
    aid = (await client.post("/api/zhijun/profile", headers=auth)).json()["profile"]["agent_id"]
    # The empty native memory is available even before the first conversation.
    memory, _bridge = _open_memory_for_agent(server, aid)
    assert memory.list_atoms() == []
    _seed_memory(server, aid)
    invalidate_cached_memory(aid)
    base = f"/api/agents/{aid}/memory"
    assert (await client.post(f"{base}/atoms/list", headers=wanx_auth, json={})).status_code == 404
    response = await client.post(
        f"{base}/atoms/atom-1:replace",
        headers=auth,
        json={"assertion": "我在合成测试中喜欢茶", "reason": "合成核对"},
    )
    assert response.status_code == 200, response.text
    replacement = response.json()["atom"]
    assert replacement["assertion"] == "我在合成测试中喜欢茶"
    readback = await client.get(f"{base}/atoms/{replacement['id']}", headers=auth)
    assert readback.json()["assertion"] == replacement["assertion"]
    assert (await client.get(f"{base}/raw_events/raw-1", headers=auth)).json()["content"] == (
        "我喜欢喝美式咖啡"
    )
    assert (await client.get(f"{base}/raw_events/raw-1", headers=wanx_auth)).status_code == 404


async def test_archive_routes_keep_scope_and_restore_original_memory(
    env_with_provider: Any,
) -> None:
    from types import SimpleNamespace

    from octop.api.common.memory_client import _open_memory_for_agent

    client, server, wanx_auth = env_with_provider
    auth = await zhijun_auth(client)
    aid = (await client.post("/api/zhijun/profile", headers=auth)).json()["profile"]["agent_id"]
    memory, _bridge = _open_memory_for_agent(server, aid)
    atom, _entity, _candidate = memory.create_atom(
        "synthetic connection regression memory", entity_name="test topic"
    )
    harness = server.app_runtime.agent_registry.get_agent(aid)
    harness._memory_runtime = SimpleNamespace(
        memory=memory,
        service=SimpleNamespace(
            _runtime=SimpleNamespace(_memory=memory, extract=lambda params: {})
        ),
    )
    assert (await client.get("/api/zhijun/maintenance", headers=auth)).json() == {"items": []}
    assert (await client.get("/api/zhijun/maintenance", headers=wanx_auth)).status_code == 404
    preview = await client.post(
        "/api/zhijun/maintenance:preview", headers=auth, json={"kind": "atom", "id": atom.id}
    )
    assert preview.status_code == 200, preview.text
    archived = await client.post(
        "/api/zhijun/maintenance",
        headers=auth,
        json={
            "kind": "atom",
            "id": atom.id,
            "version": preview.json()["version"],
            "action": "archive",
        },
    )
    assert archived.status_code == 200, archived.text
    assert memory.get_atom(atom.id) is None
    readback = await client.get("/api/zhijun/maintenance", headers=auth)
    record = readback.json()["items"][0]
    assert record["status"] == "archived"
    restored = await client.post(
        "/api/zhijun/maintenance:archive",
        headers=auth,
        json={
            "archive_id": record["archive_id"],
            "version": record["version"],
            "action": "restore",
        },
    )
    assert restored.status_code == 200, restored.text
    assert memory.get_atom(atom.id).id == atom.id
    assert (await client.get("/api/zhijun/maintenance", headers=auth)).json()["items"][0][
        "status"
    ] == "restored"
