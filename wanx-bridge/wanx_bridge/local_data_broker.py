"""One-request Unix HTTP broker. Kernel peer identity selects native audiences."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import socket
import stat
import struct
import sys
from pathlib import Path

from .local_data_protocol import DataProtocolError, canonical, digest32, fields, need


def decode_object(raw):
    def pairs(items):
        result = {}
        for name, value in items:
            need(name not in result)
            result[name] = value
        return result

    try:
        value = json.loads(raw, object_pairs_hook=pairs)
        need(type(value) is dict)
        canonical(value)  # finite integers, ASCII, bounded nesting; JSON may be spaced
        return value
    except (UnicodeError, ValueError, RecursionError):
        raise DataProtocolError("LOCAL_DATA_INVALID") from None


def peer_uid(connection):
    # No loopback/header/process-name substitute on unsupported platforms.
    if sys.platform != "linux" or not hasattr(socket, "SO_PEERCRED"):
        raise DataProtocolError("LOCAL_DATA_FORBIDDEN")
    try:
        _, uid, _ = struct.unpack(
            "3i",
            connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")),
        )
        return uid
    except (OSError, ValueError, struct.error):
        raise DataProtocolError("LOCAL_DATA_FORBIDDEN") from None


class LocalDataBroker:
    def __init__(
        self, sessions, *, socket_path, audience_uids, socket_gid=None, maximum_connections=128
    ):
        self.sessions = sessions
        self.socket_path = Path(socket_path)
        need(self.socket_path.is_absolute() and maximum_connections in range(1, 129))
        need(
            type(audience_uids) is dict
            and audience_uids
            and set(audience_uids) <= {"octop", "clipboard", "semantica", "semantica-mcp"}
        )
        self.audience_uids = {}
        for audience, values in audience_uids.items():
            values = {values} if type(values) is int else set(values)
            need(values and all(type(uid) is int and uid >= 0 for uid in values))
            self.audience_uids[audience] = frozenset(values)
        need(socket_gid is None or type(socket_gid) is int and socket_gid >= 0)
        self.socket_gid = socket_gid
        self.maximum_connections = maximum_connections
        self.server = None
        self.tasks = set()
        self.writers = set()
        self.socket_inode = None

    async def start(self):
        need(self.server is None)
        parent = self.socket_path.parent.lstat()
        need(
            stat.S_ISDIR(parent.st_mode)
            and parent.st_uid == os.geteuid()
            and not parent.st_mode & 0o022,
            "LOCAL_DATA_FORBIDDEN",
        )
        # Do not unlink an arbitrary previous file/socket. The service manager
        # owns stale-socket recovery after proving the previous runtime is dead.
        need(not os.path.lexists(self.socket_path), "LOCAL_DATA_CAPACITY")
        self.server = await asyncio.start_unix_server(
            self._connection, path=self.socket_path, limit=16384
        )
        os.chmod(self.socket_path, 0o660)
        if self.socket_gid is not None:
            os.chown(self.socket_path, -1, self.socket_gid)
        info = self.socket_path.lstat()
        self.socket_inode = (info.st_dev, info.st_ino)
        return self

    async def _consume_migration(self, body, *, audience):
        fields(body, {"requestId", "planDigest"})
        digest32(body["requestId"])
        digest32(body["planDigest"])
        need(audience is None, "LOCAL_DATA_FORBIDDEN")

        def consume():
            return self.sessions.authority.consume_team_migration(
                body["requestId"], body["planDigest"], self.sessions.wall_clock_ms() // 1000
            )

        # The sole authority validates the completed root-owned journal and
        # signs an idempotent ledger receipt; this broker cannot mint one.
        return await self.sessions.execute_authority(consume)

    async def _reply(self, writer, status, body, content_type):
        need(len(body) <= 65536)
        header = (
            f"HTTP/1.1 {status} {'OK' if status == 200 else 'Forbidden'}\r\n"
            f"Content-Type: {content_type}\r\nContent-Length: {len(body)}\r\n"
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
            uid = peer_uid(writer.get_extra_info("socket"))
            async with asyncio.timeout(0.5):
                header = await reader.readuntil(b"\r\n\r\n")
            need(len(header) <= 16384 and header.isascii())
            lines = header[:-4].decode("ascii").split("\r\n")
            request = lines.pop(0).split(" ")
            need(len(request) == 3 and request[0] == "POST" and request[2] == "HTTP/1.1")
            operation = {
                "/v1/admit": self.sessions.native_admit,
                "/v1/activate": self.sessions.native_activate,
                "/v1/check": self.sessions.native_check,
                "/v1/closed": self.sessions.native_closed,
                "/v1/child": self.sessions.child_hop,
                "/v1/authorize-resources": self.sessions.native_authorize_resources,
                "/v1/team-members": self.sessions.native_team_members,
                "/v1/resource-grants": self.sessions.native_resource_grants,
                "/v1/task-start": self.sessions.native_task_start,
                "/v1/task-check": self.sessions.native_task_check,
                "/v1/task-close": self.sessions.native_task_close,
                "/v1/team-migration/consume": self._consume_migration,
                "/v1/observe": self.sessions.native_observe,
            }.get(request[1])
            need(operation is not None, "LOCAL_DATA_ROUTE_DENIED")
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
                set(headers)
                <= {
                    "host",
                    "content-length",
                    "content-type",
                    "accept",
                    "accept-encoding",
                    "user-agent",
                    "connection",
                    "x-centuarai-native-audience",
                }
            )
            audience = headers.get("x-centuarai-native-audience")
            if request[1] == "/v1/team-migration/consume":
                need(uid == 0 and audience is None, "LOCAL_DATA_FORBIDDEN")
            else:
                need(
                    audience in self.audience_uids and uid in self.audience_uids[audience],
                    "LOCAL_DATA_FORBIDDEN",
                )
            need(
                headers.get("host") == "local-data"
                and headers.get("content-type") == "application/json"
            )
            length = headers.get("content-length", "")
            need(length.isascii() and length.isdecimal() and len(length) <= 5)
            size = int(length)
            need(0 < size <= 32768, "LOCAL_DATA_CAPACITY")
            async with asyncio.timeout(0.5):
                body = decode_object(await reader.readexactly(size))
            async with asyncio.timeout(1.0):
                result = await operation(body, audience=audience)
            need(type(result) is str and result.isascii() and len(result) <= 65536)
            await self._reply(writer, 200, result.encode("ascii"), "application/jose")
        except (
            DataProtocolError,
            ValueError,
            UnicodeError,
            OSError,
            TimeoutError,
            asyncio.IncompleteReadError,
            asyncio.LimitOverrunError,
        ) as error:
            code = error.code if isinstance(error, DataProtocolError) else "LOCAL_DATA_INVALID"
            with contextlib.suppress(Exception):
                await self._reply(
                    writer, 403, json.dumps({"code": code}).encode("ascii"), "application/json"
                )
        finally:
            self.tasks.discard(task)
            self.writers.discard(writer)
            writer.close()
            with contextlib.suppress(Exception):
                async with asyncio.timeout(0.5):
                    await writer.wait_closed()

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


Broker = LocalDataBroker
