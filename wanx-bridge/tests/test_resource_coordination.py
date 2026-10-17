"""Host OTA and public Octop resource writes share a durable, generation-fenced gate."""

import asyncio
import fcntl
import hashlib
import json
import os

import httpx
import pytest
from test_resource_candidates import candidate, inspect
from test_resource_identity import skill_resource
from test_resources import prepare
from test_resources import runtime as runtime
from test_resources import setup as setup

from wanx_bridge.admin_client import AdminClient
from wanx_bridge.config import BridgeAuthError
from wanx_bridge.resource_coordination import (
    ResourceWriteCoordinator,
    assert_no_legacy_pending,
    write_digest,
)
from wanx_bridge.resources_contract import canonical
from wanx_bridge.resources_runtime import ResourceRuntime


@pytest.fixture
def coordination(tmp_path, monkeypatch):
    directory = tmp_path / "coordination"
    directory.mkdir(mode=0o750)
    (directory / "intents").mkdir(mode=0o700)
    (directory / "coordination.lock").touch(mode=0o640)
    (directory / "protocol.json").write_bytes(
        canonical(
            {
                "schemaVersion": 1,
                "protocol": "wanx.resource-coordination.v1",
                "deviceId": "box-1",
                "component": "wanx",
                "writerUid": os.geteuid(),
                "writerGid": os.getegid(),
            }
        )
    )
    gate(directory)
    monkeypatch.setenv("WANX_RESOURCE_COORDINATION_DIR", str(directory))
    return directory


def gate(directory, *, closed=False, generation=0):
    (directory / "gate.json").write_bytes(
        canonical(
            {
                "schemaVersion": 1,
                "mode": "closed" if closed else "open",
                "generation": generation,
                "owner": {
                    "operationId": "ota-1",
                    "planDigest": "a" * 64,
                    "attemptGeneration": 1,
                    "nonce": "b" * 64,
                }
                if closed
                else None,
                "lastRelease": None,
            }
        )
    )


def coordinator(directory, operation="resource-1"):
    return ResourceWriteCoordinator(
        directory,
        device_id="box-1",
        ownership_epoch=1,
        operation_id=operation,
        scope_digest="f" * 64,
    )


def intents(directory):
    return [json.loads(path.read_bytes()) for path in (directory / "intents").glob("*.json")]


def test_closed_gate_blocks_new_operation_but_admitted_writer_can_finish(coordination):
    admitted = coordinator(coordination)
    admitted.begin()
    gate(coordination, closed=True)
    with pytest.raises(BridgeAuthError):
        coordinator(coordination, "resource-2").begin()
    admitted.before_write("1" * 64)
    admitted.before_write("2" * 64)
    assert intents(coordination)[0]["state"] == "in_flight"
    admitted.finish(True)
    assert intents(coordination)[0]["state"] == "completed"
    assert not list((coordination / "intents").glob(".coord-*"))


@pytest.mark.parametrize("state", ["in_flight", "uncertain"])
def test_restart_never_clears_uncertain_post_or_bypasses_it_with_new_operation(coordination, state):
    first = coordinator(coordination)
    first.before_write("1" * 64)
    if state == "uncertain":
        first.mark_uncertain()
    for operation in ("resource-1", "another-operation"):
        with pytest.raises(BridgeAuthError, match="RESOURCE_WRITE_UNCERTAIN"):
            coordinator(coordination, operation).begin()
    assert intents(coordination)[0]["state"] == state


def test_gate_generation_fences_old_write_and_finish(coordination):
    first = coordinator(coordination)
    first.before_write("1" * 64)
    gate(coordination, generation=1)
    for action in (lambda: first.before_write("2" * 64), lambda: first.finish(True)):
        with pytest.raises(BridgeAuthError, match="RESOURCE_COORDINATION_GENERATION_CHANGED"):
            action()
    assert intents(coordination)[0]["state"] == "in_flight"


def test_cancellation_before_external_write_can_abort_and_retry_after_gate_reopens(coordination):
    first = coordinator(coordination)
    first.begin()
    gate(coordination, closed=True)
    first.finish(False)
    assert intents(coordination)[0]["state"] == "aborted"
    with pytest.raises(BridgeAuthError, match="RESOURCE_OTA_IN_PROGRESS"):
        coordinator(coordination).begin()
    gate(coordination)
    coordinator(coordination).begin()
    assert intents(coordination)[0]["state"] == "preparing"


def test_zero_write_abort_can_reenter_after_successful_ota_generation_change(coordination):
    first = coordinator(coordination)
    first.begin()
    first.finish(False)
    assert intents(coordination)[0]["writeIntentDigest"] is None
    gate(coordination, generation=1)
    retry = coordinator(coordination)
    retry.before_write("2" * 64)
    assert intents(coordination)[0]["gateGeneration"] == 1
    assert intents(coordination)[0]["state"] == "in_flight"


@pytest.mark.parametrize(
    "state,digest", [("in_flight", "a" * 64), ("uncertain", "a" * 64), ("aborted", "a" * 64)]
)
def test_prior_write_cannot_reenter_by_advancing_generation(coordination, state, digest):
    first = coordinator(coordination)
    first.before_write(digest)
    path = next((coordination / "intents").glob("*.json"))
    value = json.loads(path.read_bytes())
    value["state"] = state
    path.write_bytes(canonical(value))
    gate(coordination, generation=1)
    before = path.read_bytes()
    with pytest.raises(BridgeAuthError):
        coordinator(coordination).begin()
    assert path.read_bytes() == before


@pytest.mark.parametrize("operation", ["resource-1", "another-operation"])
@pytest.mark.parametrize("generation", [0, 1])
def test_aborted_with_write_digest_is_invalid_for_every_admission(
    coordination, operation, generation
):
    first = coordinator(coordination)
    first.before_write("a" * 64)
    path = next((coordination / "intents").glob("*.json"))
    value = json.loads(path.read_bytes())
    value["state"] = "aborted"
    path.write_bytes(canonical(value))
    gate(coordination, generation=generation)
    before = path.read_bytes()
    with pytest.raises(BridgeAuthError, match="RESOURCE_COORDINATION_INVALID"):
        coordinator(coordination, operation).begin()
    assert path.read_bytes() == before
    assert len(intents(coordination)) == 1


def test_completed_with_write_digest_still_allows_new_admission(coordination):
    first = coordinator(coordination)
    first.before_write("a" * 64)
    first.finish(True)
    gate(coordination, generation=1)
    coordinator(coordination, "another-operation").begin()
    records = {item["operationId"]: item for item in intents(coordination)}
    assert records["resource-1"]["state"] == "completed"
    assert records["resource-1"]["writeIntentDigest"] == "a" * 64
    assert records["another-operation"]["gateGeneration"] == 1


@pytest.mark.parametrize("missing", ["protocol.json", "gate.json", "coordination.lock"])
def test_configured_missing_files_cannot_downgrade_coordination(coordination, missing):
    (coordination / missing).unlink()
    with pytest.raises(BridgeAuthError, match="RESOURCE_COORDINATION_INVALID"):
        coordinator(coordination).begin()


@pytest.mark.parametrize("bad", [".coord-crashed", "unknown.json"])
def test_unknown_intent_or_interrupted_atomic_write_blocks_admission(coordination, bad):
    (coordination / "intents" / bad).write_text("{}")
    with pytest.raises(BridgeAuthError, match="RESOURCE_COORDINATION_INVALID"):
        coordinator(coordination).begin()


def test_write_intent_digest_does_not_store_uploaded_content():
    raw = b"private customer material"
    value = write_digest("POST", "/api/workspace", {"files": {"file": ("AGENTS.md", raw)}})
    assert len(value) == 64
    assert value == write_digest("POST", "/api/workspace", {"files": {"file": ("AGENTS.md", raw)}})
    assert value != write_digest(
        "POST", "/api/workspace", {"files": {"file": ("AGENTS.md", b"other")}}
    )


async def test_candidate_ready_is_durable_before_coordination_completed(
    runtime, coordination, monkeypatch
):
    original = ResourceWriteCoordinator.finish

    def finish(self, ready):
        if ready:
            paths = list((runtime[0].catalog.directory / "binding-sets").glob("*.json"))
            assert len(paths) == 1
            ledger = json.loads(paths[0].read_bytes())
            assert ledger["resources"]["expert:companion"]["status"] == "ready"
        original(self, ready)

    monkeypatch.setattr(ResourceWriteCoordinator, "finish", finish)
    first = await candidate(runtime)
    assert first["status"] == "ready"
    assert intents(coordination)[0]["state"] == "completed"
    entry = next((coordination / "intents").glob("*.json"))
    assert (
        entry.name
        == hashlib.sha256(intents(coordination)[0]["operationId"].encode()).hexdigest() + ".json"
    )
    assert entry.stat().st_mode & 0o777 == 0o600
    gate(coordination, closed=True)
    assert (await inspect(runtime, first))["status"] == "ready"
    assert (await candidate(runtime))["status"] == "ready"


async def test_closed_gate_blocks_resource_prepare_before_download_and_post(runtime, coordination):
    gate(coordination, closed=True)
    result = await candidate(runtime)
    assert result["status"] == "blocked"
    assert result["code"] == "RESOURCE_OTA_IN_PROGRESS"
    assert runtime[0].catalog.calls == 0
    assert all(method == "GET" for method, _ in runtime[1].calls)
    assert intents(coordination) == []


async def test_lost_create_response_remains_uncertain_across_restart_without_second_post(
    runtime, coordination
):
    runtime[1].lost_create = True
    failed = await candidate(runtime)
    assert failed["status"] == "blocked"
    assert intents(coordination)[0]["state"] == "uncertain"
    runtime[1].lost_create = False
    restarted = (ResourceRuntime(runtime[0].catalog, runtime[0].admin), *runtime[1:])
    for operation in ("install-1", "another-install"):
        retry = await candidate(restarted, operation=operation)
        assert retry["status"] == "blocked"
        assert retry["code"] == "RESOURCE_WRITE_UNCERTAIN"
    assert runtime[1].calls.count(("POST", "/api/agents")) == 1
    assert len(runtime[1].rows) == 1


async def test_task_cancellation_after_create_never_releases_barrier(runtime, coordination):
    created = asyncio.Event()
    upstream = runtime[1]

    async def lost(method, path, **kwargs):
        response = await upstream(method, path, **kwargs)
        if method == "POST":
            created.set()
            await asyncio.Event().wait()
        return response

    env = (runtime[0], lost, *runtime[2:])
    task = asyncio.create_task(candidate(env))
    await asyncio.wait_for(created.wait(), 3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert intents(coordination)[0]["state"] == "uncertain"
    assert (await candidate(runtime))["code"] == "RESOURCE_WRITE_UNCERTAIN"
    assert upstream.calls.count(("POST", "/api/agents")) == 1


async def test_preparation_failure_without_write_does_not_leave_ota_barrier(
    runtime, coordination, monkeypatch
):
    async def unavailable(*args, **kwargs):
        raise BridgeAuthError("RESOURCE_DOWNLOAD_FAILED", 503)

    monkeypatch.setattr(runtime[0].catalog, "package", unavailable)
    result = await candidate(runtime)
    assert result["status"] == "blocked"
    assert intents(coordination)[0]["state"] == "aborted"
    assert all(method == "GET" for method, _ in runtime[1].calls)


async def test_skill_post_401_is_not_replayed_and_keeps_uncertain_barrier(
    runtime, coordination, tmp_path
):
    skill_resource(runtime)
    calls = []

    async def transport(request):
        calls.append((request.method, request.url.path))
        if request.method == "GET" and request.url.path == "/api/skill-packages":
            return httpx.Response(200, json=[])
        assert request.method == "POST" and request.url.path == "/api/skill-packages"
        return httpx.Response(401)

    client = AdminClient(
        "http://127.0.0.1:18088",
        tmp_path / "unused-credential",
        transport=httpx.MockTransport(transport),
    )
    client._admin_token = "stale"
    runtime[0].admin = client
    try:
        result = await candidate(runtime)
        assert result["status"] == "blocked"
        assert calls == [("GET", "/api/skill-packages"), ("POST", "/api/skill-packages")]
        assert intents(coordination)[0]["state"] == "uncertain"
    finally:
        await client.close()


async def test_legacy_inspection_is_read_only_and_accepts_real_ready_ledgers(runtime):
    assert (await prepare(runtime))["status"] == "ready"
    assert (await candidate(runtime))["status"] == "ready"
    directory = runtime[0].catalog.directory
    before = {
        path: (path.read_bytes(), path.stat().st_mtime_ns)
        for path in directory.rglob("*")
        if path.is_file()
    }
    result = assert_no_legacy_pending(directory)
    assert result == {
        "status": "ready",
        "ledgerCount": 3,
        "evidence": "no-pending-resource-ledgers",
    }
    assert before == {
        path: (path.read_bytes(), path.stat().st_mtime_ns)
        for path in directory.rglob("*")
        if path.is_file()
    }


def test_legacy_inspection_missing_state_does_not_create_files(tmp_path):
    missing = tmp_path / "missing-resource-state"
    assert assert_no_legacy_pending(missing)["ledgerCount"] == 0
    assert not missing.exists()


async def test_legacy_pending_prepare_is_not_mistaken_for_empty_gate(runtime, coordination):
    runtime[1].fail_upload = True
    assert (await prepare(runtime))["status"] == "blocked"
    with pytest.raises(BridgeAuthError, match="RESOURCE_PREPARATION_PENDING"):
        assert_no_legacy_pending(runtime[0].catalog.directory)


@pytest.mark.parametrize("pending_location", ["candidate", "shared-instance"])
async def test_legacy_inspection_rejects_unfinished_candidate_and_shared_instance(
    runtime, pending_location
):
    result = await candidate(runtime)
    directory = runtime[0].catalog.directory
    if pending_location == "candidate":
        path = directory / "binding-sets" / (result["bindingSetId"] + ".json")
        value = json.loads(path.read_bytes())
        value["bindingSetStatus"] = "preparing"
    else:
        path = next((directory / "instances" / "experts").glob("*.json"))
        value = json.loads(path.read_bytes())
        value["record"]["status"] = "preparing"
    path.write_bytes(canonical(value))
    with pytest.raises(BridgeAuthError, match="RESOURCE_PREPARATION_PENDING"):
        assert_no_legacy_pending(directory)


@pytest.mark.parametrize(
    "bad", ["invalid-json", "unknown-field", "symlink", "hardlink", "temporary"]
)
async def test_legacy_inspection_fails_closed_on_bad_ledger(runtime, tmp_path, bad):
    assert (await prepare(runtime))["status"] == "ready"
    directory = runtime[0].catalog.directory
    path = next((directory / "bindings").glob("*.json"))
    if bad == "invalid-json":
        path.write_text("{")
    elif bad == "unknown-field":
        value = json.loads(path.read_bytes())
        value["new-format"] = True
        path.write_bytes(canonical(value))
    elif bad == "symlink":
        target = tmp_path / "linked-state"
        path.rename(target)
        path.symlink_to(target)
    elif bad == "hardlink":
        os.link(path, tmp_path / "shared-inode")
    else:
        (path.parent / ".resource-crashed").write_text("{}")
    with pytest.raises(BridgeAuthError, match="RESOURCE_LOCAL_STATE_INVALID"):
        assert_no_legacy_pending(directory)


async def test_legacy_inspection_cannot_pass_while_prepare_lock_is_held(runtime):
    assert (await prepare(runtime))["status"] == "ready"
    directory = runtime[0].catalog.directory
    fd = os.open(directory / "prepare.lock", os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(BridgeAuthError, match="RESOURCE_PREPARATION_BUSY"):
            assert_no_legacy_pending(directory)
    finally:
        os.close(fd)
