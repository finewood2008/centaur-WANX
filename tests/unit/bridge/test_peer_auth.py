"""Unit tests for peer URL normalization / SSRF guards."""

from __future__ import annotations

import pytest

from octop.infra.bridge.peer_auth import normalize_peer_base_url
from octop.infra.errors import ErrorCode, OctopError


def test_normalize_accepts_https_host() -> None:
    assert normalize_peer_base_url("https://demo.octop.chat/") == "https://demo.octop.chat"


def test_normalize_rejects_metadata_ip() -> None:
    with pytest.raises(OctopError) as ei:
        normalize_peer_base_url("http://169.254.169.254/latest/meta-data")
    assert ei.value.code == ErrorCode.BRIDGE_PEER_UNREACHABLE


def test_normalize_rejects_non_http() -> None:
    with pytest.raises(OctopError) as ei:
        normalize_peer_base_url("ftp://peer.example")
    assert ei.value.code == ErrorCode.BRIDGE_PEER_UNREACHABLE


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [302, 307])
async def test_login_does_not_forward_credentials_on_redirect(monkeypatch, status) -> None:
    import httpx

    from octop.infra.bridge.peer_auth import login_peer

    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(
            status,
            headers={"location": "http://169.254.169.254/latest/meta-data"},
            json={"access_token": "redirect-must-not-be-accepted"},
        )

    client_class = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: client_class(transport=httpx.MockTransport(respond), **kw),
    )
    with pytest.raises(OctopError, match="redirects are not allowed") as error:
        await login_peer(base_url="http://127.0.0.1:8088", username="user", password="test-only")
    assert error.value.code == ErrorCode.BRIDGE_AUTH_FAILED
    assert len(requests) == 1
    assert requests[0].url.host == "127.0.0.1"


@pytest.mark.asyncio
async def test_login_accepts_direct_success(monkeypatch) -> None:
    import httpx

    from octop.infra.bridge.peer_auth import login_peer

    client_class = httpx.AsyncClient
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json={"access_token": "ok"})
    )
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: client_class(transport=transport, **kw))
    result = await login_peer(
        base_url="http://127.0.0.1:8088", username="user", password="test-only"
    )
    assert result == {"access_token": "ok"}
