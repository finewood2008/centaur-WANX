"""Synthetic offline BLE sessions: no network, production files or credentials."""

import asyncio
import copy
import json
import os
import sqlite3
import tempfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Event
from time import monotonic
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from test_local_authority_store import NOW
from test_local_ledger import activate, commit, manager_target, new_material, prepare, verified
from test_local_ledger import ledger as _ledger
from test_local_ledger import provisioned as _provisioned

from wanx_bridge import local_authority_store as store
from wanx_bridge import local_ledger_engine as engine
from wanx_bridge import local_management_protocol as wire
from wanx_bridge import local_wifi_protocol as protocol
from wanx_bridge.local_wifi_authority import LocalWifiAuthority


@pytest.fixture
def provisioned(tmp_path):
    return _provisioned.__wrapped__(tmp_path)


@pytest.fixture
def ledger(provisioned):
    yield from _ledger.__wrapped__(provisioned)


def authorize(local, device=None, *, issuer=None, delegable=True, expires=None, now=NOW + 11):
    device = device or local.root
    review = prepare(
        local,
        "network-wifi.authorize",
        {
            "bindingId": device.binding_id,
            "expiresAt": expires,
            "delegable": delegable,
        },
        device=issuer,
        now=now,
    )
    return commit(local, review, device=issuer, now=now)


def revoke(local, device=None, *, issuer=None, now=NOW + 15):
    review = prepare(
        local,
        "network-wifi.revoke",
        {"bindingId": (device or local.root).binding_id},
        device=issuer,
        now=now,
    )
    return commit(local, review, device=issuer, now=now)


def add_manager(local, *, capabilities=None, now=NOW + 12):
    device = manager_target(principal_id=local.root.payload["principalId"])
    if capabilities is not None:
        device.target["capabilities"] = sorted(capabilities)
    review = prepare(local, "device.add-manager", {"target": device.target}, now=now)
    ack, _ = commit(local, review, target=device, now=now)
    device.binding_id = verified(local, ack, "mutation-ack")["result"]["bindingId"]
    return device


def intent(local, device=None, *, ble=None, **changes):
    device = device or local.root
    ble = ble or {
        "pairingSessionId": "ble:" + os.urandom(8).hex(),
        "challengeCanonicalSha256": "a" * 64,
        "rsaSpkiSha256": "b" * 64,
    }
    value = protocol.payload(
        "intent",
        boxId="box:test",
        boxKeyThumbprint=local.authority._meta()["boxKeyThumbprint"],
        ownershipEpoch=1,
        bindingId=device.binding_id,
        clientId=device.payload["clientId"],
        ble=ble,
        nonce=wire.evidence._encode(os.urandom(32)),
    )
    value.update(changes)
    return {"ble": ble, "intentProof": protocol.sign("intent", value, device.access)}


def open_session(local, wifi, *, device=None, now=NOW + 13):
    device = device or local.root
    first = intent(local, device)
    challenge = wifi.challenge(first, now)["challenge"]
    value = protocol.decode("challenge", challenge)
    access = protocol.payload(
        "session-access", challengeDigest=protocol.digest(value), tokenCiphertextSha256="c" * 64
    )
    body = {
        "challenge": challenge,
        "accessProof": protocol.sign("session-access", access, device.access),
        "ble": first["ble"],
        "tokenCiphertextSha256": "c" * 64,
    }
    receipt = wifi.session(body, now)["sessionReceipt"]
    return SimpleNamespace(
        ble=first["ble"],
        challenge=challenge,
        session_body=body,
        receipt=receipt,
        value=protocol.decode("session-receipt", receipt),
        device=device,
    )


def apply_body(session, **changes):
    observed = {"requestId": "request:test", "counter": "1", "ciphertextSha256": "d" * 64}
    observed.update(changes)
    value = protocol.payload(
        "apply",
        sessionDigest=protocol.digest(session.value),
        applyNonce=session.value["applyNonce"],
        **observed,
    )
    return {
        "sessionReceipt": session.receipt,
        "ble": session.ble,
        "observed": observed,
        "approvalProof": protocol.sign("apply", value, session.device.approval),
    }


@pytest.fixture
def wifi(ledger):
    authorize(ledger)
    return LocalWifiAuthority(ledger.authority)


def test_offline_fresh_proofs_consume_exactly_once_and_report_idempotently(ledger, wifi):
    session = open_session(ledger, wifi)
    check = wifi.check({"sessionReceipt": session.receipt, "ble": session.ble}, NOW + 14)
    assert check["valid"] is True
    body = apply_body(session)
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(lambda _: wifi.consume(body, NOW + 14), range(12)))
    assert sum(result["execute"] for result in results) == 1
    first = next(result for result in results if result["execute"])
    for result in results:
        signed = protocol.verify(
            "execution-receipt", result["executionReceipt"], ledger.provisioned.bundle["boxKey"]
        )
        assert signed["execute"] == result["execute"]
    report = {"executionReceipt": first["executionReceipt"], "outcome": "succeeded"}
    result = wifi.result(report, NOW + 15)
    assert wifi.result(report, NOW + 16) == result
    assert wifi.consume(body, NOW + 16)["execute"] is False
    with pytest.raises(protocol.LocalWifiError, match="RESULT_CONFLICT"):
        wifi.result({**report, "outcome": "failed"}, NOW + 16)
    with pytest.raises(protocol.LocalWifiError, match="REPLAY"):
        wifi.consume(apply_body(session, requestId="request:other"), NOW + 16)


def test_role_and_cloud_identity_are_not_network_authority(ledger):
    wifi = LocalWifiAuthority(ledger.authority)
    for device in (ledger.root, ledger.use):
        with pytest.raises(protocol.LocalWifiError, match="FORBIDDEN"):
            wifi.challenge(intent(ledger, device), NOW + 10)
    assert wifi.db.execute("SELECT count(*) FROM wifi_challenges").fetchone()[0] == 0


def test_real_team_roles_require_explicit_wifi_grants_and_revoke_live_sessions(ledger):
    from test_local_team import activate_team, admit_member, invite_member

    ledger.team = activate_team(ledger)
    manager = invite_member(ledger, role="manager")
    admit_member(ledger, manager)
    owner_before = ledger.authority.get_authorization(ledger.root.binding_id, NOW + 14)
    manager_auth = ledger.authority.get_authorization(manager.binding_id, NOW + 14)
    assert owner_before["team"]["roleId"] == "owner"
    assert manager_auth["team"]["roleId"] == "manager"
    assert "resources.manage" in manager_auth["team"]["permissions"]
    wifi = LocalWifiAuthority(ledger.authority)
    for device in (ledger.root, manager):
        with pytest.raises(protocol.LocalWifiError, match="FORBIDDEN"):
            wifi.challenge(intent(ledger, device), NOW + 14)

    authorize(ledger, now=NOW + 15)
    owner_authorized = ledger.authority.get_authorization(ledger.root.binding_id, NOW + 15)
    assert {"resourceId": "network:wifi", "actions": ["write"]} in owner_authorized["grants"]
    assert owner_authorized["team"]["permissions"] == owner_before["team"]["permissions"]
    assert (
        owner_authorized["team"]["membershipRevision"] > owner_before["team"]["membershipRevision"]
    )
    approved = open_session(ledger, wifi, now=NOW + 16)
    assert wifi.consume(apply_body(approved), NOW + 16)["execute"] is True
    pending = open_session(ledger, wifi, now=NOW + 17)
    with pytest.raises(protocol.LocalWifiError, match="FORBIDDEN"):
        wifi.challenge(intent(ledger, manager), NOW + 17)

    revoke(ledger, now=NOW + 18)
    owner_revoked = ledger.authority.get_authorization(ledger.root.binding_id, NOW + 18)
    assert all(grant["resourceId"] != "network:wifi" for grant in owner_revoked["grants"])
    assert (
        owner_revoked["team"]["membershipRevision"] > owner_authorized["team"]["membershipRevision"]
    )
    with pytest.raises(protocol.LocalWifiError, match="FORBIDDEN"):
        wifi.consume(apply_body(pending), NOW + 19)
    with pytest.raises(protocol.LocalWifiError, match="FORBIDDEN"):
        wifi.challenge(intent(ledger), NOW + 19)


@pytest.mark.parametrize(
    "change",
    [
        {"boxId": "box:other"},
        {"ownershipEpoch": 2},
        {"clientId": "client:other"},
        {"boxKeyThumbprint": "Z" * 42 + "A"},
    ],
)
def test_intent_rejects_cross_box_epoch_client_and_descriptor(ledger, wifi, change):
    with pytest.raises(protocol.LocalWifiError, match="CONTEXT_CHANGED"):
        wifi.challenge(intent(ledger, **change), NOW + 13)


def test_old_cloud_or_access_key_cannot_replace_approval_key(ledger, wifi):
    session = open_session(ledger, wifi)
    body = apply_body(session)
    proof = protocol.decode("apply", body["approvalProof"])
    body["approvalProof"] = protocol.sign("apply", proof, ledger.root.access)
    with pytest.raises(protocol.LocalWifiError, match="UNAUTHORIZED"):
        wifi.consume(body, NOW + 14)
    request = intent(ledger)
    value = protocol.decode("intent", request["intentProof"])
    request["intentProof"] = protocol.sign("intent", value, ec.generate_private_key(ec.SECP256R1()))
    with pytest.raises(protocol.LocalWifiError, match="UNAUTHORIZED"):
        wifi.challenge(request, NOW + 14)
    assert wifi.db.execute("SELECT count(*) FROM wifi_operations").fetchone()[0] == 0


@pytest.mark.parametrize(
    "field,value",
    [("requestId", "request:changed"), ("counter", "2"), ("ciphertextSha256", "e" * 64)],
)
def test_exact_encrypted_request_is_bound_to_per_operation_approval(ledger, wifi, field, value):
    session = open_session(ledger, wifi)
    body = apply_body(session)
    body["observed"][field] = value
    with pytest.raises(protocol.LocalWifiError, match="CONTEXT_CHANGED"):
        wifi.consume(body, NOW + 14)


def test_ble_or_token_substitution_and_consumed_nonce_replay_denied(ledger, wifi):
    request = intent(ledger)
    first = wifi.challenge(request, NOW + 12)
    assert wifi.challenge(request, NOW + 13) == first
    request["ble"] = {**request["ble"], "pairingSessionId": "ble:other"}
    with pytest.raises(protocol.LocalWifiError, match="CONTEXT_CHANGED"):
        wifi.challenge(request, NOW + 13)
    session = open_session(ledger, wifi, now=NOW + 13)
    assert wifi.session(session.session_body, NOW + 13)["sessionReceipt"] == session.receipt
    altered = {**session.session_body, "tokenCiphertextSha256": "e" * 64}
    with pytest.raises(protocol.LocalWifiError, match="CONTEXT_CHANGED"):
        wifi.session(altered, NOW + 13)
    body = apply_body(session)
    body["ble"] = {**body["ble"], "rsaSpkiSha256": "e" * 64}
    with pytest.raises(protocol.LocalWifiError, match="CONTEXT_CHANGED"):
        wifi.consume(body, NOW + 13)


def test_revoke_denies_existing_session_but_accepts_physical_result(ledger, wifi):
    session = open_session(ledger, wifi)
    first = wifi.consume(apply_body(session), NOW + 14)
    revoke(ledger)
    with pytest.raises(protocol.LocalWifiError, match="FORBIDDEN"):
        wifi.check({"sessionReceipt": session.receipt, "ble": session.ble}, NOW + 16)
    with pytest.raises(protocol.LocalWifiError, match="FORBIDDEN"):
        wifi.consume(apply_body(session), NOW + 16)
    wifi.result({"executionReceipt": first["executionReceipt"], "outcome": "succeeded"}, NOW + 16)


def test_expiry_clock_rollback_restart_fail_closed_without_reexecution(ledger, wifi):
    session = open_session(ledger, wifi)
    first = wifi.consume(apply_body(session), NOW + 14)
    with pytest.raises(protocol.LocalWifiError, match="UNAVAILABLE"):
        wifi.check({"sessionReceipt": session.receipt, "ble": session.ble}, NOW + 13)
    with pytest.raises(protocol.LocalWifiError, match="EXPIRED"):
        wifi.consume(apply_body(session), NOW + 134)
    ledger.authority.close()
    ledger.authority = store.LocalTrustAuthority(ledger.provisioned.directory, boot_id="v2:reboot")
    new = LocalWifiAuthority(ledger.authority)
    # Mutable auxiliary cache columns are never proof of a new boot or lifetime.
    new.db.execute("UPDATE wifi_sessions SET boot_id=?,expires_at=?", ("v2:reboot", NOW + 99999))
    with pytest.raises(protocol.LocalWifiError, match="CONTEXT_CHANGED"):
        new.consume(apply_body(session), NOW + 134)
    assert new.db.execute("SELECT state FROM wifi_operations").fetchone()[0] == "interrupted"
    with pytest.raises(protocol.LocalWifiError, match="RESULT_CONFLICT"):
        new.result(
            {"executionReceipt": first["executionReceipt"], "outcome": "succeeded"}, NOW + 134
        )


def test_challenge_quota_is_authenticated_and_bounded_per_binding(ledger, wifi):
    for _ in range(4):
        wifi.challenge(intent(ledger), NOW + 13)
    with pytest.raises(protocol.LocalWifiError, match="CAPACITY"):
        wifi.challenge(intent(ledger), NOW + 13)
    assert wifi.db.execute("SELECT count(*) FROM wifi_challenges").fetchone()[0] == 4
    wifi.challenge(intent(ledger), NOW + 134)


def test_permission_governance_shared_namespace_and_narrow_revocation(ledger):
    activate(ledger)
    manager = add_manager(ledger, capabilities={"device.approve_manage", "device.approve_use"})
    with pytest.raises(Exception, match="SCOPE_EXCEEDED"):
        authorize(ledger, manager, issuer=manager, now=NOW + 13)
    authorize(ledger, now=NOW + 13)
    authorize(ledger, manager, now=NOW + 14)
    snapshot = ledger.authority._ledger.snapshot(ledger.authority._meta())
    grant = next(
        item
        for item in engine.effective_grants(
            snapshot, engine.binding(snapshot, manager.binding_id), NOW + 14
        )
        if item["resourceId"] == "network:wifi"
    )
    assert grant["resourceScope"] == "shared" and grant["sourceBindingId"] == ledger.root.binding_id
    wifi = LocalWifiAuthority(ledger.authority)
    session = open_session(ledger, wifi, device=manager, now=NOW + 14)
    with pytest.raises(Exception, match="SCOPE_EXCEEDED"):
        revoke(ledger, ledger.root, issuer=manager, now=NOW + 15)
    revoke(ledger, now=NOW + 15)
    with pytest.raises(protocol.LocalWifiError, match="FORBIDDEN"):
        wifi.consume(apply_body(session), NOW + 16)
    snapshot = ledger.authority._ledger.snapshot(ledger.authority._meta())
    assert [
        item["resourceId"]
        for item in engine.effective_grants(
            snapshot, engine.binding(snapshot, manager.binding_id), NOW + 16
        )
    ] == ["space:personal"]


def test_existing_transfer_capability_can_explicitly_enable_self_only(ledger):
    activate(ledger)
    manager = add_manager(ledger)
    with pytest.raises(Exception, match="SCOPE_EXCEEDED"):
        authorize(ledger, ledger.root, issuer=manager, now=NOW + 13)
    authorize(ledger, manager, issuer=manager, now=NOW + 13)
    wifi = LocalWifiAuthority(ledger.authority)
    session = open_session(ledger, wifi, device=manager, now=NOW + 14)
    assert wifi.consume(apply_body(session), NOW + 14)["execute"] is True


@pytest.mark.parametrize("full", [False, True])
def test_recovery_does_not_create_network_governance_beyond_existing_capability(full, ledger):
    activate(ledger)
    source = (
        ledger.root
        if full
        else add_manager(ledger, capabilities={"device.approve_use", "recovery.configure"})
    )
    signing, material = new_material(1)
    setup = prepare(
        ledger,
        "recovery.setup",
        {"expectedRecoveryVersion": 0, "newRecovery": material},
        device=source,
        now=NOW + 13,
    )
    commit(ledger, setup, device=source, material=signing, now=NOW + 13)
    offline = SimpleNamespace(
        identity={
            "kind": "recovery",
            "principalId": ledger.root.payload["principalId"],
            "bindingId": None,
            "keyVersion": 1,
        },
        access=signing,
        approval=signing,
    )
    next_signing, next_material = new_material(2)
    target = manager_target(principal_id=ledger.root.payload["principalId"])
    minimal = {
        key: target.target[key] for key in ("clientId", "accessKey", "approvalKey", "keyProtection")
    }
    review = prepare(
        ledger,
        "recovery.recover",
        {
            "expectedRecoveryVersion": 1,
            "expectedPrincipalSecurityVersion": 1,
            "newRecovery": next_material,
            "target": minimal,
        },
        device=offline,
        now=NOW + 14,
    )
    ack, _ = commit(
        ledger, review, device=offline, target=target, material=next_signing, now=NOW + 14
    )
    target.binding_id = verified(ledger, ack, "mutation-ack")["result"]["bindingId"]
    wifi = LocalWifiAuthority(ledger.authority)
    with pytest.raises(protocol.LocalWifiError, match="FORBIDDEN"):
        wifi.challenge(intent(ledger, target), NOW + 15)
    if full:
        authorize(ledger, target, issuer=target, now=NOW + 15)
        session = open_session(ledger, wifi, device=target, now=NOW + 16)
        assert wifi.consume(apply_body(session), NOW + 16)["execute"]
    else:
        with pytest.raises(Exception, match="SCOPE_EXCEEDED"):
            authorize(ledger, target, issuer=target, now=NOW + 15)


def test_root_reenable_respects_live_principal_expiry_then_can_explicitly_renew(ledger):
    authorize(ledger, expires=NOW + 30)
    revoke(ledger)
    for deadline in (None, NOW + 31):
        with pytest.raises(Exception, match="SCOPE_EXCEEDED"):
            authorize(ledger, expires=deadline, now=NOW + 16)
    authorize(ledger, expires=NOW + 29, now=NOW + 16)
    revoke(ledger, now=NOW + 17)
    authorize(ledger, expires=None, now=NOW + 31)
    wifi = LocalWifiAuthority(ledger.authority)
    session = open_session(ledger, wifi, now=NOW + 31)
    assert session.value["expiresAt"] == NOW + 151


def test_cross_principal_invite_cannot_carry_network_but_same_principal_manager_can(ledger):
    activate(ledger)
    authorize(ledger)
    target = manager_target(principal_id=ledger.root.payload["principalId"])
    target.target["grants"] = [
        {"resourceId": "network:wifi", "actions": ["write"]},
        *target.target["grants"],
    ]
    target.target["delegableGrants"] = copy.deepcopy(target.target["grants"])
    with pytest.raises(Exception):
        prepare(
            ledger,
            "principal.invite",
            {"principalId": "principal:other", "target": target.target},
            now=NOW + 12,
        )
    review = prepare(ledger, "device.add-manager", {"target": target.target}, now=NOW + 12)
    ack, _ = commit(ledger, review, target=target, now=NOW + 12)
    target.binding_id = verified(ledger, ack, "mutation-ack")["result"]["bindingId"]
    wifi = LocalWifiAuthority(ledger.authority)
    session = open_session(ledger, wifi, device=target, now=NOW + 13)
    assert wifi.consume(apply_body(session), NOW + 13)["execute"]


def test_any_committed_authorization_change_invalidates_old_session(ledger):
    activate(ledger)
    authorize(ledger)
    wifi = LocalWifiAuthority(ledger.authority)
    session = open_session(ledger, wifi)
    add_manager(ledger, now=NOW + 14)
    with pytest.raises(protocol.LocalWifiError, match="CONTEXT_CHANGED"):
        wifi.consume(apply_body(session), NOW + 15)


def test_nonce_reuse_cannot_mint_a_new_challenge_after_changed_ble_or_expiry(ledger, wifi):
    request = intent(ledger)
    wifi.challenge(request, NOW + 13)
    value = protocol.decode("intent", request["intentProof"])
    value["ble"] = {**value["ble"], "pairingSessionId": "ble:other"}
    altered = {
        "intentProof": protocol.sign("intent", value, ledger.root.access),
        "ble": value["ble"],
    }
    with pytest.raises(protocol.LocalWifiError, match="REPLAY"):
        wifi.challenge(altered, NOW + 14)
    with pytest.raises(protocol.LocalWifiError, match="EXPIRED"):
        wifi.challenge(request, NOW + 134)
    assert wifi.db.execute("SELECT count(*) FROM wifi_challenges").fetchone()[0] == 1


def test_unreported_consumption_has_bounded_retention_without_reopening_old_nonce(
    ledger, wifi, monkeypatch
):
    from wanx_bridge import local_wifi_authority as module

    session = open_session(ledger, wifi)
    wifi.consume(apply_body(session), NOW + 14)
    monkeypatch.setattr(module, "MAX_RETAINED", 1)
    later = NOW + module.RETENTION + 150
    fresh = open_session(ledger, wifi, now=later)
    assert wifi.consume(apply_body(fresh), later)["execute"]
    with pytest.raises(protocol.LocalWifiError):
        wifi.consume(apply_body(session), later)


@asynccontextmanager
async def live_ipc(ledger, wifi, monkeypatch):
    from wanx_bridge import local_wifi_broker as broker_module
    from wanx_bridge.local_trust_service import LocalTrustService

    clock = {"now": NOW + 13}
    queued = asyncio.Event()
    monkeypatch.setattr(broker_module, "time", SimpleNamespace(time=lambda: clock["now"]))
    monkeypatch.setattr(broker_module, "peer_uid", lambda _: 0)
    service = LocalTrustService(ledger.authority)

    async def execute(fn, *args):
        queued.set()
        return await service.execute_authority(fn, *args)

    with tempfile.TemporaryDirectory(prefix="wifi-fence-") as temporary:
        parent = Path(temporary).resolve()
        parent.chmod(0o700)
        broker = broker_module.LocalWifiBroker(
            wifi,
            execute_authority=execute,
            socket_path=parent / "network.sock",
            _owner_uid=os.geteuid(),
            _owner_gid=parent.stat().st_gid,
        )
        await broker.start()
        try:
            yield broker, service, clock, queued
        finally:
            await broker.close()
            await service.close()


@pytest.mark.asyncio
async def test_queued_ipc_samples_time_after_shared_execution_lock(ledger, monkeypatch):
    from test_local_wifi_broker import packet, request

    authorize(ledger, expires=NOW + 14)
    wifi = LocalWifiAuthority(ledger.authority)
    session = open_session(ledger, wifi, now=NOW + 12)
    async with live_ipc(ledger, wifi, monkeypatch) as (broker, service, clock, queued):
        service._execution_lock.acquire()
        pending = asyncio.create_task(
            request(broker, packet("/v1/wifi/consume", json.dumps(apply_body(session)).encode()))
        )
        try:
            await asyncio.wait_for(queued.wait(), 1)
            clock["now"] = NOW + 15
        finally:
            service._execution_lock.release()
        status, value = await pending
        assert status == 403 and value["code"] in {"LOCAL_WIFI_FORBIDDEN", "LOCAL_WIFI_EXPIRED"}
        assert wifi.db.execute("SELECT count(*) FROM wifi_operations").fetchone()[0] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("disconnect", [False, True])
async def test_timeout_or_disconnect_cannot_consume_after_leaving_executor_queue(
    ledger, wifi, monkeypatch, disconnect
):
    from test_local_wifi_broker import packet, request

    session = open_session(ledger, wifi)
    async with live_ipc(ledger, wifi, monkeypatch) as (broker, service, _, queued):
        service._execution_lock.acquire()
        reader, writer = await asyncio.open_unix_connection(broker.socket_path)
        try:
            writer.write(packet("/v1/wifi/consume", json.dumps(apply_body(session)).encode()))
            await writer.drain()
            await asyncio.wait_for(queued.wait(), 1)
            if disconnect:
                writer.close()
                await writer.wait_closed()
                await asyncio.wait_for(asyncio.gather(*tuple(broker.tasks)), 1)
            else:
                response = await asyncio.wait_for(reader.read(), 3)
                assert b"503" in response and b"LOCAL_WIFI_UNAVAILABLE" in response
            assert service._active["data"] == 1
        finally:
            service._execution_lock.release()
            writer.close()
            await writer.wait_closed()
        await asyncio.gather(
            *(asyncio.shield(job) for job in tuple(service._jobs)), return_exceptions=True
        )
        assert wifi.db.execute("SELECT count(*) FROM wifi_operations").fetchone()[0] == 0
        status, result = await request(
            broker, packet("/v1/wifi/consume", json.dumps(apply_body(session)).encode())
        )
        assert status == 200 and result["execute"] is True


@pytest.mark.asyncio
async def test_timeout_before_consume_commit_rolls_back_the_nonce(ledger, wifi, monkeypatch):
    from test_local_wifi_broker import packet, request

    session = open_session(ledger, wifi)
    started, release = asyncio.Event(), Event()
    loop = asyncio.get_running_loop()
    original = wifi._signed

    def paused_sign(kind, **values):
        proof = original(kind, **values)
        if kind == "execution-receipt":
            loop.call_soon_threadsafe(started.set)
            assert release.wait(4)
        return proof

    monkeypatch.setattr(wifi, "_signed", paused_sign)
    async with live_ipc(ledger, wifi, monkeypatch) as (broker, service, _, _):
        pending = asyncio.create_task(
            request(broker, packet("/v1/wifi/consume", json.dumps(apply_body(session)).encode()))
        )
        try:
            await asyncio.wait_for(started.wait(), 1)
            assert await pending == (503, {"code": "LOCAL_WIFI_UNAVAILABLE"})
        finally:
            release.set()
        await asyncio.gather(
            *(asyncio.shield(job) for job in tuple(service._jobs)), return_exceptions=True
        )
        assert wifi.db.execute("SELECT count(*) FROM wifi_operations").fetchone()[0] == 0


@pytest.mark.asyncio
async def test_lost_response_after_committed_consume_never_reissues_execution(
    ledger, wifi, monkeypatch
):
    from test_local_wifi_broker import packet, request

    session = open_session(ledger, wifi)
    async with live_ipc(ledger, wifi, monkeypatch) as (broker, service, _, _):
        committed = asyncio.Event()

        async def lost_reply(fn, *args):
            await service.execute_authority(fn, *args)
            committed.set()
            await asyncio.Event().wait()

        broker.execute_authority = lost_reply
        raw = packet("/v1/wifi/consume", json.dumps(apply_body(session)).encode())
        pending = asyncio.create_task(request(broker, raw))
        await asyncio.wait_for(committed.wait(), 1)
        assert await pending == (503, {"code": "LOCAL_WIFI_UNAVAILABLE"})
        assert wifi.db.execute("SELECT state FROM wifi_operations").fetchone()[0] == "consumed"
        broker.execute_authority = service.execute_authority
        status, result = await request(broker, raw)
        assert status == 200 and result["execute"] is False


def test_sqlite_writer_wait_and_precommit_time_are_inside_expiry_fence(ledger, monkeypatch):
    authorize(ledger, expires=NOW + 14)
    wifi = LocalWifiAuthority(ledger.authority)
    session = open_session(ledger, wifi, now=NOW + 12)
    body = apply_body(session)
    clock = {"now": NOW + 13}
    began = Event()
    wifi.db.set_trace_callback(lambda sql: began.set() if sql == "BEGIN IMMEDIATE" else None)

    path = wifi.db.execute("PRAGMA database_list").fetchone()[2]
    other = sqlite3.connect(path)
    other.execute("BEGIN IMMEDIATE")
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(
            wifi.dispatch, "consume", body, Event(), monotonic() + 5, lambda: clock["now"]
        )
        try:
            assert began.wait(1)
            clock["now"] = NOW + 15
        finally:
            other.rollback()
            other.close()
        with pytest.raises(protocol.LocalWifiError, match="FORBIDDEN|EXPIRED"):
            future.result()
    wifi.db.set_trace_callback(None)
    assert wifi.db.execute("SELECT count(*) FROM wifi_operations").fetchone()[0] == 0


def test_expiry_during_signature_verification_is_rechecked_before_commit(ledger, monkeypatch):
    authorize(ledger, expires=NOW + 14)
    wifi = LocalWifiAuthority(ledger.authority)
    session = open_session(ledger, wifi, now=NOW + 12)
    clock = {"now": NOW + 13}
    original = wifi._signed

    def clock_crossing_sign(kind, **values):
        proof = original(kind, **values)
        if kind == "execution-receipt":
            clock["now"] = NOW + 15
        return proof

    monkeypatch.setattr(wifi, "_signed", clock_crossing_sign)
    with pytest.raises(protocol.LocalWifiError, match="EXPIRED"):
        wifi.dispatch(
            "consume", apply_body(session), Event(), monotonic() + 5, lambda: clock["now"]
        )
    assert wifi.db.execute("SELECT count(*) FROM wifi_operations").fetchone()[0] == 0


def test_failed_postqueue_expiry_persists_observed_clock_highwater(ledger, monkeypatch):
    authorize(ledger, expires=NOW + 14)
    wifi = LocalWifiAuthority(ledger.authority)
    session = open_session(ledger, wifi, now=NOW + 12)
    clock = {"now": NOW + 13}
    original = wifi._signed

    def crossing(kind, **values):
        proof = original(kind, **values)
        if kind == "execution-receipt":
            clock["now"] = NOW + 15
        return proof

    monkeypatch.setattr(wifi, "_signed", crossing)
    with pytest.raises(protocol.LocalWifiError, match="EXPIRED"):
        wifi.dispatch(
            "consume", apply_body(session), Event(), monotonic() + 5, lambda: clock["now"]
        )
    monkeypatch.setattr(wifi, "_signed", original)
    clock["now"] = NOW + 13
    with pytest.raises(protocol.LocalWifiError, match="UNAVAILABLE"):
        wifi.dispatch(
            "consume", apply_body(session), Event(), monotonic() + 5, lambda: clock["now"]
        )
    assert ledger.authority._meta()["lastSeenNow"] == NOW + 15
    assert wifi.db.execute("SELECT count(*) FROM wifi_operations").fetchone()[0] == 0
