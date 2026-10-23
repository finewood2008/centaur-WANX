from unittest.mock import AsyncMock, patch

import pytest
from langchain.agents.middleware import ModelResponse
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from tests.unit.agents.test_role_ontology import Registry

from octop.infra.agents.role_ontology import RoleOntologyMiddleware
from octop.infra.agents.zhijun_interview import InterviewState


@pytest.mark.parametrize(
    "status,thread,uid,source,expected",
    [
        ("active", "own-thread", "1", "dashboard", True),
        ("paused", "own-thread", "1", "dashboard", False),
        ("completed", "own-thread", "1", "dashboard", False),
        ("active", "another-thread", "1", "dashboard", False),
        ("active", "own-thread", "2", "dashboard", False),
        ("active", "own-thread", "1", "peer", False),
    ],
)
async def test_interview_context_is_scoped_and_preserves_original_messages(
    status, thread, uid, source, expected
):
    registry = Registry()
    workspace = registry.get_agent("personal").workspace
    workspace.files["zhijun/interview.json"] = InterviewState(
        status=status, thread_id="own-thread", step=1
    ).model_dump_json()

    class Request:
        state = {"messages": [HumanMessage(content="用户原话", id="turn")]}
        messages = state["messages"]
        system_message = SystemMessage(content="原有专家规则与授权边界")

        def override(self, **kw):
            result = Request()
            result.system_message = kw["system_message"]
            return result

    request = Request()
    handler = AsyncMock(
        return_value=ModelResponse(result=[AIMessage(content='{"reply":"response"}')])
    )
    before = dict(workspace.files)
    with patch(
        "langgraph.config.get_config",
        return_value={
            "configurable": {
                "agent_id": "personal",
                "user": uid,
                "thread_id": thread,
                "source": source,
            }
        },
    ):
        await RoleOntologyMiddleware(registry, "personal", 1).awrap_model_call(request, handler)
    supplied = handler.call_args_list[0].args[0]
    assert supplied.system_message.content.startswith(request.system_message.content)
    assert ("最近你把心力" in supplied.system_message.content) is expected
    assert supplied.messages == request.messages
    assert workspace.files == before


@pytest.mark.parametrize("preparation", [False, True])
async def test_active_interview_follows_style_and_context_without_mutating_history(preparation):
    from tests.unit.agents.test_interaction_preferences import PREFERENCES

    from octop.infra.agents.middleware.interaction import InteractionPreferencesMiddleware
    from octop.infra.agents.ontology_types import PersonalOntology
    from octop.infra.agents.personal_ontology import _read, _save
    from octop.infra.agents.settings.interaction import InteractionPreferences

    registry = Registry()
    workspace = registry.get_agent("personal").workspace
    state = InterviewState(status="active", thread_id="own-thread")
    workspace.files["zhijun/interview.json"] = state.model_dump_json()
    doc = PersonalOntology()
    doc.preparation.enabled = preparation
    await _save(workspace, doc)

    class Request:
        def __init__(self, system=None):
            self.messages = [HumanMessage(content="有一次临时做汇报，我很紧张。", id="turn")]
            self.state = {"messages": self.messages}
            self.system_message = system or SystemMessage(content="原有身份与授权边界")

        def override(self, **kw):
            return Request(kw["system_message"])

    request = Request()
    handler = AsyncMock(
        return_value=ModelResponse(result=[AIMessage(content='{"reply":"response"}')])
    )

    async def role(req):
        return await RoleOntologyMiddleware(registry, "personal", 1).awrap_model_call(req, handler)

    with patch(
        "langgraph.config.get_config",
        return_value={
            "configurable": {
                "agent_id": "personal",
                "user": "1",
                "thread_id": "own-thread",
                "source": "dashboard",
            }
        },
    ):
        await InteractionPreferencesMiddleware(
            InteractionPreferences(**PREFERENCES)
        ).awrap_model_call(request, role)
    supplied = handler.call_args_list[0].args[0]
    text = supplied.system_message.content
    assert text.startswith("原有身份与授权边界")
    assert text.index("用户选择的交流方式") < text.index("起步访谈：")
    if preparation:
        assert text.index('"owner_write_receipt"') < text.index("起步访谈：")
    assert supplied.messages == request.messages
    assert (await _read(workspace)).claims == []
    assert workspace.files["zhijun/interview.json"] == state.model_dump_json()
