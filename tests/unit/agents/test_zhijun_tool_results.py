"""Malformed parallel response-option calls must not break the dialogue."""

import json
from unittest.mock import AsyncMock, Mock

import pytest
from langchain.agents.middleware import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_openai.chat_models.base import _convert_message_to_dict

from octop.infra.agents.middleware.zhijun import ZhijunMemoryBoundary


def mixed_call():
    return AIMessage(
        content="",
        tool_calls=[{"name": "zhijun_ontology_update", "id": "valid", "args": {}}],
        invalid_tool_calls=[
            {
                "name": "zhijun_response_options",
                "id": "invalid",
                "args": '{"question" string="true">继续聊？}',
                "error": "invalid JSON",
            }
        ],
    )


def assert_provider_protocol(messages):
    """Check the actual OpenAI serializer includes a contiguous result per call."""
    payload = [_convert_message_to_dict(message) for message in messages]
    for index, message in enumerate(payload):
        calls = message.get("tool_calls", [])
        if not calls:
            continue
        expected = {call["id"] for call in calls}
        answered = set()
        for answer in payload[index + 1 :]:
            if answer["role"] != "tool":
                break
            answered.add(answer["tool_call_id"])
        assert answered == expected


@pytest.mark.asyncio
async def test_parallel_invalid_call_gets_failure_before_next_user_without_reexecution():
    call = mixed_call()
    valid = ToolMessage(content='{"saved":true}', tool_call_id="valid")
    history = [HumanMessage(content="继续聊"), call, valid, HumanMessage(content="再试试")]
    request = ModelRequest(model=Mock(), messages=history, state={"messages": history})
    handler = AsyncMock(return_value=ModelResponse(result=[AIMessage(content="继续交谈")]))
    boundary = ZhijunMemoryBoundary("owned", 1, lambda: None)
    await boundary.awrap_model_call(request, handler)
    supplied = handler.call_args.args[0].messages
    assert_provider_protocol(supplied)
    failure = supplied[3]
    assert failure.tool_call_id == "invalid"
    assert failure.status == "error"
    assert json.loads(failure.content) == {
        "ok": False,
        "error": "invalid_tool_arguments",
        "executed": False,
    }
    assert supplied[2] is valid
    assert request.messages is history
    assert len(history) == 4
    assert call.invalid_tool_calls[0]["args"] == '{"question" string="true">继续聊？}'
    assert boundary._model_request(boundary._model_request(request)).messages == supplied


def test_existing_invalid_result_and_successful_tool_results_are_preserved():
    call = mixed_call()
    failure = ToolMessage(content="Malformed arguments", tool_call_id="invalid", status="error")
    valid = ToolMessage(content='{"saved":true}', tool_call_id="valid")
    history = [call, failure, valid, AIMessage(content="正常回复")]
    request = ModelRequest(model=Mock(), messages=history, state={"messages": history})
    handler = Mock(return_value=ModelResponse(result=[AIMessage(content="正常回复")]))
    ZhijunMemoryBoundary("owned", 1, lambda: None).wrap_model_call(request, handler)
    supplied = handler.call_args.args[0].messages
    assert supplied == history
    assert_provider_protocol(supplied)
    assert all(a is b for a, b in zip(supplied, history, strict=True))
