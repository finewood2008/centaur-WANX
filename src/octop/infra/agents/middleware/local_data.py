"""Local data principals get model chat, never implicit host-tool authority."""

from __future__ import annotations

import asyncio
from contextvars import ContextVar
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage

from octop.i18n import tr

# Set only by the verified native gate. Context propagates into spawned turn
# tasks; no context (cron, restored checkpoint, peer call) is not permission.
local_data_live_check: ContextVar[Any] = ContextVar("local_data_live_check", default=None)
SAFE_TOOLS = frozenset({"current_time"})


def _check() -> None:
    check = local_data_live_check.get()
    if check is None:
        raise PermissionError("local data session required")
    check()


class LocalDataToolBoundary(AgentMiddleware[Any, Any]):
    def _request(self, request: Any) -> Any:
        return request.override(
            tools=[tool for tool in request.tools if getattr(tool, "name", "") in SAFE_TOOLS]
        )

    def wrap_model_call(self, request: Any, handler: Any) -> Any:
        _check()
        result = handler(self._request(request))
        _check()
        return result

    async def awrap_model_call(self, request: Any, handler: Any) -> Any:
        await asyncio.to_thread(_check)
        result = await handler(self._request(request))
        await asyncio.to_thread(_check)
        return result

    def wrap_tool_call(self, request: Any, handler: Any) -> Any:
        _check()
        if request.tool_call.get("name") not in SAFE_TOOLS:
            return ToolMessage(
                content=tr("errors.FORBIDDEN"), tool_call_id=request.tool_call["id"], status="error"
            )
        result = handler(request)
        _check()
        return result

    async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
        await asyncio.to_thread(_check)
        if request.tool_call.get("name") not in SAFE_TOOLS:
            return ToolMessage(
                content=tr("errors.FORBIDDEN"), tool_call_id=request.tool_call["id"], status="error"
            )
        result = await handler(request)
        await asyncio.to_thread(_check)
        return result
