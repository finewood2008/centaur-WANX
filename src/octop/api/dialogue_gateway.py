"""Standalone platform HTTP surface. Not mounted on user-controlled boxes."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse

from octop.infra.dialogue.contracts import DialogueError, Generation, event
from octop.infra.dialogue.gateway import GatewayService


def build_gateway(service: GatewayService) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        yield
        await service.client.aclose()

    app = FastAPI(title="WANX Dialogue Platform Gateway", lifespan=lifespan)

    @app.exception_handler(DialogueError)
    async def failure(request: Request, exc: DialogueError) -> JSONResponse:
        return JSONResponse({"code": exc.code}, status_code=exc.status)

    @app.get("/v1/models", summary="Models allowed for the credential's account and region")
    async def models(authorization: str | None = Header(default=None)) -> dict[str, object]:
        return {"models": service.models(service.authenticate(authorization))}

    @app.get("/v1/quota", summary="Authoritative account budget and pending reservations")
    async def quota(authorization: str | None = Header(default=None)) -> dict[str, int]:
        return await service.quota(service.authenticate(authorization))

    @app.post("/v1/generate", summary="Reserve once and stream a text-only generation")
    async def generation(
        body: Generation, authorization: str | None = Header(default=None)
    ) -> StreamingResponse:
        source = await service.prepare(service.authenticate(authorization), body)

        async def stream() -> AsyncIterator[str]:
            async for item in source:
                yield event(item)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    return app
