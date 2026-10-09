"""Own the standard SDK worker; platform credentials stay in host memory."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import Any
from uuid import uuid4


class BoxManagementError(Exception):
    """Safe business error suitable for a localized UI message."""


class BoxManagementService:
    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._node = shutil.which(os.environ.get("WANX_BOX_SDK_NODE", "node"))
        self._worker = Path(__file__).with_name("sdk-host.mjs")

    async def _start(self) -> asyncio.subprocess.Process:
        if not self._node or not self._worker.is_file():
            raise BoxManagementError("SDK_HOST_UNAVAILABLE")
        if self._process is None or self._process.returncode is not None:
            self._process = await asyncio.create_subprocess_exec(
                self._node,
                str(self._worker),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                limit=2 * 1024 * 1024,
            )
        return self._process

    async def action(self, actor: int, action: str, payload: dict[str, Any]) -> Any:
        async with self._lock:
            process = await self._start()
            assert process.stdin is not None and process.stdout is not None
            request_id = uuid4().hex
            message = (
                json.dumps(
                    {"id": request_id, "actor": actor, "action": action, "input": payload},
                    ensure_ascii=False,
                ).encode()
                + b"\n"
            )
            if len(message) > 65536:
                raise BoxManagementError("INVALID_INPUT")
            try:
                async with asyncio.timeout(60):
                    process.stdin.write(message)
                    await process.stdin.drain()
                    line = await process.stdout.readline()
                reply = json.loads(line)
                if reply.get("id") != request_id:
                    raise ValueError("worker response mismatch")
            except (TimeoutError, OSError, ValueError, asyncio.CancelledError) as error:
                await self.close()
                if isinstance(error, asyncio.CancelledError):
                    raise
                raise BoxManagementError("SDK_HOST_UNAVAILABLE") from error
            if not reply.get("ok"):
                raise BoxManagementError(str(reply.get("code", "PLATFORM_REQUEST_FAILED")))
            return reply.get("result")

    async def close(self) -> None:
        process, self._process = self._process, None
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 3)
            except TimeoutError:
                process.kill()
                await process.wait()
