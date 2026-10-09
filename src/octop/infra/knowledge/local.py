"""Validate the platform-selected local model without silently choosing another."""

from __future__ import annotations

from collections.abc import Callable

from octop.infra.agents.providers.onnx_service import (
    assert_catalog_model,
    is_model_downloaded,
)


def local_embedding_model(
    settings_get: Callable[[str], str | None], *, preferred_model: str | None = None
) -> str:
    if (settings_get("knowledge_embedding_backend") or "onnx").strip().lower() != "onnx":
        return ""
    candidate = preferred_model or settings_get("knowledge_embedding_model") or ""
    try:
        model = assert_catalog_model(candidate)
    except ValueError:
        return ""
    return model if is_model_downloaded(model) else ""
