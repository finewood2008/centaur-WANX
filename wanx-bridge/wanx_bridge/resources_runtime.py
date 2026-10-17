"""Managed private resources via public Octop APIs; durable intents, no Octop DB access."""

from __future__ import annotations

import asyncio
import base64
import copy
import fcntl
import hashlib
import json
import os
import secrets
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode
from uuid import UUID

import httpx

from .admin_client import AdminClient, BridgeUpstreamError
from .config import BridgeAuthError
from .managed_resource_guard import CONTROLLED_MARKER, SHARED_MARKER
from .resource_cache import cache_io
from .resource_instances import ResourceInstances, instance_identity
from .resources import ResourceCatalog, atomic, private_bytes
from .resources_contract import (
    canonical,
    expert_files,
    fail,
    fields,
    skill_files,
    version,
)


def _json(response: Any, statuses: set[int] = frozenset({200, 201})) -> Any:
    if response.status_code not in statuses:
        raise fail(
            "RESOURCE_UPSTREAM_PERMISSION_DENIED"
            if response.status_code in {401, 403}
            else "RESOURCE_UPSTREAM_OPERATION_FAILED",
            403 if response.status_code in {401, 403} else 502,
        )
    try:
        return response.json()
    except ValueError as exc:
        raise fail("RESOURCE_UPSTREAM_RESPONSE_INVALID", 502) from exc


def _digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def _owned(row: Any, user_id: int, product: str, nonce: str) -> bool:
    return (
        isinstance(row, dict)
        and row.get("user_id") == user_id
        and row.get("application_id", "wanx") == product
        and row.get("is_shared") is False
        and row.get("kind", "expert") == "expert"
        and row.get("config", {}).get("wanx_resource_instance") == nonce
    )


class ResourceRuntime:
    def __init__(self, catalog: ResourceCatalog, admin: AdminClient) -> None:
        self.catalog = catalog
        self.admin = admin
        self.lock = asyncio.Lock()

    async def close(self) -> None:
        await self.catalog.close()
        await self.admin.close()

    async def inspect(
        self,
        body: dict[str, Any],
        session: Any,
        context: dict[str, Any],
        request: Any,
        assert_live: Any,
    ) -> dict[str, Any]:
        return await self.prepare(body, session, context, request, assert_live, read_only=True)

    async def prepare(
        self,
        body: dict[str, Any],
        session: Any,
        context: dict[str, Any],
        request: Any,
        assert_live: Any,
        *,
        read_only: bool = False,
    ) -> dict[str, Any]:
        fields(body, {"schemaVersion", "applicationId", "artifactId"})
        if body["schemaVersion"] != 1 or type(body["schemaVersion"]) is not int:
            raise fail()
        application_id, artifact_id = body["applicationId"], body["artifactId"]
        # Application IDs are package reverse-domain names; immutable artifact IDs
        # may be UUIDs/digests and are never used as filesystem paths.
        if (
            not isinstance(application_id, str)
            or not 1 <= len(application_id) <= 200
            or not isinstance(artifact_id, str)
            or not 1 <= len(artifact_id) <= 256
        ):
            raise fail()
        user = session["user"] if isinstance(session, dict) else session.user
        result = {
            "schemaVersion": 1,
            "applicationId": application_id,
            "artifactId": artifact_id,
            "deviceId": self.catalog.config.device_id,
            "observedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "status": "blocked",
            "resources": [],
            "bindings": [],
            "authorization": {"status": "unknown"},
            "readOnly": read_only,
        }
        await assert_live()
        if (
            context.get("device_id") != self.catalog.config.device_id
            or type(context.get("ownership_epoch")) is not int
            or not isinstance(context.get("sub"), str)
        ):
            raise fail("RESOURCE_AUTHORITY_INVALID", 403)
        me = _json(await request("GET", "/api/auth/me"))
        if not isinstance(me, dict) or type(me.get("id")) is not int or me["id"] != user.get("id"):
            raise fail("BOX_UPSTREAM_IDENTITY_MISMATCH", 502)
        # Consumer grants normally carry a canonical UUID. Keep old formal
        # leases whose subject predates that convention functional, but never
        # treat such a subject (or renderer input) as a gray-release account.
        account_id = None
        try:
            if str(UUID(context["sub"])) == context["sub"]:
                account_id = context["sub"]
        except ValueError:
            pass
        resolution_path = (
            self.catalog.directory
            / "resolutions"
            / (_digest([application_id, artifact_id, context["sub"]]) + ".json")
        )
        try:
            resolution = await self.catalog.resolve(
                application_id,
                artifact_id,
                **({"account_id": account_id} if account_id is not None else {}),
            )
        except BridgeAuthError as exc:
            if exc.status != 503:
                raise
            # New caches are account-scoped. The legacy shared cache can only
            # contain a formal release: gray artifacts are immutable new IDs,
            # and an old Bridge rejects the newly added releaseAccess field.
            legacy_path = (
                self.catalog.directory
                / "resolutions"
                / (_digest([application_id, artifact_id]) + ".json")
            )
            cached_path = resolution_path if resolution_path.exists() else legacy_path
            if not cached_path.exists():
                raise
            resolution = json.loads(private_bytes(cached_path, 4 * 1024 * 1024))
            if "releaseAccess" in resolution:
                # Cached resource bytes prove integrity, never an online account
                # permit. A promoted controlled artifact remains online-only.
                raise fail("RESOURCE_ONLINE_ACCESS_REQUIRED", 503) from exc
            for envelope in resolution["resources"]:
                if self.catalog.verify(envelope).get("releaseAccess") == "account":
                    raise fail("RESOURCE_ONLINE_ACCESS_REQUIRED", 503) from exc
        if "releaseAccess" in resolution:
            if resolution["releaseAccess"] != "account":
                raise fail("RESOURCE_RESPONSE_INVALID", 502)
            if account_id is None:
                raise fail("RESOURCE_ACCOUNT_IDENTITY_INVALID", 403)
            result["releaseAccess"] = "account"
        await assert_live()
        product = resolution["backendProductId"]
        result["backendProductId"] = product
        if product != me.get("application_id", "wanx"):
            result["authorization"] = {"status": "blocked", "code": "APP_ENTITLEMENT_REQUIRED"}
            return result
        result["authorization"] = {"status": "ready"}
        if product != "wanx" and resolution["resources"]:
            result["code"] = "RESOURCE_PRODUCT_PROFILE_UNSUPPORTED"
            return result
        scope = {
            **context,
            "user_id": me["id"],
            "application_id": application_id,
            "product": product,
        }
        scope_id = _digest(scope)
        path = self.catalog.directory / "bindings" / (scope_id + ".json")
        async with self.lock:
            lock_path = self.catalog.directory / "prepare.lock"
            fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as exc:
                    raise fail("RESOURCE_PREPARATION_BUSY", 409) from exc
                ledger = (
                    json.loads(private_bytes(path, 16 * 1024 * 1024))
                    if path.exists()
                    else {"schemaVersion": 1, "scope": scope, "resources": {}}
                )
                if ledger.get("scope") != scope or not isinstance(ledger.get("resources"), dict):
                    raise fail("RESOURCE_LOCAL_STATE_INVALID", 503)

                active_resources = copy.deepcopy(ledger["resources"])
                publish_bindings = False
                authorized_resources: set[str] = set()

                async def authorize_resource(envelope: dict[str, Any]) -> None:
                    payload = self.catalog.verify(envelope)
                    if payload.get("releaseAccess") != "account":
                        return
                    identity = _digest(envelope)
                    if identity not in authorized_resources:
                        await assert_live()
                        await self.catalog.authorize(envelope, account_id=account_id)
                        await assert_live()
                        authorized_resources.add(identity)
                    result["releaseAccess"] = "account"

                async def save() -> None:
                    await assert_live()
                    if not read_only:
                        durable = dict(ledger)
                        # Persist intents/candidates immediately, but publish the
                        # complete application binding set with one atomic replace.
                        # A crash between skill and expert preparation cannot expose
                        # a new global version alongside an old private copy.
                        if not publish_bindings:
                            durable["resources"] = active_resources
                        await cache_io(atomic, path, canonical(durable))

                async def remember_resolution() -> None:
                    await assert_live()
                    if not read_only:
                        await cache_io(
                            atomic,
                            resolution_path,
                            canonical(resolution),
                        )

                requirements = resolution["requirements"]
                try:
                    current = await self._current(
                        ledger,
                        requirements,
                        me["id"],
                        product,
                        request,
                        assert_live,
                        authorize_resource,
                    )
                except BridgeAuthError as exc:
                    if exc.code != "RESOURCE_NOT_PREPARED":
                        result["code"] = exc.code
                        return result
                else:
                    result.update(current)
                    latest = {
                        item["payload"]["kind"] + ":" + item["payload"]["resourceId"]: item[
                            "payload"
                        ]
                        for item in resolution["resources"]
                    }
                    result["updateAvailable"] = [
                        {
                            "kind": item["kind"],
                            "resourceId": item["resourceId"],
                            "currentVersion": item["version"],
                            "latestVersion": latest[item["kind"] + ":" + item["resourceId"]][
                                "version"
                            ],
                        }
                        for item in current["resources"]
                        if item["kind"] + ":" + item["resourceId"] in latest
                        and version(latest[item["kind"] + ":" + item["resourceId"]]["version"])
                        > version(item["version"])
                    ]
                    # Instance IDs carry conversation/history identity. A newly
                    # published resource is offered, never implicitly substituted.
                    await remember_resolution()
                    return result
                latest_envelopes = {
                    item["payload"]["kind"] + ":" + item["payload"]["resourceId"]: item
                    for item in resolution["resources"]
                }
                minimums: dict[str, str] = {}
                selected_envelopes: dict[str, Any] = {}
                instances = ResourceInstances(self.catalog.directory)

                async def adopt_shared(dependency: dict[str, Any]) -> None:
                    key = dependency["kind"] + ":" + dependency["resourceId"]
                    # Existing per-application bindings and legacy unfinished
                    # installations remain authoritative; never merge their data.
                    if key in ledger["resources"] or key in ledger.get("pendingResources", {}):
                        return
                    envelope = latest_envelopes.get(key)
                    if envelope is None:
                        return
                    payload = self.catalog.verify(envelope)
                    identity = instance_identity(payload, scope)
                    if identity is None:
                        return
                    record = await instances.read(identity)
                    if record is None:
                        return
                    stored = self.catalog.verify(record.get("envelope"))
                    if (
                        instance_identity(stored, scope) != identity
                        or stored["version"] != record.get("version")
                        or stored["package"]["sha256"] != record["digest"]
                    ):
                        raise fail("RESOURCE_LOCAL_STATE_INVALID", 503)
                    if version(record["version"]) < version(dependency["minVersion"]):
                        raise fail("RESOURCE_MIGRATION_REQUIRED")
                    if stored["version"] == payload["version"] and canonical(
                        record["envelope"]
                    ) != canonical(envelope):
                        raise fail("RESOURCE_VERSION_CHANGED")
                    await authorize_resource(record["envelope"])
                    # A shared private expert keeps the exact skill copies it
                    # was verified with, even when the market now offers newer ones.
                    for dep_key, dep_record in record.get("dependencyResources", {}).items():
                        if not isinstance(dep_record, dict) or dep_record.get("status") != "ready":
                            raise fail("RESOURCE_LOCAL_STATE_INVALID", 503)
                        dep_payload = self.catalog.verify(dep_record.get("envelope"))
                        if (
                            dep_payload["kind"] != "skill-package"
                            or dep_key != "skill-package:" + dep_payload["resourceId"]
                            or dep_record.get("version") != dep_payload["version"]
                            or dep_record.get("digest") != dep_payload["package"]["sha256"]
                        ):
                            raise fail("RESOURCE_LOCAL_STATE_INVALID", 503)
                        installed = ledger["resources"].get(dep_key)
                        if installed and installed.get("digest") != dep_record.get("digest"):
                            raise fail("RESOURCE_MIGRATION_REQUIRED")
                        if not installed:
                            ledger["resources"][dep_key] = copy.deepcopy(dep_record)
                    if record["status"] == "ready":
                        ledger["resources"][key] = record
                    else:
                        ledger.setdefault("pendingResources", {})[key] = record

                async def require(dependency: dict[str, Any]) -> None:
                    dep_key = dependency["kind"] + ":" + dependency["resourceId"]
                    if dep_key in minimums and version(minimums[dep_key]) >= version(
                        dependency["minVersion"]
                    ):
                        return
                    minimums[dep_key] = dependency["minVersion"]
                    await adopt_shared(dependency)
                    installed = ledger["resources"].get(dep_key)
                    compatible = installed and version(installed["version"]) >= version(
                        dependency["minVersion"]
                    )
                    if installed and not compatible:
                        # Also protect an existing private expert's copied skill
                        # files; changing only a global skill record would lie
                        # about which version its workspace actually executes.
                        consumed = dependency["kind"] == "skill-package" and any(
                            dependency["resourceId"] in row.get("dependencyDigests", {})
                            for row in ledger["resources"].values()
                        )
                        if dependency["kind"] == "expert" or consumed:
                            raise fail("RESOURCE_MIGRATION_REQUIRED")
                    pending = ledger.get("pendingResources", {}).get(dep_key)
                    envelope = (
                        installed["envelope"]
                        if compatible
                        else (
                            pending["envelope"]
                            if pending and pending.get("sharedIdentity")
                            else latest_envelopes.get(dep_key)
                        )
                    )
                    if envelope is None:
                        raise fail("RESOURCE_DEPENDENCY_UNRESOLVED")
                    selected_envelopes[dep_key] = envelope
                    selected = self.catalog.verify(envelope)
                    if version(selected["version"]) < version(dependency["minVersion"]):
                        raise fail("RESOURCE_MIGRATION_REQUIRED")
                    for child in selected["dependencies"]:
                        await require(child)

                try:
                    # Private expert workspaces already contain exact skill
                    # copies. Pin those snapshots before ordinary skill roots,
                    # regardless of the order declared by the application.
                    for dependency in sorted(
                        requirements, key=lambda item: item["kind"] != "expert"
                    ):
                        await require(dependency)
                except BridgeAuthError as exc:
                    result["code"] = exc.code
                    return result
                ordered, visited, visiting = [], set(), set()

                def order(key: str) -> None:
                    if key in visiting:
                        raise fail("RESOURCE_DEPENDENCY_CYCLE")
                    if key in visited:
                        return
                    visiting.add(key)
                    for dep in selected_envelopes[key]["payload"]["dependencies"]:
                        order(dep["kind"] + ":" + dep["resourceId"])
                    visiting.remove(key)
                    visited.add(key)
                    ordered.append(selected_envelopes[key])

                for key in selected_envelopes:
                    order(key)
                try:
                    # A compatible installed gray version may be newer than the
                    # current stable resolution. Recheck its exact authority before
                    # either reusing it or writing any new dependent resources.
                    for envelope in ordered:
                        await authorize_resource(envelope)
                    if not read_only:
                        for envelope in ordered:
                            payload = self.catalog.verify(envelope)
                            key = payload["kind"] + ":" + payload["resourceId"]
                            active = ledger["resources"].get(key)
                            if active and version(active["version"]) >= version(minimums[key]):
                                continue
                            package = await self.catalog.package(
                                envelope,
                                **({"account_id": account_id} if account_id is not None else {}),
                            )
                            await assert_live()
                            identity = instance_identity(payload, scope)
                            pending = ledger.get("pendingResources", {}).get(key)
                            if pending and not pending.get("sharedIdentity"):
                                identity = None  # Resume a legacy intent in its original scope.
                            installation = ledger
                            install_save = save
                            needed = []
                            if identity is not None:
                                record = await instances.read(identity)
                                if record and (
                                    record["version"] != payload["version"]
                                    or record["digest"] != payload["package"]["sha256"]
                                ):
                                    raise fail("RESOURCE_MIGRATION_REQUIRED")
                                installation = {
                                    "resources": {},
                                    "pendingResources": {key: record} if record else {},
                                }

                                async def save_shared() -> None:
                                    shared = installation.get("pendingResources", {}).get(
                                        key
                                    ) or installation["resources"].get(key)
                                    if shared is None:
                                        raise fail("RESOURCE_LOCAL_STATE_INVALID", 503)
                                    shared["sharedIdentity"] = identity
                                    if payload["kind"] == "expert":
                                        shared["dependencyResources"] = {
                                            "skill-package:"
                                            + dependency["resourceId"]: copy.deepcopy(
                                                ledger["resources"][
                                                    "skill-package:" + dependency["resourceId"]
                                                ]
                                            )
                                            for _, dependency in needed
                                        }
                                    await assert_live()
                                    # Persist the common intent before either the
                                    # application ledger or an external API write.
                                    await instances.write(identity, shared)
                                    ledger.setdefault("pendingResources", {})[key] = shared
                                    await save()

                                install_save = save_shared
                            if payload["kind"] == "skill-package":
                                await self._skill(
                                    package,
                                    payload,
                                    installation,
                                    key,
                                    _digest(identity) if identity else scope_id,
                                    install_save,
                                    assert_live,
                                    envelope,
                                    shared_pool=identity is not None,
                                )
                            else:
                                seen_skills: set[str] = set()

                                async def collect_skills(
                                    dependencies: list[dict[str, Any]],
                                ) -> None:
                                    for dep in dependencies:
                                        installed = ledger["resources"].get(
                                            dep["kind"] + ":" + dep["resourceId"]
                                        )
                                        if (
                                            not installed
                                            or installed.get("status") != "ready"
                                            or version(installed["version"])
                                            < version(dep["minVersion"])
                                        ):
                                            raise fail("RESOURCE_DEPENDENCY_UNRESOLVED")
                                        dep_payload = self.catalog.verify(installed["envelope"])
                                        if (
                                            dep["kind"] == "skill-package"
                                            and dep["resourceId"] not in seen_skills
                                        ):
                                            seen_skills.add(dep["resourceId"])
                                            await collect_skills(dep_payload["dependencies"])
                                            dep_package = await self.catalog.package(
                                                installed["envelope"],
                                                **(
                                                    {"account_id": account_id}
                                                    if account_id is not None
                                                    else {}
                                                ),
                                            )
                                            needed.append((installed["packageId"], dep_package))

                                await collect_skills(payload["dependencies"])
                                await self._expert(
                                    package,
                                    payload,
                                    installation,
                                    key,
                                    me["id"],
                                    product,
                                    needed,
                                    request,
                                    install_save,
                                    assert_live,
                                    envelope,
                                )
                            if identity is not None:
                                ledger["resources"][key] = installation["resources"][key]
                    selected = await self._current(
                        ledger,
                        requirements,
                        me["id"],
                        product,
                        request,
                        assert_live,
                        authorize_resource,
                    )
                    result.update(selected)
                    if not read_only:
                        publish_bindings = True
                        for key in tuple(ledger.get("pendingResources", {})):
                            if ledger["resources"].get(key) is ledger["pendingResources"][key]:
                                ledger["pendingResources"].pop(key)
                        await save()
                except (BridgeAuthError, BridgeUpstreamError, httpx.HTTPError, OSError) as exc:
                    ledger["resources"] = active_resources
                    error_code = getattr(exc, "code", "RESOURCE_UPSTREAM_OPERATION_FAILED")
                    # New content must never turn a working compatible installation
                    # into an outage. Only real old files/ownership and the current
                    # authoritative minimum requirements permit this fallback.
                    try:
                        selected = await self._current(
                            ledger,
                            requirements,
                            me["id"],
                            product,
                            request,
                            assert_live,
                            authorize_resource,
                        )
                    except (BridgeAuthError, BridgeUpstreamError, httpx.HTTPError, OSError):
                        result["code"] = error_code
                        return result
                    result.update(selected)
                    result["updateWarning"] = error_code
                await remember_resolution()
                return result
            except BridgeAuthError as exc:
                result["code"] = exc.code
                return result
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)

    async def _current(
        self,
        ledger: dict[str, Any],
        requirements: list[dict[str, Any]],
        user_id: int,
        product: str,
        request: Any,
        assert_live: Any,
        authorize_resource: Any,
    ) -> dict[str, Any]:
        resources, bindings, visited, visiting = [], [], set(), set()

        async def visit(requirement: dict[str, Any]) -> None:
            key = requirement["kind"] + ":" + requirement["resourceId"]
            record = ledger["resources"].get(key)
            if (
                not record
                or record.get("status") != "ready"
                or version(record["version"]) < version(requirement["minVersion"])
            ):
                raise fail("RESOURCE_NOT_PREPARED")
            payload = self.catalog.verify(record["envelope"])
            if (
                payload["kind"] != requirement["kind"]
                or payload["resourceId"] != requirement["resourceId"]
                or payload["version"] != record["version"]
                or payload["package"]["sha256"] != record["digest"]
            ):
                raise fail("RESOURCE_LOCAL_STATE_INVALID", 503)
            if key in visiting:
                raise fail("RESOURCE_DEPENDENCY_CYCLE")
            if key in visited:
                return
            await authorize_resource(record["envelope"])
            visiting.add(key)
            for dep in payload["dependencies"]:
                await visit(dep)
            if payload["kind"] == "expert":
                expected: dict[str, str] = {}

                def skill_closure(dependencies: list[dict[str, Any]]) -> None:
                    for dep in dependencies:
                        if dep["kind"] != "skill-package" or dep["resourceId"] in expected:
                            continue
                        child = ledger["resources"]["skill-package:" + dep["resourceId"]]
                        expected[dep["resourceId"]] = child["digest"]
                        skill_closure(self.catalog.verify(child["envelope"])["dependencies"])

                skill_closure(payload["dependencies"])
                if record.get("dependencyDigests", {}) != expected:
                    raise fail("RESOURCE_MIGRATION_REQUIRED")
            binding = await self._verify_binding(
                record, payload, user_id, product, request, assert_live
            )
            resources.append(
                {
                    "kind": payload["kind"],
                    "resourceId": payload["resourceId"],
                    "version": payload["version"],
                    "status": "ready",
                }
            )
            bindings.append(binding)
            visiting.remove(key)
            visited.add(key)

        for requirement in requirements:
            await visit(requirement)
        return {"status": "ready", "resources": resources, "bindings": bindings}

    async def _verify_binding(
        self,
        record: dict[str, Any],
        payload: dict[str, Any],
        user_id: int,
        product: str,
        request: Any,
        assert_live: Any,
    ) -> dict[str, Any]:
        common = {key: payload[key] for key in ("kind", "resourceId", "version")}
        await assert_live()
        if payload["kind"] == "expert":
            row = _json(await request("GET", "/api/agents/" + quote(record["instanceId"], safe="")))
            if not _owned(row, user_id, product, record["nonce"]):
                raise fail("RESOURCE_INSTANCE_OWNERSHIP_CHANGED")
            for path, digest in record["files"].items():
                response = await request(
                    "GET",
                    "/api/agents/"
                    + quote(record["instanceId"], safe="")
                    + "/workspace/download?"
                    + urlencode({"path": path, "from_workspace": "true"}),
                )
                if (
                    response.status_code != 200
                    or hashlib.sha256(response.content).hexdigest() != digest
                ):
                    raise fail("RESOURCE_USER_MODIFIED")
            if set(row.get("skill_package_ids", [])) != set(record.get("packageIds", [])):
                raise fail("RESOURCE_USER_MODIFIED")
            status = _json(
                await request(
                    "GET", "/api/agents/" + quote(record["instanceId"], safe="") + "/status"
                )
            )
            if status.get("state") != "running":
                raise fail("RESOURCE_EXPERT_START_FAILED")
            return {**common, "instanceId": record["instanceId"]}
        data = await self.admin.request(
            "GET", "/api/skill-packages/" + quote(record["packageId"], safe="")
        )
        if data.get("name") != record["name"] or data.get("description") != record["marker"]:
            raise fail("RESOURCE_INSTANCE_OWNERSHIP_CHANGED")
        summaries = data.get("skills")
        if not isinstance(summaries, list) or {item.get("slug") for item in summaries} != set(
            record["skills"]
        ):
            raise fail("RESOURCE_USER_MODIFIED")
        # Public API exposes SKILL.md only, not asset byte hashes. Preserve truthful
        # write-ack evidence; do not claim an unsupported attachment readback.
        for slug, raw_digest in record["skills"].items():
            skill = await self.admin.request(
                "GET",
                "/api/skill-packages/"
                + quote(record["packageId"], safe="")
                + "/skills/"
                + quote(slug, safe=""),
            )
            if hashlib.sha256(skill.get("raw", "").encode()).hexdigest() != raw_digest:
                raise fail("RESOURCE_USER_MODIFIED")
        await assert_live()
        return {
            **common,
            "packageId": record["packageId"],
            "verification": "api-write-ack-and-skill-text",
        }

    async def _skill(
        self,
        package: dict[str, Any],
        payload: dict[str, Any],
        ledger: dict[str, Any],
        key: str,
        scope_id: str,
        save: Any,
        assert_live: Any,
        envelope: dict[str, Any],
        *,
        shared_pool: bool = False,
    ) -> dict[str, Any]:
        record = ledger["resources"].get(key)
        digest = payload["package"]["sha256"]
        if (
            record
            and record.get("version") == payload["version"]
            and record.get("digest") != digest
        ):
            raise fail("RESOURCE_VERSION_CHANGED")
        if record and record.get("status") == "ready" and record["version"] == payload["version"]:
            return await self._verify_binding(record, payload, 0, "", None, assert_live)
        pending = ledger.setdefault("pendingResources", {})
        old = record
        record = pending.get(key)
        if record and record["version"] != payload["version"]:
            raise fail("RESOURCE_PREVIOUS_PREPARATION_PENDING")
        if record and record["digest"] != digest:
            raise fail("RESOURCE_VERSION_CHANGED")
        if record is None:
            record = {
                "version": payload["version"],
                "digest": digest,
                "envelope": envelope,
                "status": "preparing",
                "name": package["name"] + " " + package["version"] + " " + scope_id[:10],
                # Shared global packages are an immutable internal pool. The
                # native guard allows stable read/copy, but no shared mutation.
                # Gray bytes remain private to the verified resource workflow.
                "marker": (
                    CONTROLLED_MARKER
                    if payload.get("releaseAccess") == "account"
                    else SHARED_MARKER
                    if shared_pool
                    else "wanx-resource:"
                )
                + secrets.token_hex(24),
                "skills": {},
                "previousPackageIds": (
                    [old["packageId"]] + old.get("previousPackageIds", []) if old else []
                ),
            }
            pending[key] = record
            await save()
        groups = skill_files(package)
        if not record.get("packageId"):
            response = await self.admin._admin("GET", "/api/skill-packages")
            rows = _json(response)
            if not isinstance(rows, list):
                raise fail("RESOURCE_UPSTREAM_RESPONSE_INVALID", 502)
            matches = [
                row
                for row in rows
                if row.get("name") == record["name"] and row.get("description") == record["marker"]
            ]
            if len(matches) > 1:
                raise fail("RESOURCE_INSTANCE_CONFLICT")
            if matches:
                record["packageId"] = str(matches[0]["id"])
            else:
                if record.get("createRequested"):
                    raise fail("RESOURCE_CREATE_UNCERTAIN")
                record["createRequested"] = True
                await save()
                await assert_live()
                row = await self.admin.request(
                    "POST",
                    "/api/skill-packages",
                    json={
                        "name": record["name"],
                        "description": record["marker"],
                        "icon_name": "",
                        "icon_url": "",
                    },
                )
                if (
                    row.get("name") != record["name"]
                    or row.get("description") != record["marker"]
                    or not isinstance(row.get("id"), str)
                ):
                    raise fail("RESOURCE_UPSTREAM_RESPONSE_INVALID", 502)
                record["packageId"] = row["id"]
            await save()
        for slug, files in groups.items():
            raw = next(
                base64.b64decode(item["content_base64"])
                for item in files
                if item["path"] == "SKILL.md"
            )
            if slug in record["skills"]:
                continue
            if record.get("pendingSkill") == slug:
                # API cannot read attachment bytes, so an interrupted write cannot
                # be safely promoted by merely observing an existing SKILL.md.
                raise fail("RESOURCE_SKILL_IMPORT_UNCERTAIN")
            record["pendingSkill"] = slug
            await save()
            await assert_live()
            await self.admin.request(
                "POST",
                "/api/skill-packages/" + quote(record["packageId"], safe="") + "/skills",
                json={"name": slug, "files": files, "overwrite": False},
            )
            record["skills"][slug] = hashlib.sha256(raw).hexdigest()
            record.pop("pendingSkill", None)
            await save()
        binding = await self._verify_binding(record, payload, 0, "", None, assert_live)
        record["status"] = "ready"
        record["envelope"] = envelope
        ledger["resources"][key] = record
        # Keep the complete candidate durable until all application dependencies
        # are ready and the caller atomically promotes the whole binding set.
        await save()
        return binding

    async def _expert(
        self,
        package: dict[str, Any],
        payload: dict[str, Any],
        ledger: dict[str, Any],
        key: str,
        user_id: int,
        product: str,
        needed: list[tuple[str, dict[str, Any]]],
        request: Any,
        save: Any,
        assert_live: Any,
        envelope: dict[str, Any],
    ) -> dict[str, Any]:
        old = ledger["resources"].get(key)
        digest = payload["package"]["sha256"]
        dependency_digests = {
            dependency["resourceId"]: _digest(dependency) for _, dependency in needed
        }
        if old and old["version"] == payload["version"]:
            if old["digest"] != digest:
                raise fail("RESOURCE_VERSION_CHANGED")
            if old.get("dependencyDigests", {}) == dependency_digests:
                return await self._verify_binding(
                    old, payload, user_id, product, request, assert_live
                )
        # Octop has no transactionally swappable workspace API. Prepare a new
        # private instance; never rewrite a live user's old prompt/history/memory.
        pending = ledger.setdefault("pendingResources", {})
        record = pending.get(key)
        if record and (
            record["version"] != payload["version"]
            or record.get("dependencyDigests", {}) != dependency_digests
        ):
            raise fail("RESOURCE_PREVIOUS_PREPARATION_PENDING")
        if record and record["digest"] != digest:
            raise fail("RESOURCE_VERSION_CHANGED")
        if record is None:
            record = {
                "version": payload["version"],
                "digest": digest,
                "envelope": envelope,
                "dependencyDigests": dependency_digests,
                "status": "preparing",
                "nonce": secrets.token_hex(24),
                "files": {},
                "packageIds": [],
                "previousInstanceIds": (
                    [old["instanceId"]] + old.get("previousInstanceIds", []) if old else []
                ),
            }
            pending[key] = record
            await save()
        if record.get("status") == "ready":
            binding = await self._verify_binding(
                record, payload, user_id, product, request, assert_live
            )
            ledger["resources"][key] = record
            return binding
        wanted = expert_files(package)
        copies = []
        for package_id, dependency in needed:
            groups = skill_files(dependency)
            for item in dependency["files"]:
                content = base64.b64decode(item["contentBase64"])
                if item["path"] in wanted and wanted[item["path"]] != content:
                    raise fail("RESOURCE_SKILL_PATH_CONFLICT")
                wanted[item["path"]] = content
            copies.append((package_id, groups))
        hashes = {path: hashlib.sha256(content).hexdigest() for path, content in wanted.items()}
        if not record.get("instanceId"):
            rows = _json(await request("GET", "/api/agents?scope=mine"))
            if not isinstance(rows, list):
                raise fail("RESOURCE_UPSTREAM_RESPONSE_INVALID", 502)
            matches = [row for row in rows if _owned(row, user_id, product, record["nonce"])]
            if len(matches) > 1:
                raise fail("RESOURCE_INSTANCE_CONFLICT")
            if matches:
                record["instanceId"] = matches[0]["agent_id"]
            else:
                if record.get("createRequested"):
                    raise fail("RESOURCE_CREATE_UNCERTAIN")
                record["createRequested"] = True
                await save()
                row = _json(
                    await request(
                        "POST",
                        "/api/agents",
                        json={
                            "name": package["name"] + " · " + record["nonce"][:8],
                            "description": package["description"],
                            "config": {
                                "backend": {"type": "filesystem", "virtual_mode": True},
                                "wanx_resource_instance": record["nonce"],
                            },
                            "is_shared": False,
                            "knowledge_base_ids": [],
                            "mcp_servers": [],
                            "skill_package_ids": [],
                        },
                    )
                )
                if not _owned(row, user_id, product, record["nonce"]):
                    raise fail("RESOURCE_PRODUCT_PROFILE_UNSUPPORTED")
                record["instanceId"] = row["agent_id"]
            await save()
        agent = "/api/agents/" + quote(record["instanceId"], safe="")
        row = _json(await request("GET", agent))
        if not _owned(row, user_id, product, record["nonce"]):
            raise fail("RESOURCE_INSTANCE_OWNERSHIP_CHANGED")
        current = {}
        for path in wanted:
            response = await request(
                "GET",
                agent
                + "/workspace/download?"
                + urlencode({"path": path, "from_workspace": "true"}),
            )
            if response.status_code == 404:
                current[path] = None
            elif response.status_code == 200:
                current[path] = hashlib.sha256(response.content).hexdigest()
            else:
                raise fail("RESOURCE_UPSTREAM_OPERATION_FAILED", 502)
            if record.get("initialFiles") is not None and current[path] not in {
                record["initialFiles"].get(path),
                hashes[path],
            }:
                raise fail("RESOURCE_USER_MODIFIED")
        if row.get("skill_package_ids"):
            raise fail("RESOURCE_USER_MODIFIED")
        if "initialFiles" not in record:
            record["initialFiles"] = current
        await save()
        if row.get("state") != "running":
            response = await request("POST", agent + "/start")
            if response.status_code not in {200, 204}:
                raise fail("RESOURCE_EXPERT_START_FAILED")
        for package_id, groups in copies:
            for slug, files in groups.items():
                paths = ["skills/" + slug + "/" + item["path"] for item in files]
                if all(current[path] is None for path in paths):
                    _json(
                        await request(
                            "POST",
                            agent + "/skill-packages/" + quote(package_id, safe="") + "/copy",
                            json={"skill_slugs": [slug], "overwrite": False},
                        )
                    )
                    # Copy is checked byte-for-byte below, including attachments.
                    for path in paths:
                        response = await request(
                            "GET",
                            agent
                            + "/workspace/download?"
                            + urlencode({"path": path, "from_workspace": "true"}),
                        )
                        if (
                            response.status_code != 200
                            or hashlib.sha256(response.content).hexdigest() != hashes[path]
                        ):
                            raise fail("RESOURCE_SKILL_COPY_MISMATCH")
                        current[path] = hashes[path]
        for path, content in wanted.items():
            if current[path] == hashes[path]:
                continue
            _json(
                await request(
                    "POST",
                    agent
                    + "/workspace/upload?"
                    + urlencode({"path": path, "from_workspace": "true"}),
                    files={"file": (Path(path).name, content, "application/octet-stream")},
                )
            )
        response = await request("POST", agent + "/reload")
        if response.status_code not in {200, 204}:
            raise fail("RESOURCE_EXPERT_START_FAILED")
        record["files"] = hashes
        binding = await self._verify_binding(
            record, payload, user_id, product, request, assert_live
        )
        record["status"] = "ready"
        record.pop("initialFiles", None)
        record["envelope"] = envelope
        ledger["resources"][key] = record
        # Keep the complete candidate durable until all application dependencies
        # are ready and the caller atomically promotes the whole binding set.
        await save()
        return binding
