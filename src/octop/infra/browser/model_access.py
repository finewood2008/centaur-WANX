"""Select WANX's configured usable model for an owned browser conversation.

Current WANX uses its native provider factory and per-thread composer model.
No alternative factory, gateway budget or process-wide model override is needed.
"""

from __future__ import annotations

from typing import Any

from octop.infra.errors import ErrorCode, OctopError


def configured_model(manager: Any) -> str:
    ref = manager.resolve_fallback_model_ref()
    for provider in manager.providers.build_harness_configs():
        if ref in [f"{provider.id}/{m.id}" for m in provider.models if m.enabled]:
            return str(ref)
    raise OctopError(ErrorCode.FORBIDDEN, "configured model unavailable")
