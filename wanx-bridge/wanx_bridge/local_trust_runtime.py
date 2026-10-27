"""Run only the independent local management listener; no SSO/Octop startup."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import errno
import os
import secrets
import socket
import ssl
import stat
import sys
import threading
from contextlib import contextmanager
from dataclasses import dataclass

try:
    import fcntl
except ImportError:  # Windows has no reviewed ACL/lock adapter for this box service.
    fcntl = None

import uvicorn

from .local_authority_store import LocalTrustAuthority
from .local_trust_config import NETWORK_SOCKET, LocalTrustConfig, LocalTrustError
from .local_trust_protocol import BindingProtocolError
from .local_trust_server import create_app
from .local_trust_service import LocalTrustService


@dataclass
class _HeldRuntimeLock:
    directory: object
    fd: int
    pid: int
    active: bool = True


def _reclaim_stale_socket(path, *, guard, expected_gid, expected_mode=0o660, _owner_uid=0):
    """Production callers always require root ownership; UID seam is tests only."""
    if expected_mode not in (0o600, 0o660):
        raise LocalTrustError("LOCAL_TRUST_SOCKET_RECOVERY_DENIED")
    if not os.path.lexists(path):
        return
    if guard is None or not guard.active or guard.pid != os.getpid():
        raise LocalTrustError("LOCAL_TRUST_SOCKET_RECOVERY_DENIED")
    lock_info = os.fstat(guard.fd)
    named_lock = (guard.directory / "management-runtime.lock").lstat()
    if (lock_info.st_dev, lock_info.st_ino) != (named_lock.st_dev, named_lock.st_ino):
        raise LocalTrustError("LOCAL_TRUST_SOCKET_RECOVERY_DENIED")
    # The owner minted this guard only after obtaining the authority flock.
    fcntl.flock(guard.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    parent = path.parent.lstat()
    if (
        not stat.S_ISDIR(parent.st_mode)
        or parent.st_uid != _owner_uid
        or parent.st_mode & 0o022
        or parent.st_gid != expected_gid
        or expected_mode == 0o600
        and stat.S_IMODE(parent.st_mode) != 0o700
    ):
        raise LocalTrustError("LOCAL_TRUST_SOCKET_RECOVERY_DENIED")
    before = path.lstat()

    def valid(info):
        return (
            stat.S_ISSOCK(info.st_mode)
            and info.st_uid == _owner_uid
            and info.st_gid == expected_gid
            and info.st_nlink == 1
            and stat.S_IMODE(info.st_mode) == expected_mode
        )

    if not valid(before):
        raise LocalTrustError("LOCAL_TRUST_SOCKET_RECOVERY_DENIED")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.25)
        try:
            probe.connect(str(path))
        except OSError as error:
            if error.errno != errno.ECONNREFUSED:
                raise LocalTrustError("LOCAL_TRUST_SOCKET_RECOVERY_DENIED") from None
        else:
            raise LocalTrustError("LOCAL_TRUST_SOCKET_RECOVERY_DENIED")
    after = path.lstat()
    if not valid(after) or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        raise LocalTrustError("LOCAL_TRUST_SOCKET_RECOVERY_DENIED")
    path.unlink()
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextmanager
def runtime_lock(directory):
    if fcntl is None or os.name != "posix":
        raise LocalTrustError("LOCAL_TRUST_PLATFORM_UNSUPPORTED")
    fd = os.open(
        directory / "management-runtime.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600
        ):
            raise LocalTrustError("LOCAL_TRUST_LOCK_INVALID")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LocalTrustError("LOCAL_TRUST_ALREADY_RUNNING") from None
        guard = _HeldRuntimeLock(directory, fd, os.getpid())
        try:
            yield guard
        finally:
            guard.active = False
    finally:
        os.close(fd)


def server_for(
    config: LocalTrustConfig, service: LocalTrustService, application=None
) -> uvicorn.Server:
    from .local_data_transport import LocalDataHTTPProtocol, LocalDataWebSocketProtocol

    return uvicorn.Server(
        uvicorn.Config(
            application or create_app(service, authority=config.authority),
            host=config.bind_host,
            port=config.bind_port,
            ssl_certfile=str(config.tls_certificate),
            ssl_keyfile=str(config.tls_private_key),
            ssl_version=ssl.PROTOCOL_TLS_SERVER,
            proxy_headers=False,
            forwarded_allow_ips="",
            access_log=False,
            log_level="warning",
            server_header=False,
            timeout_graceful_shutdown=10,
            timeout_keep_alive=5,
            http=LocalDataHTTPProtocol if application is not None else "auto",
            ws=LocalDataWebSocketProtocol if application is not None else "none",
            workers=1,
        )
    )


async def _serve(config: LocalTrustConfig, runtime_guard=None) -> None:
    authority = await asyncio.to_thread(
        LocalTrustAuthority,
        config.state_directory,
        boot_id=secrets.token_urlsafe(32),
    )
    service = LocalTrustService(authority)
    components = None
    async with contextlib.AsyncExitStack() as cleanup:
        # Register each owner before starting it. A partial start or failed
        # shutdown must still drain the other listeners before the sole ledger.
        cleanup.push_async_callback(service.close)
        from .local_team_config import load_team_identity_policy
        from .local_trust_operations_loader import create_operation_provider

        team_policy = await asyncio.to_thread(load_team_identity_policy)
        await service.execute_authority(authority.configure_team_identity, team_policy)
        provider = await service.execute_authority(create_operation_provider, authority)
        if provider is not None:
            cleanup.push_async_callback(asyncio.to_thread, provider.close)
            await asyncio.to_thread(provider.start)
        if config.data_config is not None:
            from .local_wifi_authority import LocalWifiAuthority
            from .local_wifi_broker import LocalWifiBroker

            wifi = await service.execute_authority(LocalWifiAuthority, authority)
            await asyncio.to_thread(
                _reclaim_stale_socket,
                NETWORK_SOCKET,
                guard=runtime_guard,
                expected_gid=0,
                expected_mode=0o600,
            )
            network = LocalWifiBroker(
                wifi, execute_authority=service.execute_authority, socket_path=NETWORK_SOCKET
            )
            cleanup.push_async_callback(network.close)
            await network.start()
            components = await data_application(
                config, authority, service, operation_provider=provider, runtime_guard=runtime_guard
            )
            _, gateway, broker, sessions = components
            cleanup.push_async_callback(broker.close)
            cleanup.push_async_callback(gateway.close)
            cleanup.push_async_callback(sessions.close)
        await server_for(config, service, components[0] if components else None).serve()


class RuntimeDispatcher:
    """Keep management HTTP restrictions independent from data streams/WS."""

    def __init__(self, management, gateway):
        self.management, self.gateway = management, gateway

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            # The runtime owns startup and drains every component before closing
            # its sole authority; never let an inner application's lifespan
            # close that authority while another listener is still serving.
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        path = scope.get("path", "")
        target = (
            self.management
            if path.startswith("/local-trust/") and not path.startswith("/local-trust/v1/data/")
            else self.gateway
        )
        await target(scope, receive, send)


async def _install_worker_observer(provider, sessions, service):
    loop = asyncio.get_running_loop()
    # One complete pending snapshot, regardless of how often a worker
    # reports. Thread callbacks must not enqueue unbounded asyncio tasks.
    pending_lock = threading.Lock()
    pending = {"value": None, "scheduled": False}
    observed = asyncio.Event()

    async def drain_worker():
        try:
            while True:
                with pending_lock:
                    value = pending["value"]
                    pending["value"] = None
                    if value is None:
                        pending["scheduled"] = False
                        return
                await sessions.observe_worker(value)
                observed.set()
        except BaseException:
            with pending_lock:
                pending["scheduled"] = False
            raise

    def worker_observer(value):
        with pending_lock:
            pending["value"] = value
            if pending["scheduled"]:
                return
            pending["scheduled"] = True
        loop.call_soon_threadsafe(service.schedule_authority_change, drain_worker)

    await asyncio.to_thread(provider.install_effect_observer, worker_observer)
    # A missing/not-ready worker keeps effect unknown; it must never be
    # interpreted as an empty, already-closed job inventory.
    with contextlib.suppress(TimeoutError):
        async with asyncio.timeout(1):
            await observed.wait()


async def data_application(
    config, authority, service, *, operation_provider=None, runtime_guard=None
):
    from cryptography.hazmat.primitives import serialization

    from .assets import DashboardAssets, installed_dashboard
    from .local_data_broker import LocalDataBroker
    from .local_data_config import LocalDataConfig
    from .local_data_gateway import LocalDataGateway
    from .local_data_protocol import (
        public_jwk,
        public_key_thumbprint,
        sign_data_response,
        sign_gateway_grants,
        sign_gateway_lease,
        sign_gateway_members,
        sign_gateway_observation,
        sign_gateway_request,
        sign_gateway_resources,
        sign_gateway_task,
        verify_gateway_request,
    )
    from .local_data_routes import application_policy, child_policy, route_policy
    from .local_data_sessions import LocalDataSessions
    from .local_trust_config import private_file
    from .version import bridge_build_metadata, version_snapshot

    settings = await asyncio.to_thread(
        LocalDataConfig.load,
        config.data_config,
        authority_directory=config.state_directory,
        box_id=authority.bundle["boxId"],
    )

    def load_key():
        return serialization.load_pem_private_key(
            private_file(config.state_directory / "box-signing-key.pem", 16384), password=None
        )

    box_key = await asyncio.to_thread(load_key)
    gateway_key = settings.gateway_key
    gateway = None

    async def operation_closed(operation, reason):
        if gateway is not None:
            await gateway.operation_closed(operation, reason)

    sessions = LocalDataSessions(
        authority=authority,
        execute_authority=service.execute_authority,
        box_id=authority.bundle["boxId"],
        box_key_thumbprint=public_key_thumbprint(authority.bundle["boxKey"]),
        box_response_signer=lambda kind, body, now: sign_data_response(
            box_key, box_id=authority.bundle["boxId"], kind=kind, body=body, now_ms=now
        ),
        gateway_signer=lambda payload: sign_gateway_request(payload, gateway_key),
        gateway_verifier=lambda proof, now: verify_gateway_request(
            proof, public_jwk(gateway_key), now_ms=now
        ),
        gateway_lease_signer=lambda payload: sign_gateway_lease(payload, gateway_key),
        gateway_resources_signer=lambda payload: sign_gateway_resources(payload, gateway_key),
        gateway_observation_signer=lambda payload: sign_gateway_observation(payload, gateway_key),
        gateway_members_signer=lambda payload: sign_gateway_members(payload, gateway_key),
        gateway_task_signer=lambda payload: sign_gateway_task(payload, gateway_key),
        gateway_grants_signer=lambda payload: sign_gateway_grants(payload, gateway_key),
        required_audiences=frozenset(settings.upstreams),
        worker_required=operation_provider is not None,
        gateway_id=settings.gateway_id,
        application_policy=application_policy,
        route_policy=route_policy,
        child_policy=child_policy,
        on_operation_closed=operation_closed,
    )
    service.on_authority_changed = sessions.invalidate_authority
    assets = DashboardAssets(installed_dashboard())
    metadata = bridge_build_metadata()

    async def metadata_handler(path):
        if path == "/api/platform/assets/manifest":
            return await assets.manifest()
        if path == "/api/platform/version":
            result = version_snapshot(None, metadata)
            result["deviceId"] = authority.bundle["boxId"]
            result["boxKeyThumbprint"] = public_key_thumbprint(authority.bundle["boxKey"])
            return result
        raise LocalTrustError("LOCAL_DATA_ROUTE_DENIED", 403)

    gateway = LocalDataGateway(
        sessions,
        upstreams=settings.upstreams,
        staging_directory=settings.staging_directory,
        authority=config.authority,
        metadata_handler=metadata_handler,
    )
    socket_gid = settings.broker_socket.parent.stat().st_gid
    await asyncio.to_thread(
        _reclaim_stale_socket, settings.broker_socket, guard=runtime_guard, expected_gid=socket_gid
    )
    broker = LocalDataBroker(
        sessions,
        socket_path=settings.broker_socket,
        audience_uids={name: item["uid"] for name, item in settings.upstreams.items()},
        socket_gid=socket_gid,
    )
    try:
        await broker.start()
        await gateway.start()
        loop = asyncio.get_running_loop()

        async def committed(value):
            if value is not None:
                await sessions.observe_commit(value)
            await sessions.invalidate_authority()

        def commit_observer(value):
            loop.call_soon_threadsafe(service.schedule_authority_change, committed, value)

        if operation_provider is not None:
            await _install_worker_observer(operation_provider, sessions, service)

        install_effect = getattr(authority, "install_effect_provider", None)
        install_observer = getattr(authority, "install_commit_observer", None)
        if install_effect is not None:
            await service.execute_authority(
                lambda: install_effect(sessions.effect_snapshot, generation=sessions.generation)
            )
        if install_observer is not None:
            await service.execute_authority(install_observer, commit_observer)
    except BaseException:
        await sessions.close()
        with contextlib.suppress(Exception):
            await gateway.close()
        with contextlib.suppress(Exception):
            await broker.close()
        raise
    return (
        RuntimeDispatcher(create_app(service, authority=config.authority), gateway),
        gateway,
        broker,
        sessions,
    )


def run(config: LocalTrustConfig) -> None:
    # Startup file I/O precedes the event loop. Lock before assigning a
    # generation or opening the authoritative store, and hold until drained.
    with runtime_lock(config.state_directory) as guard:
        asyncio.run(_serve(config, guard))


def main():
    parser = argparse.ArgumentParser(description="Independent local-trust HTTPS management")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        config = LocalTrustConfig.load(args.config)
        run(config)
    except KeyboardInterrupt:
        pass
    except (LocalTrustError, BindingProtocolError) as error:
        print(error.code, file=sys.stderr)
        raise SystemExit(1) from None
    except Exception:
        print("LOCAL_TRUST_STARTUP_FAILED", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
