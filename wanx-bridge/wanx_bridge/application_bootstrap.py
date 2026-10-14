"""Apply a box administrator's app policy to a verified platform user."""

from __future__ import annotations

from typing import Any

from .admin_client import BridgeUpstreamError


def _error() -> BridgeUpstreamError:
    return BridgeUpstreamError("BOX_APPLICATION_BOOTSTRAP_FAILED", 503)


def _json(response: Any) -> Any:
    if response.status_code not in {200, 201}:
        raise _error()
    try:
        return response.json()
    except ValueError:
        raise _error() from None


def _access(value: Any, uid: int) -> bool | None:
    if not isinstance(value, list):
        raise _error()
    seen = set()
    result = None
    for row in value:
        if (
            not isinstance(row, dict)
            or type(row.get("user_id")) is not int
            or row["user_id"] < 1
            or type(row.get("enabled")) is not bool
            or row["user_id"] in seen
        ):
            raise _error()
        seen.add(row["user_id"])
        if row["user_id"] == uid:
            result = row["enabled"]
    return result


async def ensure_application_access(adapter: Any, token: str, application_id: str) -> bool:
    """Grant only an absent entitlement under the explicit box.sh policy.

    Caller holds the adapter lock. Existing revocations win. The surrounding
    platform session validates current box membership before and after exchange.
    No market installation, caller-supplied user ID, or native admin role grants
    this entitlement. Other products retain their normal explicit access rules.
    """
    if application_id != "super-advisory":
        return False
    response = await adapter._request(
        "GET", "/api/auth/me", headers={"Authorization": "Bearer " + token}
    )
    if response.status_code in {401, 403}:
        return False
    me = _json(response)
    if not isinstance(me, dict):
        raise _error()
    uid = me.get("id")
    if (
        type(uid) is not int
        or uid < 1
        or uid == adapter._admin_id
        or uid not in adapter._users.values()
        or me.get("application_id") != "wanx"
        or me.get("has_password") is not False
        or me.get("sso_identities") != [{"kind": "oidc"}]
    ):
        return False
    path = "/api/admin/applications/super-advisory"
    response = await adapter._admin("GET", path + "/deployment")
    if response.status_code == 404:
        return False
    deployment = _json(response)
    if not isinstance(deployment, dict) or not isinstance(deployment.get("configuration"), dict):
        raise _error()
    if (
        deployment.get("enabled") is not True
        or deployment["configuration"].get("auto_grant_box_users") is not True
    ):
        return False
    access = _access(_json(await adapter._admin("GET", path + "/access")), uid)
    if access is not None:
        return access
    _json(
        await adapter._admin(
            "PUT",
            path + "/access",
            json={"user_id": uid, "enabled": True, "only_if_missing": True},
        )
    )
    access = _access(_json(await adapter._admin("GET", path + "/access")), uid)
    if access is None:
        raise _error()
    return access
