"""Recover a stuck page attachment without restarting Chrome or losing its tabs."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

import aiohttp

if TYPE_CHECKING:
    from octop_browser.profile import Profile

logger = logging.getLogger(__name__)
_attachment_locks: dict[str, asyncio.Lock] = {}
_ATTACH_TIMEOUTS = {
    f"Timeout waiting for response to {domain}.enable" for domain in ("Page", "DOM", "Runtime")
}


def attachment_lock(profile: str) -> asyncio.Lock:
    """Keep concurrent reconnects from creating competing recovery tabs."""
    return _attachment_locks.setdefault(profile, asyncio.Lock())


async def _new_blank_target(profile: Profile, host: str) -> str:
    timeout = aiohttp.ClientTimeout(total=5)
    async with (
        aiohttp.ClientSession(timeout=timeout) as http,
        http.put(f"http://{host}:{profile.cdp_port}/json/new?about:blank") as response,
    ):
        response.raise_for_status()
        target = await response.json(content_type=None)
    target_id = target.get("id") if isinstance(target, dict) else None
    if (
        not isinstance(target_id, str)
        or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", target_id)
        or target.get("type") != "page"
    ):
        raise RuntimeError("Chrome did not create a recovery page")
    return target_id


async def _close_target(profile: Profile, host: str, target_id: str) -> None:
    async with (
        aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as http,
        http.get(f"http://{host}:{profile.cdp_port}/json/close/{target_id}"),
    ):
        pass


async def create_with_page_recovery[T](
    create: Callable[[], Awaitable[T]],
    profile: Profile,
    *,
    host: str,
    direct_cdp: bool = False,
) -> T:
    """Retry one page-domain attach timeout on a new blank tab in the same profile.

    A responsive browser endpoint doesn't establish that its sticky page is
    responsive. Keep that page and all profile data; only change the attachment.
    Callers serialize the whole resolution with ``attachment_lock``.
    """
    from octop_browser.cdp.client import CDPSessionError

    try:
        return await create()
    except CDPSessionError as exc:
        if direct_cdp or str(exc) not in _ATTACH_TIMEOUTS:
            raise
        logger.warning(
            "Browser page attachment timed out; opening one recovery tab for %s", profile.name
        )

    previous = profile.load_target()
    target_id = await _new_blank_target(profile, host)
    profile.save_target(target_id)
    try:
        return await create()
    except BaseException:
        # Never erase a newer attachment selected by another process.
        if profile.load_target() == target_id:
            if previous:
                profile.save_target(previous)
            else:
                profile.clear_target()
        with contextlib.suppress(Exception):
            await _close_target(profile, host, target_id)
        raise
