"""Closure evidence never treats invalidation, time, or incomplete inventory as ACK."""

import asyncio

import pytest
from test_local_data_sessions import Harness, nonce

from wanx_bridge import local_data_protocol as wire


async def observed(h, operations, *, n=70, audience="octop", generation=None):
    body = {
        "nativeGateGeneration": generation or nonce(9),
        "gateNonce": nonce(n),
        "activeOperationIds": sorted(op["operationId"] for op in operations),
    }
    proof = await h.service.native_observe(body, audience=audience)
    result = wire.verify_gateway_observation(proof, wire.public_jwk(h.gateway), h.clock.wall)
    assert result["requestDigest"] == wire.digest(body)
    return result


def commit(h, n=80):
    return {
        "operationId": nonce(n),
        "targetScope": {"kind": "binding", "id": "binding:test"},
        "authorizationVersion": 2,
        "committedAtMs": h.clock.wall,
        "deadlineMs": h.clock.wall + 5000,
        "affectedBindingIds": ["binding:test"],
    }


async def snapshot(h, value):
    await asyncio.sleep(0)
    return h.service.effect_snapshot(
        value["operationId"],
        {
            key: item
            for key, item in value.items()
            if key not in {"affectedBindingIds", "affectedJobs", "affectedJobsComplete"}
        },
    )


async def harness(*audiences):
    h = Harness(required_audiences=audiences or ("octop",))
    h.service.gateway_observation_signer = lambda value: wire.sign_gateway_observation(
        value, h.gateway
    )
    await h.start()
    return h


@pytest.mark.asyncio
async def test_effect_requires_native_ack_and_actual_gateway_transport_and_staging_completion():
    h = await harness()
    op, proof = await h.operation()
    await h.native_start(op, proof)
    assert (await observed(h, [op]))["accepted"] is True
    h.clock.advance(1)
    value = commit(h)
    await h.service.observe_commit(value)
    await h.service.invalidate_authority()
    before = await snapshot(h, value)
    assert before["effectState"] == "pending" and before["native"]["closedOperations"] == 0
    await h.service.finish_operation(op["operationId"], "cancelled", transport_closed=True)
    middle = await snapshot(h, value)
    assert middle["effectState"] == "pending" and middle["gateway"]["closedSessions"] == 1
    await h.service.native_closed(h.native(op, n=71, outcome="cancelled"), audience="octop")
    after = await snapshot(h, value)
    assert after["effectState"] == "effective"
    assert after["native"] == {
        "targetOperations": 1,
        "closedOperations": 1,
        "pendingOperations": 0,
        "unknownOperations": 0,
    }
    h.clock.advance(10000)
    assert (await snapshot(h, value)) == after  # Historical observed closure, not a live lease.


@pytest.mark.asyncio
async def test_missing_transport_evidence_stays_unknown_even_after_native_and_ttl():
    h = await harness()
    op, proof = await h.operation()
    await h.native_start(op, proof)
    await observed(h, [op])
    h.clock.advance(1)
    value = commit(h)
    await h.service.observe_commit(value)
    await h.service.invalidate_authority()
    await h.service.native_closed(h.native(op, n=71, outcome="cancelled"), audience="octop")
    await h.service.finish_operation(op["operationId"], "cancelled")
    assert (await snapshot(h, value))["effectState"] == "unknown"
    h.clock.advance(6000)
    assert (await snapshot(h, value))["effectState"] == "unknown"


@pytest.mark.asyncio
async def test_zero_targets_need_every_configured_participant_and_fresh_inventory():
    h = await harness("octop", "clipboard")
    await h.service.close_session(h.signed(h.payload("close", n=30)))
    h.clock.advance(1001)
    value = commit(h)
    await h.service.observe_commit(value)
    await observed(h, [], audience="octop")
    assert (await snapshot(h, value))["effectState"] == "unknown"
    await observed(h, [], audience="clipboard", n=71)
    result = await snapshot(h, value)
    assert result["effectState"] == "effective" and result["native"]["targetOperations"] == 0


@pytest.mark.asyncio
async def test_unknown_operation_or_new_generation_cannot_erase_unclosed_native_work():
    h = await harness()
    op, proof = await h.operation()
    await h.native_start(op, proof)
    assert (await observed(h, [], generation=nonce(77)))["accepted"] is False
    assert (await observed(h, [], n=71))["accepted"] is False
    assert (await observed(h, [op], n=72))["accepted"] is True
    h.clock.advance(1)
    value = commit(h)
    await h.service.observe_commit(value)
    await h.service.invalidate_authority()
    h.clock.advance(1001)
    assert (await snapshot(h, value))["effectState"] == "unknown"
    fresh = await harness()
    assert await snapshot(fresh, value) is None


@pytest.mark.asyncio
async def test_inventory_nonce_concurrent_replay_one_winner_and_other_purpose_cannot_verify():
    h = await harness()
    body = {"nativeGateGeneration": nonce(9), "gateNonce": nonce(70), "activeOperationIds": []}
    result = await asyncio.gather(
        *(h.service.native_observe(body, audience="octop") for _ in range(12)),
        return_exceptions=True,
    )
    winners = [value for value in result if isinstance(value, str)]
    assert len(winners) == 1
    with pytest.raises(wire.DataProtocolError):
        wire.verify_gateway_lease(winners[0], wire.public_jwk(h.gateway), h.clock.wall)


@pytest.mark.asyncio
async def test_snapshot_is_thread_safe_exact_context_and_historical_retry_cannot_reset_deadline():
    h = await harness()
    await observed(h, [])
    h.clock.advance(1)
    value = commit(h)
    await h.service.observe_commit(value)
    await h.service.invalidate_authority()
    current = await snapshot(h, value)
    expected = {
        key: item
        for key, item in value.items()
        if key not in {"affectedBindingIds", "affectedJobs", "affectedJobsComplete"}
    }
    replies = await asyncio.gather(
        *(
            asyncio.to_thread(h.service.effect_snapshot, value["operationId"], expected)
            for _ in range(20)
        )
    )
    assert all(reply == current for reply in replies)
    assert (
        h.service.effect_snapshot(value["operationId"], {**expected, "authorizationVersion": 3})
        is None
    )
    await h.service.observe_commit(value)
    assert await snapshot(h, value) == current


@pytest.mark.asyncio
async def test_evicted_unclosed_history_cannot_turn_zero_counts_into_effective():
    h = await harness()
    h.service.effects.MAX_HISTORY = 1
    first, _ = await h.operation(n=40)
    second, _ = await h.operation(n=41)
    await observed(h, [])
    h.clock.advance(1)
    value = commit(h)
    await h.service.observe_commit(value)
    await h.service.invalidate_authority()
    await h.service.finish_operation(first["operationId"], "cancelled", transport_closed=True)
    await h.service.finish_operation(second["operationId"], "cancelled", transport_closed=True)
    result = await snapshot(h, value)
    assert result["effectState"] == "unknown"


def worker_job():
    return {
        "operationId": nonce(90),
        "attempt": 2,
        "stateVersion": 4,
        "bindingId": "binding:test",
        "principalId": "principal:test",
        "ownershipEpoch": 1,
        "authorizationVersion": 1,
    }


async def worker(h, job, *, sequence=1, phase="active", ready=True, boot=91, publication=False):
    await h.service.observe_worker(
        {
            "workerBootId": nonce(boot),
            "sequence": sequence,
            "ready": ready,
            "jobs": []
            if job is None
            else [{**job, "phase": phase, "publicationPending": publication}],
        }
    )


@pytest.mark.asyncio
async def test_durable_worker_is_required_even_with_zero_data_flows():
    h = await harness()
    h.service.effects.worker_required = True
    await observed(h, [])
    h.clock.advance(1)
    value = commit(h)
    await h.service.observe_commit(value)
    await h.service.invalidate_authority()
    assert (await snapshot(h, value))["effectState"] == "unknown"
    await worker(h, None, ready=False)
    assert (await snapshot(h, value))["effectState"] == "unknown"
    await worker(h, None, sequence=2)
    assert (await snapshot(h, value))["effectState"] == "effective"


@pytest.mark.asyncio
async def test_durable_job_requires_same_boot_attempt_and_actual_no_pending_publication():
    h = await harness()
    h.service.effects.worker_required = True
    job = worker_job()
    await worker(h, job, publication=True)
    await observed(h, [])
    h.clock.advance(1)
    value = {**commit(h), "affectedJobs": [job], "affectedJobsComplete": True}
    await h.service.observe_commit(value)
    await h.service.invalidate_authority()
    initial = await snapshot(h, value)
    assert initial["effectState"] == "pending" and initial["native"]["targetOperations"] == 1
    with pytest.raises(wire.DataProtocolError):
        await worker(h, job, sequence=2, phase="closed", publication=True)
    await worker(h, {**job, "attempt": 1}, sequence=2, phase="closed")
    assert (await snapshot(h, value))["effectState"] == "unknown"
    await worker(h, {**job, "stateVersion": 5}, sequence=3, phase="closed")
    final = await snapshot(h, value)
    assert final["effectState"] == "effective" and final["native"]["closedOperations"] == 1


@pytest.mark.asyncio
async def test_known_unready_worker_boot_can_later_prove_real_drain_without_permanent_unknown():
    h = await harness()
    h.service.effects.worker_required = True
    job = worker_job()
    await worker(h, job, ready=False, publication=True)
    await observed(h, [])
    h.clock.advance(1)
    value = {**commit(h), "affectedJobs": [job], "affectedJobsComplete": True}
    await h.service.observe_commit(value)
    await h.service.invalidate_authority()
    assert (await snapshot(h, value))["effectState"] == "unknown"
    await worker(h, job, sequence=2, ready=True, phase="closed")
    assert (await snapshot(h, value))["effectState"] == "effective"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reason", ["no_provider", "new_boot", "overflow", "stale", "wrong_binding", "wrong_version"]
)
async def test_durable_uncertainty_cannot_be_silently_counted_as_no_work(reason):
    h = await harness()
    job = worker_job()
    if reason != "no_provider":
        h.service.effects.worker_required = True
        await worker(h, job)
    await observed(h, [])
    h.clock.advance(1)
    value = {**commit(h), "affectedJobs": [job], "affectedJobsComplete": reason != "overflow"}
    await h.service.observe_commit(value)
    await h.service.invalidate_authority()
    if reason == "new_boot":
        await worker(h, job, sequence=1, boot=92, phase="closed")
    if reason == "overflow":
        await worker(h, job, sequence=2, phase="closed")
    if reason == "stale":
        h.clock.advance(1001)
    if reason == "wrong_binding":
        await worker(h, {**job, "bindingId": "other:binding"}, sequence=2, phase="closed")
    if reason == "wrong_version":
        await worker(h, {**job, "stateVersion": 3}, sequence=2, phase="closed")
    assert (await snapshot(h, value))["effectState"] == "unknown"
