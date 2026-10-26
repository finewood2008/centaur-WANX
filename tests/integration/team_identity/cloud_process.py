"""Disposable real Consumer SQL fixture used by the cross-repository test.

Only synthetic signing keys are injected. Identity issue, box receipt sync,
projection, authenticated DeviceKey ACK and status reads use production services.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace


async def main() -> None:
    source = Path(os.environ["TEAM_IDENTITY_ADMIN_SOURCE"]) / "admin-backend"
    sys.path[:0] = [str(source), str(source / "tests/module_nexus")]
    import pytest
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from module_nexus.entity.do import nexus_consumer_auth_do as consumer
    from module_nexus.entity.do.nexus_omnia_sso_do import NexusOmniaDeviceMembership as Member
    from module_nexus.entity.do.nexus_team_identity_do import NexusTeamBoxAuthority as Pin
    from module_nexus.entity.vo.nexus_consumer_auth_vo import ConsumerAuthorizationAckRequest
    from module_nexus.service import team_identity_protocol as wire
    from module_nexus.service.nexus_consumer_pairing_v2_service import (
        NexusConsumerPairingV2Service as Projection,
    )
    from module_nexus.service.team_identity_service import TeamIdentityService as Service
    from sqlalchemy import select
    from test_network_box_access import database
    from test_team_identity import team as fixture

    patch = pytest.MonkeyPatch()
    database_generator = database.__wrapped__(patch)
    maker = await anext(database_generator)
    state = await fixture.__wrapped__(maker, patch)
    owner_client = ec.generate_private_key(ec.SECP256R1())
    async with maker() as db:
        owner = await db.get(consumer.NexusConsumerAppClient, "client-1")
        owner.public_key = (
            owner_client.public_key()
            .public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
            )
            .decode("ascii")
        )
        await db.commit()
    public = state.cloud.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    print(
        json.dumps(
            {
                "ready": True,
                "policy": {
                    "schemaVersion": 1,
                    "type": "centuarai-team-identity-policy",
                    "issuer": wire.ISSUER,
                    "audience": "centuarai-local-team-identity",
                    "kid": "team-test-key",
                    "publicKey": {"kty": "OKP", "crv": "Ed25519", "x": wire.b64(public)},
                    "maximumProofLifetimeSeconds": 300,
                },
            }
        ),
        flush=True,
    )
    configured = False
    try:
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "close":
                break
            try:
                now = datetime.fromtimestamp(command.get("now", 1792886411), UTC)
                if operation == "configure-box":
                    assert not configured
                    async with maker() as db:
                        pin = await db.get(Pin, "registry-1")
                        pin.box_id = command["boxId"]
                        pin.box_key_thumbprint = wire.thumbprint(command["boxKey"])
                        pin.public_key_json = wire.canonical(command["boxKey"]).decode("ascii")
                        pin.ownership_epoch = command["ownershipEpoch"]
                        await db.commit()
                    configured = True
                    value = {"configured": True}
                elif operation == "issue":
                    assert configured
                    request = command["request"]
                    owner = command["actor"] == "owner"
                    context = SimpleNamespace(
                        account_id="account-1" if owner else "member",
                        client_id="client-1" if owner else "member-client",
                        account_auth_version=4,
                        client_session_version=5,
                        access_expires_at=None,
                    )
                    body = {
                        "deviceId": "registry-1",
                        "boxId": request["boxId"],
                        "boxKeyThumbprint": request["boxKeyThumbprint"],
                        "ownershipEpoch": request["ownershipEpoch"],
                        "requestDigest": wire.digest(request),
                        "invitationId": request["invitationId"],
                        "targetAccessKey": request["target"]["accessKey"],
                        "targetApprovalKey": request["target"]["approvalKey"],
                        "nonce": command["nonce"],
                        "requestId": command["requestId"],
                    }
                    async with maker() as db:
                        value = await Service.issue(db, context, body, now=now)
                elif operation == "sync":
                    async with maker() as db:
                        value = await Service.sync(db, command["receipt"], now=now)
                elif operation == "ack":
                    async with maker() as db:
                        update = (
                            await db.execute(select(consumer.NexusConsumerAuthorizationUpdate))
                        ).scalar_one()
                        payload = ConsumerAuthorizationAckRequest(
                            authorization_update_id=update.authorization_update_id,
                            binding_id=update.binding_id,
                            ownership_epoch=update.ownership_epoch,
                            auth_version=update.auth_version,
                            snapshot_sha256=update.snapshot_sha256,
                            result="applied",
                        )
                        value = await Projection.acknowledge_authorization(
                            db,
                            registry_device_id="registry-1",
                            device_key="test-only-device-secret",
                            payload=payload,
                            now=now,
                        )
                elif operation == "status":
                    async with maker() as db:
                        grants = list(
                            await db.scalars(select(consumer.NexusConsumerDeviceClientGrant))
                        )
                        members = list(await db.scalars(select(Member)))
                        value = {
                            "grants": [
                                {
                                    "accountId": g.account_id,
                                    "clientId": g.client_id,
                                    "status": g.status,
                                    "scopes": json.loads(g.scopes),
                                }
                                for g in grants
                            ],
                            "members": [
                                {"accountId": m.account_id, "status": m.status, "role": m.role}
                                for m in members
                            ],
                        }
                else:
                    raise ValueError("UNKNOWN_FIXTURE_OPERATION")
                print(json.dumps({"ok": True, "value": value}), flush=True)
            except Exception as error:
                print(
                    json.dumps(
                        {
                            "ok": False,
                            "code": getattr(error, "code", type(error).__name__),
                            "message": str(error),
                        }
                    ),
                    flush=True,
                )
    finally:
        await database_generator.aclose()
        patch.undo()


if __name__ == "__main__":
    asyncio.run(main())
