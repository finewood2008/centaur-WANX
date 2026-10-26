"""Synthetic offline evidence tests; no enrollment, user verification or runtime routes."""

import base64
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

from wanx_bridge.local_trust_protocol import (
    BindingProtocolError,
    canonical_request,
    decode_cancel_payload,
    public_key_thumbprint,
    request_digest,
    sign_approval,
    sign_cancel,
    sign_request,
    validate_box_context,
    validate_request_context,
    verify_approval_signature,
    verify_cancel_proof,
    verify_request_proof,
)

VECTORS = Path(__file__).resolve().parents[2] / "contracts" / "local-trust" / "v1" / "vectors.json"


def b64(raw):
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def jwk(key):
    numbers = key.public_key().public_numbers()
    return {
        "crv": "P-256",
        "kty": "EC",
        "x": b64(numbers.x.to_bytes(32, "big")),
        "y": b64(numbers.y.to_bytes(32, "big")),
    }


def compact(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def wire(payload, key, header=None):
    """Independently sign adversarial wire bytes without production validators."""
    if header is None:
        header = b'{"alg":"ES256","typ":"centuarai-device-binding-request+jws"}'
    signing_input = b64(header) + "." + b64(payload)
    der = key.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256()))
    r, s = utils.decode_dss_signature(der)
    return signing_input + "." + b64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


@pytest.fixture
def vector():
    return json.loads(VECTORS.read_text())


@pytest.fixture
def sample(vector):
    access = ec.generate_private_key(ec.SECP256R1())
    manager_access = ec.generate_private_key(ec.SECP256R1())
    approval = ec.generate_private_key(ec.SECP256R1())
    vector["request"]["accessKey"] = jwk(access)
    manager = vector["trustedState"]["bindings"][0]
    manager["accessKey"], manager["approvalKey"] = jwk(manager_access), jwk(approval)
    return SimpleNamespace(
        request=vector["request"],
        context=vector["context"],
        state=vector["trustedState"],
        approval=vector["approval"],
        cancel=vector["cancel"],
        now=vector["now"],
        access_key=access,
        manager_access_key=manager_access,
        approval_key=approval,
    )


def evidence(sample):
    approval = {**sample.approval, "requestDigest": request_digest(sample.request)}
    return sign_approval(approval, sample.approval_key), sign_request(
        sample.request, sample.access_key
    )


def verify(sample):
    approval, request = evidence(sample)
    return verify_approval_signature(approval, request, sample.state, sample.now)


def history(sample, **changes):
    row = copy.deepcopy(sample.state["bindings"][0])
    row.update(
        bindingId="binding:history",
        clientId="client:history",
        status="revoked",
        accessKey=jwk(ec.generate_private_key(ec.SECP256R1())),
        approvalKey=None,
        approvalKeyVersion=None,
        canApproveUseDevices=False,
    )
    row.update(changes)
    sample.state["bindings"].append(row)
    return row


def test_independent_fixed_vectors(vector):
    request = vector["request"]
    assert canonical_request(request) == vector["canonicalRequest"].encode("ascii")
    assert request_digest(request) == vector["requestDigest"]
    assert public_key_thumbprint(request["accessKey"]) == vector["accessKeyThumbprint"]
    assert verify_request_proof(vector["proofs"]["request"]) == request
    assert validate_request_context(request, vector["context"], vector["now"]) is None
    assert (
        verify_approval_signature(
            vector["proofs"]["approval"],
            vector["proofs"]["request"],
            vector["trustedState"],
            vector["now"],
        )
        == vector["approval"]
    )
    assert decode_cancel_payload(vector["proofs"]["cancel"]) == vector["cancel"]
    assert (
        verify_cancel_proof(vector["proofs"]["cancel"], request, vector["now"]) == vector["cancel"]
    )


@pytest.mark.parametrize("format", ["object", "pem_bytes", "pem_string"])
def test_signing_helpers_emit_standard_es256_payloads(sample, format):
    key = sample.access_key
    if format != "object":
        key = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        if format == "pem_string":
            key = key.decode("ascii")
    proof = sign_request(sample.request, key)
    result = jwt.api_jws.decode_complete(
        proof, sample.access_key.public_key(), algorithms=["ES256"]
    )
    assert result["header"] == {"alg": "ES256", "typ": "centuarai-device-binding-request+jws"}
    assert result["payload"] == canonical_request(sample.request)
    assert verify_request_proof(proof) == sample.request


def test_valid_approval_is_only_evidence_and_does_not_mutate_roster(sample):
    before = copy.deepcopy((sample.request, sample.state))
    approved = verify(sample)
    assert approved == {**sample.approval, "requestDigest": request_digest(sample.request)}
    assert (sample.request, sample.state) == before
    assert "session" not in approved and "binding" not in approved and "verified" not in approved


@pytest.mark.parametrize(
    "field,value",
    [
        ("schemaVersion", True),
        ("schemaVersion", 2),
        ("schemaVersion", 1.0),
        ("purpose", "cloud-login"),
        ("boxId", "box/other"),
        ("boxId", "盒子"),
        ("ownershipEpoch", 0),
        ("ownershipEpoch", 9007199254740992),
        ("rosterVersion", True),
        ("policyVersion", -1),
        ("requestId", "short"),
        ("challenge", "A" * 44),
        ("principalId", "alice smith"),
        ("clientId", "a" * 129),
        ("role", "manage"),
        ("delegationAllowed", True),
        ("delegationAllowed", 0),
        ("approvalKey", {}),
        ("grantExpiresAt", 1),
        ("grantExpiresAt", False),
        ("issuedAt", -0.0),
        ("expiresAt", 9007199254740992),
    ],
)
def test_request_schema_rejects_unsupported_or_ambiguous_authority(sample, field, value):
    sample.request[field] = value
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        canonical_request(sample.request)


@pytest.mark.parametrize(
    "change",
    [
        "unknown",
        "missing_null",
        "zero_window",
        "long_window",
        "empty_grants",
        "duplicate_resource",
        "unsorted_resource",
        "duplicate_action",
        "unsorted_action",
        "unknown_action",
        "extra_grant_field",
        "too_many_grants",
    ],
)
def test_request_schema_never_repairs_or_defaults_fields(sample, change):
    request = sample.request
    if change == "unknown":
        request["verified"] = True
    elif change == "missing_null":
        del request["approvalKey"]
    elif change == "zero_window":
        request["expiresAt"] = request["issuedAt"]
    elif change == "long_window":
        request["expiresAt"] = request["issuedAt"] + 301
    elif change == "empty_grants":
        request["grants"] = []
    elif change == "duplicate_resource":
        request["grants"] *= 2
    elif change == "unsorted_resource":
        request["grants"] = [{"resourceId": x, "actions": ["read"]} for x in ("z", "a")]
    elif change == "duplicate_action":
        request["grants"][0]["actions"] = ["read", "read"]
    elif change == "unsorted_action":
        request["grants"][0]["actions"] = ["write", "read"]
    elif change == "unknown_action":
        request["grants"][0]["actions"] = ["admin"]
    elif change == "extra_grant_field":
        request["grants"][0]["futureResources"] = True
    else:
        request["grants"] = [
            {"resourceId": f"resource:{x:02d}", "actions": ["read"]} for x in range(17)
        ]
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        sign_request(request, sample.access_key)


@pytest.mark.parametrize(
    "change", ["private", "metadata", "curve", "point", "coordinate", "padded"]
)
def test_public_jwk_is_exact_canonical_valid_point(sample, change):
    value = sample.request["accessKey"]
    if change == "private":
        value["d"] = b64(bytes(32))
    elif change == "metadata":
        value["kid"] = "attacker-selected"
    elif change == "curve":
        value["crv"] = "P-384"
    elif change == "point":
        value["x"] = value["y"] = b64(bytes(32))
    elif change == "coordinate":
        value["x"] = b64(bytes(31))
    else:
        value["x"] += "="
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        public_key_thumbprint(value)


@pytest.mark.parametrize(
    "raw",
    [
        b'{"alg":"ES256", "typ":"centuarai-device-binding-request+jws"}',
        b'{"typ":"centuarai-device-binding-request+jws","alg":"ES256"}',
        b'{"alg":"ES256","alg":"ES256","typ":"centuarai-device-binding-request+jws"}',
        b'{"alg":"none","typ":"centuarai-device-binding-request+jws"}',
        b'{"alg":"ES256","kid":"attacker","typ":"centuarai-device-binding-request+jws"}',
        b'{"alg":"ES256","typ":"centuarai-device-binding-approval+jws"}',
    ],
)
def test_signed_noncanonical_or_wrong_headers_are_rejected(sample, raw):
    proof = wire(canonical_request(sample.request), sample.access_key, raw)
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        verify_request_proof(proof)


@pytest.mark.parametrize(
    "change", ["space", "order", "duplicate", "escaped_ascii", "float", "negative_zero"]
)
def test_even_authentically_signed_noncanonical_payload_is_rejected(sample, change):
    raw = canonical_request(sample.request)
    if change == "space":
        raw = b" " + raw
    elif change == "order":
        raw = json.dumps(
            dict(reversed(list(sample.request.items()))), separators=(",", ":")
        ).encode()
    elif change == "duplicate":
        raw = b'{"schemaVersion":1,' + raw[1:]
    elif change == "escaped_ascii":
        raw = raw.replace(b'"boxId"', b'"\\u0062oxId"')
    elif change == "float":
        raw = raw.replace(b'"ownershipEpoch":2', b'"ownershipEpoch":2.0')
    else:
        raw = raw.replace(b'"ownershipEpoch":2', b'"ownershipEpoch":-0')
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        verify_request_proof(wire(raw, sample.access_key))


@pytest.mark.parametrize(
    "change", ["padded", "noncanonical_bits", "der", "short", "oversized", "unicode"]
)
def test_jws_base64url_signature_format_and_size(sample, change):
    proof = sign_request(sample.request, sample.access_key)
    parts = proof.split(".")
    if change == "padded":
        parts[1] += "="
    elif change == "noncanonical_bits":
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        parts[2] = parts[2][:-1] + alphabet[alphabet.index(parts[2][-1]) + 1]
    elif change == "der":
        parts[2] = b64(sample.access_key.sign(b"test", ec.ECDSA(hashes.SHA256())))
    elif change == "short":
        parts[2] = b64(bytes(63))
    elif change == "oversized":
        parts[1] = "A" * 16384
    else:
        parts[0] += "é"
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        verify_request_proof(".".join(parts))


def test_possession_proof_rejects_wrong_private_key_and_field_substitution(sample):
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        sign_request(sample.request, sample.approval_key)
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_SIGNATURE_INVALID"):
        verify_request_proof(wire(canonical_request(sample.request), sample.approval_key))
    proof = sign_request(sample.request, sample.access_key).split(".")
    changed = {**sample.request, "clientId": "client:substituted"}
    proof[1] = b64(canonical_request(changed))
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_SIGNATURE_INVALID"):
        verify_request_proof(".".join(proof))
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        sign_request(sample.request, ec.generate_private_key(ec.SECP384R1()))


def test_proof_validation_alone_does_not_claim_freshness(sample):
    proof = sign_request(sample.request, sample.access_key)
    assert verify_request_proof(proof) == sample.request
    for now in (sample.request["issuedAt"] - 1, sample.request["expiresAt"]):
        with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_EXPIRED"):
            validate_request_context(sample.request, sample.context, now)
    assert validate_request_context(sample.request, sample.context, sample.now) is None


@pytest.mark.parametrize(
    "field",
    [
        "boxId",
        "boxKeyThumbprint",
        "ownershipEpoch",
        "rosterVersion",
        "rosterDigest",
        "policyVersion",
        "challenge",
    ],
)
def test_every_trusted_context_field_must_match(sample, field):
    value = sample.context[field]
    sample.context[field] = (
        value + 1 if type(value) is int else ("box:changed" if field == "boxId" else b64(bytes(32)))
    )
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_CONTEXT_MISMATCH"):
        validate_request_context(sample.request, sample.context, sample.now)


@pytest.mark.parametrize(
    "now",
    [
        True,
        False,
        None,
        float("nan"),
        float("inf"),
        float("-inf"),
        0,
        -1,
        9007199254740992,
        1792886420.0,
        1792886420.5,
    ],
)
def test_bad_local_clock_never_passes(sample, now):
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        validate_request_context(sample.request, sample.context, now)
    approval, request = evidence(sample)
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        verify_approval_signature(approval, request, sample.state, now)
    cancellation = {**sample.cancel, "requestDigest": request_digest(sample.request)}
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        verify_cancel_proof(sign_cancel(cancellation, sample.access_key), sample.request, now)


def test_box_context_helper_does_not_accept_roster_or_cloud_fields(sample):
    box = {key: value for key, value in sample.context.items() if key != "challenge"}
    assert validate_box_context(box) is None
    for extra in ("challenge", "cloudToken", "bindings"):
        with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
            validate_box_context({**box, extra: "untrusted"})


@pytest.mark.parametrize(
    "field,value",
    [
        ("role", "use"),
        ("status", "suspended"),
        ("status", "revoked"),
        ("canApproveUseDevices", False),
        ("principalId", "principal:other"),
        ("approvalKeyVersion", 2),
        ("establishedAt", 1792886401),
        ("establishedVersion", 6),
    ],
)
def test_current_qualified_same_principal_manager_is_required(sample, field, value):
    sample.state["bindings"][0][field] = value
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_APPROVAL_FORBIDDEN"):
        verify(sample)


def test_empty_roster_unknown_manager_and_missing_approval_key_cannot_bootstrap(sample):
    initial = copy.deepcopy(sample.state)
    sample.state["bindings"] = []
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_APPROVAL_FORBIDDEN"):
        verify(sample)
    sample.state = initial
    sample.approval["approverBindingId"] = sample.request["clientId"]
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_APPROVAL_FORBIDDEN"):
        verify(sample)
    sample.approval["approverBindingId"] = initial["bindings"][0]["bindingId"]
    initial["bindings"][0]["approvalKey"] = initial["bindings"][0]["approvalKeyVersion"] = None
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_APPROVAL_FORBIDDEN"):
        verify(sample)


def test_access_key_or_applicant_signature_cannot_substitute_for_approval_key(sample):
    approval = {**sample.approval, "requestDigest": request_digest(sample.request)}
    request = sign_request(sample.request, sample.access_key)
    for key in (sample.manager_access_key, sample.access_key):
        with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_SIGNATURE_INVALID"):
            verify_approval_signature(
                sign_approval(approval, key), request, sample.state, sample.now
            )


@pytest.mark.parametrize("field", ["bindingId", "clientId", "accessKey", "approvalKey"])
def test_conflicting_roster_history_is_rejected_as_a_whole(sample, field):
    duplicate = history(sample)
    current = sample.state["bindings"][0]
    duplicate[field] = copy.deepcopy(current[field])
    if field == "approvalKey":
        duplicate["approvalKeyVersion"] = 1
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        verify(sample)
    sample.state["bindings"].reverse()
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        verify(sample)


def test_same_key_across_access_approval_and_history_is_invalid(sample):
    current = sample.state["bindings"][0]
    current["approvalKey"] = current["accessKey"]
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        verify(sample)


@pytest.mark.parametrize("status", ["active", "suspended", "revoked"])
@pytest.mark.parametrize("field", ["accessKey", "approvalKey"])
def test_new_key_cannot_reuse_any_historical_key(sample, status, field):
    row = history(sample, status=status)
    row[field] = sample.request["accessKey"]
    if field == "approvalKey":
        row["approvalKeyVersion"] = 1
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_KEY_REUSE"):
        verify(sample)


def test_new_client_cannot_reuse_revoked_history(sample):
    history(sample, clientId=sample.request["clientId"])
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_CLIENT_REUSE"):
        verify(sample)


def test_client_and_key_reuse_rejection_is_independent_of_roster_order(sample):
    history(sample, accessKey=sample.request["accessKey"])
    history(sample, bindingId="binding:second-history", clientId=sample.request["clientId"])
    for bindings in (sample.state["bindings"], list(reversed(sample.state["bindings"]))):
        sample.state["bindings"] = bindings
        with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_CLIENT_REUSE"):
            verify(sample)


@pytest.mark.parametrize("offset", [0, 1])
def test_approval_with_empty_or_reversed_window_is_invalid_before_signing(sample, offset):
    approval = {**sample.approval, "requestDigest": request_digest(sample.request)}
    approval["approvedAt"] = approval["expiresAt"] + offset
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        sign_approval(approval, sample.approval_key)
    proof = wire(
        compact(approval),
        sample.approval_key,
        compact({"alg": "ES256", "typ": "centuarai-device-binding-approval+jws"}),
    )
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        verify_approval_signature(
            proof, sign_request(sample.request, sample.access_key), sample.state, sample.now
        )


@pytest.mark.parametrize(
    "change", ["extra_field", "missing_expiry", "bad_bool", "private_jwk", "bad_point"]
)
def test_malformed_local_state_never_becomes_authority(sample, change):
    row = sample.state["bindings"][0]
    if change == "extra_field":
        sample.state["cloudGrant"] = "signed-by-platform"
    elif change == "missing_expiry":
        del row["delegationExpiresAt"]
    elif change == "bad_bool":
        row["canApproveUseDevices"] = 1
    elif change == "private_jwk":
        row["approvalKey"]["d"] = b64(bytes(32))
    else:
        row["accessKey"]["x"] = row["accessKey"]["y"] = b64(bytes(32))
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        verify(sample)


@pytest.mark.parametrize(
    "field", ["ownershipEpoch", "rosterVersion", "policyVersion", "rosterDigest"]
)
def test_approval_cannot_be_applied_to_changed_current_state(sample, field):
    sample.state[field] = (
        (sample.state[field] + 1) if type(sample.state[field]) is int else b64(bytes(32))
    )
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_CONTEXT_MISMATCH"):
        verify(sample)


@pytest.mark.parametrize(
    "field", ["clientId", "principalId", "requestId", "challenge", "grantExpiresAt", "grants"]
)
def test_approval_covers_all_requested_authority_not_just_request_id(sample, field):
    approval_jws, _ = evidence(sample)
    if field in ("requestId", "challenge"):
        sample.request[field] = b64(bytes(32))
    elif field == "grantExpiresAt":
        sample.request[field] += 1
    elif field == "grants":
        sample.request["grants"][0]["actions"] = ["read"]
    else:
        sample.request[field] += ":changed"
    changed_request = sign_request(sample.request, sample.access_key)
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_CONTEXT_MISMATCH"):
        verify_approval_signature(approval_jws, changed_request, sample.state, sample.now)


@pytest.mark.parametrize("field", ["expiresAt", "delegationExpiresAt"])
def test_approver_and_delegation_must_still_be_unexpired(sample, field):
    sample.state["bindings"][0][field] = sample.now
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_EXPIRED"):
        verify(sample)


@pytest.mark.parametrize("field", ["expiresAt", "delegationExpiresAt"])
@pytest.mark.parametrize("unlimited", [False, True])
def test_lifetime_cannot_exceed_either_delegation_bound(sample, field, unlimited):
    sample.state["bindings"][0][field] = sample.request["grantExpiresAt"] - 1
    if unlimited:
        sample.request["grantExpiresAt"] = None
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_LIFETIME_EXCEEDED"):
        verify(sample)


def test_exact_scope_and_earliest_finite_lifetime_subset_can_be_approved(sample):
    manager = sample.state["bindings"][0]
    deadline = sample.request["grantExpiresAt"]
    manager["expiresAt"], manager["delegationExpiresAt"] = deadline + 1, deadline
    sample.request["grants"][0]["actions"] = ["read"]
    assert verify(sample)["requestDigest"] == request_digest(sample.request)


@pytest.mark.parametrize(
    "delegable",
    [
        [],
        [{"resourceId": "space:other", "actions": ["read", "write"]}],
        [{"resourceId": "space:personal", "actions": ["read"]}],
    ],
)
def test_scope_or_action_escalation_is_rejected(sample, delegable):
    sample.state["bindings"][0]["delegableGrants"] = delegable
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_SCOPE_EXCEEDED"):
        verify(sample)


@pytest.mark.parametrize(
    "change", ["before_request", "future_approval", "after_request", "deadline"]
)
def test_approval_time_is_bounded_by_request_and_current_clock(sample, change):
    if change == "before_request":
        sample.approval["approvedAt"] = sample.request["issuedAt"] - 1
    elif change == "future_approval":
        sample.approval["approvedAt"] = sample.now + 1
    elif change == "after_request":
        sample.approval["expiresAt"] = sample.request["expiresAt"] + 1
    else:
        sample.now = sample.approval["expiresAt"]
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_EXPIRED"):
        verify(sample)


def test_cancel_decoder_is_unverified_and_cannot_authorize_with_wrong_key(sample):
    cancellation = {**sample.cancel, "requestDigest": request_digest(sample.request)}
    wrong = sign_cancel(cancellation, sample.approval_key)
    assert decode_cancel_payload(wrong) == cancellation
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_SIGNATURE_INVALID"):
        verify_cancel_proof(wrong, sample.request, sample.now)
    correct = sign_cancel(cancellation, sample.access_key)
    assert verify_cancel_proof(correct, sample.request, sample.now) == cancellation


@pytest.mark.parametrize("change", ["request_id", "digest", "future", "expired", "unknown_field"])
def test_cancel_is_bound_to_saved_request_and_its_own_fresh_window(sample, change):
    cancellation = {**sample.cancel, "requestDigest": request_digest(sample.request)}
    if change == "request_id":
        cancellation["requestId"] = b64(bytes(32))
    elif change == "digest":
        cancellation["requestDigest"] = b64(bytes(32))
    elif change == "future":
        cancellation["issuedAt"] = sample.now + 1
    elif change == "expired":
        sample.now = cancellation["expiresAt"]
    else:
        cancellation["newRole"] = "manage"
    proof = wire(
        compact(cancellation),
        sample.access_key,
        b'{"alg":"ES256","typ":"centuarai-device-binding-cancel+jws"}',
    )
    with pytest.raises(BindingProtocolError):
        verify_cancel_proof(proof, sample.request, sample.now)


def test_future_unlimited_grant_is_explicit_only(sample):
    sample.request["grantExpiresAt"] = None
    assert verify(sample)["requestDigest"] == request_digest(sample.request)
    del sample.request["grantExpiresAt"]
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        canonical_request(sample.request)
