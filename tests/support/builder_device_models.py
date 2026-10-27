"""Synthetic device catalog and Responses stream for Builder integration tests."""

from __future__ import annotations

import asyncio
import copy
import json
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import httpx


class SyntheticCatalog:
    """Substitute already-validated V3 snapshots; never contact an Admin service."""

    def __init__(self) -> None:
        self.config = SimpleNamespace(device_id="box-native", interval=0.02)
        self.closed = False
        self.acknowledged_versions: list[str] = []
        self.value: dict[str, Any] = {
            "schemaVersion": 3,
            "deviceId": "box-native",
            "bindingId": "binding",
            "ownerAccountId": "owner",
            "ownershipEpoch": 1,
            "authVersion": 1,
            "providers": [
                {
                    "providerId": "qeetoken",
                    "displayName": "QeeToken",
                    "enabled": True,
                    "configVersion": "1",
                    "protocol": "openai-compatible",
                    "baseUrl": "https://models.example.com/v1",
                    "apiKey": "supplier-private-key",
                    "allowedProducts": ["wanxiang"],
                    "allowedModels": [],
                }
            ],
        }

    async def refresh(self) -> dict[str, Any]:
        return self.active()

    def active(self) -> dict[str, Any]:
        return copy.deepcopy(self.value)

    async def acknowledge_applied(self) -> None:
        self.acknowledged_versions.append(self.value["providers"][0]["configVersion"])

    async def close(self) -> None:
        self.closed = True


def _event(kind: str, **fields: Any) -> bytes:
    return ("event: " + kind + "\ndata: " + json.dumps({"type": kind, **fields}) + "\n\n").encode()


class SyntheticResponse(httpx.AsyncByteStream):
    def __init__(self, sequence: int, item: dict[str, Any], text: str, model: str) -> None:
        self.sequence, self.item, self.text, self.model = sequence, item, text, model

    async def __aiter__(self) -> AsyncIterator[bytes]:
        response = {
            "id": f"resp_device_{self.sequence}",
            "object": "response",
            "created_at": 1,
            "status": "in_progress",
            "model": self.model,
            "output": [],
        }
        yield _event("response.created", response=response)
        yield _event("response.output_item.added", output_index=0, item=self.item)
        position = {"item_id": self.item["id"], "output_index": 0, "content_index": 0}
        yield _event("response.output_text.delta", **position, delta=self.text)
        # Keep the stream open across the V3 catalog refresh interval.
        await asyncio.sleep(0.05)
        yield _event("response.output_text.done", **position, text=self.text)
        yield _event("response.output_item.done", output_index=0, item=self.item)
        yield _event(
            "response.completed",
            response={
                **response,
                "status": "completed",
                "output": [self.item],
                "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
            },
        )
