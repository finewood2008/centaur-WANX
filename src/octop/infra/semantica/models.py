"""Device-local, task-authorized access to WANX's existing Provider models."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import time
from collections.abc import Awaitable, Callable, Mapping
from functools import partial
from types import SimpleNamespace
from typing import Any
from urllib.parse import urlsplit

from octop.infra.agents.providers.probe import build_probe_chat_model
from octop.infra.agents.providers.resolved import list_resolved_models
from octop.infra.semantica.client import SemanticaClient, SemanticaError
from octop.infra.users.permissions import user_has_permission

_NONCES: dict[str, float] = {}
_LIMIT = asyncio.Semaphore(4)
_USER_LIMITS: dict[int, asyncio.Semaphore] = {}


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _local(url: str | None) -> bool:
    parsed = urlsplit(url or "")
    if parsed.hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        return False


def _catalog(services: Any) -> tuple[list[dict[str, Any]], dict[int, Any]]:
    rows = services.provider_repo.list_all()
    by_id = {r.id: r for r in rows}
    items = []
    for entry in list_resolved_models(rows):
        row = by_id[entry["provider_id"]]
        if "text" not in entry["input"]:
            continue
        revision = hashlib.sha256(
            _json([row.id, row.kind, row.base_url, row.api_key, row.extra_json, entry]).encode()
        ).hexdigest()
        items.append(
            {
                "id": str(row.id) + ":" + entry["model"],
                "provider_id": row.id,
                "model": entry["model"],
                "name": entry["name"],
                "provider": row.name,
                "location": "local" if _local(row.base_url) else "external",
                "revision": revision,
                "available": True,
                "capabilities": ["text", "json_check_required"],
                "context_window": entry.get("context_window"),
                "max_output_tokens": entry.get("max_output_tokens"),
            }
        )
    return items, by_id


async def _generate(
    row: Any,
    selection: dict[str, Any],
    text: str,
    schema: dict[str, Any],
    record_usage: Callable[[Any], Awaitable[None]],
) -> dict[str, Any]:
    from langchain_core.messages import HumanMessage, SystemMessage
    from octop_harness.llm.session_header import aclose_session_http_clients

    from octop.infra.utils.llm_text import llm_text_content

    model = build_probe_chat_model(row, model_id=selection["model"])
    model.max_retries = 0
    if hasattr(model, "temperature"):
        model.temperature = 0
    output = min(selection.get("max_output_tokens") or 4096, 4096)
    messages = [
        SystemMessage(
            content="Return only a complete JSON object matching this schema. Never call tools.\n"
            + _json(schema)
        ),
        HumanMessage(content=text),
    ]
    try:
        kwargs = {"max_tokens": output}
        if _local(row.base_url) and (row.kind == "ollama" or ":11434" in (row.base_url or "")):
            kwargs["extra_body"] = {"think": False}
            kwargs["reasoning_effort"] = "none"
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "starklink_result", "schema": schema},
            }
        answer = await asyncio.wait_for(model.ainvoke(messages, **kwargs), timeout=300)
        await record_usage(getattr(answer, "usage_metadata", None))
        if getattr(answer, "tool_calls", None):
            raise SemanticaError("MODEL_INVALID_OUTPUT", 502)
        content = llm_text_content(answer)
        if len(content.encode()) > 512 * 1024:
            raise SemanticaError("MODEL_INVALID_OUTPUT", 502)
        cleaned = content.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        value = json.loads(cleaned)
        if not isinstance(value, dict):
            raise ValueError("not an object")
        import jsonschema

        try:
            jsonschema.validate(value, schema)
        except jsonschema.ValidationError as exc:
            raise SemanticaError("MODEL_INVALID_OUTPUT", 502) from exc
        return {"text": _json(value), "usage": getattr(answer, "usage_metadata", None)}
    except (ValueError, KeyError) as exc:
        raise SemanticaError("MODEL_INVALID_OUTPUT", 502) from exc
    finally:
        await aclose_session_http_clients(model)


async def internal(
    raw: bytes,
    headers: Mapping[str, str],
    services: Any,
    is_disconnected: Callable[[], Awaitable[bool]],
) -> dict[str, Any]:
    try:
        if headers.get("origin"):
            raise SemanticaError("MODEL_AUTH_REQUIRED", 403)
        if len(raw) > 512 * 1024:
            raise SemanticaError("MODEL_INPUT_TOO_LARGE", 413)
        config = await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: json.loads((services.paths.root / "semantica.json").read_text()),
        )
        stamp = headers.get("x-starklink-time", "")
        nonce = headers.get("x-starklink-nonce", "")
        secret = str(config["service_token"])
        expected = hmac.new(
            secret.encode(),
            stamp.encode() + b"." + nonce.encode() + b"." + raw,
            hashlib.sha256,
        ).hexdigest()
        if (
            not stamp.isdigit()
            or abs(time.time() - int(stamp)) > 60
            or len(nonce) != 32
            or not hmac.compare_digest(expected, headers.get("x-starklink-signature", ""))
        ):
            raise SemanticaError("MODEL_AUTH_REQUIRED", 403)
        now = time.time()
        for key in list(_NONCES):
            if _NONCES[key] < now - 120:
                del _NONCES[key]
        if nonce in _NONCES:
            raise SemanticaError("MODEL_REPLAY_DENIED", 409)
        _NONCES[nonce] = now
        body = json.loads(raw)
        box, app, actor = json.loads(body["owner"])
        if box != config["box_id"] or app != config["application_id"]:
            raise SemanticaError("MODEL_AUTH_REQUIRED", 403)
        team = actor == "team:wanx"
        if team:
            actor = body.get("actor_id", "")
        app_id, user_id = actor.rsplit(":", 1)
        if app_id not in {"wanx", "semantica", "centaurai.wanx.semantica"} or not user_id.isdigit():
            raise SemanticaError("MODEL_AUTH_REQUIRED", 403)
        user = await asyncio.get_running_loop().run_in_executor(
            None, services.user_repo.get, int(user_id)
        )
        if (
            not user
            or (team and user.role != "admin")
            or user.disabled
            or not user_has_permission(
                SimpleNamespace(is_admin=user.role == "admin", permissions=user.permissions),
                "knowledge_bases",
            )
        ):
            raise SemanticaError("MODEL_AUTH_REQUIRED", 403)
        items, rows = await asyncio.get_running_loop().run_in_executor(None, _catalog, services)
        if body["action"] == "catalog":
            return {"items": items, "checked_at": now}
        requested = body["selection"]
        selection = next((m for m in items if m["id"] == requested["id"]), None)
        if selection is None:
            raise SemanticaError("MODEL_UNAVAILABLE", 409)
        if selection["revision"] != requested["revision"]:
            raise SemanticaError("MODEL_CONFIG_CHANGED", 409)
        action = body["action"]
        if action == "check":
            text = '合成连通性测试，请返回 {"ok":true}。不含用户资料。'
            schema = {
                "type": "object",
                "properties": {"ok": {"type": "boolean", "const": True}},
                "required": ["ok"],
                "additionalProperties": False,
            }
        elif action == "infer":
            if body.get("purpose") not in {"extraction", "sensitive"}:
                raise SemanticaError("MODEL_PURPOSE_DENIED", 403)
            service = SemanticaClient(config, int(user_id), app_id, team=team)
            await service.request(
                "POST",
                "/processing/authorize",
                payload={
                    "operation_id": nonce,
                    "job_id": body["job_id"],
                    "purpose": body["purpose"],
                    "model_id": selection["id"],
                    "model_revision": selection["revision"],
                },
            )
            text = body["text"]
            schema = body["schema"]
            if (
                not isinstance(text, str)
                or not isinstance(schema, dict)
                or len(text.encode()) > 200000
            ):
                raise SemanticaError("MODEL_INPUT_TOO_LARGE", 413)
        else:
            raise SemanticaError("MODEL_OPERATION_DENIED", 403)

        async def record_usage(usage: Any) -> None:
            # Provider usage is retained even when JSON validation fails. Do not
            # invent zero usage or create a conversation/Agent for accounting.
            await asyncio.get_running_loop().run_in_executor(
                None,
                partial(
                    services.audit_repo.write,
                    actor=user.username,
                    action="starklink.model.usage",
                    target=str(body.get("job_id") or "model-check"),
                    payload=_json(
                        {
                            "application_id": app,
                            "warehouse_id": body.get("warehouse_id"),
                            "purpose": body.get("purpose", "check"),
                            "model": selection["model"],
                            "provider_id": selection["provider_id"],
                            "revision": selection["revision"],
                            "location": selection["location"],
                            "usage": usage,
                            "accounting": "reported" if usage else "not_returned",
                        }
                    ),
                ),
            )

        user_limit = _USER_LIMITS.setdefault(int(user_id), asyncio.Semaphore(2))
        async with user_limit, _LIMIT:
            latest, rows = await asyncio.get_running_loop().run_in_executor(
                None, _catalog, services
            )
            if not any(
                m["id"] == selection["id"] and m["revision"] == selection["revision"]
                for m in latest
            ):
                raise SemanticaError("MODEL_CONFIG_CHANGED", 409)
            # Re-check authorization after waiting for a capacity slot.
            if action == "infer":
                await service.request(
                    "POST",
                    "/processing/authorize",
                    payload={
                        "operation_id": nonce,
                        "job_id": body["job_id"],
                        "purpose": body["purpose"],
                        "model_id": selection["id"],
                        "model_revision": selection["revision"],
                    },
                )
            task = asyncio.create_task(
                _generate(
                    rows[selection["provider_id"]],
                    selection,
                    text,
                    schema,
                    record_usage,
                )
            )
            try:
                while not task.done():
                    if await is_disconnected():
                        task.cancel()
                        raise SemanticaError("MODEL_CANCELLED", 409)
                    await asyncio.wait({task}, timeout=0.25)
                result = await task
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        return result
    except SemanticaError:
        raise
    except Exception:
        raise SemanticaError("MODEL_CALL_FAILED", 502) from None
