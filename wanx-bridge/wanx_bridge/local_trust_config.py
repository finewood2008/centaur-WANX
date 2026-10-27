"""Explicit configuration for the independent HTTPS management listener."""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import stat
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

# Separate from the native data IPC directory mounted into business containers.
# This root-only OS channel is mandatory in the protected runtime, not a caller
# configurable transport or an alternative source of network permissions.
NETWORK_SOCKET = Path("/run/centuarai-local-trust-network/network.sock")


class LocalTrustError(Exception):
    def __init__(self, code: str, status: int = 503):
        self.code, self.status = code, status
        super().__init__(code)


def private_directory(path: Path) -> None:
    if os.name != "posix":
        raise LocalTrustError("LOCAL_TRUST_PLATFORM_UNSUPPORTED")
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise LocalTrustError("LOCAL_TRUST_CONFIG_INVALID")


def private_file(path: Path, limit: int, *, contents: bool = True) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
            or info.st_size > limit
        ):
            raise LocalTrustError("LOCAL_TRUST_CONFIG_INVALID")
        if not contents:
            return b""
        value = stream.read(limit + 1)
        if len(value) > limit:
            raise LocalTrustError("LOCAL_TRUST_CONFIG_INVALID")
        return value


def strict_object(raw: bytes) -> dict:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate field")
            result[key] = value
        return result

    value = json.loads(raw, object_pairs_hook=pairs)
    if type(value) is not dict:
        raise ValueError("expected object")
    return value


@dataclass(frozen=True)
class LocalTrustConfig:
    bind_host: str
    bind_port: int
    state_directory: Path
    base_url: str
    tls_certificate: Path
    tls_private_key: Path
    data_config: Path | None = None

    @property
    def authority(self) -> str:
        parsed = urlsplit(self.base_url)
        host = parsed.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        return host if (parsed.port or 443) == 443 else f"{host}:{parsed.port}"

    @classmethod
    def load(cls, filename: str | Path) -> LocalTrustConfig:
        try:
            path = Path(filename)
            if not path.is_absolute():
                raise ValueError("absolute configuration required")
            private_directory(path.parent)
            value = strict_object(private_file(path, 8192))
            if set(value) not in (
                {"schemaVersion", "bindHost", "bindPort", "stateDirectory"},
                {"schemaVersion", "bindHost", "bindPort", "stateDirectory", "dataConfig"},
            ):
                raise ValueError("configuration shape")
            if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
                raise ValueError("configuration version")
            if not isinstance(value["bindHost"], str) or "%" in value["bindHost"]:
                raise ValueError("bind address")
            ipaddress.ip_address(value["bindHost"])
            if type(value["bindPort"]) is not int or not 1 <= value["bindPort"] <= 65535:
                raise ValueError("bind port")
            if not isinstance(value["stateDirectory"], str):
                raise ValueError("directory")
            directory = Path(value["stateDirectory"])
            if not directory.is_absolute():
                raise ValueError("absolute directory required")
            private_directory(directory)
            bundle = strict_object(private_file(directory / "private-bundle.json", 32768))
            base = urlsplit(bundle["baseUrl"])
            if (
                base.scheme != "https"
                or not base.hostname
                or not base.netloc.isascii()
                or base.username is not None
                or base.password is not None
                or base.path not in {"", "/"}
                or "?" in bundle["baseUrl"]
                or "#" in bundle["baseUrl"]
                or (base.port or 443) != value["bindPort"]
            ):
                raise ValueError("HTTPS origin required")
            certificate_path, key_path = directory / "tls-cert.pem", directory / "tls-key.pem"
            certificate = x509.load_pem_x509_certificate(private_file(certificate_path, 65536))
            key = serialization.load_pem_private_key(private_file(key_path, 16384), password=None)
            if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(
                key.curve, ec.SECP256R1
            ):
                raise ValueError("TLS key type")
            public = certificate.public_key()
            if (
                not isinstance(public, ec.EllipticCurvePublicKey)
                or public.public_numbers() != key.public_key().public_numbers()
            ):
                raise ValueError("TLS identity mismatch")
            pin = (
                base64.urlsafe_b64encode(
                    hashlib.sha256(
                        public.public_bytes(
                            serialization.Encoding.DER,
                            serialization.PublicFormat.SubjectPublicKeyInfo,
                        )
                    ).digest()
                )
                .rstrip(b"=")
                .decode("ascii")
            )
            if not hmac.compare_digest(pin, bundle["tlsSpkiSha256"]):
                raise ValueError("TLS pin mismatch")
            now = datetime.now(UTC)
            # cryptography 41 is still supported by this package. Its legacy
            # certificate datetimes are naive UTC; 42+ exposes aware fields.
            valid_from = getattr(certificate, "not_valid_before_utc", None)
            valid_until = getattr(certificate, "not_valid_after_utc", None)
            if valid_from is None:
                valid_from = certificate.not_valid_before.replace(tzinfo=UTC)
            if valid_until is None:
                valid_until = certificate.not_valid_after.replace(tzinfo=UTC)
            if not valid_from <= now < valid_until:
                raise ValueError("TLS certificate expired")
            from centuarai_local_data_gate.config import load_required_policy

            policy = load_required_policy()
            floor = directory / "local-trust-required.json"
            if os.path.lexists(floor):
                floor_value = strict_object(private_file(floor, 8192))
                from .local_trust_protocol import public_key_thumbprint

                if floor_value != {
                    "schemaVersion": 2,
                    "boxId": bundle["boxId"],
                    "boxKeyThumbprint": public_key_thumbprint(bundle["boxKey"]),
                    "policy": "local-trust-required",
                }:
                    raise ValueError("required floor invalid")
            data_config = Path(value["dataConfig"]) if "dataConfig" in value else None
            if data_config is not None and not data_config.is_absolute():
                raise ValueError("absolute data configuration required")
            if (policy is not None or os.path.lexists(floor)) and data_config is None:
                raise LocalTrustError("LOCAL_DATA_REQUIRED")
            # Loading never creates directories, identities, ledgers or keys.
            private_file(directory / "local-authority.sqlite3", 128 * 1024 * 1024, contents=False)
            return cls(
                value["bindHost"],
                value["bindPort"],
                directory,
                bundle["baseUrl"].rstrip("/"),
                certificate_path,
                key_path,
                data_config,
            )
        except LocalTrustError:
            raise
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            raise LocalTrustError("LOCAL_TRUST_CONFIG_INVALID") from None
