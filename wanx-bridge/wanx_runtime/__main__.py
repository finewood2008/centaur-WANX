"""Container composition root, extending the upstream app without monkeypatches."""

from __future__ import annotations

import argparse
import asyncio

import uvicorn
from octop.api.app import build_app
from octop.infra.agents.memory.slim_control import MemorySlimControl
from octop.infra.server import OctopServer
from octop.infra.setup.tls.http_companion import build_http_companion_app
from octop.infra.setup.tls.listeners import build_listen_plan
from octop.infra.setup.tls.store import resolve_tls_paths
from octop.launch import _cancel_background_task, _schedule_linux_bubblewrap_ensure

from .application_exchange import install_application_exchange


async def run(*, host: str, port: int) -> None:
    """Retain native server, memory, TLS listeners and shutdown lifecycle."""
    server = OctopServer()
    await server.start()
    background = _schedule_linux_bubblewrap_ensure()
    memory = MemorySlimControl(server)
    try:
        config = server.services.config if server.services is not None else server.config
        assert config is not None
        certfile, keyfile = resolve_tls_paths(server.paths.root, config.tls)
        plan = build_listen_plan(
            config, bind_host=host, bind_port=port, ssl_certfile=certfile, ssl_keyfile=keyfile
        )
        app = build_app(server)
        install_application_exchange(app)
        listeners = [
            uvicorn.Server(
                uvicorn.Config(
                    app,
                    host=plan.bind_host,
                    port=plan.https_port if plan.dual_listeners else plan.http_port or port,
                    log_level=config.log_level.lower(),
                    ssl_certfile=plan.ssl_certfile,
                    ssl_keyfile=plan.ssl_keyfile,
                )
            )
        ]
        if plan.dual_listeners:
            listeners.append(
                uvicorn.Server(
                    uvicorn.Config(
                        build_http_companion_app(https_port=plan.https_port),
                        host=plan.bind_host,
                        port=plan.http_port,
                        log_level=config.log_level.lower(),
                    )
                )
            )
        await memory.start()
        await asyncio.gather(*(listener.serve() for listener in listeners))
    finally:
        await memory.close()
        await _cancel_background_task(background)
        await server.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description="WANX container API with product session exchange")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8088)
    args = parser.parse_args()
    asyncio.run(run(host=args.host, port=args.port))


if __name__ == "__main__":
    main()
