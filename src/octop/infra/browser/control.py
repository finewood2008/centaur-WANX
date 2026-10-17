"""Per-profile arbitration for manual input and browser tools.

Legacy sessions retain agent control until an explicit handoff. Managed sessions
serialize input, bind AI to one conversation, and drain in-flight calls before
reporting that manual control is ready.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field


@dataclass
class BrowserControl:
    owner: str = "agent"
    managed: bool = False
    thread_id: str = ""
    agent_id: str = ""
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


_controls: dict[str, BrowserControl] = {}


def control_for(profile: str) -> BrowserControl:
    return _controls.setdefault(profile, BrowserControl())


def owner_for(profile: str) -> str:
    return control_for(profile).owner


def block_agent(profile: str) -> BrowserControl:
    control = control_for(profile)
    control.managed = True
    control.owner = "user"
    return control


async def drain(control: BrowserControl) -> bool:
    try:
        async with asyncio.timeout(8):
            async with control.lock:
                return True
    except TimeoutError:
        return False


async def finish_even_if_cancelled[T](task: asyncio.Future[T]) -> T:
    """Retain the input lock through repeated cancellation until CDP settles."""
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    if cancelled:
        # Retrieve the result/exception before propagating parent cancellation.
        if not task.cancelled():
            task.exception()
        raise asyncio.CancelledError
    return task.result()
