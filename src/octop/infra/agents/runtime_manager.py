"""Native runtime with host-owned application tracing boundaries."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from octop_harness import HarnessAgentManager
from octop_harness.registry import AgentEntry
from octop_harness.request import ChatRequest
from octop_harness.teams.team_manager import TeamManager


class ApplicationTeamManager(TeamManager):
    """Guard direct and queued peer dispatch, in addition to native tool discovery."""

    def list_peers(
        self,
        user_id: str | int,
        *,
        exclude_agent_id: str | None = None,
        team_peers: Sequence[str] | None = None,
    ) -> list[AgentEntry]:
        scope = "wanx"
        if exclude_agent_id is not None:
            try:
                caller = self._registry.get(exclude_agent_id)
            except KeyError:
                caller = None
            scope = caller.metadata.get("application_id", "wanx") if caller is not None else "wanx"
            if scope == "zhijun" or (
                scope != "wanx" and caller is not None and not caller.metadata.get("teams_enabled")
            ):
                return []
        peers = super().list_peers(
            user_id, exclude_agent_id=exclude_agent_id, team_peers=team_peers
        )
        return [entry for entry in peers if entry.metadata.get("application_id", "wanx") == scope]

    def _resolve_peer_entry(
        self, from_agent_id: str, to_agent_id: str, user_id: str | int
    ) -> AgentEntry:
        caller = self._registry.get(from_agent_id)
        target = self._registry.get(to_agent_id)
        if (
            caller.metadata.get("application_id", "wanx")
            != target.metadata.get("application_id", "wanx")
            or target.metadata.get("application_id", "wanx") == "zhijun"
            or (
                caller.metadata.get("application_id", "wanx") != "wanx"
                and (
                    not caller.metadata.get("teams_enabled")
                    or str(caller.metadata.get("user_id")) != str(user_id)
                )
            )
        ):
            raise ValueError("expert not found")
        return super()._resolve_peer_entry(from_agent_id, to_agent_id, user_id)


class ApplicationHarnessManager(HarnessAgentManager):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._team = ApplicationTeamManager(self._registry)
        self._team.bind_invocation_hooks(
            enrich_request=self._enrich_request,
            after_call=self._flush_langfuse,
        )
        if kwargs.get("team_processor") is not None:
            self._team.set_processor(kwargs["team_processor"])

    async def _enrich_request(self, agent_id: str, request: ChatRequest) -> ChatRequest:
        entry = self.get_agent(agent_id)
        if entry.metadata.get("application_id", "wanx") != "wanx":
            request.agent_id = agent_id
            request.callbacks = None
            return request
        return await super()._enrich_request(agent_id, request)

    def _sync_langfuse_to_agents(self) -> None:
        super()._sync_langfuse_to_agents()
        for entry in self.list_agents():
            if entry.metadata.get("application_id", "wanx") != "wanx":
                entry.agent.set_langfuse_callbacks(None)
