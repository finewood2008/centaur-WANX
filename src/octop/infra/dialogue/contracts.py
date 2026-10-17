"""Shared bounded input and SSE contracts for the box and platform gateway."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, ConfigDict, Field


class DialogueError(Exception):
    def __init__(self, code: str, status: int = 400) -> None:
        self.code, self.status = code, status
        super().__init__(code)


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=32000)


class Generation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{16,80}$")
    model: str = Field(min_length=1, max_length=150)
    messages: list[Message] = Field(min_length=1, max_length=80)


def check_url(url: str) -> str:
    parsed = urlparse(url)
    if (
        parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or not parsed.hostname
        or (
            parsed.scheme != "https"
            and not (
                parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
            )
        )
    ):
        raise DialogueError("INVALID_SERVICE_URL")
    return url.rstrip("/")


def event(data: dict[str, Any]) -> str:
    return "data: " + json.dumps(data, ensure_ascii=False) + "\n\n"


async def read_sse(response: httpx.Response) -> AsyncIterator[dict[str, Any]]:
    """Bound individual frames; handle multi-line data and comments."""
    parts: list[str] = []
    size = 0
    async for line in response.aiter_lines():
        if len(line) > 1_000_000:
            raise DialogueError("INVALID_UPSTREAM_STREAM", 502)
        if not line:
            if parts:
                raw = "\n".join(parts)
                if raw == "[DONE]":
                    yield {"type": "stream_end"}
                else:
                    item = json.loads(raw)
                    if not isinstance(item, dict):
                        raise DialogueError("INVALID_UPSTREAM_STREAM", 502)
                    yield item
            parts, size = [], 0
        elif line.startswith("data:"):
            parts.append(line[5:].lstrip(" "))
            size += len(line)
            if size > 1_000_000:
                raise DialogueError("INVALID_UPSTREAM_STREAM", 502)
    if parts:
        raise DialogueError("INCOMPLETE_STREAM", 502)
