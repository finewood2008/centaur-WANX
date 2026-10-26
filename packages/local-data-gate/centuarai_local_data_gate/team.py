"""Versioned team authority values, independent of cloud roles and native admins."""

from __future__ import annotations

import re
from urllib.parse import urlsplit

PERMISSIONS = frozenset(
    {
        "members.read",
        "members.manage",
        "roles.manage",
        "applications.manage",
        "resources.manage",
    }
)
TEAM_FIELDS = {
    "schemaVersion",
    "boxId",
    "ownershipEpoch",
    "principalId",
    "membershipId",
    "membershipRevision",
    "roleId",
    "permissions",
}


def validate_team(value, identity=None):
    from .protocol import digest32, fields, integer, need, token

    fields(value, TEAM_FIELDS)
    need(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1)
    for name in ("boxId", "principalId"):
        token(value[name])
    digest32(value["membershipId"])
    integer(value["ownershipEpoch"])
    integer(value["membershipRevision"])
    need(value["roleId"] in {"owner", "manager", "member"})
    permissions = value["permissions"]
    need(type(permissions) is list and len(permissions) <= len(PERMISSIONS))
    need(all(type(item) is str and item in PERMISSIONS for item in permissions))
    need(permissions == sorted(set(permissions)))
    if identity is not None:
        need(
            all(
                value[name] == identity[name] for name in ("boxId", "ownershipEpoch", "principalId")
            ),
            "LOCAL_DATA_CONTEXT_CHANGED",
        )
    return value


def team_resource(value):
    """Return the finite resource kind and identifier; names never grant access."""
    if value == "team:management":
        return "management", None
    if type(value) is str:
        match = re.fullmatch(
            r"team:(space|knowledge|agent|application):([A-Za-z0-9][A-Za-z0-9._-]{0,95})", value
        )
        if match:
            return match[1], match[2]
    return None


def validate_members(value):
    from .protocol import digest32, fields, integer, need, token

    need(type(value) is list and len(value) <= 128)
    previous = ""
    principals = set()
    for member in value:
        fields(member, {"membershipId", "principalId", "status", "revision"})
        digest32(member["membershipId"])
        token(member["principalId"])
        integer(member["revision"])
        need(member["status"] == "active" and member["membershipId"] > previous)
        need(member["principalId"] not in principals)
        previous = member["membershipId"]
        principals.add(member["principalId"])


def resource_binding_route(method, target):
    """Only routes whose native adapter resolves immutable selected sources."""
    target = urlsplit(target).path
    if method == "PUT" and re.fullmatch(
        r"/api/admin/applications/[A-Za-z0-9._-]{1,128}/deployment", target
    ):
        return True
    if method == "GET" and target in {
        "/api/app-studio/context/sources",
        "/api/app-studio/files",
        "/api/app-studio/_client/launch/sources",
    }:
        return True
    if method == "POST" and target == "/api/app-studio/_client/launch/configure":
        return True
    if method == "PUT" and re.fullmatch(r"/api/app-studio/projects/[a-f0-9]{32}/context", target):
        return True
    if method == "POST" and re.fullmatch(
        r"/api/app-studio/runtime/[A-Za-z0-9_-]{1,128}/(?:invoke|files)", target
    ):
        return True
    if method == "POST" and re.fullmatch(
        r"/api/app-studio/_client/launch/[a-f0-9]{32}/(?:start|archive/[a-f0-9]{64})", target
    ):
        return True
    return (
        method == "POST"
        and re.fullmatch(
            r"/api/app-studio/(?:_builder/)?projects/[a-f0-9]{32}/(?:context/read|context/search|runtime|build|interview/turns|edits|edits/[a-f0-9]{32}/(?:answer|retry))",
            target,
        )
        is not None
    )


def resource_needs(grants):
    """Finite native-local files plus read-only, exact knowledge sources."""
    return all(
        (item["resourceId"] == "wanx" and set(item["actions"]) <= {"read", "write"})
        or (
            item["resourceId"] == "semantica"
            or (team_resource(item["resourceId"]) or (None,))[0] == "knowledge"
        )
        and item["actions"] == ["read"]
        for item in grants
    )


def merge_grants(left, right):
    values = {}
    for item in [*left, *right]:
        values.setdefault(item["resourceId"], set()).update(item["actions"])
    return [
        {"resourceId": resource, "actions": sorted(actions)}
        for resource, actions in sorted(values.items())
    ]


def resource_write_route(method, target):
    target = urlsplit(target).path
    return (
        (
            method == "POST"
            and (
                target == "/api/app-studio/_client/launch/configure"
                or re.fullmatch(
                    r"/api/app-studio/_client/launch/[a-f0-9]{32}/(?:start|archive/[a-f0-9]{64})",
                    target,
                )
                or re.fullmatch(
                    r"/api/app-studio/(?:_builder/)?projects/[a-f0-9]{32}/(?:build|edits|edits/[a-f0-9]{32}/(?:answer|retry))",
                    target,
                )
            )
        )
        or method == "PUT"
        and re.fullmatch(r"/api/app-studio/projects/[a-f0-9]{32}/context", target)
    )
