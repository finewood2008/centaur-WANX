"""Synthetic identities through real Consumer, JS proofs, local ledger and cloud ACK."""

from __future__ import annotations

import copy
import importlib
import json
import os
import selectors
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from tests.integration.team_identity.test_cross_runtime import ROOT, client, encoded
from tests.integration.team_identity.test_cross_runtime import bridge as bridge


@pytest.fixture
def history(bridge: Any, tmp_path: Path):
    sys.path.insert(0, str(ROOT / "wanx-bridge/tests"))
    setup = importlib.import_module("test_local_ledger")
    provisioned = setup.provisioned.__wrapped__(tmp_path)
    generator = setup.ledger.__wrapped__(provisioned)
    ledger = next(generator)
    try:
        yield SimpleNamespace(setup=setup, ledger=ledger, now=setup.NOW + 11)
    finally:
        generator.close()


@pytest.fixture
def consumer_process(tmp_path: Path):
    source = Path(os.environ.get("TEAM_IDENTITY_ADMIN_SOURCE", ROOT.parent / "nexusaos-admin"))
    python = os.environ.get("TEAM_IDENTITY_ADMIN_PYTHON")
    if (
        not python
        or not (source / "admin-backend/module_nexus/service/team_identity_service.py").exists()
    ):
        pytest.skip("Coordinated release requires TEAM_IDENTITY_ADMIN_PYTHON and Consumer source")
    env = {
        k: v
        for k, v in os.environ.items()
        if k in {"PATH", "HOME", "USER", "LANG", "TMPDIR", "PYTHONDONTWRITEBYTECODE", "PYTHONPATH"}
    }
    env.update(TEAM_IDENTITY_ADMIN_SOURCE=str(source), APP_ENV="test", NEXUSAOS_ENV_FILE=os.devnull)
    errors = (tmp_path / "consumer-fixture.stderr").open("w+")
    process = subprocess.Popen(
        [python, str(Path(__file__).with_name("cloud_process.py"))],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=errors,
        text=True,
        env=env,
        cwd=source / "admin-backend",
        bufsize=1,
    )

    def receive():
        with selectors.DefaultSelector() as ready:
            ready.register(process.stdout, selectors.EVENT_READ)
            if not ready.select(20):
                raise AssertionError("Consumer fixture response timed out")
        line = process.stdout.readline()
        if not line:
            errors.flush()
            errors.seek(0)
            raise AssertionError(errors.read()[-6000:])
        return json.loads(line)

    def command(operation, **body):
        assert process.stdin is not None
        process.stdin.write(json.dumps({"operation": operation, **body}) + "\n")
        process.stdin.flush()
        return receive()

    try:
        greeting = receive()
        assert greeting["ready"]
        yield SimpleNamespace(policy=greeting["policy"], command=command)
    finally:
        if process.poll() is None:
            process.stdin.write('{"operation":"close"}\n')
            process.stdin.flush()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        errors.close()


def js_sign(mutation, key, purpose):
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode("ascii")
    response = client("sign-mutation", mutation=mutation, privateKey=pem, purpose=purpose)
    assert response["ok"], response
    return response["value"]


def request_for(bridge, ledger, principal_id, target, invitation_id=None):
    context = ledger.authority._context(ledger.authority._meta())
    return {
        "schemaVersion": 1,
        "purpose": "centuarai.team-membership.request",
        **{key: context[key] for key in ("boxId", "boxKeyThumbprint", "ownershipEpoch")},
        "invitationId": invitation_id,
        "principalId": principal_id,
        "target": copy.deepcopy(target),
    }


def issue(consumer, request, actor, now, request_id):
    nonce = encoded(os.urandom(32))
    response = consumer.command(
        "issue", request=request, actor=actor, now=now, nonce=nonce, requestId=request_id
    )
    assert response["ok"], response
    proof = response["value"]["proof"]
    verified = client(
        "verify-cloud",
        proof=proof,
        options={
            "policy": consumer.policy,
            "request": request,
            "accountId": "account-1" if actor == "owner" else "member",
            "clientId": "client-1" if actor == "owner" else "member-client",
            "nonce": nonce,
            "now": now,
        },
    )
    assert verified["ok"], verified
    return proof


def test_cloud_identity_to_local_approval_to_projection_and_terminal_revocation(
    bridge, history, consumer_process
):
    from wanx_bridge import local_ledger_engine as engine
    from wanx_bridge import local_ledger_protocol as protocol

    setup, ledger, now = history.setup, history.ledger, history.now
    consumer = consumer_process
    setup.activate(ledger)
    ledger.authority.configure_team_identity(consumer.policy)
    snapshot = ledger.authority._v2().snapshot(ledger.authority._meta())
    owner = engine.binding(snapshot, ledger.root.binding_id)
    result = consumer.command(
        "configure-box",
        boxId=ledger.authority._meta()["boxId"],
        boxKey=ledger.provisioned.bundle["boxKey"],
        ownershipEpoch=ledger.authority._meta()["ownershipEpoch"],
    )
    assert result["ok"], result
    target = {
        key: owner[key]
        for key in (
            "clientId",
            "accessKey",
            "approvalKey",
            "capabilities",
            "expiresAt",
            "delegationExpiresAt",
        )
    }
    target.update(
        keyProtection="software-passphrase-v1",
        grants=sorted(
            engine.grant_list(engine.effective_grants(snapshot, owner, now))
            + [{"resourceId": "team:management", "actions": ["execute", "read", "write"]}],
            key=lambda row: row["resourceId"],
        ),
        delegableGrants=engine.grant_list(
            engine.effective_grants(snapshot, owner, now, delegation=True), delegate=True
        ),
    )
    owner_request = request_for(bridge, ledger, owner["principalId"], target)
    owner_proof = issue(consumer, owner_request, "owner", now, "owner-link")
    review = setup.prepare(
        ledger,
        "team.activate",
        {"request": owner_request, "cloudProof": owner_proof, "cloudPolicy": consumer.policy},
        now=now,
    )
    mutation = review["mutation"]
    ledger.authority.commit_mutation(
        js_sign(mutation, ledger.root.approval, "mutation"),
        js_sign(mutation, ledger.root.access, "target-access"),
        js_sign(mutation, ledger.root.approval, "target-approval"),
        None,
        None,
        now,
    )

    now += 1
    member = setup.manager_target(principal_id="principal:cloud-member")
    member.target["capabilities"] = sorted(protocol.INVITED_CAPABILITIES)
    invitation = encoded(os.urandom(32))
    invite = setup.prepare(
        ledger,
        "team.invite-create",
        {
            "invitationId": invitation,
            "roleId": "member",
            "targetPolicy": {key: member.target[key] for key in bridge.TARGET_POLICY_FIELDS},
            "expiresAt": now + 3600,
        },
        now=now,
    )
    setup.commit(ledger, invite, now=now)
    request = request_for(bridge, ledger, member.payload["principalId"], member.target, invitation)
    now += 1
    proof = issue(consumer, request, "member", now, "member-join")
    assert consumer.command("status")["value"] == {"grants": [], "members": []}
    with pytest.raises(bridge.evidence.BindingProtocolError):
        setup.prepare(
            ledger, "team.member-admit", {"request": request, "cloudProof": proof}, now=now
        )

    def member_request_sign(purpose, key):
        pem = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("ascii")
        signed = client("sign-request", request=request, purpose=purpose, privateKey=pem)
        assert signed["ok"], signed
        return signed["value"]["proof"]

    ledger.authority.submit_team_request(
        member_request_sign("request-access", member.access),
        member_request_sign("request-approval", member.approval),
        proof,
        now,
    )
    review = setup.prepare(
        ledger, "team.member-admit", {"request": request, "cloudProof": proof}, now=now
    )
    mutation = review["mutation"]
    manager_approval = js_sign(mutation, ledger.root.approval, "mutation")
    with pytest.raises(bridge.evidence.BindingProtocolError):
        ledger.authority.commit_mutation(manager_approval, None, None, None, None, now)
    access_proof = js_sign(mutation, member.access, "target-access")
    approval_proof = js_sign(mutation, member.approval, "target-approval")
    request_id = bridge.request_digest(request)
    ledger.authority.consent_team_request(request_id, access_proof, approval_proof, now)
    ack = ledger.authority.commit_mutation(
        manager_approval, access_proof, approval_proof, None, None, now
    )
    assert (
        ledger.authority.commit_mutation(
            manager_approval, access_proof, approval_proof, None, None, now
        )
        == ack
    )
    ack_value = setup.verified(ledger, ack, "mutation-ack")
    verified_ack = client(
        "verify-response",
        proof=ack,
        options={
            "descriptor": {
                "boxId": ledger.authority._meta()["boxId"],
                "baseUrl": "https://synthetic.invalid",
                "boxKey": ledger.provisioned.bundle["boxKey"],
                "tlsSpkiSha256": encoded(b"T" * 32),
            },
            "kind": "mutation-ack",
            "now": now,
        },
    )
    assert verified_ack["ok"], verified_ack
    assert verified_ack["value"]["body"] == ack_value
    binding_id = ack_value["result"]["bindingId"]
    authorization = ledger.authority.get_authorization(binding_id, now)
    assert authorization["principalId"] == member.payload["principalId"]
    assert authorization["team"]["roleId"] == "member"
    assert authorization["team"]["permissions"] == []
    membership_id = authorization["team"]["membershipId"]
    receipt = setup.read(ledger, "team-association", request_id=membership_id, now=now)["receipt"]
    result = consumer.command("sync", receipt=receipt, now=now)
    assert result["ok"], result
    assert result["value"]["deliveryStatus"] == "deviceAckPending"
    assert consumer.command("ack", now=now)["value"]["accepted"]
    assert consumer.command("sync", receipt=receipt, now=now)["value"]["deliveryStatus"] == "ready"
    status = consumer.command("status")["value"]
    assert status["members"] == [{"accountId": "member", "status": "active", "role": "member"}]
    assert status["grants"] == [
        {
            "accountId": "member",
            "clientId": "member-client",
            "status": "active",
            "scopes": ["remote.p2p"],
        }
    ]

    now += 1
    review = setup.prepare(
        ledger, "team.member-revoke", {"principalId": member.payload["principalId"]}, now=now
    )
    setup.commit(ledger, review, now=now)
    with pytest.raises(bridge.evidence.BindingProtocolError):
        ledger.authority.get_authorization(binding_id, now)
    revoked = setup.read(ledger, "team-association", request_id=membership_id, now=now)["receipt"]
    result = consumer.command("sync", receipt=revoked, now=now)
    assert result["ok"], result
    assert result["value"]["status"] == "revoked"
    assert consumer.command("sync", receipt=receipt, now=now)["ok"] is False
    assert all(row["status"] == "revoked" for row in consumer.command("status")["value"]["grants"])
