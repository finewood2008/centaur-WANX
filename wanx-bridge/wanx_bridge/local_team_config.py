"""The cloud identity pin is installation policy, never an HTTP argument."""

from __future__ import annotations

import os
import stat
from pathlib import Path

from .local_team_protocol import validate_policy
from .local_trust_config import LocalTrustError, strict_object

POLICY_FILE = Path("/etc/centuarai/local-trust/team-identity.json")


def load_team_identity_policy(filename=None, *, owner_uid=0):
    path = POLICY_FILE if filename is None else Path(filename)
    if not path.is_absolute() or ".." in path.parts or os.name != "posix":
        raise LocalTrustError("LOCAL_TRUST_IDENTITY_POLICY_REQUIRED")
    if not os.path.lexists(path):
        return None
    parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for name in path.parts[1:-1]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
            info = os.fstat(parent)
            if info.st_uid not in (0, owner_uid) or info.st_mode & 0o022:
                raise ValueError()
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != owner_uid
                or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) not in (0o600, 0o644)
                or info.st_size > 8192
            ):
                raise ValueError()
            raw = stream.read(8193)
            if len(raw) > 8192:
                raise ValueError()
        value = strict_object(raw)
        validate_policy(value)
        return value
    except (OSError, ValueError, UnicodeError) as exc:
        raise LocalTrustError("LOCAL_TRUST_IDENTITY_POLICY_REQUIRED") from exc
    finally:
        os.close(parent)
