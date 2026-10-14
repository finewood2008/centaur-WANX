"""Thread DELETE must not leave captured conversations in the memory browser."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from octop_memory import Memory

from octop.infra.agents import thread_memory_cleanup as cleanup


@pytest.fixture
def memory_runtime(tmp_path):
    memory = Memory("private", backend_config={"db_path": str(tmp_path / "memory.sqlite")})
    runtime = SimpleNamespace(_memory=memory, _recall_cache=Mock(), extract=lambda p: {})
    harness = SimpleNamespace(
        workspace=SimpleNamespace(
            aread_text=AsyncMock(return_value=None), aupload_bytes=AsyncMock()
        ),
        _memory_runtime=SimpleNamespace(memory=memory, service=SimpleNamespace(_runtime=runtime)),
    )
    yield memory, harness
    memory.backend.close()


@pytest.mark.parametrize("failure", [False, True])
async def test_delete_only_removes_metadata_after_memory_cleanup(
    env_alice_bob_agent, memory_runtime, monkeypatch, failure
):
    client, server, alice, bob, agent_id = env_alice_bob_agent
    registry = server.app_runtime.agent_registry
    response = await client.post(f"/api/agents/{agent_id}/threads", headers=alice)
    thread_id = response.json()["thread_id"]
    memory, harness = memory_runtime
    raw = memory.add_raw("private original", event_type="user_message", thread_id=thread_id)
    other = memory.add_raw("unrelated", event_type="user_message", thread_id="other")
    monkeypatch.setattr(registry, "get_agent", lambda aid: harness)
    checkpoint = AsyncMock(return_value=True)
    monkeypatch.setattr(registry, "delete_thread_checkpoint", checkpoint)
    url = f"/api/agents/{agent_id}/threads/{thread_id}"
    denied = await client.delete(url, headers=bob)
    assert denied.status_code in {403, 404}
    assert memory.get_raw(raw.id) is not None
    if failure:

        def fail(*args):
            raise RuntimeError("synthetic vector deletion failure")

        monkeypatch.setattr(cleanup, "_purge_vectors", fail)
    if failure:
        with pytest.raises(RuntimeError, match="synthetic vector deletion failure"):
            await client.delete(url, headers=alice)
    else:
        response = await client.delete(url, headers=alice)
        assert response.status_code == 204, response.text
    assert (memory.get_raw(raw.id) is not None) == failure
    assert memory.get_raw(other.id) is not None
    assert (server.app_runtime.gateway.thread_registry.get_thread(thread_id) is not None) == failure
    if failure:
        checkpoint.assert_not_awaited()
    else:
        checkpoint.assert_awaited_once_with(agent_id, thread_id)
