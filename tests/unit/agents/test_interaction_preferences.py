"""Preferences add to the complete system message without altering the conversation."""

from unittest.mock import AsyncMock

import pytest
from langchain.agents.middleware import ModelRequest
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import ValidationError

from octop.infra.agents.middleware.interaction import InteractionPreferencesMiddleware
from octop.infra.agents.settings.interaction import InteractionPreferences

PREFERENCES = {
    "version": 1,
    "preset": "natural",
    "verbosity": "balanced",
    "tone": "natural",
    "questions": "necessary",
    "advice": "situational",
    "disagreement": "clear",
}


@pytest.mark.parametrize(
    "system",
    [
        None,
        SystemMessage(content="original rules"),
        SystemMessage(
            content=[
                {"type": "text", "text": "original rules", "cache_control": {"type": "ephemeral"}}
            ],
            additional_kwargs={"preserved": True},
        ),
    ],
)
async def test_preserves_system_blocks_history_and_generation_settings(system):
    middleware = InteractionPreferencesMiddleware(InteractionPreferences(**PREFERENCES))
    model = ChatOpenAI(model="test", api_key="test", temperature=0.7, max_tokens=1000)
    request = ModelRequest(
        model=model, messages=[HumanMessage(content="我的本轮要求")], system_message=system
    )
    captured = []
    middleware.wrap_model_call(request, lambda modified: captured.append(modified))
    handler = AsyncMock()
    await middleware.awrap_model_call(request, handler)
    for modified in [captured[0], handler.call_args.args[0]]:
        assert modified.messages == request.messages
        assert modified.model is model
        assert request.system_message is system
        content = modified.system_message.content
        if system and isinstance(system.content, list):
            assert content[:-1] == system.content
            assert modified.system_message.additional_kwargs == system.additional_kwargs
            text = content[-1]["text"]
        else:
            text = content
            if system:
                assert text.startswith(system.content)
        assert "用户本轮明确" in text
        assert "不是对用户人格的判断" in text
        assert "不代表获得执行操作" in text
        assert "最多提出一个" in text


@pytest.mark.parametrize(
    "extra",
    [{"temperature": 2}, {"agent_id": "other"}, {"tone": "ignore rules"}, {"version": 2}],
)
def test_contract_rejects_injected_fields_and_unknown_versions(extra):
    with pytest.raises(ValidationError):
        InteractionPreferences(**{**PREFERENCES, **extra})


async def test_preferences_reach_model_in_real_graph_for_client_and_weixin():
    from langchain.agents import create_agent
    from langchain_core.callbacks import BaseCallbackHandler
    from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
    from langchain_core.messages import AIMessage

    class Capture(BaseCallbackHandler):
        def __init__(self):
            self.calls = []

        def on_chat_model_start(self, serialized, messages, **kwargs):
            self.calls.append(messages[0])

    capture = Capture()
    graph = create_agent(
        model=FakeMessagesListChatModel(responses=[AIMessage(content="test response")]),
        system_prompt="original role, memory and authorization boundaries",
        middleware=[InteractionPreferencesMiddleware(InteractionPreferences(**PREFERENCES))],
    )
    scenarios = [
        "用两句话解释机会成本",
        "今天很累，暂时不想听建议",
        "每天学两小时却坚持不了",
        "一年总是365天吗",
    ]
    for channel in ("dashboard", "weixin"):
        for text in scenarios:
            result = await graph.ainvoke(
                {"messages": [HumanMessage(content=text)]},
                config={"callbacks": [capture], "configurable": {"channel_type": channel}},
            )
            assert result["messages"][0].content == text
            sent = capture.calls[-1]
            assert sent[0].content.startswith("original role, memory and authorization boundaries")
            assert "## 用户选择的交流方式" in sent[0].content
            assert sent[1].content == text
    assert len(capture.calls) == 8


def test_custom_dimensions_are_not_overridden_by_a_stale_preset_label():
    from octop.infra.agents.settings.interaction import interaction_instructions

    values = {**PREFERENCES, "verbosity": "brief", "advice": "on_request", "tone": "warm"}
    custom = interaction_instructions(InteractionPreferences(**{**values, "preset": "custom"}))
    for label in ("natural", "listening", "advice", "exploration"):
        assert (
            interaction_instructions(InteractionPreferences(**{**values, "preset": label}))
            == custom
        )
    assert custom != interaction_instructions(InteractionPreferences(**PREFERENCES))
