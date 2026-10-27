"""Network IPC lifecycle and mode boundaries; no real network or host mutation."""

import os
import socket
import sys
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from wanx_bridge import local_trust_runtime as runtime
from wanx_bridge.local_trust_config import LocalTrustError
from wanx_bridge.local_trust_service import LocalTrustService


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [
        None,
        "provider",
        "wifi-init",
        "wifi-start",
        "data",
        "https",
        "wifi-close",
        "provider-close",
        "sessions-close",
    ],
)
async def test_protected_runtime_owns_wifi_and_drains_it_before_single_authority(
    monkeypatch, tmp_path, failure
):
    events, services, wifi_instances, brokers = [], [], [], []
    loop_thread = threading.get_ident()

    class Authority:
        def close(self):
            events.append("authority-close")

    authority = Authority()

    class Service(LocalTrustService):
        def __init__(self, value):
            assert value is authority
            super().__init__(value)
            services.append(self)

    class Provider:
        def start(self):
            events.append("provider-start")
            if failure == "provider":
                raise RuntimeError("fixture-provider")

        def close(self):
            events.append("provider-close")
            if failure == "provider-close":
                raise RuntimeError("fixture-provider-close")

    def create_provider(value):
        assert value is authority
        return Provider()

    class Wifi:
        def __init__(self, value):
            assert value is authority
            assert threading.get_ident() != loop_thread
            assert services[0]._execution_lock.locked()
            events.append("wifi-init")
            if failure == "wifi-init":
                raise RuntimeError("fixture-wifi-init")
            wifi_instances.append(self)

    class Broker:
        def __init__(self, value, *, execute_authority, socket_path):
            assert value is wifi_instances[0]
            assert execute_authority.__self__ is services[0]
            assert socket_path == Path("/run/centuarai-local-trust-network/network.sock")
            brokers.append(self)

        async def start(self):
            events.append("wifi-start")
            if failure == "wifi-start":
                raise RuntimeError("fixture-wifi-start")

        async def close(self):
            assert not services[0]._closing
            events.append("wifi-close")
            if failure == "wifi-close":
                raise RuntimeError("fixture-wifi-close")

    class Component:
        def __init__(self, name):
            self.name = name

        async def close(self):
            events.append(self.name + "-close")
            if failure == self.name + "-close":
                raise RuntimeError("fixture-" + failure)

    guard = object()

    def reclaim(path, **kwargs):
        assert path == Path("/run/centuarai-local-trust-network/network.sock")
        assert kwargs == {"guard": guard, "expected_gid": 0, "expected_mode": 0o600}
        events.append("wifi-reclaim")

    async def data(config, value, service, **kwargs):
        assert value is authority and service is services[0]
        events.append("data-start")
        if failure == "data":
            raise RuntimeError("fixture-data")
        return object(), Component("gateway"), Component("data-broker"), Component("sessions")

    class Server:
        async def serve(self):
            events.append("https-start")
            if failure == "https":
                raise RuntimeError("fixture-https")

    monkeypatch.setattr(runtime, "LocalTrustAuthority", lambda *args, **kwargs: authority)
    monkeypatch.setattr(runtime, "LocalTrustService", Service)
    monkeypatch.setattr(runtime, "data_application", data)
    monkeypatch.setattr(runtime, "_reclaim_stale_socket", reclaim)
    monkeypatch.setattr(runtime, "server_for", lambda *args: Server())
    monkeypatch.setitem(
        sys.modules, "wanx_bridge.local_wifi_authority", SimpleNamespace(LocalWifiAuthority=Wifi)
    )
    monkeypatch.setitem(
        sys.modules, "wanx_bridge.local_wifi_broker", SimpleNamespace(LocalWifiBroker=Broker)
    )
    from wanx_bridge import local_trust_operations_loader

    monkeypatch.setattr(local_trust_operations_loader, "create_operation_provider", create_provider)
    config = SimpleNamespace(state_directory=tmp_path, data_config=tmp_path / "data.json")
    if failure:
        with pytest.raises(RuntimeError, match="fixture-" + failure):
            await runtime._serve(config, guard)
    else:
        await runtime._serve(config, guard)
    assert events[-1] == "authority-close"
    assert events.count("provider-close") == 1
    if brokers:
        assert events.count("wifi-close") == 1
        assert events.index("wifi-close") < events.index("authority-close")
    if failure not in ("provider", "wifi-init"):
        assert brokers, events
    if failure in ("wifi-init", "wifi-start"):
        assert "https-start" not in events
    if "https-start" in events:
        for name in ("sessions", "gateway", "data-broker"):
            assert events.count(name + "-close") == 1


@pytest.mark.skipif(os.name != "posix", reason="POSIX flock and Unix socket permissions")
@pytest.mark.parametrize("mode", [0o600, 0o660])
def test_socket_recovery_requires_exact_mode_per_ipc_boundary(mode):
    with tempfile.TemporaryDirectory(prefix="wifi-runtime-") as temporary:
        root = Path(temporary)
        authority, directory = root / "authority", root / "ipc"
        authority.mkdir(mode=0o700)
        directory.mkdir(mode=0o700)
        path = directory / "socket"
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(str(path))
        path.chmod(mode)
        with runtime.runtime_lock(authority) as guard:
            wrong = 0o660 if mode == 0o600 else 0o600
            with pytest.raises(LocalTrustError, match="SOCKET_RECOVERY_DENIED"):
                runtime._reclaim_stale_socket(
                    path,
                    guard=guard,
                    expected_gid=os.getgid(),
                    expected_mode=wrong,
                    _owner_uid=os.getuid(),
                )
            assert path.exists()
            runtime._reclaim_stale_socket(
                path,
                guard=guard,
                expected_gid=os.getgid(),
                expected_mode=mode,
                _owner_uid=os.getuid(),
            )
        assert not path.exists()


@pytest.mark.skipif(os.name != "posix", reason="POSIX flock and Unix socket permissions")
def test_network_stale_socket_must_not_be_unlinked_while_listener_is_live():
    with tempfile.TemporaryDirectory(prefix="wifi-runtime-") as temporary:
        root = Path(temporary)
        authority, directory = root / "authority", root / "ipc"
        authority.mkdir(mode=0o700)
        directory.mkdir(mode=0o700)
        path = directory / "socket"
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(str(path))
            path.chmod(0o600)
            listener.listen(1)
            inode = path.stat().st_ino
            with runtime.runtime_lock(authority) as guard:
                with pytest.raises(LocalTrustError, match="SOCKET_RECOVERY_DENIED"):
                    runtime._reclaim_stale_socket(
                        path,
                        guard=guard,
                        expected_gid=os.getgid(),
                        expected_mode=0o600,
                        _owner_uid=os.getuid(),
                    )
            assert path.stat().st_ino == inode


@pytest.mark.skipif(os.name != "posix", reason="POSIX flock and Unix socket permissions")
@pytest.mark.parametrize("parent_mode", [0o750, 0o755])
def test_network_socket_recovery_rejects_a_non_private_parent(parent_mode):
    with tempfile.TemporaryDirectory(prefix="wifi-runtime-") as temporary:
        root = Path(temporary)
        authority, directory = root / "authority", root / "ipc"
        authority.mkdir(mode=0o700)
        directory.mkdir(mode=parent_mode)
        directory.chmod(parent_mode)
        path = directory / "socket"
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(str(path))
        path.chmod(0o600)
        with runtime.runtime_lock(authority) as guard:
            with pytest.raises(LocalTrustError, match="SOCKET_RECOVERY_DENIED"):
                runtime._reclaim_stale_socket(
                    path,
                    guard=guard,
                    expected_gid=os.getgid(),
                    expected_mode=0o600,
                    _owner_uid=os.getuid(),
                )
        assert path.exists()
