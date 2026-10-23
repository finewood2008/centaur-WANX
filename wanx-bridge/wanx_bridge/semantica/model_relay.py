"""Private STARLINK model callback using WANX public HTTP APIs only."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import re
import sqlite3
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import jsonschema
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from referencing.exceptions import Unresolvable
from starlette.requests import ClientDisconnect

from ..admin_client import BridgeUpstreamError
from .desktop import APPS, DesktopConfig, DesktopError, request_json, strict_json
from .desktop_routes import bounded_body, live_request


def encoded(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def local(url: str) -> bool:
    hostname = urlsplit(url).hostname
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname or "").is_loopback
    except ValueError:
        return False


class ModelLedger:
    """Bridge-owned replay and usage records; contains no prompts or model credentials."""

    def __init__(self, directory: Path):
        self.path = directory / "semantica-models.sqlite3"

    def record(self, nonce: str | None = None, usage: dict | None = None) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with sqlite3.connect(self.path, timeout=10) as db:
            self.path.chmod(0o600)
            db.executescript("""
                CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, observed REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, recorded REAL NOT NULL, payload TEXT NOT NULL);
            """)
            now = time.time()
            if nonce is not None:
                db.execute("DELETE FROM nonces WHERE observed < ?", (now - 180,))
                try:
                    db.execute("INSERT INTO nonces VALUES (?, ?)", (nonce, now))
                except sqlite3.IntegrityError as exc:
                    raise DesktopError("MODEL_REPLAY_DENIED", 409) from exc
            if usage is not None:
                db.execute(
                    "INSERT INTO usage(recorded,payload) VALUES (?, ?)", (now, encoded(usage))
                )


class ModelRelay:
    def __init__(
        self,
        admin,
        config_file: Path,
        state_dir: Path,
        *,
        service_url: str | None = None,
        box_id: str | None = None,
        transport=None,
    ):
        self.admin, self.config_file, self.service_url = admin, config_file, service_url
        self.box_id = box_id
        self.ledger = ModelLedger(state_dir)
        self.client = httpx.AsyncClient(
            trust_env=False, follow_redirects=False, transport=transport
        )
        self.slots = asyncio.Semaphore(4)
        self.users: dict[int, tuple[asyncio.Semaphore, int]] = {}
        self.pending = 0

    async def close(self):
        await self.client.aclose()

    async def _get(self, path: str) -> list:
        response = await self.admin._admin("GET", path)
        if response.status_code != 200:
            raise DesktopError("MODEL_SERVICE_UNAVAILABLE")
        try:
            value = response.json()
        except ValueError as exc:
            raise DesktopError("MODEL_SERVICE_UNAVAILABLE") from exc
        if not isinstance(value, list):
            raise DesktopError("MODEL_SERVICE_UNAVAILABLE")
        return value

    async def _user(self, user_id: int):
        user = next((u for u in await self._get("/api/users") if u.get("id") == user_id), None)
        if (
            not user
            or user.get("disabled")
            or (
                user.get("role") != "admin"
                and "knowledge_bases" not in (user.get("permissions") or [])
            )
        ):
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)

    async def _catalog(self):
        providers = {p["id"]: p for p in await self._get("/api/admin/providers")}
        models = await self._get("/api/providers/resolved")
        items = []
        for model in models:
            provider = providers.get(model.get("provider_id"))
            if not provider or not provider.get("enabled") or "text" not in model.get("input", []):
                continue
            base = provider.get("base_url") or (
                "https://api.openai.com/v1" if provider.get("kind") == "openai" else ""
            )
            supported = provider.get("kind") in {"openai", "ollama"} and bool(base)
            revision = hashlib.sha256(encoded([provider, model]).encode()).hexdigest()
            items.append(
                {
                    "id": f"{provider['id']}:{model['model']}",
                    "provider_id": provider["id"],
                    "model": model["model"],
                    "name": model.get("name", model["model"]),
                    "provider": provider["name"],
                    "location": "local" if local(base) else "external",
                    "revision": revision,
                    "available": supported,
                    "capabilities": ["text", "json_check_required"] if supported else [],
                    "context_window": model.get("context_window"),
                    "max_output_tokens": model.get("max_output_tokens"),
                }
            )
        return items, providers

    async def _authorize_job(
        self, config: DesktopConfig, actor: tuple[str, int], body: dict, selection: dict, nonce: str
    ):
        app, user_id = actor
        if body.get("purpose") not in {"extraction", "sensitive"}:
            raise DesktopError("MODEL_PURPOSE_DENIED", 403)
        if not isinstance(body.get("job_id"), str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{1,128}", body["job_id"]
        ):
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        payload = {
            "operation_id": nonce,
            "job_id": body["job_id"],
            "purpose": body["purpose"],
            "model_id": selection["id"],
            "model_revision": selection["revision"],
        }
        _, value = await request_json(
            self.client,
            "POST",
            config.service_url + "/api/integration/processing/authorize",
            headers=config.headers(user_id, app, nonce),
            payload=payload,
            timeout=10,
        )
        if value.get("authorized") is not True:
            raise DesktopError("MODEL_TASK_REVOKED", 403)

    async def _generate(
        self,
        provider: dict,
        selection: dict,
        text: str,
        schema: dict,
        body: dict,
        actor: tuple[str, int],
    ):
        try:
            jsonschema.validators.validator_for(schema).check_schema(schema)
        except jsonschema.SchemaError as exc:
            raise DesktopError("MODEL_INVALID_REQUEST", 422) from exc

        # Schemas are data; never allow validation to fetch a remote reference.
        def has_external_ref(value):
            if isinstance(value, dict):
                return any(
                    (
                        key in {"$ref", "$dynamicRef"}
                        and (not isinstance(item, str) or not item.startswith("#"))
                    )
                    or has_external_ref(item)
                    for key, item in value.items()
                )
            return isinstance(value, list) and any(has_external_ref(item) for item in value)

        if has_external_ref(schema):
            raise DesktopError("MODEL_INVALID_REQUEST", 422)
        base = provider.get("base_url") or "https://api.openai.com/v1"
        parsed = urlsplit(base)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise DesktopError("MODEL_CONFIG_INVALID", 409)
        messages = [
            {
                "role": "system",
                "content": "Return only a complete JSON object matching this schema. Never call tools.\n"
                + encoded(schema),
            },
            {"role": "user", "content": text},
        ]
        limit = min(selection.get("max_output_tokens") or 4096, 4096)
        if provider["kind"] == "ollama":
            url = base.rstrip("/").removesuffix("/v1") + "/api/chat"
            payload = {
                "model": selection["model"],
                "messages": messages,
                "format": schema,
                "stream": False,
                "think": False,
                "options": {"temperature": 0, "num_predict": limit},
            }
        else:
            url = base.rstrip("/") + "/chat/completions"
            payload = {
                "model": selection["model"],
                "messages": messages,
                "stream": False,
                "temperature": 0,
                "max_tokens": limit,
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {"name": "starklink_result", "schema": schema},
                },
            }
        # Use a fresh request, without the shared client's response cookie jar.
        request = httpx.Request(
            "POST",
            url,
            headers={"authorization": "Bearer " + provider.get("api_key", "")},
            json=payload,
        )
        request.extensions["timeout"] = {"connect": 10, "read": 300, "write": 30, "pool": 10}
        async with asyncio.timeout(300):
            response = await self.client.send(request, stream=True)
            try:
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 1024 * 1024:
                        raise DesktopError("MODEL_INVALID_OUTPUT", 502)
            finally:
                await response.aclose()
        if response.status_code != 200:
            raise DesktopError("MODEL_CALL_FAILED", 502)
        try:
            result = strict_json(raw)
            if not isinstance(result, dict):
                raise ValueError()
            usage = result.get("usage")
            if provider["kind"] == "ollama":
                usage = {
                    k: result[k] for k in ("prompt_eval_count", "eval_count") if k in result
                } or None
            if usage is not None:
                if not isinstance(usage, dict):
                    raise ValueError()
                # Store only counters, never arbitrary upstream metadata.
                usage = {
                    k: v
                    for k, v in usage.items()
                    if k
                    in {
                        "prompt_tokens",
                        "completion_tokens",
                        "total_tokens",
                        "prompt_eval_count",
                        "eval_count",
                    }
                    and type(v) is int
                    and v >= 0
                } or None
            await asyncio.to_thread(
                self.ledger.record,
                usage={
                    "user_id": actor[1],
                    "application_id": actor[0],
                    "job_id": body.get("job_id"),
                    "purpose": body.get("purpose", "check"),
                    "model_id": selection["id"],
                    "revision": selection["revision"],
                    "usage": usage,
                    "accounting": "reported" if usage else "not_returned",
                },
            )
            message = (
                result["message"]
                if provider["kind"] == "ollama"
                else result["choices"][0]["message"]
            )
            if (
                not isinstance(message, dict)
                or message.get("tool_calls")
                or not isinstance(message.get("content"), str)
            ):
                raise ValueError()
            content = message["content"].strip()
            if content.startswith("```"):
                content = content.split("\n", 1)[1].rsplit("```", 1)[0].strip()
            value = strict_json(content)
            if not isinstance(value, dict):
                raise ValueError()
            jsonschema.validate(value, schema)
        except (
            ValueError,
            KeyError,
            IndexError,
            TypeError,
            jsonschema.ValidationError,
            Unresolvable,
        ) as exc:
            raise DesktopError("MODEL_INVALID_OUTPUT", 502) from exc
        return {"text": encoded(value), "usage": usage}

    async def invoke(self, request: Request):
        if request.headers.get("origin") is not None:
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        # This callback belongs only to the private loopback listener. Never use
        # forwarded headers as proof that a request came from the local service.
        try:
            peer = ipaddress.ip_address(request.client.host if request.client else "")
        except ValueError as exc:
            raise DesktopError("MODEL_AUTH_REQUIRED", 403) from exc
        if not (
            peer.is_loopback or getattr(peer, "ipv4_mapped", None) and peer.ipv4_mapped.is_loopback
        ):
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        async with asyncio.timeout(30):
            raw = await bounded_body(request, 512 * 1024)
        config = await asyncio.to_thread(
            DesktopConfig.load, self.config_file, self.service_url, self.box_id
        )
        stamp, nonce, signature = (
            request.headers.get(k, "")
            for k in ("x-starklink-time", "x-starklink-nonce", "x-starklink-signature")
        )
        if (
            any(
                len(request.headers.getlist(k)) != 1
                for k in ("x-starklink-time", "x-starklink-nonce")
            )
            or not re.fullmatch(r"[0-9]{10,12}", stamp)
            or abs(time.time() - int(stamp)) > 60
            or not re.fullmatch(r"[a-f0-9]{32}", nonce)
        ):
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        # Legacy managed callers may still sign. Standalone relies on this
        # private listener plus WANX user checks and live task authorization.
        if "x-starklink-signature" in request.headers:
            expected = hmac.new(
                config.service_token.encode(),
                stamp.encode() + b"." + nonce.encode() + b"." + raw,
                hashlib.sha256,
            ).hexdigest()
            if (
                not config.service_token
                or len(request.headers.getlist("x-starklink-signature")) != 1
                or not re.fullmatch(r"[a-f0-9]{64}", signature)
                or not hmac.compare_digest(signature, expected)
            ):
                raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        await asyncio.to_thread(self.ledger.record, nonce)
        try:
            body = strict_json(raw)
            box, app, actor = json.loads(body["owner"])
            app_id, user_id = actor.rsplit(":", 1)
            if (
                box != config.box_id
                or app != config.application_id
                or app_id not in APPS
                or not user_id.isdigit()
                or int(user_id) < 1
            ):
                raise ValueError()
            actor = app_id, int(user_id)
            action = body["action"]
            if action not in {"catalog", "check", "infer"}:
                raise ValueError()
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            raise DesktopError("MODEL_AUTH_REQUIRED", 403) from exc
        await self._user(actor[1])
        items, _ = await self._catalog()
        if action == "catalog":
            return {"items": items, "checked_at": time.time()}
        selected = body.get("selection")
        if not isinstance(selected, dict):
            raise DesktopError("MODEL_INVALID_REQUEST", 422)
        selection = next(
            (m for m in items if m["id"] == selected.get("id") and m["available"]), None
        )
        if selection is None:
            raise DesktopError("MODEL_UNAVAILABLE", 409)
        if selection["revision"] != selected.get("revision"):
            raise DesktopError("MODEL_CONFIG_CHANGED", 409)
        if action == "check":
            text = '合成连通性测试，请返回 {"ok":true}。不含用户资料。'
            schema = {
                "type": "object",
                "properties": {"ok": {"type": "boolean", "const": True}},
                "required": ["ok"],
                "additionalProperties": False,
            }
        else:
            text, schema = body.get("text"), body.get("schema")
            if (
                not isinstance(text, str)
                or not isinstance(schema, dict)
                or len(text.encode()) > 200000
            ):
                raise DesktopError("MODEL_INPUT_TOO_LARGE", 413)
        if self.pending >= 32:
            raise DesktopError("MODEL_BUSY", 429)
        self.pending += 1
        user_limit, users = self.users.get(actor[1], (asyncio.Semaphore(2), 0))
        self.users[actor[1]] = user_limit, users + 1

        async def permitted():
            await self._user(actor[1])
            latest, providers = await self._catalog()
            if not any(
                m["id"] == selection["id"]
                and m["revision"] == selection["revision"]
                and m["available"]
                for m in latest
            ):
                raise DesktopError("MODEL_CONFIG_CHANGED", 409)
            if action == "infer":
                await self._authorize_job(config, actor, body, selection, nonce)
            return providers[selection["provider_id"]]

        async def work():
            async with user_limit, self.slots:
                provider = await permitted()
                audit = {
                    "job_id": body["job_id"] if action == "infer" else None,
                    "purpose": body["purpose"] if action == "infer" else "check",
                }
                result = await self._generate(provider, selection, text, schema, audit, actor)
                await permitted()
                return result

        async def watch():
            while True:
                await permitted()
                await asyncio.sleep(1)

        drained = asyncio.Event()
        drained.set()
        try:
            async with asyncio.timeout(320):
                return await live_request(request, work(), watch(), drained)
        finally:
            self.pending -= 1
            remaining = self.users[actor[1]][1] - 1
            if remaining:
                self.users[actor[1]] = user_limit, remaining
            else:
                self.users.pop(actor[1], None)

    def register(self, app: FastAPI):
        @app.post("/internal/starklink/models", include_in_schema=False)
        async def callback(request: Request):
            try:
                value = await self.invoke(request)
                return JSONResponse(value, headers={"Cache-Control": "no-store"})
            except DesktopError as exc:
                return JSONResponse(
                    {"code": exc.code, "message": exc.message},
                    status_code=exc.status,
                    headers={"Cache-Control": "no-store"},
                )
            except ClientDisconnect:
                return Response(status_code=499)
            except (httpx.HTTPError, BridgeUpstreamError, TimeoutError, OSError, sqlite3.Error):
                return JSONResponse(
                    {"code": "MODEL_SERVICE_UNAVAILABLE", "message": None},
                    status_code=503,
                    headers={"Cache-Control": "no-store"},
                )
