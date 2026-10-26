"""Disposable real HTTPS engine for the explicit desktop/box integration test.

All keys and delivery credentials are generated for the temporary test directory.
This bypasses OS provisioning eligibility only inside a synthetic test fixture.
"""

import base64
import datetime as dt
import hashlib
import ipaddress
import json
import os
import secrets
import sys
import time
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "wanx-bridge"))

from wanx_bridge.local_authority_store import initialize_authority  # noqa: E402
from wanx_bridge.local_management_protocol import canonical, public_jwk  # noqa: E402


def encoded(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def write_private(path, value):
    with path.open("xb") as stream:
        os.chmod(path, 0o600)
        stream.write(value)


def initialize(directory, port):
    directory.mkdir(mode=0o700)
    tls_key = ec.generate_private_key(ec.SECP256R1())
    authority_key = ec.generate_private_key(ec.SECP256R1())
    for filename, key in (("tls-key.pem", tls_key), ("box-signing-key.pem", authority_key)):
        write_private(
            directory / filename,
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ),
        )
    now = dt.datetime.now(dt.UTC)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "synthetic-local-trust-test")])
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(tls_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=1))
        .not_valid_after(now + dt.timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            critical=False,
        )
        .sign(tls_key, hashes.SHA256())
    )
    write_private(directory / "tls-cert.pem", certificate.public_bytes(serialization.Encoding.PEM))
    secret = secrets.token_bytes(32)
    descriptor = {
        "boxId": "integration-box",
        "baseUrl": f"https://127.0.0.1:{port}",
        "boxKey": public_jwk(authority_key),
        "tlsSpkiSha256": encoded(
            hashlib.sha256(
                tls_key.public_key().public_bytes(
                    serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
                )
            ).digest()
        ),
    }
    provision = {"provisioningId": secrets.token_urlsafe(32), "ownershipEpoch": 1}
    bundle = {
        "schemaVersion": 1,
        "type": "centuarai-local-trust-private",
        **descriptor,
        **provision,
        "grants": [{"resourceId": "space", "actions": ["read", "write"]}],
        "claimSecretSha256": encoded(hashlib.sha256(secret).digest()),
        "sourceEvidenceKind": "full-erase",
        "sourceEvidenceSha256": encoded(hashlib.sha256(b"test-only").digest()),
    }
    write_private(directory / "private-bundle.json", canonical(bundle))
    initialize_authority(directory, now=int(time.time()))
    packet = {
        "schemaVersion": 1,
        "type": "centuarai-local-trust-delivery",
        **descriptor,
        **provision,
        "claimSecret": encoded(secret),
    }
    write_private(directory.parent / "delivery.json", canonical(packet))
    config = {
        "schemaVersion": 1,
        "bindHost": "127.0.0.1",
        "bindPort": port,
        "stateDirectory": str(directory),
    }
    write_private(directory.parent / "runtime.json", json.dumps(config).encode())


if __name__ == "__main__":
    directory = Path(sys.argv[1]).resolve()
    port = int(sys.argv[2])
    if len(sys.argv) == 3:
        initialize(directory, port)
    # Restart reopens the exact existing ledger and keys; never initializes again.
    os.environ["PYTHONPATH"] = str(ROOT / "wanx-bridge")
    os.execv(
        sys.executable,
        [
            sys.executable,
            "-m",
            "wanx_bridge.local_trust_runtime",
            "--config",
            str(directory.parent / "runtime.json"),
        ],
    )
