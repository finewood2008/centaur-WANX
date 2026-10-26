import base64
import os

import pytest
from test_local_ledger import NOW, activate, actor, verified
from test_local_ledger import ledger as _ledger
from test_local_ledger import provisioned as _provisioned
from test_local_ledger_operations import SyntheticProvider

from wanx_bridge import local_backup_io as io
from wanx_bridge import local_management_protocol as wire
from wanx_bridge import local_trust_protocol as evidence

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Private authority requires POSIX")


@pytest.fixture
def provisioned(tmp_path):
    return _provisioned.__wrapped__(tmp_path)


@pytest.fixture
def ledger(provisioned):
    yield from _ledger.__wrapped__(provisioned)


class FixtureIO(SyntheticProvider):
    def __init__(self):
        self.calls = []
        self.bad = False

    def backup_io(self, operation, body, authorization, now):
        self.calls.append((operation, authorization))
        if operation == "targets.list":
            result = {"type": "backup-targets", "targets": []}
        elif operation == "source.begin":
            result = {
                "type": "backup-source-upload",
                "uploadId": "upload:fixture",
                "offset": 0,
                "chunkMaxBytes": io.MAX_CHUNK,
                "archiveMaxBytes": io.MAX_ARCHIVE,
                "expiresAt": now + 3600,
            }
        elif operation == "source.append":
            result = {
                "type": "backup-source-upload-progress",
                "uploadId": body["uploadId"],
                "offset": body["offset"] + len(io.chunk(body["chunkBase64"])),
                "expiresAt": now + 3600,
            }
            if self.bad:
                result["uploadId"] = "upload:another"
        else:
            raise AssertionError("unexpected test operation")
        return {"body": result, "contentBase64": None}


@pytest.mark.parametrize(
    "profiles,resources",
    [
        (["semantica-private-v1"], ["semantica"]),
        (["wanx-personal-v1"], ["clipboard", "space:personal"]),
        (
            ["semantica-private-v1", "wanx-personal-v1"],
            ["clipboard", "semantica", "space:personal"],
        ),
    ],
)
def test_catalog_accepts_only_fixed_profile_resource_mapping(profiles, resources):
    target = {
        "targetId": "local-managed",
        "kind": "local-managed",
        "durability": "same-box",
        "scopeProfiles": profiles,
        "resourceIds": resources,
        "maxArchiveBytes": io.MAX_ARCHIVE,
    }
    io.response_body("targets.list", {"type": "backup-targets", "targets": [target]})
    for bad in (
        {**target, "resourceIds": ["wanx"]},
        {**target, "scopeProfiles": ["arbitrary-profile"]},
        {**target, "scopeProfiles": profiles + profiles},
        {**target, "scopeProfiles": []},
    ):
        with pytest.raises(evidence.BindingProtocolError):
            io.response_body("targets.list", {"type": "backup-targets", "targets": [bad]})


def proof(ledger, operation, body, now, device=None):
    device = device or ledger.root
    challenge = verified(ledger, ledger.authority.auth_challenge_v2(now), "read-challenge")
    value = {
        "schemaVersion": 1,
        "purpose": "centuarai.local-backup.io",
        "boxId": "box:test",
        "boxKeyThumbprint": challenge["context"]["boxKeyThumbprint"],
        "ownershipEpoch": 1,
        "principalSecurityVersion": 1,
        "nonce": challenge["nonce"],
        "issuedAt": now,
        "expiresAt": now + 60,
        "actor": actor(device),
        "operation": operation,
        "bodySha256": wire.digest(body),
    }
    return wire._sign(value, device.access, io.PROOF_TYPE, io.proof_schema), value


def test_fixed_io_requires_current_capability_fresh_nonce_and_exact_body_hash(ledger):
    provider = FixtureIO()
    ledger.authority.configure_operation_provider(provider)
    signed, _ = proof(ledger, "targets.list", {}, NOW + 4)
    with pytest.raises(evidence.BindingProtocolError, match="AUTHORIZATION_DENIED"):
        ledger.authority.backup_io("targets.list", {}, signed, NOW + 4)
    assert provider.calls == []
    activate(ledger, now=NOW + 5)
    signed, value = proof(ledger, "targets.list", {}, NOW + 6)
    result = ledger.authority.backup_io("targets.list", {}, signed, NOW + 6)
    decoded = io.verify_response(
        result,
        ledger.provisioned.bundle["boxKey"],
        box_id="box:test",
        operation="targets.list",
        nonce=value["nonce"],
        request={},
    )
    assert decoded["body"] == {"type": "backup-targets", "targets": []}
    with pytest.raises(evidence.BindingProtocolError, match="CHALLENGE_INVALID"):
        ledger.authority.backup_io("targets.list", {}, signed, NOW + 6)
    assert len(provider.calls) == 1
    signed, _ = proof(ledger, "targets.list", {}, NOW + 7, device=ledger.use)
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.backup_io("targets.list", {}, signed, NOW + 7)
    assert len(provider.calls) == 1


def test_upload_chunks_are_bounded_bound_to_offset_and_current_principal(ledger):
    activate(ledger)
    provider = FixtureIO()
    ledger.authority.configure_operation_provider(provider)
    body = {
        "uploadId": "upload:fixture",
        "offset": 0,
        "chunkBase64": base64.b64encode(b"synthetic ciphertext").decode(),
    }
    signed, value = proof(ledger, "source.append", body, NOW + 11)
    with pytest.raises(evidence.BindingProtocolError, match="CONTEXT_MISMATCH"):
        ledger.authority.backup_io("source.append", {**body, "offset": 1}, signed, NOW + 11)
    assert provider.calls == []
    result = ledger.authority.backup_io("source.append", body, signed, NOW + 11)
    response = io.verify_response(
        result,
        ledger.provisioned.bundle["boxKey"],
        box_id="box:test",
        operation="source.append",
        nonce=value["nonce"],
        request=body,
    )
    assert response["body"]["offset"] == len(b"synthetic ciphertext")
    assert provider.calls[0][1]["principalId"] == ledger.root.payload["principalId"]
    bad = {**body, "chunkBase64": base64.b64encode(bytes(io.MAX_CHUNK + 1)).decode()}
    signed, _ = proof(ledger, "source.append", bad, NOW + 12)
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.backup_io("source.append", bad, signed, NOW + 12)
    assert len(provider.calls) == 1


def test_provider_cannot_sign_a_different_upload_receipt(ledger):
    activate(ledger)
    provider = FixtureIO()
    provider.bad = True
    ledger.authority.configure_operation_provider(provider)
    body = {
        "uploadId": "upload:fixture",
        "offset": 0,
        "chunkBase64": base64.b64encode(b"ciphertext").decode(),
    }
    signed, _ = proof(ledger, "source.append", body, NOW + 11)
    with pytest.raises(evidence.BindingProtocolError):
        ledger.authority.backup_io("source.append", body, signed, NOW + 11)


@pytest.mark.parametrize("malformed", ["YQ", "YQ=", "YQ===", "Y Q==", "-_==", "é", "!!!!"])
def test_chunk_decoder_rejects_noncanonical_or_url_base64(malformed):
    with pytest.raises(evidence.BindingProtocolError):
        io.chunk(malformed)
