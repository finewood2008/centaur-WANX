"""Independent clipboard API. WANX remains a separate, unchanged process."""

from __future__ import annotations

import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .routes import router
from .upstream import BusinessError

PREFIX = "/api/clipboard/v1"


def create_app(home: Path, upstream: str, *, transport=None) -> FastAPI:
    target = urlsplit(upstream)
    if (
        target.scheme not in {"http", "https"}
        or not target.hostname
        or target.path not in {"", "/"}
        or target.username
        or target.password
        or target.query
        or target.fragment
    ):
        raise ValueError("WANX upstream must be a fixed origin without credentials")
    home = home.resolve()
    home.mkdir(parents=True, exist_ok=True, mode=0o700)

    @asynccontextmanager
    async def lifespan(app):
        yield
        app.state.wanx.close()

    app = FastAPI(
        title="WANX Super Clipboard business service",
        lifespan=lifespan,
        docs_url=PREFIX + "/docs",
        openapi_url=PREFIX + "/openapi.json",
        redoc_url=None,
    )
    app.state.home, app.state.locks = home, {}
    app.state.wanx = httpx.Client(
        base_url=upstream,
        transport=transport,
        trust_env=False,
        follow_redirects=False,
        timeout=httpx.Timeout(60, connect=5),
    )

    @app.exception_handler(BusinessError)
    async def business_error(request, exc):
        return JSONResponse({"detail": {"code": exc.code}}, status_code=exc.status)

    @app.exception_handler(sqlite3.Error)
    async def metadata_error(request, exc):
        return JSONResponse({"detail": {"code": "CLIPBOARD_METADATA_UNAVAILABLE"}}, status_code=503)

    @app.exception_handler(OSError)
    async def storage_error(request, exc):
        return JSONResponse({"detail": {"code": "CLIPBOARD_METADATA_UNAVAILABLE"}}, status_code=507)

    @app.middleware("http")
    async def business_origin(request: Request, next_handler):
        if request.url.path.startswith(PREFIX):
            origin = request.headers.get("origin")
            if origin and origin != str(request.base_url).rstrip("/"):
                return JSONResponse(
                    {"detail": {"code": "CLIPBOARD_ORIGIN_DENIED"}}, status_code=403
                )
        response = await next_handler(request)
        if request.url.path.startswith(PREFIX):
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            api = getattr(request.state, "wanx_api", None)
            if api and api.renewed:
                response.headers["X-Octop-Access-Token"] = api.renewed
        return response

    app.include_router(router, prefix=PREFIX)
    return app
