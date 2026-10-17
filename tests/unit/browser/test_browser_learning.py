"""Learning isolation, lease ownership, recovery, and tool control."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from octop_browser.record.models import RecordingManifest, RecordingTarget
from octop_browser.record.settings import RecordReplaySettings
from octop_browser.record.store import RecordingStore
from pydantic import ValidationError

from octop.api.routers.browser.learning import StartBody
from octop.infra.agents.middleware import browser_profile
from octop.infra.browser import learning
from octop.infra.errors import OctopError

RID = "learn_" + "a" * 32


@pytest.fixture
def recording(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    store = RecordingStore(RecordReplaySettings(base_dir=tmp_path))
    manifest = RecordingManifest(
        recordingId=RID,
        createdAt="2026-10-16T00:00:00Z",
        profile="user-42",
        target=RecordingTarget(title="Test"),
    )
    store.create(manifest)
    recorder = SimpleNamespace(manifest=manifest, stop=AsyncMock(), close=AsyncMock())
    monkeypatch.setattr(learning, "_store", lambda: store)
    monkeypatch.setattr(learning, "_active", {})
    monkeypatch.setattr(learning, "_locks", {})
    monkeypatch.setattr(learning, "_attach", AsyncMock(return_value=recorder))
    return recorder


@pytest.mark.asyncio
async def test_one_recording_per_profile_and_client(recording):
    first = await learning.start("user-42", "client-a", "Test", None)
    try:
        assert (await learning.start("user-42", "client-a", "Test", None)) == first
        with pytest.raises(OctopError):
            await learning.start("user-42", "client-b", "Test", None)
        assert learning.status("user-43") == {"active": None}
        await learning.stop_if_client("user-42", "client-b")
        recording.stop.assert_not_awaited()
        assert learning.restrict_action("user-42", "new_tab")
        assert not learning.restrict_action("user-42", "fill")
    finally:
        await learning.stop_if_client("user-42", "client-a")
    recording.stop.assert_awaited_once()
    recording.close.assert_awaited_once()
    assert not learning.restrict_action("user-42", "new_tab")


@pytest.mark.asyncio
async def test_other_users_cannot_stop_or_read_recording(recording):
    await learning.start("user-42", "client", "Test", None)
    try:
        with pytest.raises(OctopError):
            await learning.stop("user-43", RID)
        with pytest.raises(OctopError):
            learning.draft("user-43", RID)
        with pytest.raises(OctopError):
            learning.draft("user-42", "../secret")
        recording.stop.assert_not_awaited()
    finally:
        await learning.stop_if_client("user-42", "client")


@pytest.mark.asyncio
async def test_expired_lease_closes_capture_but_retains_draft(recording, monkeypatch):
    monkeypatch.setattr(learning, "LEASE_SECONDS", 0.01)
    await learning.start("user-42", "client", "Test", None)
    await asyncio.sleep(0.05)
    assert learning.status("user-42")["active"] is None
    recording.close.assert_awaited_once()
    assert learning.draft("user-42", RID)["recordingId"] == RID


@pytest.mark.asyncio
async def test_foreign_client_cannot_renew_lease(recording):
    await learning.start("user-42", "client", "Test", None)
    try:
        before = learning._active["user-42"].expires_at
        learning.renew("user-42", "another", RID)
        assert learning._active["user-42"].expires_at == before
    finally:
        await learning.stop_if_client("user-42", "client")


@pytest.mark.asyncio
async def test_failed_stop_still_closes_and_releases_capture(recording):
    await learning.start("user-42", "client", "Test", None)
    recording.stop.side_effect = RuntimeError("gone")
    with pytest.raises(RuntimeError):
        await learning.stop_if_client("user-42", "client")
    recording.close.assert_awaited_once()
    assert learning.status("user-42")["active"] is None


def test_recover_draft_after_backend_restart(recording):
    result = learning.draft("user-42", RID)
    assert result["recordingId"] == RID
    assert learning._store().read_manifest(RID).status == "stopped"


def test_blank_learning_name_is_rejected():
    with pytest.raises(ValidationError):
        StartBody(client_id="c", name="  ")


@pytest.mark.asyncio
async def test_ai_cannot_leave_learning_tab(recording, monkeypatch):
    from langgraph.prebuilt.tool_node import ToolCallRequest

    from octop.infra.browser.control import control_for

    monkeypatch.setattr(
        browser_profile,
        "get_config",
        lambda: {"configurable": {"user": "42", "thread_id": "learn"}},
    )
    control = control_for("user-42")
    old = (control.managed, control.owner, control.thread_id)
    control.managed, control.owner, control.thread_id = True, "agent", "learn"
    await learning.start("user-42", "client", "Test", None)
    try:
        handler = AsyncMock()
        req = ToolCallRequest(
            tool_call={"name": "browser_use", "id": "call", "args": {"action": "new_tab"}},
            tool=None,
            state={},
            runtime=None,
        )
        result = await browser_profile.BrowserProfileMiddleware().awrap_tool_call(req, handler)
        assert result.status == "error"
        handler.assert_not_awaited()
    finally:
        await learning.stop_if_client("user-42", "client")
        control.managed, control.owner, control.thread_id = old


def test_final_field_values_ignore_hidden_mirrors_and_keep_action_boundaries():
    def event(value, *, target="editor", kind="input", visible=True):
        return {
            "kind": kind,
            "targetId": "tab",
            "page": {"url": "https://example.test"},
            "target": {"id": target, "visible": visible},
            "value": value,
        }

    click = {"kind": "click", "target": {"id": "save"}}
    result = learning._final_field_events(
        [
            event("draft"),
            event("hidden mirror", target="mirror", visible=False),
            event("first paragraph\nsecond paragraph"),
            click,
            event("later edit"),
        ]
    )
    assert [e.get("value") for e in result] == [
        "first paragraph\nsecond paragraph",
        None,
        "later edit",
    ]
    assert result[1] == click


def test_field_identity_is_scoped_to_page_and_tab():
    events = [
        {
            "kind": "input",
            "targetId": tab,
            "page": {"url": url},
            "target": {"id": "query"},
            "value": value,
        }
        for tab, url, value in [
            ("a", "one", "first"),
            ("b", "one", "second"),
            ("a", "two", "third"),
        ]
    ]
    assert learning._final_field_events(events) == events


def test_scrolling_during_edit_does_not_create_an_intermediate_parameter():
    first = {"kind": "input", "target": {"id": "body"}, "value": "draft"}
    scroll = {"kind": "scroll", "scroll": {"y": 300}}
    final = {**first, "value": "complete paragraphs"}
    click = {"kind": "click", "target": {"id": "save"}}
    assert learning._final_field_events([first, scroll, final, click]) == [scroll, final, click]
