"""Read-only V3 diagnosis consumes current authoritative resource bindings."""

import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.readiness import diagnose_application, validate_readiness_request


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
