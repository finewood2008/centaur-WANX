import copy
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from wanx_bridge import local_data_protocol as wire

VECTORS = json.loads(
    (Path(__file__).parents[2] / "contracts/local-trust/data-v1/vectors.json").read_text()
)


def public(name):
    return {key: value for key, value in VECTORS["privateJwks"][name].items() if key != "d"}


def test_protocol_errors_never_echo_unreviewed_exception_text():
    for code in ("database password=synthetic", "LOCAL_DATA_UNKNOWN_PRIVATE_DETAIL", {"detail": 1}):
        error = wire.DataProtocolError(code)
        assert error.code == str(error) == "LOCAL_DATA_INVALID"


@pytest.mark.parametrize("producer", ["pythonProofs", "nodeProofs"])
@pytest.mark.parametrize(
    "kind", ["session", "session-intent", "request", "heartbeat", "close", "renewal"]
)
def test_python_verifies_real_python_and_node_vectors(producer, kind):
    proof = VECTORS[producer][kind]
    if kind == "session-intent":
        result = wire.verify_session_intent(proof, public("access"), now_ms=VECTORS["nowMs"])
    elif kind == "session":
        result = wire.verify_session_proof(proof, public("access"), now_ms=VECTORS["nowMs"])
    else:
        result = wire.verify_channel_proof(
            proof, public("channel"), kind=kind, now_ms=VECTORS["nowMs"]
        )
    assert result == VECTORS["payloads"][kind]


@pytest.mark.parametrize("kind", ["session-challenge", "session", "heartbeat", "closed", "effect"])
def test_response_vectors(kind):
    item = VECTORS["responses"][kind]
    value = wire.verify_data_response(
        item["jws"],
        public("box"),
        box_id="box:vector",
        kind=kind,
        now_ms=VECTORS["nowMs"],
        expected=item["body"],
    )
    assert value["body"] == item["body"]


def test_shared_gateway_and_lease_vectors():
    assert (
        wire.verify_gateway_request(VECTORS["gateway"]["jws"], public("gateway"), VECTORS["nowMs"])
        == VECTORS["gateway"]["payload"]
    )
    assert (
        wire.verify_gateway_lease(VECTORS["lease"]["jws"], public("gateway"), VECTORS["nowMs"])
        == VECTORS["lease"]["payload"]
    )
    assert (
        wire.verify_gateway_resources(
            VECTORS["resources"]["jws"], public("gateway"), VECTORS["nowMs"]
        )
        == VECTORS["resources"]["payload"]
    )
    assert (
        wire.verify_gateway_observation(
            VECTORS["observation"]["jws"], public("gateway"), VECTORS["nowMs"]
        )
        == VECTORS["observation"]["payload"]
    )


@pytest.mark.parametrize(
    "kind",
    [
        "session",
        "session-intent",
        "request",
        "heartbeat",
        "renewal",
        "close",
        "gateway-request",
        "gateway-lease",
        "gateway-resources",
        "gateway-observation",
    ],
)
def test_every_field_wrong_container_or_missing_is_fixed_protocol_error(kind):
    source = (
        VECTORS["payloads"].get(kind)
        or VECTORS[
            {
                "gateway-request": "gateway",
                "gateway-lease": "lease",
                "gateway-resources": "resources",
                "gateway-observation": "observation",
            }[kind]
        ]["payload"]
    )
    validator = wire.VALIDATORS[kind]
    for name in source:
        bad = copy.deepcopy(source)
        del bad[name]
        with pytest.raises(wire.DataProtocolError):
            validator(bad)
        for malformed in ([], {}, True):
            if source[name] == malformed:
                continue
            bad = copy.deepcopy(source)
            bad[name] = malformed
            with pytest.raises(wire.DataProtocolError):
                validator(bad)
    bad = {**source, "unknown": None}
    with pytest.raises(wire.DataProtocolError):
        validator(bad)


@pytest.mark.parametrize(
    "path",
    [
        "//elsewhere",
        "/a/../b",
        "/a/./b",
        "/a//b",
        "/a%2fb",
        "/a%252fb",
        "/%41",
        "/a\\b",
        "/a#fragment",
        "/a?token=x",
        "/a?%61ccess_token=x",
        "/a?AUTHORIZATION=x",
        "/a?data_proof=x",
        "/a?gateway_proof=x",
        "/a%GG",
        "/%ff",
        "/a\nb",
    ],
)
def test_ambiguous_and_credential_targets_rejected(path):
    with pytest.raises(wire.DataProtocolError):
        wire.validate_target(path)


@pytest.mark.parametrize(
    "path", ["/", "/api/files/abc?offset=1&length=8", "/api/%E4%BD%A0", "/api/files?name=a%20b"]
)
def test_exact_targets_accepted(path):
    wire.validate_target(path)


def test_no_algorithm_confusion_unknown_signature_key_or_wrong_purpose():
    vector = VECTORS["nodeProofs"]["request"]
    with pytest.raises(wire.DataProtocolError):
        wire.verify_channel_proof(vector, public("access"), kind="request", now_ms=VECTORS["nowMs"])
    with pytest.raises(wire.DataProtocolError):
        wire.verify_channel_proof(
            vector, public("channel"), kind="heartbeat", now_ms=VECTORS["nowMs"]
        )
    for header in (
        {"alg": "none", "typ": wire.TYPES["request"]},
        {"alg": "ES256", "typ": wire.TYPES["request"], "jwk": public("channel")},
    ):
        bad = wire.encode(wire.canonical(header)) + "." + ".".join(vector.split(".")[1:])
        with pytest.raises(wire.DataProtocolError):
            wire.verify_channel_proof(
                bad, public("channel"), kind="request", now_ms=VECTORS["nowMs"]
            )


def test_noncanonical_json_duplicate_fields_padding_and_time_boundary():
    proof = VECTORS["nodeProofs"]["heartbeat"]
    parts = proof.split(".")
    raw = wire.decode(parts[1])
    for changed in (
        b" " + raw,
        raw[:-1] + b',"sequence":1}',
        raw.replace(b'"sequence":1', b'"sequence":1.0'),
    ):
        altered = parts[0] + "." + wire.encode(changed) + "." + parts[2]
        with pytest.raises(wire.DataProtocolError):
            wire.verify_channel_proof(
                altered, public("channel"), kind="heartbeat", now_ms=VECTORS["nowMs"]
            )
    with pytest.raises(wire.DataProtocolError):
        wire.verify_channel_proof(
            proof + "=", public("channel"), kind="heartbeat", now_ms=VECTORS["nowMs"]
        )
    for now in (VECTORS["nowMs"] - 1, VECTORS["nowMs"] + 3000):
        with pytest.raises(wire.DataProtocolError):
            wire.verify_channel_proof(proof, public("channel"), kind="heartbeat", now_ms=now)


def test_channel_cannot_reuse_long_term_access_key():
    payload = copy.deepcopy(VECTORS["payloads"]["session"])
    payload["channelKey"] = public("access")
    key = ec.derive_private_key(2, ec.SECP256R1())
    with pytest.raises(wire.DataProtocolError):
        wire.sign_session(payload, key)


def test_twelve_selector_headers_and_response_expected_context():
    headers = VECTORS["payloads"]["request"]["headers"]
    assert len(headers) == 12 and headers["spaceLink"] and headers["contentSha256"]
    for name in ("spaceLink", "contentSha256"):
        bad = copy.deepcopy(headers)
        del bad[name]
        with pytest.raises(wire.DataProtocolError):
            wire.validate_headers(bad)
    with pytest.raises(wire.DataProtocolError):
        wire.verify_data_response(
            VECTORS["responses"]["session"]["jws"],
            public("box"),
            box_id="box:vector",
            kind="session",
            now_ms=VECTORS["nowMs"],
            expected={"applicationId": "other-app"},
        )
