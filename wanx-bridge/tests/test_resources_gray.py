"""Account release access cannot be inferred from cached resource bytes."""

import hashlib
import json

import httpx
import pytest
from test_resources import prepare, signed
from test_resources import runtime as runtime
from test_resources import setup as setup

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.resources import ResourceCatalog, atomic
from wanx_bridge.resources_contract import canonical

ACCOUNT_A = "a898cd6c-bca4-42dc-9a35-4165c20b5d21"
ACCOUNT_B = "5439ed5b-ff27-4a2f-b68d-28796ce0afe4"


def account_policy(env, *, controlled=True):
    catalog = env[0].catalog
    original = catalog.resolve
    policy = {"allowed": {ACCOUNT_A}, "offline": False, "accounts": []}

    async def resolve(application, artifact, *, account_id=None):
        policy["accounts"].append(account_id)
        if policy["offline"]:
            raise BridgeAuthError("RESOURCE_SERVICE_UNAVAILABLE", 503)
        if controlled and account_id not in policy["allowed"]:
            raise BridgeAuthError("MARKET_GRAY_ACCESS_DENIED", 403)
        result = await original(application, artifact)
        if controlled:
            result["releaseAccess"] = "account"
        return result

    catalog.resolve = resolve
    return policy


async def test_gray_uses_only_verified_context_subject(runtime):
    runtime[3]["sub"] = ACCOUNT_A
    runtime[2].user["username"] = ACCOUNT_B
    policy = account_policy(runtime)
    result = await prepare(runtime)
    assert result["status"] == "ready" and result["releaseAccess"] == "account"
    assert policy["accounts"] == [ACCOUNT_A]
    # Neither the renderer nor Octop's username can select the rollout account.
    runtime[4]["accountId"] = ACCOUNT_B
    with pytest.raises(BridgeAuthError, match="RESOURCE_CONTRACT_INVALID"):
        await prepare(runtime)
    assert policy["accounts"] == [ACCOUNT_A]


@pytest.mark.parametrize("read_only", [False, True])
async def test_stopping_gray_rejects_existing_ready_binding(runtime, read_only):
    runtime[3]["sub"] = ACCOUNT_A
    policy = account_policy(runtime)
    assert (await prepare(runtime))["status"] == "ready"
    policy["allowed"].clear()
    with pytest.raises(BridgeAuthError, match="MARKET_GRAY_ACCESS_DENIED") as error:
        await prepare(runtime, read_only=read_only)
    assert error.value.status == 403
    assert len(runtime[1].rows) == 1


@pytest.mark.parametrize("read_only", [False, True])
async def test_gray_offline_never_reuses_cached_online_permission(runtime, read_only):
    runtime[3]["sub"] = ACCOUNT_A
    policy = account_policy(runtime)
    first = await prepare(runtime)
    policy["offline"] = True
    with pytest.raises(BridgeAuthError, match="RESOURCE_ONLINE_ACCESS_REQUIRED") as error:
        await prepare(runtime, read_only=read_only)
    assert error.value.status == 503
    assert len(runtime[1].rows) == 1
    assert runtime[1].files[first["bindings"][0]["instanceId"]]["AGENTS.md"] == b"Be helpful"


async def test_gray_account_switch_does_not_reuse_another_account_cache_or_instance(runtime):
    runtime[3]["sub"] = ACCOUNT_A
    policy = account_policy(runtime)
    first = await prepare(runtime)
    runtime[3]["sub"] = ACCOUNT_B
    with pytest.raises(BridgeAuthError, match="MARKET_GRAY_ACCESS_DENIED"):
        await prepare(runtime)
    policy["offline"] = True
    with pytest.raises(BridgeAuthError, match="RESOURCE_SERVICE_UNAVAILABLE"):
        await prepare(runtime)
    policy["offline"] = False
    policy["allowed"].add(ACCOUNT_B)
    second = await prepare(runtime)
    assert second["status"] == "ready"
    assert second["bindings"][0]["instanceId"] != first["bindings"][0]["instanceId"]
    assert len(list((runtime[0].catalog.directory / "resolutions").glob("*.json"))) == 2
    runtime[3]["sub"] = ACCOUNT_A
    assert (await prepare(runtime))["bindings"] == first["bindings"]


async def test_formal_uuid_account_keeps_offline_fallback_without_sharing_cache(runtime):
    runtime[3]["sub"] = ACCOUNT_A
    policy = account_policy(runtime, controlled=False)
    first = await prepare(runtime)
    assert policy["accounts"] == [ACCOUNT_A]
    policy["offline"] = True
    assert (await prepare(runtime))["bindings"] == first["bindings"]
    runtime[3]["sub"] = ACCOUNT_B
    with pytest.raises(BridgeAuthError, match="RESOURCE_SERVICE_UNAVAILABLE"):
        await prepare(runtime)


async def test_legacy_formal_non_uuid_subject_and_old_cache_remain_compatible(runtime):
    policy = account_policy(runtime, controlled=False)
    first = await prepare(runtime)
    assert policy["accounts"] == [None]
    cached = next((runtime[0].catalog.directory / "resolutions").glob("*.json"))
    # Reproduce a cache written by the previous Bridge (app/artifact only).
    old_name = hashlib.sha256(
        canonical([runtime[4]["applicationId"], runtime[4]["artifactId"]])
    ).hexdigest()
    cached.rename(cached.with_name(old_name + ".json"))
    policy["offline"] = True
    assert (await prepare(runtime))["bindings"] == first["bindings"]


async def test_controlled_marker_even_in_legacy_cache_cannot_fallback(runtime):
    policy = account_policy(runtime, controlled=False)
    await prepare(runtime)
    cached = next((runtime[0].catalog.directory / "resolutions").glob("*.json"))
    content = json.loads(cached.read_bytes())
    content["releaseAccess"] = "account"
    old_name = hashlib.sha256(
        canonical([runtime[4]["applicationId"], runtime[4]["artifactId"]])
    ).hexdigest()
    atomic(cached.with_name(old_name + ".json"), canonical(content))
    cached.unlink()
    policy["offline"] = True
    with pytest.raises(BridgeAuthError, match="RESOURCE_ONLINE_ACCESS_REQUIRED"):
        await prepare(runtime)


async def test_non_uuid_subject_cannot_use_controlled_response(runtime):
    policy = account_policy(runtime)
    policy["allowed"].add(None)  # A mistaken Admin reply still cannot bypass the Bridge gate.
    with pytest.raises(BridgeAuthError, match="RESOURCE_ACCOUNT_IDENTITY_INVALID") as error:
        await prepare(runtime)
    assert error.value.status == 403 and not runtime[1].rows


async def test_http_resolve_contract_carries_uuid_and_rejects_stopped_gray(setup):
    private, _, config = setup
    envelope = signed(private)[2]
    stopped = False
    observed = []

    async def handler(request):
        assert request.headers["authorization"] == "CentaurOS-DeviceKey device-secret"
        body = json.loads(request.content)
        observed.append(body)
        if stopped:
            return httpx.Response(
                403,
                json={
                    "code": 403,
                    "success": False,
                    "errorCode": "MARKET_GRAY_ACCESS_DENIED",
                    "msg": "Stopped",
                },
            )
        return httpx.Response(
            200,
            json={
                "code": 200,
                "success": True,
                "data": {
                    "schemaVersion": 1,
                    "applicationId": body["applicationId"],
                    "artifactId": body["artifactId"],
                    "backendProductId": "wanx",
                    "requirements": [
                        {"kind": "expert", "resourceId": "companion", "minVersion": "1.0.0"}
                    ],
                    "resources": [envelope],
                    "releaseAccess": "account",
                },
            },
        )

    catalog = ResourceCatalog(config, transport=httpx.MockTransport(handler))
    value = await catalog.resolve("centaurai.test", "gray-artifact", account_id=ACCOUNT_A)
    assert value["releaseAccess"] == "account"
    assert observed == [
        {"applicationId": "centaurai.test", "artifactId": "gray-artifact", "accountId": ACCOUNT_A}
    ]
    stopped = True
    with pytest.raises(BridgeAuthError, match="MARKET_GRAY_ACCESS_DENIED") as error:
        await catalog.resolve("centaurai.test", "gray-artifact", account_id=ACCOUNT_A)
    assert error.value.status == 403
    await catalog.close()
