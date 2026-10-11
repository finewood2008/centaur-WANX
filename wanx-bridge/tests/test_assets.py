"""Static acceleration stays outside Octop and never caches business responses."""

import gzip
import hashlib
import time

import httpx
import pytest
from test_gateway import Auth

from wanx_bridge.server import create_app


@pytest.fixture
async def assets(tmp_path):
    root = tmp_path / "dashboard"
    (root / "assets").mkdir(parents=True)
    data = b"export const value = 42;\n" * 500
    (root / "assets" / "app-hash.js").write_bytes(data)
    (root / "assets" / "app.css").write_bytes(b"body { color: red; }")
    (root / "assets" / "private.json").write_text('{"secret":true}')
    auth = Auth()
    seen = []

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"fallback"

    def upstream(request):
        seen.append(request.url.path)
        return httpx.Response(200, stream=Body())

    app = create_app(
        auth, object(), dashboard_dir=root, http_transport=httpx.MockTransport(upstream)
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://box"
        ) as client:
            yield client, root, data, auth, seen


async def test_manifest_requires_current_session_and_limits_catalog(assets):
    client, root, data, auth, seen = assets
    path = "/api/platform/assets/manifest"
    assert (await client.get(path)).status_code == 401
    response = await client.get(path, headers={"authorization": "Bearer opaque-marker"})
    assert response.status_code == 200
    manifest = response.json()
    assert manifest["assets"]["/assets/app-hash.js"]["sha256"] == hashlib.sha256(data).hexdigest()
    assert "/assets/private.json" not in manifest["assets"]
    assert response.headers["cache-control"] == "no-store"
    auth.deadline = time.monotonic() - 1
    assert (
        await client.get(path, headers={"authorization": "Bearer opaque-marker"})
    ).status_code == 401


async def test_gzip_head_conditional_and_q_zero(assets):
    client, root, data, auth, seen = assets
    path = "/assets/app-hash.js"
    response = await client.get(path, headers={"accept-encoding": "gzip"})
    assert response.content == data
    assert response.headers["content-encoding"] == "gzip"
    assert int(response.headers["content-length"]) == len(
        gzip.compress(data, compresslevel=5, mtime=0)
    )
    assert response.headers["vary"] == "Accept-Encoding"
    head = await client.head(path, headers={"accept-encoding": "gzip"})
    assert head.content == b""
    assert head.headers["content-length"] == response.headers["content-length"]
    unchanged = await client.get(
        path, headers={"accept-encoding": "gzip", "if-none-match": response.headers["etag"]}
    )
    assert unchanged.status_code == 304
    assert unchanged.content == b""
    plain = await client.get(path, headers={"accept-encoding": "gzip;q=0, *;q=1"})
    assert "content-encoding" not in plain.headers
    assert plain.content == data
    assert plain.headers["etag"] != response.headers["etag"]
    # The identity representation cannot reuse the gzip validator.
    assert (
        await client.get(
            path, headers={"accept-encoding": "identity", "if-none-match": response.headers["etag"]}
        )
    ).status_code == 200
    assert seen == []


async def test_only_published_assets_and_changed_content_falls_back(assets):
    client, root, data, auth, seen = assets
    for path in ["/api/health", "/assets/private.json", "/", "/assets/app-hash.js?x=1"]:
        assert (await client.get(path)).content == b"fallback"
    await client.get("/assets/app-hash.js")
    (root / "assets" / "app-hash.js").write_bytes(b"changed")
    assert (await client.get("/assets/app-hash.js")).content == b"fallback"
    assert (await client.get("/assets/app-hash.js")).content == b"changed"


async def test_symlink_does_not_escape_catalog(assets, tmp_path):
    client, root, *_ = assets
    secret = tmp_path / "secret.js"
    secret.write_text("secret")
    try:
        (root / "assets" / "escape.js").symlink_to(secret)
    except OSError:
        pytest.skip("symlinks unavailable")
    manifest = (
        await client.get(
            "/api/platform/assets/manifest", headers={"authorization": "Bearer opaque-marker"}
        )
    ).json()
    assert "/assets/escape.js" not in manifest["assets"]
