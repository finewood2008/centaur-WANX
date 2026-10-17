"""Keep controlled resource staging packages out of Octop's global package APIs.

Octop packages are instance-global, so its existing permission checks cannot
express a WANX account rollout. Controlled packages are internal staging only:
ResourceRuntime copies their files into a private expert through loopback APIs.
The public proxy must never expose, mount, mutate, or copy those global packages.
Stable shared packages permit reads and copying into a private agent, but no
mutation or mounts of the shared source. Ordinary and historical stable packages
keep their native behavior.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import quote

from .resources_contract import fail

CONTROLLED_MARKER = "wanx-resource:account:"
SHARED_MARKER = "wanx-resource:shared:"
MAX_BODY_BYTES = 4 * 1024 * 1024
_ROOT = "/api/skill-packages"
_MOUNTS = re.compile(r"/api/agents/[^/]+/skill-packages\Z")
_COPY = re.compile(r"/api/agents/[^/]+/skill-packages/([^/]+)/copy\Z")
_AGENT = re.compile(r"/api/agents/[^/]+\Z")
_INSTALL = re.compile(
    r"(?:/api/agents/from-expert/[^/]+|/api/experts/(?:published|hub)/[^/]+/install)\Z"
)
_PUSH = re.compile(r"/api/agents/[^/]+/skills/[^/]+/push-to-package\Z")
_ID_KEYS = {"package_id", "package_ids", "skill_package_ids"}


def _path(path: str) -> str:
    return path.rstrip("/")


def _controlled(row: Any) -> bool:
    if not isinstance(row, dict) or not isinstance(row.get("description"), str):
        raise fail("RESOURCE_UPSTREAM_RESPONSE_INVALID", 502)
    return row["description"].startswith(CONTROLLED_MARKER)


def _deny() -> None:
    raise fail("RESOURCE_MANAGED_PACKAGE_PRIVATE", 403)


class ManagedResourceGuard:
    def __init__(self, admin: Any) -> None:
        self.admin = admin

    @staticmethod
    def needs_body(method: str, path: str) -> bool:
        path = _path(path)
        return (
            method == "POST"
            and path in {_ROOT, "/api/agents"}
            or method == "PATCH"
            and bool(_AGENT.fullmatch(path))
            or method == "PUT"
            and bool(_MOUNTS.fullmatch(path))
            or method == "POST"
            and bool(_INSTALL.fullmatch(path) or _PUSH.fullmatch(path))
            # Prevent creation of a private marker on an ordinary package, too.
            or method == "PATCH"
            and path.startswith(_ROOT + "/")
            and path.count("/") == 3
        )

    @staticmethod
    def needs_response(method: str, path: str) -> bool:
        path = _path(path)
        return method == "GET" and (path == _ROOT or bool(_MOUNTS.fullmatch(path)))

    async def _package(self, package_id: str, *, access: str = "mount") -> None:
        if not isinstance(package_id, str) or not package_id or len(package_id) > 256:
            raise fail("RESOURCE_PACKAGE_REFERENCE_INVALID", 400)
        row = await self.admin.request("GET", _ROOT + "/" + quote(package_id, safe=""))
        if _controlled(row):
            _deny()
        if row["description"].startswith(SHARED_MARKER) and access not in {"read", "copy"}:
            raise fail("RESOURCE_MANAGED_PACKAGE_READ_ONLY", 403)

    async def inspect_request(self, method: str, path: str, body: bytes | None = None) -> None:
        path = _path(path)
        if path.startswith(_ROOT + "/"):
            package_id = path[len(_ROOT) + 1 :].split("/", 1)[0]
            # Fixed native routes are not package identifiers.
            if package_id not in {"hub", "from-skillhub"}:
                await self._package(
                    package_id, access="read" if method in {"GET", "HEAD"} else "write"
                )
        match = _COPY.fullmatch(path)
        if match:
            await self._package(match[1], access="copy" if method == "POST" else "write")
        if not self.needs_body(method, path):
            return
        if not isinstance(body, bytes) or len(body) > MAX_BODY_BYTES:
            raise fail("RESOURCE_REQUEST_INVALID", 413 if body else 400)
        try:
            value = json.loads(body)
        except (ValueError, UnicodeError, RecursionError) as exc:
            raise fail("RESOURCE_REQUEST_INVALID", 400) from exc
        if not isinstance(value, dict):
            raise fail("RESOURCE_REQUEST_INVALID", 400)
        if path == _ROOT or method == "PATCH" and path.startswith(_ROOT + "/"):
            if isinstance(value.get("description"), str) and value["description"].startswith(
                (CONTROLLED_MARKER, SHARED_MARKER)
            ):
                _deny()
        # Agent config is extensible; nested references must not bypass the
        # dedicated mount route. Inspect only known JSON mutation routes, never
        # workspace uploads, chat messages, or arbitrary customer documents.
        pending, package_ids, count = [value], set(), 0
        while pending:
            item = pending.pop()
            count += 1
            if count > 10000:
                raise fail("RESOURCE_REQUEST_INVALID", 400)
            if isinstance(item, list):
                pending.extend(item)
            elif isinstance(item, dict):
                for key, child in item.items():
                    if key in _ID_KEYS and child is not None:
                        references = child if isinstance(child, list) else [child]
                        for reference in references:
                            if (
                                not isinstance(reference, str)
                                or not reference
                                or len(reference) > 256
                            ):
                                raise fail("RESOURCE_PACKAGE_REFERENCE_INVALID", 400)
                            package_ids.add(reference)
                        if len(package_ids) > 256:
                            raise fail("RESOURCE_PACKAGE_REFERENCE_INVALID", 400)
                    pending.append(child)
        for package_id in sorted(package_ids):
            await self._package(package_id)

    async def filter_response(self, method: str, path: str, value: Any) -> Any:
        path = _path(path)
        if not self.needs_response(method, path):
            return value
        if path == _ROOT:
            if not isinstance(value, list):
                raise fail("RESOURCE_UPSTREAM_RESPONSE_INVALID", 502)
            return [row for row in value if not _controlled(row)]
        if not isinstance(value, dict) or not isinstance(value.get("packages"), list):
            raise fail("RESOURCE_UPSTREAM_RESPONSE_INVALID", 502)
        if not isinstance(value.get("package_ids"), list):
            raise fail("RESOURCE_UPSTREAM_RESPONSE_INVALID", 502)
        packages = [row for row in value["packages"] if not _controlled(row)]
        visible_ids = {row.get("id") for row in packages}
        return {
            **value,
            "packages": packages,
            "package_ids": [item for item in value["package_ids"] if item in visible_ids],
        }
