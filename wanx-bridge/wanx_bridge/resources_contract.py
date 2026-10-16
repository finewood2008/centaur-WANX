"""Independent signed WANX resource contract; never imports Octop internals."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import unicodedata
from pathlib import PurePosixPath
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .config import BridgeAuthError

MAX_PACKAGE = 24 * 1024 * 1024
_ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}\Z")
_VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
_RESERVED = re.compile(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?\Z")


def fail(code: str = "RESOURCE_CONTRACT_INVALID", status: int = 409) -> BridgeAuthError:
    return BridgeAuthError(code, status)


def canonical(value: Any) -> bytes:
    def check(item: Any) -> None:
        if item is None or isinstance(item, (str, bool)):
            return
        if type(item) is int and abs(item) <= 9007199254740991:
            return
        if isinstance(item, list):
            for child in item:
                check(child)
            return
        if isinstance(item, dict) and all(isinstance(k, str) for k in item):
            for child in item.values():
                check(child)
            return
        raise fail()

    check(value)
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode()


def fields(value: Any, keys: set[str]) -> None:
    if not isinstance(value, dict) or set(value) != keys:
        raise fail()


def identifier(value: Any) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise fail()
    return value


def version(value: Any) -> tuple[int, int, int]:
    if not isinstance(value, str) or not _VERSION.fullmatch(value):
        raise fail()
    result = tuple(int(part) for part in value.split("."))
    if any(part > 2147483647 for part in result):
        raise fail()
    return result


def dependencies(value: Any, kind: str, resource_id: str) -> None:
    if not isinstance(value, list) or len(value) > 64:
        raise fail()
    seen = set()
    for item in value:
        fields(item, {"kind", "resourceId", "minVersion"})
        identifier(item["resourceId"])
        version(item["minVersion"])
        key = (item["kind"], item["resourceId"])
        if (
            item["kind"] not in {"expert", "skill-package"}
            or key in seen
            or key == (kind, resource_id)
        ):
            raise fail()
        if kind == "skill-package" and item["kind"] == "expert":
            raise fail()
        seen.add(key)


def metadata(value: Any) -> None:
    if not isinstance(value, dict) or len(canonical(value)) > 65536:
        raise fail()


def resource_header(value: dict[str, Any]) -> None:
    if (
        type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != 1
        or value["kind"] not in {"expert", "skill-package"}
    ):
        raise fail()
    identifier(value["resourceId"])
    version(value["version"])
    if (
        not isinstance(value["name"], str)
        or not value["name"].strip()
        or len(value["name"]) > 200
        or not isinstance(value["description"], str)
        or len(value["description"]) > 20000
    ):
        raise fail()
    dependencies(value["dependencies"], value["kind"], value["resourceId"])
    metadata(value["metadata"])


def relative_path(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode()) > 512
        or value != unicodedata.normalize("NFC", value)
    ):
        raise fail()
    if (
        value.startswith("/")
        or "\\" in value
        or ":" in value
        or any(ord(c) < 32 or ord(c) == 127 for c in value)
    ):
        raise fail()
    parts = value.split("/")
    if any(p in {"", ".", ".."} or p.endswith((".", " ")) or _RESERVED.fullmatch(p) for p in parts):
        raise fail()
    return value


def validate_package(raw: bytes, payload: dict[str, Any]) -> dict[str, Any]:
    package = payload["package"]
    if len(raw) != package["sizeBytes"] or hashlib.sha256(raw).hexdigest() != package["sha256"]:
        raise fail("RESOURCE_PACKAGE_DIGEST_MISMATCH")
    try:
        value = json.loads(raw)
        fields(
            value,
            {
                "schemaVersion",
                "kind",
                "resourceId",
                "version",
                "name",
                "description",
                "dependencies",
                "metadata",
                "files",
            },
        )
        resource_header(value)
        if canonical(value) != raw:
            raise fail()
        if any(
            value[k] != payload[k]
            for k in (
                "schemaVersion",
                "kind",
                "resourceId",
                "version",
                "name",
                "description",
                "dependencies",
                "metadata",
            )
        ):
            raise fail("RESOURCE_PACKAGE_IDENTITY_MISMATCH")
        files = value["files"]
        if not isinstance(files, list) or not 1 <= len(files) <= 256:
            raise fail()
        seen: set[str] = set()
        total = 0
        for item in files:
            fields(item, {"path", "contentBase64"})
            path = relative_path(item["path"])
            folded = path.casefold()
            if folded in seen or any(
                folded.startswith(p + "/") or p.startswith(folded + "/") for p in seen
            ):
                raise fail()
            seen.add(folded)
            content = base64.b64decode(item["contentBase64"], validate=True)
            if (
                base64.b64encode(content).decode() != item["contentBase64"]
                or len(content) > 4 * 1024 * 1024
            ):
                raise fail()
            total += len(content)
        if total > 16 * 1024 * 1024:
            raise fail()
        return value
    except (TypeError, ValueError, KeyError, UnicodeError, RecursionError) as exc:
        raise fail() from exc


def verify_envelope(envelope: Any, trust: dict[str, Any]) -> dict[str, Any]:
    try:
        fields(envelope, {"payload", "signature"})
        payload, signature = envelope["payload"], envelope["signature"]
        fields(
            payload,
            {
                "schemaVersion",
                "purpose",
                "kind",
                "resourceId",
                "version",
                "name",
                "description",
                "dependencies",
                "metadata",
                "package",
                "publishedAt",
            },
        )
        resource_header(payload)
        if payload["purpose"] != "wanx.resource.v1" or not isinstance(payload["publishedAt"], str):
            raise fail()
        fields(payload["package"], {"format", "sha256", "sizeBytes"})
        p = payload["package"]
        if (
            p["format"] != "wanx-resource-json"
            or not isinstance(p["sha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", p["sha256"])
            or type(p["sizeBytes"]) is not int
            or not 0 < p["sizeBytes"] <= MAX_PACKAGE
        ):
            raise fail()
        fields(signature, {"algorithm", "keyId", "signatureBase64"})
        if signature["algorithm"] != "ed25519" or trust.get("schemaVersion") != 1:
            raise fail()
        pem = trust["keys"][signature["keyId"]]
        key = serialization.load_pem_public_key(pem.encode())
        if not isinstance(key, Ed25519PublicKey):
            raise fail()
        key.verify(
            base64.b64decode(signature["signatureBase64"], validate=True), canonical(payload)
        )
        return payload
    except (TypeError, ValueError, KeyError, InvalidSignature) as exc:
        raise fail("RESOURCE_SIGNATURE_INVALID") from exc


def expert_files(package: dict[str, Any]) -> dict[str, bytes]:
    result = {}
    for item in package["files"]:
        path = item["path"]
        # Only the bundle's public manifest has a system destination. Auth, sessions,
        # memory databases, symlink tricks and executable host paths are never imported.
        if any(
            part.startswith(".") for part in PurePosixPath(path).parts
        ) or path.casefold().startswith(("sessions/", "memory/")):
            raise fail("RESOURCE_EXPERT_PATH_FORBIDDEN")
        target = ".octop/manifest.json" if path == "manifest.json" else path
        result[target] = base64.b64decode(item["contentBase64"])
    try:
        manifest = json.loads(result[".octop/manifest.json"])
        if not isinstance(manifest, dict):
            raise ValueError()
    except (KeyError, ValueError, UnicodeError) as exc:
        raise fail("RESOURCE_EXPERT_MANIFEST_REQUIRED") from exc
    return result


def skill_files(package: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
    result: dict[str, list[dict[str, str]]] = {}
    for item in package["files"]:
        parts = item["path"].split("/", 2)
        if (
            len(parts) != 3
            or parts[0] != "skills"
            or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", parts[1])
        ):
            raise fail("RESOURCE_SKILL_LAYOUT_INVALID")
        result.setdefault(parts[1], []).append(
            {"path": parts[2], "content_base64": item["contentBase64"]}
        )
    for files in result.values():
        if not any(item["path"] == "SKILL.md" for item in files):
            raise fail("RESOURCE_SKILL_LAYOUT_INVALID")
    return result
