"""Read-only factory/upgrade checks against the running WANX loopback service.

This profile verifies shared prerequisites, not customer accounts, purchased app
licenses or paid inference. It never creates an expert, library or personal space,
changes a feature switch, installs a package, or contacts a model provider.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from .admin_client import AdminClient, BridgeUpstreamError

SCHEMA_VERSION = 1
PROFILE_VERSION = 1
PROFILE_ID = "wanx-five-apps"
COUNCIL_TEMPLATES = (
    "brainstorm-council-strategy",
    "brainstorm-council-resources",
    "brainstorm-council-review",
    "brainstorm-council-action",
)
APPLICATIONS = (
    ("ai-browser", "centaurai.wanx.ai-browser"),
    ("centaurloop", "centaurai.wanx.centaurloop"),
    ("superadvisors", "centaurai.wanx.superadvisors"),
    ("dialogue", "centaurai.wanx.dialogue"),
    ("zhijun", "centaurai.wanx.zhijun"),
)


@dataclass(frozen=True)
class Observation:
    status: int = 0
    data: Any = None

    @property
    def ok(self) -> bool:
        return self.status == 200

    def coded_not_found(self, *, codes: tuple[str, ...] = ("NOT_FOUND",)) -> bool:
        return (
            self.status == 404
            and isinstance(self.data, dict)
            and isinstance(self.data.get("error"), dict)
            and self.data["error"].get("code") in codes
        )


async def _observe(client: AdminClient, path: str) -> Observation:
    try:
        response = await client._admin("GET", path)
        return Observation(response.status_code, response.json())
    except (BridgeUpstreamError, ValueError):
        # No response body, provider URL or exception message crosses the receipt.
        return Observation()


def _check(code: str, ok: bool, *, scope: str = "service") -> dict[str, Any]:
    return {"code": code, "status": "ready" if ok else "blocked", "scope": scope}


def _customer_pending() -> dict[str, str]:
    return {
        "code": "CUSTOMER_INITIALIZATION_PENDING",
        "status": "pending",
        "scope": "customer",
    }


def _application(code: str, app_id: str, checks: list[dict[str, Any]]) -> dict[str, Any]:
    blocked = any(c["status"] == "blocked" for c in checks)
    return {
        "code": code,
        "applicationId": app_id,
        "status": "blocked" if blocked else "pending_customer",
        "prerequisitesReady": not blocked,
        "customerInitialization": "on_authenticated_use",
        "checks": checks + [_customer_pending()],
    }


def _receipt(
    mode: str, checks: list[dict[str, Any]], applications: list[dict[str, Any]]
) -> dict[str, Any]:
    all_checks = checks + [c for app in applications for c in app["checks"]]
    service_ready = not any(
        c["scope"] == "service" and c["status"] == "blocked" for c in all_checks
    )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "profileId": PROFILE_ID,
        "profileVersion": PROFILE_VERSION,
        "mode": mode,
        "ready": service_ready and all(app["prerequisitesReady"] for app in applications),
        "serviceReady": service_ready,
        "checks": checks,
        "applications": applications,
        "customerInitialization": "on_authenticated_use",
        "customerPermissions": "not_verified",
        "inference": "not_tested",
        "resourceDelivery": "bundled_templates_checked_admin_mapping_not_verified",
        "mutations": False,
    }


def _failure(mode: str, code: str) -> dict[str, Any]:
    return _receipt(
        mode,
        [_check(code, False)],
        [_application(name, app_id, [_check(code, False)]) for name, app_id in APPLICATIONS],
    )


def _dict(observation: Observation) -> dict[str, Any]:
    return observation.data if observation.ok and isinstance(observation.data, dict) else {}


def _valid_models(observation: Observation) -> list[dict[str, Any]]:
    if not observation.ok or not isinstance(observation.data, list):
        return []
    return [
        row
        for row in observation.data
        if isinstance(row, dict)
        and isinstance(row.get("provider_name"), str)
        and row["provider_name"]
        and isinstance(row.get("model"), str)
        and row["model"]
    ]


def _browser_model(
    providers: Observation, active: Observation, models: list[dict[str, Any]]
) -> bool:
    """Mirror the browser's configured WANX model requirement, not inference.

    The native provider endpoint contains secrets. Only a boolean is retained in
    the public result; neither provider rows nor URLs are copied to the receipt.
    An absent/stale active selection uses the first usable native model.
    """
    models = _usable_models(providers, models)
    if not models:
        return False
    selected = _dict(active)
    target = next(
        (
            row
            for row in models
            if row["provider_name"] == selected.get("provider_name")
            and row["model"] == selected.get("model")
        ),
        models[0],
    )
    return bool(target)


def _usable_models(providers: Observation, models: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Native resolution also requires a service address, unlike its catalog API."""
    if not providers.ok or not isinstance(providers.data, list):
        return []
    names = {
        row["name"]
        for row in providers.data
        if isinstance(row, dict)
        and isinstance(row.get("name"), str)
        and row.get("enabled") is True
        and isinstance(row.get("base_url"), str)
        and row["base_url"]
        and isinstance(row.get("api_key"), str)
        and row["api_key"]
    }
    return [row for row in models if row["provider_name"] in names]


async def inspect_delivery(
    root: Path,
    base_url: str,
    *,
    mode: str = "factory",
    credentials_file: Path | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Return bounded, credential-free evidence; only authentication uses POST.

    ``ready`` means shared prerequisites/configuration, never customer usability.
    ``serviceReady`` deliberately excludes missing models and explicit disabled
    customer settings so an OTA never resets them or rolls back for those choices.
    """
    if mode not in {"factory", "upgrade"}:
        raise ValueError("invalid delivery mode")
    client = AdminClient(
        base_url, credentials_file or root / "credential.json", transport=transport
    )
    try:
        try:
            health = client._json(await client._request("GET", "/api/health"))
            if health.get("ok") is not True or health.get("db") is not True:
                return _failure(mode, "WANX_SERVICE_UNHEALTHY")
            await client._admin_login()
        except BridgeUpstreamError:
            return _failure(mode, "WANX_DELIVERY_ACCESS_UNAVAILABLE")

        # Factory credentials must belong to WANX, not a customer's product.
        me = _dict(await _observe(client, "/api/auth/me"))
        if me.get("role") != "admin" or me.get("application_id") != "wanx":
            return _failure(mode, "WANX_DELIVERY_ADMIN_SCOPE_INVALID")
        paths = {
            "models": "/api/providers/resolved",
            "providers": "/api/providers",
            "active": "/api/providers/active-model",
            "experts": "/api/experts",
            "browser_control": "/api/browser/control-capabilities",
            "browser_env": "/api/browser/env-status",
            "loops": "/api/loops/capability",
            "product": "/api/admin/applications/super-advisory",
            "deployment": "/api/admin/applications/super-advisory/deployment",
            # WANX admin is outside the product scope: a structured native 404
            # proves this route executes without initializing a product profile.
            "brainstorm": "/api/brainstorm/profile",
            "dialogue": "/api/dialogue/sessions",
            "knowledge": "/api/knowledge-bases/capability",
            # No real customer agent is read. Generic HTTP 404 is NOT evidence.
            "ontology": f"/api/agents/delivery-probe-{uuid.uuid4().hex}/ontology",
        }
        results = await asyncio.gather(*(_observe(client, path) for path in paths.values()))
        observed = dict(zip(paths, results, strict=True))
        return _evaluate(root, mode, observed)
    finally:
        await client.close()


def _evaluate(root: Path, mode: str, observed: dict[str, Observation]) -> dict[str, Any]:
    models = _valid_models(observed["models"])
    model_api = (
        observed["models"].ok
        and isinstance(observed["models"].data, list)
        and len(models) == len(observed["models"].data)
    )
    models = _usable_models(observed["providers"], models)
    model_check = _check("MODEL_NOT_CONFIGURED", bool(models), scope="configuration")
    catalog = observed["experts"]
    catalog_ok = (
        catalog.ok
        and isinstance(catalog.data, list)
        and all(
            isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"]
            for row in catalog.data
        )
    )
    templates = (
        {
            row.get("id")
            for row in catalog.data
            if isinstance(row, dict) and isinstance(row.get("id"), str)
        }
        if catalog_ok
        else set()
    )
    knowledge = _dict(observed["knowledge"])
    knowledge_checks = knowledge.get("checks", {})
    knowledge_api = all(
        type(knowledge.get(key)) is bool
        for key in ("feature_enabled", "prerequisites_ok", "usable")
    ) and isinstance(knowledge_checks, dict)
    knowledge_runtime = _check(
        "KNOWLEDGE_RUNTIME_MISSING",
        knowledge_api and knowledge_checks.get("deps_available") is True,
    )
    knowledge_setting = _check(
        "KNOWLEDGE_FEATURE_DISABLED",
        knowledge.get("feature_enabled") is True,
        scope="configuration",
    )
    knowledge_ready = _check(
        "KNOWLEDGE_PREREQUISITES_FAILED",
        knowledge.get("prerequisites_ok") is True and knowledge.get("usable") is True,
        scope="configuration",
    )
    control = _dict(observed["browser_control"])
    browser_env = _dict(observed["browser_env"])
    loops = _dict(observed["loops"])
    product = _dict(observed["product"])
    deployment = _dict(observed["deployment"])
    dialogue = _dict(observed["dialogue"])
    apps = {
        "ai-browser": [
            _check(
                "BROWSER_CONTROL_UNAVAILABLE",
                type(control.get("version")) is int
                and control["version"] == 1
                and control.get("exclusive_control") is True
                and type(control.get("skill_learning")) is int
                and control["skill_learning"] == 1,
            ),
            _check(
                "BROWSER_RUNTIME_MISSING",
                browser_env.get("browsers_ok") is True
                and browser_env.get("harness_browser") is True,
            ),
            _check(
                "BROWSER_MODEL_NOT_CONFIGURED",
                _browser_model(observed["providers"], observed["active"], models),
                scope="configuration",
            ),
        ],
        "centaurloop": [
            _check(
                "LOOP_CAPABILITY_UNAVAILABLE",
                type(loops.get("protocol_version")) is int
                and loops["protocol_version"] >= 2
                and all(
                    loops.get(key) is True
                    for key in (
                        "available",
                        "human_judgments",
                        "channel_interaction",
                        "visual_builder",
                        "routine_tasks",
                        "dedicated_executor",
                        "result_delivery",
                        "resource_selection",
                    )
                ),
            ),
            _check("LOOP_TEMPLATE_MISSING", "centaurloop" in templates),
            model_check,
            knowledge_runtime,
            knowledge_setting,
            knowledge_ready,
        ],
        "superadvisors": [
            _check("BRAINSTORM_API_UNAVAILABLE", observed["brainstorm"].coded_not_found()),
            _check(
                "APPLICATION_MANAGEMENT_API_UNAVAILABLE",
                all(
                    (observed[key].ok and isinstance(observed[key].data, dict))
                    or observed[key].coded_not_found()
                    for key in ("product", "deployment")
                ),
            ),
            _check("COUNCIL_TEMPLATES_MISSING", set(COUNCIL_TEMPLATES).issubset(templates)),
            _check(
                "ADVISORY_PRODUCT_NOT_CONFIGURED",
                product.get("application_id") == "super-advisory"
                and isinstance(product.get("capabilities"), list)
                and {"teams", "brainstorm"}.issubset(product["capabilities"]),
                scope="configuration",
            ),
            _check(
                "ADVISORY_PRODUCT_DISABLED",
                deployment.get("enabled") is True,
                scope="configuration",
            ),
            model_check,
        ],
        "dialogue": [
            _check("DIALOGUE_STORAGE_API_UNAVAILABLE", isinstance(dialogue.get("sessions"), list)),
            model_check,
        ],
        "zhijun": [
            _check("ZHIJUN_TEMPLATE_MISSING", "zhijun-personal-companion" in templates),
            # Native application access may reject the absent probe Agent before
            # the ontology handler runs. Both native 404 codes are valid here;
            # authorization failures and generic missing routes remain blocked.
            _check(
                "ONTOLOGY_API_UNAVAILABLE",
                observed["ontology"].coded_not_found(codes=("NOT_FOUND", "AGENT_NOT_FOUND")),
            ),
            model_check,
            knowledge_runtime,
            knowledge_setting,
            knowledge_ready,
        ],
    }
    common = [
        _check("WANX_SERVICE_UNHEALTHY", True),
        _check("MODEL_CATALOG_UNAVAILABLE", model_api),
        _check("EXPERT_CATALOG_UNAVAILABLE", catalog_ok),
        _check(
            "WANX_STORAGE_UNWRITABLE",
            root.is_dir() and os.access(root, os.R_OK | os.W_OK | os.X_OK),
        ),
    ]
    return _receipt(
        mode, common, [_application(name, app_id, apps[name]) for name, app_id in APPLICATIONS]
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--credentials-file", type=Path)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--mode", choices=("factory", "upgrade"), default="factory")
    args = parser.parse_args(argv)
    try:
        receipt = asyncio.run(
            inspect_delivery(
                args.root, args.base_url, mode=args.mode, credentials_file=args.credentials_file
            )
        )
    except Exception:
        receipt = _failure(args.mode, "WANX_DELIVERY_PROBE_FAILED")
    print(json.dumps(receipt, separators=(",", ":"), ensure_ascii=True))
    return 0 if receipt["serviceReady"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
