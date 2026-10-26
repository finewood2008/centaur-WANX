"""Keep historical Starlink calls on the current turn's explicit grant."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest

_TOOL = re.compile(
    r"^(wanx_knowledge_[0-9a-f]{32})_(xingtu_(?:warehouses|documents|graph|search|evidence))$"
)
_SERVER = re.compile(r"^wanx_knowledge_[0-9a-f]{32}$")


class KnowledgeToolScopeMiddleware(AgentMiddleware[Any, Any]):
    def __init__(self, tools: Callable[[], list[Any]]) -> None:
        super().__init__()
        self._tools = tools

    def _current_request(self, request: ToolCallRequest) -> ToolCallRequest | ToolMessage:
        call = request.tool_call
        match = _TOOL.fullmatch(call["name"])
        if not match:
            return request
        config = request.runtime.config.get("configurable") or {}
        active = [s for s in (config.get("mcp_servers") or []) if _SERVER.fullmatch(s)]
        if match[1] in active:
            return request
        if len(active) == 1:
            name = active[0] + "_" + match[2]
            tool = next((t for t in self._tools() if t.name == name), None)
            if tool is not None:
                return request.override(tool_call={**call, "name": name}, tool=tool)
        return ToolMessage(
            content='{"code":"ASSISTANT_KNOWLEDGE_DENIED"}',
            tool_call_id=call["id"],
            name=call["name"],
            status="error",
        )

    def wrap_tool_call(self, request: ToolCallRequest, handler: Callable[..., Any]) -> Any:
        current = self._current_request(request)
        return current if isinstance(current, ToolMessage) else handler(current)

    async def awrap_tool_call(
        self, request: ToolCallRequest, handler: Callable[..., Awaitable[Any]]
    ) -> Any:
        current = self._current_request(request)
        return current if isinstance(current, ToolMessage) else await handler(current)
