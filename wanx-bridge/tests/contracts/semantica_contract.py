"""Audit the bridge against a Semantica OpenAPI export and selected source contracts.

No backend startup, database access, writes or model calls. Optional live probes
are limited to fixed read-only metadata paths. Run from wanx-bridge with uv run.
"""

from __future__ import annotations

import argparse
import ast
import asyncio
import hashlib
import json
import re
from pathlib import Path
from types import SimpleNamespace

import httpx
import jsonschema
from pydantic import SecretStr
from starlette.datastructures import Headers

from wanx_bridge.semantica.desktop import DesktopConfig, DesktopError, decode, prepare, resolve

UID = "10000000-0000-4000-8000-000000000001"
REASONING = (
    "discover",
    "prepare",
    "reference",
    "scope",
    "search",
    "evidence",
    "read-document",
    "coverage",
)
REASONING_MODELS = dict(
    zip(
        REASONING,
        (
            "DiscoverRequest",
            "PrepareRequest",
            "ReferenceRequest",
            "ScopeRequest",
            "ScopedSearchRequest",
            "ScopedEvidenceRequest",
            "DocumentReadRequest",
            "ScopeRequest",
        ),
        strict=True,
    )
)
# Present in Semantica but intentionally outside the STARLINK desktop surface.
OTHER = {
    ("POST", "/api/integration/documents"),
    ("PUT", "/api/integration/documents/{document_id}/text"),
    ("DELETE", "/api/integration/documents/{document_id}"),
    ("POST", "/api/integration/search/workspaces"),
    ("POST", "/api/integration/processing/authorize"),
}
CONFIG = DesktopConfig(
    "http://127.0.0.1:8090", "contract-only-" + "a" * 32, "contract-box", "semantica"
)


def sample(schema, document):
    if "$ref" in schema:
        return sample(document["components"]["schemas"][schema["$ref"].rsplit("/", 1)[1]], document)
    if "default" in schema:
        return schema["default"]
    if "enum" in schema:
        return schema["enum"][0]
    if "const" in schema:
        return schema["const"]
    if "anyOf" in schema:
        return sample(next(s for s in schema["anyOf"] if s.get("type") != "null"), document)
    kind = schema.get("type", "object")
    if kind == "object":
        return {k: sample(schema["properties"][k], document) for k in schema.get("required", [])}
    if kind == "array":
        return [sample(schema["items"], document) for _ in range(schema.get("minItems", 0))]
    if kind in {"integer", "number"}:
        return max(1, schema.get("minimum", 0), schema.get("exclusiveMinimum", 0) + 1)
    if kind == "boolean":
        return True
    if schema.get("pattern") == "^[0-9a-f]{64}$":
        return "a" * 64
    return "a" * max(1, schema.get("minLength", 1))


def validate(value, schema, document):
    jsonschema.Draft202012Validator({"components": document["components"], **schema}).validate(
        value
    )


def audit_routes(document):
    rows, outside, errors = [], [], []
    for template, methods in document["paths"].items():
        if not template.startswith(("/api/integration/", "/api/open/v1/")):
            continue
        for method, contract in methods.items():
            method = method.upper()
            if (method, template) in OTHER:
                outside.append({"method": method, "upstream": template})
                continue
            for reasoning in REASONING if "{operation}" in template else (None,):
                path = re.sub(
                    r"\{([^}]+)\}",
                    lambda m: (
                        reasoning
                        if m[1] == "operation"
                        else UID
                        if m[1] in {"warehouse_id", "transfer_id", "key_id"}
                        else "contract-skill"
                        if m[1] == "skill_id"
                        else "contract-id"
                    ),
                    template,
                )
                desktop = (
                    path.removeprefix("/api/integration")
                    if path.startswith("/api/integration/")
                    else path.removeprefix("/api")
                )
                try:
                    op = resolve(method, desktop)
                    queries = {
                        p["name"]: p["schema"]
                        for p in contract.get("parameters", [])
                        if p["in"] == "query"
                    }
                    assert op.query_keys <= queries.keys(), (
                        f"undeclared queries: {op.query_keys - queries.keys()}"
                    )
                    # Explicit workspace selection belongs only to the trusted scope.
                    assert not (queries.keys() - op.query_keys - {"workspace_id"}), (
                        "missing supported query"
                    )
                    schema = (
                        contract.get("requestBody", {})
                        .get("content", {})
                        .get("application/json", {})
                        .get("schema")
                    )
                    body = sample(schema, document) if schema else ({} if method != "GET" else None)
                    if body is not None and "warehouse_id" in body:
                        body["warehouse_id"] = UID
                    if reasoning:
                        argument_schema = {
                            "$ref": "#/components/schemas/" + REASONING_MODELS[reasoning]
                        }
                        arguments = sample(argument_schema, document)
                        arguments.pop("workspace_id", None)
                        body["arguments"] = arguments
                        validate({**arguments, "workspace_id": UID}, argument_schema, document)
                    if op.path == "/processing/reprocess":
                        body["documents"] = [
                            {"id": "contract-document", "version_id": "contract-version"}
                        ]
                    if body is not None and not op.public and op.path != "/search":
                        body["operation_id"] = "contract-operation"
                    query = {
                        k: str(sample(v, document))
                        for k, v in queries.items()
                        if k in op.query_keys
                    }
                    if "warehouse_id" in query:
                        query["warehouse_id"] = UID
                    outgoing, operation_id = prepare(op, method, body, query)
                    if schema:
                        validate(outgoing, schema, document)
                    response_schema = (
                        contract.get("responses", {})
                        .get("200", {})
                        .get("content", {})
                        .get("application/json", {})
                        .get("schema")
                    )
                    if response_schema:
                        response_sample = sample(response_schema, document)
                        validate(response_sample, response_schema, document)
                        assert decode(200, json.dumps(response_sample).encode()) == response_sample
                    if method == "PATCH":
                        assert (
                            operation_id == "contract-operation" and "operation_id" not in outgoing
                        )
                    # All default-resource endpoints must also route under a warehouse prefix.
                    if not op.public and not desktop.startswith(("/warehouses", "/processing")):
                        scoped = resolve(method, "/warehouses/" + UID + desktop)
                        assert scoped.warehouse == UID and scoped.path == op.path
                    rows.append(
                        {
                            "method": method,
                            "desktop": desktop,
                            "upstream": path,
                            "queries": sorted(op.query_keys),
                            "request_schema": schema,
                            "response_schema": contract.get("responses", {})
                            .get("200", {})
                            .get("content", {})
                            .get("application/json", {})
                            .get("schema"),
                        }
                    )
                except (DesktopError, AssertionError, jsonschema.ValidationError) as exc:
                    errors.append({"method": method, "upstream": path, "error": str(exc)})
    return rows, outside, errors


def callback_contract(source, document):
    """Capture the real Semantica serializer without making its HTTP call."""
    import hmac

    path = source / "app/services/processing_models.py"
    tree = ast.parse(path.read_text(encoding="utf8"))
    encode = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "encode")
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "ProcessingModels")
    relay = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "relay")
    captured = []

    class Client:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def send(self, request):
            captured.append(request)
            return httpx.Response(200, json={"text": '{"ok":true}', "usage": {"total_tokens": 1}})

    import time
    import uuid

    ns = {
        "json": json,
        "hmac": hmac,
        "hashlib": hashlib,
        "time": time,
        "uuid": uuid,
        "httpx": SimpleNamespace(Request=httpx.Request, Client=Client, HTTPError=httpx.HTTPError),
        "controlled": lambda: False,
        "WarehouseError": type("WarehouseError", (ValueError,), {}),
    }
    exec(compile(ast.Module(body=[encode, relay], type_ignores=[]), str(path), "exec"), ns)
    owner = json.dumps([CONFIG.box_id, CONFIG.application_id, "wanx:7"])
    state = SimpleNamespace(
        base="http://127.0.0.1:18089",
        settings=SimpleNamespace(
            integration_service_token=SecretStr(CONFIG.service_token), model_timeout_seconds=180
        ),
    )
    selected = {"id": "1:contract", "revision": "a" * 64}
    cases = (
        ("catalog", None),
        ("check", {"selection": selected}),
        (
            "infer",
            {
                "job_id": "contract-job",
                "warehouse_id": UID,
                "purpose": "extraction",
                "selection": selected,
                "text": "synthetic",
                "schema": {"type": "object"},
            },
        ),
    )
    for mode, (action, payload) in (
        (mode, case) for mode in ("standalone", "managed") for case in cases
    ):
        state.settings.integration_mode = mode
        state.settings.integration_service_token = SecretStr(
            "" if mode == "standalone" else CONFIG.service_token
        )
        result = ns["relay"](state, action, owner, payload)
        assert result == {"text": '{"ok":true}', "usage": {"total_tokens": 1}}
        request = captured[-1]
        assert request.url.path == "/internal/starklink/models"
        assert json.loads(request.content) == {"action": action, "owner": owner, **(payload or {})}
        stamp, nonce = request.headers["x-starklink-time"], request.headers["x-starklink-nonce"]
        expected = hmac.new(
            CONFIG.service_token.encode(),
            stamp.encode() + b"." + nonce.encode() + b"." + request.content,
            hashlib.sha256,
        ).hexdigest()
        if mode == "managed":
            assert request.headers["x-starklink-signature"] == expected
        else:
            assert "x-starklink-signature" not in request.headers
            assert "authorization" not in request.headers
        assert re.fullmatch(r"[a-f0-9]{32}", nonce)
    validate(
        {
            "operation_id": "contract-operation",
            "job_id": "contract-job",
            "purpose": "extraction",
            "model_id": selected["id"],
            "model_revision": selected["revision"],
        },
        {"$ref": "#/components/schemas/AuthorizeInput"},
        document,
    )
    return {
        "serializer_and_return_envelope": "passed",
        "authorize_request_schema": "passed",
        "actions": ["catalog", "check", "infer"],
        "standalone_without_shared_secret": "passed",
        "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def auth_contract(source):
    path = source / "app/integration/auth.py"
    tree = ast.parse(path.read_text(encoding="utf8"))
    # Execute only the authentication module, excluding its Settings import.
    # It performs no backend initialization; tests supply synthetic settings.
    tree.body = [
        n for n in tree.body if not isinstance(n, ast.ImportFrom) or n.module != "app.config"
    ]
    ns = {"__name__": "semantica_contract_auth"}
    exec(compile(tree, str(path), "exec"), ns)
    ns["IntegrationScope"].model_rebuild(_types_namespace=ns)
    settings = SimpleNamespace(
        application_tokens=lambda: {},
        integration_service_token=SecretStr(CONFIG.service_token),
        integration_application_id=CONFIG.application_id,
        integration_box_id=CONFIG.box_id,
        integration_mode="standalone",
    )
    for warehouse in (None, UID):
        for owner_view in (False, True):
            headers = CONFIG.headers(
                7, "wanx", "contract-operation", warehouse, owner_view=owner_view, ttl=300
            )
            scope = ns["authenticate"](Headers(headers), settings)
            scope.require(scope.workspace_id, write=True, operation_id="contract-operation")
            scope.validate_bindings(required=True)
            assert scope.owner_view is owner_view

    async def check_middleware(mode):
        seen = []

        async def app(scope, receive, send):
            seen.append(ns["request_scope"].get() is not None)

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            raise AssertionError(message)

        settings.integration_mode = mode
        headers = CONFIG.headers(7, "wanx")
        if mode == "standalone":
            settings.integration_service_token = SecretStr("")
            settings.integration_box_id = settings.integration_application_id = ""
            headers = {"x-semantica-scope": headers["x-semantica-scope"]}
        else:
            settings.integration_service_token = SecretStr(CONFIG.service_token)
            settings.integration_box_id = CONFIG.box_id
            settings.integration_application_id = CONFIG.application_id
        middleware = ns["ManagedAuthMiddleware"](app, settings=settings, surface="workbench")
        await middleware(
            {
                "type": "http",
                "method": "GET",
                "path": "/api/integration/status",
                "headers": [(k.encode(), v.encode()) for k, v in headers.items()],
            },
            receive,
            send,
        )
        return seen == [True]

    return {
        "signature_and_workspace_binding": "passed",
        "standalone_establishes_scope": asyncio.run(check_middleware("standalone")),
        "managed_establishes_scope": asyncio.run(check_middleware("managed")),
        "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def probe(origin):
    from wanx_bridge.semantica.config import upstream_origin

    origin = upstream_origin(origin)
    rows = []
    with httpx.Client(trust_env=False, follow_redirects=False, timeout=10) as client:
        for path in (
            "/api/health/live",
            "/api/health/ready",
            "/api/settings/status",
            "/api/integration/status",
            "/api/integration/capabilities",
            "/api/integration/warehouses",
            "/api/integration/processing/catalog",
        ):
            response = client.get(origin + path)
            data = response.json()
            # Do not persist document data, credentials or private configuration.
            value = {
                k: data[k]
                for k in ("status", "version", "integration_mode", "mcp_authentication", "detail")
                if k in data
            }
            rows.append({"path": path, "status": response.status_code, "metadata": value})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--openapi", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument(
        "--url", help="Optional running service origin; fixed GET metadata probes only"
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    document = json.loads(args.openapi.read_text(encoding="utf8"))
    rows, outside, errors = audit_routes(document)
    # Pin this audited surface so removing an upstream operation cannot silently pass.
    if len(rows) + len(errors) != 73:
        errors.append(
            {"error": "STARLINK surface changed: expected 73 expanded method/operation pairs"}
        )
    report = {
        "version": document["info"]["version"],
        "openapi_sha256": hashlib.sha256(args.openapi.read_bytes()).hexdigest(),
        "matched_operations": len(rows),
        "errors": errors,
        "outside_desktop_scope": outside,
        "auth": auth_contract(args.source),
        "model_callback": callback_contract(args.source, document),
        "routes": rows,
    }
    if args.url:
        report["live_readonly"] = probe(args.url)
    if args.output:
        args.output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
        )
    print(
        json.dumps({k: v for k, v in report.items() if k != "routes"}, ensure_ascii=True, indent=2)
    )
    raise SystemExit(1 if errors else 0)


if __name__ == "__main__":
    main()
