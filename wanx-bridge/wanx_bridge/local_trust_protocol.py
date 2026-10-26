"""Offline local binding signature evidence; never enrollment or runtime authority.

This implements only the restricted JSON/JWS profile in
contracts/local-trust/v1/README.md. Trusted context and roster provenance,
native user verification, transactional revalidation and box ACKs belong to
subsequent integration. Cloud grants are not accepted as a root of trust.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

SAFE_INTEGER = 9007199254740991
MAX_JWS_BYTES = 16384
_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
_BASE64URL = re.compile(r"[A-Za-z0-9_-]+\Z")
_BOX_FIELDS = {
    "boxId",
    "boxKeyThumbprint",
    "ownershipEpoch",
    "rosterVersion",
    "rosterDigest",
    "policyVersion",
}
_REQUEST_FIELDS = _BOX_FIELDS | {
    "schemaVersion",
    "purpose",
    "requestId",
    "challenge",
    "issuedAt",
    "expiresAt",
    "principalId",
    "clientId",
    "accessKey",
    "approvalKey",
    "role",
    "grants",
    "delegationAllowed",
    "grantExpiresAt",
}
_APPROVAL_FIELDS = {
    "schemaVersion",
    "purpose",
    "requestDigest",
    "approverBindingId",
    "approvalKeyVersion",
    "approvedAt",
    "expiresAt",
}
_CANCEL_FIELDS = {"schemaVersion", "purpose", "requestId", "requestDigest", "issuedAt", "expiresAt"}
_BINDING_FIELDS = {
    "bindingId",
    "principalId",
    "clientId",
    "role",
    "status",
    "accessKey",
    "approvalKey",
    "approvalKeyVersion",
    "canApproveUseDevices",
    "delegableGrants",
    "expiresAt",
    "delegationExpiresAt",
    "establishedAt",
    "establishedVersion",
}
_PURPOSE = "centuarai.local-device-binding."
_TYPES = {
    kind: f"centuarai-device-binding-{kind}+jws" for kind in ("request", "approval", "cancel")
}


class BindingProtocolError(ValueError):
    """A stable rejection code, without request bodies or key material."""

    def __init__(self, code: str = "LOCAL_BINDING_INVALID") -> None:
        self.code = code
        super().__init__(code)


def _require(condition: bool, code: str = "LOCAL_BINDING_INVALID") -> None:
    if not condition:
        raise BindingProtocolError(code)


def _fields(value: Any, expected: set[str]) -> None:
    _require(type(value) is dict and set(value) == expected)


def _integer(value: Any) -> None:
    _require(type(value) is int and 0 < value <= SAFE_INTEGER)


def _token(value: Any) -> None:
    _require(type(value) is str and _TOKEN.fullmatch(value) is not None)


def _encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode(value: Any, length: int | None = None) -> bytes:
    _require(type(value) is str and _BASE64URL.fullmatch(value) is not None)
    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    except (ValueError, TypeError) as exc:
        raise BindingProtocolError() from exc
    _require(_encode(raw) == value and (length is None or len(raw) == length))
    return raw


def _digest(value: Any) -> None:
    _decode(value, 32)


def _canonical(value: Any) -> bytes:
    """Restricted ASCII/safe-integer profile, not a general JCS serializer."""

    def check(item: Any) -> None:
        if item is None or type(item) is bool:
            return
        if type(item) is str:
            _require(item.isascii())
            return
        if type(item) is int:
            _require(abs(item) <= SAFE_INTEGER)
            return
        if type(item) is list:
            for child in item:
                check(child)
            return
        if type(item) is dict:
            _require(all(type(key) is str and key.isascii() for key in item))
            for child in item.values():
                check(child)
            return
        raise BindingProtocolError()

    try:
        check(value)
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode(
            "ascii"
        )
    except (RecursionError, UnicodeError, ValueError, TypeError) as exc:
        if isinstance(exc, BindingProtocolError):
            raise
        raise BindingProtocolError() from exc


def _parse(raw: bytes) -> dict[str, Any]:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result = {}
        for key, value in pairs:
            _require(key not in result)
            result[key] = value
        return result

    try:
        value = json.loads(raw.decode("ascii"), object_pairs_hook=unique)
        _require(type(value) is dict and _canonical(value) == raw)
        return value
    except (ValueError, UnicodeError, RecursionError) as exc:
        if isinstance(exc, BindingProtocolError):
            raise
        raise BindingProtocolError() from exc


def _public_key(jwk: Any) -> ec.EllipticCurvePublicKey:
    _fields(jwk, {"crv", "kty", "x", "y"})
    _require(jwk["crv"] == "P-256" and jwk["kty"] == "EC")
    x, y = _decode(jwk["x"], 32), _decode(jwk["y"], 32)
    try:
        return ec.EllipticCurvePublicNumbers(
            int.from_bytes(x, "big"), int.from_bytes(y, "big"), ec.SECP256R1()
        ).public_key()
    except ValueError as exc:
        raise BindingProtocolError() from exc


def public_key_thumbprint(jwk: Any) -> str:
    """RFC 7638 SHA-256 thumbprint of an exact, valid P-256 public JWK."""
    _public_key(jwk)
    return _encode(hashlib.sha256(_canonical(jwk)).digest())


def _grants(value: Any, *, empty: bool = False) -> None:
    _require(type(value) is list and (0 if empty else 1) <= len(value) <= 16)
    identifiers = []
    for grant in value:
        _fields(grant, {"resourceId", "actions"})
        _token(grant["resourceId"])
        actions = grant["actions"]
        _require(type(actions) is list and 1 <= len(actions) <= 3)
        _require(
            all(
                type(action) is str and action in {"execute", "read", "write"} for action in actions
            )
        )
        _require(actions == sorted(set(actions)))
        identifiers.append(grant["resourceId"])
    _require(identifiers == sorted(set(identifiers)))


def validate_box_context(context: Any) -> None:
    """Validate six context fields only; this never establishes their trust."""
    _fields(context, _BOX_FIELDS)
    _token(context["boxId"])
    for field in ("boxKeyThumbprint", "rosterDigest"):
        _digest(context[field])
    for field in ("ownershipEpoch", "rosterVersion", "policyVersion"):
        _integer(context[field])


def _window(value: dict[str, Any]) -> None:
    _integer(value["issuedAt"])
    _integer(value["expiresAt"])
    _require(value["issuedAt"] < value["expiresAt"] <= value["issuedAt"] + 300)


def _request(value: Any) -> None:
    _fields(value, _REQUEST_FIELDS)
    _require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1)
    _require(value["purpose"] == _PURPOSE + "request")
    validate_box_context({key: value[key] for key in _BOX_FIELDS})
    for field in ("requestId", "challenge"):
        _digest(value[field])
    for field in ("principalId", "clientId"):
        _token(value[field])
    _window(value)
    _public_key(value["accessKey"])
    _require(value["approvalKey"] is None and value["role"] == "use")
    _require(value["delegationAllowed"] is False)
    _grants(value["grants"])
    if value["grantExpiresAt"] is not None:
        _integer(value["grantExpiresAt"])
        _require(value["grantExpiresAt"] >= value["expiresAt"])


def canonical_request(value: Any) -> bytes:
    _request(value)
    return _canonical(value)


def request_digest(value: Any) -> str:
    return _encode(hashlib.sha256(canonical_request(value)).digest())


def _approval(value: Any) -> None:
    _fields(value, _APPROVAL_FIELDS)
    _require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1)
    _require(value["purpose"] == _PURPOSE + "approval")
    _digest(value["requestDigest"])
    _token(value["approverBindingId"])
    for field in ("approvalKeyVersion", "approvedAt", "expiresAt"):
        _integer(value[field])
    _require(value["approvedAt"] < value["expiresAt"])


def _cancel(value: Any) -> None:
    _fields(value, _CANCEL_FIELDS)
    _require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1)
    _require(value["purpose"] == _PURPOSE + "cancel")
    _digest(value["requestId"])
    _digest(value["requestDigest"])
    _window(value)


def _private_key(key: Any) -> ec.EllipticCurvePrivateKey:
    try:
        if isinstance(key, str):
            key = key.encode("ascii")
        if isinstance(key, bytes):
            key = serialization.load_pem_private_key(key, password=None)
        _require(
            isinstance(key, ec.EllipticCurvePrivateKey) and isinstance(key.curve, ec.SECP256R1)
        )
        return key
    except (ValueError, TypeError, UnicodeError) as exc:
        if isinstance(exc, BindingProtocolError):
            raise
        raise BindingProtocolError() from exc


def _sign(value: Any, private_key: Any, kind: str) -> str:
    {"request": _request, "approval": _approval, "cancel": _cancel}[kind](value)
    result = jwt.api_jws.encode(
        _canonical(value),
        _private_key(private_key),
        algorithm="ES256",
        headers={"typ": _TYPES[kind]},
    )
    _require(len(result) <= MAX_JWS_BYTES)
    return result


def sign_request(request: Any, private_key: Any) -> str:
    _request(request)
    key = _private_key(private_key)
    _require(
        key.public_key().public_numbers() == _public_key(request["accessKey"]).public_numbers()
    )
    return _sign(request, key, "request")


def sign_approval(payload: Any, private_key: Any) -> str:
    return _sign(payload, private_key, "approval")


def sign_cancel(payload: Any, private_key: Any) -> str:
    return _sign(payload, private_key, "cancel")


def _decode_jws(jws: Any, kind: str) -> dict[str, Any]:
    _require(type(jws) is str and jws.isascii() and len(jws) <= MAX_JWS_BYTES)
    parts = jws.split(".")
    _require(len(parts) == 3)
    header = _parse(_decode(parts[0]))
    _require(header == {"alg": "ES256", "typ": _TYPES[kind]})
    value = _parse(_decode(parts[1]))
    _decode(parts[2], 64)
    {"request": _request, "approval": _approval, "cancel": _cancel}[kind](value)
    return value


def _verify(jws: str, key: ec.EllipticCurvePublicKey) -> None:
    try:
        jwt.api_jws.decode_complete(jws, key=key, algorithms=["ES256"])
    except (jwt.PyJWTError, ValueError, TypeError) as exc:
        raise BindingProtocolError("LOCAL_BINDING_SIGNATURE_INVALID") from exc


def verify_request_proof(jws: Any) -> dict[str, Any]:
    """Verify syntax and key possession; intentionally does not assert freshness."""
    request = _decode_jws(jws, "request")
    _verify(jws, _public_key(request["accessKey"]))
    return request


def _now(value: Any) -> None:
    _integer(value)


def _request_time(request: dict[str, Any], now: int) -> None:
    _now(now)
    _require(request["issuedAt"] <= now < request["expiresAt"], "LOCAL_BINDING_EXPIRED")


def validate_request_context(request: Any, context: Any, now: int) -> None:
    _request(request)
    _fields(context, _BOX_FIELDS | {"challenge"})
    validate_box_context({key: context[key] for key in _BOX_FIELDS})
    _digest(context["challenge"])
    _request_time(request, now)
    _require(all(request[key] == context[key] for key in context), "LOCAL_BINDING_CONTEXT_MISMATCH")


def _roster(state: Any) -> dict[str, dict[str, Any]]:
    _fields(state, _BOX_FIELDS | {"bindings"})
    validate_box_context({key: state[key] for key in _BOX_FIELDS})
    _require(type(state["bindings"]) is list)
    bindings: dict[str, dict[str, Any]] = {}
    clients: set[str] = set()
    keys: set[str] = set()
    for binding in state["bindings"]:
        _fields(binding, _BINDING_FIELDS)
        for field in ("bindingId", "principalId", "clientId"):
            _token(binding[field])
        _require(binding["role"] in ("manage", "use"))
        _require(binding["status"] in ("active", "suspended", "revoked"))
        _require(type(binding["canApproveUseDevices"]) is bool)
        _grants(binding["delegableGrants"], empty=True)
        for field in ("establishedAt", "establishedVersion"):
            _integer(binding[field])
        for field in ("expiresAt", "delegationExpiresAt"):
            if binding[field] is not None:
                _integer(binding[field])
        fingerprints = [public_key_thumbprint(binding["accessKey"])]
        if binding["approvalKey"] is None:
            _require(binding["approvalKeyVersion"] is None)
        else:
            _integer(binding["approvalKeyVersion"])
            fingerprints.append(public_key_thumbprint(binding["approvalKey"]))
        _require(binding["bindingId"] not in bindings and binding["clientId"] not in clients)
        for fingerprint in fingerprints:
            _require(fingerprint not in keys)
            keys.add(fingerprint)
        bindings[binding["bindingId"]] = binding
        clients.add(binding["clientId"])
    return bindings


def verify_approval_signature(
    approval_jws: Any, request_jws: Any, trusted_state: Any, now: int
) -> dict[str, Any]:
    """Return signature evidence, never user-verification or enrollment authority."""
    request = verify_request_proof(request_jws)
    approval = _decode_jws(approval_jws, "approval")
    bindings = _roster(trusted_state)
    _request_time(request, now)
    _require(
        all(request[key] == trusted_state[key] for key in _BOX_FIELDS),
        "LOCAL_BINDING_CONTEXT_MISMATCH",
    )
    _require(approval["requestDigest"] == request_digest(request), "LOCAL_BINDING_CONTEXT_MISMATCH")
    _require(
        request["issuedAt"]
        <= approval["approvedAt"]
        <= now
        < approval["expiresAt"]
        <= request["expiresAt"],
        "LOCAL_BINDING_EXPIRED",
    )
    target_key = public_key_thumbprint(request["accessKey"])
    _require(
        all(binding["clientId"] != request["clientId"] for binding in bindings.values()),
        "LOCAL_BINDING_CLIENT_REUSE",
    )
    for binding in bindings.values():
        for field in ("accessKey", "approvalKey"):
            if binding[field] is not None:
                _require(
                    public_key_thumbprint(binding[field]) != target_key, "LOCAL_BINDING_KEY_REUSE"
                )
    approver = bindings.get(approval["approverBindingId"])
    _require(approver is not None, "LOCAL_BINDING_APPROVAL_FORBIDDEN")
    assert approver is not None
    _require(
        approver["status"] == "active"
        and approver["role"] == "manage"
        and approver["canApproveUseDevices"]
        and approver["principalId"] == request["principalId"]
        and approver["approvalKey"] is not None
        and approver["approvalKeyVersion"] == approval["approvalKeyVersion"]
        and approver["establishedAt"] <= request["issuedAt"]
        and approver["establishedVersion"] <= request["rosterVersion"],
        "LOCAL_BINDING_APPROVAL_FORBIDDEN",
    )
    _verify(approval_jws, _public_key(approver["approvalKey"]))
    for field in ("expiresAt", "delegationExpiresAt"):
        deadline = approver[field]
        _require(deadline is None or now < deadline, "LOCAL_BINDING_EXPIRED")
        _require(
            deadline is None
            or (request["grantExpiresAt"] is not None and request["grantExpiresAt"] <= deadline),
            "LOCAL_BINDING_LIFETIME_EXCEEDED",
        )
    allowed = {grant["resourceId"]: set(grant["actions"]) for grant in approver["delegableGrants"]}
    _require(
        all(
            set(grant["actions"]) <= allowed.get(grant["resourceId"], set())
            for grant in request["grants"]
        ),
        "LOCAL_BINDING_SCOPE_EXCEEDED",
    )
    return approval


def decode_cancel_payload(jws: Any) -> dict[str, Any]:
    """UNVERIFIED cancellation payload for request lookup only, never authorization."""
    return _decode_jws(jws, "cancel")


def verify_cancel_proof(cancel_jws: Any, request: Any, now: int) -> dict[str, Any]:
    _request(request)
    cancellation = decode_cancel_payload(cancel_jws)
    _now(now)
    _require(cancellation["issuedAt"] <= now < cancellation["expiresAt"], "LOCAL_BINDING_EXPIRED")
    _require(
        cancellation["requestId"] == request["requestId"]
        and cancellation["requestDigest"] == request_digest(request),
        "LOCAL_BINDING_CONTEXT_MISMATCH",
    )
    _verify(cancel_jws, _public_key(request["accessKey"]))
    return cancellation
