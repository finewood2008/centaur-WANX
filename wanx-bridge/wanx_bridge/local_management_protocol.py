"""Strict wire primitives for local management, never a source of user authority."""

from __future__ import annotations

import hashlib
import hmac
from typing import Any
from urllib.parse import urlsplit

import jwt
from cryptography.hazmat.primitives.asymmetric import ec

from . import local_trust_protocol as evidence
from .local_trust_protocol import BindingProtocolError

_ROOT_FIELDS = {
    "schemaVersion",
    "purpose",
    "boxId",
    "boxKeyThumbprint",
    "provisioningId",
    "ownershipEpoch",
    "challenge",
    "requestId",
    "issuedAt",
    "expiresAt",
    "principalId",
    "clientId",
    "accessKey",
    "approvalKey",
    "grants",
    "grantExpiresAt",
    "keyProtection",
}
_READ_FIELDS = {
    "schemaVersion",
    "purpose",
    "boxId",
    "boxKeyThumbprint",
    "ownershipEpoch",
    "nonce",
    "issuedAt",
    "expiresAt",
    "clientId",
    "operation",
    "requestId",
}
_BUNDLE_FIELDS = {
    "schemaVersion",
    "type",
    "boxId",
    "baseUrl",
    "boxKey",
    "tlsSpkiSha256",
    "provisioningId",
    "ownershipEpoch",
    "grants",
    "claimSecretSha256",
    "sourceEvidenceKind",
    "sourceEvidenceSha256",
}
ROOT_ACCESS = "centuarai-first-root-access+jws"
ROOT_APPROVAL = "centuarai-first-root-approval+jws"
ROOT_SECRET = "centuarai-first-root-secret+jws"
READ = "centuarai-local-management-read+jws"
RESPONSE = "centuarai-local-management-response+jws"


def public_jwk(key: ec.EllipticCurvePrivateKey | ec.EllipticCurvePublicKey) -> dict:
    if isinstance(key, ec.EllipticCurvePrivateKey):
        key = key.public_key()
    evidence._require(
        isinstance(key, ec.EllipticCurvePublicKey) and isinstance(key.curve, ec.SECP256R1)
    )
    numbers = key.public_numbers()
    return {
        "crv": "P-256",
        "kty": "EC",
        "x": evidence._encode(numbers.x.to_bytes(32, "big")),
        "y": evidence._encode(numbers.y.to_bytes(32, "big")),
    }


def canonical(value: Any) -> bytes:
    return evidence._canonical(value)


def digest(value: Any) -> str:
    return evidence._encode(hashlib.sha256(canonical(value)).digest())


def validate_bundle(value: Any) -> None:
    evidence._fields(value, _BUNDLE_FIELDS)
    evidence._require(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and value["type"] == "centuarai-local-trust-private"
    )
    evidence._token(value["boxId"])
    evidence._public_key(value["boxKey"])
    for name in ("tlsSpkiSha256", "provisioningId", "claimSecretSha256", "sourceEvidenceSha256"):
        evidence._digest(value[name])
    evidence._integer(value["ownershipEpoch"])
    evidence._grants(value["grants"])
    evidence._require(value["sourceEvidenceKind"] in ("factory-clean", "full-erase"))
    evidence._require(
        type(value["baseUrl"]) is str
        and 1 <= len(value["baseUrl"]) <= 512
        and value["baseUrl"].isascii()
        and "\\" not in value["baseUrl"]
        and not any(ord(char) <= 32 or ord(char) == 127 for char in value["baseUrl"])
    )
    try:
        url = urlsplit(value["baseUrl"])
        evidence._require(
            url.scheme == "https"
            and bool(url.hostname)
            and url.username is None
            and url.password is None
            and not url.query
            and not url.fragment
            and url.path in ("", "/")
            and (url.port is None or 0 < url.port < 65536)
        )
    except ValueError as exc:
        raise BindingProtocolError() from exc


def validate_first_root(value: Any) -> None:
    evidence._fields(value, _ROOT_FIELDS)
    evidence._require(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and value["purpose"] == "centuarai.local-management.first-root"
    )
    for name in ("boxId", "principalId", "clientId"):
        evidence._token(value[name])
    for name in ("boxKeyThumbprint", "provisioningId", "challenge", "requestId"):
        evidence._digest(value[name])
    evidence._integer(value["ownershipEpoch"])
    evidence._window(value)
    evidence._require(
        evidence.public_key_thumbprint(value["accessKey"])
        != evidence.public_key_thumbprint(value["approvalKey"])
    )
    evidence._grants(value["grants"])
    evidence._require(
        value["grantExpiresAt"] is None and value["keyProtection"] == "software-passphrase-v1"
    )


def canonical_first_root(value: Any) -> bytes:
    validate_first_root(value)
    return canonical(value)


def first_root_digest(value: Any) -> str:
    return evidence._encode(hashlib.sha256(canonical_first_root(value)).digest())


def _decode(jws: Any, typ: str, validator, *, secret: bool = False) -> dict:
    evidence._require(type(jws) is str and jws.isascii() and len(jws) <= evidence.MAX_JWS_BYTES)
    parts = jws.split(".")
    evidence._require(len(parts) == 3)
    header = evidence._parse(evidence._decode(parts[0]))
    evidence._require(header == {"alg": "HS256" if secret else "ES256", "typ": typ})
    payload = evidence._parse(evidence._decode(parts[1]))
    evidence._decode(parts[2], 32 if secret else 64)
    validator(payload)
    return payload


def _sign(payload: Any, key: Any, typ: str, validator, *, secret: bool = False) -> str:
    validator(payload)
    if secret:
        evidence._require(type(key) is bytes and len(key) == 32)
    else:
        key = evidence._private_key(key)
    proof = jwt.api_jws.encode(
        canonical(payload), key, algorithm="HS256" if secret else "ES256", headers={"typ": typ}
    )
    evidence._require(len(proof) <= evidence.MAX_JWS_BYTES)
    return proof


def sign_first_root(payload: Any, private_key: Any, *, purpose: str) -> str:
    evidence._require(purpose in ("access", "approval"))
    validate_first_root(payload)
    key = evidence._private_key(private_key)
    evidence._require(public_jwk(key) == payload[purpose + "Key"])
    return _sign(
        payload, key, ROOT_ACCESS if purpose == "access" else ROOT_APPROVAL, validate_first_root
    )


def sign_first_root_secret(payload: Any, verification_key: bytes) -> str:
    return _sign(payload, verification_key, ROOT_SECRET, validate_first_root, secret=True)


def verify_first_root_proofs(
    access_proof: str, approval_proof: str, secret_proof: str, verification_key: bytes | None = None
) -> dict:
    """Always verify both client keys; only a saved exact retry may omit the consumed PSK."""
    payload = _decode(access_proof, ROOT_ACCESS, validate_first_root)
    approval = _decode(approval_proof, ROOT_APPROVAL, validate_first_root)
    secret = _decode(secret_proof, ROOT_SECRET, validate_first_root, secret=True)
    evidence._require(payload == approval == secret, "LOCAL_BINDING_CONTEXT_MISMATCH")
    evidence._verify(access_proof, evidence._public_key(payload["accessKey"]))
    evidence._verify(approval_proof, evidence._public_key(payload["approvalKey"]))
    if verification_key is not None:
        evidence._require(type(verification_key) is bytes and len(verification_key) == 32)
        signing, signature = secret_proof.rsplit(".", 1)
        expected = hmac.digest(verification_key, signing.encode("ascii"), "sha256")
        evidence._require(
            hmac.compare_digest(expected, evidence._decode(signature, 32)),
            "LOCAL_BINDING_SIGNATURE_INVALID",
        )
    return payload


def validate_read(value: Any) -> None:
    evidence._fields(value, _READ_FIELDS)
    evidence._require(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and value["purpose"] == "centuarai.local-management.read"
    )
    for name in ("boxId", "clientId"):
        evidence._token(value[name])
    for name in ("boxKeyThumbprint", "nonce"):
        evidence._digest(value[name])
    evidence._integer(value["ownershipEpoch"])
    evidence._window(value)
    evidence._require(value["expiresAt"] <= value["issuedAt"] + 60)
    evidence._require(value["operation"] in ("state", "request"))
    if value["operation"] == "state":
        evidence._require(value["requestId"] is None)
    else:
        evidence._digest(value["requestId"])


def decode_read_proof(proof: str) -> dict:
    """Unverified locator; it must never authorize or disclose a saved record."""
    return _decode(proof, READ, validate_read)


def verify_read_proof(proof: str, public_key: dict) -> dict:
    value = decode_read_proof(proof)
    evidence._verify(proof, evidence._public_key(public_key))
    return value


def sign_read_proof(payload: Any, private_key: Any) -> str:
    return _sign(payload, private_key, READ, validate_read)


def verify_saved_approval(proof: str, expected_payload: dict, approval_key: dict) -> None:
    payload = evidence._decode_jws(proof, "approval")
    evidence._require(payload == expected_payload, "LOCAL_BINDING_CONTEXT_MISMATCH")
    evidence._verify(proof, evidence._public_key(approval_key))


def _response(value: Any) -> None:
    evidence._fields(
        value, {"schemaVersion", "purpose", "boxId", "boxKeyThumbprint", "kind", "issuedAt", "body"}
    )
    evidence._require(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and value["purpose"] == "centuarai.local-management.response"
    )
    evidence._token(value["boxId"])
    evidence._digest(value["boxKeyThumbprint"])
    evidence._integer(value["issuedAt"])
    fields = {
        "first-root-challenge": {
            "provisioningId",
            "ownershipEpoch",
            "challenge",
            "issuedAt",
            "expiresAt",
            "grants",
        },
        "auth-challenge": {"nonce", "issuedAt", "expiresAt", "ownershipEpoch"},
        "binding-challenge": {"context", "challenge", "issuedAt", "expiresAt"},
        "state": {"context", "bindings", "recoveryConfigured"},
        "request": {"requestId", "requestDigest", "state", "requestJws", "ack"},
        "request-receipt": {"requestId", "requestDigest", "state", "expiresAt"},
        "binding-ack": {
            "requestId",
            "requestDigest",
            "bindingId",
            "principalId",
            "clientId",
            "role",
            "accessKeyThumbprint",
            "ownershipEpoch",
            "rosterVersion",
            "rosterDigest",
            "policyVersion",
            "committedAt",
            "recoveryConfigured",
        },
    }
    evidence._require(type(value["kind"]) is str and value["kind"] in fields)
    kind, body = value["kind"], value["body"]
    evidence._fields(body, fields[kind])
    if kind.endswith("-challenge"):
        evidence._window(body)
        evidence._require(body["issuedAt"] == value["issuedAt"])
        evidence._digest(body["nonce"] if kind == "auth-challenge" else body["challenge"])
        if kind == "auth-challenge":
            evidence._require(body["expiresAt"] <= body["issuedAt"] + 60)
        if kind == "first-root-challenge":
            evidence._digest(body["provisioningId"])
            evidence._grants(body["grants"])
        if kind != "binding-challenge":
            evidence._integer(body["ownershipEpoch"])
    if kind in ("state", "binding-challenge"):
        evidence.validate_box_context(body["context"])
        evidence._require(
            all(body["context"][field] == value[field] for field in ("boxId", "boxKeyThumbprint"))
        )
    if kind == "state":
        evidence._roster({**body["context"], "bindings": body["bindings"]})
        evidence._require(body["recoveryConfigured"] is False)
    if kind in ("request", "request-receipt", "binding-ack"):
        evidence._digest(body["requestId"])
        evidence._digest(body["requestDigest"])
    if kind in ("request", "request-receipt"):
        evidence._require(body["state"] in ("pending", "approved", "cancelled", "expired"))
        if kind == "request-receipt":
            evidence._integer(body["expiresAt"])
        else:
            request = evidence.verify_request_proof(body["requestJws"])
            evidence._require(
                request["requestId"] == body["requestId"]
                and evidence.request_digest(request) == body["requestDigest"]
            )
            evidence._require(
                type(body["ack"]) is str if body["state"] == "approved" else body["ack"] is None
            )
    if kind == "binding-ack":
        for field in ("bindingId", "principalId", "clientId"):
            evidence._token(body[field])
        for field in ("ownershipEpoch", "rosterVersion", "policyVersion", "committedAt"):
            evidence._integer(body[field])
        for field in ("accessKeyThumbprint", "rosterDigest"):
            evidence._digest(body[field])
        evidence._require(
            body["role"] in ("use", "manage")
            and body["recoveryConfigured"] is False
            and body["committedAt"] == value["issuedAt"]
        )
    canonical(value)


def sign_response(box_id: str, key: Any, kind: str, body: dict, now: int) -> str:
    key = evidence._private_key(key)
    payload = {
        "schemaVersion": 1,
        "purpose": "centuarai.local-management.response",
        "boxId": box_id,
        "boxKeyThumbprint": evidence.public_key_thumbprint(public_jwk(key)),
        "kind": kind,
        "issuedAt": now,
        "body": body,
    }
    return _sign(payload, key, RESPONSE, _response)


def verify_response(proof: str, box_key: dict, *, box_id: str, kind: str) -> dict:
    value = _decode(proof, RESPONSE, _response)
    evidence._verify(proof, evidence._public_key(box_key))
    evidence._require(
        value["boxId"] == box_id
        and value["kind"] == kind
        and value["boxKeyThumbprint"] == evidence.public_key_thumbprint(box_key),
        "LOCAL_BINDING_CONTEXT_MISMATCH",
    )
    if kind == "request" and value["body"]["state"] == "approved":
        body = value["body"]
        ack = verify_response(body["ack"], box_key, box_id=box_id, kind="binding-ack")["body"]
        request = evidence.verify_request_proof(body["requestJws"])
        evidence._require(
            all(ack[field] == body[field] for field in ("requestId", "requestDigest"))
            and all(
                ack[field] == request[field]
                for field in ("clientId", "principalId", "role", "ownershipEpoch", "policyVersion")
            )
            and ack["accessKeyThumbprint"] == evidence.public_key_thumbprint(request["accessKey"])
            and ack["rosterVersion"] > request["rosterVersion"],
            "LOCAL_BINDING_CONTEXT_MISMATCH",
        )
    return value
