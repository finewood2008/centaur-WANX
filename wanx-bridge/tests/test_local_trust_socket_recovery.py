"""Real process death and live-listener rejection for the fixed runtime UDS."""

import asyncio
import os
import socket
import stat
import sys
import tempfile
from pathlib import Path

import pytest

from wanx_bridge.local_trust_config import LocalTrustError
from wanx_bridge.local_trust_runtime import _reclaim_stale_socket, runtime_lock

BRIDGE_DIRECTORY = Path(__file__).resolve().parents[1]

pytestmark = pytest.mark.skipif(os.name != "posix", reason="POSIX authority flock and Unix socket")

LISTENER = r"""
import contextlib, os, signal, socket, sys
from pathlib import Path
from wanx_bridge.local_trust_runtime import runtime_lock
manager = runtime_lock(Path(sys.argv[1])) if sys.argv[3] == 'locked' else contextlib.nullcontext()
with manager:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(sys.argv[2]); os.chmod(sys.argv[2], 0o660); sock.listen(4)
    print('ready', flush=True)
    signal.pause()
"""
RESTART = r"""
import os, socket, sys
from pathlib import Path
from wanx_bridge.local_trust_runtime import _reclaim_stale_socket, runtime_lock
path = Path(sys.argv[2])
with runtime_lock(Path(sys.argv[1])) as guard:
    _reclaim_stale_socket(path, guard=guard, expected_gid=os.getgid(), _owner_uid=os.getuid())
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(str(path)); os.chmod(path, 0o660); sock.listen(4)
    print('restarted', flush=True)
"""


@pytest.fixture
def socket_paths():
    # macOS AF_UNIX paths are shorter than pytest's nested temporary root.
    with tempfile.TemporaryDirectory(prefix="local-trust-socket-") as value:
        root = Path(value)
        authority = root / "authority"
        authority.mkdir(mode=0o700)
        broker = root / "ipc"
        broker.mkdir(mode=0o750)
        yield authority, broker / "gate.sock"


async def listener(authority, path, mode):
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        LISTENER,
        str(authority),
        str(path),
        mode,
        cwd=BRIDGE_DIRECTORY,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    ready = await asyncio.wait_for(process.stdout.readline(), 3)
    if ready != b"ready\n":
        _, error = await asyncio.wait_for(process.communicate(), 3)
        pytest.fail(error.decode())
    return process


async def kill(process):
    if process.returncode is None:
        process.kill()
    await asyncio.wait_for(process.communicate(), 3)


@pytest.mark.asyncio
async def test_sigkill_releases_authority_flock_and_restart_reclaims_only_stale_socket(
    socket_paths,
):
    authority, path = socket_paths
    first = await listener(authority, path, "locked")
    try:
        with pytest.raises(LocalTrustError, match="LOCAL_TRUST_ALREADY_RUNNING"):
            with runtime_lock(authority):
                pass
    finally:
        await kill(first)
    assert stat.S_ISSOCK(path.lstat().st_mode)
    restarted = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        RESTART,
        str(authority),
        str(path),
        cwd=BRIDGE_DIRECTORY,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(restarted.communicate(), 3)
    assert restarted.returncode == 0, stderr.decode()
    assert stdout == b"restarted\n"


@pytest.mark.asyncio
async def test_live_unix_listener_is_retained_even_when_authority_lock_is_available(socket_paths):
    authority, path = socket_paths
    first = await listener(authority, path, "unlocked")
    identity = path.stat().st_ino
    try:
        with runtime_lock(authority) as guard:
            with pytest.raises(LocalTrustError, match="LOCAL_TRUST_SOCKET_RECOVERY_DENIED"):
                _reclaim_stale_socket(
                    path, guard=guard, expected_gid=os.getgid(), _owner_uid=os.getuid()
                )
        assert path.stat().st_ino == identity
    finally:
        await kill(first)


@pytest.mark.parametrize(
    "change", ["no-lock", "released-lock", "file", "symlink", "mode", "owner", "group", "hardlink"]
)
def test_socket_recovery_fails_closed_on_untrusted_state(socket_paths, change):
    authority, path = socket_paths
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.bind(str(path))
    path.chmod(0o660)
    if change == "file":
        path.unlink()
        path.write_text("retained")
        path.chmod(0o660)
    elif change == "symlink":
        real = path.with_name("actual.sock")
        path.rename(real)
        path.symlink_to(real)
    elif change == "mode":
        path.chmod(0o600)
    elif change == "hardlink":
        os.link(path, path.with_name("second.sock"))
    with runtime_lock(authority) as guard:
        if change == "released-lock":
            guard.active = False
        expected = os.getuid() + 1 if change == "owner" else os.getuid()
        group = os.getgid() + 1 if change == "group" else os.getgid()
        with pytest.raises(LocalTrustError, match="LOCAL_TRUST_SOCKET_RECOVERY_DENIED"):
            _reclaim_stale_socket(
                path,
                guard=None if change == "no-lock" else guard,
                expected_gid=group,
                _owner_uid=expected,
            )
    assert os.path.lexists(path)
