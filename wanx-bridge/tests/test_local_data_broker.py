"""Real Unix sockets with a synthetic session service; kernel seam tested separately."""

import asyncio
import contextlib
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from wanx_bridge import local_data_broker as module
from wanx_bridge.local_data_protocol import DataProtocolError


@pytest.fixture
async def broker(monkeypatch):
    calls = []

    async def operation(body, *, audience):
        calls.append((body, audience))
        return "synthetic.signed.result"

    service = SimpleNamespace(
        **{
            name: operation
            for name in (
                "native_admit",
                "native_activate",
                "native_check",
                "native_closed",
                "child_hop",
                "native_authorize_resources",
                "native_observe",
            )
        }
    )
    with tempfile.TemporaryDirectory(
        prefix="wanx-broker-", dir=Path("/tmp").resolve()
    ) as directory:
        root = Path(directory)
        root.chmod(0o700)
        monkeypatch.setattr(module, "peer_uid", lambda connection: os.geteuid())
        value = module.LocalDataBroker(
            service,
            socket_path=root / "broker.sock",
            audience_uids={"octop": {os.geteuid()}},
            maximum_connections=1,
        )
        await value.start()
        try:
            yield value, calls
        finally:
            await value.close()
        assert not value.socket_path.exists()


def request(body=b"{}", *, target="/v1/check", headers=(), audience="octop"):
    return (
        f"POST {target} HTTP/1.1\r\nHost: local-data\r\nContent-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\nX-Centuarai-Native-Audience: {audience}\r\n".encode()
        + b"".join(name + b": " + value + b"\r\n" for name, value in headers)
        + b"\r\n"
        + body
    )


async def exchange(broker, data):
    reader, writer = await asyncio.open_unix_connection(broker.socket_path)
    writer.write(data)
    await writer.drain()
    result = await asyncio.wait_for(reader.read(), 2)
    writer.close()
    with contextlib.suppress(BrokenPipeError, ConnectionResetError):
        await writer.wait_closed()
    return result


@pytest.mark.asyncio
async def test_broker_is_one_request_no_pipeline_and_no_caller_identity_override(broker):
    value, calls = broker
    response = await exchange(value, request() + request())
    assert response.startswith(b"HTTP/1.1 200") and response.count(b"HTTP/1.1") == 1
    assert calls == [({}, "octop")]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw",
    [
        request(b'{"operationId":1,"operationId":2}'),
        request(b'{"x":NaN}'),
        request(b'{"x":1e999}'),
        request(headers=[(b"Content-Length", b"2")]),
        request(headers=[(b"Authorization", b"Bearer copied")]),
        request(headers=[(b"Transfer-Encoding", b"chunked")]),
        request(target="/v1/check?token=secret"),
        request(audience="clipboard"),
        request(b" " * 32769),
    ],
    ids=[
        "duplicate-json",
        "nan",
        "infinity",
        "duplicate-length",
        "bearer",
        "chunked",
        "query",
        "wrong-audience",
        "oversize",
    ],
)
async def test_broker_rejects_ambiguous_or_unbounded_wire_before_service(broker, raw):
    value, calls = broker
    response = await exchange(value, raw)
    assert response.startswith(b"HTTP/1.1 403") and calls == []


@pytest.mark.asyncio
async def test_broker_wrong_kernel_uid_denied_before_service(broker, monkeypatch):
    value, calls = broker
    monkeypatch.setattr(module, "peer_uid", lambda connection: os.geteuid() + 1)
    assert (await exchange(value, request())).startswith(b"HTTP/1.1 403")
    assert calls == []


@pytest.mark.asyncio
async def test_connection_capacity_has_no_unbounded_wait_queue(broker):
    value, calls = broker
    first_reader, first_writer = await asyncio.open_unix_connection(value.socket_path)
    for _ in range(20):
        if len(value.tasks) == 1:
            break
        await asyncio.sleep(0.01)
    assert len(value.tasks) == 1
    reader, writer = await asyncio.open_unix_connection(value.socket_path)
    assert await asyncio.wait_for(reader.read(), 0.2) == b""
    writer.close()
    await writer.wait_closed()
    first_writer.close()
    await first_writer.wait_closed()
    await first_reader.read()
    assert calls == []


def test_unsupported_peer_credential_platform_is_closed(monkeypatch):
    monkeypatch.setattr(module.sys, "platform", "darwin")
    with pytest.raises(DataProtocolError, match="FORBIDDEN"):
        module.peer_uid(object())


@pytest.mark.asyncio
async def test_broker_never_unlinks_preexisting_path(tmp_path):
    tmp_path.chmod(0o700)
    filename = tmp_path / "gate.sock"
    filename.write_text("do not replace")
    value = module.LocalDataBroker(object(), socket_path=filename, audience_uids={"octop": 1})
    with pytest.raises(DataProtocolError):
        await value.start()
    await value.close()
    assert filename.read_text() == "do not replace"
