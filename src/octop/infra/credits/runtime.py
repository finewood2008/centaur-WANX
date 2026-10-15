"""Observe server-side model calls. Shadow-only; never accepts client usage or prices.

Factories are instrumented as well as task entry points so auxiliary calls outside
chat (memory/compaction/planning) remain visible as unlinked audit tasks. Such calls
cannot be promoted to commercial billing until their authorization is established.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import logging
import uuid
from collections.abc import Iterator
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from langchain_core.callbacks import BaseCallbackHandler

from octop.infra.credits.metering import Meter
from octop.infra.db.repos.metering import MeterRepo
from octop.infra.gateway.process.usage_record import normalize_usage

logger = logging.getLogger(__name__)


@dataclass
class Task:
    meter: Meter
    id: str
    closed: bool = False
    cancelled: bool = False
    failed: bool = False


current: ContextVar[Task | None] = ContextVar("wanx_meter_task", default=None)
active: dict[tuple[str, str], Task] = {}
account_context: ContextVar[dict[str, Any] | None] = ContextVar("wanx_meter_identity", default=None)


@contextlib.contextmanager
def task_scope(
    meter: Meter,
    app: str,
    *,
    identity: dict[str, Any] | None = None,
    key: str | None = None,
    tier: str = "standard",
    user_id: int = 0,
) -> Iterator[Task]:
    parent = current.get()
    if parent and not parent.closed:
        yield parent
        return
    identity = identity or account_context.get()
    if identity and app not in ("wanx", identity["application_id"]):
        identity = None
    # An identity can only originate from a verified, app-scoped meter session.
    app = str(identity["application_id"]) if identity else app
    account = str(identity["account_key"]) if identity else None
    try:
        row = meter.create_task(account, app, key or uuid.uuid4().hex, tier, user_id=user_id)
        meter.start(row["id"])
        task = Task(meter, row["id"])
    except Exception:
        logger.warning("Task usage recording unavailable", exc_info=True)
        yield Task(meter, "", closed=True)
        return
    token = current.set(task)
    try:
        yield task
    except asyncio.CancelledError:
        task.cancelled = True
        raise
    except BaseException:
        task.failed = True
        raise
    finally:
        task.closed = True
        current.reset(token)
        try:
            meter.finish(
                task.id, "failed" if task.failed else "cancelled" if task.cancelled else "completed"
            )
        except Exception:
            logger.warning("Task usage finalization unavailable", exc_info=True)


def metered_stream(method: Any) -> Any:
    @functools.wraps(method)
    async def wrapped(self: Any, agent_id: str, request: dict[str, Any]) -> Any:
        # Test/embedded registries without persistent services retain their behavior.
        db = getattr(self._repos, "db", None)
        if db is None:
            async for chunk in method(self, agent_id, request):
                yield chunk
            return
        row = self.get_row(agent_id)
        app = getattr(row, "application_id", None) or "wanx"
        identity = request.get("_meter_identity")
        with task_scope(
            Meter(MeterRepo(db)),
            app,
            identity=identity,
            user_id=getattr(row, "user_id", 0) or 0,
        ) as task:
            key = (agent_id, str(request.get("thread_id") or ""))
            active[key] = task
            try:
                clean = {k: v for k, v in request.items() if not k.startswith("_meter_")}
                async for chunk in method(self, agent_id, clean):
                    if isinstance(chunk, dict) and chunk.get("type") == "error":
                        task.failed = True
                    yield chunk
            finally:
                if active.get(key) is task:
                    active.pop(key, None)

    return wrapped


def cancel(agent_id: str, thread_id: str) -> None:
    task = active.get((agent_id, thread_id))
    if task:
        task.cancelled = True


class CostCallback(BaseCallbackHandler):
    run_inline = True

    def __init__(
        self, meter: Meter, model: str, provider: str, trusted_price: bool, app: str, user_id: int
    ) -> None:
        self.meter, self.model, self.provider = meter, model, provider
        self.trusted_price, self.app, self.user_id = trusted_price, app, user_id
        self.runs: dict[str, tuple[Task, bool]] = {}

    def on_chat_model_start(
        self, serialized: Any, messages: Any, *, run_id: Any, **kwargs: Any
    ) -> None:
        task = current.get()
        own = task is None or task.closed
        if own:
            row = self.meter.create_task(None, self.app, uuid.uuid4().hex, user_id=self.user_id)
            self.meter.start(row["id"])
            task = Task(self.meter, row["id"])
        assert task is not None
        # Approximate in-flight usage for audit only; it never limits a call.
        max_input = sum(len(str(m.content).encode("utf-8")) for batch in messages for m in batch)
        params = kwargs.get("invocation_params") or {}
        max_output = params.get("max_tokens") or params.get("max_completion_tokens") or 32768
        if not isinstance(max_output, int) or max_output < 0:
            max_output = 32768
        priced_model = self.model if self.trusted_price else f"unpriced:{self.model}"
        task.meter.begin_call(
            task.id, str(run_id), priced_model, self.provider, max_input, max_output
        )
        self.runs[str(run_id)] = (task, own)

    def _finish(self, run_id: Any, response: Any, failed: bool) -> None:
        record = self.runs.pop(str(run_id), None)
        if record is None:
            return
        task, own = record
        usage = None
        if response is not None:
            raw = (getattr(response, "llm_output", None) or {}).get("token_usage")
            for batch in getattr(response, "generations", []):
                for generation in batch:
                    message = getattr(generation, "message", None)
                    meta = getattr(message, "response_metadata", {}) or {}
                    source = meta.get("token_usage") or meta.get("usage") or {}
                    if source or getattr(message, "usage_metadata", None):
                        raw = {**source, **(getattr(message, "usage_metadata", None) or {})}
            input_count = (
                raw.get("input_tokens", raw.get("prompt_tokens")) if isinstance(raw, dict) else None
            )
            output_count = (
                raw.get("output_tokens", raw.get("completion_tokens"))
                if isinstance(raw, dict)
                else None
            )
            if isinstance(raw, dict) and (
                type(input_count) is int
                and type(output_count) is int
                and input_count >= 0
                and output_count >= 0
            ):
                normalized = normalize_usage(raw)
                if (
                    normalized["cache_read_tokens"] + normalized["cache_write_tokens"]
                    <= normalized["input_tokens"]
                ):
                    usage = {k: v for k, v in normalized.items() if k != "model"}
        task.meter.finish_call(task.id, str(run_id), usage, failed=failed)
        if own:
            task.closed = True
            task.meter.finish(task.id, "failed" if failed else "completed")

    def on_llm_end(self, response: Any, *, run_id: Any, **kwargs: Any) -> None:
        self._finish(run_id, response, False)

    def on_llm_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> None:
        self._finish(run_id, kwargs.get("response"), True)


def instrument_factory(factory: Any, db: Any, app: str, user_id: int) -> None:
    if getattr(factory, "_wanx_cost_instrumented", False):
        return
    factory._wanx_cost_instrumented = True
    original = factory.get_chat_model
    meter = Meter(MeterRepo(db))
    providers = {p.id: p for p in factory.provider_configs()}

    def get_model(ref: str) -> Any:
        model = original(ref)
        provider = providers.get(ref.partition("/")[0])
        callbacks = list(model.callbacks or [])
        if not any(isinstance(cb, CostCallback) for cb in callbacks):
            provider_id, _, model_id = ref.partition("/")
            provider = providers.get(provider_id)
            host = urlparse(str(getattr(provider, "base_url", "") or "")).hostname
            callbacks.append(
                CostCallback(meter, model_id, provider_id, host == "api.deepseek.com", app, user_id)
            )
            model.callbacks = callbacks
        return model

    factory.get_chat_model = get_model
    # Attach to instances already created while compiling the agent graph.
    for ref in factory.list_refs():
        if ref in factory._cache:
            get_model(ref)


def metered_call(method: Any) -> Any:
    @functools.wraps(method)
    async def wrapped(self: Any, agent_id: str, request: dict[str, Any]) -> Any:
        db = getattr(self._repos, "db", None)
        if db is None:
            return await method(self, agent_id, request)
        row = self.get_row(agent_id)
        with task_scope(
            Meter(MeterRepo(db)),
            getattr(row, "application_id", None) or "wanx",
            identity=request.get("_meter_identity"),
            user_id=getattr(row, "user_id", 0) or 0,
        ):
            clean = {k: v for k, v in request.items() if not k.startswith("_meter_")}
            return await method(self, agent_id, clean)

    return wrapped
