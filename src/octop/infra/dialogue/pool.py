"""Text-only conversations using WANX's existing enabled Provider model pool."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import AsyncIterator
from dataclasses import replace
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from octop_harness.llm.factory import build_chat_model
from octop_harness.llm.session_header import aclose_session_http_clients

from octop.infra.agents.providers.store import ProviderStore
from octop.infra.dialogue.contracts import DialogueError
from octop.infra.dialogue.provider import is_dialogue_gateway
from octop.infra.dialogue.upstream import SYSTEM


class WanxModelPool:
    def __init__(self, services: Any) -> None:
        self.services = services
        self.running: dict[int, int] = {}

    def _entries(self) -> dict[str, tuple[Any, Any]]:
        # Same persisted catalog and eligibility rules used by WANX's model picker.
        rows = self.services.provider_repo.list_all()
        ids = {r.name: r.id for r in rows if not is_dialogue_gateway(r)}
        configs = ProviderStore(self.services.provider_repo).build_harness_configs()
        return {
            f"wanx-{ids[p.id]}-{hashlib.sha256(m.id.encode()).hexdigest()[:24]}": (p, m)
            for p in configs
            if p.id in ids
            for m in p.models
        }

    @staticmethod
    def _limits(model: Any) -> tuple[int, int]:
        output = min(model.max_output_tokens or 2048, 4096)
        # UTF-8 bytes plus protocol overhead conservatively bound input tokens.
        window = model.context_window or 32768
        capacity = min(model.max_input_tokens or window, window - output) - 1024
        return max(0, min(24000, capacity)), output

    async def models(self) -> list[dict[str, Any]]:
        entries = await asyncio.to_thread(self._entries)
        return [
            {
                "id": key,
                "name": model.name,
                "provider": provider.name,
                "source": "wanx_pool",
                "max_input_bytes": self._limits(model)[0],
                "max_output_tokens": self._limits(model)[1],
                "input_units": None,
                "output_units": None,
            }
            for key, (provider, model) in entries.items()
        ]

    async def generate(self, user_id: int, body: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        entries = await asyncio.to_thread(self._entries)
        selected = entries.get(body["model"])
        if selected is None:
            raise DialogueError("MODEL_UNAVAILABLE", 400)
        provider, model = selected
        limit, output = self._limits(model)
        if sum(len(m["content"].encode()) for m in body["messages"]) > limit:
            raise DialogueError("CONTEXT_LIMIT", 413)
        if self.running.get(user_id, 0) >= 3 or sum(self.running.values()) >= 12:
            raise DialogueError("CONCURRENCY_LIMIT", 429)
        self.running[user_id] = self.running.get(user_id, 0) + 1
        llm: Any = None
        try:
            # No Agent, tools, filesystem, terminal, automatic routing, or retries.
            llm = build_chat_model(provider, replace(model, native_tool_search=False))
            from urllib.parse import urlparse

            from octop.infra.credits.metering import Meter
            from octop.infra.credits.runtime import CostCallback
            from octop.infra.db.repos.metering import MeterRepo

            llm.callbacks = [
                *(getattr(llm, "callbacks", None) or []),
                CostCallback(
                    Meter(MeterRepo(self.services.db)),
                    model.id,
                    provider.id,
                    urlparse(provider.base_url).hostname == "api.deepseek.com",
                    "centaurai.wanx.dialogue",
                    user_id,
                ),
            ]
            llm.max_retries = 0
            if (
                hasattr(llm, "use_responses_api")
                and "chatgpt.com/backend-api/codex" in provider.base_url
            ):
                llm.use_responses_api = True
            messages: list[BaseMessage] = [SystemMessage(content=SYSTEM)]
            messages.extend(
                HumanMessage(content=m["content"])
                if m["role"] == "user"
                else AIMessage(content=m["content"])
                for m in body["messages"]
            )
            usage = None
            finish = None
            size = 0
            async for chunk in llm.astream(messages, max_tokens=output):
                if chunk.tool_calls or chunk.tool_call_chunks:
                    raise DialogueError("TOOLS_DISABLED", 502)
                content = chunk.content
                text = (
                    content
                    if isinstance(content, str)
                    else "".join(
                        str(part.get("text", ""))
                        for part in content
                        if isinstance(part, dict) and part.get("type") in {"text", "text_delta"}
                    )
                )
                size += len(text.encode())
                if size > 256000:
                    raise DialogueError("OUTPUT_LIMIT", 502)
                if text:
                    yield {"type": "delta", "text": text}
                usage = chunk.usage_metadata or usage
                finish = (
                    chunk.response_metadata.get("finish_reason")
                    or chunk.response_metadata.get("stop_reason")
                    or finish
                )
            if finish in {"length", "max_tokens", "content_filter"}:
                raise DialogueError("INCOMPLETE_STREAM", 502)
            if not size:
                raise DialogueError("INCOMPLETE_STREAM", 502)
            yield {"type": "done", "usage": usage, "accounting": "provider_managed"}
        except DialogueError:
            raise
        except Exception:
            # Provider exceptions can contain keys, URLs, or user prompts.
            raise DialogueError("UPSTREAM_UNAVAILABLE", 502) from None
        finally:
            self.running[user_id] -= 1
            if not self.running[user_id]:
                del self.running[user_id]
            if llm is not None:
                await aclose_session_http_clients(llm)
