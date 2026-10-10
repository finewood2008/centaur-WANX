"""Optional LAN advertisement. Discovery never grants access to private APIs."""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import socket
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from zeroconf import ServiceInfo, Zeroconf

logger = logging.getLogger(__name__)


def mount_lan_discovery(app: FastAPI, server: Any) -> None:
    from octop import __version__

    paths = getattr(server, "paths", None) or server.services.paths
    identity_file = Path(paths.config).parent / "lan-service-id"
    try:
        server_id = str(uuid.UUID(identity_file.read_text().strip()))
    except (OSError, ValueError):
        server_id = str(uuid.uuid4())
        try:
            identity_file.write_text(server_id, encoding="utf-8")
            identity_file.chmod(0o600)
        except OSError:
            logger.warning("LAN identity could not be persisted")
    identity: dict[str, Any] = {
        "product": "wanx",
        "protocol": 1,
        "serverId": server_id,
        "name": "WANX · " + socket.gethostname().split(".")[0][:48],
        "version": __version__,
        "capabilities": ["login", "private-agents"],
    }
    if (Path(__file__).parent / "routers" / "role_ontology.py").exists():
        identity["capabilities"].append("role-ontology-v1")
    app.state.wanx_lan_endpoint = None
    running: list[tuple[Zeroconf, ServiceInfo]] = []

    @app.get("/.well-known/wanx", include_in_schema=False)
    async def wanx_identity() -> dict[str, Any]:
        return identity

    def start() -> None:
        endpoint = app.state.wanx_lan_endpoint
        if not endpoint or os.getenv("WANX_LAN_DISCOVERY", "1") == "0":
            return
        host, port, tls = endpoint
        if host in ("127.0.0.1", "localhost", "::1"):
            return
        try:
            import ifaddr
            from zeroconf import IPVersion

            addresses = []
            for adapter in ifaddr.get_adapters():
                for address in adapter.ips:
                    if not isinstance(address.ip, str):
                        continue
                    ip = ipaddress.ip_address(address.ip)
                    if (
                        ip.version == 4
                        and any(
                            ip in ipaddress.ip_network(network)
                            for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
                        )
                        and (host in ("0.0.0.0", "::") or host == address.ip)
                    ):
                        addresses.append(socket.inet_aton(address.ip))
            if not addresses:
                return
            info = ServiceInfo(
                "_wanx._tcp.local.",
                f"WANX-{server_id[:8]}._wanx._tcp.local.",
                addresses=addresses,
                port=int(port),
                properties={"serverId": server_id, "protocol": "1", "tls": "1" if tls else "0"},
                server=f"wanx-{server_id[:8]}.local.",
            )
            zc = Zeroconf(
                interfaces=[socket.inet_ntoa(address) for address in addresses],
                ip_version=IPVersion.V4Only,
            )
            try:
                zc.register_service(info)
            except Exception:
                zc.close()
                raise
            running.append((zc, info))
            logger.info("WANX LAN discovery started on port %s", port)
        except Exception:
            logger.warning(
                "WANX LAN discovery unavailable; manual address remains available", exc_info=True
            )

    def stop() -> None:
        for zc, info in running:
            try:
                zc.unregister_service(info)
            finally:
                zc.close()
        running.clear()

    async def startup() -> None:
        await asyncio.to_thread(start)

    async def shutdown() -> None:
        await asyncio.to_thread(stop)

    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[Any]:
        async with original_lifespan(application) as state:
            await startup()
            try:
                yield state
            finally:
                await shutdown()

    app.router.lifespan_context = lifespan
