"""Peer turn.start should keep dashboard composer fields."""

from __future__ import annotations

import pytest

from octop.api.bridge_peer import prepare_peer_dashboard_turn
from octop.api.routers.chat.models import UserTurnWsFrame
from octop.infra.bridge.manager import _bridge_turn_ws_payload
from octop.infra.bridge.peer_turn import USER_TURN_WS_KEYS, PeerTurnRejected


def test_bridge_turn_ws_payload_keeps_composer_fields() -> None:
    out = _bridge_turn_ws_payload(
        {
            "type": "turn.start",
            "request_id": "r1",
            "agent_id": "main",
            "text": "hi",
            "thread_id": "thr_1",
            "knowledge_base_ids": ["kb1"],
            "hitl_policy": {"mode": "allow_all"},
            "conversation_mode": "ask",
            "reasoning_mode": "enabled",
            "target_agent_ids": ["doctor"],
            "mcp_servers": ["gmail"],
            "skills": ["notes"],
        }
    )
    assert out["type"] == "user_turn"
    assert out["text"] == "hi"
    assert out["thread_id"] == "thr_1"
    assert out["knowledge_base_ids"] == ["kb1"]
    assert out["hitl_policy"] == {"mode": "allow_all"}
    assert out["conversation_mode"] == "ask"
    assert out["reasoning_mode"] == "enabled"
    assert out["target_agent_ids"] == ["doctor"]
    assert out["mcp_servers"] == ["gmail"]
    assert out["skills"] == ["notes"]
    assert "request_id" not in out
    assert "agent_id" not in out


def test_bridge_turn_ws_payload_defaults_empty_text() -> None:
    out = _bridge_turn_ws_payload({"messages": [{"role": "user", "content": "x"}]})
    assert out["type"] == "user_turn"
    assert out["text"] == ""
    assert out["messages"][0]["content"] == "x"


def test_user_turn_ws_keys_match_dashboard_frame() -> None:
    frame_keys = set(UserTurnWsFrame.model_fields) - {"type"}
    assert frame_keys == USER_TURN_WS_KEYS


@pytest.mark.asyncio
async def test_empty_peer_turn_is_rejected() -> None:
    with pytest.raises(PeerTurnRejected, match="empty message"):
        await prepare_peer_dashboard_turn(
            server=object(),
            user=object(),
            agent_id="a1",
            payload={},
            ws_connection_id="ws",
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("cleanup", ["disconnect", "_unregister_session", "replace"])
async def test_running_peer_turn_keeps_receiver_available_and_is_cancelled(monkeypatch, cleanup):
    import asyncio
    from unittest.mock import AsyncMock, MagicMock

    from octop.infra.bridge.manager import BridgeManager

    repo = MagicMock()
    repo.get.return_value = None
    manager = BridgeManager(
        bridge_repo=repo,
        secret_repo=MagicMock(),
        user_repo=MagicMock(),
        advertise_base_url="http://localhost",
    )
    session = MagicMock()
    session.close = AsyncMock()
    await manager._register_session("peer", session)
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def run_turn(*args):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(manager, "_execute_peer_turn", run_turn)
    try:
        await asyncio.wait_for(
            manager._handle_inbound_turn("peer", {"type": "turn.start", "request_id": "incoming"}),
            timeout=1,
        )
        await asyncio.wait_for(started.wait(), timeout=1)
        queue = await manager.open_turn_waiter("outgoing")
        reply = {"type": "turn.chunk", "request_id": "outgoing", "frame": {"text": "reply"}}
        await manager._handle_inbound_turn("peer", reply)
        assert queue.get_nowait() == reply
        assert not cancelled.is_set()
        if cleanup == "replace":
            await manager._register_session("peer", MagicMock())
        else:
            await getattr(manager, cleanup)("peer")
        assert cancelled.is_set()
        assert not manager._peer_turn_tasks
        session.close.assert_awaited_once()
    finally:
        await manager._cancel_peer_turns("peer")
