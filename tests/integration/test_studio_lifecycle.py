"""Both editions share one Builder service per WANX server lifecycle."""

from pathlib import Path

from octop.api.app import build_app
from tests.support.app import octop_client


async def test_rebuilding_http_app_reuses_builder_and_server_stop_releases_lease(
    tmp_octop_home: Path,
) -> None:
    async with octop_client(tmp_octop_home) as (_client, server):
        first = build_app(server).state.app_studio
        second = build_app(server).state.app_studio
        assert first is second
        assert not getattr(first, "closing", False)
    assert first.closing
    # A second close from ASGI lifespan is safe after server shutdown.
    await first.close()
    async with octop_client(tmp_octop_home) as (_client, server):
        reopened = build_app(server).state.app_studio
        assert reopened is not first
        assert not getattr(reopened, "closing", False)
