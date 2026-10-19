"""Private browser expert preparation using only the authenticated native API.

The native create endpoint has no idempotency key. A durable intent prevents a
second POST after a timeout/crash: absence from one GET is not proof the original
POST stopped. An uncertain request is reconciled by reads, never replayed.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import stat
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx

from .config import BridgeAuthError

APPLICATION = "centaurai.wanx.ai-browser"
_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")


def _fail(code: str, status: int = 409) -> BridgeAuthError:
    return BridgeAuthError(code, status)


def browser_configuration(body: Any) -> dict[str, Any]:
    """Accept the browser's reviewed create shape, never identity/credentials."""
    invalid = "BROWSER_EXPERT_CONFIGURATION_INVALID"
    if not isinstance(body, dict) or set(body) != {"configuration"}:
        raise _fail(invalid, 400)
    value = body["configuration"]
    fields = {
        "name",
        "description",
        "default_model",
        "is_shared",
        "icon_name",
        "color",
        "welcome_message",
        "mcp_servers",
        "knowledge_base_ids",
        "skill_package_ids",
        "config",
        "system_prompt",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise _fail(invalid, 400)
    for field, limit in (
        ("name", 128),
        ("description", 2048),
        ("icon_name", 64),
        ("welcome_message", 2048),
        ("system_prompt", 32768),
    ):
        if (
            not isinstance(value[field], str)
            or not value[field].strip()
            or len(value[field]) > limit
        ):
            raise _fail(invalid, 400)
    if (
        value["default_model"] is not None
        or value["is_shared"] is not False
        or not isinstance(value["color"], str)
        or re.fullmatch(r"#[0-9A-Fa-f]{6}", value["color"]) is None
        or any(
            value[key] != [] for key in ("mcp_servers", "knowledge_base_ids", "skill_package_ids")
        )
    ):
        raise _fail(invalid, 400)
    config = value["config"]
    if (
        not isinstance(config, dict)
        or set(config)
        != {
            "wanx_browser_expert",
            "tools_disabled",
            "skills_disabled",
            "enable_trajectory",
            "backend",
        }
        or config["wanx_browser_expert"] != {"application_id": APPLICATION, "version": 1}
        or type(config["wanx_browser_expert"].get("version")) is not int
        or config["backend"] != {"type": "filesystem", "virtual_mode": True}
        or config["backend"].get("virtual_mode") is not True
        or config["enable_trajectory"] is not False
    ):
        raise _fail(invalid, 400)
    for key in ("tools_disabled", "skills_disabled"):
        entries = config[key]
        if (
            not isinstance(entries, list)
            or len(entries) > 256
            or any(not isinstance(item, str) or not _ID.fullmatch(item) for item in entries)
            or len(set(entries)) != len(entries)
        ):
            raise _fail(invalid, 400)
    if not {
        "execute",
        "read_env_file",
        "write_env_file",
        "write_file",
        "edit_file",
        "cronjob_create",
    }.issubset(config["tools_disabled"]):
        raise _fail(invalid, 400)
    return value


def _owned(row: Any, user_id: int) -> bool:
    return (
        isinstance(row, dict)
        and row.get("user_id") == user_id
        and row.get("is_owner") is True
        and row.get("is_shared") is False
        and row.get("application_id") == "wanx"
        and row.get("kind", "expert") == "expert"
        and isinstance(row.get("agent_id"), str)
        and _ID.fullmatch(row["agent_id"]) is not None
    )


def _marked(row: Any) -> bool:
    config = row.get("config") if isinstance(row, dict) else None
    marker = config.get("wanx_browser_expert") if isinstance(config, dict) else None
    return isinstance(marker, dict) and marker.get("application_id") == APPLICATION


class BrowserExpertPreparer:
    def __init__(self, state_dir: Path | None, *, lock_timeout: float = 10) -> None:
        self.root = Path(state_dir) / "browser-experts" if state_dir is not None else None
        self.lock_timeout = lock_timeout

    @asynccontextmanager
    async def _locked(self, user_id: int, live: Any):
        # WANX boxes are Linux; a missing cross-process locking capability must
        # never silently downgrade this endpoint to an in-memory-only lock.
        try:
            import fcntl
        except ImportError as exc:
            raise _fail("BROWSER_EXPERT_STATE_UNAVAILABLE", 503) from exc
        if self.root is None:
            raise _fail("BROWSER_EXPERT_STATE_UNAVAILABLE", 503)
        fd = None
        try:
            if self.root.parent.is_symlink() or not self.root.parent.is_dir():
                raise OSError("private state root unavailable")
            self.root.mkdir(mode=0o700, exist_ok=True)
            if self.root.is_symlink() or not self.root.is_dir():
                raise OSError("invalid lock directory")
            if self.root.stat().st_uid != os.getuid():
                raise OSError("invalid lock directory owner")
            os.chmod(self.root, 0o700)
            key = hashlib.sha256(f"wanx:{user_id}:{APPLICATION}".encode()).hexdigest()
            fd = os.open(
                self.root / (key + ".lock"),
                os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK,
                0o600,
            )
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
                raise OSError("invalid lock file")
            os.fchmod(fd, 0o600)
            deadline = asyncio.get_running_loop().time() + self.lock_timeout
            while True:
                await live()
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if asyncio.get_running_loop().time() >= deadline:
                        raise _fail("BROWSER_EXPERT_BUSY") from None
                    await asyncio.sleep(0.05)
            yield self.root / (key + ".pending")
        except OSError as exc:
            raise _fail("BROWSER_EXPERT_STATE_UNAVAILABLE", 503) from exc
        finally:
            if fd is not None:
                os.close(fd)

    @staticmethod
    def _intent(path: Path) -> None:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(
                {"schemaVersion": 1, "applicationId": APPLICATION, "createdAt": int(time.time())},
                stream,
            )
            stream.flush()
            os.fsync(stream.fileno())
        parent = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)

    async def ensure(
        self, body: Any, user: dict[str, Any], request: Any, live: Any
    ) -> dict[str, Any]:
        configuration = browser_configuration(body)
        uid = user.get("id")
        if type(uid) is not int or uid < 1 or user.get("application_id", "wanx") != "wanx":
            raise _fail("BROWSER_EXPERT_FORBIDDEN", 403)

        async def find() -> dict[str, Any] | None:
            response = await request("GET", "/api/agents?scope=mine")
            if response.status_code != 200:
                raise _fail("BROWSER_EXPERT_UNAVAILABLE", 503)
            try:
                rows = response.json()
            except ValueError:
                raise _fail("BROWSER_EXPERT_UNAVAILABLE", 503) from None
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise _fail("BROWSER_EXPERT_UNAVAILABLE", 503)
            marked = [row for row in rows if _marked(row) and row.get("user_id") == uid]
            matches = [row for row in marked if _owned(row, uid)]
            if len(matches) > 1:
                raise _fail("BROWSER_EXPERT_AMBIGUOUS")
            if len(marked) != len(matches):
                raise _fail("BROWSER_EXPERT_OWNERSHIP_CONFLICT")
            if matches:
                return matches[0]
            if any(
                row.get("user_id") == uid and row.get("name") == configuration["name"]
                for row in rows
            ):
                raise _fail("BROWSER_EXPERT_NAME_CONFLICT")
            return None

        async with self._locked(uid, live) as pending:
            # Validate the live native subject as well; only the supplied
            # authenticated user's token is used for every request.
            me = await request("GET", "/api/auth/me")
            try:
                native = me.json()
            except ValueError:
                native = None
            if (
                me.status_code != 200
                or not isinstance(native, dict)
                or native.get("id") != uid
                or native.get("application_id", "wanx") != "wanx"
            ):
                raise _fail("BROWSER_EXPERT_FORBIDDEN", 403)
            existing = await find()
            if existing is not None:
                pending.unlink(missing_ok=True)
                return existing
            if pending.exists() or pending.is_symlink():
                raise _fail("BROWSER_EXPERT_PREPARATION_PENDING")
            await live()
            self._intent(pending)
            response = None
            try:
                response = await request("POST", "/api/agents", json=configuration)
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
                # These transport phases precede sending the request. Clearing
                # only this intent permits a later retry after connectivity
                # recovers; a read/write failure does not provide that proof.
                pending.unlink(missing_ok=True)
                raise _fail("BROWSER_EXPERT_UNAVAILABLE", 503) from None
            except httpx.HTTPError:
                pass  # The native POST may still be committing; never replay.
            await live()
            existing = await find()
            if existing is not None:
                pending.unlink(missing_ok=True)
                return existing
            # Only authentication and request validation failures prove the
            # native create handler did not run. Other errors may be emitted
            # after a partial commit and must retain the durable intent.
            if response is not None and response.status_code in {401, 403, 422}:
                pending.unlink(missing_ok=True)
                raise _fail(
                    "BROWSER_EXPERT_CREATE_FAILED",
                    403 if response.status_code in {401, 403} else 409,
                )
            raise _fail("BROWSER_EXPERT_PREPARATION_PENDING")
