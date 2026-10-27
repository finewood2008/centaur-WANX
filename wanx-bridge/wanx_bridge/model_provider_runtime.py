"""Project leased device providers into WANX through a private inference proxy.

WANX stores only a revocable local proxy credential. Supplier credentials never
leave the in-memory catalog, including on errors or provider-list responses.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import inspect
import ipaddress
import json
import logging
import re
import secrets
import socket
from collections.abc import AsyncIterator, Callable
from typing import Any

import anyio
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .admin_client import AdminClient, BridgeUpstreamError
from .config import BridgeAuthError
from .model_provider_catalog import BINDING, ModelProviderCatalog, public_https
from .oidc import loopback_origin

MAX_BODY = 8 * 1024 * 1024
MAX_RESPONSE = 32 * 1024 * 1024
MAX_MODELS = 512 * 1024
PREFIX = "admin-managed-"
MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}")
NON_CHAT = re.compile(
    r"(?:embed|rerank|whisper|tts|transcri|dall-e|(?:^|[-_/])image(?:$|[-_/])|audio)", re.I
)
logger = logging.getLogger(__name__)


def fail(code: str = "MODEL_PROVIDER_UPSTREAM_FAILED", status: int = 503) -> BridgeAuthError:
    return BridgeAuthError(code, status)


class PublicPinnedTransport(httpx.AsyncBaseTransport):
    """Resolve once, dial the validated address, and retain TLS hostname checks."""

    def __init__(self) -> None:
        # An IP origin must never pool a TLS connection across distinct hostnames.
        self.transport = httpx.AsyncHTTPTransport(
            trust_env=False, limits=httpx.Limits(max_connections=16, max_keepalive_connections=0)
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        public_https(str(request.url))
        try:
            async with asyncio.timeout(5):
                addresses = await asyncio.get_running_loop().getaddrinfo(
                    request.url.host, 443, type=socket.SOCK_STREAM
                )
            ips = [item[4][0] for item in addresses]
            if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
                raise fail("MODEL_PROVIDER_DESTINATION_DENIED")
            target = next((ip for ip in ips if ":" not in ip), ips[0])
            headers = request.headers.copy()
            headers["host"] = request.url.host
            pinned = httpx.Request(
                request.method,
                request.url.copy_with(host=target),
                headers=headers,
                stream=request.stream,
                extensions={**request.extensions, "sni_hostname": request.url.host},
            )
            return await self.transport.handle_async_request(pinned)
        except (OSError, ValueError, TimeoutError):
            raise fail("MODEL_PROVIDER_DESTINATION_UNAVAILABLE") from None

    async def aclose(self) -> None:
        await self.transport.aclose()


def _fingerprint(snapshot: dict[str, Any], provider: dict[str, Any]) -> str:
    stable_provider = {k: v for k, v in provider.items() if k != "credentialExpiresAt"}
    value = [{key: snapshot[key] for key in sorted(BINDING)}, stable_provider]
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _models(values: Any, secret: str) -> list[dict[str, Any]]:
    if not isinstance(values, list) or len(values) > 4096:
        raise fail("MODEL_PROVIDER_MODELS_INVALID")
    result: dict[str, dict[str, Any]] = {}
    for value in values:
        row = {"id": value} if isinstance(value, str) else value
        if not isinstance(row, dict):
            raise fail("MODEL_PROVIDER_MODELS_INVALID")
        ident = row.get("id")
        if not isinstance(ident, str) or not MODEL_ID.fullmatch(ident) or secret in ident:
            raise fail("MODEL_PROVIDER_MODELS_INVALID")
        task = str(row.get("type") or row.get("task") or "")
        if NON_CHAT.search(ident) or NON_CHAT.search(task):
            continue
        model: dict[str, Any] = {"id": ident, "name": ident, "enabled": True}
        # Ordinary WANX callers still use Chat Completions. Builder's Responses
        # route must not opt those callers into native-tool-search implicitly.
        for key in (
            "context_window",
            "context_length",
            "max_tokens",
            "max_input_tokens",
            "max_output_tokens",
        ):
            number = row.get(key)
            if type(number) is int and 0 < number <= 100_000_000:
                model[key] = number
        if (
            isinstance(row.get("name"), str)
            and len(row["name"]) <= 200
            and secret not in row["name"]
        ):
            model["name"] = row["name"]
        if type(row.get("reasoning")) is bool:
            model["reasoning"] = row["reasoning"]
        if isinstance(row.get("input"), list) and all(
            isinstance(x, str) and x in {"text", "image", "audio"} for x in row["input"]
        ):
            model["input"] = row["input"]
        result[ident] = model
    return list(result.values())


class ModelProviderRuntime:
    def __init__(
        self,
        catalog: ModelProviderCatalog,
        admin: AdminClient,
        private_issuer: str,
        *,
        authority_check: Callable[[dict[str, Any]], Any] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.catalog, self.admin = catalog, admin
        self.origin = loopback_origin(private_issuer)
        self.authority_check = authority_check
        self.client = httpx.AsyncClient(
            transport=transport or PublicPinnedTransport(),
            trust_env=False,
            follow_redirects=False,
            timeout=httpx.Timeout(120, connect=10),
        )
        self.note = "wanx-admin-model-provider-v1:" + catalog.config.device_id
        self.entries: dict[str, dict[str, Any]] = {}
        self.lock = asyncio.Lock()
        self.closed = False
        self.requests: set[asyncio.Task[Any]] = set()
        self.last_error: str | None = None

    async def _read(self, response: httpx.Response, limit: int) -> bytes:
        data = bytearray()
        async for chunk in response.aiter_bytes():
            if len(data) + len(chunk) > limit:
                raise fail("MODEL_PROVIDER_RESPONSE_TOO_LARGE")
            data.extend(chunk)
        return bytes(data)

    async def _admin(self, method: str, path: str, body: Any = None) -> Any:
        response = await self.admin._admin(
            method, path, **({"json": body} if body is not None else {})
        )
        if response.status_code not in {200, 201}:
            raise fail("MODEL_PROVIDER_WANX_UPDATE_FAILED")
        try:
            return response.json()
        except ValueError:
            raise fail("MODEL_PROVIDER_WANX_UPDATE_FAILED") from None

    async def _discover(self, provider: dict[str, Any]) -> list[dict[str, Any]]:
        if provider["allowedModels"]:
            return _models(provider["allowedModels"], provider["apiKey"])
        request = self.client.build_request(
            "GET",
            public_https(provider["baseUrl"]) + "/models",
            headers={"Authorization": "Bearer " + provider["apiKey"], "Accept": "application/json"},
        )
        request.headers.pop("cookie", None)
        async with asyncio.timeout(20):
            response = await self.client.send(request, stream=True)
            try:
                if response.status_code != 200:
                    raise fail("MODEL_PROVIDER_MODELS_UNAVAILABLE")
                raw = await self._read(response, MAX_MODELS)
            finally:
                await response.aclose()
        try:
            data = json.loads(raw)
            return _models(data["data"], provider["apiKey"])
        except (ValueError, KeyError, TypeError):
            raise fail("MODEL_PROVIDER_MODELS_INVALID") from None

    async def reconcile(self) -> None:
        async with self.lock:
            if self.closed:
                return
            refresh_error = None
            try:
                await self.catalog.refresh()
            except BridgeAuthError as exc:
                refresh_error = exc
            try:
                snapshot = self.catalog.active()
                await self._authority(snapshot)
            except BridgeAuthError as exc:
                snapshot = None
                refresh_error = exc
            rows = await self._admin("GET", "/api/admin/providers")
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise fail("MODEL_PROVIDER_WANX_UPDATE_FAILED")
            desired = {p["providerId"]: p for p in snapshot["providers"]} if snapshot else {}
            desired = {ident: p for ident, p in desired.items() if p["enabled"]}
            for row in rows:
                if row.get("note") == self.note and str(row.get("name", "")).startswith(PREFIX):
                    ident = row["name"][len(PREFIX) :]
                    if ident not in desired:
                        self.entries.pop(ident, None)
                        if row.get("enabled") or row.get("models"):
                            await self._admin(
                                "PATCH",
                                f"/api/admin/providers/{row['id']}",
                                {"enabled": False, "models": []},
                            )
                            row.update(enabled=False, models=[])
            provider_error = None
            for ident, provider in desired.items():
                name = PREFIX + ident
                existing = next((row for row in rows if row.get("name") == name), None)
                if existing is not None and existing.get("note") != self.note:
                    provider_error = fail("MODEL_PROVIDER_NAME_CONFLICT")
                    self.entries.pop(ident, None)
                    continue
                fingerprint = _fingerprint(snapshot, provider)
                entry = self.entries.get(ident)
                unchanged = entry is not None and entry["fingerprint"] == fingerprint
                if not unchanged or snapshot.get("schemaVersion") == 3:
                    # V3 refreshes /models on every poll. Keep the authorized
                    # entry usable while an unchanged provider is rediscovered.
                    if not unchanged:
                        self.entries.pop(ident, None)
                    try:
                        models = await self._discover(provider)
                    except (BridgeAuthError, httpx.HTTPError, TimeoutError, OSError) as exc:
                        self.entries.pop(ident, None)
                        provider_error = (
                            exc
                            if isinstance(exc, BridgeAuthError)
                            else fail("MODEL_PROVIDER_MODELS_UNAVAILABLE")
                        )
                        if existing is not None and (
                            existing.get("enabled") or existing.get("models")
                        ):
                            await self._admin(
                                "PATCH",
                                f"/api/admin/providers/{existing['id']}",
                                {"enabled": False, "models": []},
                            )
                            existing.update(enabled=False, models=[])
                        continue
                    entry = {
                        "fingerprint": fingerprint,
                        "key": entry["key"]
                        if entry and entry["fingerprint"] == fingerprint
                        else secrets.token_urlsafe(32),
                        "models": models,
                    }
                    if unchanged:
                        # Removed models stop immediately, even if persisting
                        # the refreshed WANX row takes longer than discovery.
                        self.entries[ident] = entry
                wanted = {
                    "name": name,
                    "kind": "openai",
                    "base_url": self.origin + f"/model-providers/{ident}/v1",
                    "api_key": entry["key"],
                    "note": self.note,
                    "models": entry["models"],
                }
                if existing is None:
                    existing = await self._admin("POST", "/api/admin/providers", wanted)
                    rows.append(existing)
                else:
                    patch = {
                        k: v
                        for k, v in wanted.items()
                        if k not in {"name", "models"} and existing.get(k) != v
                    }
                    # WANX decorates model rows with inferred reasoning metadata.
                    # Compare supplied fields so decoration does not reload every poll.
                    actual_models = existing.get("models", [])
                    if len(actual_models) != len(entry["models"]) or any(
                        not isinstance(actual, dict)
                        or any(actual.get(k) != v for k, v in expected.items())
                        for actual, expected in zip(actual_models, entry["models"])
                    ):
                        patch["models"] = entry["models"]
                    if not existing.get("enabled"):
                        patch["enabled"] = True
                    if patch:
                        existing.update(
                            await self._admin(
                                "PATCH", f"/api/admin/providers/{existing['id']}", patch
                            )
                        )
                self.entries[ident] = entry
            # Re-check after network requests; a catalog lease may expire during discovery.
            if desired:
                try:
                    await self._authority(self.catalog.active())
                except BridgeAuthError as exc:
                    self.entries.clear()
                    for row in rows:
                        if (
                            row.get("note") == self.note
                            and str(row.get("name", "")).startswith(PREFIX)
                            and (row.get("enabled") or row.get("models"))
                        ):
                            await self._admin(
                                "PATCH",
                                f"/api/admin/providers/{row['id']}",
                                {"enabled": False, "models": []},
                            )
                            row.update(enabled=False, models=[])
                    provider_error = exc
            active = await self._admin("GET", "/api/providers/active-model")
            if not isinstance(active, dict):
                raise fail("MODEL_PROVIDER_WANX_UPDATE_FAILED")
            valid = {
                (r.get("name"), m.get("id"))
                for r in rows
                if r.get("enabled") and r.get("base_url") and r.get("api_key")
                for m in r.get("models", [])
                if isinstance(m, dict)
                and m.get("enabled", True)
                and not NON_CHAT.search(str(m.get("id", "")))
            }
            if (active.get("provider_name"), active.get("model")) not in valid:
                candidate = next(
                    (
                        (PREFIX + ident, m["id"])
                        for ident in desired
                        if ident in self.entries
                        for m in self.entries[ident]["models"]
                    ),
                    None,
                )
                if candidate:
                    await self._admin(
                        "PUT",
                        "/api/providers/active-model",
                        {"provider_name": candidate[0], "model": candidate[1]},
                    )
            if provider_error is None and snapshot and snapshot.get("schemaVersion") == 3:
                try:
                    await self.catalog.acknowledge_applied()
                except BridgeAuthError:
                    self.entries.clear()
                    self.catalog.clear()
                    raise
            self.last_error = refresh_error.code if refresh_error else None
            if provider_error is not None:
                self.last_error = provider_error.code
                raise provider_error

    async def poll(self) -> None:
        reported = object()
        while not self.closed:
            try:
                await self.reconcile()
            except (BridgeAuthError, BridgeUpstreamError) as exc:
                self.last_error = exc.code
            except (httpx.HTTPError, TimeoutError, OSError, ValueError):
                self.last_error = "MODEL_PROVIDER_SYNC_FAILED"
            state = (self.last_error, len(self.entries))
            if state != reported:
                if self.last_error:
                    logger.warning("Model provider synchronization: %s", self.last_error)
                else:
                    logger.info(
                        "Model provider synchronization ready: %d providers", len(self.entries)
                    )
                reported = state
            await asyncio.sleep(self.catalog.config.interval)

    async def _authority(self, snapshot: dict[str, Any]) -> None:
        if self.authority_check is not None:
            result = self.authority_check(snapshot)
            if inspect.isawaitable(result):
                result = await result
            if result is False:
                raise fail("MODEL_PROVIDER_AUTHORIZATION_CHANGED", 403)

    async def _check(self, ident: str, credential: str, model: str) -> dict[str, Any]:
        if self.closed:
            raise fail("MODEL_PROVIDER_UNAVAILABLE")
        snapshot = self.catalog.active()
        await self._authority(snapshot)
        provider = next(
            (p for p in snapshot["providers"] if p["providerId"] == ident and p["enabled"]),
            None,
        )
        entry = self.entries.get(ident)
        if (
            provider is None
            or entry is None
            or entry["fingerprint"] != _fingerprint(snapshot, provider)
        ):
            raise fail("MODEL_PROVIDER_CHANGED", 403)
        if not hmac.compare_digest(credential.encode(), ("Bearer " + entry["key"]).encode()):
            raise fail("MODEL_PROVIDER_CREDENTIAL_INVALID", 401)
        if model not in {m["id"] for m in entry["models"]} or (
            provider["allowedModels"] and model not in provider["allowedModels"]
        ):
            raise fail("MODEL_PROVIDER_MODEL_DENIED", 403)
        return provider

    async def _watch(self, ident: str, credential: str, model: str) -> None:
        while True:
            await self._check(ident, credential, model)
            await asyncio.sleep(0.25)

    async def _proxy(
        self, ident: str, request: Request, endpoint: str = "chat/completions"
    ) -> Response:
        raw = bytearray()
        async with asyncio.timeout(30):
            async for chunk in request.stream():
                if len(raw) + len(chunk) > MAX_BODY:
                    raise fail("MODEL_PROVIDER_REQUEST_TOO_LARGE", 413)
                raw.extend(chunk)
        try:
            body = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except ValueError:
            raise fail("MODEL_PROVIDER_REQUEST_INVALID", 400) from None
        if not isinstance(body, dict) or not isinstance(body.get("model"), str):
            raise fail("MODEL_PROVIDER_REQUEST_INVALID", 400)
        if endpoint == "responses":
            if not isinstance(body.get("input", []), (str, list)) or (
                "stream" in body and type(body["stream"]) is not bool
            ):
                raise fail("MODEL_PROVIDER_REQUEST_INVALID", 400)
        elif not isinstance(body.get("messages"), list):
            raise fail("MODEL_PROVIDER_REQUEST_INVALID", 400)
        credential, model = request.headers.get("authorization", ""), body["model"]
        provider = await self._check(ident, credential, model)
        guard = asyncio.create_task(self._watch(ident, credential, model))
        pending: asyncio.Task[Any] | None = None
        upstream: httpx.Response | None = None

        async def cleanup() -> None:
            nonlocal upstream
            with anyio.CancelScope(shield=True):
                if (
                    upstream is None
                    and pending is not None
                    and pending.done()
                    and not pending.cancelled()
                ):
                    with contextlib.suppress(BaseException):
                        value = pending.result()
                        if isinstance(value, httpx.Response):
                            upstream = value
                for task in (pending, guard):
                    if task is not None:
                        task.cancel()
                        with contextlib.suppress(BaseException):
                            await task
                        self.requests.discard(task)
                if upstream is not None:
                    await upstream.aclose()

        try:
            upstream_request = self.client.build_request(
                "POST",
                public_https(provider["baseUrl"]) + "/" + endpoint,
                json=body,
                headers={
                    "Authorization": "Bearer " + provider["apiKey"],
                    "Content-Type": "application/json",
                    "Accept": "text/event-stream" if body.get("stream") else "application/json",
                },
            )
            upstream_request.headers.pop("cookie", None)
            pending = asyncio.create_task(self.client.send(upstream_request, stream=True))
            self.requests.update((guard, pending))
            done, _ = await asyncio.wait({pending, guard}, return_when=asyncio.FIRST_COMPLETED)
            if guard in done:
                await guard
            upstream = await pending
            self.requests.discard(pending)
            await self._check(ident, credential, model)
            if upstream.status_code != 200:
                raise fail()
            media = upstream.headers.get("content-type", "").split(";")[0].strip()
            expected = "text/event-stream" if body.get("stream") else "application/json"
            if media != expected:
                raise fail("MODEL_PROVIDER_RESPONSE_INVALID")
        except BaseException:
            await cleanup()
            raise

        async def stream() -> AsyncIterator[bytes]:
            nonlocal pending
            total = 0
            iterator = upstream.aiter_bytes().__aiter__()
            try:
                while True:
                    pending = asyncio.create_task(anext(iterator))
                    self.requests.add(pending)
                    done, _ = await asyncio.wait(
                        {pending, guard}, return_when=asyncio.FIRST_COMPLETED
                    )
                    if guard in done:
                        return
                    try:
                        chunk = await pending
                    except StopAsyncIteration:
                        return
                    finally:
                        self.requests.discard(pending)
                    await self._check(ident, credential, model)
                    total += len(chunk)
                    if total > MAX_RESPONSE:
                        return
                    yield chunk
            except (BridgeAuthError, httpx.HTTPError):
                return
            finally:
                await cleanup()

        return StreamingResponse(
            stream(), media_type=expected, headers={"Cache-Control": "no-store"}
        )

    def register_routes(self, app: FastAPI) -> None:
        async def proxy(provider_id: str, request: Request, endpoint: str) -> Response:
            try:
                return await self._proxy(provider_id, request, endpoint)
            except BridgeAuthError as exc:
                return JSONResponse(
                    {"error": {"code": exc.code, "message": exc.code}}, status_code=exc.status
                )
            except (httpx.HTTPError, TimeoutError, OSError):
                return JSONResponse(
                    {
                        "error": {
                            "code": "MODEL_PROVIDER_UPSTREAM_FAILED",
                            "message": "MODEL_PROVIDER_UPSTREAM_FAILED",
                        }
                    },
                    status_code=503,
                )

        @app.post("/model-providers/{provider_id}/v1/chat/completions", include_in_schema=False)
        async def chat(provider_id: str, request: Request) -> Response:
            return await proxy(provider_id, request, "chat/completions")

        @app.post("/model-providers/{provider_id}/v1/responses", include_in_schema=False)
        async def responses(provider_id: str, request: Request) -> Response:
            return await proxy(provider_id, request, "responses")

    async def close(self) -> None:
        self.closed = True
        self.entries.clear()
        tasks = list(self.requests)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.client.aclose()
        await self.admin.close()
        await self.catalog.close()
