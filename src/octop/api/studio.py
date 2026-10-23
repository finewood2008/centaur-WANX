"""Register the shared Builder component before the dashboard fallback."""

import os
from importlib import import_module
from pathlib import Path

from fastapi import FastAPI

from octop.infra.server import OctopServer


def mount_studio(app: FastAPI, server: OctopServer) -> None:
    # Documentation-only app factories have no running database lifecycle.
    if server.services is None or not getattr(server, "database_bound", False):
        return
    configured = os.environ.get("WANX_STUDIO_ROOT")
    root = (
        Path(configured).expanduser().resolve()
        if configured
        else Path(__file__).resolve().parents[3] / "wanx-studio"
    )
    # Source deployments install Node dependencies here. Wheel deployments point
    # WANX_STUDIO_ROOT at the separately installed, versioned Builder component.
    if not (root / "package.json").is_file():
        return
    service = import_module("wanx_studio.wanx").mount_wanx(app, server, root)
    server.add_shutdown_callback(service.close)
