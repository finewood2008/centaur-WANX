"""Factory and OTA readiness must observe services without changing customer state."""

from __future__ import annotations

import copy
import json

import httpx
import pytest

from wanx_bridge import delivery_readiness as delivery

pytest_plugins = ["test_upstream"]


@pytest.fixture
def root(tmp_path):
    credential = tmp_path / "credential.json"
    credential.write_text(json.dumps({"username": "factory", "password": "private-password"}))
    credential.chmod(0o600)
    return tmp_path


class Upstream:
    def __init__(self):
        self.calls = []
        self.overrides = {}
        self.me = {"id": 1, "role": "admin", "application_id": "wanx"}
        self.models = [{"provider_name": "deepseek", "model": "chat"}]
        self.knowledge_enabled = True

    def __call__(self, request):
        path = request.url.path
        self.calls.append((request.method, path))
        if path == "/api/health":
            return httpx.Response(200, json={"ok": True, "db": True})
        if path == "/api/auth/captcha":
            return httpx.Response(200, json={"provider": "slider"})
        if path == "/api/auth/login":
            assert request.method == "POST"
            assert json.loads(request.content) == {
                "username": "factory",
                "password": "private-password",
            }
            return httpx.Response(200, json={"access_token": "private-token", "user": self.me})
        assert request.method == "GET", "readiness must not install or change configuration"
        assert request.headers["authorization"] == "Bearer private-token"
        key = "ontology" if path.startswith("/api/agents/delivery-probe-") else path
        if key in self.overrides:
            status, body = self.overrides[key]
            return httpx.Response(status, json=body)
        data = {
            "/api/auth/me": self.me,
            "/api/providers/resolved": self.models,
            "/api/providers/active-model": {"provider_name": "deepseek", "model": "chat"},
            "/api/providers": [
                {
                    "name": "deepseek",
                    "base_url": "https://api.deepseek.com",
                    "api_key": "private-api-key",
                    "enabled": True,
                }
            ],
            "/api/experts": [
                {"id": name}
                for name in [
                    "centaurloop",
                    "zhijun-personal-companion",
                    *delivery.COUNCIL_TEMPLATES,
                ]
            ],
            "/api/browser/control-capabilities": {
                "version": 1,
                "exclusive_control": True,
                "skill_learning": 1,
            },
            "/api/browser/env-status": {
                "browsers_ok": True,
                "harness_browser": True,
                "chrome_path": "/private/path/chrome",
            },
            "/api/loops/capability": {
                "protocol_version": 2,
                **dict.fromkeys(
                    [
                        "available",
                        "human_judgments",
                        "channel_interaction",
                        "visual_builder",
                        "routine_tasks",
                        "dedicated_executor",
                        "result_delivery",
                        "resource_selection",
                    ],
                    True,
                ),
            },
            "/api/admin/applications/super-advisory": {
                "application_id": "super-advisory",
                "capabilities": ["teams", "brainstorm"],
            },
            "/api/admin/applications/super-advisory/deployment": {
                "application_id": "super-advisory",
                "enabled": True,
            },
            "/api/dialogue/sessions": {"sessions": []},
            "/api/knowledge-bases/capability": {
                "feature_enabled": self.knowledge_enabled,
                "prerequisites_ok": True,
                "usable": self.knowledge_enabled,
                "checks": {"deps_available": True},
            },
        }
        if key == "ontology" or path == "/api/brainstorm/profile":
            return httpx.Response(
                404,
                json={
                    "error": {
                        "code": "AGENT_NOT_FOUND" if key == "ontology" else "NOT_FOUND",
                        "message": "private detail",
                    }
                },
            )
        assert path in data, path
        return httpx.Response(200, json=data[path])


async def inspect(root, upstream, **kwargs):
    return await delivery.inspect_delivery(
        root, "http://127.0.0.1:18088", transport=httpx.MockTransport(upstream), **kwargs
    )


def blocked_codes(receipt):
    checks = receipt["checks"] + [c for app in receipt["applications"] for c in app["checks"]]
    return {c["code"] for c in checks if c["status"] == "blocked"}


@pytest.mark.parametrize("mode", ["factory", "upgrade"])
async def test_shared_prerequisites_do_not_claim_customer_or_inference_ready(root, mode):
    upstream = Upstream()
    before = sorted(root.iterdir())
    report = await inspect(root, upstream, mode=mode)
    assert report["schemaVersion"] == report["profileVersion"] == 1
    assert report["ready"] is True
    assert report["serviceReady"] is True
    assert report["mutations"] is False
    assert report["inference"] == "not_tested"
    assert report["customerPermissions"] == "not_verified"
    assert report["customerInitialization"] == "on_authenticated_use"
    assert len(report["applications"]) == 5
    assert {a["status"] for a in report["applications"]} == {"pending_customer"}
    assert sorted(root.iterdir()) == before
    assert [p for m, p in upstream.calls if m != "GET"] == ["/api/auth/login"]
    assert not any(
        "personal-space" in path or "knowledge-base/" in path for _, path in upstream.calls
    )
    output = json.dumps(report)
    assert "private" not in output
    assert "api.deepseek.com" not in output


async def test_missing_models_and_explicit_disabled_settings_never_fail_service_upgrade(root):
    upstream = Upstream()
    upstream.models = []
    upstream.knowledge_enabled = False
    upstream.overrides["/api/admin/applications/super-advisory/deployment"] = (
        200,
        {"enabled": False},
    )
    original = copy.deepcopy(upstream.overrides)
    report = await inspect(root, upstream, mode="upgrade")
    assert report["serviceReady"] is True
    assert report["ready"] is False
    assert {
        "MODEL_NOT_CONFIGURED",
        "KNOWLEDGE_FEATURE_DISABLED",
        "ADVISORY_PRODUCT_DISABLED",
    } <= blocked_codes(report)
    assert upstream.overrides == original
    assert upstream.knowledge_enabled is False


@pytest.mark.parametrize("path", ["ontology", "/api/brainstorm/profile", "/api/dialogue/sessions"])
async def test_generic_404_is_not_running_contract_evidence(root, path):
    upstream = Upstream()
    upstream.overrides[path] = (404, {"detail": "Not Found"})
    report = await inspect(root, upstream)
    assert report["serviceReady"] is False


@pytest.mark.parametrize("mode", ["factory", "upgrade"])
@pytest.mark.parametrize("code", ["NOT_FOUND", "AGENT_NOT_FOUND"])
async def test_ontology_missing_agent_uses_native_structured_404(root, mode, code):
    upstream = Upstream()
    # Native current_user application access rejects a nonexistent probe Agent
    # before the private ontology handler can return its generic NOT_FOUND.
    upstream.overrides["ontology"] = (
        404,
        {"error": {"code": code, "message": "private agent detail"}},
    )
    report = await inspect(root, upstream, mode=mode)
    assert report["serviceReady"] is True
    assert "ONTOLOGY_API_UNAVAILABLE" not in blocked_codes(report)
    assert "private" not in json.dumps(report)
    assert [p for m, p in upstream.calls if m != "GET"] == ["/api/auth/login"]


@pytest.mark.parametrize(
    "status,body",
    [
        (401, {"error": {"code": "AGENT_NOT_FOUND"}}),
        (403, {"error": {"code": "AGENT_NOT_FOUND"}}),
        (200, {"error": {"code": "AGENT_NOT_FOUND"}}),
        (500, {"error": {"code": "AGENT_NOT_FOUND"}}),
        (404, {"detail": "Not Found"}),
        (404, {"error": "AGENT_NOT_FOUND"}),
        (404, {"error": {"message": "AGENT_NOT_FOUND"}}),
        (404, {"error": {"code": "FORBIDDEN"}}),
        (404, {"error": {"code": "UNKNOWN_ROUTE"}}),
    ],
)
async def test_ontology_rejects_non_native_missing_agent_results(root, status, body):
    upstream = Upstream()
    upstream.overrides["ontology"] = (status, body)
    report = await inspect(root, upstream, mode="upgrade")
    assert report["serviceReady"] is False
    assert "ONTOLOGY_API_UNAVAILABLE" in blocked_codes(report)


async def test_agent_not_found_does_not_mask_other_missing_contracts(root):
    upstream = Upstream()
    upstream.overrides["/api/brainstorm/profile"] = (404, {"error": {"code": "AGENT_NOT_FOUND"}})
    report = await inspect(root, upstream, mode="upgrade")
    assert report["serviceReady"] is False
    assert "BRAINSTORM_API_UNAVAILABLE" in blocked_codes(report)


@pytest.mark.parametrize(
    "path,body,code",
    [
        ("/api/experts", [], "COUNCIL_TEMPLATES_MISSING"),
        (
            "/api/browser/env-status",
            {"browsers_ok": False, "harness_browser": True},
            "BROWSER_RUNTIME_MISSING",
        ),
        (
            "/api/browser/control-capabilities",
            {"version": 1, "exclusive_control": False, "skill_learning": 1},
            "BROWSER_CONTROL_UNAVAILABLE",
        ),
        ("/api/loops/capability", {"protocol_version": 1}, "LOOP_CAPABILITY_UNAVAILABLE"),
        ("/api/providers/resolved", {"models": []}, "MODEL_CATALOG_UNAVAILABLE"),
        ("/api/dialogue/sessions", {"sessions": "invalid"}, "DIALOGUE_STORAGE_API_UNAVAILABLE"),
    ],
)
async def test_runtime_defects_fail_service_readiness(root, path, body, code):
    upstream = Upstream()
    upstream.overrides[path] = (200, body)
    report = await inspect(root, upstream)
    assert report["serviceReady"] is False
    assert code in blocked_codes(report)


async def test_missing_advisory_registration_is_configuration_not_runtime_failure(root):
    upstream = Upstream()
    for path in [
        "/api/admin/applications/super-advisory",
        "/api/admin/applications/super-advisory/deployment",
    ]:
        upstream.overrides[path] = (404, {"error": {"code": "NOT_FOUND"}})
    report = await inspect(root, upstream, mode="upgrade")
    assert report["serviceReady"] is True
    assert report["ready"] is False
    assert "ADVISORY_PRODUCT_NOT_CONFIGURED" in blocked_codes(report)


async def test_browser_does_not_treat_arbitrary_chat_provider_as_supported(root):
    upstream = Upstream()
    upstream.overrides["/api/providers"] = (
        200,
        [
            {
                "name": "deepseek",
                "base_url": "https://other.example.com",
                "api_key": "never-output",
                "enabled": True,
            }
        ],
    )
    report = await inspect(root, upstream)
    assert report["serviceReady"] is True
    assert "BROWSER_MODEL_NOT_CONFIGURED" in blocked_codes(report)
    assert "MODEL_NOT_CONFIGURED" not in blocked_codes(report)
    assert "never-output" not in json.dumps(report)


async def test_product_credentials_never_probe_customer_private_resources(root):
    upstream = Upstream()
    upstream.me["application_id"] = "super-advisory"
    report = await inspect(root, upstream)
    assert blocked_codes(report) == {"WANX_DELIVERY_ADMIN_SCOPE_INVALID"}
    assert not any(path == "/api/brainstorm/profile" for _, path in upstream.calls)


@pytest.mark.parametrize("field,value", [("api_key", ""), ("base_url", ""), ("enabled", False)])
async def test_catalog_alone_is_not_evidence_of_usable_model(root, field, value):
    upstream = Upstream()
    provider = {
        "name": "deepseek",
        "base_url": "https://api.deepseek.com",
        "api_key": "private-api-key",
        "enabled": True,
    }
    provider[field] = value
    upstream.overrides["/api/providers"] = (200, [provider])
    report = await inspect(root, upstream)
    assert report["serviceReady"] is True
    assert report["ready"] is False
    assert "MODEL_NOT_CONFIGURED" in blocked_codes(report)


async def test_stale_active_selection_uses_first_usable_model(root):
    upstream = Upstream()
    upstream.models.insert(0, {"provider_name": "removed", "model": "old"})
    upstream.overrides["/api/providers/active-model"] = (
        200,
        {"provider_name": "removed", "model": "old"},
    )
    report = await inspect(root, upstream)
    assert report["ready"] is True


async def test_probe_timeout_fails_service_without_leaking_errors(root):
    upstream = Upstream()

    def timed_out(request):
        if request.url.path == "/api/browser/env-status":
            raise httpx.ConnectTimeout("private upstream password", request=request)
        return upstream(request)

    report = await delivery.inspect_delivery(
        root, "http://127.0.0.1", transport=httpx.MockTransport(timed_out)
    )
    assert report["serviceReady"] is False
    assert "BROWSER_RUNTIME_MISSING" in blocked_codes(report)
    assert "private" not in json.dumps(report)


async def test_unsafe_credentials_fail_without_leaking_or_probing(root):
    (root / "credential.json").write_text("private invalid credentials")
    upstream = Upstream()
    report = await inspect(root, upstream)
    assert blocked_codes(report) == {"WANX_DELIVERY_ACCESS_UNAVAILABLE"}
    assert "private" not in json.dumps(report)
    assert len(upstream.calls) == 2


@pytest.mark.parametrize(
    "url",
    ["https://example.com", "http://192.168.0.22", "http://localhost", "http://secret@127.0.0.1"],
)
async def test_only_fixed_loopback_origin_is_allowed(root, url):
    upstream = Upstream()
    with pytest.raises(ValueError):
        await delivery.inspect_delivery(root, url, transport=httpx.MockTransport(upstream))
    assert not upstream.calls


def test_cli_failure_is_bounded_json_without_exception_details(root, monkeypatch, capsys):
    async def fail(*args, **kwargs):
        raise RuntimeError("private password and token")

    monkeypatch.setattr(delivery, "inspect_delivery", fail)
    assert (
        delivery.main(["--root", str(root), "--base-url", "http://127.0.0.1", "--mode", "upgrade"])
        == 2
    )
    output = capsys.readouterr()
    assert output.err == ""
    assert "private" not in output.out
    assert json.loads(output.out)["serviceReady"] is False


def test_cli_configuration_pending_does_not_request_ota_rollback(root, monkeypatch, capsys):
    async def pending(*args, **kwargs):
        return {"serviceReady": True, "ready": False}

    monkeypatch.setattr(delivery, "inspect_delivery", pending)
    assert delivery.main(["--root", str(root), "--base-url", "http://127.0.0.1"]) == 0
    assert json.loads(capsys.readouterr().out) == {"serviceReady": True, "ready": False}


async def test_real_native_ontology_missing_agent_probe(real_octop):
    upstream, _server, credentials = real_octop

    class NativeReadOnlyTransport(httpx.AsyncBaseTransport):
        def __init__(self):
            self.native = httpx.ASGITransport(app=upstream._octop_app)
            self.ontology_responses = []

        async def handle_async_request(self, request):
            assert request.method == "GET" or (
                request.method == "POST" and request.url.path == "/api/auth/login"
            )
            response = await self.native.handle_async_request(request)
            await response.aread()
            if request.url.path.startswith("/api/agents/delivery-probe-"):
                self.ontology_responses.append(
                    (response.status_code, response.json().get("error", {}).get("code"))
                )
            return response

    transport = NativeReadOnlyTransport()
    report = await delivery.inspect_delivery(
        credentials.parent,
        "http://127.0.0.1:18088",
        mode="upgrade",
        credentials_file=credentials,
        transport=transport,
    )
    assert transport.ontology_responses == [(404, "AGENT_NOT_FOUND")]
    assert "ONTOLOGY_API_UNAVAILABLE" not in blocked_codes(report)
