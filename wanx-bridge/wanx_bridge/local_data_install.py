"""Create a separate gateway signer, never a ledger or an ownership proof."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from .local_data_protocol import public_jwk
from .local_trust_config import LocalTrustError, private_directory, private_file, strict_object
from .local_trust_runtime import runtime_lock


def _create(path: Path, data: bytes):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def provision_gateway(directory: Path):
    directory = directory.absolute()
    private_directory(directory)
    with runtime_lock(directory):
        # Existing initialized identity is mandatory. No absent or corrupt DB is
        # repaired from a bundle, and no first-root material is read or copied.
        bundle = strict_object(private_file(directory / "private-bundle.json", 32768))
        if bundle.get("type") != "centuarai-local-trust-private" or not bundle.get("boxId"):
            raise LocalTrustError("LOCAL_DATA_CONFIG_INVALID")
        private_file(directory / "local-authority.sqlite3", 128 * 1024 * 1024, contents=False)
        key_path = directory / "gateway-signing-key.pem"
        descriptor_path = directory / "gateway-descriptor.json"
        if os.path.lexists(key_path) or os.path.lexists(descriptor_path):
            raise LocalTrustError("LOCAL_DATA_ALREADY_PROVISIONED")
        key = ec.generate_private_key(ec.SECP256R1())
        descriptor = {
            "schemaVersion": 1,
            "gatewayId": "gateway-" + secrets.token_urlsafe(32),
            "gatewayKey": public_jwk(key),
        }
        _create(
            key_path,
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ),
        )
        # Any interrupted partial provisioning stays closed for operator review.
        _create(
            descriptor_path,
            json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode() + b"\n",
        )
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return descriptor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provision-gateway", required=True, type=Path)
    args = parser.parse_args()
    try:
        value = provision_gateway(args.provision_gateway)
    except Exception as exc:
        print(
            exc.code if isinstance(exc, LocalTrustError) else "LOCAL_DATA_PROVISION_FAILED",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
    print(json.dumps(value, separators=(",", ":")))


if __name__ == "__main__":
    main()
