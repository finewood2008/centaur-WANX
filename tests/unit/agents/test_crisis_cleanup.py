"""Preview never exposes crisis text or mutates owned/other namespaces."""

import json
from types import SimpleNamespace

from octop_memory import Memory
from octop_memory.service import MemoryService

from octop.infra.agents.crisis_cleanup import preview_crisis_cleanup


async def test_preview_is_owned_content_free_and_read_only(tmp_path):
    memory = Memory("synthetic", backend_config={"db_path": str(tmp_path / "memory.sqlite")})
    try:
        service = MemoryService(memory)
        secret = "我现在想伤害自己，这件事包含私人姓名王小明。"
        service.capture_turn(user=secret, session_id="s", user_id="7")
        service.capture_turn(user=secret, session_id="other", user_id="8")
        service.capture_turn(user="忙得撑不下去了，正在赶死线。", session_id="work", user_id="7")
        row = SimpleNamespace(agent_id="own", user_id=7, application_id="zhijun")
        registry = SimpleNamespace(
            get_application_profile=lambda uid, app: row,
            get_agent=lambda aid: SimpleNamespace(
                workspace=None, _memory_runtime=SimpleNamespace(memory=memory)
            ),
        )
        report = await preview_crisis_cleanup(registry, 7)
        assert report["counts"]["raw_events"] == 1
        assert report["purge_ready"] is False
        assert secret not in json.dumps(report, ensure_ascii=False)
        assert "王小明" not in json.dumps(report, ensure_ascii=False)
        assert len(memory.list_raw(session_id="s")) == 1
        assert len(memory.list_raw(session_id="other")) == 1
        assert len(memory.list_raw(session_id="work")) == 1
    finally:
        memory.backend.close()
