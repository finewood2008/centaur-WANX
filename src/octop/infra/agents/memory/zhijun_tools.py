"""Read-only episode tools bound to one runtime's native memory instance."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from langchain_core.tools import BaseTool, tool


def _date_boundary(value: str | None, *, end: bool, time_zone: str) -> str | None:
    if not value:
        return None
    date_only = len(value) == 10
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo(time_zone))
    if date_only and end:
        parsed += timedelta(days=1)
    return parsed.astimezone(UTC).isoformat()


async def search_episodes(
    memory: Any,
    *,
    query: str = "",
    date_from: str | None = None,
    date_to: str | None = None,
    emotion: str | None = None,
    offset: int = 0,
    limit: int = 20,
    time_zone: str = "Asia/Shanghai",
) -> dict[str, Any]:
    from octop_memory.application.dashboard_data import list_episodes

    result = await asyncio.to_thread(
        list_episodes,
        memory,
        {
            "query": query or None,
            "date_from": _date_boundary(date_from, end=False, time_zone=time_zone),
            "date_to": _date_boundary(date_to, end=True, time_zone=time_zone),
            "emotion": emotion,
            "offset": max(0, offset),
            "limit": max(1, min(100, limit)),
        },
    )
    for row in result["items"]:
        row["path"] = f"/episodes/{row['id']}"
    return {"ok": True, **result}


async def read_episode(memory: Any, episode_id: str) -> dict[str, Any]:
    from octop_memory.application.dashboard_data import get_episode, get_raw_event

    def read() -> dict[str, Any]:
        episode = get_episode(memory, {"episode_id": episode_id})
        sources: list[dict[str, Any]] = []
        missing: list[str] = []
        for source_id in episode.get("raw_event_ids", []):
            if memory.get_raw(source_id) is None:
                missing.append(source_id)
                continue
            sources.append(
                {"path": f"/raw_events/{source_id}", **get_raw_event(memory, {"id": source_id})}
            )
        return {
            "ok": True,
            "path": f"/episodes/{episode_id}",
            "episode": episode,
            "sources": sources,
            "raw_events": sources,
            "missing_source_ids": missing,
        }

    result = await asyncio.to_thread(read)
    return result


def build_episode_tools(
    memory_for_agent: Callable[[], Any],
    *,
    agent_id: str,
    user_id: int | None,
    time_zone: str = "Asia/Shanghai",
) -> list[BaseTool]:
    def owned_memory() -> Any:
        from langgraph.config import get_config

        cfg = get_config().get("configurable") or {}
        if (
            cfg.get("agent_id") != agent_id
            or user_id is None
            or str(cfg.get("user") or "") != str(user_id)
            or cfg.get("source") in {"peer", "ask_agent", "inbox"}
        ):
            raise PermissionError("profile ownership required")
        memory = memory_for_agent()
        if memory is None:
            raise RuntimeError("memory is unavailable")
        return memory

    @tool
    async def zhijun_episode_search(
        query: str = "",
        date_from: str | None = None,
        date_to: str | None = None,
        emotion: str | None = None,
        offset: int = 0,
        limit: int = 20,
    ) -> str:
        """Search this person's native episodes; paginate before summarizing a period.

        Date-only values cover whole days in the server timezone, including
        the end date. Datetimes without an offset use the server timezone;
        offset-aware ISO values keep their instant. Emotion is a native English
        episode tag. Each returned path may be verified with zhijun_episode_get.
        """
        result = await search_episodes(
            owned_memory(),
            query=query,
            date_from=date_from,
            date_to=date_to,
            emotion=emotion,
            offset=offset,
            limit=limit,
            time_zone=time_zone,
        )
        return json.dumps(result, ensure_ascii=False)

    @tool
    async def zhijun_episode_get(episode_id: str) -> str:
        """Verify a native episode and its original source events in this profile.

        episode_id is returned by zhijun_episode_search. Missing source events
        are identified explicitly; an extracted quote is not full source text.
        """
        result = await read_episode(owned_memory(), episode_id)
        return json.dumps(result, ensure_ascii=False)

    return [zhijun_episode_search, zhijun_episode_get]
