"""Provider configuration renewal must never outlive its device/Owner lease."""

import copy
import json
from datetime import UTC, datetime

import httpx
import pytest

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.model_provider_catalog import (
    ModelProviderCatalog,
    ModelProviderConfig,
    public_https,
)


def stamp(seconds):
    return datetime.fromtimestamp(seconds, UTC).isoformat()


def snapshot(now=1800000000):
    return {
        "schemaVersion": 2,
        "deviceId": "box-1",
        "bindingId": "binding-1",
        "ownerAccountId": "owner-1",
        "ownershipEpoch": 1,
        "authVersion": 1,
        "issuedAt": stamp(now),
        "expiresAt": stamp(now + 300),
        "providers": [
            {
                "providerId": "company",
                "displayName": "Company",
                "configVersion": "1",
                "enabled": True,
                "protocol": "openai-compatible",
                "baseUrl": "https://models.example.com/v1",
                "apiKey": "SECRET_PROVIDER_KEY",
                "allowedProducts": ["wanxiang"],
                "allowedModels": [],
            }
        ],
    }


@pytest.fixture
def setup(tmp_path):
    key = tmp_path / "device-key"
    key.write_text("device-key-test-123456789")
    key.chmod(0o600)
    config = ModelProviderConfig("box-1", key, "https://admin.example.com/prod-api")
    state = {"now": 1800000000, "mono": 1000, "value": snapshot(), "requests": []}

    def transport(request):
        state["requests"].append(request)
        if state.get("network"):
            raise httpx.ConnectError("secret request must not leak", request=request)
        ack = request.method == "POST"
        status = state.get("ack_status" if ack else "status", 200)
        if status != 200:
            return httpx.Response(status, text="SECRET_SERVER_ERROR")
        data = copy.deepcopy(state["value"])
        if ack:
            body = json.loads(request.content)
            state["ack"] = body
            data = {"accepted": True, "providers": body["providers"]}
            if state.get("bad_ack"):
                data["providers"] = []
        ident = request.headers["X-Request-Id"]
        envelope = {
            "success": True,
            "msg": "",
            "errorCode": None,
            "data": data,
            "requestId": ident,
            "serverTime": stamp(state["now"]),
        }
        if state.get("bad_envelope"):
            envelope.update(state["bad_envelope"])
        raw = state.get("raw")
        return httpx.Response(
            200,
            headers={"X-Request-Id": "wrong" if state.get("bad_header") else ident},
            content=raw if raw is not None else json.dumps(envelope).encode(),
        )

    catalog = ModelProviderCatalog(
        config,
        transport=httpx.MockTransport(transport),
        clock=lambda: state["now"],
        monotonic=lambda: state["mono"],
    )
    return catalog, state


async def test_full_ack_device_wide_enabled_snapshot_and_no_credential_files(setup):
    catalog, state = setup
    other = copy.deepcopy(state["value"]["providers"][0])
    other.update(providerId="other", allowedProducts=["zhijun"])
    disabled = dict(
        other,
        providerId="disabled",
        enabled=False,
        protocol=None,
        baseUrl=None,
        apiKey=None,
        allowedProducts=[],
        allowedModels=[],
    )
    state["value"]["providers"] += [other, disabled]
    result = await catalog.refresh()
    assert [p["providerId"] for p in result["providers"]] == ["company", "other"]
    assert result["providers"][0]["allowedModels"] == []
    assert len(state["ack"]["providers"]) == 3
    assert state["ack"]["status"] == "loaded"
    assert set(state["ack"]) == {
        "schemaVersion",
        "status",
        "bindingId",
        "ownerAccountId",
        "ownershipEpoch",
        "authVersion",
        "providers",
    }
    assert len(list(catalog.config.key_file.parent.iterdir())) == 1
    assert state["requests"][0].url.path == "/prod-api/api/devices/box-1/model-providers"
    assert state["requests"][0].headers["X-Nexus-Provisioning-Version"] == "2"
    result["providers"][0]["apiKey"] = "changed"
    assert catalog.active()["providers"][0]["apiKey"] == "SECRET_PROVIDER_KEY"
    await catalog.close()
    with pytest.raises(BridgeAuthError):
        catalog.active()


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
async def test_transient_error_keeps_only_unexpired_lease(setup, status):
    catalog, state = setup
    await catalog.refresh()
    state["status"] = status
    with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_TEMPORARILY_UNAVAILABLE"):
        await catalog.refresh()
    assert catalog.active()["providers"]
    state["mono"] += 300
    with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_LEASE_EXPIRED"):
        catalog.active()
    await catalog.close()


async def test_network_error_redacted_and_wall_clock_expiration(setup):
    catalog, state = setup
    await catalog.refresh()
    state["network"] = True
    with pytest.raises(BridgeAuthError) as failure:
        await catalog.refresh()
    assert str(failure.value) == "MODEL_PROVIDER_TEMPORARILY_UNAVAILABLE"
    assert catalog.active()
    state["now"] += 301
    with pytest.raises(BridgeAuthError):
        catalog.active()
    await catalog.close()


@pytest.mark.parametrize("status", [301, 302, 400, 401, 403, 404, 409])
async def test_authority_failure_clears_snapshot_without_body_or_redirect(setup, status):
    catalog, state = setup
    await catalog.refresh()
    state["status"] = status
    with pytest.raises(BridgeAuthError) as failure:
        await catalog.refresh()
    assert str(failure.value) == "MODEL_PROVIDER_ACCESS_DENIED"
    with pytest.raises(BridgeAuthError):
        catalog.active()
    assert len(state["requests"]) == 3
    await catalog.close()


@pytest.mark.parametrize(
    "field,value",
    [
        ("deviceId", "other"),
        ("ownershipEpoch", True),
        ("authVersion", 0),
        ("bindingId", ""),
        ("expiresAt", stamp(1800000301)),
        ("issuedAt", stamp(1800000031)),
        ("schemaVersion", True),
    ],
)
async def test_invalid_binding_or_lease_clears(setup, field, value):
    catalog, state = setup
    await catalog.refresh()
    state["value"][field] = value
    with pytest.raises(BridgeAuthError):
        await catalog.refresh()
    assert catalog.snapshot is None
    await catalog.close()


@pytest.mark.parametrize(
    "mode", ["bad_header", "bad_ack", "duplicate", "oversized", "nan", "bad_envelope"]
)
async def test_protocol_failures_clear_snapshot(setup, mode):
    catalog, state = setup
    await catalog.refresh()
    if mode == "duplicate":
        state["raw"] = b'{"success":true,"success":true}'
    elif mode == "oversized":
        state["raw"] = b" " * (512 * 1024 + 1)
    elif mode == "nan":
        state["raw"] = b'{"value":NaN}'
    elif mode == "bad_envelope":
        state[mode] = {"requestId": "wrong"}
    else:
        state[mode] = True
    with pytest.raises(BridgeAuthError):
        await catalog.refresh()
    assert catalog.snapshot is None
    await catalog.close()


@pytest.mark.parametrize("change", ["rollback", "same_version_key", "missing", "duplicate"])
async def test_provider_monotonicity_survives_clearing(setup, change):
    catalog, state = setup
    state["value"]["providers"][0]["configVersion"] = "2"
    await catalog.refresh()
    catalog.clear()
    if change == "rollback":
        state["value"]["providers"][0]["configVersion"] = "1"
    elif change == "same_version_key":
        state["value"]["providers"][0]["apiKey"] = "NEW_KEY"
    elif change == "missing":
        state["value"]["providers"] = []
    else:
        state["value"]["providers"] *= 2
    with pytest.raises(BridgeAuthError):
        await catalog.refresh()
    assert catalog.snapshot is None
    await catalog.close()


async def test_rotation_owner_change_and_ack_failure_do_not_resurrect_old_credentials(setup):
    catalog, state = setup
    await catalog.refresh()
    state["value"]["providers"][0].update(configVersion="2", apiKey="ROTATED_KEY")
    assert (await catalog.refresh())["providers"][0]["apiKey"] == "ROTATED_KEY"
    state["value"].update(ownershipEpoch=2, bindingId="binding-2", ownerAccountId="owner-2")
    state["ack_status"] = 503
    with pytest.raises(BridgeAuthError):
        await catalog.refresh()
    assert catalog.snapshot is None
    state["ack_status"] = 200
    assert (await catalog.refresh())["ownerAccountId"] == "owner-2"
    state["ack_status"] = 409
    with pytest.raises(BridgeAuthError):
        await catalog.refresh()
    assert catalog.snapshot is None
    state["value"].update(ownershipEpoch=1, bindingId="binding-1", ownerAccountId="owner-1")
    with pytest.raises(BridgeAuthError):
        await catalog.refresh()
    await catalog.close()


async def test_revocation_get_followed_by_ack_outage_clears_old_provider(setup):
    catalog, state = setup
    await catalog.refresh()
    state["value"]["providers"][0].update(
        configVersion="2",
        enabled=False,
        protocol=None,
        baseUrl=None,
        apiKey=None,
        allowedProducts=[],
        allowedModels=[],
    )
    state["ack_status"] = 503
    with pytest.raises(BridgeAuthError):
        await catalog.refresh()
    assert catalog.snapshot is None
    await catalog.close()


@pytest.mark.parametrize(
    "url",
    [
        "http://models.example.com",
        "https://127.0.0.1",
        "https://[::1]",
        "https://host.local/v1",
        "https://user:pass@models.example.com",
        "https://models.example.com:8080",
        "https://models.example.com/v1?token=secret",
        "https://models.example.com/a/../v1",
        "https://models.example.com/%2e",
    ],
)
def test_unsafe_provider_destinations_rejected(url):
    with pytest.raises(BridgeAuthError):
        public_https(url)


def test_config_resource_defaults_explicit_override_and_disabled(monkeypatch, tmp_path):
    for name in ("API_BASE", "DEVICE_ID", "KEY_FILE", "ENABLED", "CHECK_INTERVAL_SECONDS"):
        monkeypatch.delenv("WANX_MODEL_PROVIDERS_" + name, raising=False)
        monkeypatch.delenv("WANX_RESOURCES_" + name, raising=False)
    assert ModelProviderConfig.from_env() is None
    monkeypatch.setenv("WANX_RESOURCES_API_BASE", "https://admin.example.com/prod-api")
    monkeypatch.setenv("WANX_RESOURCES_DEVICE_ID", "box-1")
    monkeypatch.setenv("WANX_RESOURCES_KEY_FILE", str(tmp_path / "key"))
    config = ModelProviderConfig.from_env()
    assert config.device_id == "box-1" and config.interval == 60
    monkeypatch.setenv("WANX_PLATFORM_DEVICE_ID", "centauros-physical")
    monkeypatch.setenv("WANX_MODEL_PROVIDERS_DEVICE_ID", "dc:56:7b:53:7b:bf")
    legacy = ModelProviderConfig.from_env()
    assert legacy.device_id == "dc:56:7b:53:7b:bf"
    assert legacy.identity_device_id == "centauros-physical"
    monkeypatch.setenv("WANX_MODEL_PROVIDERS_IDENTITY_DEVICE_ID", "centauros-explicit")
    assert ModelProviderConfig.from_env().identity_device_id == "centauros-explicit"
    monkeypatch.setenv("WANX_MODEL_PROVIDERS_DEVICE_ID", "box-2")
    assert ModelProviderConfig.from_env().device_id == "box-2"
    monkeypatch.setenv("WANX_MODEL_PROVIDERS_ENABLED", "0")
    assert ModelProviderConfig.from_env() is None
    monkeypatch.setenv("WANX_MODEL_PROVIDERS_ENABLED", "1")
    monkeypatch.setenv("WANX_MODEL_PROVIDERS_API_BASE", "http://localhost")
    with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_LOCAL_CONFIG_INVALID"):
        ModelProviderConfig.from_env()


def use_v3(catalog, state):
    from dataclasses import replace

    catalog.config = replace(catalog.config, protocol_version=3)
    state["value"].update(schemaVersion=3, modelAccessState="ready")
    provider = state["value"]["providers"][0]
    provider.pop("allowedProducts")
    provider.update(
        credentialId="wc_" + "a" * 48,
        credentialGeneration="1",
        credentialExpiresAt=stamp(state["now"] + 300),
        profileRevision="1",
        billingMode="account_balance",
        allowedModels=[],
    )


async def test_v3_ack_follows_application_and_renewal_keeps_config_version(setup):
    catalog, state = setup
    use_v3(catalog, state)
    await catalog.refresh()
    assert len(state["requests"]) == 1 and "ack" not in state
    assert state["requests"][0].headers["X-Nexus-Provisioning-Version"] == "3"
    await catalog.acknowledge_applied()
    assert state["ack"]["status"] == "applied"
    assert state["ack"]["providers"][0]["credentialGeneration"] == "1"
    state["now"] += 60
    state["value"].update(issuedAt=stamp(state["now"]), expiresAt=stamp(state["now"] + 300))
    state["value"]["providers"][0]["credentialExpiresAt"] = stamp(state["now"] + 300)
    await catalog.refresh()
    assert catalog.active()["providers"][0]["configVersion"] == "1"
    await catalog.close()


@pytest.mark.parametrize("change", ["expiry", "key", "admin_model_policy"])
async def test_v3_rejects_unsafe_credentials(setup, change):
    catalog, state = setup
    use_v3(catalog, state)
    await catalog.refresh()
    item = state["value"]["providers"][0]
    if change == "expiry":
        item["credentialExpiresAt"] = stamp(state["now"] + 299)
    elif change == "key":
        item["apiKey"] = "different-key-without-version-change"
    else:
        item["allowedModels"] = ["admin-override"]
    with pytest.raises(BridgeAuthError):
        await catalog.refresh()
    assert catalog.snapshot is None
    await catalog.close()
