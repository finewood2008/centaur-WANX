"""Read-only V3 diagnosis consumes current authoritative resource bindings."""

import asyncio
import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.readiness import diagnose_application, validate_readiness_request
from wanx_bridge.server import create_app


def request():
    return {
        "schemaVersion": 1,
        "applicationId": "example.application",
        "artifactId": "26a3080f-f7e1-4b38-bebe-6a96f4ef852a",
        "compatibility": {
            "backendProductId": "wanx",
            "clientRange": ">=0.1.0",
            "hostProtocolRange": ">=1.0.0",
            "backendContracts": [],
            "resourceDependencies": [{"kind": "expert", "resourceId": "0", "minVersion": "1.0.0"}],
            "localDataSchema": {"readRange": ">=1.0.0", "writeVersion": "1.0.0"},
        },
    }


async def test_uses_authoritative_resource_binding_for_new_application_without_name_mapping():
    body = request()
    report = {
        "applicationId": body["applicationId"],
        "artifactId": body["artifactId"],
        "backendProductId": "wanx",
        "status": "ready",
        "authorization": {"status": "ready"},
        "resources": [{"kind": "expert", "resourceId": "0", "version": "1.2.0", "status": "ready"}],
        "bindings": [
            {
                "kind": "expert",
                "resourceId": "0",
                "version": "1.2.0",
                "instanceId": "private-instance",
            }
        ],
    }
    inspect = AsyncMock(return_value=report)
    get = AsyncMock(return_value=httpx.Response(200, json={"id": 7, "application_id": "wanx"}))
    result = await diagnose_application(
        body, SimpleNamespace(user={"id": 7}), {"contracts": []}, get, inspect_resources=inspect
    )
    assert result["status"] == "ready"
    assert result["readOnly"] is True
    assert result["productId"] == "wanx"
    assert result["bindings"] == report["bindings"]
    inspect.assert_awaited_once_with(
        {key: body[key] for key in ("schemaVersion", "applicationId", "artifactId")}
    )
    get.assert_awaited_once_with("/api/auth/me")


async def test_stale_preparation_cannot_hide_current_resource_failure_or_scope_change():
    body = request()
    report = {
        "applicationId": body["applicationId"],
        "artifactId": body["artifactId"],
        "backendProductId": "wanx",
        "status": "blocked",
        "code": "RESOURCE_USER_MODIFIED",
        "authorization": {"status": "ready"},
        "resources": [],
        "bindings": [],
    }
    get = AsyncMock(return_value=httpx.Response(200, json={"id": 7, "application_id": "wanx"}))
    inspect = AsyncMock(return_value=report)
    result = await diagnose_application(
        body, {"user": {"id": 7}}, {"contracts": []}, get, inspect_resources=inspect
    )
    assert result["status"] == "blocked"
    assert result["checks"] == [{"code": "RESOURCE_USER_MODIFIED"}]
    report["backendProductId"] = "other-product"
    with pytest.raises(BridgeAuthError, match="RESOURCE_APPLICATION_SCOPE_INVALID"):
        await diagnose_application(
            body, {"user": {"id": 7}}, {"contracts": []}, get, inspect_resources=inspect
        )


async def test_unconfigured_resource_extension_does_not_claim_ready():
    get = AsyncMock(return_value=httpx.Response(200, json={"id": 7, "application_id": "wanx"}))
    result = await diagnose_application(request(), {"user": {"id": 7}}, {"contracts": []}, get)
    assert result["status"] == "blocked"
    assert result["checks"] == [{"code": "RESOURCE_CENTER_UNAVAILABLE"}]


@pytest.mark.parametrize(
    "change",
    [
        {"optional": True},
        {"minVersion": "1.0.0-beta"},
        {"minVersion": "2147483648.0.0"},
        {"resourceId": "../x"},
    ],
)
def test_rejects_ambiguous_resource_contracts(change):
    body = copy.deepcopy(request())
    body["compatibility"]["resourceDependencies"][0].update(change)
    with pytest.raises(BridgeAuthError):
        validate_readiness_request(body)


def candidate_request():
    return {**request(), "schemaVersion": 2, "bindingSetId": "a" * 64}


async def test_candidate_readiness_keeps_runtime_contract_checks_and_binding_scope():
    body = candidate_request()
    body["compatibility"]["backendContracts"] = [
        {"id": "wanx.new-contract", "range": ">=2.0.0", "features": []}
    ]
    report = {
        "schemaVersion": 2,
        "applicationId": body["applicationId"],
        "artifactId": body["artifactId"],
        "bindingSetId": body["bindingSetId"],
        "operationId": "install-1",
        "bindingScope": {
            "accountId": "a",
            "deviceId": "box-a",
            "ownershipEpoch": 1,
            "artifactId": body["artifactId"],
        },
        "backendProductId": "wanx",
        "status": "ready",
        "authorization": {"status": "ready"},
        "resources": [],
        "bindings": [],
    }
    inspect = AsyncMock(return_value=report)
    get = AsyncMock(return_value=httpx.Response(200, json={"id": 7, "application_id": "wanx"}))
    result = await diagnose_application(
        body, {"user": {"id": 7}}, {"contracts": []}, get, inspect_resources=inspect
    )
    assert result["status"] == "blocked"
    assert result["checks"][0]["code"] == "BACKEND_CONTRACT_INCOMPATIBLE"
    assert result["schemaVersion"] == 2 and result["bindingScope"] == report["bindingScope"]
    inspect.assert_awaited_once_with(
        {key: body[key] for key in ("schemaVersion", "applicationId", "artifactId", "bindingSetId")}
    )
    report["bindingSetId"] = "b" * 64
    with pytest.raises(BridgeAuthError, match="RESOURCE_APPLICATION_SCOPE_INVALID"):
        await diagnose_application(
            body, {"user": {"id": 7}}, {"contracts": []}, get, inspect_resources=inspect
        )


@pytest.mark.parametrize(
    "change",
    [
        {"bindingSetId": "../x"},
        {"bindingSetId": "A" * 64},
        {"schemaVersion": True},
        {"schemaVersion": 1},
    ],
)
def test_candidate_readiness_rejects_malformed_or_legacy_binding_reference(change):
    with pytest.raises(BridgeAuthError):
        validate_readiness_request({**candidate_request(), **change})


async def test_candidate_http_routes_use_scoped_runtime_and_readiness_cannot_write():
    calls = []
    session = SimpleNamespace(
        user={"id": 7, "application_id": "wanx"}, upstream_token="native-private"
    )

    class Auth:
        config = SimpleNamespace(device_id="box-a")

        def authorize(self, marker):
            return session

        def assert_live(self, value):
            return None

        def resource_context(self, value):
            return {"sub": "a", "device_id": "box-a", "ownership_epoch": 1}

    class Resources:
        catalog = SimpleNamespace(poll=lambda: asyncio.Event().wait())
        close = AsyncMock()

        async def prepare_candidate(self, body, received, context, upstream, live):
            assert received is session and context["sub"] == "a"
            calls.append("prepare_candidate")
            return {"schemaVersion": 2, "status": "blocked"}

        async def inspect_candidate(self, body, received, context, upstream, live):
            calls.append("inspect_candidate")
            await upstream("POST", "/api/agents", json={})
            pytest.fail("readiness must refuse writes")

    async def upstream(req):
        assert req.method == "GET" and req.url.path == "/api/auth/me"
        return httpx.Response(200, json=session.user)

    app = create_app(
        Auth(), object(), resources=Resources(), http_transport=httpx.MockTransport(upstream)
    )
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://box",
            headers={"authorization": "Bearer opaque"},
        ) as client,
    ):
        prepared = await client.post(
            "/api/platform/applications/candidates/prepare", json={"schemaVersion": 2}
        )
        assert prepared.status_code == 200 and prepared.headers["cache-control"] == "no-store"
        for route in (
            "/api/platform/applications/candidates/inspect",
            "/api/platform/applications/readiness",
        ):
            inspected = await client.post(route, json=candidate_request())
            assert inspected.status_code == 500
            assert inspected.json()["code"] == "RESOURCE_READ_ONLY_VIOLATION"
    assert calls == ["prepare_candidate", "inspect_candidate", "inspect_candidate"]
