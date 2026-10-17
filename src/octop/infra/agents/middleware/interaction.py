"""Apply per-agent preferences at the shared model boundary, for web and IM alike."""

from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import SystemMessage

from octop.infra.agents.settings.interaction import InteractionPreferences, interaction_instructions


class InteractionPreferencesMiddleware(AgentMiddleware[Any, Any]):
    def __init__(self, preferences: InteractionPreferences) -> None:
        super().__init__()
        self.instructions = interaction_instructions(preferences)

    def _request(self, request: ModelRequest[Any]) -> ModelRequest[Any]:
        system = request.system_message
        if system is None:
            updated = SystemMessage(content=self.instructions)
        else:
            content = system.content
            # Preserve all structured blocks, metadata and provider cache controls.
            combined = (
                [*content, {"type": "text", "text": self.instructions}]
                if isinstance(content, list)
                else f"{content}\n\n{self.instructions}"
            )
            updated = system.model_copy(update={"content": combined})
        return request.override(system_message=updated)

    def wrap_model_call(
        self, request: ModelRequest[Any], handler: Callable[[ModelRequest[Any]], ModelResponse]
    ) -> ModelResponse:
        return handler(self._request(request))

    async def awrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        return await handler(self._request(request))
