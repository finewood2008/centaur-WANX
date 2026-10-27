"""Synthetic host control around actual OS erase/ledger/redelivery code."""
import base64
import os
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

WORKSPACE = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(WORKSPACE / "centuarai-os/tests"))
from deployment import box_reset as reset  # noqa: E402
from deployment import local_trust_backup_crypto as wire  # noqa: E402
from deployment.local_trust_operations import ARCHIVES, WORKER, Paths, _read, _write  # noqa: E402
from deployment.local_trust_transfer import (  # noqa: E402
    CLIPBOARD,
    CONTROL,
    DELIVERY,
    TRANSFER,
    Executor,
    InboxControl,
    TransferProvider,
)
from test_box_reset import DEVICE, RESET_ID, FakeRuntime  # noqa: E402


class DirectControl(InboxControl):
    def __init__(self, paths, executor):
        super().__init__(paths)
        self.executor = executor

    def call(self, action, operation_id):
        return self.executor.execute({"schemaVersion": 1, "type": "centuarai-local-operation-control",
            "requestId": wire.encode(os.urandom(32)), "operationId": operation_id, "action": action})


class TransferFixture:
    def __init__(self, root, authority):
        self.paths = Paths(root)
        for logical in (CONTROL, WORKER, ARCHIVES, TRANSFER, DELIVERY):
            self.paths.private(logical, create=True)
        self.runtime = FakeRuntime(root)
        self.runtime.write(reset.IDENTITY, {"device_id": DEVICE})
        self.key = ed25519.Ed25519PrivateKey.generate()
        public = self.key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        for trust in (reset.RESET_TRUST, reset.HANDOFF_TRUST):
            target = self.runtime.path(trust + "/test.pem")
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            target.write_bytes(public)
            target.chmod(0o644)
        self.runtime.write(reset.MARKER, self.sign({"schemaVersion": 2, "deviceId": DEVICE,
            "handoffId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "handoffGeneration": 1,
            "setupWindowSeconds": 600, "issuedAt": "2026-01-01T00:00:00Z"}, reset.HANDOFF_DOMAIN))
        self.business_roots = (reset.RESOURCES[0], reset.RESOURCES[2], CLIPBOARD, WORKER, ARCHIVES,
                               "/var/lib/centauros/local-trust/data-staging")
        for logical in self.business_roots:
            target = self.runtime.path(logical)
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
            (target / "private-data").write_bytes(b"synthetic old owner private bytes")
        self.external_backup = root.parent / "independent-external-backup.cxb"
        self.external_backup.write_bytes(b"synthetic independently saved encrypted archive")
        self.external_backup.chmod(0o600)
        self.executor = Executor(root=root, runtime=self.runtime, clock=lambda: int(time.time()))
        self.control = DirectControl(self.paths, self.executor)
        self.attach(authority)

    def attach(self, authority):
        self.authority = authority
        self.provider = TransferProvider(authority, self.paths, self.control, clock=lambda: int(time.time()))
        authority.configure_transfer_provider(self.provider)

    def sign(self, value, domain):
        return {"payload": value, "algorithm": "Ed25519", "keyId": "test",
                "signature": base64.b64encode(self.key.sign(domain + reset.canonical(value))).decode()}

    def authorize(self, transfer_id):
        plan = _read(self.provider._plan(transfer_id))["osPreview"]["plan"]
        now = datetime.now(UTC).replace(microsecond=0)
        permit = self.sign({"schemaVersion": 1, "purpose": "erase", "resetId": RESET_ID, "deviceId": DEVICE,
            "targetEpoch": 2, "handoffGeneration": 2, "scopeManifestSha256": plan["scope_manifest_sha256"],
            "nonce": "b" * 64, "issuedAt": (now - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "expiresAt": (now + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"), "eraseReceiptSha256": ""}, reset.RESET_DOMAIN)
        snapshot = {"authorizationUpdateId": "update", "bindingId": "old-binding", "ownerAccountId": "old-account",
                    "deviceId": DEVICE, "ownershipEpoch": 2, "authVersion": 2, "grants": []}
        snapshot["snapshotSha256"] = reset.digest(snapshot)
        snapshot.update(generatedAt=reset.now_text(), commands=[], supportSessions=[])
        self.runtime.write(reset.AUTHORIZATION + "/consumer-authorization.json", snapshot)
        self.runtime.cloud_state = {"deviceId": DEVICE, "resetId": RESET_ID, "permit": permit}

    def prepare(self, transfer_id):
        approved, permit = self.provider.pending()
        assert approved["transferId"] == transfer_id
        _write(self.paths.at(TRANSFER) / "authorizations" / transfer_id, {"permit": permit})
        self.control.call("transfer.prepare", transfer_id)
        self.authority.mark_erase_started(transfer_id, transfer_id, int(time.time()))

    def finish(self, transfer_id):
        self.control.call("transfer.execute", transfer_id)
        self.authority.complete_verified_redelivery(transfer_id, transfer_id, transfer_id, int(time.time()))
        self.control.call("transfer.publish", transfer_id)

    def inspect(self, transfer_id):
        packet = self.paths.at(DELIVERY) / ("transfer-" + transfer_id + ".json")
        return {"type": "transfer-inspected", "privateFilesRemaining": sum((self.paths.at(root) / "private-data").exists() for root in self.business_roots),
                "externalBackupRetained": self.external_backup.read_bytes() == b"synthetic independently saved encrypted archive",
                "deliveryPacket": None if not packet.exists() else wire.canonical(_read(packet)).decode("ascii")}
