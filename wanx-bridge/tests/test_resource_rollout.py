"""Resource gray admission is independent of application gray and cached bytes."""

import base64
import copy
import json
import time

import httpx
import pytest
from test_resources import prepare, signed
from test_resources import runtime as runtime
from test_resources import setup as setup
from test_resources_gray import ACCOUNT_A, ACCOUNT_B

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.resources import ResourceCatalog, atomic
from wanx_bridge.resources_contract import canonical, validate_package, verify_envelope


def controlled(private, **kwargs):
    package, raw, envelope = signed(private, **kwargs)
    envelope["payload"]["releaseAccess"] = "account"
    envelope["signature"]["signatureBase64"] = base64.b64encode(
        private.sign(canonical(envelope["payload"]))
    ).decode()
    return package, raw, envelope


def success(data):
    return httpx.Response(200, json={"code": 200, "success": True, "data": data})


def denied(code="RESOURCE_GRAY_ACCESS_DENIED"):
    return httpx.Response(403, json={"code": 403, "success": False, "errorCode": code})


def test_controlled_signature_is_bound_to_access_marker_but_package_is_unchanged(setup):
    private, trust, _ = setup
    package, raw, envelope = controlled(private)
    assert verify_envelope(envelope, trust)["releaseAccess"] == "account"
    assert validate_package(raw, envelope["payload"]) == package
    assert raw == signed(private)[1]
    changed = copy.deepcopy(envelope)
    del changed["payload"]["releaseAccess"]
    with pytest.raises(BridgeAuthError, match="RESOURCE_SIGNATURE_INVALID"):
        verify_envelope(changed, trust)


@pytest.mark.parametrize("marker", [None, "stable", True, {}, ["account"]])
def test_unknown_controlled_marker_is_rejected_even_if_signed(setup, marker):
    private, trust, _ = setup
    envelope = controlled(private)[2]
    envelope["payload"]["releaseAccess"] = marker
    envelope["signature"]["signatureBase64"] = base64.b64encode(
        private.sign(canonical(envelope["payload"]))
    ).decode()
    with pytest.raises(BridgeAuthError):
        verify_envelope(envelope, trust)


async def test_poll_only_checks_metadata_and_preserves_cache_on_bad_catalog(setup):
    private, _, config = setup
    envelopes = [signed(private)[2], controlled(private, resource_id="other")[2]]
    requests = []

    async def handler(request):
        requests.append(request)
        assert request.method == "GET"
        assert request.url.path.endswith("/catalog")
        assert request.url.params["resourceProtocol"] == "2"
        return success({"schemaVersion": 1, "items": envelopes})

    catalog = ResourceCatalog(config, transport=httpx.MockTransport(handler))
    assert await catalog.synchronize() == {"count": 2, "failures": []}
    assert len(requests) == 1
    assert not (config.state_dir / "packages").exists()
    assert not (config.state_dir / "bindings").exists()
    original = (config.state_dir / "catalog.json").read_bytes()
    envelopes[1]["payload"]["name"] = "corrupt signature"
    with pytest.raises(BridgeAuthError, match="RESOURCE_SIGNATURE_INVALID"):
        await catalog.synchronize()
    assert (config.state_dir / "catalog.json").read_bytes() == original
    await catalog.close()


async def test_controlled_shared_cache_rechecks_each_account_and_current_gray_state(setup):
    private, _, config = setup
    package, raw, envelope = controlled(private)
    allowed = {ACCOUNT_A}
    requests = []
    offline = False

    async def handler(request):
        requests.append(request)
        if request.url.host == "artifacts.example":
            assert "authorization" not in request.headers
            return httpx.Response(200, content=raw)
        assert request.headers["authorization"] == "CentaurOS-DeviceKey device-secret"
        body = json.loads(request.content)
        assert body["resourceProtocol"] == 2
        if offline:
            return httpx.Response(503)
        if body.get("accountId") not in allowed:
            return denied()
        return success(
            {
                "envelope": envelope,
                "url": "https://artifacts.example/p",
                "expiresAt": int(time.time()) + 300,
            }
        )

    catalog = ResourceCatalog(config, transport=httpx.MockTransport(handler))
    assert await catalog.package(envelope, account_id=ACCOUNT_A) == package
    assert len(requests) == 2
    assert await catalog.package(envelope, account_id=ACCOUNT_A) == package
    assert len(requests) == 3  # Authoritative admission call despite cache hit.
    with pytest.raises(BridgeAuthError, match="RESOURCE_GRAY_ACCESS_DENIED"):
        await catalog.package(envelope, account_id=ACCOUNT_B)
    allowed.clear()
    with pytest.raises(BridgeAuthError, match="RESOURCE_GRAY_ACCESS_DENIED"):
        await catalog.package(envelope, account_id=ACCOUNT_A)
    offline = True
    with pytest.raises(BridgeAuthError, match="RESOURCE_ONLINE_ACCESS_REQUIRED"):
        await catalog.package(envelope, account_id=ACCOUNT_A)
    assert len([r for r in requests if r.url.host == "artifacts.example"]) == 1
    assert (
        config.state_dir / "packages" / (envelope["payload"]["package"]["sha256"] + ".json")
    ).read_bytes() == raw
    await catalog.close()


@pytest.mark.parametrize("account_id", [None, "consumer-1", ACCOUNT_A.upper()])
async def test_controlled_download_requires_verified_canonical_account_even_when_cached(
    setup, account_id
):
    private, _, config = setup
    _, raw, envelope = controlled(private)

    async def handler(request):
        raise AssertionError("No request may invent an account")

    catalog = ResourceCatalog(config, transport=httpx.MockTransport(handler))
    atomic(
        config.state_dir / "packages" / (envelope["payload"]["package"]["sha256"] + ".json"), raw
    )
    with pytest.raises(BridgeAuthError, match="RESOURCE_ACCOUNT_IDENTITY_INVALID"):
        await catalog.package(envelope, account_id=account_id)
    await catalog.close()


def resource_policy(env):
    """Model Admin choosing an eligible gray resource for a legacy stable app."""
    original = env[0].catalog
    stable = signed(original.private)
    gray = controlled(original.private, version="2.0.0")
    policy = {"allowed": {ACCOUNT_A}, "channel": "gray", "offline": False, "requests": []}

    async def handler(request):
        policy["requests"].append(request)
        if request.url.host == "artifacts.example":
            return httpx.Response(
                200, content=gray[1] if request.url.path == "/2.0.0" else stable[1]
            )
        body = json.loads(request.content)
        assert body["resourceProtocol"] == 2
        if policy["offline"]:
            return httpx.Response(503)
        eligible = policy["channel"] == "published" or (
            policy["channel"] == "gray" and body.get("accountId") in policy["allowed"]
        )
        if request.url.path.endswith("/resolve"):
            selected = gray[2] if eligible else stable[2]
            result = {
                "schemaVersion": 1,
                "applicationId": body["applicationId"],
                "artifactId": body["artifactId"],
                "backendProductId": "wanx",
                "requirements": [
                    {"kind": "expert", "resourceId": "companion", "minVersion": "1.0.0"}
                ],
                "resources": [selected],
            }
            if eligible:
                result["releaseAccess"] = "account"
            return success(result)
        if request.url.path.endswith("/access"):
            if not eligible and policy["channel"] != "withdrawn":
                return denied()
            return success(
                {
                    "envelope": gray[2],
                    "channel": "gray" if policy["channel"] == "gray" else "stable",
                }
            )
        assert request.url.path.endswith("/download")
        selected = gray[2] if body["version"] == "2.0.0" else stable[2]
        if body["version"] == "2.0.0" and not eligible:
            return denied()
        return success(
            {
                "envelope": selected,
                "url": "https://artifacts.example/" + body["version"],
                "expiresAt": int(time.time()) + 300,
            }
        )

    env[0].catalog = ResourceCatalog(original.config, transport=httpx.MockTransport(handler))
    env[3]["sub"] = ACCOUNT_A
    return policy, gray[2]


@pytest.mark.parametrize("read_only", [False, True])
async def test_stopped_resource_gray_cannot_reuse_higher_binding_against_stable_selection(
    runtime, read_only
):
    policy, _ = resource_policy(runtime)
    first = await prepare(runtime)
    assert first["status"] == "ready" and first["resources"][0]["version"] == "2.0.0"
    instance_id = first["bindings"][0]["instanceId"]
    runtime[1].files[instance_id]["customer-notes.md"] = b"Keep my data"
    before = copy.deepcopy(runtime[1].files)
    policy["channel"] = "stopped"
    second = await prepare(runtime, read_only=read_only)
    assert second["status"] == "blocked" and second["code"] == "RESOURCE_GRAY_ACCESS_DENIED"
    assert runtime[1].files == before and len(runtime[1].rows) == 1
    await runtime[0].catalog.close()


async def test_resource_gray_accounts_get_distinct_bindings_and_no_implicit_expert_overwrite(
    runtime,
):
    policy, _ = resource_policy(runtime)
    gray = await prepare(runtime)
    runtime[3]["sub"] = ACCOUNT_B
    stable = await prepare(runtime)
    assert stable["resources"][0]["version"] == "1.0.0"
    assert stable["bindings"][0]["instanceId"] != gray["bindings"][0]["instanceId"]
    policy["allowed"].add(ACCOUNT_B)
    unchanged = await prepare(runtime)
    assert unchanged["bindings"] == stable["bindings"]
    assert unchanged["updateAvailable"][0]["latestVersion"] == "2.0.0"
    assert len(runtime[1].rows) == 2
    await runtime[0].catalog.close()


async def test_resource_gray_promotion_retains_same_instance_and_requires_live_admission(runtime):
    policy, envelope = resource_policy(runtime)
    before = canonical(envelope)
    first = await prepare(runtime)
    policy["channel"] = "published"
    assert (await prepare(runtime))["bindings"] == first["bindings"]
    assert canonical(envelope) == before
    policy["channel"] = "withdrawn"
    # Withdrawal stops acquisition, not an existing promoted instance's use.
    assert (await prepare(runtime))["bindings"] == first["bindings"]
    with pytest.raises(BridgeAuthError, match="RESOURCE_GRAY_ACCESS_DENIED"):
        await runtime[0].catalog.package(envelope, account_id=ACCOUNT_A)
    policy["offline"] = True
    blocked = await prepare(runtime)
    assert blocked["status"] == "blocked" and blocked["code"] == "RESOURCE_ONLINE_ACCESS_REQUIRED"
    assert len(runtime[1].rows) == 1
    await runtime[0].catalog.close()


async def test_failed_controlled_prepare_resumes_single_instance_with_fresh_cache_admission(
    runtime,
):
    policy, _ = resource_policy(runtime)
    runtime[1].fail_upload = True
    first = await prepare(runtime)
    assert first["status"] == "blocked" and len(runtime[1].rows) == 1
    downloads = len([r for r in policy["requests"] if r.url.path.endswith("/download")])
    second = await prepare(runtime)
    assert second["status"] == "ready" and len(runtime[1].rows) == 1
    assert len([r for r in policy["requests"] if r.url.path.endswith("/download")]) > downloads
    assert len([r for r in policy["requests"] if r.url.host == "artifacts.example"]) == 1
    await runtime[0].catalog.close()


async def test_signed_controlled_marker_cannot_be_removed_from_offline_resolution(runtime):
    policy, _ = resource_policy(runtime)
    await prepare(runtime)
    cached = next((runtime[0].catalog.directory / "resolutions").glob("*.json"))
    value = json.loads(cached.read_bytes())
    value.pop("releaseAccess")
    atomic(cached, canonical(value))
    policy["offline"] = True
    with pytest.raises(BridgeAuthError, match="RESOURCE_ONLINE_ACCESS_REQUIRED"):
        await prepare(runtime)
    await runtime[0].catalog.close()
