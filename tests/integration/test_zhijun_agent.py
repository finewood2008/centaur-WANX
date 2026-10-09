"""Zhijun reuses the native expert, workspace and memory surfaces."""

from typing import Any

import pytest


async def test_zhijun_template_is_available_via_native_catalog(env: Any) -> None:
    client, _server, auth = env
    response = await client.get("/api/experts/zhijun-personal-companion", headers=auth)
    assert response.status_code == 200
    template = response.json()
    files = {file["name"]: file["content"] for file in template["file_contents"]}
    assert set(files) >= {"AGENTS.md", "SOUL.md", "BOOTSTRAP.md"}
    assert "memory_search" in files["AGENTS.md"]
    assert "memory_get" in files["AGENTS.md"]
    schema = client._octop_app.openapi()
    assert "/api/zhijun/profile" in schema["paths"]


async def test_zhijun_rules_use_workspace_without_changing_config(env_with_agent: Any) -> None:
    client, _server, auth, aid = env_with_agent
    before = (await client.get(f"/api/agents/{aid}", headers=auth)).json()
    template = (await client.get("/api/experts/zhijun-personal-companion", headers=auth)).json()
    files = {file["name"]: file["content"] for file in template["file_contents"]}
    for name in ("AGENTS.md", "SOUL.md"):
        content = files[name]
        written = await client.put(
            f"/api/agents/{aid}/workspace/file",
            params={"path": name},
            headers=auth,
            json={"content": content},
        )
        assert written.status_code == 200, written.text
        read = await client.get(
            f"/api/agents/{aid}/workspace/file", params={"path": name}, headers=auth
        )
        assert read.json()["content"] == content
    reloaded = await client.post(f"/api/agents/{aid}/reload", headers=auth)
    assert reloaded.status_code == 204
    after = (await client.get(f"/api/agents/{aid}", headers=auth)).json()
    assert after["config"] == before["config"]
    assert after["default_model"] == before["default_model"]


async def test_zhijun_native_review_and_deprecation_survive_reload(
    env_with_main_agent: Any,
) -> None:
    """Exercise the native states used by both clients against disposable memory."""
    pytest.importorskip("octop_memory.adapters.bridge.handlers")
    from octop_memory.types import Candidate  # noqa: PLC0415

    from octop.api.common.memory_client import (  # noqa: PLC0415
        _open_memory_for_agent,
        invalidate_cached_memory,
    )
    from tests.integration.test_memory_api import _now, _seed_memory  # noqa: PLC0415

    client, server, auth, aid = env_with_main_agent
    _seed_memory(server, aid)
    memory, _bridge = _open_memory_for_agent(server, aid)
    for identifier in ("zhijun-accept", "zhijun-reject"):
        memory.add_candidate(
            Candidate(
                id=identifier,
                raw_event_ids=["raw-1"],
                candidate_type="Preference",
                status="needs_review",
                title="合成偏好",
                assertion="喜欢喝美式咖啡",
                verbatim_quote="我喜欢喝美式咖啡",
                quote_event_id="raw-1",
                subject_name="User",
                subject_entity_type="User",
                target_entity_id="ent-user",
                confidence="high",
                importance="medium",
                recommended_action="review",
                promotion_reason="synthetic fixture",
                extractor_version="zhijun-test",
                created_at=_now(),
            )
        )
    invalidate_cached_memory(aid)
    base = f"/api/agents/{aid}/memory"
    promoted = await client.post(f"{base}/candidates/zhijun-accept:promote", headers=auth)
    assert promoted.status_code == 200, promoted.text
    assert (await client.get(f"{base}/candidates/zhijun-accept", headers=auth)).json()[
        "status"
    ] == "promoted"
    rejected = await client.post(
        f"{base}/candidates/zhijun-reject:reject",
        headers=auth,
        json={"reason": "合成验收拒绝"},
    )
    assert rejected.status_code == 200, rejected.text
    deprecated = await client.post(
        f"{base}/atoms/atom-1:deprecate", headers=auth, json={"reason": "合成验收弃用"}
    )
    assert deprecated.status_code == 200, deprecated.text
    assert (await client.post(f"/api/agents/{aid}/reload", headers=auth)).status_code == 204
    invalidate_cached_memory(aid)
    for identifier, status in (("zhijun-accept", "promoted"), ("zhijun-reject", "rejected")):
        read = await client.get(f"{base}/candidates/{identifier}", headers=auth)
        assert read.json()["status"] == status
    active = (await client.post(f"{base}/atoms/list", headers=auth, json={})).json()["items"]
    assert "atom-1" not in {atom["id"] for atom in active}
    historical = (
        await client.post(f"{base}/atoms/list", headers=auth, json={"include_deprecated": True})
    ).json()["items"]
    assert "atom-1" in {atom["id"] for atom in historical}
    raw = await client.get(f"{base}/raw_events/raw-1", headers=auth)
    assert raw.status_code == 200, raw.text
    assert raw.json()["content"] == "我喜欢喝美式咖啡"
