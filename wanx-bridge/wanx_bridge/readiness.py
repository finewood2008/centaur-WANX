"""Read-only application diagnostics through authorized public HTTP APIs.

The public expert list has no verifiable template version or migration contract.
Existing instances remain unbound and untouched; names never establish provenance.
"""

from __future__ import annotations

import re
from typing import Any
from uuid import UUID

from .config import BridgeAuthError

APPLICATION_PRODUCTS = {
    "centaurai.wanx.zhijun": "wanx",
    "centaurai.wanx.superadvisors": "super-advisory",
}
_ID = re.compile(r"[a-z][a-z0-9._-]{1,127}\Z")
_STABLE = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
_RANGE = re.compile(rf"(?:>=|<=|>|<|=)?{_STABLE}(?: (?:>=|<=|>|<|=)?{_STABLE})*\Z")


def _invalid() -> BridgeAuthError:
    return BridgeAuthError("APPLICATION_CONTRACT_UNSUPPORTED", 400)


def _keys(value: Any, keys: set[str]) -> None:
    if not isinstance(value, dict) or set(value) != keys:
        raise _invalid()


def _identifier(value: Any) -> bool:
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def _range(value: Any) -> None:
    if not isinstance(value, str) or len(value) > 256 or not _RANGE.fullmatch(value):
        raise _invalid()


def _matches(version: str, wanted: str) -> bool:
    actual = tuple(int(part) for part in version.split("."))
    for token in wanted.split(" "):
        match = re.fullmatch(rf"(>=|<=|>|<|=)?({_STABLE})", token)
        if match is None:
            return False
        target = tuple(int(part) for part in match[2].split("."))
        if not {
            None: actual == target,
            "=": actual == target,
            ">": actual > target,
            ">=": actual >= target,
            "<": actual < target,
            "<=": actual <= target,
        }[match[1]]:
            return False
    return True


def validate_readiness_request(body: Any) -> dict[str, Any]:
    resources = (
        isinstance(body, dict)
        and isinstance(body.get("compatibility"), dict)
        and "resourceDependencies" in body["compatibility"]
    )
    candidate = resources and body.get("schemaVersion") == 2
    _keys(
        body,
        {"schemaVersion", "applicationId", "compatibility"}
        | ({"artifactId"} if resources else set())
        | ({"bindingSetId"} if candidate else set()),
    )
    if resources:
        try:
            if str(UUID(body["artifactId"])) != body["artifactId"]:
                raise ValueError()
        except (TypeError, ValueError, AttributeError):
            raise _invalid() from None
    if (
        type(body["schemaVersion"]) is not int
        or body["schemaVersion"] != (2 if candidate else 1)
        or not _identifier(body["applicationId"])
    ):
        raise _invalid()
    if candidate and (
        not isinstance(body["bindingSetId"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", body["bindingSetId"])
    ):
        raise _invalid()
    requirements = body["compatibility"]
    _keys(
        requirements,
        {
            "backendProductId",
            "clientRange",
            "hostProtocolRange",
            "backendContracts",
            "resourceDependencies" if resources else "requiredExperts",
            "localDataSchema",
        },
    )
    if not _identifier(requirements["backendProductId"]):
        raise _invalid()
    _range(requirements["clientRange"])
    _range(requirements["hostProtocolRange"])
    contracts, experts = requirements["backendContracts"], requirements.get("requiredExperts", [])
    if resources:
        dependencies = requirements["resourceDependencies"]
        if not isinstance(dependencies, list) or len(dependencies) > 64:
            raise _invalid()
        seen_resources = set()
        for dependency in dependencies:
            _keys(dependency, {"kind", "resourceId", "minVersion"})
            resource_id, minimum = dependency["resourceId"], dependency["minVersion"]
            if (
                dependency["kind"] not in ("expert", "skill-package")
                or not isinstance(resource_id, str)
                or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", resource_id)
                or not isinstance(minimum, str)
                or len(minimum) > 32
                or not re.fullmatch(_STABLE, minimum)
                or any(int(part) > 2147483647 for part in minimum.split("."))
            ):
                raise _invalid()
            key = (dependency["kind"], resource_id)
            if key in seen_resources:
                raise _invalid()
            seen_resources.add(key)
    if (
        not isinstance(contracts, list)
        or len(contracts) > 32
        or not isinstance(experts, list)
        or len(experts) > 64
    ):
        raise _invalid()
    seen = set()
    for contract in contracts:
        _keys(contract, {"id", "range", "features"})
        features = contract["features"]
        if (
            not _identifier(contract["id"])
            or contract["id"] in seen
            or not isinstance(features, list)
            or len(features) > 32
            or any(not _identifier(feature) for feature in features)
            or len(set(features)) != len(features)
        ):
            raise _invalid()
        seen.add(contract["id"])
        _range(contract["range"])
    seen = set()
    for expert in experts:
        _keys(expert, {"templateId", "versionRange", "role", "count", "required"})
        if (
            not _identifier(expert["templateId"])
            or not _identifier(expert["role"])
            or type(expert["count"]) is not int
            or not 1 <= expert["count"] <= 64
            or type(expert["required"]) is not bool
        ):
            raise _invalid()
        key = (expert["templateId"], expert["role"])
        if key in seen:
            raise _invalid()
        seen.add(key)
        _range(expert["versionRange"])
    schema = requirements["localDataSchema"]
    _keys(schema, {"readRange", "writeVersion"})
    _range(schema["readRange"])
    if (
        not isinstance(schema["writeVersion"], str)
        or not re.fullmatch(_STABLE, schema["writeVersion"])
        or not _matches(schema["writeVersion"], schema["readRange"])
    ):
        raise _invalid()
    return requirements


async def diagnose_application(
    body: dict[str, Any],
    session: Any,
    snapshot: dict[str, Any],
    get: Any,
    *,
    inspect_resources: Any = None,
) -> dict[str, Any]:
    requirements = validate_readiness_request(body)
    user = session["user"] if isinstance(session, dict) else session.user
    product = requirements["backendProductId"]
    result = {
        **snapshot,
        "applicationId": body["applicationId"],
        "productId": product,
        "status": "blocked",
        "authorization": {"status": "unknown", "code": "APP_AUTHORIZATION_UNVERIFIED"},
        "experts": [],
        "checks": [],
        "readOnly": True,
    }
    dynamic = "resourceDependencies" in requirements
    if not dynamic and APPLICATION_PRODUCTS.get(body["applicationId"]) != product:
        result["authorization"] = {
            "status": "blocked",
            "code": "APPLICATION_BACKEND_MAPPING_UNSUPPORTED",
        }
        return result
    response = await get("/api/auth/me")
    if response.status_code != 200:
        result["authorization"] = {
            "status": "blocked",
            "code": "APP_ENTITLEMENT_REQUIRED"
            if response.status_code in {401, 403}
            else "BACKEND_CAPABILITIES_UNKNOWN",
        }
        return result
    try:
        me = response.json()
    except ValueError:
        me = None
    if not isinstance(me, dict) or me.get("id") != user.get("id") or type(me.get("id")) is not int:
        raise BridgeAuthError("BOX_UPSTREAM_IDENTITY_MISMATCH", 502)
    if me.get("application_id", "wanx") == product:
        result["authorization"] = {"status": "ready"}
    if dynamic:
        result["resources"], result["bindings"] = [], []
        if inspect_resources is None:
            result["checks"].append({"code": "RESOURCE_CENTER_UNAVAILABLE"})
        elif result["authorization"]["status"] == "ready":
            inspection = await inspect_resources(
                {
                    "schemaVersion": body["schemaVersion"],
                    "applicationId": body["applicationId"],
                    "artifactId": body["artifactId"],
                    **(
                        {"bindingSetId": body["bindingSetId"]} if body["schemaVersion"] == 2 else {}
                    ),
                }
            )
            if (
                not isinstance(inspection, dict)
                or inspection.get("applicationId") != body["applicationId"]
                or inspection.get("artifactId") != body["artifactId"]
                or inspection.get("backendProductId") != product
            ):
                raise BridgeAuthError("RESOURCE_APPLICATION_SCOPE_INVALID", 403)
            if body["schemaVersion"] == 2:
                if (
                    inspection.get("schemaVersion") != 2
                    or inspection.get("bindingSetId") != body["bindingSetId"]
                ):
                    raise BridgeAuthError("RESOURCE_APPLICATION_SCOPE_INVALID", 403)
                result.update(
                    schemaVersion=2,
                    artifactId=body["artifactId"],
                    bindingSetId=inspection["bindingSetId"],
                    bindingScope=inspection.get("bindingScope"),
                    operationId=inspection.get("operationId"),
                )
            result["authorization"] = inspection.get("authorization", {"status": "unknown"})
            result["resources"] = inspection.get("resources", [])
            result["bindings"] = inspection.get("bindings", [])
            if inspection.get("status") != "ready":
                result["checks"].append({"code": inspection.get("code", "RESOURCE_NOT_PREPARED")})
    # A WANX parent token cannot prove entitlement to a separately scoped product.
    # Calling the existing application exchange here could auto-grant/create data.
    unbound = None
    if requirements.get("requiredExperts") and result["authorization"]["status"] == "ready":
        response = await get("/api/agents?scope=mine")
        if response.status_code == 200:
            try:
                rows = response.json()
            except ValueError:
                rows = None
            if isinstance(rows, list) and all(isinstance(row, dict) for row in rows):
                unbound = [
                    row["agent_id"]
                    for row in rows
                    if row.get("user_id") == me["id"]
                    and row.get("is_shared") is False
                    and isinstance(row.get("agent_id"), str)
                ]
    for expert in requirements.get("requiredExperts", []):
        result["experts"].append(
            {
                "templateId": expert["templateId"],
                "role": expert["role"],
                "status": "blocked",
                "code": "EXPERT_NOT_PREPARED" if unbound == [] else "EXPERT_VERSION_UNKNOWN",
                "instances": [],
                "required": expert["required"],
                "migration": {"status": "blocked", "code": "EXPERT_MIGRATION_UNSUPPORTED"},
            }
        )
    if unbound is not None:
        result["unmanagedInstances"] = [
            {"instanceId": item, "status": "provenance_unknown"} for item in unbound
        ]
    actual = {contract["id"]: contract for contract in snapshot["contracts"]}
    for contract in requirements["backendContracts"]:
        available = actual.get(contract["id"])
        if (
            not available
            or not _matches(available["version"], contract["range"])
            or not set(contract["features"]) <= set(available["features"])
        ):
            result["checks"].append(
                {"code": "BACKEND_CONTRACT_INCOMPATIBLE", "detail": contract["id"]}
            )
    if (
        result["authorization"]["status"] == "ready"
        and not result["checks"]
        and not any(expert["required"] for expert in requirements.get("requiredExperts", []))
    ):
        result["status"] = "ready"
    return result
