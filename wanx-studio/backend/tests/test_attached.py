from contextlib import asynccontextmanager, nullcontext
from types import SimpleNamespace

from fastapi import FastAPI
import httpx
import pytest

from wanx_studio import attached


@pytest.mark.asyncio
@pytest.mark.parametrize('fails', [False, True])
async def test_existing_wanx_factory_keeps_lifecycle_and_api_routes(tmp_path, monkeypatch, fails):
    events = []

    @asynccontextmanager
    async def original_lifespan(app):
        events.append('wanx-start')
        try:
            yield {'existing': True}
        finally:
            events.append('wanx-stop')

    app = FastAPI(lifespan=original_lifespan)

    @app.get('/{path:path}')
    async def dashboard(path: str):
        return {'dashboard': path}

    server = SimpleNamespace(paths=SimpleNamespace(root=tmp_path), services=object())

    async def close():
        events.append('studio-stop')

    service = SimpleNamespace(close=close)

    def mount(target, instance, project_root):
        assert target is app and instance is server and project_root == tmp_path

        @target.get('/api/app-studio/context')
        async def context():
            return {'studio': True}

        return service

    monkeypatch.setattr(attached, 'mount_wanx', mount)
    build = attached.attach_factory(lambda instance: app, tmp_path, tmp_path)
    assert build(server) is app
    assert not hasattr(service, 'validation_limit')
    expected = pytest.raises(RuntimeError, match='synthetic-request-failure') if fails else nullcontext()
    with expected:
        async with app.router.lifespan_context(app) as state:
            assert state == {'existing': True}
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                assert (await client.get('/api/app-studio/context')).json() == {'studio': True}
                assert (await client.get('/settings')).json() == {'dashboard': 'settings'}
            if fails:
                raise RuntimeError('synthetic-request-failure')
    assert events == ['wanx-start', 'wanx-stop', 'studio-stop']


def test_attach_rejects_other_home_and_unconfigured_server(tmp_path):
    build = attached.attach_factory(lambda _: pytest.fail('factory must not run'), tmp_path, tmp_path)
    with pytest.raises(RuntimeError, match='WANX_HOME_MISMATCH'):
        build(SimpleNamespace(paths=SimpleNamespace(root=tmp_path / 'other'), services=object()))
    with pytest.raises(RuntimeError, match='EXISTING_WANX_SETUP_REQUIRED'):
        build(SimpleNamespace(paths=SimpleNamespace(root=tmp_path), services=None))
