"""Execute stale tool names once, without using a stale or unselected grant."""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage
from langchain_core.tools import StructuredTool
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

from octop.infra.agents.middleware.knowledge_tools import KnowledgeToolScopeMiddleware

OLD = "wanx_knowledge_" + "a" * 32
CURRENT = "wanx_knowledge_" + "b" * 32
OTHER = "wanx_knowledge_" + "c" * 32


def graph(registered_old: bool = False):
    calls = []

    def search(query: str, warehouse_id: str = "") -> str:
        calls.append(("current", query, warehouse_id))
        return "[MASKED] synthetic evidence"

    def stale(query: str, warehouse_id: str = "") -> str:
        calls.append(("old", query, warehouse_id))
        return "must not run"

    tools = [
        StructuredTool.from_function(
            search, name=CURRENT + "_xingtu_search", description="Synthetic read"
        )
    ]
    tools.append(
        StructuredTool.from_function(
            search, name="ordinary_tool", description="Synthetic ordinary tool"
        )
    )
    if registered_old:
        tools.append(
            StructuredTool.from_function(
                stale, name=OLD + "_xingtu_search", description="Old synthetic grant"
            )
        )
    scope = KnowledgeToolScopeMiddleware(lambda: tools)
    builder = StateGraph(MessagesState)
    builder.add_node(
        "tools",
        ToolNode(tools, wrap_tool_call=scope.wrap_tool_call, awrap_tool_call=scope.awrap_tool_call),
    )
    builder.add_edge(START, "tools")
    builder.add_edge("tools", END)
    return builder.compile(), calls


def request(name: str = OLD):
    return {
        "messages": [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": name + "_xingtu_search",
                        "args": {"query": "synthetic", "warehouse_id": "observed-warehouse"},
                        "id": "call-1",
                    }
                ],
            )
        ]
    }


@pytest.mark.parametrize("registered_old", [False, True])
def test_sync_repair_uses_current_tool_and_preserves_args(registered_old: bool) -> None:
    runner, calls = graph(registered_old)
    result = runner.invoke(request(), {"configurable": {"mcp_servers": [CURRENT]}})
    assert calls == [("current", "synthetic", "observed-warehouse")]
    assert result["messages"][-1].content == "[MASKED] synthetic evidence"
    assert result["messages"][-1].tool_call_id == "call-1"


@pytest.mark.asyncio
@pytest.mark.parametrize("active", [None, [], [CURRENT], [CURRENT, OTHER]])
async def test_async_repair_requires_one_unambiguous_selected_grant(active) -> None:
    runner, calls = graph(registered_old=True)
    result = await runner.ainvoke(request(), {"configurable": {"mcp_servers": active}})
    if active == [CURRENT]:
        assert calls == [("current", "synthetic", "observed-warehouse")]
        assert result["messages"][-1].status == "success"
    else:
        assert calls == []
        assert result["messages"][-1].status == "error"
        assert "ASSISTANT_KNOWLEDGE_DENIED" in result["messages"][-1].content


def test_current_tool_stays_usable_with_multiple_selected_servers() -> None:
    runner, calls = graph()
    runner.invoke(request(CURRENT), {"configurable": {"mcp_servers": [CURRENT, OTHER]}})
    assert calls == [("current", "synthetic", "observed-warehouse")]


def test_ordinary_tools_are_not_changed_by_knowledge_selection() -> None:
    runner, calls = graph()
    message = AIMessage(
        content="",
        tool_calls=[{"name": "ordinary_tool", "args": {"query": "synthetic"}, "id": "ordinary"}],
    )
    runner.invoke({"messages": [message]}, {"configurable": {"mcp_servers": []}})
    assert calls == [("current", "synthetic", "")]
