"""Real-process termination must drain runtime IPC before Uvicorn replays signals."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals and Unix sockets")


def _runtime_child(directory, double):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    from wanx_bridge import (
        local_team_config,
        local_trust_operations_loader,
        local_wifi_authority,
        local_wifi_broker,
    )
    from wanx_bridge import local_trust_runtime as runtime
    from wanx_bridge.local_data_broker import LocalDataBroker

    folder = Path(directory)
    os.chown(folder, -1, os.getegid())
    servers = []

    def record(value):
        with (folder / "events.jsonl").open("a") as stream:
            stream.write(json.dumps(value) + "\n")

    class Authority:
        def configure_team_identity(self, policy):
            pass

        def close(self):
            record("authority-close")

    class Provider:
        def start(self):
            pass

        def close(self):
            record("provider-close")

    class Component:
        def __init__(self, name):
            self.name = name

        async def close(self):
            if self.name == "sessions":
                (folder / "cleanup-started").touch()
                if double:
                    while not (folder / "second-signal-sent").exists():
                        await asyncio.sleep(0.001)
                    # The original Uvicorn SIGINT handler must still run while
                    # draining resources, rather than ignoring the second signal.
                    while not servers[0].force_exit:
                        await asyncio.sleep(0.001)
                    record("second-sigint-observed")
            record(self.name + "-close")

    class WifiBroker(local_wifi_broker.LocalWifiBroker):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs, _owner_uid=os.geteuid(), _owner_gid=os.getegid())

        async def close(self):
            await super().close()
            record("network-close")

    class DataBroker(LocalDataBroker):
        async def close(self):
            await super().close()
            record("native-close")

    async def app(scope, receive, send):
        assert scope["type"] == "lifespan"
        while True:
            message = await receive()
            record(message["type"])
            if message["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            else:
                await send({"type": "lifespan.shutdown.complete"})
                return

    async def data(*args, **kwargs):
        sessions = Component("sessions")
        broker = DataBroker(
            sessions, socket_path=folder / "native.sock", audience_uids={"octop": os.geteuid()}
        )
        await broker.start()
        return app, Component("gateway"), broker, sessions

    original_server_for = runtime.server_for

    def server_for(*args):
        server = original_server_for(*args)
        servers.append(server)
        return server

    # Only storage / business fixtures and existing filesystem owner seams are
    # substituted. Both brokers, LocalTrustService, server_for, _serve, Uvicorn
    # signal handling and real broker/service close implementations run intact.
    runtime.LocalTrustAuthority = lambda *args, **kwargs: Authority()
    runtime.NETWORK_SOCKET = folder / "network.sock"
    runtime._reclaim_stale_socket = lambda *args, **kwargs: None
    runtime.data_application = data
    runtime.server_for = server_for
    local_team_config.load_team_identity_policy = lambda: None
    local_trust_operations_loader.create_operation_provider = lambda authority: Provider()
    local_wifi_authority.LocalWifiAuthority = lambda authority: object()
    local_wifi_broker.LocalWifiBroker = WifiBroker

    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.now(UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = folder / "tls.pem", folder / "tls-key.pem"
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    config = SimpleNamespace(
        state_directory=folder,
        data_config=folder / "synthetic.json",
        bind_host="127.0.0.1",
        bind_port=0,
        tls_certificate=cert_path,
        tls_private_key=key_path,
    )

    async def execute():
        async def ready():
            while not servers or not servers[0].started:
                await asyncio.sleep(0.001)
            (folder / "ready").touch()

        marker = asyncio.create_task(ready())
        await runtime._serve(config)
        await marker

    asyncio.run(execute())


@pytest.mark.parametrize(
    "signum,double", [(signal.SIGTERM, False), (signal.SIGINT, False), (signal.SIGINT, True)]
)
def test_runtime_signal_drains_owned_resources_before_replay(signum, double):
    from wanx_bridge import local_trust_runtime as runtime

    # Keep socket names below macOS/Linux sockaddr_un length limits.
    with tempfile.TemporaryDirectory(prefix="trust-signal-") as directory:
        folder = Path(directory)
        environment = os.environ.copy()
        bridge = str(Path(runtime.__file__).resolve().parents[1])
        environment["PYTHONPATH"] = os.pathsep.join(
            filter(None, (bridge, environment.get("PYTHONPATH")))
        )
        process = subprocess.Popen(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--signal-child",
                directory,
                str(int(double)),
            ],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        deadline = time.monotonic() + 15

        def wait_for(name):
            while not (folder / name).exists():
                if process.poll() is not None:
                    stdout, stderr = process.communicate(timeout=2)
                    pytest.fail(
                        f"runtime exited before {name}: {process.returncode}\n{stdout}\n{stderr}"
                    )
                assert time.monotonic() < deadline, f"runtime did not reach {name}"
                time.sleep(0.005)

        try:
            wait_for("ready")
            assert (folder / "native.sock").exists() and (folder / "network.sock").exists()
            process.send_signal(signum)
            if double:
                wait_for("cleanup-started")
                process.send_signal(signum)
                (folder / "second-signal-sent").touch()
            stdout, stderr = process.communicate(timeout=10)
            assert process.returncode == -signum, (process.returncode, stdout, stderr)
            assert not (folder / "native.sock").exists(), (
                "native socket survived graceful termination"
            )
            assert not (folder / "network.sock").exists(), (
                "network socket survived graceful termination"
            )
            events = [
                json.loads(line) for line in (folder / "events.jsonl").read_text().splitlines()
            ]
            required = [
                "sessions-close",
                "gateway-close",
                "native-close",
                "network-close",
                "provider-close",
                "authority-close",
            ]
            assert [event for event in events if event in required] == required
            if double:
                assert "second-sigint-observed" in events
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)


if __name__ == "__main__" and len(sys.argv) == 4 and sys.argv[1] == "--signal-child":
    _runtime_child(sys.argv[2], bool(int(sys.argv[3])))
