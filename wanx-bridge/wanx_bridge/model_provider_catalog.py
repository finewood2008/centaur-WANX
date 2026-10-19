"""Device Provider V2 leases; credentials live only in this process's memory."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import ipaddress
import json
import os
import re
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit
from uuid import uuid4

import httpx

from .config import BridgeAuthError
from .resources import private_bytes

MAX_RESPONSE = 512 * 1024
MAX_INTEGER = 9007199254740991
BINDING = {"deviceId", "bindingId", "ownerAccountId", "ownershipEpoch", "authVersion"}
PROVIDER_FIELDS = {
    "providerId",
    "displayName",
    "enabled",
    "configVersion",
    "protocol",
    "baseUrl",
    "apiKey",
    "allowedProducts",
    "allowedModels",
}


def require(valid: bool, code: str = "MODEL_PROVIDER_RESPONSE_INVALID") -> None:
    if not valid:
        raise BridgeAuthError(code, 503)


def public_https(value: str) -> str:
    """Validate URL syntax; outbound inference must additionally pin public DNS."""
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ""
        require(
            isinstance(value, str)
            and value.isascii()
            and 1 <= len(value) <= 2048
            and parsed.scheme == "https"
            and parsed.port in {None, 443}
            and parsed.username is None
            and parsed.password is None
            and not parsed.query
            and not parsed.fragment
            and "?" not in value
            and "#" not in value
            and not any(ord(c) <= 32 or ord(c) == 127 for c in value)
            and "\\" not in value
            and "%" not in value
            and "." in host
            and len(host) <= 253
            and not host.endswith(
                (".local", ".localhost", ".internal", ".lan", ".home", ".test", ".invalid")
            )
            and re.search("[a-z]", host.split(".")[-1]) is not None
            and all(
                re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part)
                for part in host.split(".")
            )
            and not any(part in {".", ".."} for part in parsed.path.split("/"))
        )
        try:
            ipaddress.ip_address(host)
        except ValueError:
            return value.rstrip("/")
        raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise BridgeAuthError("MODEL_PROVIDER_RESPONSE_INVALID", 503) from None


@dataclass(frozen=True)
class ModelProviderConfig:
    device_id: str
    key_file: Path
    api_base: str
    interval: int = 60
    identity_device_id: str | None = None

    @classmethod
    def from_env(cls) -> ModelProviderConfig | None:
        enabled = os.getenv("WANX_MODEL_PROVIDERS_ENABLED")
        if enabled == "0":
            return None
        values = {
            name: os.getenv("WANX_MODEL_PROVIDERS_" + name, os.getenv("WANX_RESOURCES_" + name, ""))
            for name in ("API_BASE", "DEVICE_ID", "KEY_FILE")
        }
        if enabled is None and not any(values.values()):
            return None
        try:
            require(enabled in {None, "1"})
            base = public_https(values["API_BASE"])
            device = values["DEVICE_ID"]
            require(re.fullmatch(r"[A-Za-z0-9_.:-]{1,256}", device) is not None)
            key = Path(values["KEY_FILE"])
            require(key.is_absolute())
            interval = int(os.getenv("WANX_MODEL_PROVIDERS_CHECK_INTERVAL_SECONDS", "60"))
            require(15 <= interval <= 120)
            identity = (
                os.getenv(
                    "WANX_MODEL_PROVIDERS_IDENTITY_DEVICE_ID",
                    os.getenv("WANX_PLATFORM_DEVICE_ID", ""),
                )
                or None
            )
            require(
                identity is None or re.fullmatch(r"[A-Za-z0-9_.-]{1,256}", identity) is not None
            )
            return cls(device, key, base, interval, identity)
        except (ValueError, BridgeAuthError):
            raise BridgeAuthError("MODEL_PROVIDER_LOCAL_CONFIG_INVALID", 503) from None


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def _timestamp(value: Any) -> float:
    try:
        require(isinstance(value, str) and len(value) <= 40)
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(parsed.utcoffset() is not None)
        return parsed.timestamp()
    except (ValueError, TypeError, OverflowError):
        raise BridgeAuthError("MODEL_PROVIDER_RESPONSE_INVALID", 503) from None


def _provider(value: Any) -> None:
    require(type(value) is dict and set(value) == PROVIDER_FIELDS)
    require(
        isinstance(value["providerId"], str)
        and re.fullmatch(r"[a-z][a-z0-9-]{0,63}", value["providerId"]) is not None
    )
    name = value["displayName"]
    require(
        isinstance(name, str)
        and 1 <= len(name) <= 80
        and bool(name.strip())
        and not any(unicodedata.category(c).startswith("C") for c in name)
    )
    version = value["configVersion"]
    require(
        isinstance(version, str)
        and re.fullmatch(r"[1-9][0-9]{0,15}", version) is not None
        and int(version) <= MAX_INTEGER
    )
    require(type(value["enabled"]) is bool)
    if not value["enabled"]:
        require(
            all(value[k] is None for k in ("protocol", "baseUrl", "apiKey"))
            and value["allowedProducts"] == []
            and value["allowedModels"] == []
        )
        return
    require(value["protocol"] == "openai-compatible")
    public_https(value["baseUrl"])
    key = value["apiKey"]
    require(
        isinstance(key, str) and 1 <= len(key) <= 8192 and all(33 <= ord(c) <= 126 for c in key)
    )
    products, models = value["allowedProducts"], value["allowedModels"]
    require(
        type(products) is list
        and len(products) <= 2
        and all(type(p) is str and p in {"wanxiang", "zhijun"} for p in products)
        and len(set(products)) == len(products)
    )
    require(
        type(models) is list
        and len(models) <= 100
        and all(
            type(m) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", m)
            for m in models
        )
        and len(set(models)) == len(models)
    )


class ModelProviderCatalog:
    """The composition root must verify the configured Consumer Registry binding.

    Registry IDs can differ from certificate/physical platform identity IDs on
    legacy boxes; do not equate them without the trusted registration mapping.
    """

    def __init__(
        self,
        config: ModelProviderConfig,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        public_https(config.api_base)
        self.config = config
        self.clock, self.monotonic = clock, monotonic
        self.client = httpx.AsyncClient(
            transport=transport, trust_env=False, follow_redirects=False, timeout=10
        )
        self.lock = asyncio.Lock()
        self.snapshot: dict[str, Any] | None = None
        self.deadline = 0.0
        self.history_identity: tuple[Any, ...] | None = None
        self.binding: dict[str, Any] | None = None
        self.history: dict[str, tuple[int, bytes]] = {}
        self.last_error: str | None = None

    def clear(self) -> None:
        self.snapshot = None
        self.deadline = 0.0

    def active(self) -> dict[str, Any]:
        if self.snapshot is None:
            raise BridgeAuthError("MODEL_PROVIDER_UNAVAILABLE", 503)
        if self.monotonic() >= self.deadline or self.clock() >= _timestamp(
            self.snapshot["expiresAt"]
        ):
            self.clear()
            raise BridgeAuthError("MODEL_PROVIDER_LEASE_EXPIRED", 503)
        return copy.deepcopy(self.snapshot)

    async def _request(
        self, method: str, key: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        request_id = "req_" + uuid4().hex
        url = (
            self.config.api_base.rstrip("/")
            + "/api/devices/"
            + quote(self.config.device_id, safe="")
            + "/model-providers"
        )
        if body is not None:
            url += "/ack"
        try:
            async with (
                asyncio.timeout(15),
                self.client.stream(
                    method,
                    url,
                    headers={
                        "Authorization": "CentaurOS-DeviceKey " + key,
                        "X-Nexus-Provisioning-Version": "2",
                        "X-Request-Id": request_id,
                        "Accept": "application/json",
                    },
                    **({"json": body} if body is not None else {}),
                ) as response,
            ):
                if response.status_code != 200:
                    transient = response.status_code == 429 or 500 <= response.status_code <= 599
                    raise BridgeAuthError(
                        "MODEL_PROVIDER_TEMPORARILY_UNAVAILABLE"
                        if transient
                        else "MODEL_PROVIDER_ACCESS_DENIED",
                        response.status_code,
                    )
                require(response.headers.get_list("X-Request-Id") == [request_id])
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    require(len(raw) + len(chunk) <= MAX_RESPONSE)
                    raw.extend(chunk)
            value = json.loads(
                raw, object_pairs_hook=_object, parse_constant=lambda _: require(False)
            )
            require(
                type(value) is dict
                and set(value) == {"success", "msg", "errorCode", "data", "requestId", "serverTime"}
            )
            require(
                value["success"] is True
                and value["errorCode"] is None
                and value["requestId"] == request_id
                and type(value["data"]) is dict
                and type(value["msg"]) is str
            )
            _timestamp(value["serverTime"])
            return value["data"]
        except (httpx.HTTPError, TimeoutError):
            raise BridgeAuthError("MODEL_PROVIDER_TEMPORARILY_UNAVAILABLE", 503) from None
        except (ValueError, UnicodeError, RecursionError):
            raise BridgeAuthError("MODEL_PROVIDER_RESPONSE_INVALID", 503) from None

    def _validate(
        self, value: dict[str, Any]
    ) -> tuple[tuple[Any, ...], dict[str, tuple[int, bytes]], float]:
        require(set(value) == {"schemaVersion", *BINDING, "issuedAt", "expiresAt", "providers"})
        require(
            type(value["schemaVersion"]) is int
            and value["schemaVersion"] == 2
            and value["deviceId"] == self.config.device_id
        )
        for field in ("bindingId", "ownerAccountId"):
            require(
                type(value[field]) is str
                and 1 <= len(value[field]) <= 128
                and all(ord(c) >= 33 and ord(c) != 127 for c in value[field])
            )
        for field in ("ownershipEpoch", "authVersion"):
            require(type(value[field]) is int and 1 <= value[field] <= MAX_INTEGER)
        issued, expires, now = (
            _timestamp(value["issuedAt"]),
            _timestamp(value["expiresAt"]),
            self.clock(),
        )
        require(
            issued <= now + 30 and 0 < expires - issued <= 300 and expires > now,
            "MODEL_PROVIDER_LEASE_EXPIRED",
        )
        require(type(value["providers"]) is list and len(value["providers"]) <= 32)
        current: dict[str, tuple[int, bytes]] = {}
        for item in value["providers"]:
            _provider(item)
            require(item["providerId"] not in current)
            current[item["providerId"]] = (
                int(item["configVersion"]),
                hashlib.sha256(
                    json.dumps(
                        item, sort_keys=True, separators=(",", ":"), ensure_ascii=True
                    ).encode()
                ).digest(),
            )
        identity = tuple(value[k] for k in sorted(BINDING))
        if self.binding is not None:
            require(value["ownershipEpoch"] >= self.binding["ownershipEpoch"])
            if value["ownershipEpoch"] == self.binding["ownershipEpoch"]:
                require(
                    value["bindingId"] == self.binding["bindingId"]
                    and value["ownerAccountId"] == self.binding["ownerAccountId"]
                    and value["authVersion"] >= self.binding["authVersion"]
                )
        if identity == self.history_identity:
            require(set(self.history) <= set(current))
            for ident, before in self.history.items():
                after = current[ident]
                require(after[0] > before[0] or after == before)
        return identity, current, self.monotonic() + min(300, expires - now)

    async def refresh(self) -> dict[str, Any]:
        async with self.lock:
            try:
                try:
                    key = (
                        (
                            await asyncio.to_thread(
                                private_bytes, self.config.key_file, 1024, secret=True
                            )
                        )
                        .decode()
                        .strip()
                    )
                    require(re.fullmatch(r"[\x21-\x7e]{16,256}", key) is not None)
                except (BridgeAuthError, UnicodeError):
                    raise BridgeAuthError("MODEL_PROVIDER_LOCAL_CONFIG_INVALID", 503) from None
                value = await self._request("GET", key)
                identity, history, deadline = self._validate(value)
                # A new identity or revocation must invalidate the previous lease even
                # if acknowledging the replacement encounters a transient outage.
                if identity != self.history_identity or history != self.history:
                    self.clear()
                self.history_identity, self.history = identity, history
                self.binding = {k: value[k] for k in BINDING}
                versions = [
                    {"providerId": p["providerId"], "configVersion": p["configVersion"]}
                    for p in value["providers"]
                ]
                body = {
                    "schemaVersion": 2,
                    "status": "loaded",
                    **{k: value[k] for k in BINDING - {"deviceId"}},
                    "providers": versions,
                }
                ack = await self._request("POST", key, body)
                require(
                    set(ack) == {"accepted", "providers"}
                    and ack["accepted"] is True
                    and type(ack["providers"]) is list
                )
                require(
                    all(
                        type(p) is dict
                        and set(p) == {"providerId", "configVersion"}
                        and type(p["providerId"]) is str
                        and type(p["configVersion"]) is str
                        for p in ack["providers"]
                    )
                )
                require(
                    sorted(ack["providers"], key=lambda p: p["providerId"])
                    == sorted(versions, key=lambda p: p["providerId"])
                )
                self.snapshot = {
                    **value,
                    # Providers are device-wide services. Keep the legacy field
                    # in the versioned wire snapshot, but do not require a
                    # separate per-product grant (including old zhijun-only rows).
                    "providers": [p for p in value["providers"] if p["enabled"]],
                }
                self.deadline = deadline
                self.last_error = None
                return self.active()
            except BridgeAuthError as exc:
                self.last_error = exc.code
                if exc.code != "MODEL_PROVIDER_TEMPORARILY_UNAVAILABLE":
                    self.clear()
                elif self.snapshot is not None and (
                    self.monotonic() >= self.deadline
                    or self.clock() >= _timestamp(self.snapshot["expiresAt"])
                ):
                    self.clear()
                raise

    async def close(self) -> None:
        self.clear()
        await self.client.aclose()
