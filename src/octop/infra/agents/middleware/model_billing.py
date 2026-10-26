"""Report provider payment failures immediately instead of retrying the model."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.exceptions import ModelError


class ModelBillingErrorMiddleware(AgentMiddleware[Any, Any]):
    def wrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], ModelResponse[Any]],
    ) -> ModelResponse[Any]:
        try:
            return handler(request)
        except Exception as exc:
            if getattr(exc, "status_code", None) == 402:
                raise ModelError("HTTP 402: model provider payment required") from exc
            raise

    async def awrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any]:
        try:
            return await handler(request)
        except Exception as exc:
            if getattr(exc, "status_code", None) == 402:
                raise ModelError("HTTP 402: model provider payment required") from exc
            raise
