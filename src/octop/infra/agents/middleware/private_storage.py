"""Use the acting WANX account, rather than the agent owner's host privileges."""

from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from pathlib import Path
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from octop.i18n import tr
from octop.infra.agents.middleware.token_quota import configurable_user_id
from octop.infra.utils.private_paths import (
    is_private_storage_path,
    is_relative_file_pattern,
    is_untrusted_workspace,
)

resuming_actor: ContextVar[int | None] = ContextVar("private_storage_resuming_actor", default=None)


class PrivateStorageBoundary(AgentMiddleware[Any, Any]):
    def __init__(self, users: Any, workspace: Path, *, agent_id: str | None = None) -> None:
        super().__init__()
        self.users, self.workspace = users, workspace.resolve()
        self.agent_id = agent_id

    def _blocked(self, request: ToolCallRequest) -> bool:
        name = str(request.tool_call.get("name", "")).split("__")[-1]
        user_id = configurable_user_id() or resuming_actor.get()
        user = self.users.get(user_id) if user_id is not None else None
        admin = user is not None and not user.disabled and user.role == "admin"
        args = request.tool_call.get("args") or {}
        if name == "browser_use":
            if not admin and any(
                str(args.get(key, "")).strip().lower().startswith("file:")
                for key in ["url", "target_url", "href", "query", "link", "address"]
            ):
                return True
            if not args.get("path"):
                return False
            # Browser screenshot output is a file write too.
            name = "write_file"
        if name in {"execute", "execute_shell_command", "acp_runner"}:
            # An unrestricted host shell can read service files regardless of API ACL.
            return not admin
        if name not in {
            "ls",
            "glob",
            "grep",
            "read_file",
            "write_file",
            "edit_file",
            "send_file_to_user",
        }:
            return False
        if user is None or user.disabled:
            return True
        if not admin and is_untrusted_workspace(self.workspace, self.agent_id):
            return True
        if (
            name == "glob"
            and not admin
            and not is_relative_file_pattern(str(args.get("pattern", "")))
        ):
            return True
        raw = args.get("file_path", args.get("path", "."))
        if not isinstance(raw, str):
            return True
        try:
            path = Path(raw).expanduser()
            path = (path if path.is_absolute() else self.workspace / path).resolve()
            return is_private_storage_path(path) or (
                not admin and not path.is_relative_to(self.workspace)
            )
        except (OSError, RuntimeError, ValueError):
            return True

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command[Any]],
    ) -> ToolMessage | Command[Any]:
        if self._blocked(request):
            return ToolMessage(
                content=tr("errors.FORBIDDEN"), tool_call_id=request.tool_call["id"], status="error"
            )
        return handler(request)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        if self._blocked(request):
            return ToolMessage(
                content=tr("errors.FORBIDDEN"), tool_call_id=request.tool_call["id"], status="error"
            )
        return await handler(request)
