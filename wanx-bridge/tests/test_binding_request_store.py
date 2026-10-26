"""Real SQLite transactions and independent connections; synthetic keys only."""

import base64
import copy
import json
import os
import sqlite3
import stat
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from jwt import api_jws

from wanx_bridge import binding_request_store as journal
from wanx_bridge.binding_request_store import BindingRequestStore
from wanx_bridge.local_trust_protocol import (
    BindingProtocolError,
    canonical_request,
    request_digest,
    sign_cancel,
    sign_request,
)

pytestmark = pytest.mark.skipif(
    os.name != "posix", reason="Journal requires POSIX file permissions"
)
VECTOR = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts/local-trust/v1/vectors.json").read_text()
)
NOW = VECTOR["now"]
KEY = serialization.load_pem_private_key(
    VECTOR["testKeys"]["accessPrivateKeyPem"].encode("ascii"), password=None
)
CONTEXT = {name: value for name, value in VECTOR["context"].items() if name != "challenge"}


def identifier(number):
    return base64.urlsafe_b64encode(number.to_bytes(32, "big")).rstrip(b"=").decode("ascii")


def proposal(challenge, number=1, **changes):
    request = copy.deepcopy(VECTOR["request"])
    request.update(challenge)
    request.update(requestId=identifier(number))
    request.update(changes)
    return request


def cancellation(request, now=NOW + 1, **changes):
    payload = {
        "schemaVersion": 1,
        "purpose": "centuarai.local-device-binding.cancel",
        "requestId": request["requestId"],
        "requestDigest": request_digest(request),
        "issuedAt": now,
        "expiresAt": now + 120,
    }
    payload.update(changes)
    return payload


@pytest.fixture
def factory(tmp_path):
    opened = []

    def create(boot_id="boot-1", directory=None):
        store = BindingRequestStore(directory or tmp_path / "journal", boot_id=boot_id)
        opened.append(store)
        return store

    yield create
    for store in opened:
        store.close()


def race(*operations):
    barrier = threading.Barrier(len(operations))

    def run(operation):
        barrier.wait(timeout=5)
        try:
            return operation()
        except BindingProtocolError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=len(operations)) as pool:
        futures = [pool.submit(run, operation) for operation in operations]
        return [future.result(timeout=10) for future in futures]


def test_challenge_randomness_private_database_and_minimal_receipt(factory, tmp_path):
    store = factory()
    first = store.issue_challenge(CONTEXT, NOW)
    second = store.issue_challenge(CONTEXT, NOW)
    assert first != second
    assert set(first) == {"challenge", "issuedAt", "expiresAt"}
    assert first["issuedAt"] == NOW and first["expiresAt"] == NOW + 300
    assert len(base64.urlsafe_b64decode(first["challenge"] + "=")) == 32
    request = proposal(first)
    receipt = store.submit(sign_request(request, KEY), NOW)
    assert receipt == {
        "requestId": request["requestId"],
        "requestDigest": request_digest(request),
        "state": "pending",
        "expiresAt": NOW + 300,
    }
    assert stat.S_IMODE((tmp_path / "journal").stat().st_mode) == 0o700
    assert stat.S_IMODE((tmp_path / "journal" / "binding-requests.sqlite3").stat().st_mode) == 0o600
    assert not (tmp_path / "journal" / "auth.sqlite3").exists()
    assert not any(
        hasattr(store, method)
        for method in (
            "approve",
            "commit_binding",
            "seed_manager",
            "grant",
            "create_session",
            "migrate",
            "query",
        )
    )


def test_context_is_saved_not_replaced_from_signed_request(factory):
    store = factory()
    context = copy.deepcopy(CONTEXT)
    challenge = store.issue_challenge(context, NOW)
    context["policyVersion"] += 1
    altered = proposal(challenge, policyVersion=context["policyVersion"])
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_CONTEXT_MISMATCH"):
        store.submit(sign_request(altered, KEY), NOW)
    # Rejected requests neither consume the challenge nor reserve their ID.
    valid = proposal(challenge)
    assert store.submit(sign_request(valid, KEY), NOW)["state"] == "pending"


@pytest.mark.parametrize(
    "changes",
    [
        {"issuedAt": NOW - 1, "expiresAt": NOW + 299},
        {"issuedAt": NOW + 1, "expiresAt": NOW + 301},
    ],
)
def test_request_lifetime_must_fit_issued_challenge(factory, changes):
    store = factory()
    challenge = store.issue_challenge(CONTEXT, NOW)
    request = proposal(challenge, **changes)
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_CHALLENGE_INVALID"):
        store.submit(sign_request(request, KEY), NOW + 1)
    assert store.submit(sign_request(proposal(challenge), KEY), NOW + 1)["state"] == "pending"


def test_unknown_and_exactly_expired_challenges_are_rejected(factory):
    store = factory()
    request = proposal({"challenge": identifier(900), "issuedAt": NOW, "expiresAt": NOW + 300})
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_CHALLENGE_INVALID"):
        store.submit(sign_request(request, KEY), NOW)
    challenge = store.issue_challenge(CONTEXT, NOW)
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_CHALLENGE_INVALID"):
        store.submit(sign_request(proposal(challenge), KEY), NOW + 300)


def test_same_digest_retry_accepts_new_signature_but_not_changed_content(factory):
    store = factory()
    request = proposal(store.issue_challenge(CONTEXT, NOW))
    first = store.submit(sign_request(request, KEY), NOW)
    assert store.submit(sign_request(request, KEY), NOW + 1) == first
    changed = {**request, "clientId": "different-client"}
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_REQUEST_CONFLICT"):
        store.submit(sign_request(changed, KEY), NOW + 1)
    # Construct the invalid proof independently: the production signing helper
    # correctly refuses to sign a request with a mismatched access key.
    wrong_proof = api_jws.encode(
        canonical_request(request),
        ec.generate_private_key(ec.SECP256R1()),
        algorithm="ES256",
        headers={"typ": "centuarai-device-binding-request+jws"},
    )
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_SIGNATURE_INVALID"):
        store.submit(wrong_proof, NOW + 1)
    assert store._db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 1


def test_signed_cancellation_is_terminal_and_retries_never_recreate(factory):
    store = factory()
    request = proposal(store.issue_challenge(CONTEXT, NOW))
    proof = sign_request(request, KEY)
    store.submit(proof, NOW)
    cancel = sign_cancel(cancellation(request), KEY)
    cancelled = store.cancel(cancel, NOW + 1)
    assert cancelled["state"] == "cancelled"
    assert store.cancel(cancel, NOW + 2) == cancelled
    assert store.submit(sign_request(request, KEY), NOW + 500) == cancelled
    other_id = {**request, "requestId": identifier(2)}
    with pytest.raises(BindingProtocolError):
        store.submit(sign_request(other_id, KEY), NOW + 500)
    assert store._db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 1


@pytest.mark.parametrize("bad", ["key", "digest", "request", "expired"])
def test_cancellation_requires_saved_key_digest_and_fresh_proof(factory, bad):
    store = factory()
    request = proposal(store.issue_challenge(CONTEXT, NOW))
    initial = store.submit(sign_request(request, KEY), NOW)
    payload = cancellation(request)
    key = KEY
    if bad == "key":
        key = ec.generate_private_key(ec.SECP256R1())
    elif bad == "digest":
        payload["requestDigest"] = identifier(400)
    elif bad == "request":
        payload["requestId"] = identifier(400)
    else:
        payload.update(issuedAt=NOW - 3, expiresAt=NOW - 1)
    with pytest.raises(BindingProtocolError):
        store.cancel(sign_cancel(payload, key), NOW + 1)
    assert store.submit(sign_request(request, KEY), NOW + 1) == initial


def test_expiry_wins_at_deadline_and_terminal_retry_still_checks_signature(factory):
    store = factory()
    request = proposal(store.issue_challenge(CONTEXT, NOW), expiresAt=NOW + 10)
    store.submit(sign_request(request, KEY), NOW)
    cancel = sign_cancel(cancellation(request, NOW + 9), KEY)
    assert store.cancel(cancel, NOW + 10)["state"] == "expired"
    assert store.submit(sign_request(request, KEY), NOW + 10)["state"] == "expired"
    wrong_proof = api_jws.encode(
        canonical_request(request),
        ec.generate_private_key(ec.SECP256R1()),
        algorithm="ES256",
        headers={"typ": "centuarai-device-binding-request+jws"},
    )
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_SIGNATURE_INVALID"):
        store.submit(wrong_proof, NOW + 11)


def test_same_boot_connections_share_state_and_restart_fences_old_instances(factory):
    first, same = factory(), factory()
    pending = proposal(first.issue_challenge(CONTEXT, NOW))
    first.submit(sign_request(pending, KEY), NOW)
    assert same.submit(sign_request(pending, KEY), NOW)["state"] == "pending"
    unused = first.issue_challenge(CONTEXT, NOW)
    restarted = factory("boot-2")
    assert restarted.submit(sign_request(pending, KEY), NOW)["state"] == "expired"
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_CHALLENGE_INVALID"):
        restarted.submit(sign_request(proposal(unused, 2), KEY), NOW)
    for store in (first, same):
        for call in (
            lambda: store.issue_challenge(CONTEXT, NOW),
            lambda: store.submit(sign_request(pending, KEY), NOW),
            lambda: store.cancel(sign_cancel(cancellation(pending, NOW), KEY), NOW),
        ):
            with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_BOOT_MISMATCH"):
                call()
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_BOOT_MISMATCH"):
        factory("boot-1")
    assert restarted.issue_challenge(CONTEXT, NOW)["issuedAt"] == NOW


def test_same_boot_concurrent_startup_does_not_retire_itself(factory):
    first, second = race(lambda: factory(), lambda: factory())
    request = proposal(first.issue_challenge(CONTEXT, NOW))
    assert second.submit(sign_request(request, KEY), NOW)["state"] == "pending"
    assert first._db.execute("SELECT COUNT(*) FROM retired_boots").fetchone()[0] == 0


def test_boot_transition_failure_rolls_back_expiry_and_generation(factory):
    original = factory()
    request = proposal(original.issue_challenge(CONTEXT, NOW))
    original.submit(sign_request(request, KEY), NOW)
    original._db.execute("""CREATE TRIGGER fail_boot BEFORE UPDATE OF boot_id ON boot
        BEGIN SELECT RAISE(ABORT, 'synthetic boot failure'); END""")
    with pytest.raises(sqlite3.IntegrityError, match="synthetic boot failure"):
        factory("boot-2")
    assert original.submit(sign_request(request, KEY), NOW)["state"] == "pending"
    assert original._db.execute("SELECT COUNT(*) FROM retired_boots").fetchone()[0] == 0
    original._db.execute("DROP TRIGGER fail_boot")
    rebooted = factory("boot-2")
    assert rebooted.submit(sign_request(request, KEY), NOW)["state"] == "expired"


@pytest.mark.parametrize("operation", ["issue", "submit", "cancel"])
def test_clock_high_water_is_shared_and_rollback_rejected(factory, operation):
    first, second = factory(), factory()
    request = proposal(first.issue_challenge(CONTEXT, NOW), expiresAt=NOW + 10)
    first.submit(sign_request(request, KEY), NOW)
    # A malformed proof is an expected rejection, but observed time and expiry
    # remain committed so a later backward clock cannot revive the request.
    with pytest.raises(BindingProtocolError):
        first.submit("invalid", NOW + 10)
    calls = {
        "issue": lambda: second.issue_challenge(CONTEXT, NOW + 9),
        "submit": lambda: second.submit(sign_request(request, KEY), NOW + 9),
        "cancel": lambda: second.cancel(sign_cancel(cancellation(request, NOW + 9), KEY), NOW + 9),
    }
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_CLOCK_ROLLBACK"):
        calls[operation]()
    assert second.submit(sign_request(request, KEY), NOW + 10)["state"] == "expired"
    # A genuine new boot may use a reset clock, but its old evidence stays dead.
    rebooted = factory("boot-2")
    assert rebooted.submit(sign_request(request, KEY), NOW)["state"] == "expired"


@pytest.mark.parametrize("value", [True, False, 0, -1, 1.0, "1792886410", 9007199254740991])
def test_store_requires_bounded_integer_trusted_time(factory, value):
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_INVALID"):
        factory().issue_challenge(CONTEXT, value)


def test_two_connections_can_consume_a_challenge_only_once(factory):
    first, second = factory(), factory()
    challenge = first.issue_challenge(CONTEXT, NOW)
    proofs = [sign_request(proposal(challenge, number), KEY) for number in (1, 2)]
    traces = [[], []]
    first._db.set_trace_callback(traces[0].append)
    second._db.set_trace_callback(traces[1].append)
    results = race(lambda: first.submit(proofs[0], NOW), lambda: second.submit(proofs[1], NOW))
    assert sum(isinstance(result, dict) for result in results) == 1
    assert results.count("LOCAL_BINDING_CHALLENGE_USED") == 1
    assert all("BEGIN IMMEDIATE" in trace for trace in traces)
    assert first._db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 1


def test_concurrent_same_request_has_one_record_and_same_receipt(factory):
    first, second = factory(), factory()
    request = proposal(first.issue_challenge(CONTEXT, NOW))
    proofs = [sign_request(request, KEY), sign_request(request, KEY)]
    results = race(lambda: first.submit(proofs[0], NOW), lambda: second.submit(proofs[1], NOW))
    assert results[0] == results[1] and results[0]["state"] == "pending"
    assert first._db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 1


@pytest.mark.parametrize("deadline", [False, True])
def test_cancel_and_submission_retry_serialize_without_resurrection(factory, deadline):
    first, second = factory(), factory()
    request = proposal(first.issue_challenge(CONTEXT, NOW), expiresAt=NOW + 10)
    proof = sign_request(request, KEY)
    first.submit(proof, NOW)
    now = NOW + 10 if deadline else NOW + 1
    cancel = sign_cancel(cancellation(request, now), KEY)
    results = race(lambda: first.submit(proof, now), lambda: second.cancel(cancel, now))
    expected = "expired" if deadline else "cancelled"
    assert results[1]["state"] == expected
    assert first.submit(proof, now)["state"] == expected


def test_submit_failure_rolls_back_request_and_challenge_consumption(factory):
    store = factory()
    request = proposal(store.issue_challenge(CONTEXT, NOW))
    store._db.execute("""CREATE TRIGGER fail_consume BEFORE UPDATE OF consumed_request_id ON challenges
        WHEN NEW.consumed_request_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END""")
    with pytest.raises(sqlite3.IntegrityError, match="synthetic write failure"):
        store.submit(sign_request(request, KEY), NOW)
    observer = factory()
    assert observer._db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 0
    assert observer._db.execute("SELECT consumed_request_id FROM challenges").fetchone()[0] is None
    store._db.execute("DROP TRIGGER fail_consume")
    assert observer.submit(sign_request(request, KEY), NOW)["state"] == "pending"


def test_cancellation_write_failure_leaves_pending_evidence(factory):
    store = factory()
    request = proposal(store.issue_challenge(CONTEXT, NOW))
    initial = store.submit(sign_request(request, KEY), NOW)
    store._db.execute("""CREATE TRIGGER fail_cancel BEFORE UPDATE OF state ON requests
        WHEN NEW.state='cancelled' BEGIN SELECT RAISE(ABORT, 'synthetic cancel failure'); END""")
    with pytest.raises(sqlite3.IntegrityError, match="synthetic cancel failure"):
        store.cancel(sign_cancel(cancellation(request), KEY), NOW + 1)
    assert store.submit(sign_request(request, KEY), NOW + 1) == initial


def test_expected_error_rolls_back_evidence_but_keeps_clock_and_expiry(factory, monkeypatch):
    store = factory()
    old = proposal(store.issue_challenge(CONTEXT, NOW), expiresAt=NOW + 1)
    store.submit(sign_request(old, KEY), NOW)
    new = proposal(store.issue_challenge(CONTEXT, NOW), 2)

    def reject_receipt(_row):
        raise BindingProtocolError("LOCAL_BINDING_SYNTHETIC_REJECTION")

    with monkeypatch.context() as patch:
        patch.setattr(store, "_receipt", reject_receipt)
        with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_SYNTHETIC_REJECTION"):
            store.submit(sign_request(new, KEY), NOW + 1)
    observer = factory()
    assert observer._db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 1
    assert observer.submit(sign_request(old, KEY), NOW + 1)["state"] == "expired"
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_CLOCK_ROLLBACK"):
        observer.submit(sign_request(new, KEY), NOW)
    assert observer.submit(sign_request(new, KEY), NOW + 1)["state"] == "pending"


def test_challenge_capacity_reclaims_only_expired_challenges(factory):
    store = factory()
    issued = [store.issue_challenge(CONTEXT, NOW) for _ in range(128)]
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_CHALLENGE_CAPACITY"):
        store.issue_challenge(CONTEXT, NOW)
    assert store.issue_challenge(CONTEXT, NOW + 300)["challenge"] not in {
        item["challenge"] for item in issued
    }


def test_challenge_capacity_is_atomic_across_connections(factory):
    first, second = factory(), factory()
    for _ in range(127):
        first.issue_challenge(CONTEXT, NOW)
    results = race(
        lambda: first.issue_challenge(CONTEXT, NOW),
        lambda: second.issue_challenge(CONTEXT, NOW),
    )
    assert results.count("LOCAL_BINDING_CHALLENGE_CAPACITY") == 1
    assert sum(isinstance(result, dict) for result in results) == 1
    assert first._db.execute("SELECT COUNT(*) FROM challenges").fetchone()[0] == 128


def test_pending_capacity_rejection_does_not_consume_challenge(factory):
    store = factory()
    requests = []
    for number in range(1, 129):
        request = proposal(store.issue_challenge(CONTEXT, NOW), number)
        store.submit(sign_request(request, KEY), NOW)
        requests.append(request)
    overflow = proposal(store.issue_challenge(CONTEXT, NOW), 129)
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_REQUEST_CAPACITY"):
        store.submit(sign_request(overflow, KEY), NOW)
    store.cancel(sign_cancel(cancellation(requests[0], NOW), KEY), NOW)
    assert store.submit(sign_request(overflow, KEY), NOW)["state"] == "pending"
    assert store.submit(sign_request(requests[0], KEY), NOW)["state"] == "cancelled"


def test_retained_request_capacity_never_deletes_tombstones(factory):
    store = factory()
    sample = proposal(store.issue_challenge(CONTEXT, NOW), 5000)
    # Arrange already-retained cancellation records in one fixture transaction;
    # the operation under test must count terminal rows, not only pending rows.
    rows = []
    for number in range(4096):
        request = {**sample, "requestId": identifier(number)}
        rows.append(
            (
                request["requestId"],
                request_digest(request),
                json.dumps(request),
                "cancelled",
                request["expiresAt"],
            )
        )
    store._db.execute("BEGIN IMMEDIATE")
    store._db.executemany("INSERT INTO requests VALUES (?, ?, ?, ?, ?)", rows)
    store._db.commit()
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_REQUEST_CAPACITY"):
        store.submit(sign_request(sample, KEY), NOW)
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_REQUEST_CAPACITY"):
        store.issue_challenge(CONTEXT, NOW)
    assert store._db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 4096
    assert store._db.execute("SELECT consumed_request_id FROM challenges").fetchone()[0] is None
    previous = {**sample, "requestId": identifier(1)}
    assert store.submit(sign_request(previous, KEY), NOW + 500)["state"] == "cancelled"


@pytest.mark.parametrize(
    "kind",
    [
        "directory-symlink",
        "directory-mode",
        "database-symlink",
        "database-mode",
        "database-hardlink",
        "sidecar-symlink",
    ],
)
def test_unsafe_storage_paths_are_rejected_without_changing_target(tmp_path, kind):
    directory = tmp_path / "journal"
    directory.mkdir(mode=0o700)
    target = tmp_path / "unrelated"
    target.write_bytes(b"unrelated user data")
    path = directory / "binding-requests.sqlite3"
    if kind == "directory-symlink":
        alias = tmp_path / "alias"
        alias.symlink_to(directory, target_is_directory=True)
        directory = alias
    elif kind == "directory-mode":
        directory.chmod(0o755)
    elif kind == "database-symlink":
        path.symlink_to(target)
    elif kind == "database-mode":
        path.write_bytes(b"existing private file")
        path.chmod(0o644)
    elif kind == "database-hardlink":
        target.chmod(0o600)
        path.hardlink_to(target)
    else:
        path.with_name(path.name + "-journal").symlink_to(target)
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_STORE_PATH_INVALID"):
        BindingRequestStore(directory, boot_id="boot-1")
    assert target.read_bytes() == b"unrelated user data"


def test_unimplemented_acl_platform_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(journal, "os", SimpleNamespace(name="nt"))
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_STORE_UNSUPPORTED_PLATFORM"):
        BindingRequestStore(tmp_path / "journal", boot_id="boot-1")
    assert not (tmp_path / "journal").exists()


def test_existing_non_database_file_is_not_replaced(tmp_path):
    directory = tmp_path / "journal"
    directory.mkdir(mode=0o700)
    path = directory / "binding-requests.sqlite3"
    path.write_bytes(b"pre-existing unrelated private file")
    path.chmod(0o600)
    with pytest.raises(sqlite3.DatabaseError):
        BindingRequestStore(directory, boot_id="boot-1")
    assert path.read_bytes() == b"pre-existing unrelated private file"


def test_close_is_idempotent_and_preserves_database(factory, tmp_path):
    store = factory()
    store.close()
    store.close()
    with pytest.raises(BindingProtocolError, match="LOCAL_BINDING_STORE_CLOSED"):
        store.issue_challenge(CONTEXT, NOW)
    assert (tmp_path / "journal" / "binding-requests.sqlite3").exists()
