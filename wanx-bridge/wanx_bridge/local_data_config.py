"""Root-controlled data runtime configuration; no caller-selected upstreams."""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from centuarai_local_data_gate.config import REQUIRED_POLICY, load_required_policy
from centuarai_local_data_gate.config import private_directory as staging_directory
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from .local_data_protocol import public_jwk, token
from .local_trust_config import LocalTrustError, private_directory, private_file, strict_object


@dataclass(frozen=True)
class LocalDataConfig:
    gateway_id: str
    gateway_key: object
    broker_socket: Path
    staging_directory: Path
    upstreams: dict
    policy: dict | None

    @classmethod
    def load(cls, filename, *, authority_directory: Path, box_id: str):
        try:
            path = Path(filename)
            if not path.is_absolute():
                raise ValueError()
            private_directory(path.parent)
            value = strict_object(private_file(path, 16384))
            if (
                set(value)
                != {
                    "schemaVersion",
                    "gatewayId",
                    "gatewayKeyFile",
                    "brokerSocket",
                    "stagingDirectory",
                    "policyFile",
                    "upstreams",
                }
                or type(value["schemaVersion"]) is not int
                or value["schemaVersion"] != 1
            ):
                raise ValueError()
            token(value["gatewayId"])
            if value["policyFile"] != str(REQUIRED_POLICY):
                raise ValueError()
            policy = load_required_policy()
            if policy and (policy["boxId"] != box_id or policy["gatewayId"] != value["gatewayId"]):
                raise ValueError()
            key_path = Path(value["gatewayKeyFile"])
            if key_path != authority_directory / "gateway-signing-key.pem":
                raise ValueError()
            key = serialization.load_pem_private_key(private_file(key_path, 16384), password=None)
            if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(
                key.curve, ec.SECP256R1
            ):
                raise ValueError()
            descriptor = strict_object(
                private_file(authority_directory / "gateway-descriptor.json", 4096)
            )
            if descriptor != {
                "schemaVersion": 1,
                "gatewayId": value["gatewayId"],
                "gatewayKey": public_jwk(key),
            }:
                raise ValueError()
            bundle = strict_object(private_file(authority_directory / "private-bundle.json", 32768))
            if public_jwk(key) == bundle["boxKey"]:
                raise ValueError()
            tls_key = serialization.load_pem_private_key(
                private_file(authority_directory / "tls-key.pem", 16384), password=None
            )
            if public_jwk(key) == public_jwk(tls_key):
                raise ValueError()
            socket = Path(value["brokerSocket"])
            if not socket.is_absolute() or ".." in socket.parts:
                raise ValueError()
            for parent in socket.parents:
                info = parent.lstat()
                if (
                    not stat.S_ISDIR(info.st_mode)
                    or info.st_uid != os.geteuid()
                    or info.st_mode & 0o022
                ):
                    raise ValueError()
            staging = Path(value["stagingDirectory"])
            staging_directory(staging)
            upstreams = value["upstreams"]
            if not isinstance(upstreams, dict) or set(upstreams) != {
                "octop",
                "semantica",
                "semantica-mcp",
                "clipboard",
            }:
                raise ValueError()
            for item in upstreams.values():
                if (
                    set(item) != {"origin", "uid"}
                    or type(item["uid"]) is not int
                    or item["uid"] <= 0
                ):
                    raise ValueError()
                origin = urlsplit(item["origin"])
                if (
                    origin.scheme != "http"
                    or origin.hostname != "127.0.0.1"
                    or origin.port is None
                    or origin.path
                    or origin.query
                    or origin.fragment
                    or origin.username
                    or origin.password
                ):
                    raise ValueError()
            if len({item["origin"] for item in upstreams.values()}) != 4:
                raise ValueError()
            return cls(value["gatewayId"], key, socket, staging, upstreams, policy)
        except Exception:
            raise LocalTrustError("LOCAL_DATA_CONFIG_INVALID") from None
