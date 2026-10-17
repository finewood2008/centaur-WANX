"""Keep per-account gateway credentials out of shared provider catalogs."""

from __future__ import annotations

import json
from typing import Any


def is_dialogue_gateway(row: Any) -> bool:
    try:
        extra = json.loads(getattr(row, "extra_json", None) or "{}")
    except (TypeError, ValueError):
        return False
    return isinstance(extra, dict) and extra.get("dialogue_gateway") is True
