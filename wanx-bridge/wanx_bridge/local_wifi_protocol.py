"""Offline BLE Wi-Fi proofs. Validation is not a substitute for current ledger authority."""

from __future__ import annotations

import re

from . import local_management_protocol as wire
from . import local_trust_protocol as evidence

RESOURCE = "network:wifi"
TYPES = {
    kind: "centuarai-local-wifi-" + kind + "+jws"
    for kind in (
        "intent",
        "challenge",
        "session-access",
        "session-receipt",
        "apply",
        "check-receipt",
        "execution-receipt",
        "result-receipt",
    )
}
LIMITS = {
    "intent": 2048,
    "challenge": 8192,
    "session-access": 1024,
    "session-receipt": 8192,
    "apply": 1536,
    "check-receipt": 1024,
    "execution-receipt": 1536,
    "result-receipt": 1024,
}
FIELDS = {
    "intent": {
        "boxId",
        "boxKeyThumbprint",
        "ownershipEpoch",
        "bindingId",
        "clientId",
        "ble",
        "nonce",
    },
    "challenge": {"context", "ble", "challengeId", "intentDigest", "issuedAt", "expiresAt"},
    "session-access": {"challengeDigest", "tokenCiphertextSha256"},
    "session-receipt": {
        "context",
        "ble",
        "sessionId",
        "challengeDigest",
        "tokenCiphertextSha256",
        "applyNonce",
        "issuedAt",
        "expiresAt",
    },
    "apply": {"sessionDigest", "applyNonce", "requestId", "counter", "ciphertextSha256"},
    "check-receipt": {"sessionDigest", "valid", "authorizationVersion", "issuedAt", "expiresAt"},
    "execution-receipt": {
        "sessionDigest",
        "requestId",
        "counter",
        "ciphertextSha256",
        "authorizationVersion",
        "execute",
        "state",
        "issuedAt",
        "expiresAt",
    },
    "result-receipt": {"sessionDigest", "requestId", "outcome", "issuedAt"},
}
CONTEXT = {
    "boxId",
    "boxKeyThumbprint",
    "ownershipEpoch",
    "authorityBootId",
    "authorizationVersion",
    "bindingId",
    "bindingRevision",
    "principalId",
    "principalSecurityVersion",
    "clientId",
    "approvalKeyVersion",
}
BLE = {"pairingSessionId", "challengeCanonicalSha256", "rsaSpkiSha256"}
OUTCOMES = {"succeeded", "failed", "interrupted"}


class LocalWifiError(evidence.BindingProtocolError):
    def __init__(self, code="LOCAL_WIFI_INVALID"):
        self.code = code
        super().__init__(code)


def need(condition, code="LOCAL_WIFI_INVALID"):
    if not condition:
        raise LocalWifiError(code)


def fields(value, expected):
    need(type(value) is dict and set(value) == set(expected))


def hex_digest(value):
    need(type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value) is not None)


def ble(value):
    fields(value, BLE)
    evidence._token(value["pairingSessionId"])
    for key in BLE - {"pairingSessionId"}:
        hex_digest(value[key])


def context(value):
    fields(value, CONTEXT)
    for name in ("boxId", "authorityBootId", "bindingId", "principalId", "clientId"):
        evidence._token(value[name])
    evidence._digest(value["boxKeyThumbprint"])
    for name in CONTEXT - {
        "boxId",
        "authorityBootId",
        "bindingId",
        "principalId",
        "clientId",
        "boxKeyThumbprint",
    }:
        evidence._integer(value[name])


def observed(value):
    fields(value, {"requestId", "counter", "ciphertextSha256"})
    evidence._token(value["requestId"])
    counter = value["counter"]
    need(type(counter) is str and re.fullmatch(r"[1-9][0-9]{0,19}", counter) is not None)
    need(int(counter) <= 2**64 - 1)
    hex_digest(value["ciphertextSha256"])


def validate(kind, value):
    need(kind in FIELDS)
    fields(value, FIELDS[kind] | {"schemaVersion", "purpose"})
    need(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1)
    need(value["purpose"] == "centuarai.local-wifi." + kind + ".v1")
    if "context" in value:
        context(value["context"])
    if "ble" in value:
        ble(value["ble"])
    for name in {
        "boxKeyThumbprint",
        "nonce",
        "challengeId",
        "intentDigest",
        "challengeDigest",
        "sessionId",
        "applyNonce",
        "sessionDigest",
    } & value.keys():
        evidence._digest(value[name])
    for name in {"boxId", "bindingId", "clientId", "requestId"} & value.keys():
        evidence._token(value[name])
    for name in {"ownershipEpoch", "authorizationVersion", "issuedAt", "expiresAt"} & value.keys():
        evidence._integer(value[name])
    if "expiresAt" in value:
        limit = 5 if kind in ("check-receipt", "execution-receipt") else 120
        need(0 < value["expiresAt"] - value["issuedAt"] <= limit)
    if "tokenCiphertextSha256" in value:
        hex_digest(value["tokenCiphertextSha256"])
    if kind in ("apply", "execution-receipt"):
        observed({k: value[k] for k in ("requestId", "counter", "ciphertextSha256")})
    if kind == "check-receipt":
        need(value["valid"] is True)
    if kind == "execution-receipt":
        need(type(value["execute"]) is bool and value["state"] in OUTCOMES | {"consumed"})
        need(not value["execute"] or value["state"] == "consumed")
    if kind == "result-receipt":
        need(value["outcome"] in OUTCOMES)


def payload(kind, **values):
    value = {"schemaVersion": 1, "purpose": "centuarai.local-wifi." + kind + ".v1", **values}
    validate(kind, value)
    return value


def decode(kind, proof):
    need(type(proof) is str and proof.isascii() and len(proof) <= LIMITS[kind])
    try:
        return wire._decode(proof, TYPES[kind], lambda value: validate(kind, value))
    except evidence.BindingProtocolError:
        raise LocalWifiError() from None


def verify(kind, proof, public_key):
    value = decode(kind, proof)
    try:
        evidence._verify(proof, evidence._public_key(public_key))
    except evidence.BindingProtocolError:
        raise LocalWifiError("LOCAL_WIFI_UNAUTHORIZED") from None
    return value


def sign(kind, value, private_key):
    try:
        proof = wire._sign(value, private_key, TYPES[kind], lambda v: validate(kind, v))
        need(len(proof) <= LIMITS[kind])
        return proof
    except evidence.BindingProtocolError:
        raise LocalWifiError() from None


digest = wire.digest
