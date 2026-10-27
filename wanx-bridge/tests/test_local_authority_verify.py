"""Offline verifier must inspect the complete ledger without advancing it."""

import json
import os
import sqlite3

import pytest
from test_local_authority_store import NOW, claim
from test_local_authority_store import provisioned as _provisioned

from wanx_bridge import local_authority_store as store
from wanx_bridge import local_trust_protocol as evidence
from wanx_bridge.local_trust_config import LocalTrustError
from wanx_bridge.local_trust_runtime import runtime_lock

pytestmark = pytest.mark.skipif(os.name != "posix", reason="POSIX private authority and flock")


@pytest.fixture
def provisioned(tmp_path):
    return _provisioned.__wrapped__(tmp_path)


def files(directory):
    return {
        path.name: (path.read_bytes(), path.stat().st_mtime_ns, path.stat().st_mode)
        for path in directory.iterdir()
        if path.is_file()
    }


@pytest.mark.parametrize("claimed", [False, True])
def test_verification_keeps_every_private_file_and_logical_snapshot_unchanged(provisioned, claimed):
    if claimed:
        authority = store.LocalTrustAuthority(provisioned.directory, boot_id="prior-boot")
        claim(provisioned, authority)
        authority.close()
    store.migrate_authority_v2(provisioned.directory, now=NOW + 3)
    before = files(provisioned.directory)
    with sqlite3.connect(provisioned.directory / "local-authority.sqlite3") as db:
        logical = list(db.iterdump())
    result = store.verify_authority_v2(provisioned.directory)
    assert result["schemaVersion"] == 2
    assert result["boxId"] == provisioned.bundle["boxId"]
    assert "claimSecret" not in json.dumps(result)
    assert files(provisioned.directory) == before
    with sqlite3.connect(provisioned.directory / "local-authority.sqlite3") as db:
        assert list(db.iterdump()) == logical
    assert store.verify_authority_v2(provisioned.directory) == result
    assert files(provisioned.directory) == before


@pytest.mark.parametrize("damage", ["seal", "ack", "floor", "journal", "schema"])
def test_verification_rejects_damaged_authority_without_repairing(provisioned, damage):
    store.migrate_authority_v2(provisioned.directory, now=NOW + 3)
    directory = provisioned.directory
    if damage in ("seal", "floor"):
        path = directory / (store.SEAL if damage == "seal" else "local-trust-required.json")
        path.write_bytes(b"{}")
    elif damage == "journal":
        path = directory / "local-authority.sqlite3-journal"
        path.write_bytes(b"unfinished-transaction")
        path.chmod(0o600)
    else:
        with sqlite3.connect(directory / "local-authority.sqlite3") as db:
            if damage == "ack":
                db.execute("DROP TRIGGER ledger_events_no_update")
                db.execute("UPDATE ledger_events SET ack='invalid.signature'")
            else:
                db.execute("PRAGMA user_version=9")
    before = files(directory)
    with pytest.raises(evidence.BindingProtocolError):
        store.verify_authority_v2(directory)
    assert files(directory) == before


def test_verification_rejects_unmigrated_floor_and_live_runtime(provisioned):
    directory = provisioned.directory
    floor = directory / "local-trust-required.json"
    floor.write_bytes(b"{}")
    floor.chmod(0o600)
    with runtime_lock(directory):
        before = files(directory)
        with pytest.raises(LocalTrustError, match="ALREADY_RUNNING"):
            store.verify_authority_v2(directory)
        assert files(directory) == before
    before = files(directory)
    with pytest.raises(evidence.BindingProtocolError, match="MIGRATION_REQUIRED"):
        store.verify_authority_v2(directory)
    assert files(directory) == before
