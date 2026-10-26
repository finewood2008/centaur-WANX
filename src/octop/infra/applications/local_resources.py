"""Private native resource preparation for a verified local principal.

No cloud account, product-login executor, downloaded code execution or admin
fallback is used. Persistent bindings are observations; every call first asks
the current parent operation to authorize the signed catalog's resource batch.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import re
import shutil
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from octop.infra.agents.manager import AgentCreateSpec
from octop.infra.applications.local_catalog import (
    LocalResourceCatalog,
    _atomic,
    json_value,
    read_regular,
)
from octop.infra.applications.local_contract import (
    canonical,
    expert_files,
    fail,
    fields,
    skill_files,
)

_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_SHA = re.compile(r"[a-f0-9]{64}\Z")
_CONTRACTS = [
    {"id": "wanx-bridge.readiness", "version": "1.0.0", "features": ["read-only"]},
    {"id": "wanx-local.resources", "version": "1.0.0", "features": ["read-only"]},
]
_budget_lock = threading.Lock()
_active_operations = 0


def _digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


class LocalApplicationResources:
    def __init__(self, *, services: Any, registry: Any, catalog: LocalResourceCatalog) -> None:
        self.services = services
        self.registry = registry
        self.catalog = catalog
        self.root = services.paths.root / "local-application-bindings"

    async def handle(
        self, operation: str, body: dict[str, Any], *, user: Any, context: Any
    ) -> dict[str, Any]:
        global _active_operations
        with _budget_lock:
            if _active_operations >= 4:
                raise fail("RESOURCE_PREPARATION_BUSY")
            _active_operations += 1
        try:
            return await self._handle(operation, body, user=user, context=context)
        finally:
            with _budget_lock:
                _active_operations -= 1

    async def _handle(
        self, operation: str, body: dict[str, Any], *, user: Any, context: Any
    ) -> dict[str, Any]:
        claims = context.claims
        if (
            not getattr(user, "local_data", False)
            or user.is_admin
            or claims["applicationId"] != "wanx-host"
        ):
            raise fail("LOCAL_DATA_SCOPE_DENIED", 403)
        candidate = operation == "candidate"
        readonly = operation == "readiness"
        if operation not in {"prepare", "candidate", "readiness"}:
            raise fail()
        required = {"schemaVersion", "applicationId", "artifactId"}
        if candidate:
            required.add("operationId")
        if readonly:
            required.add("compatibility")
            if body.get("schemaVersion") == 2:
                required.add("bindingSetId")
        fields(body, required)
        if (
            type(body["schemaVersion"]) is not int
            or body["schemaVersion"] != (2 if candidate else 1)
            and not (readonly and body["schemaVersion"] == 2)
            or not isinstance(body["applicationId"], str)
            or candidate
            and (not isinstance(body["operationId"], str) or not _ID.fullmatch(body["operationId"]))
            or readonly
            and body["schemaVersion"] == 2
            and not _SHA.fullmatch(str(body["bindingSetId"]))
        ):
            raise fail()
        await asyncio.to_thread(context.require_live)
        resolved = await asyncio.to_thread(
            self.catalog.resolve, body["applicationId"], body["artifactId"]
        )
        descriptor, payloads, packages = (
            resolved["descriptor"],
            resolved["payloads"],
            resolved["packages"],
        )
        if readonly and body["compatibility"] != descriptor["compatibility"]:
            raise fail("RESOURCE_ARTIFACT_MISMATCH")
        # This adapter supports only the signed WANX private resource product.
        # The broker rechecks its *current* grant; the host session's initial
        # read/write admission does not confer authority over these resources.
        actions = ["read"] if readonly else ["read", "write"]
        await context.authorize_resources([{"resourceId": "wanx", "actions": actions}])
        await asyncio.to_thread(context.require_live)
        scope = {
            "schemaVersion": 2,
            "authorization": "local-trust-v1",
            "boxKeyThumbprint": claims["boxKeyThumbprint"],
            "principalId": claims["principalId"],
            "deviceId": claims["boxId"],
            "ownershipEpoch": claims["ownershipEpoch"],
            "artifactId": descriptor["artifactId"],
        }
        principal_scope = {key: value for key, value in scope.items() if key != "artifactId"}
        namespace = _digest({"scope": principal_scope, "userId": user.id})
        operation_id = body.get("operationId", "default")
        payload_digest = _digest(payloads)
        binding_id = _digest(
            {"scope": scope, "payloadDigest": payload_digest, "operationId": operation_id}
        )
        if readonly and body["schemaVersion"] == 2:
            binding_id = body["bindingSetId"]
        directory = self.root / namespace
        if readonly and not directory.exists():
            raise fail("APPLICATION_RESOURCES_NOT_READY")
        async with _OperationLock(directory, context):
            state_path = directory / f"{binding_id}.json"
            record = await asyncio.to_thread(_read_record, state_path)
            if record is not None:
                if (
                    record.get("bindingScope") != scope
                    or record.get("userId") != user.id
                    or record.get("payloadDigest") != payload_digest
                    or record.get("bindingSetId") != binding_id
                ):
                    raise fail("RESOURCE_BINDING_DRIFT")
                operation_id = record["operationId"]
            elif readonly:
                raise fail("APPLICATION_RESOURCES_NOT_READY")
            else:
                record = {
                    "schemaVersion": 1,
                    "bindingScope": scope,
                    "userId": user.id,
                    "payloadDigest": payload_digest,
                    "bindingSetId": binding_id,
                    "operationId": operation_id,
                    "bindings": [],
                }
            bindings = []
            for payload in payloads:
                await asyncio.to_thread(context.require_live)
                package = packages[(payload["kind"], payload["resourceId"])]
                # Artifact binding sets stay immutable, while unchanged signed
                # resources survive frontend releases. The published legacy
                # name "account" means this *local principal*, never a cloud
                # account or a global shared expert.
                marker = _digest(
                    {
                        "scope": principal_scope,
                        "userId": user.id,
                        "applicationId": None
                        if payload["metadata"].get("expertInstanceScope") == "account"
                        else descriptor["applicationId"],
                        "resource": payload,
                    }
                )
                if payload["kind"] == "skill-package":
                    binding = await asyncio.to_thread(
                        self._skill, package, marker, user.id, context, readonly
                    )
                else:
                    wanted = expert_files(package)
                    # Dependency skills are copied into this private expert,
                    # never attached from another user's global package.
                    for dependency in payload["dependencies"]:
                        if dependency["kind"] != "skill-package":
                            continue
                        for item in packages[(dependency["kind"], dependency["resourceId"])][
                            "files"
                        ]:
                            content = base64.b64decode(item["contentBase64"])
                            if item["path"] in wanted and wanted[item["path"]] != content:
                                raise fail("RESOURCE_SKILL_PATH_CONFLICT")
                            wanted[item["path"]] = content
                    binding = await self._expert(
                        package, wanted, marker, user.id, context, readonly
                    )
                bindings.append(
                    {
                        "kind": payload["kind"],
                        "resourceId": payload["resourceId"],
                        "version": payload["version"],
                        **binding,
                    }
                )
            if record["bindings"] and record["bindings"] != bindings:
                raise fail("RESOURCE_BINDING_DRIFT")
            if not readonly:
                record["bindings"] = bindings
                await asyncio.to_thread(_write_record, state_path, record, context)
            await asyncio.to_thread(context.require_live)
        return {
            "schemaVersion": body["schemaVersion"],
            "applicationId": descriptor["applicationId"],
            "artifactId": descriptor["artifactId"],
            "deviceId": claims["boxId"],
            "backendProductId": "wanx",
            "productId": "wanx",
            "status": "ready",
            "observedAt": datetime.now(UTC).isoformat(),
            "readOnly": readonly,
            "authorization": {"status": "ready"},
            "contracts": _CONTRACTS,
            "resources": [
                {
                    "kind": p["kind"],
                    "resourceId": p["resourceId"],
                    "version": p["version"],
                    "status": "ready",
                }
                for p in payloads
            ],
            "bindings": bindings,
            "bindingScope": scope,
            "bindingSetId": binding_id,
            "operationId": operation_id,
            "checks": [],
        }

    def _skill(
        self, package: dict[str, Any], marker: str, uid: int, context: Any, readonly: bool
    ) -> dict[str, str]:
        package_id = "lr" + marker[:24]
        root = self.services.paths.skill_packages_dir
        destination = root / package_id
        wanted = {
            item["path"]: base64.b64decode(item["contentBase64"]) for item in package["files"]
        }
        row = self.services.skill_package_repo.get(package_id)
        expected_name = f"{package['name'][:150]} · {marker[:16]}"
        if row is not None and (row.created_by != str(uid) or row.name != expected_name):
            raise fail("RESOURCE_INSTANCE_OWNERSHIP_CHANGED", 403)
        if row is None or not destination.exists():
            if readonly:
                raise fail("APPLICATION_RESOURCES_NOT_READY")
            context.require_live()
            root.mkdir(parents=True, exist_ok=True)
            temporary = Path(tempfile.mkdtemp(prefix=".local-resource-", dir=root))
            try:
                for relative, content in wanted.items():
                    context.require_live()
                    target = temporary / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content)
                context.require_live()
                if destination.exists() or destination.is_symlink():
                    raise fail("RESOURCE_INSTANCE_CONFLICT")
                if row is None:
                    self.services.skill_package_repo.create(
                        id=package_id,
                        name=expected_name,
                        description=package["description"],
                        created_by=str(uid),
                    )
                context.require_live()
                os.rename(temporary, destination)
                context.require_live()
                self.services.skill_package_repo.update_skill_count(
                    package_id, len(skill_files(package))
                )
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
            row = self.services.skill_package_repo.get(package_id)
        if (
            row is None
            or row.created_by != str(uid)
            or row.name != f"{package['name'][:150]} · {marker[:16]}"
        ):
            raise fail("RESOURCE_INSTANCE_OWNERSHIP_CHANGED", 403)
        for relative, content in wanted.items():
            context.require_live()
            if read_regular(destination / relative, 4 * 1024**2) != content:
                raise fail("RESOURCE_USER_MODIFIED")
        # A package with extra files is no longer the installed signed version.
        actual = {
            p.relative_to(destination).as_posix() for p in destination.rglob("*") if p.is_file()
        }
        if actual != set(wanted):
            raise fail("RESOURCE_USER_MODIFIED")
        context.require_live()
        return {"packageId": package_id}

    async def _expert(
        self,
        package: dict[str, Any],
        wanted: dict[str, bytes],
        marker: str,
        uid: int,
        context: Any,
        readonly: bool,
    ) -> dict[str, str]:
        instance_id = "lr" + marker[:24]
        row = self.registry.get_row(instance_id)
        if row is None:
            if readonly:
                raise fail("APPLICATION_RESOURCES_NOT_READY")
            spec = AgentCreateSpec(
                agent_id=instance_id,
                user_id=uid,
                name=f"{package['name'][:150]} · {marker[:16]}",
                description=package["description"],
                is_shared=False,
                config={
                    "backend": {"type": "filesystem", "virtual_mode": True},
                    "local_resource_instance": marker,
                },
                skill_package_ids=[],
                knowledge_base_ids=[],
                mcp_servers=[],
            )

            async def initialize(created: Any, workspace: Any) -> None:
                for relative, content in wanted.items():
                    await asyncio.to_thread(context.require_live)
                    await workspace.aupload_bytes(relative, content)
                    await asyncio.to_thread(context.require_live)

            row = await self.registry.create(
                spec, workspace_initializer=initialize, before_side_effect=context.require_live
            )
        config = self.registry.get_config(instance_id)
        if (
            row.user_id != uid
            or row.is_shared
            or row.application_id != "wanx"
            or config.get("local_resource_instance") != marker
            or config.get("skill_package_ids")
            or config.get("knowledge_base_ids")
            or config.get("mcp_servers")
        ):
            raise fail("RESOURCE_INSTANCE_OWNERSHIP_CHANGED", 403)
        workspace = self.registry.workspace_for_agent(instance_id)
        if workspace is None:
            raise fail("APPLICATION_RESOURCES_NOT_READY")
        for relative, content in wanted.items():
            await asyncio.to_thread(context.require_live)
            if await workspace.adownload_bytes(relative) != content:
                raise fail("RESOURCE_USER_MODIFIED")
        await asyncio.to_thread(context.require_live)
        return {"instanceId": instance_id}


def _read_record(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    value = json_value(read_regular(path, 1024**2))
    fields(
        value,
        {
            "schemaVersion",
            "bindingScope",
            "userId",
            "payloadDigest",
            "bindingSetId",
            "operationId",
            "bindings",
        },
    )
    if value["schemaVersion"] != 1 or not isinstance(value["bindings"], list):
        raise fail("RESOURCE_BINDING_DRIFT")
    return cast(dict[str, Any], value)


def _write_record(path: Path, value: dict[str, Any], context: Any) -> None:
    context.require_live()
    _atomic(path, canonical(value), before_commit=context.require_live)


class _OperationLock:
    """Cross-worker lock, bounded and cancellation-aware while waiting."""

    def __init__(self, directory: Path, context: Any) -> None:
        self.directory = directory
        self.context = context
        self.fd: int | None = None

    async def __aenter__(self) -> None:
        if os.name != "posix":
            raise fail("RESOURCE_CATALOG_PLATFORM_UNSUPPORTED")
        import fcntl

        def open_lock() -> int:
            self.context.require_live()
            for parent in (self.directory, *self.directory.parents):
                if parent.is_symlink():
                    raise fail("RESOURCE_CATALOG_UNSAFE")
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            return os.open(self.directory / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)

        self.fd = await asyncio.to_thread(open_lock)
        deadline = asyncio.get_running_loop().time() + 10
        try:
            while True:
                await asyncio.to_thread(self.context.require_live)
                try:
                    fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return
                except BlockingIOError:
                    if asyncio.get_running_loop().time() >= deadline:
                        raise fail("RESOURCE_PREPARATION_BUSY", 409) from None
                    await asyncio.sleep(0.02)
        except BaseException:
            os.close(self.fd)
            self.fd = None
            raise

    async def __aexit__(self, *_: Any) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
