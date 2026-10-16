"""Opt-in device resource transport and durable cache, separate from OTA and Octop."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import stat
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit
from uuid import UUID

import httpx

from .config import BridgeAuthError
from .resource_cache import (
    CACHE_MAX_BYTES,
    CACHE_MIN_FREE_BYTES,
    cache_bytes,
    cache_io,
    cache_lock,
    cleanup_cache,
)
from .resources_contract import (
    MAX_PACKAGE,
    canonical,
    fail,
    fields,
    validate_package,
    verify_envelope,
)


def private_bytes(path: Path, limit: int = 65536, *, secret: bool = False) -> bytes:
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_size > limit
                or (secret and info.st_mode & 0o077)
            ):
                raise ValueError()
            return stream.read(limit + 1)
    except (OSError, ValueError) as exc:
        raise fail("RESOURCE_LOCAL_CONFIG_INVALID", 503) from exc


def atomic(path: Path, value: bytes) -> None:
    if path.is_symlink() or path.parent.is_symlink():
        raise fail("RESOURCE_LOCAL_STATE_INVALID", 503)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".resource-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


@dataclass(frozen=True)
class ResourceConfig:
    device_id: str
    key_file: Path
    api_base: str
    trust_file: Path
    state_dir: Path
    allowed_hosts: frozenset[str]
    interval: int = 900

    @classmethod
    def from_env(cls) -> ResourceConfig | None:
        if os.getenv("WANX_RESOURCES_ENABLED") != "1":
            return None
        try:
            base = os.environ["WANX_RESOURCES_API_BASE"].rstrip("/")
            parsed = urlsplit(base)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
                or parsed.port not in {None, 443}
            ):
                raise ValueError()
            device_id = os.environ["WANX_RESOURCES_DEVICE_ID"]
            if (
                not device_id
                or len(device_id) > 128
                or not all(c.isalnum() or c in "-_." for c in device_id)
            ):
                raise ValueError()
            paths = [
                Path(os.environ["WANX_RESOURCES_" + key])
                for key in ("KEY_FILE", "TRUST_FILE", "STATE_DIR")
            ]
            hosts = frozenset(
                host.strip().lower()
                for host in os.environ["WANX_RESOURCES_ALLOWED_HOSTS"].split(",")
                if host.strip()
            )
            if (
                not hosts
                or any("/" in host or ":" in host or "*" in host for host in hosts)
                or any(not p.is_absolute() for p in paths)
            ):
                raise ValueError()
            interval = int(os.getenv("WANX_RESOURCES_CHECK_INTERVAL_SECONDS", "900"))
            if not 60 <= interval <= 86400:
                raise ValueError()
            return cls(device_id, paths[0], base, paths[1], paths[2], hosts, interval)
        except (ValueError, KeyError) as exc:
            raise fail("RESOURCE_LOCAL_CONFIG_INVALID", 503) from exc


class ResourceCatalog:
    def __init__(
        self, config: ResourceConfig, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self.config = config
        self.directory = config.state_dir
        self.directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        if self.directory.is_symlink():
            raise fail("RESOURCE_LOCAL_STATE_INVALID", 503)
        self.directory.chmod(0o700)
        self.client = httpx.AsyncClient(
            transport=transport, trust_env=False, follow_redirects=False, timeout=30
        )
        self.lock = asyncio.Lock()
        self.last_error: str | None = None
        self.last_cleanup: dict[str, Any] | None = None

    def verify(self, envelope: Any) -> dict[str, Any]:
        try:
            trust = json.loads(private_bytes(self.config.trust_file))
        except (ValueError, UnicodeError) as exc:
            raise fail("RESOURCE_TRUST_INVALID", 503) from exc
        return verify_envelope(envelope, trust)

    async def _read(self, method: str, url: str, *, limit: int, **kwargs: Any) -> tuple[int, bytes]:
        try:
            async with asyncio.timeout(120), self.client.stream(method, url, **kwargs) as response:
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > limit:
                        raise fail("RESOURCE_RESPONSE_TOO_LARGE", 502)
                return response.status_code, bytes(data)
        except (httpx.HTTPError, TimeoutError) as exc:
            raise fail("RESOURCE_SERVICE_UNAVAILABLE", 503) from exc

    async def request(self, operation: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        if operation not in {"catalog", "resolve", "download", "access"}:
            raise fail()
        key = private_bytes(self.config.key_file, 8192, secret=True).decode().strip()
        if not key or any(c.isspace() for c in key):
            raise fail("RESOURCE_DEVICE_CREDENTIAL_INVALID", 503)
        status, raw = await self._read(
            "GET" if body is None else "POST",
            self.config.api_base
            + "/device-api/v1/resources/"
            + quote(self.config.device_id, safe="")
            + "/"
            + operation,
            limit=24 * 1024 * 1024,
            headers={"Authorization": "CentaurOS-DeviceKey " + key, "Accept": "application/json"},
            **({"params": {"resourceProtocol": 2}} if body is None else {"json": body}),
        )
        if status in {401, 403}:
            # Authorization denial is final, never a transient transport failure.
            # Keep the explicit gray-access code while exposing no server details.
            try:
                denied = json.loads(raw)
            except (ValueError, TypeError):
                denied = {}
            code = "RESOURCE_PUBLICATION_UNAVAILABLE"
            if isinstance(denied, dict) and denied.get("errorCode") in {
                "MARKET_GRAY_ACCESS_DENIED",
                "RESOURCE_GRAY_ACCESS_DENIED",
                "RESOURCE_DEVICE_ACCESS_DENIED",
            }:
                code = denied["errorCode"]
            raise fail(code, status)
        if status != 200:
            raise fail(
                "RESOURCE_SERVICE_UNAVAILABLE"
                if status >= 500
                else "RESOURCE_PUBLICATION_UNAVAILABLE",
                503 if status >= 500 else 409,
            )
        try:
            value = json.loads(raw)
            if (
                value.get("code") != 200
                or value.get("success") is not True
                or not isinstance(value.get("data"), dict)
            ):
                raise ValueError()
            return value["data"]
        except (ValueError, TypeError, AttributeError) as exc:
            raise fail("RESOURCE_RESPONSE_INVALID", 502) from exc

    async def resolve(
        self, application_id: str, artifact_id: str, *, account_id: str | None = None
    ) -> dict[str, Any]:
        body = {"applicationId": application_id, "artifactId": artifact_id, "resourceProtocol": 2}
        if account_id is not None:
            body["accountId"] = account_id
        result = await self.request("resolve", body)
        fields(
            result,
            {
                "schemaVersion",
                "applicationId",
                "artifactId",
                "backendProductId",
                "requirements",
                "resources",
            }
            | (
                {"releaseAccess"}
                if isinstance(result, dict) and "releaseAccess" in result
                else set()
            ),
        )
        if "releaseAccess" in result and result["releaseAccess"] != "account":
            raise fail("RESOURCE_RESPONSE_INVALID", 502)
        if (
            result["schemaVersion"] != 1
            or result["applicationId"] != application_id
            or result["artifactId"] != artifact_id
            or (
                result["backendProductId"] is not None
                and not isinstance(result["backendProductId"], str)
            )
            or not isinstance(result["resources"], list)
            or len(result["resources"]) > 256
        ):
            raise fail("RESOURCE_RESPONSE_INVALID", 502)
        from .resources_contract import dependencies

        dependencies(result["requirements"], "application", "")
        seen: dict[tuple[str, str], dict[str, Any]] = {}
        from .resources_contract import version

        for envelope in result["resources"]:
            payload = self.verify(envelope)
            if (
                payload.get("releaseAccess") == "account"
                and result.get("releaseAccess") != "account"
            ):
                raise fail("RESOURCE_RESPONSE_INVALID", 502)
            key = (payload["kind"], payload["resourceId"])
            if key in seen:
                raise fail("RESOURCE_RESPONSE_INVALID", 502)
            for dep in payload["dependencies"]:
                resolved = seen.get((dep["kind"], dep["resourceId"]))
                if resolved is None or version(resolved["version"]) < version(dep["minVersion"]):
                    raise fail("RESOURCE_DEPENDENCY_UNRESOLVED")
            seen[key] = payload
        for requirement in result["requirements"]:
            resolved = seen.get((requirement["kind"], requirement["resourceId"]))
            if resolved is None or version(resolved["version"]) < version(
                requirement["minVersion"]
            ):
                raise fail("RESOURCE_DEPENDENCY_UNRESOLVED")
        return result

    async def _resource_request(
        self, operation: str, envelope: dict[str, Any], *, account_id: str | None = None
    ) -> dict[str, Any]:
        """Bind every acquisition or reuse check to the verified account and envelope."""
        payload = self.verify(envelope)
        controlled = payload.get("releaseAccess") == "account"
        if controlled:
            try:
                if not isinstance(account_id, str) or str(UUID(account_id)) != account_id:
                    raise ValueError()
            except ValueError as exc:
                raise fail("RESOURCE_ACCOUNT_IDENTITY_INVALID", 403) from exc
        body = {key: payload[key] for key in ("kind", "resourceId", "version")}
        body["resourceProtocol"] = 2
        if account_id is not None:
            body["accountId"] = account_id
        try:
            response = await self.request(operation, body)
        except BridgeAuthError as exc:
            if controlled and exc.status == 503:
                raise fail("RESOURCE_ONLINE_ACCESS_REQUIRED", 503) from exc
            raise
        if canonical(response.get("envelope")) != canonical(envelope):
            raise fail("RESOURCE_PACKAGE_IDENTITY_MISMATCH")
        self.verify(response["envelope"])
        return response

    async def _download(
        self, envelope: dict[str, Any], *, account_id: str | None = None
    ) -> dict[str, Any]:
        download = await self._resource_request("download", envelope, account_id=account_id)
        fields(download, {"envelope", "url", "expiresAt"})
        if (
            type(download["expiresAt"]) is not int
            or not time.time() < download["expiresAt"] <= time.time() + 900
        ):
            raise fail("RESOURCE_DOWNLOAD_EXPIRED")
        return download

    async def authorize(self, envelope: dict[str, Any], *, account_id: str | None = None) -> None:
        """An installed controlled resource still needs current preparation authority."""
        if self.verify(envelope).get("releaseAccess") == "account":
            access = await self._resource_request("access", envelope, account_id=account_id)
            fields(access, {"envelope", "channel"})
            if access["channel"] not in {"stable", "gray"}:
                raise fail("RESOURCE_RESPONSE_INVALID", 502)

    async def package(
        self, envelope: dict[str, Any], *, account_id: str | None = None
    ) -> dict[str, Any]:
        payload = self.verify(envelope)
        digest = payload["package"]["sha256"]
        cached = self.directory / "packages" / (digest + ".json")
        async with self.lock, cache_lock(self.directory):
            try:
                cache_size = await cache_io(cache_bytes, self.directory)
            except (OSError, ValueError) as exc:
                raise fail("RESOURCE_LOCAL_STATE_INVALID", 503) from exc
            # Shared immutable bytes prove integrity, not account membership. A
            # gray package remains controlled after promotion to stable.
            download = (
                await self._download(envelope, account_id=account_id)
                if payload.get("releaseAccess") == "account"
                else None
            )
            if cached.exists() or cached.is_symlink():
                package = validate_package(
                    await cache_io(private_bytes, cached, MAX_PACKAGE), payload
                )
                # Retention is based on recent use, not just the original download.
                await cache_io(os.utime, cached, None)
                return package
            if download is None:
                download = await self._download(envelope, account_id=account_id)
            try:
                parsed = urlsplit(download["url"])
                port = parsed.port
            except (ValueError, TypeError) as exc:
                raise fail("RESOURCE_DOWNLOAD_ORIGIN_FORBIDDEN") from exc
            if (
                parsed.scheme != "https"
                or parsed.hostname not in self.config.allowed_hosts
                or port not in {None, 443}
                or parsed.username
                or parsed.password
                or parsed.fragment
            ):
                raise fail("RESOURCE_DOWNLOAD_ORIGIN_FORBIDDEN")
            size = payload["package"]["sizeBytes"]
            if (
                cache_size + size > CACHE_MAX_BYTES
                or shutil.disk_usage(self.directory).free - size < CACHE_MIN_FREE_BYTES
            ):
                # Runtime preparation may already hold prepare.lock. Never run
                # GC here: periodic/explicit cleanup takes prepare -> cache locks.
                raise fail("RESOURCE_CACHE_FULL", 503)
            status, raw = await self._read("GET", download["url"], limit=size)
            if status != 200:
                raise fail("RESOURCE_DOWNLOAD_FAILED", 502)
            package = validate_package(raw, payload)

            def store() -> None:
                atomic(cached, raw)
                atomic(self.directory / "envelopes" / (digest + ".json"), canonical(envelope))

            await cache_io(store)
            return package

    async def cleanup(self) -> dict[str, Any]:
        """Run separately from preparation; a busy installer is never interrupted."""
        self.last_cleanup = await cleanup_cache(self.directory, self.verify)
        return self.last_cleanup

    async def synchronize(self) -> dict[str, Any]:
        result = await self.request("catalog")
        fields(result, {"schemaVersion", "items"})
        if (
            result["schemaVersion"] != 1
            or not isinstance(result["items"], list)
            or len(result["items"]) > 4096
        ):
            raise fail("RESOURCE_RESPONSE_INVALID", 502)
        # Poll only signed metadata. Packages are downloaded on demand through
        # an application-authorized user session; no full-market disk/network load.
        seen = set()
        for envelope in result["items"]:
            payload = self.verify(envelope)
            key = (payload["kind"], payload["resourceId"])
            if key in seen:
                raise fail("RESOURCE_RESPONSE_INVALID", 502)
            seen.add(key)
        async with cache_lock(self.directory):
            await cache_io(atomic, self.directory / "catalog.json", canonical(result))
        try:
            await self.cleanup()
        except (BridgeAuthError, OSError, ValueError):
            # Cache maintenance cannot invalidate a successfully fetched catalog.
            self.last_cleanup = {"status": "skipped", "code": "RESOURCE_CACHE_STATE_UNVERIFIED"}
        self.last_error = None
        return {"count": len(result["items"]), "failures": []}

    async def poll(self) -> None:
        while True:
            try:
                await self.synchronize()
            except (BridgeAuthError, OSError, ValueError):
                self.last_error = "RESOURCE_SYNC_UNAVAILABLE"
            await asyncio.sleep(self.config.interval)

    async def close(self) -> None:
        await self.client.aclose()
