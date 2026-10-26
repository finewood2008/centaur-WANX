"""Verified, offline resource catalog; the CLI never executes package content.

Release/deployment tools install existing signed application descriptors and
resource envelopes. The running service only reads this root-owned, read-only
mount. An application descriptor is evidence of dependencies, never authority
to create resources for a local principal.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import os
import re
import stat
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any, cast

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from octop.infra.applications.local_contract import (
    MAX_PACKAGE,
    canonical,
    dependencies,
    expert_files,
    fail,
    fields,
    skill_files,
    validate_package,
    verify_envelope,
    version,
)

DEFAULT_CATALOG = "/run/centuarai-local-resource-catalog"
DEFAULT_TRUST = "/etc/centuarai/local-trust/resource-trust.json"
_UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z")
_APP = re.compile(r"[a-z][a-z0-9._-]{1,63}\Z")
_HEX = re.compile(r"[a-f0-9]{64}\Z")


def read_regular(path: Path, limit: int) -> bytes:
    """Bounded no-follow reads, including every directory below the configured root."""
    try:
        for parent in (path, *path.parents):
            if parent.is_symlink():
                raise fail("RESOURCE_CATALOG_UNSAFE")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
                raise fail("RESOURCE_CATALOG_UNSAFE")
            data = stream.read(limit + 1)
            if len(data) > limit:
                raise fail("RESOURCE_CATALOG_UNSAFE")
            return data
    except FileNotFoundError as exc:
        raise fail("RESOURCE_CATALOG_UNAVAILABLE", 503) from exc


def json_value(raw: bytes) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise fail()
            result[key] = value
        return result

    try:
        return json.loads(raw, object_pairs_hook=pairs)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise fail() from exc


def _base64(value: Any, limit: int) -> bytes:
    try:
        if not isinstance(value, str) or len(value) > limit * 2:
            raise ValueError()
        raw = base64.b64decode(value, validate=True)
        if len(raw) > limit or base64.b64encode(raw).decode() != value:
            raise ValueError()
        return raw
    except ValueError as exc:
        raise fail("RESOURCE_SIGNATURE_INVALID") from exc


def load_trust(path: Path) -> dict[str, Any]:
    trust = json_value(read_regular(path, 128 * 1024))
    fields(trust, {"schemaVersion", "applicationKeys", "resourceKeys"})
    if type(trust["schemaVersion"]) is not int or trust["schemaVersion"] != 1:
        raise fail()
    for purpose in ("applicationKeys", "resourceKeys"):
        keys = trust[purpose]
        if not isinstance(keys, dict) or not keys or len(keys) > 64:
            raise fail()
        for key_id, pem in keys.items():
            if not isinstance(key_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", key_id):
                raise fail()
            try:
                key = serialization.load_pem_public_key(pem.encode())
                if not isinstance(key, Ed25519PublicKey):
                    raise ValueError()
            except (ValueError, TypeError, AttributeError) as exc:
                raise fail("RESOURCE_SIGNATURE_INVALID") from exc
    return cast(dict[str, Any], trust)


def verify_application(envelope: Any, trust: dict[str, Any]) -> dict[str, Any]:
    """Accept the existing v3 signed descriptor, never caller compatibility claims."""
    fields(envelope, {"keyId", "descriptorBase64", "signatureBase64"})
    raw = _base64(envelope["descriptorBase64"], 75_000)
    signature = _base64(envelope["signatureBase64"], 64)
    try:
        pem = trust["applicationKeys"][envelope["keyId"]]
        key = serialization.load_pem_public_key(pem.encode())
        if not isinstance(key, Ed25519PublicKey) or len(signature) != 64:
            raise ValueError()
        key.verify(signature, raw)
    except (KeyError, TypeError, ValueError, InvalidSignature) as exc:
        raise fail("RESOURCE_SIGNATURE_INVALID") from exc
    value = json_value(raw)
    required = {
        "schemaVersion",
        "artifactId",
        "applicationId",
        "version",
        "os",
        "arch",
        "packageType",
        "hostProtocol",
        "fileName",
        "sha256",
        "size",
        "minWanxVersion",
        "manifest",
        "compatibility",
    }
    if (
        not isinstance(value, dict)
        or not required <= value.keys()
        or set(value) - required - {"buildId", "critical"}
    ):
        raise fail()
    if (
        type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != 3
        or value["hostProtocol"] != 1
        or value["packageType"] != "wanxapp"
        or not isinstance(value["artifactId"], str)
        or not _UUID.fullmatch(value["artifactId"])
        or not isinstance(value["applicationId"], str)
        or not _APP.fullmatch(value["applicationId"])
        or not isinstance(value["sha256"], str)
        or not _HEX.fullmatch(value["sha256"])
        or type(value["size"]) is not int
        or not 0 < value["size"] <= 1024**3
        or value.get("critical", []) != []
    ):
        raise fail("APPLICATION_CONTRACT_UNSUPPORTED")
    # Release versions use the stable resource-version subset for this offline
    # adapter. Prerelease/unknown protocols require a newer deployed adapter.
    version(value["version"])
    version(value["minWanxVersion"])
    manifest = value["manifest"]
    if (
        not isinstance(manifest, dict)
        or manifest.get("protocolVersion") != 3
        or manifest.get("applicationId") != value["applicationId"]
        or manifest.get("version") != value["version"]
        or manifest.get("runtime") != "electron"
        or manifest.get("launchMode") != "shared"
        or manifest.get("compatibility") != value["compatibility"]
        or manifest.get("critical", []) != []
    ):
        raise fail("APPLICATION_CONTRACT_UNSUPPORTED")
    if "releaseAccess" in manifest:
        raise fail("RESOURCE_ONLINE_LICENSE_REQUIRED", 403)
    compatibility = value["compatibility"]
    fields(
        compatibility,
        {
            "backendProductId",
            "clientRange",
            "hostProtocolRange",
            "backendContracts",
            "resourceDependencies",
            "localDataSchema",
        },
    )
    # Do not turn a WANX principal into a legacy product profile/cloud grant.
    if compatibility["backendProductId"] != "wanx":
        raise fail("RESOURCE_PRODUCT_PROFILE_UNSUPPORTED")
    dependencies(compatibility["resourceDependencies"], "application", "")
    if (
        not isinstance(compatibility["backendContracts"], list)
        or len(compatibility["backendContracts"]) > 32
    ):
        raise fail()
    for contract in compatibility["backendContracts"]:
        fields(contract, {"id", "range", "features"})
        if (
            contract["id"] not in {"wanx-bridge.readiness", "wanx-local.resources"}
            or not isinstance(contract["range"], str)
            or contract["features"] != ["read-only"]
        ):
            raise fail("BACKEND_CONTRACT_INCOMPATIBLE")
    return value


def verify_resources(
    items: Any, descriptor: dict[str, Any], trust: dict[str, Any]
) -> list[dict[str, Any]]:
    if not isinstance(items, list) or len(items) > 256:
        raise fail()
    resources: dict[tuple[str, str], dict[str, Any]] = {}
    for item in items:
        payload = verify_envelope(item, {"schemaVersion": 1, "keys": trust["resourceKeys"]})
        if "releaseAccess" in payload:
            raise fail("RESOURCE_ONLINE_LICENSE_REQUIRED", 403)
        key = (payload["kind"], payload["resourceId"])
        if key in resources:
            raise fail()
        resources[key] = payload
    visited: set[tuple[str, str]] = set()
    pending: set[tuple[str, str]] = set()
    ordered: list[dict[str, Any]] = []

    def visit(requirement: dict[str, Any]) -> None:
        key = (requirement["kind"], requirement["resourceId"])
        payload = resources.get(key)
        if payload is None or version(payload["version"]) < version(requirement["minVersion"]):
            raise fail("RESOURCE_DEPENDENCY_UNAVAILABLE")
        if key in pending:
            raise fail("RESOURCE_DEPENDENCY_CYCLE")
        if key in visited:
            return
        pending.add(key)
        for dependency in payload["dependencies"]:
            visit(dependency)
        pending.remove(key)
        visited.add(key)
        ordered.append(payload)

    for requirement in descriptor["compatibility"]["resourceDependencies"]:
        visit(requirement)
    if visited != set(resources):
        raise fail("RESOURCE_DEPENDENCY_UNEXPECTED")
    return ordered


class LocalResourceCatalog:
    def __init__(self, root: Path, trust_path: Path) -> None:
        self.root = root
        self.trust_path = trust_path

    @classmethod
    def from_environment(cls) -> LocalResourceCatalog:
        return cls(
            Path(os.getenv("OCTOP_LOCAL_RESOURCE_CATALOG", DEFAULT_CATALOG)),
            Path(os.getenv("OCTOP_LOCAL_RESOURCE_TRUST", DEFAULT_TRUST)),
        )

    def resolve(self, application_id: str, artifact_id: str) -> dict[str, Any]:
        if not isinstance(artifact_id, str) or not _UUID.fullmatch(artifact_id):
            raise fail("APPLICATION_RESOURCE_ARTIFACT_REQUIRED")
        trust = load_trust(self.trust_path)
        record = json_value(
            read_regular(self.root / "artifacts" / f"{artifact_id}.json", 4 * 1024**2)
        )
        fields(record, {"schemaVersion", "applicationEnvelope", "resources"})
        if type(record["schemaVersion"]) is not int or record["schemaVersion"] != 1:
            raise fail()
        descriptor = verify_application(record["applicationEnvelope"], trust)
        if descriptor["artifactId"] != artifact_id or descriptor["applicationId"] != application_id:
            raise fail("RESOURCE_ARTIFACT_MISMATCH")
        payloads = verify_resources(record["resources"], descriptor, trust)
        if sum(payload["package"]["sizeBytes"] for payload in payloads) > 64 * 1024**2:
            raise fail("RESOURCE_CATALOG_TOO_LARGE")
        packages = {}
        for payload in payloads:
            digest = payload["package"]["sha256"]
            package = validate_package(
                read_regular(self.root / "packages" / f"{digest}.json", MAX_PACKAGE), payload
            )
            if payload["kind"] == "expert":
                expert_files(package)
            else:
                skill_files(package)
            packages[(payload["kind"], payload["resourceId"])] = package
        return {"descriptor": descriptor, "payloads": payloads, "packages": packages}


def _atomic(path: Path, data: bytes, *, before_commit: Any = None) -> None:
    fd, temporary = tempfile.mkstemp(prefix=".catalog-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), 0o644)
        if before_commit is not None:
            before_commit()
        os.replace(temporary, path)
        if os.name == "posix":
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextlib.contextmanager
def _install_lock(root: Path) -> Iterator[None]:
    # The deployment CLI is a host POSIX operation. Runtime remains read-only.
    if os.name != "posix":
        raise fail("RESOURCE_CATALOG_PLATFORM_UNSUPPORTED")
    import fcntl

    root.mkdir(parents=True, exist_ok=True, mode=0o755)
    for path in (root, *root.parents):
        if path.is_symlink():
            raise fail("RESOURCE_CATALOG_UNSAFE")
    fd = os.open(root / ".install.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode) or os.fstat(fd).st_nlink != 1:
            raise fail("RESOURCE_CATALOG_UNSAFE")
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def install_catalog(
    *, root: Path, trust_path: Path, application_envelope: Path, resources: list[tuple[Path, Path]]
) -> dict[str, Any]:
    if len(resources) > 256:
        raise fail("RESOURCE_CATALOG_TOO_LARGE")
    trust = load_trust(trust_path)
    envelope = json_value(read_regular(application_envelope, 128 * 1024))
    descriptor = verify_application(envelope, trust)
    envelopes, raw_packages = [], {}
    total = 0
    for envelope_path, package_path in resources:
        resource = json_value(read_regular(envelope_path, 128 * 1024))
        payload = verify_envelope(resource, {"schemaVersion": 1, "keys": trust["resourceKeys"]})
        if package_path.is_dir():
            package_path = package_path / "package.json"
        raw = read_regular(package_path, MAX_PACKAGE)
        total += len(raw)
        if total > 64 * 1024**2:
            raise fail("RESOURCE_CATALOG_TOO_LARGE")
        package = validate_package(raw, payload)
        (expert_files if payload["kind"] == "expert" else skill_files)(package)
        envelopes.append(resource)
        raw_packages[payload["package"]["sha256"]] = raw
    payloads = verify_resources(envelopes, descriptor, trust)
    record = {"schemaVersion": 1, "applicationEnvelope": envelope, "resources": envelopes}
    with _install_lock(root):
        for subdir in ("artifacts", "packages"):
            path = root / subdir
            if path.is_symlink():
                raise fail("RESOURCE_CATALOG_UNSAFE")
            path.mkdir(exist_ok=True, mode=0o755)
        target = root / "artifacts" / f"{descriptor['artifactId']}.json"
        if target.exists():
            previous = json_value(read_regular(target, 4 * 1024**2))
            if previous["applicationEnvelope"] != envelope:
                raise fail("RESOURCE_ARTIFACT_IMMUTABLE")
            old_payloads = verify_resources(previous["resources"], descriptor, trust)
            old = {(p["kind"], p["resourceId"]): p for p in old_payloads}
            for payload in payloads:
                prior = old.get((payload["kind"], payload["resourceId"]))
                if prior and (
                    version(payload["version"]) < version(prior["version"])
                    or payload["version"] == prior["version"]
                    and payload != prior
                ):
                    raise fail("RESOURCE_VERSION_ROLLBACK")
        for digest, raw in raw_packages.items():
            target_package = root / "packages" / f"{digest}.json"
            if target_package.exists():
                if read_regular(target_package, MAX_PACKAGE) != raw:
                    raise fail("RESOURCE_PACKAGE_DIGEST_MISMATCH")
            else:
                _atomic(target_package, raw)
        _atomic(target, canonical(record))
    return {
        "artifactId": descriptor["artifactId"],
        "applicationId": descriptor["applicationId"],
        "resourceCount": len(payloads),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser(
        "install", help="Verify and atomically install an offline resource catalog entry"
    )
    install.add_argument("--catalog", type=Path, required=True)
    install.add_argument("--trust", type=Path, required=True)
    install.add_argument("--application-envelope", type=Path, required=True)
    install.add_argument(
        "--resource",
        nargs=2,
        type=Path,
        action="append",
        default=[],
        metavar=("ENVELOPE", "PACKAGE"),
    )
    args = parser.parse_args(argv)
    result = install_catalog(
        root=args.catalog,
        trust_path=args.trust,
        application_envelope=args.application_envelope,
        resources=args.resource,
    )
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
