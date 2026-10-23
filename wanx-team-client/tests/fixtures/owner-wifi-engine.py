"""Opt-in cross-repository test: real box protocol/crypto, simulated Wi-Fi adapter."""
import base64
import datetime
import hashlib
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

loader = importlib.machinery.SourceFileLoader("owner_wifi_engine", str(Path(sys.argv[1]) / "discovery/centauros-provisioning-ble-gatt"))
spec = importlib.util.spec_from_loader(loader.name, loader)
ble = importlib.util.module_from_spec(spec)
loader.exec_module(ble)
device_id = "centauros-" + "a" * 24
owner = {"deviceId": device_id, "ownerAccountId": "owner-account", "bindingId": "binding-one", "ownershipEpoch": 1, "authVersion": 1}
device_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
platform_key = ed25519.Ed25519PrivateKey.generate()
root_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
now = datetime.datetime.now(datetime.timezone.utc)
root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Root")])
root_cert = (x509.CertificateBuilder().subject_name(root_name).issuer_name(root_name).public_key(root_key.public_key())
    .serial_number(1).not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=365))
    .add_extension(x509.BasicConstraints(ca=True, path_length=1), critical=True)
    .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, None, None), critical=True).sign(root_key, hashes.SHA256()))
leaf_cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, device_id)]))
    .issuer_name(root_name).public_key(device_key.public_key()).serial_number(2)
    .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=30))
    .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
    .add_extension(x509.KeyUsage(True, False, True, False, False, False, False, None, None), critical=True)
    .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
    .add_extension(x509.SubjectAlternativeName([x509.UniformResourceIdentifier("spiffe://nexusaos/device/" + device_id)]), critical=False)
    .sign(root_key, hashes.SHA256()))
public_hash = hashlib.sha256(device_key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()
info = {"schema_version": 3, "device_id": device_id, "display_name": "Test Box", "model": "C100", "serial_suffix": "AAAA",
        "provisioning_protocol_version": 2, "security_profile": "NEXUSAOS_LOCAL_AEAD_V2", "identity_public_key_sha256": public_hash,
        "pairing_mode_remaining_seconds": 0, "network_state": "connected", "cloud_enrollment_status": "ready", "max_message_bytes": 2048}
iso = lambda value: value.isoformat(timespec="seconds").replace("+00:00", "Z")
attestation = {"deviceId": device_id, "certificatePem": leaf_cert.public_bytes(serialization.Encoding.PEM).decode(),
               "certificateChainPem": [], "serialNumber": "02", "publicKeySha256": public_hash,
               "certificateStatus": "active", "statusCheckedAt": iso(now), "expiresAt": iso(now + datetime.timedelta(days=30))}

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    key_path = root / "var/lib/centauros/device/device-key.pem"
    key_path.parent.mkdir(parents=True)
    key_path.write_bytes(device_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    key_path.chmod(0o600)
    trust = root / "var/lib/centuaros/wanx-platform/platform-public-key.pem"
    trust.parent.mkdir(parents=True)
    trust.write_bytes(platform_key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    trust.chmod(0o644)
    backend = ble.ProvisioningV2Backend("unused", directory, clock=time.monotonic)
    with patch.object(backend, "_owner_snapshot", return_value=owner), patch.object(backend, "_first_claim_eligible", return_value=False), \
         patch.object(backend, "device_info_object", return_value=info), patch.object(backend, "run_cli_stdin", return_value="ok") as wifi_apply:
        for line in sys.stdin:
            try:
                message = json.loads(line)
                op = message["op"]
                if op == "metadata":
                    value = {"attestation": attestation, "serverTime": iso(now), "root": root_cert.public_bytes(serialization.Encoding.PEM).decode(),
                             "pin": "sha256/" + base64.b64encode(hashlib.sha256(root_key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).digest()).decode()}
                elif op == "read":
                    value = base64.b64encode(ble.jcs_bytes(info)).decode()
                elif op == "request":
                    value = base64.b64encode(backend.handle_logical_frame(base64.b64decode(message["frame"]), "central")).decode()
                elif op == "authorize":
                    body = message["body"]
                    session = backend.sessions[body["pairingSessionId"]]
                    payload = {"schemaVersion": 1, "purpose": "owner-wifi", **owner, "clientId": body["clientId"],
                               "pairingSessionId": body["pairingSessionId"], "challengeCanonicalSha256": session.values["challenge_canonical_sha256"],
                               "pairingTokenCiphertextSha256": body["pairingTokenCiphertextSha256"], "expiresInSeconds": 300}
                    value = {"permit": {"payload": payload, "keyId": "test-platform", "algorithm": "Ed25519",
                                        "signature": base64.b64encode(platform_key.sign(b"CENTAURAI-OWNER-WIFI-V1\n" + ble.jcs_bytes(payload))).decode()}}
                elif op == "close":
                    backend.drop_connection("central")
                    value = None
                elif op == "stats":
                    value = {"wifiApplyCalls": wifi_apply.call_count, "owner": owner,
                             "claimRecordExists": (root / "var/lib/centauros/provisioning/device-proof-retry").exists()}
                else:
                    raise ValueError("unsupported operation")
                print(json.dumps({"ok": True, "value": value}), flush=True)
            except Exception as exc:
                print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
