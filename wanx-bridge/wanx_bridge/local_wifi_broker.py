"""Root-only local Wi-Fi authority IPC, isolated from native application sockets."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import stat
import threading
import time
from pathlib import Path
from time import monotonic

from .local_data_broker import decode_object, peer_uid
from .local_data_protocol import DataProtocolError
from .local_trust_protocol import BindingProtocolError
from .local_wifi_protocol import LocalWifiError, need

NETWORK_SOCKET = "/run/centuarai-local-trust-network/network.sock"


class LocalWifiBroker:
    def __init__(
        self,
        authority,
        *,
        execute_authority,
        socket_path=NETWORK_SOCKET,
        maximum_connections=8,
        _owner_uid=0,
        _owner_gid=0,
    ):
        self.authority = authority
        self.execute_authority = execute_authority
        self.socket_path = Path(socket_path)
        need(
            self.socket_path.is_absolute()
            and type(maximum_connections) is int
            and 1 <= maximum_connections <= 8
        )
        self.maximum_connections = maximum_connections
        # Private test seams are never runtime configuration. Production peers
        # are always authenticated by Linux SO_PEERCRED, with uid exactly zero.
        self.owner_uid, self.owner_gid = _owner_uid, _owner_gid
        self.server = None
        self.socket_inode = None
        self.tasks, self.writers = set(), set()

    async def start(self):
        need(self.server is None)
        parent = self.socket_path.parent.lstat()
        need(
            stat.S_ISDIR(parent.st_mode)
            and parent.st_uid == self.owner_uid
            and parent.st_gid == self.owner_gid
            and stat.S_IMODE(parent.st_mode) == 0o700,
            "LOCAL_WIFI_FORBIDDEN",
        )
        need(not os.path.lexists(self.socket_path), "LOCAL_WIFI_CAPACITY")
        try:
            self.server = await asyncio.start_unix_server(
                self._connection, path=self.socket_path, limit=4096
            )
            info = self.socket_path.lstat()
            self.socket_inode = (info.st_dev, info.st_ino)
            os.chmod(self.socket_path, 0o600)
            os.chown(self.socket_path, self.owner_uid, self.owner_gid)
            return self
        except BaseException:
            await self.close()
            raise

    async def _reply(self, writer, status, value):
        body = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("ascii")
        need(len(body) <= 32768)
        header = (
            f"HTTP/1.1 {status} {'OK' if status == 200 else 'Forbidden'}\r\n"
            f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n"
            "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
        ).encode("ascii")
        writer.write(header + body)
        async with asyncio.timeout(0.5):
            await writer.drain()

    async def _connection(self, reader, writer):
        task = asyncio.current_task()
        if len(self.tasks) >= self.maximum_connections:
            writer.close()
            return
        self.tasks.add(task)
        self.writers.add(writer)
        try:
            try:
                uid = peer_uid(writer.get_extra_info("socket"))
            except (DataProtocolError, OSError):
                raise LocalWifiError("LOCAL_WIFI_FORBIDDEN") from None
            need(uid == 0, "LOCAL_WIFI_FORBIDDEN")
            async with asyncio.timeout(0.5):
                header = await reader.readuntil(b"\r\n\r\n")
            need(len(header) <= 4096 and header.isascii())
            lines = header[:-4].decode("ascii").split("\r\n")
            request = lines.pop(0).split(" ")
            need(len(request) == 3 and request[0] == "POST" and request[2] == "HTTP/1.1")
            methods = {
                "/v1/wifi/" + name: name
                for name in ("challenge", "session", "check", "consume", "result")
            }
            need(request[1] in methods)
            headers = {}
            for line in lines:
                name, separator, value = line.partition(":")
                need(
                    separator
                    and name
                    and name == name.strip()
                    and name.lower() not in headers
                    and all(32 <= ord(c) < 127 for c in line)
                )
                headers[name.lower()] = value.strip()
            need(
                set(headers) <= {"host", "content-type", "content-length", "connection"}
                and headers.get("host") == "local-wifi"
                and headers.get("content-type") == "application/json"
                and headers.get("connection", "close").lower() == "close"
            )
            length = headers.get("content-length", "")
            need(length.isascii() and length.isdecimal() and len(length) <= 5)
            size = int(length)
            need(0 < size <= 32768, "LOCAL_WIFI_CAPACITY")
            async with asyncio.timeout(0.5):
                body = decode_object(await reader.readexactly(size))
            # Bytes already received beyond Content-Length are never interpreted
            # as another request. Close also prevents delayed pipelining.
            need(not reader._buffer)
            result = await self._invoke(methods[request[1]], body, reader)
            need(type(result) is dict)
            await self._reply(writer, 200, result)
        except Exception as error:
            if isinstance(error, LocalWifiError):
                code = error.code
            elif isinstance(
                error,
                (
                    BindingProtocolError,
                    DataProtocolError,
                    ValueError,
                    UnicodeError,
                    asyncio.IncompleteReadError,
                    asyncio.LimitOverrunError,
                ),
            ):
                code = "LOCAL_WIFI_INVALID"
            else:
                code = "LOCAL_WIFI_UNAVAILABLE"
            status = (
                429
                if code == "LOCAL_WIFI_CAPACITY"
                else 503
                if code == "LOCAL_WIFI_UNAVAILABLE"
                else 403
            )
            with contextlib.suppress(Exception):
                await self._reply(writer, status, {"code": code})
        finally:
            self.tasks.discard(task)
            self.writers.discard(writer)
            writer.close()
            with contextlib.suppress(Exception):
                async with asyncio.timeout(0.5):
                    await writer.wait_closed()

    async def _invoke(self, name, body, reader):
        cancelled = threading.Event()
        # Only the monotonic budget is fixed at admission. Wall time is sampled
        # by dispatch after acquiring the authority's serialized execution lock.
        job = asyncio.create_task(
            self.execute_authority(
                self.authority.dispatch, name, body, cancelled, monotonic() + 2, lambda: time.time()
            )
        )
        disconnected = asyncio.create_task(reader.read(1))
        try:
            async with asyncio.timeout(2):
                done, _ = await asyncio.wait(
                    {job, disconnected}, return_when=asyncio.FIRST_COMPLETED
                )
                need(job in done and disconnected not in done, "LOCAL_WIFI_UNAVAILABLE")
                return await job
        finally:
            cancelled.set()
            # The service shields its bounded physical worker, which now sees
            # the fence if it was queued or is about to commit. Cancelling this
            # waiter neither frees that worker slot nor makes a late reply usable.
            job.cancel()
            disconnected.cancel()
            await asyncio.gather(job, disconnected, return_exceptions=True)

    async def close(self):
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
        for writer in tuple(self.writers):
            writer.close()
        for task in tuple(self.tasks):
            task.cancel()
        await asyncio.gather(*tuple(self.tasks), return_exceptions=True)
        if self.socket_inode is not None:
            with contextlib.suppress(FileNotFoundError):
                info = self.socket_path.lstat()
                if stat.S_ISSOCK(info.st_mode) and (info.st_dev, info.st_ino) == self.socket_inode:
                    self.socket_path.unlink()
            self.socket_inode = None
