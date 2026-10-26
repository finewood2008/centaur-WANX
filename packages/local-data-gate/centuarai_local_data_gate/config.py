"""Operator-controlled native configuration; never loaded from business backups."""

from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path

from .protocol import DataProtocolError, digest32, fields, public_key, token

REQUIRED_POLICY = Path("/etc/centuarai/local-trust/required.json")


def load_required_policy(filename=None, *, owner_uid: int = 0):
    """A present but invalid policy is never interpreted as legacy mode."""
    path = Path(filename) if filename is not None else REQUIRED_POLICY
    try:
        path.lstat()
    except FileNotFoundError:
        return None
    except OSError:
        raise DataProtocolError("LOCAL_DATA_REQUIRED") from None
    try:
        if os.name != "posix" or not path.is_absolute():
            raise ValueError()
        for parent in path.parents:
            info = parent.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o022:
                raise ValueError()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or info.st_uid != owner_uid
                or info.st_mode & 0o022
                or info.st_size > 8192
            ):
                raise ValueError()

            def pairs(items):
                result = {}
                for key, value in items:
                    if key in result:
                        raise ValueError()
                    result[key] = value
                return result

            value = json.loads(stream.read(8193), object_pairs_hook=pairs)
        fields(value, {"schemaVersion", "type", "boxId", "gatewayId", "minimumGateVersion"})
        if (
            type(value["schemaVersion"]) is not int
            or value["schemaVersion"] != 1
            or value["type"] != "centuarai-local-data-required"
            or type(value["minimumGateVersion"]) is not int
            or value["minimumGateVersion"] != 1
        ):
            raise ValueError()
        token(value["boxId"])
        token(value["gatewayId"])
        return value
    except (OSError, ValueError, TypeError, KeyError, DataProtocolError):
        raise DataProtocolError("LOCAL_DATA_REQUIRED") from None


def private_directory(path: Path) -> None:
    if os.name != "posix" or not path.is_absolute():
        raise DataProtocolError("LOCAL_DATA_STAGING_UNAVAILABLE")
    for item in (path, *path.parents):
        if not stat.S_ISDIR(item.lstat().st_mode):
            raise DataProtocolError("LOCAL_DATA_STAGING_UNAVAILABLE")
    info = path.lstat()
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise DataProtocolError("LOCAL_DATA_STAGING_UNAVAILABLE")


@dataclass(frozen=True)
class GateConfig:
    audience: str
    gateway_id: str
    gateway_key: dict
    box_id: str
    box_key_thumbprint: str
    broker_socket: str
    staging_directory: Path

    @classmethod
    def load(cls, filename, *, audience: str, owner_uid: int = 0):
        """owner_uid is injectable for isolated tests; deployed callers use root."""
        try:
            path = Path(filename)
            if os.name != "posix" or not path.is_absolute():
                raise ValueError()
            for parent in path.parents:
                info = parent.lstat()
                if (
                    not stat.S_ISDIR(info.st_mode)
                    or info.st_uid != owner_uid
                    or info.st_mode & 0o022
                ):
                    raise ValueError()
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if (
                    not stat.S_ISREG(info.st_mode)
                    or info.st_uid != owner_uid
                    or info.st_nlink != 1
                    or info.st_mode & 0o022
                    or info.st_size > 16384
                ):
                    raise ValueError()

                def pairs(items):
                    value = {}
                    for key, item in items:
                        if key in value:
                            raise ValueError()
                        value[key] = item
                    return value

                value = json.loads(stream.read(16385), object_pairs_hook=pairs)
            fields(
                value,
                {
                    "schemaVersion",
                    "mode",
                    "audience",
                    "gatewayId",
                    "gatewayKey",
                    "boxId",
                    "boxKeyThumbprint",
                    "brokerSocket",
                    "stagingDirectory",
                },
            )
            if (
                type(value["schemaVersion"]) is not int
                or value["schemaVersion"] != 1
                or value["mode"] != "required"
                or value["audience"] != audience
                or audience not in {"octop", "semantica", "semantica-mcp", "clipboard"}
            ):
                raise ValueError()
            token(value["gatewayId"])
            token(value["boxId"])
            digest32(value["boxKeyThumbprint"])
            public_key(value["gatewayKey"])
            socket = Path(value["brokerSocket"])
            if not socket.is_absolute() or ".." in socket.parts:
                raise ValueError()
            for parent in socket.parents:
                info = parent.lstat()
                if (
                    not stat.S_ISDIR(info.st_mode)
                    or info.st_uid != owner_uid
                    or info.st_mode & 0o022
                ):
                    raise ValueError()
            staging = Path(value["stagingDirectory"])
            private_directory(staging)
            return cls(
                audience,
                value["gatewayId"],
                value["gatewayKey"],
                value["boxId"],
                value["boxKeyThumbprint"],
                str(socket),
                staging,
            )
        except (OSError, ValueError, TypeError, KeyError, DataProtocolError):
            raise DataProtocolError("LOCAL_DATA_REQUIRED") from None
