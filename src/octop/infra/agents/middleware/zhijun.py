"""Restrict Zhijun tools and execution to owned memory and reference material."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from octop.i18n import tr
from octop.infra.utils.locale import normalize_locale

ZHJUN_TOOLS = frozenset(
    {
        "zhijun_ontology_update",
        "zhijun_context_update",
        "zhijun_knowledge_get",
        "zhijun_understanding_review",
        "zhijun_memory_recall",
        "zhijun_attachment_get",
        "zhijun_response_options",
        "search_knowledge",
        "current_time",
    }
)


def _name(tool: Any) -> str:
    if isinstance(tool, dict):
        fn = tool.get("function")
        return str(fn.get("name") if isinstance(fn, dict) else tool.get("name") or "")
    return str(getattr(tool, "name", ""))


_LEGACY_RECALL = {
    "memory_search",
    "memory_get",
    "zhijun_ontology_read",
    "zhijun_episode_search",
    "zhijun_episode_get",
}


def _with_invalid_tool_results(messages: list[Any]) -> list[Any]:
    """Close malformed calls in the model view without rewriting stored history.

    The graph executes valid calls but can leave a parallel invalid call without
    a result. Providers still serialize that invalid call and require its result
    before the next model request. Record failure, never invent successful data.
    """
    result: list[Any] = []
    index = 0
    while index < len(messages):
        message = messages[index]
        result.append(message)
        index += 1
        if not isinstance(message, AIMessage) or not message.invalid_tool_calls:
            continue
        answered: set[str] = set()
        while index < len(messages) and isinstance(messages[index], ToolMessage):
            answer = messages[index]
            answered.add(answer.tool_call_id)
            result.append(answer)
            index += 1
        for call in message.invalid_tool_calls:
            call_id = call.get("id")
            if not call_id or call_id in answered:
                continue
            result.append(
                ToolMessage(
                    content=json.dumps(
                        {"ok": False, "error": "invalid_tool_arguments", "executed": False}
                    ),
                    tool_call_id=call_id,
                    name=call.get("name") or "unknown",
                    status="error",
                )
            )
            answered.add(call_id)
    return result


class ZhijunMemoryBoundary(AgentMiddleware[Any, Any]):
    """An allowlist that cannot be bypassed by a resumed/forged old tool call."""

    def __init__(
        self,
        agent_id: str,
        user_id: int | None,
        memory_service: Callable[[], Any],
        *,
        allowed_tools: frozenset[str] = ZHJUN_TOOLS,
        allow_peer_calls: bool = False,
    ) -> None:
        super().__init__()
        self.agent_id = agent_id
        self.user_id = user_id
        self.memory_service = memory_service
        self.allowed_tools = allowed_tools
        self.allow_peer_calls = allow_peer_calls

    def _model_request(self, request: ModelRequest[Any]) -> ModelRequest[Any]:
        messages = _with_invalid_tool_results(request.messages)
        if "zhijun_memory_recall" in self.allowed_tools:
            calls = {
                call["id"]: call["name"]
                for message in messages
                for call in getattr(message, "tool_calls", [])
            }
            # Old checkpoints must not replay unlabelled native recall as evidence.
            messages = [
                message.model_copy(
                    update={
                        "content": json.dumps(
                            {
                                "ok": False,
                                "error": "legacy_recall_requires_refresh",
                                "recall_tool": "zhijun_memory_recall",
                            }
                        )
                    }
                )
                if isinstance(message, ToolMessage)
                and (message.name or calls.get(message.tool_call_id)) in _LEGACY_RECALL
                else message
                for message in messages
            ]
        return request.override(
            tools=[t for t in request.tools if _name(t) in self.allowed_tools],
            messages=messages,
        )

    def wrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], ModelResponse[Any]],
    ) -> ModelResponse[Any]:
        return handler(self._model_request(request))

    async def awrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any]:
        return await handler(self._model_request(request))

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        from langgraph.config import get_config

        cfg = get_config().get("configurable") or {}
        allowed = (
            str(cfg.get("agent_id") or "") == self.agent_id
            and self.user_id is not None
            and str(cfg.get("user") or "") == str(self.user_id)
            and (self.allow_peer_calls or cfg.get("source") not in {"peer", "ask_agent", "inbox"})
            and str(request.tool_call.get("name") or "") in self.allowed_tools
        )
        if allowed:
            name = str(request.tool_call.get("name") or "")
            try:
                if name in {"memory_search", "memory_get"}:
                    service = self.memory_service()
                    if service is None:
                        raise RuntimeError("memory is unavailable")
                    args = request.tool_call.get("args") or {}
                    if name == "memory_search":
                        result = await asyncio.to_thread(
                            service.search, args["query"], max_results=args.get("max_results", 5)
                        )
                    else:
                        result = await asyncio.to_thread(
                            service.get,
                            args["path"],
                            start=args.get("start"),
                            lines=args.get("lines"),
                        )
                        result = {**result, "path": args["path"]}
                    if result.get("error"):
                        raise RuntimeError("memory lookup failed")
                    return ToolMessage(
                        content=json.dumps({"ok": True, **result}, ensure_ascii=False),
                        tool_call_id=str(request.tool_call.get("id") or ""),
                    )
                return await handler(request)
            except Exception:
                error = {
                    "search_knowledge": "knowledge_unavailable",
                    "zhijun_attachment_get": "attachment_unavailable",
                    "zhijun_response_options": "expression_invitation_unavailable",
                    "current_time": "tool_unavailable",
                }.get(name, "memory_unavailable")
                return ToolMessage(
                    content=json.dumps({"ok": False, "error": error}),
                    tool_call_id=str(request.tool_call.get("id") or ""),
                    status="error",
                )
        return ToolMessage(
            content=tr("errors.FORBIDDEN", normalize_locale(cfg.get("locale"))),
            tool_call_id=str(request.tool_call.get("id") or ""),
            status="error",
        )
