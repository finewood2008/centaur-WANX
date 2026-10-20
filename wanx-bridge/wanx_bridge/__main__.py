"""Run the private identity provider and public WANX bridge as one supervised unit."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import secrets
import signal
import stat
import sys
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import uvicorn
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .admin_client import AdminClient
from .auth import PlatformAuthService
from .config import BridgeAuthError, PlatformConfig
from .model_provider_catalog import ModelProviderCatalog, ModelProviderConfig
from .model_provider_runtime import ModelProviderRuntime
from .oidc import OidcError, OidcProvider, loopback_origin
from .resources import ResourceCatalog, ResourceConfig
from .resources_runtime import ResourceRuntime
from .server import create_app
from .upstream import BridgeUpstreamError, OctopAdapter


class RuntimeFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class RuntimeConfig:
    oidc_host: str
    oidc_port: int
    bind_host: str
    bind_port: int
    upstream_url: str
    credentials_file: Path

    @property
    def issuer(self) -> str:
        host = "[::1]" if self.oidc_host == "::1" else self.oidc_host
        return f"http://{host}:{self.oidc_port}"

    @classmethod
    def from_env(cls) -> RuntimeConfig:
        try:
            config = cls(
                os.getenv("WANX_BRIDGE_OIDC_HOST", "127.0.0.1"),
                int(os.getenv("WANX_BRIDGE_OIDC_PORT", "18089")),
                os.getenv("WANX_BRIDGE_BIND_HOST", "127.0.0.1"),
                int(os.getenv("WANX_BRIDGE_PORT", "8088")),
                loopback_origin(os.getenv("WANX_BRIDGE_UPSTREAM_URL", "http://127.0.0.1:18088")),
                Path(
                    os.getenv("WANX_BRIDGE_ADMIN_CREDENTIAL_FILE", "/data/.octop/credential.json")
                ),
            )
            if (
                config.oidc_host not in {"127.0.0.1", "::1"}
                or not 1 <= config.oidc_port <= 65535
                or not 1 <= config.bind_port <= 65535
                or len(
                    {config.bind_port, config.oidc_port, urlsplit(config.upstream_url).port or 80}
                )
                != 3
                or not config.bind_host
            ):
                raise ValueError()
            return config
        except (ValueError, TypeError) as exc:
            raise RuntimeFailure("BOX_BRIDGE_CONFIG_INVALID") from exc


def load_provider(config: PlatformConfig, runtime: RuntimeConfig) -> OidcProvider:
    """Create a durable OIDC identity without ever replacing an existing identity."""
    directory = config.state_dir
    path = directory / "oidc-identity.json"
    try:
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or (os.name == "posix" and info.st_uid != os.geteuid()):
            raise ValueError()
        directory.chmod(0o700)
        if not path.exists() and not path.is_symlink():
            key = ec.generate_private_key(ec.SECP256R1())
            value = {
                "version": 1,
                "device_id": config.device_id,
                "private_key": key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8,
                    serialization.NoEncryption(),
                ).decode(),
                "client_secret": secrets.token_urlsafe(48),
            }
            descriptor, temporary = tempfile.mkstemp(prefix=".oidc-", dir=directory)
            try:
                with os.fdopen(descriptor, "w") as stream:
                    json.dump(value, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                # link is atomic and refuses overwriting another process's key.
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    pass
            finally:
                os.unlink(temporary)
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_size > 8192
                or (os.name == "posix" and (info.st_mode & 0o077 or info.st_uid != os.geteuid()))
            ):
                raise ValueError()
            value = json.loads(stream.read(8193))
        if value.get("version") != 1 or value.get("device_id") != config.device_id:
            raise ValueError()
        loaded_key = serialization.load_pem_private_key(
            value["private_key"].encode(), password=None
        )
        if not isinstance(loaded_key, ec.EllipticCurvePrivateKey):
            raise ValueError()
        client_id = "wanx-bridge-" + hashlib.sha256(config.device_id.encode()).hexdigest()[:32]
        return OidcProvider(runtime.issuer, client_id, value["client_secret"], loaded_key)
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        raise RuntimeFailure("BOX_BRIDGE_IDENTITY_INVALID") from exc


def create_private_app(provider: OidcProvider) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/.well-known/openid-configuration")
    async def discovery() -> dict[str, Any]:
        return provider.discovery()

    @app.get("/jwks")
    async def jwks() -> dict[str, Any]:
        return provider.jwks()

    @app.post("/token")
    async def token(request: Request) -> JSONResponse:
        if (
            request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            != "application/x-www-form-urlencoded"
        ):
            return JSONResponse({"error": "invalid_request"}, status_code=400)
        raw = bytearray()
        try:
            async with asyncio.timeout(10):
                async for chunk in request.stream():
                    raw.extend(chunk)
                    if len(raw) > 8192:
                        return JSONResponse({"error": "invalid_request"}, status_code=413)
            values = parse_qs(
                raw.decode("utf-8"),
                keep_blank_values=True,
                strict_parsing=True,
                max_num_fields=16,
                errors="strict",
            )
            if any(len(value) != 1 for value in values.values()):
                raise ValueError()
            result = provider.exchange({name: value[0] for name, value in values.items()})
            return JSONResponse(result, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})
        except OidcError as exc:
            return JSONResponse(
                {"error": exc.code},
                status_code=401 if exc.code == "invalid_client" else 400,
                headers={"Cache-Control": "no-store"},
            )
        except (ValueError, TimeoutError):
            return JSONResponse({"error": "invalid_request"}, status_code=400)

    return app


class _Server(uvicorn.Server):
    @contextlib.contextmanager
    def capture_signals(self) -> Iterator[None]:
        # The supervisor installs exactly one pair of handlers for both listeners.
        yield


def _new_server(app: FastAPI, host: str, port: int) -> uvicorn.Server:
    return _Server(
        uvicorn.Config(
            app,
            host=host,
            port=port,
            access_log=False,
            log_level="warning",
            timeout_graceful_shutdown=5,
            server_header=False,
        )
    )


async def _serve(server: uvicorn.Server) -> None:
    try:
        await server.serve()
    except SystemExit as exc:
        raise RuntimeFailure("BOX_BRIDGE_LISTENER_FAILED") from exc


async def _started(server: uvicorn.Server, task: asyncio.Task[None]) -> None:
    async with asyncio.timeout(10):
        while not server.started:
            if task.done():
                await task
                raise RuntimeFailure("BOX_BRIDGE_LISTENER_FAILED")
            await asyncio.sleep(0.02)


async def _wait_upstream(url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
    async with httpx.AsyncClient(
        trust_env=False, follow_redirects=False, timeout=2, transport=transport
    ) as client:
        async with asyncio.timeout(60):
            while True:
                try:
                    async with client.stream("GET", url + "/api/health") as response:
                        if response.status_code == 200:
                            raw = bytearray()
                            async for chunk in response.aiter_bytes():
                                raw.extend(chunk)
                                if len(raw) > 8192:
                                    raise ValueError()
                            health = json.loads(raw)
                            if (
                                isinstance(health, dict)
                                and health.get("ok") is True
                                and health.get("db") is True
                            ):
                                return
                except (httpx.HTTPError, ValueError):
                    pass
                await asyncio.sleep(0.5)


async def run(stop: asyncio.Event | None = None) -> None:
    runtime = RuntimeConfig.from_env()
    config = PlatformConfig.from_env()
    provider = await asyncio.to_thread(load_provider, config, runtime)
    auth = PlatformAuthService(config)
    adapter = OctopAdapter(runtime.upstream_url, provider, runtime.credentials_file)
    resources = None
    try:
        resource_config = ResourceConfig.from_env()
        if resource_config is not None:
            if resource_config.device_id != config.device_id:
                raise BridgeAuthError("RESOURCE_DEVICE_IDENTITY_MISMATCH", 503)
            resources = ResourceRuntime(
                ResourceCatalog(resource_config),
                AdminClient(runtime.upstream_url, runtime.credentials_file),
            )
    except (BridgeAuthError, OSError):
        # Optional resource setup cannot take existing logins/apps offline.
        print("RESOURCE_SERVICE_NOT_CONFIGURED", file=sys.stderr)
    models = None
    model_task = None
    try:
        model_config = ModelProviderConfig.from_env()
        if model_config is not None:
            if model_config.identity_device_id != config.device_id:
                raise BridgeAuthError("MODEL_PROVIDER_DEVICE_IDENTITY_MISMATCH", 503)
            models = ModelProviderRuntime(
                ModelProviderCatalog(model_config),
                AdminClient(runtime.upstream_url, runtime.credentials_file),
                runtime.issuer,
                authority_check=auth.assert_model_binding,
            )
    except (BridgeAuthError, OSError) as exc:
        # A model configuration outage must not take box login or local providers down.
        print(getattr(exc, "code", "MODEL_PROVIDER_LOCAL_CONFIG_INVALID"), file=sys.stderr)
    servers: list[uvicorn.Server] = []
    tasks: list[asyncio.Task[None]] = []
    pending: asyncio.Task[Any] | None = None
    stop = stop or asyncio.Event()
    stopping = asyncio.create_task(stop.wait())
    loop = asyncio.get_running_loop()
    installed: list[tuple[signal.Signals, Any]] = []
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            previous = signal.getsignal(signum)
            loop.add_signal_handler(signum, stop.set)
            installed.append((signum, previous))
        except (NotImplementedError, RuntimeError):
            pass

    async def startup() -> None:
        await _started(servers[0], tasks[0])
        await _wait_upstream(runtime.upstream_url)
        await adapter.initialize()

    try:
        private_app = create_private_app(provider)
        if models is not None:
            models.register_routes(private_app)
        private = _new_server(private_app, runtime.oidc_host, runtime.oidc_port)
        servers.append(private)
        tasks.append(asyncio.create_task(_serve(private)))
        pending = asyncio.create_task(startup())
        done, _ = await asyncio.wait(
            [pending, stopping, tasks[0]], return_when=asyncio.FIRST_COMPLETED
        )
        if stopping in done:
            return
        if tasks[0] in done:
            await tasks[0]
            raise RuntimeFailure("BOX_BRIDGE_LISTENER_FAILED")
        await pending
        pending = None
        if models is not None:
            model_task = asyncio.create_task(models.poll())
        public = _new_server(
            create_app(
                auth,
                adapter,
                upstream_url=runtime.upstream_url,
                resources=resources,
                clipboard_url=os.getenv("WANX_BRIDGE_CLIPBOARD_URL", "http://127.0.0.1:8092")
                or None,
            ),
            runtime.bind_host,
            runtime.bind_port,
        )
        servers.append(public)
        tasks.append(asyncio.create_task(_serve(public)))
        done, _ = await asyncio.wait([stopping, *tasks], return_when=asyncio.FIRST_COMPLETED)
        if stopping not in done:
            for task in done:
                await task
            raise RuntimeFailure("BOX_BRIDGE_LISTENER_FAILED")
    finally:
        if model_task is not None:
            model_task.cancel()
            await asyncio.gather(model_task, return_exceptions=True)
        if pending is not None:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        for server in servers:
            server.should_exit = True
        try:
            async with asyncio.timeout(8):
                await asyncio.gather(*tasks, return_exceptions=True)
        except TimeoutError:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        stopping.cancel()
        await asyncio.gather(stopping, return_exceptions=True)
        if models is not None:
            await models.close()
        try:
            await adapter.close()
        finally:
            auth.close()
        for signum, previous in installed:
            loop.remove_signal_handler(signum)
            signal.signal(signum, previous)


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    except (RuntimeFailure, BridgeAuthError, BridgeUpstreamError) as exc:
        print(exc.code, file=sys.stderr)
        raise SystemExit(1) from None
    except Exception:
        print("BOX_BRIDGE_STARTUP_FAILED", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
