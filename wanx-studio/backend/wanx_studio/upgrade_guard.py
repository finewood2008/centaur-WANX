"""Local process locks that keep image upgrades outside active Builder work.

Background jobs hold shared locks; the OTA helper holds an exclusive lock until
its stdin closes or the container exits. No persistent drain flag survives a
failed upgrade. Only Linux images advertise this capability.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import stat
import sys

from .contracts import StudioError


def acquire(root: Path, *, exclusive: bool = False):
    """Return an owned lock file, or fail without waiting or starting work."""
    if os.name != "posix":
        raise StudioError("BUILDER_UPGRADE_GUARD_UNAVAILABLE", 409)
    import fcntl

    fd = None
    try:
        fd = os.open(root / "upgrade.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise StudioError("BUILDER_UPGRADE_GUARD_UNAVAILABLE", 409)
        fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        stream = os.fdopen(fd, "r+b")
        fd = None
        return stream
    except BlockingIOError:
        raise StudioError("BUILDER_UPGRADE_BUSY", 409) from None
    except OSError:
        raise StudioError("BUILDER_UPGRADE_GUARD_UNAVAILABLE", 409) from None
    finally:
        if fd is not None:
            os.close(fd)


async def background_lock(root: Path):
    """Keep filesystem access off the event loop, including cancelled admission."""
    pending = asyncio.get_running_loop().run_in_executor(None, acquire, root)
    try:
        return await asyncio.shield(pending)
    except asyncio.CancelledError:
        # Cancelling an executor future does not stop its thread. Wait for the
        # real acquisition and close any returned fd, even after double cancel.
        while not pending.done():
            try:
                await asyncio.shield(pending)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not pending.cancelled() and pending.exception() is None:
            pending.result().close()
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        lock = acquire(args.root, exclusive=True)
    except StudioError as error:
        status = "busy" if error.code == "BUILDER_UPGRADE_BUSY" else "blocked"
        print(json.dumps({"schemaVersion": 1, "status": status}), flush=True)
        return 75 if status == "busy" else 78
    with lock:
        print(json.dumps({"schemaVersion": 1, "status": "ready"}), flush=True)
        # The host keeps this pipe open through SIGTERM and container shutdown.
        # EOF also releases admission when a stop fails or the updater exits.
        sys.stdin.buffer.read()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
