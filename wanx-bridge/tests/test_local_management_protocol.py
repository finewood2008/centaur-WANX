import copy
import json
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from wanx_bridge import local_management_protocol as protocol
from wanx_bridge import local_trust_protocol as evidence
from wanx_bridge.local_trust_protocol import BindingProtocolError


@pytest.fixture
def root():
    vector = json.loads(
        (Path(__file__).resolve().parents[2] / "contracts/local-trust/v1/vectors.json").read_text()
    )
    access, approval = (ec.generate_private_key(ec.SECP256R1()) for _ in range(2))
    value = {key: item for key, item in vector["request"].items() if key in protocol._ROOT_FIELDS}
    value.update(
        purpose="centuarai.local-management.first-root",
        provisioningId=evidence._encode(bytes(32)),
        accessKey=protocol.public_jwk(access),
        approvalKey=protocol.public_jwk(approval),
        grantExpiresAt=None,
        keyProtection="software-passphrase-v1",
    )
    return value, access, approval


def proofs(root):
    value, access, approval = root
    return (
        protocol.sign_first_root(value, access, purpose="access"),
        protocol.sign_first_root(value, approval, purpose="approval"),
        protocol.sign_first_root_secret(value, bytes(32)),
    )


def test_root_proofs_cover_one_payload_with_independent_keys(root):
    value, _, _ = root
    result = protocol.verify_first_root_proofs(*proofs(root), bytes(32))
    assert result == value
    assert protocol.first_root_digest(value) == protocol.digest(value)
    assert protocol.canonical_first_root(value) == protocol.canonical(value)


@pytest.mark.parametrize(
    "field,value",
    [
        ("schemaVersion", True),
        ("purpose", "centuarai.local-device-binding.request"),
        ("approvalKey", None),
        ("grantExpiresAt", 1792890000),
        ("keyProtection", "hardware"),
        ("ownershipEpoch", 1.0),
        ("ownershipEpoch", 0),
        ("clientId", "用户"),
        ("provisioningId", "short"),
        ("requestId", ""),
        ("grants", []),
    ],
)
def test_root_schema_rejects_ambiguous_or_escalated_payloads(root, field, value):
    payload = copy.deepcopy(root[0])
    payload[field] = value
    with pytest.raises(BindingProtocolError):
        protocol.canonical_first_root(payload)


def test_root_requires_both_keys_and_identical_payload(root):
    value, access, approval = root
    access_proof, approval_proof, secret_proof = proofs(root)
    with pytest.raises(BindingProtocolError, match="SIGNATURE_INVALID"):
        protocol.verify_first_root_proofs(access_proof, approval_proof, secret_proof, b"1" * 32)
    changed = {**value, "clientId": "client:changed"}
    with pytest.raises(BindingProtocolError, match="CONTEXT_MISMATCH"):
        protocol.verify_first_root_proofs(
            access_proof,
            protocol.sign_first_root(changed, approval, purpose="approval"),
            secret_proof,
        )
    with pytest.raises(BindingProtocolError):
        protocol.sign_first_root(value, approval, purpose="access")
    value["approvalKey"] = value["accessKey"]
    with pytest.raises(BindingProtocolError):
        protocol.sign_first_root(value, access, purpose="access")


def test_consumed_secret_replay_still_requires_both_client_proofs(root):
    value, access, _ = root
    a, _, s = proofs(root)
    bad = jwt.api_jws.encode(
        protocol.canonical(value),
        access,
        algorithm="ES256",
        headers={"typ": protocol.ROOT_APPROVAL},
    )
    with pytest.raises(BindingProtocolError, match="SIGNATURE_INVALID"):
        protocol.verify_first_root_proofs(a, bad, s)
    assert protocol.verify_first_root_proofs(*proofs(root)) == value


@pytest.mark.parametrize(
    "change", ["extra_header", "wrong_alg", "padding", "whitespace", "duplicate"]
)
def test_authentic_but_noncanonical_root_envelopes_are_rejected(root, change):
    value, access, _ = root
    a, p, s = proofs(root)
    if change in ("extra_header", "wrong_alg"):
        headers = {"typ": protocol.ROOT_ACCESS, "kid": "untrusted"}
        a = jwt.api_jws.encode(
            protocol.canonical(value), access, algorithm="ES256", headers=headers
        )
        if change == "wrong_alg":
            a = protocol.sign_first_root_secret(value, bytes(32))
    elif change == "padding":
        parts = a.split(".")
        parts[2] += "="
        a = ".".join(parts)
    else:
        raw = protocol.canonical(value)
        raw = b" " + raw if change == "whitespace" else raw[:-1] + b',"schemaVersion":1}'
        a = jwt.api_jws.encode(
            raw, access, algorithm="ES256", headers={"typ": protocol.ROOT_ACCESS}
        )
    with pytest.raises(BindingProtocolError):
        protocol.verify_first_root_proofs(a, p, s, bytes(32))


def read_payload(root):
    value = root[0]
    return {
        "schemaVersion": 1,
        "purpose": "centuarai.local-management.read",
        "boxId": value["boxId"],
        "boxKeyThumbprint": value["boxKeyThumbprint"],
        "ownershipEpoch": value["ownershipEpoch"],
        "nonce": value["challenge"],
        "issuedAt": value["issuedAt"],
        "expiresAt": value["issuedAt"] + 60,
        "clientId": value["clientId"],
        "operation": "state",
        "requestId": None,
    }


def test_read_proof_has_separate_purpose_and_verifies_key(root):
    payload = read_payload(root)
    proof = protocol.sign_read_proof(payload, root[1])
    assert protocol.verify_read_proof(proof, root[0]["accessKey"]) == payload
    with pytest.raises(BindingProtocolError, match="SIGNATURE_INVALID"):
        protocol.verify_read_proof(proof, root[0]["approvalKey"])
    with pytest.raises(BindingProtocolError):
        protocol.decode_read_proof(proofs(root)[0])


@pytest.mark.parametrize(
    "field,value",
    [
        ("requestId", "bad"),
        ("operation", "approve"),
        ("nonce", None),
        ("purpose", "state"),
        ("ownershipEpoch", False),
        ("expiresAt", 9007199254740992),
    ],
)
def test_read_schema_rejects_invalid_inputs(root, field, value):
    payload = read_payload(root)
    payload[field] = value
    with pytest.raises(BindingProtocolError):
        protocol.sign_read_proof(payload, root[1])


def test_read_request_requires_id_and_sixty_second_window(root):
    payload = read_payload(root)
    payload["operation"] = "request"
    with pytest.raises(BindingProtocolError):
        protocol.sign_read_proof(payload, root[1])
    payload["requestId"] = root[0]["requestId"]
    protocol.sign_read_proof(payload, root[1])
    payload["expiresAt"] += 1
    with pytest.raises(BindingProtocolError):
        protocol.sign_read_proof(payload, root[1])


def test_box_response_is_bound_to_key_kind_and_box(root):
    value, key, _ = root
    body = {
        "nonce": value["challenge"],
        "issuedAt": value["issuedAt"],
        "expiresAt": value["issuedAt"] + 60,
        "ownershipEpoch": value["ownershipEpoch"],
    }
    proof = protocol.sign_response(value["boxId"], key, "auth-challenge", body, value["issuedAt"])
    assert (
        protocol.verify_response(
            proof, value["accessKey"], box_id=value["boxId"], kind="auth-challenge"
        )["body"]
        == body
    )
    for box, kind in (("box:other", "auth-challenge"), (value["boxId"], "binding-ack")):
        with pytest.raises(BindingProtocolError):
            protocol.verify_response(proof, value["accessKey"], box_id=box, kind=kind)
    with pytest.raises(BindingProtocolError):
        protocol.sign_response(
            value["boxId"], key, "auth-challenge", {**body, "verified": True}, value["issuedAt"]
        )
