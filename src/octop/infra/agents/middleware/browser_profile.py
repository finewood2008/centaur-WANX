"""Force browser tool calls onto the current user's isolated profile."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.config import get_config
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from octop.i18n import tr
from octop.infra.browser.control import control_for, finish_even_if_cancelled
from octop.infra.browser.learning import restrict_action
from octop.infra.utils.browser_media import parse_octop_user_id, user_browser_profile

logger = logging.getLogger(__name__)

_BROWSER_TOOL = "browser_use"
_MISSING_USER = (
    "browser_use blocked: the current turn has no Octop user id, "
    "so a browser profile cannot be isolated."
)


def _bind_browser_profile(request: ToolCallRequest) -> ToolCallRequest | ToolMessage:
    tool_call = request.tool_call
    if str(tool_call.get("name") or "") != _BROWSER_TOOL:
        return request

    configurable = dict(get_config().get("configurable") or {})
    user_id = parse_octop_user_id(configurable.get("user"))
    if user_id is None:
        logger.warning("browser_use blocked: configurable.user is missing or invalid")
        return ToolMessage(
            content=_MISSING_USER,
            tool_call_id=str(tool_call.get("id") or ""),
            status="error",
        )

    raw_args = tool_call.get("args")
    args = dict(raw_args) if isinstance(raw_args, dict) else {}
    args["profile"] = user_browser_profile(user_id)
    return request.override(tool_call={**tool_call, "args": args})


class BrowserProfileMiddleware(AgentMiddleware[Any, Any]):
    """Prevent model-selected profiles from crossing Octop user boundaries."""

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command[Any]],
    ) -> ToolMessage | Command[Any]:
        bound = _bind_browser_profile(request)
        if isinstance(bound, ToolMessage):
            return bound
        if str(bound.tool_call.get("name") or "") == _BROWSER_TOOL:
            profile = str(bound.tool_call.get("args", {}).get("profile", ""))
            if control_for(profile).managed:
                return ToolMessage(
                    content=tr("browser_control.manual"),
                    tool_call_id=bound.tool_call["id"],
                    status="error",
                )
        return handler(bound)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        bound = _bind_browser_profile(request)
        if isinstance(bound, ToolMessage):
            return bound
        if str(bound.tool_call.get("name") or "") != _BROWSER_TOOL:
            return await handler(bound)
        profile = str(bound.tool_call.get("args", {}).get("profile", ""))
        control = control_for(profile)
        async with control.lock:
            thread_id = str((get_config().get("configurable") or {}).get("thread_id") or "")
            if control.managed and (control.owner != "agent" or thread_id != control.thread_id):
                return ToolMessage(
                    content=tr("browser_control.manual"),
                    tool_call_id=bound.tool_call["id"],
                    status="error",
                )
            if restrict_action(profile, str(bound.tool_call.get("args", {}).get("action", ""))):
                return ToolMessage(
                    content=tr("browser_control.learning_current_tab"),
                    tool_call_id=bound.tool_call["id"],
                    status="error",
                )
            task = asyncio.ensure_future(handler(bound))
            return await finish_even_if_cancelled(task)


__all__ = ["BrowserProfileMiddleware"]
