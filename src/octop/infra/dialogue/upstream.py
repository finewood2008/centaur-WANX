"""Text-only relay adapters. Never create or execute tools."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

from octop.infra.dialogue.contracts import DialogueError, Generation, check_url, read_sse

SYSTEM = "Answer the user's question directly. Present uncertainty clearly. You have no tools."


class ModelRoute(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-zA-Z0-9_.-]{1,100}$")
    name: str
    provider: str
    upstream_model: str
    protocol: Literal["openai", "anthropic"] = "openai"
    base_url: str
    key_env: str
    verified: bool = False
    regions: list[str] = Field(default_factory=list)
    max_input_bytes: int = Field(default=24000, ge=1024, le=128000)
    max_output_tokens: int = Field(default=2048, ge=128, le=8192)
    input_units: int = Field(default=1, ge=1)
    output_units: int = Field(default=1, ge=1)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "provider": self.provider,
            "input_units": self.input_units,
            "output_units": self.output_units,
            "max_output_tokens": self.max_output_tokens,
            "max_input_bytes": self.max_input_bytes,
        }


async def generate(
    route: ModelRoute,
    body: Generation,
    client: httpx.AsyncClient,
) -> AsyncIterator[dict[str, Any]]:
    key = os.environ.get(route.key_env)
    if not key:
        raise DialogueError("MODEL_UNAVAILABLE", 503)
    base = check_url(route.base_url)
    messages = [m.model_dump() for m in body.messages]
    common = {
        "model": route.upstream_model,
        "messages": messages,
        "stream": True,
        "max_tokens": route.max_output_tokens,
    }
    if route.protocol == "anthropic":
        payload = {**common, "system": SYSTEM}
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
        endpoint = "/messages"
    else:
        payload = {
            **common,
            "messages": [{"role": "system", "content": SYSTEM}, *messages],
            "stream_options": {"include_usage": True},
        }
        headers = {"Authorization": "Bearer " + key}
        endpoint = "/chat/completions"
    input_tokens: int | None = None
    output_tokens: int | None = None
    finished = False
    output_bytes = 0
    async with client.stream("POST", base + endpoint, headers=headers, json=payload) as response:
        if response.status_code != 200:
            # Do not forward upstream error bodies (may contain credentials/prompts).
            yield {"type": "rejected", "status": response.status_code}
            raise DialogueError("UPSTREAM_REJECTED", 502)
        async for item in read_sse(response):
            if item.get("error") or item.get("type") == "error":
                raise DialogueError("UPSTREAM_ERROR", 502)
            text = ""
            if route.protocol == "anthropic":
                kind = item.get("type")
                if kind == "message_start":
                    usage = item.get("message", {}).get("usage", {})
                    if "input_tokens" in usage:
                        input_tokens = (
                            int(usage["input_tokens"])
                            + int(usage.get("cache_read_input_tokens", 0))
                            + int(usage.get("cache_creation_input_tokens", 0))
                        )
                if kind == "content_block_start" and item.get("content_block", {}).get("type") in {
                    "tool_use",
                    "server_tool_use",
                }:
                    raise DialogueError("TOOLS_DISABLED", 502)
                if (
                    kind == "content_block_delta"
                    and item.get("delta", {}).get("type") == "text_delta"
                ):
                    text = item["delta"].get("text", "")
                if kind == "message_delta":
                    usage = item.get("usage", {})
                    if "output_tokens" in usage:
                        output_tokens = int(usage["output_tokens"])
                if kind == "message_stop":
                    finished = True
            else:
                for choice in item.get("choices", []):
                    delta = choice.get("delta", {})
                    if delta.get("tool_calls") or delta.get("function_call"):
                        raise DialogueError("TOOLS_DISABLED", 502)
                    text += delta.get("content") or ""
                    if choice.get("finish_reason") in {"stop", "length", "content_filter"}:
                        finished = True
                usage = item.get("usage") or {}
                if "prompt_tokens" in usage and "completion_tokens" in usage:
                    input_tokens, output_tokens = (
                        int(usage["prompt_tokens"]),
                        int(usage["completion_tokens"]),
                    )
            if text:
                output_bytes += len(text.encode())
                if output_bytes > 256000:
                    raise DialogueError("OUTPUT_LIMIT", 502)
                yield {"type": "delta", "text": text}
        if not finished:
            raise DialogueError("INCOMPLETE_STREAM", 502)
        yield {"type": "usage", "input_tokens": input_tokens, "output_tokens": output_tokens}
