"""Disposable real HTTPS authority for desktop integration. No user paths.

Only stdin controls migration/restart of this process's newly generated fixture.
It is not imported by the product or exposed as an HTTP administration endpoint.
"""

import datetime
import hashlib
import ipaddress
import json
import os
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

import uvicorn
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "wanx-bridge"))
from wanx_bridge import local_authority_store as store  # noqa: E402
from wanx_bridge import local_management_protocol as wire  # noqa: E402
from wanx_bridge.local_trust_protocol import _encode  # noqa: E402
from wanx_bridge.local_trust_server import create_app  # noqa: E402
from wanx_bridge.local_trust_service import LocalTrustService  # noqa: E402


def private(path, data):
    path.write_bytes(data)
    path.chmod(0o600)


def emit(value):
    print(json.dumps(value), flush=True)


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    transfer_enabled = sys.argv[1:] == ["--transfer"]
    backup_enabled = transfer_enabled or sys.argv[1:] == ["--backup"]
    if backup_enabled:
        workspace = Path(__file__).resolve().parents[3]
        sys.path.insert(0, str(workspace / "centuarai-os"))
        sys.path.insert(0, str(workspace / "centuarai-semantica"))
        from app.db import JobRepository
        from deployment import local_trust_semantica_profile as profile
        from deployment.local_trust_operations import DATA, Provider

        class TempWriterControl:
            # Only this disposable fixture writes its business data. Real flock
            # is still checked; this is not a claim about systemd writer stops.
            def __init__(self, data):
                self.data = data
            def quiesce(self, operation, *, application="semantica"):
                assert application in ("semantica", "wanx")
                if application == "semantica":
                    with profile.ownership_lock(self.data):
                        pass
                return {"schemaVersion": 1, "operationId": operation, "writersStopped": True}
            def resume(self, operation, *, application="semantica"):
                assert application in ("semantica", "wanx")
                pass
    with tempfile.TemporaryDirectory(prefix="wanx-ledger-https-") as temporary:
        directory = Path(temporary).resolve()
        directory.chmod(0o700)
        authority_directory = directory / "os/var/lib/centauros/local-trust" if backup_enabled else directory
        authority_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if transfer_enabled:
            from device_trust_transfer_fixture import DEVICE, TransferFixture
        signing = ec.generate_private_key(ec.SECP256R1())
        tls = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "synthetic-ledger-fixture")])
        current = datetime.datetime.now(datetime.UTC)
        certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(tls.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(current - datetime.timedelta(minutes=1))
            .not_valid_after(current + datetime.timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
            .sign(tls, hashes.SHA256()))
        private(directory / "tls-key.pem", tls.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        private(directory / "tls-cert.pem", certificate.public_bytes(serialization.Encoding.PEM))
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        listener.close()
        secret = os.urandom(32)
        bundle = {"schemaVersion": 1, "type": "centuarai-local-trust-private", "boxId": DEVICE if transfer_enabled else "box:desktop-fixture",
            "baseUrl": f"https://127.0.0.1:{port}", "boxKey": wire.public_jwk(signing),
            "tlsSpkiSha256": _encode(hashlib.sha256(tls.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).digest()),
            "provisioningId": _encode(os.urandom(32)), "ownershipEpoch": 1,
            "grants": ([{"resourceId": "clipboard", "actions": ["read", "write"]}, {"resourceId": "semantica", "actions": ["read", "write"]}] if backup_enabled else [])
                + [{"resourceId": "space:personal", "actions": ["read", "write"]}],
            "claimSecretSha256": _encode(hashlib.sha256(secret).digest()),
            "sourceEvidenceKind": "factory-clean", "sourceEvidenceSha256": _encode(os.urandom(32))}
        private(authority_directory / store.BUNDLE, wire.canonical(bundle))
        private(authority_directory / store.KEY, signing.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        store.initialize_authority(authority_directory, now=int(time.time()))
        descriptor = {field: bundle[field] for field in ("boxId", "baseUrl", "boxKey", "tlsSpkiSha256")}
        packet = {"schemaVersion": 1, "type": "centuarai-local-trust-delivery", **descriptor,
            "provisioningId": bundle["provisioningId"], "ownershipEpoch": 1, "claimSecret": _encode(secret)}
        server = thread = provider = authority = None
        transfer = None
        migrated = False
        if backup_enabled:
            data = directory / "os" / DATA.lstrip("/")
            data.mkdir(parents=True, mode=0o700)
            (data / "app.lock").touch(mode=0o600)
            repo = JobRepository(data / "app.sqlite3")
            repo.initialize()
            from device_trust_wanx_data_fixture import WanxData
            wanx_data = WanxData(directory / "os", descriptor)

        def stop():
            if provider is not None:
                provider.close()
            if server is not None:
                server.should_exit = True
                thread.join(8)
                if thread.is_alive():
                    raise RuntimeError("fixture shutdown timed out")

        def start():
            nonlocal server, thread, provider, authority, transfer
            authority = store.LocalTrustAuthority(authority_directory, boot_id="fixture:" + os.urandom(8).hex())
            original_commit = authority.commit_mutation
            def checked_commit(*args, **kwargs):
                try:
                    return original_commit(*args, **kwargs)
                except Exception:
                    import traceback
                    traceback.print_exc(file=sys.stderr)
                    raise
            authority.commit_mutation = checked_commit
            if backup_enabled and migrated:
                if transfer_enabled:
                    if transfer is None:
                        transfer = TransferFixture(directory / "os", authority)
                    else:
                        transfer.attach(authority)
                provider = Provider(authority, root=directory / "os", control=transfer.control if transfer_enabled else TempWriterControl(data))
                for method_name in ("prepare", "backup_io", "preflight_backup_io", "validate_phase", "validate_source"):
                    original = getattr(provider, method_name)
                    def checked_method(*args, _original=original, **kwargs):
                        try:
                            return _original(*args, **kwargs)
                        except Exception:
                            import traceback
                            traceback.print_exc(file=sys.stderr)
                            raise
                    setattr(provider, method_name, checked_method)
                authority.configure_operation_provider(provider)
            service = LocalTrustService(authority)
            application = create_app(service, authority=f"127.0.0.1:{port}")
            server = uvicorn.Server(uvicorn.Config(application, host="127.0.0.1", port=port,
                ssl_keyfile=str(directory / "tls-key.pem"), ssl_certfile=str(directory / "tls-cert.pem"),
                log_level="critical", access_log=False, ws="none"))
            thread = threading.Thread(target=server.run, daemon=True)
            thread.start()
            deadline = time.monotonic() + 8
            while not server.started and thread.is_alive() and time.monotonic() < deadline:
                time.sleep(0.01)
            if not server.started:
                raise RuntimeError("fixture startup failed")

        try:
            start()
            emit({"type": "ready", "descriptor": descriptor, "deliveryPacket": json.dumps(packet)})
            for line in sys.stdin:
                command = json.loads(line)
                if command == {"operation": "migrate"}:
                    stop()
                    store.migrate_authority_v2(authority_directory, now=int(time.time()))
                    migrated = True
                    start()
                    emit({"type": "migrated"})
                elif command == {"operation": "restart"}:
                    stop()
                    start()
                    emit({"type": "restarted"})
                elif command == {"operation": "stop"}:
                    break
                elif transfer_enabled and set(command) == {"operation", "transferId"} and command["operation"] in ("transfer.authorize", "transfer.prepare", "transfer.finish", "transfer.inspect"):
                    action = command["operation"].split(".")[1]
                    if action == "inspect":
                        emit(transfer.inspect(command["transferId"]))
                    else:
                        try:
                            if action in ("prepare", "finish"):
                                # Use the actual worker close/drain boundary;
                                # never remove or bypass its process lock.
                                provider.close()
                            getattr(transfer, action)(command["transferId"])
                            emit({"type": "transfer-step", "ok": True})
                        except Exception as exc:
                            code = getattr(exc, "code", str(exc))
                            if not isinstance(code, str) or not code.startswith("LOCAL_"):
                                raise
                            emit({"type": "transfer-step", "ok": False, "code": code})
                elif command == {"operation": "challenge.saturate"}:
                    issued = 0
                    for _ in range(129):
                        try:
                            authority.auth_challenge_v2(int(time.time()))
                            issued += 1
                        except Exception as exc:
                            if str(exc) != "LOCAL_TRUST_CAPACITY":
                                raise
                            break
                    else:
                        raise RuntimeError("anonymous fixture pool was not bounded")
                    emit({"type": "saturated", "issued": issued, "capacityRejected": True})
                elif backup_enabled and provider is not None and command == {"operation": "backup.run"}:
                    original_run = provider._run
                    def checked_run(job, _original=original_run):
                        try:
                            return _original(job)
                        except Exception:
                            import traceback
                            traceback.print_exc(file=sys.stderr)
                            raise
                    provider._run = checked_run
                    try:
                        provider.run_once()
                    finally:
                        provider._run = original_run
                    emit({"type": "ran"})
                elif backup_enabled and {"operation", "principalId"} <= set(command) <= {"operation", "principalId", "otherOnly", "documentBytes"} and command["operation"] == "backup.seed":
                    principal = command["principalId"]
                    assert isinstance(principal, str) and len(principal) <= 128
                    namespace = profile.mapped_workspace(bundle["boxId"], _encode(hashlib.sha256(wire.canonical(bundle["boxKey"])).digest()), 1, principal)
                    for doc_id, owner in ((("other-doc", "other-principal"),) if command.get("otherOnly") is True else (("fixture-doc", namespace), ("other-doc", "other-principal"))):
                        content = (b"synthetic backup binary \x00\xff\n" * 50000)[:1024 * 1024] if doc_id == "fixture-doc" else b"other principal private fixture"
                        size = command.get("documentBytes", 1350000) if doc_id == "fixture-doc" else len(content)
                        assert type(size) is int and 0 < size <= 196 * 1024 * 1024
                        document = data / "originals" / doc_id / "input.bin"
                        document.parent.mkdir(parents=True, mode=0o700)
                        with document.open("wb") as output:
                            for offset in range(0, size, len(content)):
                                output.write(content[:min(len(content), size - offset)])
                        repo.create_document_with_job(document_id=doc_id, workspace_id=owner, original_name="input.bin",
                            original_path=f"originals/{doc_id}/input.bin", media_type="application/octet-stream", document_format="txt",
                            digest=file_sha256(document), size_bytes=size)
                    emit({"type": "seeded", "workspace": namespace, "sha256": None if command.get("otherOnly") else file_sha256(data / "originals/fixture-doc/input.bin")})
                elif backup_enabled and command == {"operation": "backup.inspect"}:
                    rows = {}
                    for doc_id in ("fixture-doc", "other-doc"):
                        row = repo.get_document(doc_id)
                        if row is not None:
                            rows[doc_id] = {"workspace": row["workspace_id"], "sha256": file_sha256(data / row["original_path"])}
                    emit({"type": "inspected", "documents": rows})
                elif backup_enabled and set(command) in ({"operation", "principalId"}, {"operation", "principalId", "otherOnly"}) and command["operation"] == "wanx.seed":
                    emit(wanx_data.seed(command["principalId"], other_only=command.get("otherOnly") is True))
                elif backup_enabled and set(command) == {"operation", "principalId"} and command["operation"] == "wanx.inspect":
                    emit(wanx_data.inspect(command["principalId"]))
                elif backup_enabled and set(command) == {"operation", "profileId", "boxId", "boxKeyThumbprint", "principalId", "bindingId", "ownershipEpoch"} and command["operation"] == "wanx.ensure":
                    authorization = authority.get_authorization(command["bindingId"], int(time.time()))
                    for key in ("boxId", "boxKeyThumbprint", "principalId", "bindingId", "ownershipEpoch"):
                        assert authorization[key] == command[key]
                    assert {"clipboard", "space:personal"}.issubset({row["resourceId"] for row in authorization["grants"]})
                    wanx_data.ensure(command["principalId"])
                    emit({"type": "namespace-ready", "identity": {key: value for key, value in command.items() if key != "operation"}})
                else:
                    emit({"type": "invalid-command"})
        finally:
            stop()


if __name__ == "__main__":
    main()
