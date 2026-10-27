import json
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from test_local_trust_runtime import configured as configured
from test_local_trust_runtime import write_private

from wanx_bridge.local_data_install import provision_gateway
from wanx_bridge.local_data_protocol import public_jwk, public_key_thumbprint
from wanx_bridge.local_trust_config import LocalTrustConfig, LocalTrustError
from wanx_bridge.local_trust_runtime import runtime_lock


@pytest.mark.parametrize("first", ["_", "-"])
def test_random_gateway_id_satisfies_downstream_protocol(configured, monkeypatch, first):
    from wanx_bridge import local_data_install
    from wanx_bridge.local_data_protocol import token

    random_value = first + "a" * 42
    monkeypatch.setattr(
        local_data_install, "secrets", SimpleNamespace(token_urlsafe=lambda size: random_value)
    )
    descriptor = provision_gateway(configured.directory)
    token(descriptor["gatewayId"])
    assert descriptor["gatewayId"].endswith(random_value)
    assert json.loads((configured.directory / "gateway-descriptor.json").read_text()) == descriptor


def test_gateway_key_is_distinct_create_only_and_private(configured):
    descriptor = provision_gateway(configured.directory)
    keyfile = configured.directory / "gateway-signing-key.pem"
    original = keyfile.read_bytes()
    key = serialization.load_pem_private_key(original, password=None)
    assert public_jwk(key) == descriptor["gatewayKey"]
    assert descriptor["gatewayKey"] != configured.bundle["boxKey"]
    assert keyfile.stat().st_mode & 0o777 == 0o600
    with pytest.raises(LocalTrustError, match="ALREADY_PROVISIONED"):
        provision_gateway(configured.directory)
    assert keyfile.read_bytes() == original


def test_partial_gateway_state_or_running_runtime_never_reinitialized(configured):
    with runtime_lock(configured.directory):
        with pytest.raises(LocalTrustError, match="ALREADY_RUNNING"):
            provision_gateway(configured.directory)
    marker = configured.directory / "gateway-descriptor.json"
    write_private(marker, b"partial")
    with pytest.raises(LocalTrustError, match="ALREADY_PROVISIONED"):
        provision_gateway(configured.directory)
    assert marker.read_bytes() == b"partial"
    assert not (configured.directory / "gateway-signing-key.pem").exists()


def test_missing_ledger_is_not_recreated(configured):
    (configured.directory / "local-authority.sqlite3").unlink()
    with pytest.raises(OSError):
        provision_gateway(configured.directory)
    assert not (configured.directory / "local-authority.sqlite3").exists()
    assert not (configured.directory / "gateway-signing-key.pem").exists()


def test_authority_required_floor_forbids_management_only(configured):
    floor = {
        "schemaVersion": 2,
        "boxId": configured.bundle["boxId"],
        "boxKeyThumbprint": public_key_thumbprint(configured.bundle["boxKey"]),
        "policy": "local-trust-required",
    }
    write_private(configured.directory / "local-trust-required.json", json.dumps(floor).encode())
    with pytest.raises(LocalTrustError, match="LOCAL_DATA_REQUIRED"):
        LocalTrustConfig.load(configured.filename)
    configured.config["dataConfig"] = str(configured.directory / "data.json")
    write_private(configured.filename, json.dumps(configured.config).encode())
    assert (
        LocalTrustConfig.load(configured.filename).data_config == configured.directory / "data.json"
    )


async def test_required_policy_blocks_old_bridge_before_oidc_or_cloud(monkeypatch):
    import centuarai_local_data_gate

    from wanx_bridge.__main__ import RuntimeFailure, run
    from wanx_bridge.config import BridgeAuthError
    from wanx_bridge.server import create_app

    monkeypatch.setattr(centuarai_local_data_gate, "load_required_policy", lambda: {"boxId": "box"})
    with pytest.raises(RuntimeFailure, match="LOCAL_DATA_REQUIRED"):
        await run()
    with pytest.raises(BridgeAuthError, match="LOCAL_DATA_REQUIRED"):
        create_app(None, None)
