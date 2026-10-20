"""Tests for BinaryReadGuardMiddleware."""

from __future__ import annotations

from octop.infra.agents.middleware.binary_read_guard import read_file_block_reason


def test_blocks_inbound_pdf() -> None:
    reason = read_file_block_reason("inbound/01KWB9MG2Z570P7QB367KDJ75R.pdf")
    assert reason is not None
    assert "pdf" in reason.lower()
    assert "execute_shell_command" in reason


def test_allows_inbound_txt() -> None:
    assert read_file_block_reason("inbound/01JTEST.txt") is None


def test_blocks_pdf_anywhere() -> None:
    assert read_file_block_reason("docs/report.pdf") is not None


def test_video_is_blocked_outside_inbound_and_in_subagents() -> None:
    from octop.infra.agents.middleware.binary_read_guard import BinaryReadGuardMiddleware

    assert BinaryReadGuardMiddleware.inherit_to_subagents is True
    for path in (
        "inbound/clip.mp4",
        "/.octop/workspaces/media-publisher/inbound/clip.mp4",
        "frames/CLIP.MOV",
    ):
        reason = read_file_block_reason(path)
        assert reason is not None
        assert "publisher_sample_video" in reason
        assert "base64" in reason


def test_old_serialized_video_is_recovered_before_summarization() -> None:
    import json

    from langchain_core.messages import ToolMessage

    from octop.infra.agents.middleware.binary_read_guard import BinaryReadGuardMiddleware

    original = ToolMessage(
        id="video-result",
        tool_call_id="read-video",
        content=json.dumps(
            [{"type": "video", "base64": "A" * 1_000_000, "mime_type": "video/mp4"}]
        ),
    )
    updated = BinaryReadGuardMiddleware().before_model({"messages": [original]}, None)
    assert updated is not None
    recovered = updated["messages"][0]
    assert recovered.id == original.id
    assert recovered.tool_call_id == original.tool_call_id
    assert len(str(recovered.content)) < 500
    assert "original workspace file is unchanged" in str(recovered.content)
    assert len(original.content) > 1_000_000
    assert BinaryReadGuardMiddleware().before_model({"messages": [recovered]}, None) is None
