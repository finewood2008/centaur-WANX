"""Read-only Builder policy; generated projects cannot alter WANX authority."""

import json
from copy import deepcopy
from importlib.resources import files
from pathlib import Path

_POLICY_RESOURCE = files(__package__).joinpath("wanx-foundation.json")
if not _POLICY_RESOURCE.is_file():
    # Editable/source runs share the same policy with the JavaScript compiler.
    _POLICY_RESOURCE = Path(__file__).resolve().parents[2] / "core" / "wanx-foundation.json"
_POLICY = json.loads(_POLICY_RESOURCE.read_text(encoding="utf-8"))
FOUNDATION_PROMPT = _POLICY["instruction"]


def foundation_policy():
    return deepcopy({k: v for k, v in _POLICY.items() if k != "instruction"})


def has_auth_storage(collections):
    forbidden = set(_POLICY["forbiddenCredentialFields"])
    return any(
        key.replace("_", "").replace("-", "").lower() in forbidden
        for fields in collections.values()
        for key in fields
    )
