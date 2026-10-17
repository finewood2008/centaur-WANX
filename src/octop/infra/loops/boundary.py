"""Per-invocation capability boundary, including resumed native tool calls."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from contextlib import suppress
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from octop.infra.agents.middleware.zhijun import _name


@dataclass
class LoopScope:
    allowed_tools: frozenset[str]
    validate: Callable[[], None]
    events: list[dict[str, Any]] = field(default_factory=list)
    record: Callable[[list[dict[str, Any]]], None] | None = None


def has_uncertain_actions(events: list[dict[str, Any]]) -> bool:
    # Only this native, side-effect-free tool is exempt. Unknown and connector tools stay conservative.
    return any(event.get("tool") != "current_time" for event in events)


loop_scope: ContextVar[LoopScope | None] = ContextVar("wanx_loop_scope", default=None)


class LoopBoundary(AgentMiddleware[Any, Any]):
    """Leave regular turns unchanged; enforce Loop scopes before any tool runs."""

    async def awrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any]:
        scope = loop_scope.get()
        if scope is not None:
            await asyncio.to_thread(scope.validate)
            if not scope.allowed_tools <= {_name(t) for t in request.tools}:
                raise PermissionError("loop_dependency_unavailable")
            request = request.override(
                tools=[t for t in request.tools if _name(t) in scope.allowed_tools]
            )
        return await handler(request)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        scope = loop_scope.get()
        if scope is None:
            return await handler(request)
        await asyncio.to_thread(scope.validate)
        name = str(request.tool_call.get("name") or "")
        if name not in scope.allowed_tools:
            raise PermissionError("loop_tool_outside_scope")
        # A durable round is already marked running before an external action.
        # An interrupted round is never automatically replayed after restart.
        event: dict[str, Any] = {
            "tool": name,
            "call_id": str(request.tool_call.get("id") or ""),
            "args": request.tool_call.get("args") or {},
            "status": "unknown",
        }
        scope.events.append(event)
        if scope.record is not None:
            await asyncio.to_thread(scope.record, scope.events)
        response = await handler(request)
        messages = (
            [response]
            if isinstance(response, ToolMessage)
            else (response.update or {}).get("messages", [])
            if isinstance(response.update, dict)
            else []
        )
        for message in messages:
            if isinstance(message, ToolMessage) and message.tool_call_id == event["call_id"]:
                content = message.content
                with suppress(ValueError):
                    content = json.loads(content) if isinstance(content, str) else content
                event.update(status=getattr(message, "status", "success"), result=content)
        if scope.record is not None:
            await asyncio.to_thread(scope.record, scope.events)
        return response
