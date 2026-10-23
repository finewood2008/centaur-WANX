"""Unchecked interview prose never reaches streaming, history, or tool execution."""

import json
from unittest.mock import AsyncMock

import pytest
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage
from octop_harness.protocols.langgraph import LangGraphProtocol

from octop.infra.agents.zhijun_interview_grounding import grounded_reply
from octop.infra.errors import OctopError


class Grounding(AgentMiddleware):
    async def awrap_model_call(self, request, handler):
        return await grounded_reply(request, handler)


class Model(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


async def test_stream_emits_only_reviewed_answer_and_preserves_both_calls_usage():
    draft = "你临时被推上台，没有准备。"
    final = "那次汇报时你很紧张。你愿意多说说吗？"
    responses = [
        AIMessage(
            content=draft,
            usage_metadata={"input_tokens": 10, "output_tokens": 3, "total_tokens": 13},
        ),
        AIMessage(
            content=json.dumps({"reply": final}),
            usage_metadata={"input_tokens": 20, "output_tokens": 7, "total_tokens": 27},
        ),
    ]

    class Capture(BaseCallbackHandler):
        def __init__(self):
            self.ends = 0

        def on_llm_end(self, *args, **kwargs):
            self.ends += 1

    capture = Capture()
    graph = create_agent(model=Model(responses=responses), middleware=[Grounding()])
    protocol = LangGraphProtocol(graph=graph)
    events = [
        e
        async for e in protocol.stream(
            [HumanMessage(content="临时做汇报，我很紧张")], {"callbacks": [capture]}
        )
    ]
    text = "".join(e.get("content", "") for e in events if e["type"] == "token")
    assert text == final
    assert draft not in repr(events)
    usage = [e["usage"] for e in events if e["type"] == "usage"]
    assert len(usage) == 1
    assert usage[0]["total_tokens"] == 40
    assert capture.ends == 2


@pytest.mark.parametrize(
    "review", ["not json", "{}", '{"reply":""}', '{"reply":"ok","extra":true}']
)
async def test_failed_review_never_releases_draft(review):
    graph = create_agent(
        model=Model(responses=[AIMessage(content="unsafe draft"), AIMessage(content=review)]),
        middleware=[Grounding()],
    )
    seen = []
    with pytest.raises(OctopError):
        async for event in LangGraphProtocol(graph=graph).stream(
            [HumanMessage(content="hello")], {}
        ):
            seen.append(event)
    assert "unsafe draft" not in repr(seen)


async def test_tool_call_keeps_arguments_but_hides_unreviewed_preamble():
    call = {"name": "memory_search", "args": {"query": "工作"}, "id": "call", "type": "tool_call"}
    message = AIMessage(content="你一直没有被认可", tool_calls=[call])
    response = ModelResponse(result=[message])
    handler = AsyncMock(return_value=response)
    result = await grounded_reply(object(), handler)
    assert result.result[0].content == ""
    assert result.result[0].tool_calls == message.tool_calls
    assert message.content == "你一直没有被认可"
    assert handler.await_count == 1


async def test_review_is_read_only_and_does_not_treat_previous_ai_as_user_evidence():
    source = HumanMessage(content="我准备了很久", id="human")
    request = ModelRequest(
        model=Model(responses=[]),
        messages=[AIMessage(content="你没准备"), source],
        tools=[],
        system_message=None,
    )
    handler = AsyncMock(
        side_effect=[
            ModelResponse(result=[AIMessage(content="你没准备")]),
            ModelResponse(result=[AIMessage(content='{"reply":"你准备了很久。"}')]),
        ]
    )
    result = await grounded_reply(request, handler)
    review_request = handler.call_args_list[1].args[0]
    payload = json.loads(review_request.messages[0].content)
    assert payload["sources"] == [{"role": "user", "text": "我准备了很久"}]
    assert payload["previous_replies"] == ["你没准备"]
    assert review_request.tools == [] and review_request.tool_choice == "none"
    assert request.messages[1] == source
    assert result.result[0].content == "你准备了很久。"


async def test_read_only_tool_executes_and_only_checked_prose_enters_history():
    from langchain_core.tools import tool

    calls = []

    @tool
    def memory_search(query: str) -> str:
        """Search isolated memory."""
        calls.append(query)
        return "No matching memory entries."

    graph = create_agent(
        model=Model(
            responses=[
                AIMessage(
                    content="unsupported preamble",
                    additional_kwargs={"provider_context": "tool protocol signature"},
                    tool_calls=[
                        {
                            "name": "memory_search",
                            "args": {"query": "汇报"},
                            "id": "call",
                            "type": "tool_call",
                        }
                    ],
                ),
                AIMessage(content="unverified draft"),
                AIMessage(content='{"reply":"你愿意多说说那次汇报吗？"}'),
            ]
        ),
        tools=[memory_search],
        middleware=[Grounding()],
    )
    events = [
        e
        async for e in LangGraphProtocol(graph=graph).stream(
            [HumanMessage(content="那次汇报我很紧张")], {}
        )
    ]
    assert calls == ["汇报"]
    assert "unsupported preamble" not in repr(events)
    assert "unverified draft" not in repr(events)
    text = "".join(e.get("content", "") for e in events if e["type"] == "token")
    assert text == "你愿意多说说那次汇报吗？"


async def test_tool_round_retains_provider_protocol_context():
    blocks = [
        {"type": "thinking", "thinking": "private", "signature": "signed"},
        {"type": "text", "text": "unsupported prose"},
    ]
    message = AIMessage(
        content=blocks,
        additional_kwargs={"reasoning_content": "protocol reasoning"},
        tool_calls=[
            {"name": "memory_search", "args": {"query": "q"}, "id": "t", "type": "tool_call"}
        ],
    )
    response = await grounded_reply(
        object(), AsyncMock(return_value=ModelResponse(result=[message]))
    )
    assert response.result[0].content == blocks[:1]
    assert response.result[0].additional_kwargs == message.additional_kwargs
