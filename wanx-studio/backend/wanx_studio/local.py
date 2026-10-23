"""Loopback-only synthetic preview. No real WANX identity, files or model keys."""
from __future__ import annotations

import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse

from .api import create_router
from .contracts import StudioError
from .service import StudioService
from .runner import Runner


def build_local(root: Path | None = None):
    project=Path(__file__).resolve().parents[2]
    service=StudioService(root or project/'.runtime/local-wanx',project)
    service.runner=Runner(service)
    token=secrets.token_urlsafe(32)

    @asynccontextmanager
    async def lifespan(app):
        yield
        await service.close()

    app=FastAPI(title='WANX Studio isolated local preview',lifespan=lifespan)
    app.state.studio=service

    @app.middleware('http')
    async def local_boundary(request,call_next):
        origin=request.headers.get('origin')
        if origin and origin not in {'http://127.0.0.1:5178','http://127.0.0.1:5179','http://localhost:5178','http://testserver'}:
            return JSONResponse({'code':'ORIGIN_DENIED'},403)
        if request.headers.get('sec-fetch-site')=='cross-site':
            return JSONResponse({'code':'ORIGIN_DENIED'},403)
        response=await call_next(request)
        response.headers['Cache-Control']='no-store'
        return response

    async def identity(request:Request):
        if request.cookies.get('wanx_studio_preview')!=token:
            raise HTTPException(401,detail={'code':'PREVIEW_SESSION_REQUIRED'})
        return 'synthetic-local-user'

    @app.get('/api/app-studio/session')
    async def session():
        response=JSONResponse({'mode':'local-preview'})
        response.set_cookie('wanx_studio_preview',token,httponly=True,samesite='strict',path='/api')
        return response

    @app.exception_handler(StudioError)
    async def failure(_request,error):
        return JSONResponse({'code':error.code},error.status)

    app.include_router(create_router(service,identity,local_preview=True))
    return app


if __name__=='__main__':
    import uvicorn
    uvicorn.run(build_local(),host='127.0.0.1',port=int(os.environ.get('WANX_STUDIO_PORT','5179')),log_level='warning')
