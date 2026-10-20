"""Prepare a Zhijun source without replacing the account's existing choices."""

from __future__ import annotations

from typing import Any

from .admin_client import BridgeUpstreamError


def _private(row: Any, user_id: int) -> bool:
    return (
        isinstance(row, dict)
        and row.get("user_id") == user_id
        and row.get("is_shared") is False
        and row.get("kind") != "team"
        and row.get("application_id", "wanx") == "wanx"
    )


async def _bind_profile(adapter: Any, headers: dict[str, str], row: dict[str, Any]) -> None:
    # Older public APIs have no primary-profile contract and permit private
    # ontology directly. Newer APIs advertise the owner binding on every row.
    if "zhijun_primary" not in row or row["zhijun_primary"] is True:
        return
    if row["zhijun_primary"] is not False:
        raise BridgeUpstreamError("BOX_UPSTREAM_PROTOCOL_INVALID")
    agent_id = row["agent_id"]
    response = await adapter._request(
        "PUT",
        f"/api/agents/{agent_id}/zhijun-profile",
        headers=headers,
        json={"version": 1},
    )
    if response.status_code != 200:
        raise BridgeUpstreamError("BOX_ZHIJUN_INITIALIZATION_FAILED")
    bound = adapter._json(response)
    if bound.get("agent_id") != agent_id or bound.get("primary") is not True:
        raise BridgeUpstreamError("BOX_UPSTREAM_PROTOCOL_INVALID")


async def ensure_private_expert(adapter: Any, token: str, user_id: int) -> None:
    """Preserve existing choices; never share or copy another user's workspace.

    An owned, shared bundled expert is also a usable source: the Zhijun app
    provisions its private workspace through its existing source binding. Do
    not create a competing blank expert or change that source's sharing policy.

    The adapter's login lock serializes initialization. A deterministic ID and
    ownership-checked conflict recovery also handle process restart/retry.
    Model configuration remains the operator's responsibility: no inference,
    paid provider, credentials or global preference is created here.
    """
    headers = {"Authorization": "Bearer " + token}
    response = await adapter._request("GET", "/api/agents?scope=mine", headers=headers)
    if response.status_code != 200:
        raise BridgeUpstreamError("BOX_ZHIJUN_INITIALIZATION_FAILED")
    try:
        rows = response.json()
    except ValueError as exc:
        raise BridgeUpstreamError("BOX_UPSTREAM_PROTOCOL_INVALID") from exc
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise BridgeUpstreamError("BOX_UPSTREAM_PROTOCOL_INVALID")
    if any(_private(row, user_id) and row.get("zhijun_primary") is True for row in rows):
        return
    for row in rows:
        agent_id = row.get("agent_id")
        if (
            (
                _private(row, user_id)
                or (
                    row.get("user_id") == user_id
                    and row.get("is_shared") is True
                    and row.get("kind") != "team"
                    and row.get("application_id", "wanx") == "wanx"
                    and row.get("template_name") == "zhijun-personal-companion"
                )
            )
            and isinstance(agent_id, str)
            and not agent_id.startswith(("zhijun-lan-user-", "zhijun-role-"))
            and "知君" in str(row.get("name", ""))
        ):
            if _private(row, user_id):
                await _bind_profile(adapter, headers, row)
            return
    agent_id = f"centuarai-zhijun-{user_id}"
    # An existing reserved ID with incompatible ownership/sharing is not ours
    # to repurpose, even when an administrator can see it.
    if any(row.get("agent_id") == agent_id for row in rows):
        raise BridgeUpstreamError("BOX_ZHIJUN_EXPERT_CONFLICT", 409)
    active = adapter._json(
        await adapter._request("GET", "/api/providers/active-model", headers=headers)
    )
    provider, model = active.get("provider_name"), active.get("model")
    if not isinstance(provider, str) or not isinstance(model, str):
        raise BridgeUpstreamError("BOX_UPSTREAM_PROTOCOL_INVALID")
    body = {
        "agent_id": agent_id,
        "name": "知君 · 私人伙伴",
        "backend": {"type": "filesystem", "virtual_mode": True},
        "knowledge_base_ids": [],
        "mcp_servers": [],
        "skill_package_ids": [],
    }
    if provider and model:
        body["default_model"] = provider + "/" + model
    created = await adapter._request(
        "POST", "/api/agents/from-expert/zhijun-personal-companion", headers=headers, json=body
    )
    if created.status_code not in {200, 201, 409}:
        raise BridgeUpstreamError("BOX_ZHIJUN_INITIALIZATION_FAILED")
    row = adapter._json(await adapter._request("GET", f"/api/agents/{agent_id}", headers=headers))
    if not _private(row, user_id) or row.get("agent_id") != agent_id:
        raise BridgeUpstreamError("BOX_ZHIJUN_EXPERT_CONFLICT", 409)
    await _bind_profile(adapter, headers, row)


async def recover_private_profile(
    adapter: Any, token: str, user: dict[str, Any], agent_id: str, live: Any
) -> bool:
    """Repair a known companion for an already verified session, never adopt data."""
    uid = user.get("id")
    if type(uid) is not int or user.get("application_id", "wanx") != "wanx":
        return False
    await live()
    response = await adapter._request(
        "GET", "/api/agents?scope=mine", headers={"Authorization": "Bearer " + token}
    )
    if response.status_code != 200:
        return False
    try:
        rows = response.json()
    except ValueError:
        return False
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        return False
    # Never replace a user's explicit primary choice, including another agent.
    if any(_private(row, uid) and row.get("zhijun_primary") is True for row in rows):
        return False
    row = next((row for row in rows if row.get("agent_id") == agent_id), None)
    if (
        not _private(row, uid)
        or row.get("zhijun_primary") is not False
        or not (
            agent_id == f"centuarai-zhijun-{uid}"
            or row.get("template_name") == "zhijun-personal-companion"
        )
    ):
        return False
    await live()
    await _bind_profile(adapter, {"Authorization": "Bearer " + token}, row)
    await live()
    return True
