"""Owner-held, blank Zhijun profiles using the native agent lifecycle."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING, Any

from octop.infra.errors import ErrorCode, OctopError

if TYPE_CHECKING:
    from octop.infra.agents.manager import AgentManager
    from octop.infra.db.repos.agents import AgentRow

APPLICATION_ID = "zhijun"
RULES_DIR = Path(__file__).parent / "experts" / "library" / "zhijun-personal-companion"
PROFILE_READY = ".zhijun-profile-ready"
MATERIAL_RULES = "ZHIJUN_MATERIALS.md"
CONVERSATION_RULES = "ZHIJUN_CONVERSATION.md"


def get_profile(manager: AgentManager, user_id: int) -> AgentRow | None:
    return manager.get_application_profile(user_id, APPLICATION_ID)


async def seed_blank_profile(row: AgentRow, workspace: Any) -> None:
    """Seed behavior only; never copy an existing person's context or run the model."""
    pairs = await asyncio.to_thread(
        lambda: [
            (name, (RULES_DIR / name).read_bytes())
            for name in ("AGENTS.md", "SOUL.md", MATERIAL_RULES, CONVERSATION_RULES)
        ]
    )
    for name in ("USER.md", "MEMORY.md"):
        if await workspace.aread_text(name) is None:
            pairs.append((name, b""))
    await workspace.aupload_many(pairs)
    for name, content in pairs:
        if await workspace.aread_text(name) != content.decode("utf-8"):
            raise OSError("profile initialization readback failed")
    # Publish completion only after every behavior file has been verified.
    await workspace.aupload_many([(".bootstrapped", b"zhijun\n")])
    if await workspace.aread_text(".bootstrapped") != "zhijun\n":
        raise OSError("bootstrap marker readback failed")
    await workspace.aupload_many([(PROFILE_READY, b"ready-v1\n")])
    if await workspace.aread_text(PROFILE_READY) != "ready-v1\n":
        raise OSError("profile marker readback failed")


async def ensure_profile_initialized(row: AgentRow, workspace: Any) -> None:
    if await workspace.aread_text(PROFILE_READY) != "ready-v1\n":
        await seed_blank_profile(row, workspace)
    else:
        # Add new behavior without replacing existing personal rules or memory.
        for name in (MATERIAL_RULES, CONVERSATION_RULES):
            if await workspace.aread_text(name) is not None:
                continue
            content = await asyncio.to_thread((RULES_DIR / name).read_bytes)
            await workspace.aupload_many([(name, content)])
            if await workspace.aread_text(name) != content.decode("utf-8"):
                raise OSError("behavior initialization readback failed")


async def get_or_create_profile(manager: AgentManager, user_id: int) -> AgentRow:
    """Return the unique profile, preserving its identity even when startup fails."""
    from octop.infra.agents.manager import AgentCreateSpec

    existing = get_profile(manager, user_id)
    if existing is not None:
        if existing.last_state in {"failed", "stopped"}:
            workspace = manager.workspace_for_agent(existing.agent_id)
            if workspace is not None:
                await ensure_profile_initialized(existing, workspace)
            await manager.start(existing.agent_id)
        fresh = manager.get_row(existing.agent_id)
        assert fresh is not None
        return fresh
    try:
        row = await manager.create(
            AgentCreateSpec(
                name="知君",
                user_id=user_id,
                application_id=APPLICATION_ID,
                description="在交谈中积累经历，带着记忆理解自己。",
                skill_package_ids=[],
                knowledge_base_ids=[],
                mcp_servers=[],
            ),
            workspace_initializer=seed_blank_profile,
        )
    except Exception:
        # The partial unique index is the cross-process arbiter. A competing
        # creator (or failed startup) may already have durably allocated the row.
        existing = get_profile(manager, user_id)
        if existing is None:
            raise
        return existing
    fresh = get_profile(manager, user_id)
    if fresh is None:
        raise OctopError.localized(ErrorCode.AGENT_NOT_FOUND)
    assert fresh.agent_id == row.agent_id
    return fresh
