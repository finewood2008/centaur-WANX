"""Private deployment bindings; no plaintext Xingtu key is returned to callers."""

from __future__ import annotations

import asyncio
import copy
import json
import os
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
    if getattr(user, "local_data", False):
        from octop.infra.users.team_authority import require_team_permission, team_context

        require_team_permission(user, "applications.manage")
        if not re.fullmatch(r"ai\.wanx\.selfmade\.[a-f0-9]{32}", app_id):
            raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422)
        context = team_context(user)
        bindings = value[FIELD]
        if not isinstance(bindings, dict) or len(bindings) > 100:
            raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422)
        grants = []
        normalized = {}
        for warehouse, item in sorted(bindings.items()):
            resource = "team:knowledge:" + warehouse
            saved = {
                "resourceId": resource,
                "boxId": context.claims["boxId"],
                "ownershipEpoch": context.claims["ownershipEpoch"],
            }
            if not re.fullmatch(
                r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", warehouse
            ) or item not in ({"resourceId": resource}, saved):
                raise SemanticaError("ACCESS_KEY_SCOPE_DENIED", 403)
            grants.append({"resourceId": resource, "actions": ["read"]})
            normalized[warehouse] = saved
        context.authorize_resources_sync(grants)
        context.require_live()
        value[FIELD] = normalized
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
    services: Any,
    owner: str,
    app_id: str,
    action: str,
    params: dict[str, Any],
    *,
    context: Any = None,
) -> dict[str, Any]:
    deployment = services.application_repo.deployment(app_id)
    warehouse = params.get("warehouseId")
    if not isinstance(warehouse, str) or not re.fullmatch(r"[a-f0-9-]{36}", warehouse):
        raise SemanticaError("ACCESS_KEY_SCOPE_DENIED", 403)
    binding = (deployment or {}).get("configuration", {}).get(FIELD, {}).get(warehouse)
    if context is not None:
        from centuarai_local_data_gate import GateContext

        from .local_team_client import LocalSemanticaClient

        if not isinstance(context, GateContext):
            raise SemanticaError("SEMANTICA_RESOURCE_FORBIDDEN", 403)
        context.check_cached()
        expected = {
            "resourceId": "team:knowledge:" + warehouse,
            "boxId": context.claims["boxId"],
            "ownershipEpoch": context.claims["ownershipEpoch"],
        }
        if binding != expected:
            raise SemanticaError("ACCESS_KEY_SCOPE_DENIED", 403)
        claims = context.claims
        uid = await asyncio.to_thread(
            services.local_data_principal_repo.resolve,
            context.principal_namespace,
            claims["boxKeyThumbprint"],
            claims["ownershipEpoch"],
            claims["principalId"],
        )
        if owner != "wanx:" + str(uid):
            raise SemanticaError("ACCESS_KEY_SCOPE_DENIED", 403)
        local_client = await asyncio.to_thread(
            LocalSemanticaClient.from_file, context, services.paths.root / "semantica.json"
        )
        prefix = "/warehouses/" + warehouse
        if action == "search":
            if set(params) - {"warehouseId", "query", "document_ids", "entity_types", "limit"}:
                raise SemanticaError("SEMANTICA_QUERY_NOT_ALLOWED", 422)
            return await local_client.request(
                "POST",
                prefix + "/search",
                payload={key: value for key, value in params.items() if key != "warehouseId"},
            )
        if action == "documents" and set(params) == {"warehouseId"}:
            return await local_client.request("GET", prefix + "/documents")
        if action == "graph" and set(params) == {"warehouseId"}:
            return await local_client.request("GET", prefix + "/graph")
        if (
            action == "evidence"
            and set(params) == {"warehouseId", "id"}
            and isinstance(params["id"], str)
            and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", params["id"])
        ):
            return await local_client.request("GET", prefix + "/evidence/" + params["id"])
        raise SemanticaError("SEMANTICA_OPERATION_NOT_ALLOWED", 403)
    from centuarai_local_data_gate import load_required_policy

    if os.environ.get("OCTOP_LOCAL_DATA_MODE") == "required" or load_required_policy() is not None:
        raise SemanticaError("SEMANTICA_RESOURCE_FORBIDDEN", 403)
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
