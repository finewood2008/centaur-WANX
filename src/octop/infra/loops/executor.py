"""Provision the private WANX expert used by newly created CentaurLoops."""

from __future__ import annotations

import asyncio
from typing import Any

from octop.infra.agents.application import application_id
from octop.infra.agents.manager import AgentCreateSpec
from octop.infra.agents.settings.tool_catalog import BUILTIN_TOOL_CATALOG, CRITICAL_TOOLS
from octop.infra.db.repos.proactive_care_config import ProactiveCareConfig
from octop.infra.errors import ErrorCode, OctopError

TEMPLATE = "centaurloop"
# Start with bounded research and reporting. A task still needs its own tool scope.
READ_TOOLS = CRITICAL_TOOLS | {
    "current_time",
    "web_fetch",
    "searchfree_search",
    "ask_user_question",
    "search_knowledge",
}


class LoopExecutor:
    def __init__(self, service: Any):
        self.service = service
        self._lock = asyncio.Lock()

    async def ensure(self, user_id: int) -> dict[str, str]:
        svc = self.service
        async with self._lock:
            user = await svc._db(svc.repos.user_repo.get, user_id)
            if not user or user.disabled or application_id(user) != "wanx":
                raise OctopError.localized(ErrorCode.FORBIDDEN)
            # Stable per-owner identity prevents duplicate experts on concurrent opens
            # and never adopts an unrelated expert merely because its name matches.
            aid = f"centaurloop-{user_id}"
            row = await svc._db(svc.repos.agent_repo.get, aid)
            if row is None:
                owned = await svc._db(svc.agents.list_agents, user_id)
                model = next(
                    (
                        a.default_model
                        for a in owned
                        if a.enabled and application_id(a) == "wanx" and a.default_model
                    ),
                    None,
                )

                async def initialize(created: Any, workspace: Any) -> None:
                    # Dedicated experts run only their confirmed Loops, without
                    # the general assistant's independently scheduled greetings.
                    await svc._db(
                        svc.repos.proactive_care_config_repo.upsert,
                        ProactiveCareConfig(agent_id=created.agent_id, enabled=False),
                    )

                row = await svc.agents.create(
                    AgentCreateSpec(
                        agent_id=aid,
                        user_id=user_id,
                        name="半人马环",
                        description="通过对话配置重复的小任务，自动执行并在关键时刻请本人判断。",
                        template_name=TEMPLATE,
                        default_model=model,
                        color="#a6452e",
                        icon_name="repeat",
                        config={
                            "tools_disabled": [
                                tool.name
                                for tool in BUILTIN_TOOL_CATALOG
                                if tool.name not in READ_TOOLS
                            ]
                        },
                    ),
                    workspace_initializer=initialize,
                )
            if row.template_name != TEMPLATE:
                raise OctopError(ErrorCode.LOOP_INVALID, "专用专家标识已被占用，请在万象中检查。")
            await svc._db(svc._assert_owner, user_id, row.agent_id)
            return {"agent_id": row.agent_id, "name": row.name}
