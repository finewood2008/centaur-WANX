"""Evidence owned by the running Bridge, never inferred from an Octop checkout."""

from __future__ import annotations

import hashlib
import os
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from cryptography.hazmat.primitives import serialization

BRIDGE_CONTRACTS = (
    {"id": "wanx-bridge.version", "version": "1.0.0", "features": ["read-only"]},
    {"id": "wanx-bridge.readiness", "version": "1.0.0", "features": ["read-only"]},
)


def bridge_build_metadata() -> dict[str, Any]:
    try:
        installed_version = version("wanx-bridge")
    except PackageNotFoundError:
        installed_version = None
    # These optional fields are stamped by this process's release configuration.
    # Missing build identity is unknown, not the current catalog's target version.
    return {
        "version": installed_version,
        "buildId": os.getenv("WANX_BRIDGE_BUILD_ID") or None,
        "sourceRevision": os.getenv("WANX_BRIDGE_SOURCE_REVISION") or None,
        "source": "running-bridge-package",
    }


def version_snapshot(config: Any, metadata: dict[str, Any]) -> dict[str, Any]:
    key = getattr(config, "box_key", None)
    fingerprint = (
        hashlib.sha256(
            key.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw
            )
        ).hexdigest()
        if key is not None
        else None
    )
    return {
        "schemaVersion": 1,
        "deviceId": getattr(config, "device_id", None),
        "deviceKeyFingerprint": fingerprint,
        "observedAt": datetime.now(UTC).isoformat(),
        "bridge": dict(metadata),
        "contracts": [dict(item, features=list(item["features"])) for item in BRIDGE_CONTRACTS],
        "upstream": {
            "status": "unknown",
            "version": None,
            "code": "PUBLIC_VERSION_EVIDENCE_UNAVAILABLE",
        },
        "expertMigration": {"status": "blocked", "code": "EXPERT_MIGRATION_UNSUPPORTED"},
    }
