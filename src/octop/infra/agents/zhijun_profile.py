"""An explicit owner-bound identity; expert names and IDs are not runtime permissions."""

from __future__ import annotations

from typing import Any

from octop.infra.agents.application import application_id
from octop.infra.agents.personal_ontology import _lock
from octop.infra.agents.settings.profile import dumps_config, parse_config_json
from octop.infra.errors import ErrorCode, OctopError


def primary(row: Any) -> bool:
    return bool(
        row is not None
        and application_id(row) == "wanx"
        and row.user_id is not None
        and not row.is_shared
        and parse_config_json(row.config_json).get("zhijun_profile")
        == {"version": 1, "primary": True}
    )


async def bind(registry: Any, uid: int, aid: str) -> dict[str, Any]:
    async with _lock(registry, "zhijun-primary:" + str(uid)):
        row = registry.get_row(aid)
        if (
            row is None
            or row.user_id != uid
            or row.is_shared
            or application_id(row) != "wanx"
            or row.kind == "team"
        ):
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        if any(primary(r) and r.user_id == uid and r.agent_id != aid for r in registry.list_rows()):
            raise OctopError(ErrorCode.SELF_MODEL_INVALID, "此账户已经有知君私人空间，不能自动替换")
        if primary(row):
            return {"agent_id": aid, "primary": True}
        if not registry.try_begin_history_backfill(aid):
            raise OctopError.localized(ErrorCode.AGENT_BUSY)
        key = "zhijun_profile"
        cfg = registry.get_config(aid)
        previous = cfg.get(key)
        try:
            cfg[key] = {"version": 1, "primary": True}
            registry._repos.agent_repo.update_config(aid, config_json=dumps_config(cfg))
            try:
                await registry._reload_agent(aid, strict=True)
            except BaseException as exc:
                restored = registry.get_config(aid)
                if previous is None:
                    restored.pop(key, None)
                else:
                    restored[key] = previous
                registry._repos.agent_repo.update_config(aid, config_json=dumps_config(restored))
                await registry._reload_agent(aid, strict=True)
                if isinstance(exc, Exception):
                    raise OctopError.localized(ErrorCode.INTERNAL_ERROR) from exc
                raise
        finally:
            registry.end_history_backfill(aid)
        return {"agent_id": aid, "primary": True}
