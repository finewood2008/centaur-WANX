from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from octop.infra.agents.response_options import (
    ResponseOption,
    ResponseOptionsInput,
    build_response_options_tools,
    response_options_payload,
)
from octop.infra.errors import OctopError


def invitation() -> dict[str, object]:
    return {
        "question": "你愿意从哪里聊起？",
        "options": [
            {"label": "聊眼下", "draft": "我想先聊眼下在意的事。"},
            {"label": "暂不展开", "draft": "我暂时不想展开。"},
        ],
    }


def test_payload_is_an_expression_invitation_without_fact_or_memory_fields() -> None:
    request = ResponseOptionsInput.model_validate(invitation())
    payload = response_options_payload(request.question, request.options)
    assert payload == {"ok": True, "version": 1, "kind": "expression_invitation", **invitation()}
    assert ResponseOption(label="  暂不展开  ", draft=" 稍后再聊。 ").label == "暂不展开"


@pytest.mark.parametrize(
    "draft",
    ["准确，就是这样。", "大方向对，但有一处我想补一下。", "先别急着记下来，我还想再想想。"],
)
def test_tool_schema_rejects_content_free_confirmation_drafts(draft: str) -> None:
    with pytest.raises(ValidationError):
        ResponseOption(label="建议", draft=draft)


@pytest.mark.parametrize(
    "changes",
    [
        {"question": "你怎么想？后来发生了什么？"},
        {"question": " "},
        {"options": []},
        {"options": [{"label": "a", "draft": "one"}]},
        {"options": [{"label": str(i), "draft": str(i)} for i in range(5)]},
        {"options": [{"label": "a", "draft": "one"}, {"label": "a", "draft": "two"}]},
        {"options": [{"label": "a", "draft": "one"}, {"label": "b", "draft": "one"}]},
        {"options": [{"label": "a", "draft": "one"}, {"label": "b", "draft": "x" * 501}]},
        {"memory_confirmed": True},
    ],
)
def test_invalid_or_confirmation_shaped_invitation_is_rejected(changes: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        ResponseOptionsInput.model_validate({**invitation(), **changes})


@pytest.mark.asyncio
async def test_tool_returns_typed_invitation_in_the_bound_owned_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {"configurable": {"agent_id": "owned", "user": "7", "source": "web"}},
    )
    tool = build_response_options_tools(agent_id="owned", user_id=7)[0]
    result = json.loads(await tool.ainvoke(invitation()))
    assert result["kind"] == "expression_invitation"
    assert len(result["options"]) == 2
    assert tool.name == "zhijun_response_options"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "config",
    [
        {},
        {"agent_id": "other", "user": "7"},
        {"agent_id": "owned", "user": "8"},
        *(
            {"agent_id": "owned", "user": "7", "source": source}
            for source in ["peer", "ask_agent", "inbox"]
        ),
    ],
)
async def test_tool_cannot_run_across_accounts_or_from_peer_sources(
    monkeypatch: pytest.MonkeyPatch, config: dict[str, str]
) -> None:
    monkeypatch.setattr("langgraph.config.get_config", lambda: {"configurable": config})
    tool = build_response_options_tools(agent_id="owned", user_id=7)[0]
    with pytest.raises(OctopError):
        await tool.ainvoke(invitation())
