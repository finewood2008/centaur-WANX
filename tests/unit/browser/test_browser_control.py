import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langgraph.prebuilt.tool_node import ToolCallRequest

from octop.api.routers.browser.stream import _handle_client_event
from octop.infra.agents.middleware import browser_profile
from octop.infra.browser import control


@pytest.fixture(autouse=True)
def clear_controls():
    control._controls.clear()
    yield
    control._controls.clear()


def request():
    return ToolCallRequest(
        tool_call={"name": "browser_use", "args": {}, "id": "one"},
        tool=None,
        state={},
        runtime=None,
    )


@pytest.mark.asyncio
async def test_manual_control_blocks_tools_and_other_threads(monkeypatch):
    monkeypatch.setattr(
        browser_profile, "get_config", lambda: {"configurable": {"user": "1", "thread_id": "a"}}
    )
    c = control.block_agent("user-1")
    handler = AsyncMock()
    middleware = browser_profile.BrowserProfileMiddleware()
    assert (await middleware.awrap_tool_call(request(), handler)).status == "error"
    c.owner = "agent"
    c.thread_id = "b"
    assert (await middleware.awrap_tool_call(request(), handler)).status == "error"
    handler.assert_not_called()
    c.thread_id = "a"
    await middleware.awrap_tool_call(request(), handler)
    handler.assert_awaited_once()


@pytest.mark.asyncio
async def test_takeover_drains_inflight_and_blocks_queued_tool(monkeypatch):
    monkeypatch.setattr(
        browser_profile, "get_config", lambda: {"configurable": {"user": "1", "thread_id": "a"}}
    )
    c = control.control_for("user-1")
    c.managed, c.thread_id = True, "a"
    started, finish = asyncio.Event(), asyncio.Event()

    async def handler(_):
        started.set()
        await finish.wait()
        return "finished"

    middleware = browser_profile.BrowserProfileMiddleware()
    active = asyncio.create_task(middleware.awrap_tool_call(request(), handler))
    await started.wait()
    queued_handler = AsyncMock()
    queued = asyncio.create_task(middleware.awrap_tool_call(request(), queued_handler))
    control.block_agent("user-1")
    active.cancel()
    drained = asyncio.create_task(control.drain(c))
    await asyncio.sleep(0)
    assert not drained.done()
    finish.set()
    with pytest.raises(asyncio.CancelledError):
        await active
    assert await drained
    assert (await queued).status == "error"
    queued_handler.assert_not_called()


@pytest.mark.asyncio
async def test_profiles_do_not_block_other_users():
    a = control.block_agent("user-1")
    assert control.owner_for("user-2") == "agent"
    async with a.lock:
        assert await control.drain(control.control_for("user-2"))


@pytest.mark.asyncio
async def test_keyboard_text_and_edit_keys_use_cdp():
    send = AsyncMock()
    session = SimpleNamespace(_internal=SimpleNamespace(client=SimpleNamespace(send=send)))
    await _handle_client_event(session, {"type": "type", "text": "中文 hello"})
    send.assert_awaited_with("Input.insertText", {"text": "中文 hello"})
    for key, code, vk in [
        ("Backspace", "Backspace", 8),
        ("Tab", "Tab", 9),
        ("ArrowLeft", "ArrowLeft", 37),
        ("a", "KeyA", 65),
    ]:
        await _handle_client_event(
            session, {"type": "keydown", "key": key, "code": code, "modifiers": 2}
        )
        assert send.await_args.args[1]["windowsVirtualKeyCode"] == vk
        assert send.await_args.args[1]["modifiers"] == 2
    await _handle_client_event(session, {"type": "keyup", "key": "Enter"})
    assert send.await_args.args[1]["type"] == "keyUp"


@pytest.mark.asyncio
async def test_new_tab_does_not_reuse_an_existing_blank_tab():
    session = SimpleNamespace(new_tab=AsyncMock())
    await _handle_client_event(session, {"type": "tab_new"})
    session.new_tab.assert_awaited_once_with(force_new=True)
