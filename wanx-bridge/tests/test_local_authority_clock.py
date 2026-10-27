"""Clock observations survive a denied operation without restoring its writes."""

import copy
import os

import pytest
from test_local_authority_store import NOW
from test_local_authority_store import provisioned as _provisioned

from wanx_bridge import local_authority_store as store
from wanx_bridge.local_trust_protocol import BindingProtocolError

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Private SQLite authority")


@pytest.fixture
def authority(tmp_path):
    provisioned = _provisioned.__wrapped__(tmp_path)
    store.migrate_authority_v2(provisioned.directory, now=NOW + 3)
    value = store.LocalTrustAuthority(provisioned.directory, boot_id="clock:fixture")
    try:
        yield value
    finally:
        value.close()


def test_denied_operation_persists_observed_time_without_resurrecting_metadata(authority):
    before = copy.deepcopy(authority._meta())
    callbacks = []
    with pytest.raises(BindingProtocolError, match="FIXTURE_DENIED"):
        with authority._transaction(NOW + 10, observed_now=lambda: NOW + 20) as meta:
            meta["rosterVersion"] += 100
            meta["ownership"]["ownerPrincipalId"] = "must-not-be-restored"
            authority._save_meta(meta)
            authority._db.execute("INSERT INTO retired_boots VALUES ('rolled-back-boot')")
            authority._after_commit(lambda: callbacks.append("must-not-run"))
            raise BindingProtocolError("FIXTURE_DENIED")
    assert authority._meta() == {**before, "lastSeenNow": NOW + 20}
    assert (
        authority._db.execute(
            "SELECT 1 FROM retired_boots WHERE boot_id='rolled-back-boot'"
        ).fetchone()
        is None
    )
    assert callbacks == []
    with pytest.raises(BindingProtocolError, match="CLOCK_ROLLBACK"):
        with authority._transaction(NOW + 19):
            pytest.fail("rolled-back wall clock entered an operation")
    assert authority._meta()["lastSeenNow"] == NOW + 20


def test_successful_operation_and_after_commit_callback_keep_the_observed_highwater(authority):
    observed = []
    with authority._transaction(NOW + 10, observed_now=lambda: NOW + 20) as meta:
        # Only the operation owns its other metadata changes. A clock merge
        # must not replace them with the pre-operation snapshot.
        meta["policyVersion"] += 1
        authority._save_meta(meta)
        authority._db.execute("INSERT INTO retired_boots VALUES ('committed-boot')")
        authority._after_commit(lambda: observed.append(copy.deepcopy(authority._meta())))
    assert authority._meta()["policyVersion"] == 2
    assert authority._meta()["lastSeenNow"] == NOW + 20
    assert (
        authority._db.execute(
            "SELECT 1 FROM retired_boots WHERE boot_id='committed-boot'"
        ).fetchone()
        is not None
    )
    assert observed == [authority._meta()]


def test_observed_hook_cannot_lower_the_existing_clock_floor(authority):
    with authority._transaction(NOW + 10, observed_now=lambda: NOW + 9):
        pass
    assert authority._meta()["lastSeenNow"] == NOW + 10


@pytest.mark.parametrize("value", [True, -1, 1.5, "20", None])
def test_invalid_observed_clock_rolls_back_the_transaction(authority, value):
    before = copy.deepcopy(authority._meta())
    with pytest.raises(BindingProtocolError):
        with authority._transaction(NOW + 10, observed_now=lambda: value) as meta:
            meta["policyVersion"] += 1
            authority._save_meta(meta)
    assert authority._meta() == before


def test_default_transaction_preserves_denial_and_unexpected_error_semantics(authority):
    before = copy.deepcopy(authority._meta())
    with pytest.raises(BindingProtocolError, match="FIXTURE_DENIED"):
        with authority._transaction(NOW + 10) as meta:
            meta["policyVersion"] += 1
            authority._save_meta(meta)
            raise BindingProtocolError("FIXTURE_DENIED")
    assert authority._meta() == {**before, "lastSeenNow": NOW + 10}
    with pytest.raises(RuntimeError, match="fixture-failure"):
        with authority._transaction(NOW + 20, observed_now=lambda: NOW + 30):
            raise RuntimeError("fixture-failure")
    assert authority._meta() == {**before, "lastSeenNow": NOW + 10}
