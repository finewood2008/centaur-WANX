"""Carry a verified live guard across the dashboard's in-memory worker queue."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from octop_gateway import models as gateway_models
from octop_gateway.models import InboundMessage
from pydantic import PrivateAttr

from octop.infra.agents.middleware.local_data import local_data_live_check


def validate_local_turn(body: dict[str, Any]) -> None:
    """The local model surface has no command, attachment or plugin authority."""
    for name in (
        "mcp_servers",
        "skills",
        "target_agent_ids",
        "knowledge_base_ids",
        "invitation_id",
    ):
        if body.get(name):
            raise PermissionError("local data context denied")
    policy = body.get("hitl_policy")
    if policy and policy != {"mode": "ask", "tools": []}:
        raise PermissionError("local data context denied")
    texts = [body.get("text") or ""]
    for message in body.get("messages") or []:
        if (
            not isinstance(message, dict)
            or set(message) != {"role", "content"}
            or message["role"] not in {"user", "assistant"}
        ):
            raise PermissionError("local data context denied")
        content = message["content"]
        if isinstance(content, str):
            texts.append(content)
        elif isinstance(content, list):
            for part in content:
                if (
                    not isinstance(part, dict)
                    or set(part) != {"type", "text"}
                    or part["type"] != "text"
                    or not isinstance(part["text"], str)
                ):
                    raise PermissionError("local data context denied")
                texts.append(part["text"])
        else:
            raise PermissionError("local data context denied")
    if any(not isinstance(text, str) or text.lstrip().startswith("/") for text in texts):
        raise PermissionError("local data commands denied")


class LocalDataInbound(InboundMessage):
    # PrivateAttr is neither parsed from wire JSON nor included in model_dump.
    # No proof, callable or capability handle enters persisted message metadata.
    _live: Callable[[], None] | None = PrivateAttr(default=None)

    @classmethod
    def bind(cls, message: InboundMessage, check: Callable[[], None]) -> LocalDataInbound:
        result = cls.model_validate(message.model_dump())
        result._live = check
        return result


# The upstream model has a deferred ChannelSubject annotation. Resolve it
# against its defining module before constructing our private subclass.
LocalDataInbound.model_rebuild(_types_namespace=vars(gateway_models))


async def run_local_turn(
    message: LocalDataInbound, handler: Callable[[Any], Awaitable[None]]
) -> None:
    if message._live is None:
        raise PermissionError("local data session required")
    check = message._live
    await asyncio.to_thread(check)
    token = local_data_live_check.set(check)

    async def watch() -> None:
        while True:
            await asyncio.sleep(0.2)
            await asyncio.to_thread(check)

    async def invoke() -> None:
        await handler(message)

    worker = asyncio.create_task(invoke())
    guard = asyncio.create_task(watch())
    try:
        done, _ = await asyncio.wait({worker, guard}, return_when=asyncio.FIRST_COMPLETED)
        if guard in done:
            await guard
        await worker
    finally:
        for task in (worker, guard):
            if not task.done():
                task.cancel()
        await asyncio.gather(worker, guard, return_exceptions=True)
        local_data_live_check.reset(token)
