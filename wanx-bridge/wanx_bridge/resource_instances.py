"""Durable managed-instance identities; callers hold the device prepare.lock."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from .resource_cache import cache_io
from .resources import atomic, private_bytes
from .resources_contract import canonical, fail


def instance_identity(payload: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any] | None:
    if payload["kind"] == "skill-package":
        return {
            "kind": payload["kind"],
            "resourceId": payload["resourceId"],
            "version": payload["version"],
            "digest": payload["package"]["sha256"],
        }
    account_scope = payload["metadata"].get("expertInstanceScope") == "account"
    if not account_scope and "binding_set_id" not in scope:
        return None
    return {
        "kind": "expert",
        "resourceId": payload["resourceId"],
        **{
            key: scope[key] for key in ("device_id", "ownership_epoch", "sub", "user_id", "product")
        },
        # Candidate operations/artifacts may change while the same application's
        # private expert and its conversation history remain stable. Legacy
        # schema-1 per-application identities retain their original behavior.
        **({"application_id": scope["application_id"]} if not account_scope else {}),
    }


class ResourceInstances:
    def __init__(self, directory: Path) -> None:
        self.directory = directory / "instances"

    def path(self, identity: dict[str, Any]) -> Path:
        folder = "skills" if identity["kind"] == "skill-package" else "experts"
        path = self.directory / folder / (hashlib.sha256(canonical(identity)).hexdigest() + ".json")
        if self.directory.is_symlink() or path.parent.is_symlink() or path.is_symlink():
            raise fail("RESOURCE_LOCAL_STATE_INVALID", 503)
        return path

    async def read(self, identity: dict[str, Any]) -> dict[str, Any] | None:
        path = self.path(identity)
        if not path.exists():
            return None
        try:
            value = json.loads(await cache_io(private_bytes, path, 16 * 1024 * 1024))
            if (
                not isinstance(value, dict)
                or type(value.get("schemaVersion")) is not int
                or value.get("schemaVersion") != 1
                or value.get("identity") != identity
                or not isinstance(value.get("record"), dict)
                or value["record"].get("sharedIdentity") != identity
                or value["record"].get("status") not in {"preparing", "ready"}
                or not isinstance(value["record"].get("digest"), str)
                or re.fullmatch(r"[0-9a-f]{64}", value["record"]["digest"]) is None
                or not isinstance(value["record"].get("dependencyResources", {}), dict)
            ):
                raise ValueError()
            return value["record"]
        except (ValueError, UnicodeError, TypeError) as exc:
            raise fail("RESOURCE_LOCAL_STATE_INVALID", 503) from exc

    async def write(self, identity: dict[str, Any], record: dict[str, Any]) -> None:
        await cache_io(
            atomic,
            self.path(identity),
            canonical({"schemaVersion": 1, "identity": identity, "record": record}),
        )
