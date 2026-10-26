"""Bounded anonymous staging; no caller-selected file names or orphan recovery deletes."""

from __future__ import annotations

import asyncio
import hashlib
import os
import stat
import tempfile

from .config import private_directory
from .protocol import DataProtocolError, encode

CHUNK = 64 * 1024
MAX_BODY = 200 * 1024 * 1024


async def file_io(function, *args):
    """A cancelled waiter retains its slot until physical file I/O finishes."""
    pending = asyncio.create_task(asyncio.to_thread(function, *args))
    cancelled = None
    while True:
        try:
            result = await asyncio.shield(pending)
            break
        except asyncio.CancelledError as error:
            cancelled = error
            if pending.done():
                pending.result()
                break
    if cancelled is not None:
        raise cancelled
    return result


class StagedBody:
    @classmethod
    async def create(cls, directory):
        created = []

        def build():
            value = cls(directory)
            created.append(value)
            return value

        try:
            return await file_io(build)
        except asyncio.CancelledError:
            if created:
                await created[0].close()
            raise

    def __init__(self, directory):
        private_directory(directory)
        self.file = tempfile.TemporaryFile(mode="w+b", dir=directory)  # noqa: SIM115 -- spans ASGI task
        info = os.fstat(self.file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink:
            self.file.close()
            raise DataProtocolError("LOCAL_DATA_STAGING_UNAVAILABLE")
        self.length = 0
        self.sha256 = hashlib.sha256()

    def write(self, chunk):
        self.file.write(chunk)
        self.sha256.update(chunk)
        self.length += len(chunk)

    async def consume(self, receive, *, expected_bytes, expected_digest, check):
        if type(expected_bytes) is not int or not 0 <= expected_bytes <= MAX_BODY:
            raise DataProtocolError("LOCAL_DATA_BODY_TOO_LARGE")
        try:
            async with asyncio.timeout(300):
                while True:
                    check()
                    async with asyncio.timeout(15):
                        message = await receive()
                    if message["type"] == "http.disconnect":
                        raise DataProtocolError("LOCAL_DATA_SESSION_CLOSED")
                    if message["type"] != "http.request":
                        raise DataProtocolError()
                    chunk = message.get("body", b"")
                    if self.length + len(chunk) > expected_bytes:
                        raise DataProtocolError("LOCAL_DATA_BODY_MISMATCH")
                    for offset in range(0, len(chunk), CHUNK):
                        check()
                        await file_io(self.write, chunk[offset : offset + CHUNK])
                    if not message.get("more_body", False):
                        break
                if self.length != expected_bytes or encode(self.sha256.digest()) != expected_digest:
                    raise DataProtocolError("LOCAL_DATA_BODY_MISMATCH")
                await file_io(self.file.seek, 0)
        except TimeoutError:
            raise DataProtocolError("LOCAL_DATA_SESSION_EXPIRED") from None
        except OSError:
            raise DataProtocolError("LOCAL_DATA_STAGING_UNAVAILABLE") from None

    async def chunks(self):
        await file_io(self.file.seek, 0)
        while chunk := await file_io(self.file.read, CHUNK):
            yield chunk

    async def read(self, limit):
        if self.length > limit:
            raise DataProtocolError("LOCAL_DATA_BODY_TOO_LARGE")

        def read():
            position = self.file.tell()
            self.file.seek(0)
            try:
                return self.file.read(limit + 1)
            finally:
                self.file.seek(position)

        return await file_io(read)

    async def close(self):
        await file_io(self.file.close)
