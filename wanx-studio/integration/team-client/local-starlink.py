"""Local Starlink service plus the existing private model callback transport."""
import asyncio
from pathlib import Path
import sys
import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import Response

STARLINK=Path('/Volumes/OneDrive/OneDrive/AI/centaurAI/万象app/centuarai-semantica')
sys.path.insert(0,str(STARLINK))
from app.main import create_app

callback=FastAPI(docs_url=None,redoc_url=None,openapi_url=None)

@callback.post('/internal/starklink/models')
async def models(request:Request):
    if request.headers.get('origin'):
        return Response(status_code=403)
    body=bytearray()
    async for part in request.stream():
        body.extend(part)
        if len(body)>512*1024:return Response(status_code=413)
    headers={k:request.headers[k] for k in ['content-type','x-starklink-time','x-starklink-nonce','x-starklink-signature'] if k in request.headers}
    try:
        async with httpx.AsyncClient(timeout=330,trust_env=False,follow_redirects=False) as client:
            response=await client.post('http://127.0.0.1:8089/internal/starklink/models',headers=headers,content=bytes(body))
        return Response(response.content,status_code=response.status_code,media_type='application/json',headers={'Cache-Control':'no-store'})
    except httpx.HTTPError:
        return Response('{"code":"MODEL_RELAY_UNAVAILABLE"}',status_code=503,media_type='application/json')

async def main():
    service=uvicorn.Server(uvicorn.Config(create_app(),host='127.0.0.1',port=8090,log_level='warning'))
    relay=uvicorn.Server(uvicorn.Config(callback,host='127.0.0.1',port=18089,log_level='warning'))
    await asyncio.gather(service.serve(),relay.serve())

if __name__=='__main__':asyncio.run(main())
