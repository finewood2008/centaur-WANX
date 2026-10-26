"""Real cloud/box/client signature interoperability; no authority callbacks are mocked.

The cross-repository signer is discovered beside WANX, or through
TEAM_IDENTITY_ADMIN_SOURCE. Standalone WANX CI can run the local ES256 tests;
the coordinated release must also run every Consumer signer test.
"""

from __future__ import annotations

import base64
import copy
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519

ROOT = Path(__file__).resolve().parents[3]
CLIENT = Path(__file__).with_name("client_vectors.mjs")
NOW = 2_000_000_000


def encoded(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def public(key: ec.EllipticCurvePrivateKey) -> dict[str, str]:
    numbers = key.public_key().public_numbers()
    return {
        "kty": "EC",
        "crv": "P-256",
        "x": encoded(numbers.x.to_bytes(32, "big")),
        "y": encoded(numbers.y.to_bytes(32, "big")),
    }


@pytest.fixture(scope="module")
def bridge() -> ModuleType:
    directory = str(ROOT / "wanx-bridge")
    if directory not in sys.path:
        sys.path.insert(0, directory)
    from wanx_bridge import local_team_protocol

    return local_team_protocol


@pytest.fixture(scope="module")
def cloud() -> ModuleType:
    directory = Path(os.environ.get("TEAM_IDENTITY_ADMIN_SOURCE", ROOT.parent / "nexusaos-admin"))
    filename = directory / "admin-backend/module_nexus/service/team_identity_protocol.py"
    if not filename.is_file():
        pytest.skip("Consumer source required for coordinated cloud/box/client release validation")
    spec = importlib.util.spec_from_file_location("team_identity_release_signer", filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def vector(bridge: ModuleType) -> dict[str, Any]:
    access = ec.generate_private_key(ec.SECP256R1())
    approval = ec.generate_private_key(ec.SECP256R1())
    signing = ed25519.Ed25519PrivateKey.generate()
    request = {
        "schemaVersion": 1,
        "purpose": "centuarai.team-membership.request",
        "boxId": "synthetic-box",
        "boxKeyThumbprint": encoded(b"B" * 32),
        "ownershipEpoch": 7,
        "invitationId": encoded(b"I" * 32),
        "principalId": "synthetic-member",
        "target": {
            "clientId": "synthetic-local-device",
            "accessKey": public(access),
            "approvalKey": public(approval),
            "keyProtection": "software-passphrase-v1",
            "capabilities": [],
            "grants": [{"resourceId": "wanx", "actions": ["read"]}],
            "delegableGrants": [],
            "expiresAt": None,
            "delegationExpiresAt": None,
        },
    }
    policy = {
        "schemaVersion": 1,
        "type": "centuarai-team-identity-policy",
        "issuer": "nexusaos-platform",
        "audience": "centuarai-local-team-identity",
        "kid": "synthetic-cloud-key",
        "publicKey": {
            "kty": "OKP",
            "crv": "Ed25519",
            "x": encoded(
                signing.public_key().public_bytes(
                    serialization.Encoding.Raw, serialization.PublicFormat.Raw
                )
            ),
        },
        "maximumProofLifetimeSeconds": 300,
    }
    claims = {
        "schemaVersion": 1,
        "purpose": "centuarai.team.identity-association",
        "issuer": policy["issuer"],
        "audience": policy["audience"],
        "subject": "synthetic-consumer",
        "jti": encoded(b"J" * 32),
        "issuedAt": NOW,
        "expiresAt": NOW + 300,
        "boxId": request["boxId"],
        "boxKeyThumbprint": request["boxKeyThumbprint"],
        "ownershipEpoch": request["ownershipEpoch"],
        "requestDigest": bridge.request_digest(request),
        "invitationId": request["invitationId"],
        "targetAccessKeyThumbprint": bridge.evidence.public_key_thumbprint(public(access)),
        "targetApprovalKeyThumbprint": bridge.evidence.public_key_thumbprint(public(approval)),
        "clientId": "synthetic-cloud-client",
        "clientKeyThumbprint": encoded(b"C" * 32),
        "nonce": encoded(b"N" * 32),
    }
    return {
        "request": request,
        "policy": policy,
        "claims": claims,
        "signing": signing,
        "access": access,
        "approval": approval,
    }


def client(operation: str, **payload: Any) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required for cross-runtime contract validation")
    result = subprocess.run(
        [node, str(CLIENT)],
        input=json.dumps({"operation": operation, **payload}),
        text=True,
        capture_output=True,
        timeout=20,
        check=True,
        cwd=ROOT,
    )
    return json.loads(result.stdout)


def cloud_options(vector: dict[str, Any], **changes: Any) -> dict[str, Any]:
    return {
        "policy": vector["policy"],
        "request": vector["request"],
        "accountId": vector["claims"]["subject"],
        "clientId": vector["claims"]["clientId"],
        "nonce": vector["claims"]["nonce"],
        "now": NOW + 1,
        **changes,
    }


@pytest.mark.parametrize("purpose", ["request-access", "request-approval"])
def test_real_client_request_signature_is_verified_by_box(
    bridge: ModuleType, vector: dict[str, Any], purpose: str
) -> None:
    key = vector["access" if purpose == "request-access" else "approval"]
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode("ascii")
    result = client("sign-request", request=vector["request"], purpose=purpose, privateKey=pem)
    assert result["ok"], result
    assert result["value"]["digest"] == bridge.request_digest(vector["request"])
    assert bridge.verify_request(result["value"]["proof"], purpose=purpose) == vector["request"]
    other = "request-approval" if purpose == "request-access" else "request-access"
    with pytest.raises(bridge.evidence.BindingProtocolError):
        bridge.verify_request(result["value"]["proof"], purpose=other)


@pytest.mark.parametrize("purpose", ["request-access", "request-approval"])
def test_real_box_request_signature_is_verified_by_client(
    bridge: ModuleType, vector: dict[str, Any], purpose: str
) -> None:
    key = vector["access" if purpose == "request-access" else "approval"]
    proof = bridge.sign_request(vector["request"], key, purpose=purpose)
    result = client("verify-request", proof=proof, publicKey=public(key), purpose=purpose)
    assert result == {"ok": True, "value": vector["request"]}
    other_key = vector["approval" if purpose == "request-access" else "access"]
    assert not client("verify-request", proof=proof, publicKey=public(other_key), purpose=purpose)[
        "ok"
    ]


@pytest.mark.parametrize("jti", [encoded(b"J" * 32), encoded(b"\xff" * 32), encoded(b"\xfb" * 32)])
def test_real_consumer_signer_is_accepted_by_box_and_client(
    cloud: ModuleType, bridge: ModuleType, vector: dict[str, Any], jti: str
) -> None:
    claims = {**vector["claims"], "jti": jti}
    proof = cloud.sign_cloud_proof(claims, vector["signing"], vector["policy"]["kid"])
    assert bridge.verify_cloud(proof, vector["policy"], vector["request"], NOW + 1) == claims
    assert client("verify-cloud", proof=proof, options=cloud_options(vector)) == {
        "ok": True,
        "value": claims,
    }


@pytest.mark.parametrize(
    "field,value",
    [
        ("boxId", "other-box"),
        ("boxKeyThumbprint", encoded(b"X" * 32)),
        ("ownershipEpoch", 8),
        ("invitationId", encoded(b"X" * 32)),
        ("principalId", "other-member"),
    ],
)
def test_cloud_proof_cannot_be_moved_to_another_request(
    cloud: ModuleType, bridge: ModuleType, vector: dict[str, Any], field: str, value: Any
) -> None:
    proof = cloud.sign_cloud_proof(vector["claims"], vector["signing"], vector["policy"]["kid"])
    request = {**vector["request"], field: value}
    with pytest.raises(bridge.evidence.BindingProtocolError):
        bridge.verify_cloud(proof, vector["policy"], request, NOW + 1)
    assert not client("verify-cloud", proof=proof, options=cloud_options(vector, request=request))[
        "ok"
    ]


@pytest.mark.parametrize(
    "field,value",
    [
        ("issuer", "untrusted-cloud"),
        ("audience", "local-data"),
        ("purpose", "centuarai.local-data"),
        ("expiresAt", NOW + 301),
        ("expiresAt", NOW),
        ("issuedAt", NOW + 2),
        ("targetAccessKeyThumbprint", encoded(b"X" * 32)),
        ("targetApprovalKeyThumbprint", encoded(b"X" * 32)),
        ("schemaVersion", True),
        ("unknownClaim", "admin"),
    ],
)
def test_even_authentic_cloud_signature_cannot_change_the_identity_contract(
    bridge: ModuleType, vector: dict[str, Any], field: str, value: Any
) -> None:
    header = {
        "alg": "EdDSA",
        "typ": "centuarai-team-cloud-identity+jws",
        "kid": vector["policy"]["kid"],
    }
    parts = [
        encoded(json.dumps(part, sort_keys=True, separators=(",", ":")).encode("ascii"))
        for part in (header, {**vector["claims"], field: value})
    ]
    signed = ".".join(parts)
    proof = signed + "." + encoded(vector["signing"].sign(signed.encode("ascii")))
    with pytest.raises(bridge.evidence.BindingProtocolError):
        bridge.verify_cloud(proof, vector["policy"], vector["request"], NOW + 1)
    assert not client("verify-cloud", proof=proof, options=cloud_options(vector))["ok"]


@pytest.mark.parametrize(
    "field,value",
    [
        ("accountId", "other-consumer"),
        ("clientId", "other-cloud-client"),
        ("nonce", encoded(b"X" * 32)),
    ],
)
def test_client_does_not_accept_a_response_for_a_different_cloud_session(
    cloud: ModuleType, vector: dict[str, Any], field: str, value: str
) -> None:
    proof = cloud.sign_cloud_proof(vector["claims"], vector["signing"], vector["policy"]["kid"])
    assert not client("verify-cloud", proof=proof, options=cloud_options(vector, **{field: value}))[
        "ok"
    ]


@pytest.mark.parametrize("encoding", ["duplicate-field", "whitespace", "noncanonical-number"])
def test_signed_noncanonical_json_is_rejected_by_both_verifiers(
    bridge: ModuleType, vector: dict[str, Any], encoding: str
) -> None:
    header = json.dumps(
        {
            "alg": "EdDSA",
            "typ": "centuarai-team-cloud-identity+jws",
            "kid": vector["policy"]["kid"],
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    payload = json.dumps(vector["claims"], sort_keys=True, separators=(",", ":"))
    if encoding == "duplicate-field":
        payload = payload[:-1] + ',"subject":"synthetic-consumer"}'
    elif encoding == "whitespace":
        payload = " " + payload
    else:
        payload = payload.replace('"ownershipEpoch":7', '"ownershipEpoch":7.0')
    signing = encoded(header.encode()) + "." + encoded(payload.encode())
    proof = signing + "." + encoded(vector["signing"].sign(signing.encode("ascii")))
    with pytest.raises(bridge.evidence.BindingProtocolError):
        bridge.verify_cloud(proof, vector["policy"], vector["request"], NOW + 1)
    assert not client("verify-cloud", proof=proof, options=cloud_options(vector))["ok"]


def test_request_cannot_delegate_more_or_longer_than_it_receives(
    bridge: ModuleType, vector: dict[str, Any]
) -> None:
    cases = []
    request = copy.deepcopy(vector["request"])
    request["target"]["delegableGrants"] = [{"resourceId": "wanx", "actions": ["write"]}]
    cases.append(request)
    request = copy.deepcopy(vector["request"])
    request["target"].update(expiresAt=NOW + 60, delegationExpiresAt=NOW + 120)
    cases.append(request)
    for request in cases:
        with pytest.raises(bridge.evidence.BindingProtocolError):
            bridge.validate_request(request)
        assert not client("validate-request", request=request)["ok"]
