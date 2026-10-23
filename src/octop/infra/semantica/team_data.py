"""Private deployment bindings; no plaintext Xingtu key is returned to callers."""

from __future__ import annotations

import copy
import json
import re
from typing import Any

from .client import SemanticaClient, SemanticaError

FIELD = "studio_team_data"


def store_bindings(
    services: Any, user: Any, app_id: str, configuration: dict[str, Any]
) -> dict[str, Any]:
    value = copy.deepcopy(configuration)
    if FIELD not in value:
        return value
    if user.role != "admin" or not re.fullmatch(r"ai\.wanx\.selfmade\.[a-f0-9]{32}", app_id):
        raise SemanticaError("SEMANTICA_ADMIN_REQUIRED", 403)
    bindings = value[FIELD]
    if not isinstance(bindings, dict) or len(bindings) > 100:
        raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422)
    previous = (
        (services.application_repo.deployment(app_id) or {}).get("configuration", {}).get(FIELD, {})
    )
    config = json.loads((services.paths.root / "semantica.json").read_text())
    for warehouse, item in bindings.items():
        if not re.fullmatch(r"[a-f0-9-]{36}", warehouse) or not isinstance(item, dict):
            raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422)
        if set(item) == {"keyId"}:
            key_id = item["keyId"]
            if not isinstance(key_id, str) or not re.fullmatch(r"[a-f0-9-]{36}", key_id):
                raise SemanticaError("ACCESS_KEY_INVALID", 403)
            reference = "studio-team-data/key/" + key_id
            saved = services.secret_repo.get(reference)
            if saved is None:
                raise SemanticaError("ACCESS_KEY_INVALID", 403)
            record = json.loads(saved)
            if record["warehouse"] != warehouse or record["box"] != config["box_id"]:
                raise SemanticaError("ACCESS_KEY_SCOPE_DENIED", 403)
            bindings[warehouse] = {"reference": reference, "box": config["box_id"]}
        elif item != previous.get(warehouse):
            raise SemanticaError("ACCESS_KEY_INVALID", 403)
    return value


async def read_bound(
    services: Any, owner: str, app_id: str, action: str, params: dict[str, Any]
) -> dict[str, Any]:
    deployment = services.application_repo.deployment(app_id)
    warehouse = params.get("warehouseId")
    if not isinstance(warehouse, str) or not re.fullmatch(r"[a-f0-9-]{36}", warehouse):
        raise SemanticaError("ACCESS_KEY_SCOPE_DENIED", 403)
    binding = (deployment or {}).get("configuration", {}).get(FIELD, {}).get(warehouse)
    if not binding or set(binding) != {"reference", "box"}:
        raise SemanticaError("ACCESS_KEY_SCOPE_DENIED", 403)
    client = SemanticaClient.from_file(
        services.paths.root / "semantica.json", int(owner.split(":")[1]), "wanx", team=True
    )
    if binding["box"] != client.config["box_id"]:
        raise SemanticaError("ACCESS_KEY_SCOPE_DENIED", 403)
    # Check the current team's ownership before using a per-warehouse read key.
    await client.request("GET", "/warehouses/" + warehouse)
    secret = services.secret_repo.get(binding["reference"])
    if secret is None:
        raise SemanticaError("ACCESS_KEY_INVALID", 403)
    key = json.loads(secret)["token"]
    details = await client.public_read("GET", "/warehouse", key)
    if details.get("id", details.get("warehouse", {}).get("id")) != warehouse:
        raise SemanticaError("ACCESS_KEY_SCOPE_DENIED", 403)
    if action == "search":
        return await client.public_read(
            "POST",
            "/search",
            key,
            payload={
                k: v
                for k, v in params.items()
                if k in {"query", "document_ids", "entity_types", "limit"}
            },
        )
    if action in {"documents", "graph"}:
        return await client.public_read("GET", "/" + action, key)
    if (
        action == "evidence"
        and isinstance(params.get("id"), str)
        and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", params["id"])
    ):
        return await client.public_read("GET", "/evidence/" + params["id"], key)
    raise SemanticaError("SEMANTICA_OPERATION_NOT_ALLOWED", 403)
