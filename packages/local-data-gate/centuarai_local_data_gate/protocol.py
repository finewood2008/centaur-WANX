"""Pure, strict local-data wire codec; no authority, I/O or platform dependency."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from urllib.parse import parse_qsl, unquote, urlsplit

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils

SAFE_INTEGER = 2**53 - 1
MAX_PROOF_BYTES = 16384
MAX_RESPONSE_BYTES = 65536
HEADERS = {
    "contentType",
    "range",
    "ifRange",
    "ifMatch",
    "lastEventId",
    "agentId",
    "dataContext",
    "idempotencyKey",
    "webSocketKey",
    "webSocketProtocol",
    "spaceLink",
    "contentSha256",
}
IDENTITY = {"boxId", "boxKeyThumbprint", "ownershipEpoch", "principalId", "bindingId", "clientId"}
CHANNEL = {
    "schemaVersion",
    "purpose",
    "boxId",
    "sessionId",
    "gatewayGeneration",
    "applicationId",
    "launchId",
    "jti",
    "issuedAtMs",
    "expiresAtMs",
}
REQUEST = CHANNEL | {"transport", "method", "rawTarget", "headers", "bodySha256", "bodyBytes"}
AUTHORIZATION = IDENTITY | {
    "authorizationVersion",
    "principalSecurityVersion",
    "bindingRevision",
    "grants",
    "grantExpiresAtMs",
}
GATEWAY = {
    "schemaVersion",
    "purpose",
    "audience",
    "gatewayId",
    "gatewayGeneration",
    "sessionId",
    "operationId",
    "parentOperationId",
    "jti",
    "issuedAtMs",
    "expiresAtMs",
    "authorizationVersion",
    "principalSecurityVersion",
    "bindingRevision",
    "applicationId",
    "launchId",
    "transport",
    "method",
    "rawTarget",
    "headers",
    "bodySha256",
    "bodyBytes",
    "resourceId",
    "action",
    "serviceContext",
} | IDENTITY
LEASE = {
    "schemaVersion",
    "purpose",
    "audience",
    "gatewayId",
    "gatewayGeneration",
    "nativeGateGeneration",
    "gateNonce",
    "sessionId",
    "operationId",
    "parentOperationId",
    "gatewayProofDigest",
    "state",
    "ownershipEpoch",
    "authorizationVersion",
    "principalSecurityVersion",
    "bindingId",
    "bindingRevision",
    "principalId",
    "clientId",
    "applicationId",
    "launchId",
    "resourceId",
    "action",
    "issuedAtMs",
    "expiresAtMs",
}
TYPES = {
    name: f"centuarai-local-data-{name}+jws"
    for name in (
        "session",
        "session-intent",
        "heartbeat",
        "renewal",
        "close",
        "request",
        "gateway-request",
        "gateway-lease",
        "gateway-resources",
        "gateway-observation",
        "response",
    )
}


DATA_ERROR_CODES = frozenset(
    {
        "LOCAL_DATA_INVALID",
        "LOCAL_DATA_REQUIRED",
        "LOCAL_DATA_FORBIDDEN",
        "LOCAL_DATA_SESSION_CLOSED",
        "LOCAL_DATA_SESSION_EXPIRED",
        "LOCAL_DATA_REPLAY",
        "LOCAL_DATA_CONTEXT_CHANGED",
        "LOCAL_DATA_BODY_MISMATCH",
        "LOCAL_DATA_BODY_TOO_LARGE",
        "LOCAL_DATA_STAGING_UNAVAILABLE",
        "LOCAL_DATA_CAPACITY",
        "LOCAL_DATA_AUTHORITY_UNAVAILABLE",
        "LOCAL_DATA_CLOCK_ROLLBACK",
        "LOCAL_DATA_ROUTE_DENIED",
        "LOCAL_DATA_SCOPE_DENIED",
        "LOCAL_DATA_UNAVAILABLE",
        "LOCAL_DATA_CAPABILITY_REQUIRED",
    }
)


class DataProtocolError(Exception):
    def __init__(self, code="LOCAL_DATA_INVALID"):
        self.code = code if type(code) is str and code in DATA_ERROR_CODES else "LOCAL_DATA_INVALID"
        super().__init__(self.code)


def need(condition, code="LOCAL_DATA_INVALID"):
    if not condition:
        raise DataProtocolError(code)


def fields(value, names):
    need(type(value) is dict and set(value) == set(names))


def integer(value, *, zero=False):
    need(type(value) is int and (0 if zero else 1) <= value <= SAFE_INTEGER)


def token(value):
    need(
        type(value) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value) is not None
    )


def encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def decode(value, length=None):
    need(type(value) is str and re.fullmatch(r"[A-Za-z0-9_-]+", value) is not None)
    try:
        result = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError) as exc:
        raise DataProtocolError() from exc
    need(encode(result) == value and (length is None or len(result) == length))
    return result


def digest32(value):
    decode(value, 32)


def canonical(value, _depth=0):
    need(_depth <= 32)
    if value is None or type(value) is bool:
        return json.dumps(value).encode("ascii")
    if type(value) is int:
        need(-SAFE_INTEGER <= value <= SAFE_INTEGER)
        return str(value).encode("ascii")
    if type(value) is str:
        need(value.isascii())
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("ascii")
    if type(value) is list:
        return b"[" + b",".join(canonical(item, _depth + 1) for item in value) + b"]"
    need(type(value) is dict and all(type(key) is str for key in value))
    return (
        b"{"
        + b",".join(
            canonical(key) + b":" + canonical(value[key], _depth + 1) for key in sorted(value)
        )
        + b"}"
    )


def digest(value):
    return encode(hashlib.sha256(canonical(value)).digest())


def public_key(value):
    fields(value, {"crv", "kty", "x", "y"})
    need(value["crv"] == "P-256" and value["kty"] == "EC")
    try:
        return ec.EllipticCurvePublicNumbers(
            int.from_bytes(decode(value["x"], 32), "big"),
            int.from_bytes(decode(value["y"], 32), "big"),
            ec.SECP256R1(),
        ).public_key()
    except ValueError as exc:
        raise DataProtocolError() from exc


def public_jwk(key):
    if isinstance(key, ec.EllipticCurvePrivateKey):
        key = key.public_key()
    need(isinstance(key, ec.EllipticCurvePublicKey) and isinstance(key.curve, ec.SECP256R1))
    p = key.public_numbers()
    return {
        "crv": "P-256",
        "kty": "EC",
        "x": encode(p.x.to_bytes(32, "big")),
        "y": encode(p.y.to_bytes(32, "big")),
    }


def public_key_thumbprint(jwk):
    public_key(jwk)
    return digest(jwk)


def grants(value, *, empty=False):
    need(type(value) is list and (0 if empty else 1) <= len(value) <= 16)
    previous = ""
    for grant in value:
        fields(grant, {"resourceId", "actions"})
        token(grant["resourceId"])
        need(grant["resourceId"] > previous)
        previous = grant["resourceId"]
        actions = grant["actions"]
        need(
            type(actions) is list
            and 1 <= len(actions) <= 3
            and all(type(a) is str and a in {"execute", "read", "write"} for a in actions)
            and actions == sorted(set(actions))
        )


def _window(value, maximum):
    integer(value["issuedAtMs"])
    integer(value["expiresAtMs"])
    need(0 < value["expiresAtMs"] - value["issuedAtMs"] <= maximum)


def fresh(value, now_ms):
    integer(now_ms)
    need(value["issuedAtMs"] <= now_ms < value["expiresAtMs"], "LOCAL_DATA_SESSION_EXPIRED")


def _base(value, purpose):
    need(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and value["purpose"] == "centuarai.local-data." + purpose
    )


def _identity(value):
    for name in ("boxId", "principalId", "bindingId", "clientId"):
        token(value[name])
    digest32(value["boxKeyThumbprint"])
    integer(value["ownershipEpoch"])


def validate_session_intent_payload(value):
    fields(
        value,
        {
            "schemaVersion",
            "purpose",
            "boxId",
            "boxKeyThumbprint",
            "bindingId",
            "applicationId",
            "launchId",
            "requestId",
            "channelKey",
            "jti",
            "issuedAtMs",
            "expiresAtMs",
        },
    )
    _base(value, "session-intent")
    for name in ("boxId", "bindingId", "applicationId"):
        token(value[name])
    for name in ("boxKeyThumbprint", "launchId", "requestId", "jti"):
        digest32(value[name])
    public_key(value["channelKey"])
    _window(value, 3000)


def validate_session_payload(value):
    fields(
        value,
        {
            "schemaVersion",
            "purpose",
            "gatewayGeneration",
            "challenge",
            "requestId",
            "issuedAtMs",
            "expiresAtMs",
            "applicationId",
            "launchId",
            "channelKey",
        }
        | IDENTITY,
    )
    _base(value, "session")
    _identity(value)
    _window(value, 30000)
    for name in ("gatewayGeneration", "challenge", "requestId", "launchId"):
        digest32(value[name])
    token(value["applicationId"])
    public_key(value["channelKey"])


def _channel(value, purpose):
    _base(value, purpose)
    for name in ("boxId", "applicationId"):
        token(value[name])
    for name in ("sessionId", "gatewayGeneration", "launchId", "jti"):
        digest32(value[name])


def validate_heartbeat_payload(value):
    fields(value, CHANNEL | {"sequence"})
    _channel(value, "heartbeat")
    _window(value, 3000)
    integer(value["sequence"])


def validate_renewal_payload(value):
    fields(value, CHANNEL | {"requestId", "channelKey"})
    _channel(value, "renewal")
    _window(value, 3000)
    digest32(value["requestId"])
    public_key(value["channelKey"])


def validate_close_payload(value):
    fields(value, CHANNEL | {"reason"})
    _channel(value, "close")
    _window(value, 3000)
    need(value["reason"] in ("lock", "user-close", "app-exit", "superseded"))


def validate_target(value):
    need(
        type(value) is str
        and value.isascii()
        and 1 <= len(value) <= 8192
        and value.startswith("/")
        and not any(ord(c) <= 32 or ord(c) == 127 for c in value)
        and "#" not in value
        and "\\" not in value
    )
    try:
        target = urlsplit(value)
        need(not target.scheme and not target.netloc)
        path = target.path
        need(not re.search(r"%(?![0-9a-fA-F]{2})", value))
        decoded = unquote(path, errors="strict")
        need(
            not any(p in {".", ".."} for p in decoded.split("/"))
            and "//" not in decoded
            and "\\" not in decoded
            and not any(ord(c) < 32 or ord(c) == 127 for c in decoded)
            and unquote(decoded) == decoded
        )
        # Encoded ASCII path aliases must not bypass the registered raw route.
        need(not any(int(m[1], 16) < 128 for m in re.finditer(r"%([0-9a-fA-F]{2})", path)))
        need(
            not any(
                k.casefold()
                in {"token", "access_token", "authorization", "gateway_proof", "data_proof"}
                for k, _ in parse_qsl(target.query, keep_blank_values=True)
            )
        )
    except (ValueError, UnicodeError) as exc:
        raise DataProtocolError() from exc


def validate_headers(value):
    fields(value, HEADERS)
    for item in value.values():
        need(
            item is None
            or type(item) is str
            and 1 <= len(item) <= 4096
            and item.isascii()
            and all(32 <= ord(c) < 127 for c in item)
        )
    need(sum(len(v) for v in value.values() if v is not None) <= 8192)


def _request(value):
    need(value["transport"] in ("http", "websocket"))
    need(value["method"] in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"))
    validate_target(value["rawTarget"])
    validate_headers(value["headers"])
    digest32(value["bodySha256"])
    integer(value["bodyBytes"], zero=True)
    if value["transport"] == "websocket":
        need(
            value["method"] == "GET"
            and value["bodyBytes"] == 0
            and value["bodySha256"] == encode(hashlib.sha256(b"").digest())
            and value["headers"]["webSocketKey"] is not None
        )
    else:
        need(
            value["headers"]["webSocketKey"] is None
            and value["headers"]["webSocketProtocol"] is None
        )


def validate_request_payload(value):
    fields(value, REQUEST)
    _channel(value, "request")
    _window(value, 10000)
    _request(value)


def _context(value):
    audience = value["audience"]
    need(audience in ("octop", "semantica", "semantica-mcp", "clipboard"))
    ctx = value["serviceContext"]
    if audience == "octop":
        fields(ctx, {"kind", "principalNamespace", "clipboardScope"})
        need(ctx["kind"] == "principal")
        validate_clipboard_scope(ctx["clipboardScope"])
        need((value["parentOperationId"] is None) == (ctx["clipboardScope"] is None))
    elif audience == "clipboard":
        fields(ctx, {"kind", "principalNamespace", "applicationId"})
        need(ctx["kind"] == "clipboard" and ctx["applicationId"] == value["applicationId"])
    else:
        fields(ctx, {"kind", "principalNamespace", "workspaceId", "warehouseId", "operation"})
        need(ctx["kind"] == "warehouse")
        token(ctx["workspaceId"])
        token(ctx["operation"])
        need(
            ctx["warehouseId"] is None
            or type(ctx["warehouseId"]) is str
            and re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", ctx["warehouseId"])
            is not None
        )
    expected = principal_namespace(
        value["boxKeyThumbprint"], value["ownershipEpoch"], value["principalId"]
    )
    need(ctx["principalNamespace"] == expected, "LOCAL_DATA_CONTEXT_CHANGED")


def principal_namespace(box_key_thumbprint, ownership_epoch, principal_id):
    digest32(box_key_thumbprint)
    integer(ownership_epoch)
    token(principal_id)
    return digest(
        {
            "schemaVersion": 1,
            "purpose": "centuarai.local-data.principal",
            "boxKeyThumbprint": box_key_thumbprint,
            "ownershipEpoch": ownership_epoch,
            "principalId": principal_id,
        }
    )


def validate_clipboard_scope(value):
    if value is None:
        return
    fields(value, {"application", "exportId", "parent"})
    need(value["application"] == "wanx.clipboard")
    if value["exportId"] is None:
        need(value["parent"] is None)
    else:
        need(
            type(value["exportId"]) is str
            and re.fullmatch(r"[0-9a-f]{32}", value["exportId"]) is not None
        )
        need(
            type(value["parent"]) is str
            and re.fullmatch(r"(?:[0-9a-f]{32})?", value["parent"]) is not None
        )


def validate_gateway_request(value):
    fields(value, GATEWAY)
    _base(value, "gateway-request")
    _identity(value)
    _window(value, 2000)
    _request(value)
    _context(value)
    for name in ("gatewayId", "applicationId", "resourceId"):
        token(value[name])
    for name in ("gatewayGeneration", "sessionId", "operationId", "jti", "launchId"):
        digest32(value[name])
    if value["parentOperationId"] is not None:
        digest32(value["parentOperationId"])
    for name in ("authorizationVersion", "principalSecurityVersion", "bindingRevision"):
        integer(value[name])
    need(value["action"] in ("execute", "read", "write"))


def validate_gateway_lease(value):
    fields(value, LEASE)
    _base(value, "gateway-lease")
    _window(value, 1000)
    need(
        value["audience"] in ("octop", "semantica", "semantica-mcp", "clipboard")
        and value["state"] in ("staging", "active", "closed")
        and value["action"] in ("execute", "read", "write")
    )
    for name in (
        "gatewayId",
        "bindingId",
        "principalId",
        "clientId",
        "applicationId",
        "resourceId",
    ):
        token(value[name])
    for name in (
        "gatewayGeneration",
        "nativeGateGeneration",
        "gateNonce",
        "sessionId",
        "operationId",
        "gatewayProofDigest",
        "launchId",
    ):
        digest32(value[name])
    if value["parentOperationId"] is not None:
        digest32(value["parentOperationId"])
    for name in (
        "ownershipEpoch",
        "authorizationVersion",
        "principalSecurityVersion",
        "bindingRevision",
    ):
        integer(value[name])


def validate_authorization(value):
    fields(value, AUTHORIZATION)
    _identity(value)
    for name in ("authorizationVersion", "principalSecurityVersion", "bindingRevision"):
        integer(value[name])
    grants(value["grants"])
    if value["grantExpiresAtMs"] is not None:
        integer(value["grantExpiresAtMs"])


def validate_gateway_resources(value):
    fields(value, LEASE | {"grants", "requestDigest"})
    _base(value, "gateway-resources")
    base = {key: value[key] for key in LEASE}
    base["purpose"] = "centuarai.local-data.gateway-lease"
    validate_gateway_lease(base)
    grants(value["grants"])
    digest32(value["requestDigest"])
    need(
        value["state"] == "active"
        and value["audience"] == "octop"
        and value["applicationId"] == "wanx-host"
        and value["parentOperationId"] is None
    )


def validate_gateway_observation(value):
    fields(
        value,
        {
            "schemaVersion",
            "purpose",
            "audience",
            "gatewayId",
            "gatewayGeneration",
            "nativeGateGeneration",
            "gateNonce",
            "requestDigest",
            "accepted",
            "issuedAtMs",
            "expiresAtMs",
        },
    )
    _base(value, "gateway-observation")
    need(value["audience"] in ("octop", "clipboard", "semantica", "semantica-mcp"))
    token(value["gatewayId"])
    for name in ("gatewayGeneration", "nativeGateGeneration", "gateNonce", "requestDigest"):
        digest32(value[name])
    need(type(value["accepted"]) is bool)
    _window(value, 1000)


WORKER_JOB_FIELDS = {
    "operationId",
    "attempt",
    "stateVersion",
    "bindingId",
    "principalId",
    "ownershipEpoch",
    "authorizationVersion",
}


def validate_worker_job(value, *, evidence=False):
    fields(value, WORKER_JOB_FIELDS | ({"phase", "publicationPending"} if evidence else set()))
    digest32(value["operationId"])
    for name in ("bindingId", "principalId"):
        token(value[name])
    for name in ("attempt", "stateVersion", "ownershipEpoch", "authorizationVersion"):
        integer(value[name])
    if evidence:
        need(
            value["phase"] in ("active", "closed", "unknown")
            and type(value["publicationPending"]) is bool
        )
        need(value["phase"] != "closed" or value["publicationPending"] is False)


def _response_body(kind, body):
    if kind == "session-challenge":
        fields(body, {"challenge", "gatewayGeneration", "issuedAtMs", "expiresAtMs"})
        digest32(body["challenge"])
        digest32(body["gatewayGeneration"])
        _window(body, 30000)
    elif kind == "session":
        fields(
            body,
            {
                "sessionId",
                "gatewayGeneration",
                "applicationId",
                "launchId",
                "channelKeyThumbprint",
                "issuedAtMs",
                "expiresAtMs",
                "presenceExpiresAtMs",
                "heartbeatIntervalMs",
                "authorization",
            },
        )
        for name in ("sessionId", "gatewayGeneration", "launchId", "channelKeyThumbprint"):
            digest32(body[name])
        token(body["applicationId"])
        _window(body, 300000)
        integer(body["presenceExpiresAtMs"])
        need(
            body["issuedAtMs"]
            < body["presenceExpiresAtMs"]
            <= min(body["expiresAtMs"], body["issuedAtMs"] + 3000)
            and type(body["heartbeatIntervalMs"]) is int
            and body["heartbeatIntervalMs"] == 1000
        )
        validate_authorization(body["authorization"])
        limit = body["authorization"]["grantExpiresAtMs"]
        need(limit is None or body["expiresAtMs"] <= limit)
    elif kind == "heartbeat":
        fields(
            body,
            {
                "sessionId",
                "sequence",
                "issuedAtMs",
                "presenceExpiresAtMs",
                "authorizationVersion",
                "bindingRevision",
            },
        )
        digest32(body["sessionId"])
        for name in (
            "sequence",
            "issuedAtMs",
            "presenceExpiresAtMs",
            "authorizationVersion",
            "bindingRevision",
        ):
            integer(body[name])
        need(body["issuedAtMs"] < body["presenceExpiresAtMs"] <= body["issuedAtMs"] + 3000)
    elif kind == "closed":
        fields(body, {"sessionId", "closedAtMs"})
        digest32(body["sessionId"])
        integer(body["closedAtMs"])
    elif kind == "effect":
        fields(
            body,
            {
                "operationId",
                "targetScope",
                "authorizationVersion",
                "committedAtMs",
                "deadlineMs",
                "effectState",
                "gateway",
                "native",
                "observedAtMs",
                "evidenceDigest",
            },
        )
        digest32(body["operationId"])
        digest32(body["evidenceDigest"])
        fields(body["targetScope"], {"kind", "id"})
        need(body["targetScope"]["kind"] in ("session", "binding", "principal", "ownership"))
        (digest32 if body["targetScope"]["kind"] == "session" else token)(body["targetScope"]["id"])
        for name in ("authorizationVersion", "committedAtMs", "deadlineMs", "observedAtMs"):
            integer(body[name])
        need(
            body["deadlineMs"] == body["committedAtMs"] + 5000
            and body["effectState"] in ("pending", "effective", "failed", "unknown")
        )
        fields(
            body["gateway"], {"generation", "targetSessions", "closedSessions", "pendingSessions"}
        )
        digest32(body["gateway"]["generation"])
        fields(
            body["native"],
            {"targetOperations", "closedOperations", "pendingOperations", "unknownOperations"},
        )
        for group in (body["gateway"], body["native"]):
            for name, value in group.items():
                if name != "generation":
                    integer(value, zero=True)
        need(
            body["gateway"]["targetSessions"]
            == body["gateway"]["closedSessions"] + body["gateway"]["pendingSessions"]
        )
        need(
            body["native"]["targetOperations"]
            == sum(
                body["native"][k]
                for k in ("closedOperations", "pendingOperations", "unknownOperations")
            )
        )
        if body["effectState"] == "effective":
            need(
                body["gateway"]["pendingSessions"]
                == body["native"]["pendingOperations"]
                == body["native"]["unknownOperations"]
                == 0
            )
    else:
        raise DataProtocolError()


def validate_response(value):
    fields(
        value,
        {"schemaVersion", "purpose", "boxId", "boxKeyThumbprint", "kind", "issuedAtMs", "body"},
    )
    _base(value, "response")
    token(value["boxId"])
    digest32(value["boxKeyThumbprint"])
    integer(value["issuedAtMs"])
    _response_body(value["kind"], value["body"])
    if "issuedAtMs" in value["body"]:
        need(value["issuedAtMs"] == value["body"]["issuedAtMs"])
    if value["kind"] == "session":
        need(
            value["body"]["authorization"]["boxId"] == value["boxId"]
            and value["body"]["authorization"]["boxKeyThumbprint"] == value["boxKeyThumbprint"]
        )


VALIDATORS = {
    "session": validate_session_payload,
    "session-intent": validate_session_intent_payload,
    "heartbeat": validate_heartbeat_payload,
    "renewal": validate_renewal_payload,
    "close": validate_close_payload,
    "request": validate_request_payload,
    "gateway-request": validate_gateway_request,
    "gateway-lease": validate_gateway_lease,
    "gateway-resources": validate_gateway_resources,
    "gateway-observation": validate_gateway_observation,
    "response": validate_response,
}


def _parse(segment):
    raw = decode(segment)
    need(raw.isascii())
    try:
        value = json.loads(raw)
        need(canonical(value) == raw)
        return value
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise DataProtocolError() from exc


def _decode(proof, kind):
    need(
        kind in VALIDATORS
        and type(proof) is str
        and proof.isascii()
        and len(proof) <= (MAX_RESPONSE_BYTES if kind == "response" else MAX_PROOF_BYTES)
    )
    parts = proof.split(".")
    need(len(parts) == 3)
    need(_parse(parts[0]) == {"alg": "ES256", "typ": TYPES[kind]})
    payload = _parse(parts[1])
    VALIDATORS[kind](payload)
    signature = decode(parts[2], 64)
    return payload, (parts[0] + "." + parts[1]).encode("ascii"), signature


def _sign(payload, key, kind):
    VALIDATORS[kind](payload)
    need(isinstance(key, ec.EllipticCurvePrivateKey) and isinstance(key.curve, ec.SECP256R1))
    source = (
        encode(canonical({"alg": "ES256", "typ": TYPES[kind]})) + "." + encode(canonical(payload))
    )
    need(len(source) + 87 <= (MAX_RESPONSE_BYTES if kind == "response" else MAX_PROOF_BYTES))
    r, s = utils.decode_dss_signature(key.sign(source.encode("ascii"), ec.ECDSA(hashes.SHA256())))
    return source + "." + encode(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


def _verify(proof, key, kind, now_ms=None):
    payload, source, raw = _decode(proof, kind)
    if type(key) is dict:
        key = public_key(key)
    need(isinstance(key, ec.EllipticCurvePublicKey) and isinstance(key.curve, ec.SECP256R1))
    try:
        key.verify(
            utils.encode_dss_signature(
                int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")
            ),
            source,
            ec.ECDSA(hashes.SHA256()),
        )
    except InvalidSignature as exc:
        raise DataProtocolError("LOCAL_DATA_FORBIDDEN") from exc
    if now_ms is not None:
        fresh(payload, now_ms)
    return payload


def decode_session_locator(jws):
    payload = _decode(jws, "session")[0]
    return {key: payload[key] for key in ("bindingId", "gatewayGeneration", "challenge")}


def decode_session_intent_locator(jws):
    payload = _decode(jws, "session-intent")[0]
    return {key: payload[key] for key in ("bindingId", "boxId", "boxKeyThumbprint")}


def verify_session_intent(jws, access_key, *, now_ms):
    value = _verify(jws, access_key, "session-intent", now_ms)
    need(
        public_key_thumbprint(value["channelKey"]) != public_key_thumbprint(access_key),
        "LOCAL_DATA_FORBIDDEN",
    )
    return value


def sign_session_intent(payload, key):
    validate_session_intent_payload(payload)
    need(public_key_thumbprint(payload["channelKey"]) != public_key_thumbprint(public_jwk(key)))
    return _sign(payload, key, "session-intent")


def decode_channel_locator(jws, *, kind):
    need(kind in {"heartbeat", "close", "request", "renewal"})
    payload = _decode(jws, kind)[0]
    return {key: payload[key] for key in ("sessionId", "gatewayGeneration")}


def decode_request_expectations(jws):
    """Unverified, bounded staging expectations; never an admission decision."""
    payload = _decode(jws, "request")[0]
    return {key: payload[key] for key in ("bodySha256", "bodyBytes")}


def verify_session_proof(jws, access_key, *, now_ms):
    value = _verify(jws, access_key, "session", now_ms)
    need(
        public_key_thumbprint(value["channelKey"]) != public_key_thumbprint(access_key),
        "LOCAL_DATA_FORBIDDEN",
    )
    return value


def verify_channel_proof(jws, channel_key, *, kind, now_ms):
    need(kind in {"heartbeat", "close", "request", "renewal"})
    value = _verify(jws, channel_key, kind, now_ms)
    if kind == "renewal":
        need(
            public_key_thumbprint(value["channelKey"]) != public_key_thumbprint(channel_key),
            "LOCAL_DATA_FORBIDDEN",
        )
    return value


def sign_session(payload, key):
    validate_session_payload(payload)
    need(public_key_thumbprint(payload["channelKey"]) != public_key_thumbprint(public_jwk(key)))
    return _sign(payload, key, "session")


def sign_channel(payload, key, *, kind):
    need(kind in {"heartbeat", "close", "request", "renewal"})
    return _sign(payload, key, kind)


def sign_data_response(box_key, *, box_id, kind, body, now_ms):
    return _sign(
        {
            "schemaVersion": 1,
            "purpose": "centuarai.local-data.response",
            "boxId": box_id,
            "boxKeyThumbprint": public_key_thumbprint(public_jwk(box_key)),
            "kind": kind,
            "issuedAtMs": now_ms,
            "body": body,
        },
        box_key,
        "response",
    )


def verify_data_response(jws, box_key, *, box_id, kind, now_ms, expected=None):
    payload = _verify(jws, box_key, "response")
    integer(now_ms)
    need(
        payload["boxId"] == box_id
        and payload["boxKeyThumbprint"] == public_key_thumbprint(box_key)
        and payload["kind"] == kind,
        "LOCAL_DATA_CONTEXT_CHANGED",
    )
    need(payload["issuedAtMs"] <= now_ms, "LOCAL_DATA_SESSION_EXPIRED")
    if kind in {"session", "session-challenge"}:
        fresh(payload["body"], now_ms)
    if kind in {"session", "heartbeat"}:
        need(now_ms < payload["body"]["presenceExpiresAtMs"], "LOCAL_DATA_SESSION_EXPIRED")
    for name, value in (expected or {}).items():
        need(
            name in payload["body"] and canonical(payload["body"][name]) == canonical(value),
            "LOCAL_DATA_CONTEXT_CHANGED",
        )
    return payload


def sign_gateway_request(payload, key):
    return _sign(payload, key, "gateway-request")


def verify_gateway_request(jws, key, now_ms):
    return _verify(jws, key, "gateway-request", now_ms)


def sign_gateway_lease(payload, key):
    return _sign(payload, key, "gateway-lease")


def verify_gateway_lease(jws, key, now_ms):
    return _verify(jws, key, "gateway-lease", now_ms)


def gateway_proof_digest(jws):
    need(type(jws) is str and jws.isascii() and len(jws) <= MAX_PROOF_BYTES)
    return encode(hashlib.sha256(jws.encode("ascii")).digest())


def sign_gateway_resources(payload, key):
    return _sign(payload, key, "gateway-resources")


def verify_gateway_resources(jws, key, now_ms):
    return _verify(jws, key, "gateway-resources", now_ms)


def sign_gateway_observation(payload, key):
    return _sign(payload, key, "gateway-observation")


def verify_gateway_observation(jws, key, now_ms):
    return _verify(jws, key, "gateway-observation", now_ms)
