"""Real SDK timers, capture, extraction and native API reads on disposable data."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from octop_harness.memory.runtime import MemoryRuntime
from octop_memory import MemoryService
from octop_memory.ports.llm import LLMClientError

from tests.integration.test_zhijun_profile import zhijun_auth

QUOTE = "我习惯在每天午饭后散步二十分钟。"


class ExtractModel:
    """Only the model output is synthetic; the SDK pipeline stays real."""

    def __init__(self, memory: Any, session_id: str) -> None:
        self.memory = memory
        self.session_id = session_id
        self.fail = False

    def call_llm(self, prompt: str, **kwargs: Any) -> str:
        if self.fail:
            raise LLMClientError("synthetic extraction model unavailable")
        event = next(
            event
            for event in self.memory.list_raw(session_id=self.session_id)
            if event.event_type == "user_message"
        )
        return json.dumps(
            {
                "candidates": [
                    {
                        "candidate_type": "Preference",
                        "title": "午饭后散步",
                        "assertion": QUOTE,
                        "verbatim_quote": QUOTE,
                        "quote_event_id": event.id,
                        "source_refs": [event.id],
                        "subject": {"name": "User", "entity_type": "User"},
                        "confidence": "medium",
                        "importance": "medium",
                        "recommended_action": "promote",
                        "promotion_reason": "synthetic direct owner quote of a stable preference",
                    }
                ]
            },
            ensure_ascii=False,
        )


async def wait_for_run(memory: Any) -> dict[str, Any]:
    async with asyncio.timeout(5):
        while not (run := memory.get_last_extract_run()):
            await asyncio.sleep(0.02)
    return run


async def extraction_runtime(env: Any, mode: str, enabled: bool = True) -> tuple[Any, ...]:
    client, server, _ = env
    auth = await zhijun_auth(client)
    aid = (await client.post("/api/zhijun/profile", headers=auth)).json()["profile"]["agent_id"]
    registry = server.app_runtime.agent_registry
    cfg = registry._build_harness_config(registry.get_row(aid))
    cfg.memory_aux_model_enabled = False
    cfg.memory_extract_on_session_end = enabled
    cfg.memory_extract_trigger_mode = mode
    # Accelerate only this disposable SDK timer; the public API's floors remain tested.
    cfg.memory_extract_idle_seconds = 0.2
    cfg.memory_extract_interval_seconds = 0.2
    runtime = MemoryRuntime(
        config=cfg,
        workspace_path=Path(cfg.workspace_dir),
        model_factory=SimpleNamespace(),
    )
    model = ExtractModel(runtime.memory, "extraction-test")
    runtime._service = MemoryService(
        runtime.memory, llm=model, config={"extraction": {"regen_pages": False}}
    )
    middleware = runtime.build_middleware()
    context = SimpleNamespace(
        config={
            "configurable": {
                "thread_id": "extraction-test",
                "session_id": "extraction-test",
                "user": "1",
            }
        }
    )
    user = HumanMessage(content=QUOTE)
    middleware.before_model({"messages": [user]}, context)
    middleware.after_model({"messages": [user, AIMessage(content="好，我听到了。")]}, context)
    return client, auth, aid, runtime, model


@pytest.mark.parametrize("mode", ["idle", "interval"])
async def test_automatic_extraction_keeps_source_and_native_review_state(
    env_with_provider: Any, mode: str
) -> None:
    client, auth, aid, runtime, _model = await extraction_runtime(env_with_provider, mode)
    try:
        run = await wait_for_run(runtime.memory)
        assert run["failure_reason"] is None and run["candidates"] == 1
        response = await client.post(
            f"/api/agents/{aid}/memory/candidates/list", headers=auth, json={}
        )
        assert response.status_code == 200, response.text
        candidates = response.json()["items"]
        assert len(candidates) == 1
        candidate = candidates[0]
        assert candidate["verbatim_quote"] == QUOTE
        assert candidate["status"] == "promoted"
        source = await client.get(
            f"/api/agents/{aid}/memory/raw_events/{candidate['quote_event_id']}", headers=auth
        )
        assert source.json()["content"] == QUOTE
        atoms = runtime.memory.list_atoms()
        assert len(atoms) == 1 and atoms[0].assertion == QUOTE
        counts = await client.get(f"/api/agents/{aid}/memory/stats/counts", headers=auth)
        assert counts.json()["last_extract_run"]["candidates"] == 1
        assert counts.json()["last_extract_run"]["failure_reason"] is None
    finally:
        runtime.close()


async def test_disabling_automatic_extraction_still_captures_sources(
    env_with_provider: Any,
) -> None:
    _client, _auth, _aid, runtime, _model = await extraction_runtime(
        env_with_provider, "idle", False
    )
    try:
        await asyncio.sleep(0.5)
        assert runtime.memory.list_raw(session_id="extraction-test")
        assert runtime.memory.get_last_extract_run() is None
        assert runtime.middleware._extract_idle_seconds == 0
        assert runtime.middleware._extract_interval_seconds == 0
    finally:
        runtime.close()


async def test_extraction_failure_is_recorded_without_losing_sources(
    env_with_provider: Any,
) -> None:
    _client, _auth, _aid, runtime, model = await extraction_runtime(env_with_provider, "idle")
    model.fail = True
    try:
        run = await wait_for_run(runtime.memory)
        assert "synthetic extraction model unavailable" in run["failure_reason"]
        assert runtime.memory.list_raw(session_id="extraction-test")
        assert not runtime.memory.list_candidates()
        assert not runtime.memory.list_atoms()
    finally:
        runtime.close()
