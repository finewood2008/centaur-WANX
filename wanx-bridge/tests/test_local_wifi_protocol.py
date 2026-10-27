"""Bounded proof wire domains and management/data authorization separation."""

import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from test_local_wifi_authority import intent
from test_local_wifi_authority import ledger as _ledger
from test_local_wifi_authority import provisioned as _provisioned

from wanx_bridge import local_ledger_protocol as ledger_protocol
from wanx_bridge import local_management_protocol as wire
from wanx_bridge import local_trust_protocol as evidence
from wanx_bridge import local_wifi_protocol as protocol
from wanx_bridge.local_resource_catalog import resolve_resource, validate_resource_grants


@pytest.fixture
def provisioned(tmp_path):
    return _provisioned.__wrapped__(tmp_path)


@pytest.fixture
def ledger(provisioned):
    yield from _ledger.__wrapped__(provisioned)


@pytest.mark.parametrize(
    "change",
    [
        {"schemaVersion": True},
        {"schemaVersion": 2},
        {"purpose": "cloud.owner"},
        {"ownershipEpoch": True},
        {"ownershipEpoch": 0},
        {"extra": "ignored?"},
        {"nonce": "not-a-digest"},
        {"boxId": "box:中文"},
    ],
)
def test_intent_rejects_noncanonical_or_unknown_claims(ledger, change):
    value = protocol.decode("intent", intent(ledger)["intentProof"])
    value.update(change)
    with pytest.raises(evidence.BindingProtocolError):
        protocol.sign("intent", value, ledger.root.access)


@pytest.mark.parametrize("counter", ["0", "01", "-1", "1.0", 1, True, "18446744073709551616"])
def test_counter_is_positive_canonical_uint64_string(counter):
    with pytest.raises(evidence.BindingProtocolError):
        protocol.observed(
            {"requestId": "request:test", "counter": counter, "ciphertextSha256": "a" * 64}
        )


@pytest.mark.parametrize("digest", ["a" * 63, "A" * 64, "g" * 64, "a" * 65, None])
def test_raw_cipher_digest_is_exact_lowercase_hex(digest):
    with pytest.raises(evidence.BindingProtocolError):
        protocol.hex_digest(digest)


def test_proof_cannot_cross_type_or_key_and_object_digest_ignores_signature_encoding(ledger):
    signed = intent(ledger)["intentProof"]
    value = protocol.decode("intent", signed)
    resigned = protocol.sign("intent", value, ledger.root.access)
    assert protocol.digest(protocol.decode("intent", resigned)) == protocol.digest(value)
    with pytest.raises(evidence.BindingProtocolError):
        protocol.verify("apply", signed, wire.public_jwk(ledger.root.access))
    with pytest.raises(evidence.BindingProtocolError):
        protocol.verify("intent", signed, wire.public_jwk(ec.generate_private_key(ec.SECP256R1())))
    with pytest.raises(evidence.BindingProtocolError):
        protocol.decode("intent", signed + "=" * 2048)


def test_network_grant_is_shared_management_only_not_arbitrary_data_action():
    first = resolve_resource("principal:a", "network:wifi")
    second = resolve_resource("principal:b", "network:wifi")
    assert first["scope"] == "shared" and first["namespaceId"] == second["namespaceId"]
    validate_resource_grants([{"resourceId": "network:wifi", "actions": ["write"]}])
    for actions in (["read"], ["read", "write"]):
        with pytest.raises(evidence.BindingProtocolError):
            validate_resource_grants([{"resourceId": "network:wifi", "actions": actions}])


def test_network_grant_cannot_open_data_application_or_native_business_route():
    from test_local_data_routes import context, observed

    from wanx_bridge.local_data_protocol import DataProtocolError
    from wanx_bridge.local_data_routes import application_policy, route_policy

    view = context("network:wifi", ["write"])
    with pytest.raises(DataProtocolError):
        application_policy("wanx-host", "launch:test", view)
    for path in ("/api/personal-space/uploads", "/api/agents", "/api/clipboard/v1/note"):
        with pytest.raises(DataProtocolError):
            route_policy(view, observed(path, "POST"))
    view["grants"].append({"resourceId": "space:personal", "actions": ["read"]})
    assert application_policy("wanx-host", "launch:test", view) == [
        {"resourceId": "space:personal", "actions": ["read"]}
    ]


def test_network_permissions_cannot_be_requested_as_backup_resources():
    create = {
        "scopeProfile": "profile:test",
        "resourceIds": ["space:personal"],
        "targetId": "target:test",
        "expectedRecoveryVersion": 1,
        "recipientKeyThumbprint": evidence._encode(b"a" * 32),
        "includeBusinessSecrets": False,
    }
    ledger_protocol.validate_args("backup.create", create)
    create["resourceIds"] = ["network:wifi"]
    with pytest.raises(evidence.BindingProtocolError):
        ledger_protocol.validate_args("backup.create", create)
    restore = {
        name: evidence._encode(b"a" * 32)
        for name in (
            "backupId",
            "archiveSha256",
            "sourceBoxKeyThumbprint",
            "manifestSha256",
            "targetDescriptorDigest",
        )
    }
    restore.update(
        scopeProfile="profile:test",
        sourceId="source:test",
        resourceIds=["space:personal"],
        ownerMapping=[
            {
                "sourcePrincipalId": "principal:a",
                "targetPrincipalId": "principal:b",
                "resourceIds": ["space:personal"],
            }
        ],
    )
    ledger_protocol.validate_args("backup.restore", restore)
    restore["resourceIds"] = ["network:wifi"]
    with pytest.raises(evidence.BindingProtocolError):
        ledger_protocol.validate_args("backup.restore", restore)
    from wanx_bridge.local_data_routes import RESOURCES

    assert "network:wifi" not in RESOURCES
