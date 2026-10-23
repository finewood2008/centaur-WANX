"""The existing WANX model can be configured or removed without restarting Builder."""
from pathlib import Path
from fastapi import FastAPI
from httpx import AsyncClient, ASGITransport
from wanx_studio.api import create_router
from wanx_studio.service import StudioService
from wanx_studio.wanx import WanxModels

async def test_context_tracks_model_configuration_changes_without_restart(tmp_path):
    selection={'current':None}
    models=WanxModels.__new__(WanxModels)
    models.resolve=lambda:selection['current']
    svc=StudioService(tmp_path,Path(__file__).resolve().parents[2],models)
    app=FastAPI()
    async def identity():return 'alice'
    app.include_router(create_router(svc,identity))
    try:
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
            assert (await client.get('/api/app-studio/context')).json()['modelAvailable'] is False
            selection['current']=object()
            assert (await client.get('/api/app-studio/context')).json()['modelAvailable'] is True
            selection['current']=None
            assert (await client.get('/api/app-studio/context')).json()['modelAvailable'] is False
        assert svc.store.db.execute('select count(*) from usage').fetchone()[0]==0
    finally:await svc.close()
