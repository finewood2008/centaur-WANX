"""Private Unix socket tests. Linux root uses actual SO_PEERCRED."""

import asyncio
import contextlib
import json
import os
import stat
import sys
from types import SimpleNamespace

import pytest

from wanx_bridge import local_wifi_broker as module
from wanx_bridge.local_wifi_protocol import LocalWifiError


def packet(path="/v1/wifi/challenge", body=b"{}", extra=b""):
    return (
        b"POST "
        + path.encode()
        + b" HTTP/1.1\r\nHost: local-wifi\r\nContent-Type: application/json\r\n"
        + b"Content-Length: "
        + str(len(body)).encode()
        + b"\r\n"
        + extra
        + b"\r\n"
        + body
    )


async def request(broker, raw):
    reader, writer = await asyncio.open_unix_connection(broker.socket_path)
    writer.write(raw)
    await writer.drain()
    head = await reader.readuntil(b"\r\n\r\n")
    length = next(
        int(line.split(b":", 1)[1].strip())
        for line in head.split(b"\r\n")
        if line.lower().startswith(b"content-length:")
    )
    body = await reader.readexactly(length)
    writer.close()
    # A rejected peer may have unread request bytes: Linux can reset the stream
    # on close after delivering the complete framed error response.
    with contextlib.suppress(ConnectionResetError, BrokenPipeError):
        await writer.wait_closed()
    return int(head.split(b" ")[1]), json.loads(body)


@pytest.fixture
def configured(tmp_path, monkeypatch):
    directory = tmp_path / "network"
    directory.mkdir(mode=0o700)
    calls = []

    def action(body, now):
        calls.append((body, now))
        return {"valid": True}

    async def execute(method, *args):
        return method(*args)

    authority = SimpleNamespace(
        **{name: action for name in ("challenge", "session", "check", "consume", "result")}
    )
    authority.dispatch = lambda name, body, cancelled, deadline, clock: action(body, int(clock()))
    # Keep a real Linux-root test path. macOS has no Linux SO_PEERCRED.
    if sys.platform != "linux" or os.geteuid() != 0:
        monkeypatch.setattr(module, "peer_uid", lambda _: 0)
    broker = module.LocalWifiBroker(
        authority,
        execute_authority=execute,
        socket_path=directory / "network.sock",
        _owner_uid=os.geteuid(),
        _owner_gid=directory.stat().st_gid,
    )
    return broker, calls


@pytest.mark.asyncio
async def test_root_rpc_permissions_and_cleanup(configured):
    broker, calls = configured
    await broker.start()
    try:
        assert stat.S_IMODE(broker.socket_path.stat().st_mode) == 0o600
        assert await request(broker, packet()) == (200, {"valid": True})
        assert len(calls) == 1
    finally:
        await broker.close()
    assert not broker.socket_path.exists()


@pytest.mark.asyncio
async def test_non_root_peer_fails_before_parsing_or_authority(configured, monkeypatch):
    broker, calls = configured
    monkeypatch.setattr(module, "peer_uid", lambda _: 1000)
    await broker.start()
    try:
        status, body = await request(broker, packet(extra=b"X-Uid: 0\r\n"))
        assert status == 403 and body == {"code": "LOCAL_WIFI_FORBIDDEN"}
        assert not calls
    finally:
        await broker.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw",
    [
        packet(extra=b"Authorization: cloud-token\r\n"),
        packet(extra=b"Content-Length: 2\r\n"),
        packet(extra=b"Transfer-Encoding: chunked\r\n"),
        packet(extra=b"X-Centuarai-Native-Audience: wanx\r\n"),
        packet(extra=b"Connection: keep-alive\r\n"),
        packet(body=b'{"key":1,"key":2}'),
        packet(body=b"[]"),
        packet(path="/v1/wifi/check?admin=1"),
        packet() + packet(),
        packet(body=b'{"cloudOwner":true}').replace(b"POST", b"GET", 1),
    ],
)
async def test_strict_single_request_http_rejects_smuggling_and_cloud_headers(configured, raw):
    broker, calls = configured
    await broker.start()
    try:
        status, body = await request(broker, raw)
        assert status == 403 and set(body) == {"code"}
        assert not calls
    finally:
        await broker.close()


@pytest.mark.asyncio
async def test_start_rejects_stale_paths_and_broad_parent_without_deleting_them(configured):
    broker, _ = configured
    broker.socket_path.write_text("existing")
    with pytest.raises(LocalWifiError, match="CAPACITY"):
        await broker.start()
    assert broker.socket_path.read_text() == "existing"
    broker.socket_path.unlink()
    broker.socket_path.parent.chmod(0o750)
    with pytest.raises(LocalWifiError, match="FORBIDDEN"):
        await broker.start()


@pytest.mark.asyncio
async def test_close_preserves_replaced_inode(configured):
    broker, _ = configured
    await broker.start()
    broker.socket_path.unlink()
    broker.socket_path.write_text("replacement")
    await broker.close()
    assert broker.socket_path.read_text() == "replacement"


@pytest.mark.asyncio
async def test_authority_error_never_leaks_exception_detail(configured):
    broker, _ = configured

    async def failure(*_):
        raise RuntimeError("secret diagnostic /private/path")

    broker.execute_authority = failure
    await broker.start()
    try:
        assert await request(broker, packet()) == (503, {"code": "LOCAL_WIFI_UNAVAILABLE"})
    finally:
        await broker.close()
