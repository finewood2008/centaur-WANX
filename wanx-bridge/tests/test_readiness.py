"""Readiness never creates, grants, migrates or infers provenance from names."""

import copy
from types import SimpleNamespace

import httpx
import pytest

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.readiness import validate_readiness_request
from wanx_bridge.server import create_app
from wanx_bridge.version import bridge_build_metadata


def requirements(*, experts=True):
    return {
        "schemaVersion": 1,
        "applicationId": "centaurai.wanx.zhijun",
        "compatibility": {
            "backendProductId": "wanx",
            "clientRange": ">=0.1.0 <1.0.0",
            "hostProtocolRange": ">=1.0.0 <2.0.0",
            "backendContracts": [
                {
                    "id": "wanx-bridge.readiness",
                    "range": ">=1.0.0 <2.0.0",
                    "features": ["read-only"],
                }
            ],
            "requiredExperts": [
                {
                    "templateId": "zhijun-personal-companion",
                    "versionRange": ">=1.0.0 <2.0.0",
                    "role": "companion",
                    "count": 1,
                    "required": True,
                }
            ]
            if experts
            else [],
            "localDataSchema": {"readRange": ">=1.0.0 <2.0.0", "writeVersion": "1.0.0"},
        },
    }


class Auth:
    config = SimpleNamespace(device_id="box-a")

    def __init__(self):
        self.live = True
        self.session = SimpleNamespace(
            upstream_token="private-token", user={"id": 7, "application_id": "wanx"}
        )

    def authorize(self, marker):
        if marker != "opaque-token":
            raise BridgeAuthError("AUTH_REQUIRED")
        self.assert_live(self.session)
        return self.session

    def assert_live(self, session):
        if not self.live:
            raise BridgeAuthError("LEASE_EXPIRED")


@pytest.fixture
async def environment():
    auth, calls, rows = Auth(), [], []

    async def upstream(request):
        calls.append(request)
        assert request.method == "GET", "Diagnostics must never write to upstream"
        assert request.headers["authorization"] == "Bearer private-token"
        assert "cookie" not in request.headers
        if request.url.path == "/api/auth/me":
            return httpx.Response(
                200, json=auth.session.user, headers={"set-cookie": "unrelated=secret"}
            )
        if request.url.path == "/api/agents":
            return httpx.Response(200, json=rows)
        raise AssertionError(request.url.path)

    app = create_app(
        auth,
        object(),
        http_transport=httpx.MockTransport(upstream),
        build_metadata={
            "version": "0.1.0",
            "buildId": "release-abc",
            "sourceRevision": "commit-abc",
            "source": "running-bridge-package",
        },
    )
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://box",
            headers={"authorization": "Bearer opaque-token"},
        ) as client,
    ):
        yield client, auth, calls, rows


async def test_version_requires_current_session_and_reports_only_own_build(environment):
    client, auth, calls, _ = environment
    response = await client.get("/api/platform/version")
    assert response.status_code == 200
    value = response.json()
    assert value["deviceId"] == "box-a"
    assert value["bridge"]["buildId"] == "release-abc"
    assert value["upstream"] == {
        "status": "unknown",
        "version": None,
        "code": "PUBLIC_VERSION_EVIDENCE_UNAVAILABLE",
    }
    assert value["expertMigration"]["status"] == "blocked"
    assert response.headers["cache-control"] == "no-store"
    assert not calls
    assert (
        await client.get("/api/platform/version", headers={"authorization": "Bearer native-token"})
    ).status_code == 401
    auth.live = False
    assert (await client.get("/api/platform/version")).status_code == 401


async def test_expert_names_and_untrusted_source_fields_never_establish_versions(environment):
    client, _, calls, rows = environment
    rows.extend(
        [
            {
                "agent_id": "mine-renamed",
                "user_id": 7,
                "is_shared": False,
                "name": "知君",
                "version": "1.0.0",
                "template_id": "zhijun-personal-companion",
            },
            {"agent_id": "other-user", "user_id": 8, "is_shared": False},
            {"agent_id": "shared", "user_id": 7, "is_shared": True},
        ]
    )
    before = copy.deepcopy(rows)
    response = await client.post("/api/platform/applications/readiness", json=requirements())
    assert response.status_code == 200
    value = response.json()
    assert value["status"] == "blocked"
    assert value["authorization"]["status"] == "ready"
    assert value["experts"][0]["code"] == "EXPERT_VERSION_UNKNOWN"
    assert value["experts"][0]["instances"] == []
    assert value["experts"][0]["migration"]["code"] == "EXPERT_MIGRATION_UNSUPPORTED"
    assert value["unmanagedInstances"] == [
        {"instanceId": "mine-renamed", "status": "provenance_unknown"}
    ]
    assert rows == before
    assert [call.url.path for call in calls] == ["/api/auth/me", "/api/agents"]
    assert "private-token" not in response.text


async def test_no_instances_reports_preparation_needed_without_bootstrap(environment):
    client, _, calls, _ = environment
    result = (await client.post("/api/platform/applications/readiness", json=requirements())).json()
    assert result["experts"][0]["code"] == "EXPERT_NOT_PREPARED"
    assert all(call.method == "GET" for call in calls)


async def test_readonly_contract_can_be_ready_without_expert_requirements(environment):
    client, _, calls, _ = environment
    result = (
        await client.post("/api/platform/applications/readiness", json=requirements(experts=False))
    ).json()
    assert result["status"] == "ready"
    assert [call.url.path for call in calls] == ["/api/auth/me"]


async def test_parent_scope_does_not_claim_scoped_entitlement_or_reuse_bootstrap(environment):
    client, _, calls, _ = environment
    body = requirements()
    body["applicationId"] = "centaurai.wanx.superadvisors"
    body["compatibility"]["backendProductId"] = "super-advisory"
    result = (await client.post("/api/platform/applications/readiness", json=body)).json()
    assert result["authorization"] == {"status": "unknown", "code": "APP_AUTHORIZATION_UNVERIFIED"}
    assert result["status"] == "blocked"
    assert [call.url.path for call in calls] == ["/api/auth/me"]


async def test_product_mapping_is_controlled_and_not_caller_selected(environment):
    client, _, calls, _ = environment
    body = requirements()
    body["compatibility"]["backendProductId"] = "super-advisory"
    result = (await client.post("/api/platform/applications/readiness", json=body)).json()
    assert result["authorization"]["code"] == "APPLICATION_BACKEND_MAPPING_UNSUPPORTED"
    assert not calls


async def test_unknown_required_fields_fail_before_upstream_access(environment):
    client, _, calls, _ = environment
    for field in ("requiredModels", "newPermission"):
        body = requirements()
        body["compatibility"][field] = []
        response = await client.post("/api/platform/applications/readiness", json=body)
        assert response.status_code == 400
        assert response.json()["code"] == "APPLICATION_CONTRACT_UNSUPPORTED"
    assert not calls


async def test_unknown_backend_contract_is_not_inferred_from_bridge_version(environment):
    client, _, _, _ = environment
    body = requirements(experts=False)
    body["compatibility"]["backendContracts"] = [
        {"id": "brainstorm.api", "range": ">=1.0.0 <2.0.0", "features": []}
    ]
    result = (await client.post("/api/platform/applications/readiness", json=body)).json()
    assert result["status"] == "blocked"
    assert result["checks"] == [
        {"code": "BACKEND_CONTRACT_INCOMPATIBLE", "detail": "brainstorm.api"}
    ]


async def test_authorization_revoked_during_probe_discards_the_result():
    auth = Auth()

    async def upstream(request):
        auth.live = False
        return httpx.Response(200, json={"id": 7, "application_id": "wanx"})

    app = create_app(auth, object(), http_transport=httpx.MockTransport(upstream))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://box") as client,
    ):
        response = await client.post(
            "/api/platform/applications/readiness",
            headers={"authorization": "Bearer opaque-token"},
            json=requirements(experts=False),
        )
        assert response.status_code == 401
        assert response.json()["code"] == "LEASE_EXPIRED"


def test_build_identity_does_not_fall_back_to_catalog_or_git(monkeypatch):
    monkeypatch.delenv("WANX_BRIDGE_BUILD_ID", raising=False)
    monkeypatch.delenv("WANX_BRIDGE_SOURCE_REVISION", raising=False)
    value = bridge_build_metadata()
    assert value["buildId"] is None
    assert value["sourceRevision"] is None


@pytest.mark.parametrize("wanted", ["*", "^1.0.0", "1.0", "01.0.0", ">=1.0.0 || <2.0.0"])
def test_ranges_are_explicit_stable_comparators(wanted):
    body = requirements()
    body["compatibility"]["clientRange"] = wanted
    with pytest.raises(BridgeAuthError):
        validate_readiness_request(body)
