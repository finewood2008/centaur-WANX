"""Box-side independent conversations and durable context snapshots."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any, cast

import httpx

from octop.infra.db.services import SharedServices
from octop.infra.dialogue.contracts import DialogueError, check_url, read_sse
from octop.infra.dialogue.pool import WanxModelPool

Owner = tuple[int, str]
ACTIVE = {"queued", "running"}


class DialogueService:
    def __init__(self, services: SharedServices, client: httpx.AsyncClient | None = None) -> None:
        self.services = services
        self.repo = services.repos.dialogue_repo
        self.pool = WanxModelPool(services)
        self.client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(65, connect=15), follow_redirects=False
        )
        self.locks: dict[str, asyncio.Lock] = {}
        self.tasks: dict[tuple[str, str], asyncio.Task[None]] = {}
        self.meter_groups: dict[tuple[str, str], tuple[Any, int]] = {}

    def lock(self, session_id: str) -> asyncio.Lock:
        return self.locks.setdefault(session_id, asyncio.Lock())

    async def connection(self, owner: Owner) -> tuple[str, dict[str, str]]:
        def resolve() -> tuple[str, dict[str, str]]:
            raw = self.services.settings_repo.get(f"dialogue.provider:{owner[1]}:{owner[0]}")
            row = self.services.provider_repo.get(int(raw)) if raw and raw.isdigit() else None
            if not row or not row.enabled or not row.api_key or not row.base_url:
                raise DialogueError("GATEWAY_NOT_CONFIGURED", 503)
            extra = json.loads(row.extra_json or "{}")
            if extra.get("dialogue_gateway") is not True:
                raise DialogueError("GATEWAY_NOT_CONFIGURED", 503)
            return check_url(row.base_url), {"Authorization": "Bearer " + row.api_key}

        return await asyncio.to_thread(resolve)

    async def uses_pool(self, owner: Owner) -> bool:
        # An existing platform binding (even invalid/disabled) must never fall back
        # to a different billing path after a quota or connection failure.
        return (
            await asyncio.to_thread(
                self.services.settings_repo.get, f"dialogue.provider:{owner[1]}:{owner[0]}"
            )
            is None
        )

    async def remote(self, owner: Owner, path: str) -> dict[str, Any]:
        if await self.uses_pool(owner):
            if path == "/models":
                return {"models": await self.pool.models()}
            if path == "/quota":
                return {
                    "source": "wanx_pool",
                    "remaining": None,
                    "pending": 0,
                    "billing": "provider_managed",
                }
            raise DialogueError("NOT_FOUND", 404)
        base, headers = await self.connection(owner)
        try:
            response = await self.client.get(base + path, headers=headers)
            if response.status_code != 200:
                raise DialogueError("GATEWAY_UNAVAILABLE", 503)
            data: dict[str, Any] = response.json()
            return data
        except (httpx.HTTPError, ValueError) as exc:
            raise DialogueError("GATEWAY_UNAVAILABLE", 503) from exc

    async def models(self, owner: Owner) -> list[dict[str, Any]]:
        data = await self.remote(owner, "/models")
        # Only public fields cross the application boundary.
        fields = {
            "id",
            "source",
            "name",
            "provider",
            "input_units",
            "output_units",
            "max_output_tokens",
            "max_input_bytes",
        }
        return [{k: v for k, v in m.items() if k in fields} for m in data.get("models", [])]

    async def list_sessions(self, owner: Owner) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self.repo.list, owner)

    async def _load(self, owner: Owner, session_id: str) -> dict[str, Any]:
        data = await asyncio.to_thread(self.repo.get, owner, session_id)
        if data is None or data.get("deleting"):
            raise DialogueError("NOT_FOUND", 404)
        repaired = False
        for group in data["groups"]:
            for answer in group["answers"]:
                if answer["status"] in ACTIVE and (session_id, answer["id"]) not in self.tasks:
                    answer.update(status="interrupted", error="SERVICE_RESTARTED")
                    repaired = True
        if repaired:
            await self._save(owner, data)
        return data

    @staticmethod
    def public(data: dict[str, Any]) -> dict[str, Any]:
        result = copy.deepcopy(data)
        result.pop("requests", None)
        for group in result["groups"]:
            group.pop("context", None)
        return result

    async def get(self, owner: Owner, session_id: str) -> dict[str, Any]:
        async with self.lock(session_id):
            return self.public(await self._load(owner, session_id))

    async def _save(self, owner: Owner, data: dict[str, Any]) -> None:
        data["revision"] = data.get("revision", 0) + 1
        write = asyncio.create_task(asyncio.to_thread(self.repo.save, owner, data))
        try:
            await asyncio.shield(write)
        except asyncio.CancelledError:
            # Keep the session lock until the SQL commit has really finished.
            await write
            raise

    @staticmethod
    def _dedupe(data: dict[str, Any], request_id: str, payload: dict[str, Any]) -> bool:
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        old = data["requests"].get(request_id)
        if old:
            if old != fingerprint:
                raise DialogueError("IDEMPOTENCY_CONFLICT", 409)
            return True
        if len(data["requests"]) >= 200:
            raise DialogueError("SESSION_LIMIT", 413)
        data["requests"][request_id] = fingerprint
        return False

    @staticmethod
    def _group(data: dict[str, Any], group_id: str) -> dict[str, Any]:
        for group in data["groups"]:
            if group["id"] == group_id:
                return cast(dict[str, Any], group)
        raise DialogueError("NOT_FOUND", 404)

    @staticmethod
    def _answer(data: dict[str, Any], answer_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        for group in data["groups"]:
            for answer in group["answers"]:
                if answer["id"] == answer_id:
                    return group, answer
        raise DialogueError("NOT_FOUND", 404)

    async def create(
        self, owner: Owner, request_id: str, prompt: str, models: list[str]
    ) -> dict[str, Any]:
        session_id = hashlib.sha256(f"{owner}:{request_id}".encode()).hexdigest()[:32]
        async with self.lock(session_id):
            existing = await asyncio.to_thread(self.repo.get, owner, session_id)
            if existing:
                self._dedupe(existing, request_id, {"prompt": prompt, "models": models})
                return self.public(await self._load(owner, session_id))
            data: dict[str, Any] = {
                "id": session_id,
                "title": prompt[:60],
                "revision": 0,
                "groups": [],
                "requests": {},
            }
            self._dedupe(data, request_id, {"prompt": prompt, "models": models})
            group: dict[str, Any] = {
                "id": uuid.uuid4().hex,
                "prompt": prompt,
                "context": [],
                "parent_answer": None,
                "answers": [],
            }
            data["groups"].append(group)
            await self._add(owner, data, group, models)
            return self.public(data)

    async def mutate(
        self, owner: Owner, session_id: str, request_id: str, action: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        async with self.lock(session_id):
            data = await self._load(owner, session_id)
            if self._dedupe(data, request_id, {"action": action, **payload}):
                return self.public(data)
            if action == "add":
                group = self._group(data, payload["group_id"])
                await self._add(owner, data, group, payload["models"])
            elif action == "continue":
                group, answer = self._answer(data, payload["answer_id"])
                if answer["status"] != "completed" or not answer["text"]:
                    raise DialogueError("ANSWER_NOT_COMPLETE", 409)
                if len(data["groups"]) >= 40:
                    raise DialogueError("SESSION_LIMIT", 413)
                context = [
                    *group["context"],
                    {"role": "user", "content": group["prompt"]},
                    {"role": "assistant", "content": answer["text"]},
                ]
                branch = {
                    "id": uuid.uuid4().hex,
                    "prompt": payload["prompt"],
                    "context": context,
                    "parent_answer": answer["id"],
                    "answers": [],
                }
                data["groups"].append(branch)
                await self._add(owner, data, branch, [answer["model"]])
            elif action == "retry":
                group, answer = self._answer(data, payload["answer_id"])
                if answer["status"] in ACTIVE:
                    raise DialogueError("ANSWER_RUNNING", 409)
                await self._validate_models(owner, [answer["model"]])
                answer.update(
                    text="",
                    status="queued",
                    error=None,
                    usage=None,
                    elapsed_ms=None,
                    accounting=None,
                    generation_id=uuid.uuid4().hex,
                )
                await self._save(owner, data)
                self._spawn(owner, data, group, answer)
            else:
                raise DialogueError("INVALID_ACTION")
            return self.public(data)

    async def _validate_models(self, owner: Owner, models: list[str]) -> dict[str, dict[str, Any]]:
        available = {m["id"]: m for m in await self.models(owner)}
        if (
            not 1 <= len(models) <= 3
            or len(set(models)) != len(models)
            or any(m not in available for m in models)
        ):
            raise DialogueError("MODEL_UNAVAILABLE", 400)
        return available

    async def _add(
        self, owner: Owner, data: dict[str, Any], group: dict[str, Any], models: list[str]
    ) -> None:
        available = await self._validate_models(owner, models)
        used = {a["model"] for a in group["answers"]}
        if used.intersection(models) or len(group["answers"]) + len(models) > 3:
            raise DialogueError("MODEL_LIMIT", 400)
        messages = [*group["context"], {"role": "user", "content": group["prompt"]}]
        size = sum(len(m["content"].encode()) for m in messages)
        if len(messages) > 80 or any(size > available[m]["max_input_bytes"] for m in models):
            raise DialogueError("CONTEXT_LIMIT", 413)
        answers = [
            {
                "id": uuid.uuid4().hex,
                "generation_id": uuid.uuid4().hex,
                "model": m,
                "name": available[m]["name"],
                "text": "",
                "status": "queued",
                "error": None,
                "usage": None,
                "elapsed_ms": None,
                "accounting": None,
            }
            for m in models
        ]
        group["answers"].extend(answers)
        await self._save(owner, data)
        for answer in answers:
            self._spawn(owner, data, group, answer)

    def _spawn(
        self, owner: Owner, data: dict[str, Any], group: dict[str, Any], answer: dict[str, Any]
    ) -> None:
        messages = copy.deepcopy([*group["context"], {"role": "user", "content": group["prompt"]}])
        key = (data["id"], answer["id"])
        from octop.infra.credits.metering import Meter
        from octop.infra.credits.runtime import Task, account_context
        from octop.infra.db.repos.metering import MeterRepo

        group_key = (data["id"], group["id"])
        previous = self.meter_groups.get(group_key)
        if previous:
            metered, count = previous
        else:
            meter = Meter(MeterRepo(self.services.db))
            identity = account_context.get()
            account = (
                identity["account_key"]
                if identity and identity["application_id"] == "centaurai.wanx.dialogue"
                else None
            )
            try:
                row = meter.create_task(
                    account, "centaurai.wanx.dialogue", uuid.uuid4().hex, user_id=owner[0]
                )
                meter.start(row["id"])
                metered, count = Task(meter, row["id"]), 0
            except Exception:
                logging.getLogger(__name__).warning("Usage recording unavailable", exc_info=True)
                metered, count = Task(meter, "", closed=True), 0
        self.meter_groups[group_key] = metered, count + 1
        task = asyncio.create_task(
            self._metered_run(
                group_key,
                metered,
                owner,
                data["id"],
                answer["id"],
                {
                    "request_id": answer["generation_id"],
                    "model": answer["model"],
                    "messages": messages,
                },
            )
        )
        self.tasks[key] = task
        task.add_done_callback(
            lambda _t: self.tasks.pop(key, None) if self.tasks.get(key) is _t else None
        )

    async def _metered_run(self, group_key: tuple[str, str], metered: Any, *args: Any) -> None:
        from octop.infra.credits.runtime import current

        token = current.set(metered)
        try:
            state = await self._run(*args)
            metered.failed = metered.failed or state == "failed"
            metered.cancelled = metered.cancelled or state == "stopped"
        except BaseException:
            metered.failed = True
            raise
        finally:
            current.reset(token)
            _, count = self.meter_groups[group_key]
            if count > 1:
                self.meter_groups[group_key] = metered, count - 1
            else:
                self.meter_groups.pop(group_key)
                metered.closed = True
                try:
                    metered.meter.finish(
                        metered.id,
                        "failed"
                        if metered.failed
                        else "cancelled"
                        if metered.cancelled
                        else "completed",
                    )
                except Exception:
                    logging.getLogger(__name__).warning(
                        "Usage finalization unavailable", exc_info=True
                    )

    async def _update(self, owner: Owner, session_id: str, answer_id: str, **changes: Any) -> None:
        async with self.lock(session_id):
            data = await asyncio.to_thread(self.repo.get, owner, session_id)
            if data is not None:
                _, answer = self._answer(data, answer_id)
                answer.update(changes)
                await self._save(owner, data)

    async def generate(self, owner: Owner, body: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        if await self.uses_pool(owner):
            async for item in self.pool.generate(owner[0], body):
                yield item
            return
        base, headers = await self.connection(owner)
        async with self.client.stream(
            "POST", base + "/generate", headers=headers, json=body
        ) as response:
            if response.status_code != 200:
                raw = await response.aread()
                code = json.loads(raw).get("code") if len(raw) < 10000 else None
                permitted = {
                    "QUOTA_EXHAUSTED",
                    "CONCURRENCY_LIMIT",
                    "MODEL_UNAVAILABLE",
                    "CONTEXT_LIMIT",
                    "REQUEST_ALREADY_ACCEPTED",
                    "IDEMPOTENCY_CONFLICT",
                }
                raise DialogueError(
                    code if code in permitted else "GATEWAY_UNAVAILABLE", response.status_code
                )
            async for item in read_sse(response):
                yield item

    async def _run(
        self, owner: Owner, session_id: str, answer_id: str, body: dict[str, Any]
    ) -> str:
        started = time.monotonic()
        text = ""
        last_save = started
        state = "failed"
        error: str | None = "INCOMPLETE_STREAM"
        usage: Any = None
        accounting: Any = None
        try:
            await self._update(owner, session_id, answer_id, status="running")
            async with asyncio.timeout(190):
                async for item in self.generate(owner, body):
                    if item.get("type") == "delta":
                        text += item.get("text", "")
                        if len(text.encode()) > 256000:
                            raise DialogueError("OUTPUT_LIMIT", 502)
                        if time.monotonic() - last_save >= 0.1:
                            await self._update(owner, session_id, answer_id, text=text)
                            last_save = time.monotonic()
                    elif item.get("type") == "done":
                        state, error, usage, accounting = (
                            "completed",
                            None,
                            item.get("usage"),
                            item.get("accounting"),
                        )
                    elif item.get("type") == "error":
                        raise DialogueError("UPSTREAM_UNAVAILABLE", 502)
        except asyncio.CancelledError:
            state, error = "stopped", None
        except DialogueError as exc:
            error = exc.code
        except (httpx.HTTPError, TimeoutError, ValueError, TypeError):
            error = "GATEWAY_UNAVAILABLE"
        finally:
            finish = asyncio.create_task(
                self._update(
                    owner,
                    session_id,
                    answer_id,
                    status=state,
                    text=text,
                    error=error,
                    usage=usage,
                    accounting=accounting,
                    elapsed_ms=round((time.monotonic() - started) * 1000),
                )
            )
            try:
                await asyncio.shield(finish)
            except asyncio.CancelledError:
                await finish

        return state

    async def stop(self, owner: Owner, session_id: str, answer_id: str) -> dict[str, Any]:
        async with self.lock(session_id):
            data = await self._load(owner, session_id)
            self._answer(data, answer_id)
            task = self.tasks.get((session_id, answer_id))
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            async with self.lock(session_id):
                stored = await asyncio.to_thread(self.repo.get, owner, session_id)
                if stored is not None:
                    _, answer = self._answer(stored, answer_id)
                    if answer["status"] in ACTIVE:
                        answer.update(status="stopped", error=None)
                        await self._save(owner, stored)
        return await self.get(owner, session_id)

    async def delete(self, owner: Owner, session_id: str) -> None:
        async with self.lock(session_id):
            data = await self._load(owner, session_id)
            data["deleting"] = True
            await self._save(owner, data)
        tasks = [task for (sid, _), task in self.tasks.items() if sid == session_id]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        async with self.lock(session_id):
            await asyncio.to_thread(self.repo.delete, owner, session_id)

    async def events(self, owner: Owner, session_id: str) -> AsyncIterator[dict[str, Any]]:
        revision = -1
        while True:
            data = await self.get(owner, session_id)
            if data["revision"] != revision:
                yield {"type": "snapshot", "session": data}
                revision = data["revision"]
            if not any(a["status"] in ACTIVE for g in data["groups"] for a in g["answers"]):
                return
            await asyncio.sleep(0.25)

    async def close(self) -> None:
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.client.aclose()
