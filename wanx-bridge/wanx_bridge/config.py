"""Configuration for the separately deployed WANX identity boundary."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey


class BridgeAuthError(Exception):
    def __init__(self, code: str = "BOX_PLATFORM_AUTH_FAILED", status: int = 401) -> None:
        self.code = code
        self.status = status
        super().__init__(code)


@dataclass(frozen=True)
class PlatformConfig:
    device_id: str
    issuer: str
    box_key: Ed25519PrivateKey
    platform_key: Ed25519PublicKey
    state_dir: Path = Path("/data/wanx-bridge")

    @classmethod
    def from_env(cls) -> PlatformConfig:
        if os.getenv("WANX_PLATFORM_SSO_ENABLED") != "1":
            raise BridgeAuthError("BOX_PLATFORM_DISABLED", 403)
        try:
            device = os.environ["WANX_PLATFORM_DEVICE_ID"].strip()
            private = serialization.load_pem_private_key(
                Path(os.environ["WANX_PLATFORM_BOX_KEY_FILE"]).read_bytes(), password=None
            )
            public = serialization.load_pem_public_key(
                Path(os.environ["WANX_PLATFORM_PUBLIC_KEY_FILE"]).read_bytes()
            )
            if (
                not device
                or not isinstance(private, Ed25519PrivateKey)
                or not isinstance(public, Ed25519PublicKey)
            ):
                raise ValueError("invalid configuration")
            return cls(
                device,
                os.getenv("WANX_PLATFORM_ISSUER", "nexusaos-platform"),
                private,
                public,
                Path(os.getenv("WANX_BRIDGE_STATE_DIR", "/data/wanx-bridge")),
            )
        except (OSError, KeyError, ValueError, TypeError) as exc:
            raise BridgeAuthError("BOX_PLATFORM_CONFIG_INVALID", 503) from exc
