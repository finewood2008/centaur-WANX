"""User-scoped skill demonstrations using the existing octop-browser recorder.

Attach only to the already-open page. The app's stream owns the recording;
disconnect or an expired lease ends capture and retains a reviewable draft.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import aiohttp

from octop.infra.browser.learning_recorder import make_recorder
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.paths import PathLayout

LEASE_SECONDS = 45


@dataclass
class Learning:
    recorder: Any
    client_id: str
    expires_at: float
    watchdog: asyncio.Task[None] | None = None


_active: dict[str, Learning] = {}
_locks: dict[str, asyncio.Lock] = {}


def _lock(profile: str) -> asyncio.Lock:
    return _locks.setdefault(profile, asyncio.Lock())


def _store() -> Any:
    from octop_browser.record.settings import RecordReplaySettings
    from octop_browser.record.store import RecordingStore

    return RecordingStore(
        RecordReplaySettings(base_dir=PathLayout.from_env().root / "browser-learning")
    )


def _owned(profile: str, recording_id: str) -> tuple[Any, Any]:
    if not re.fullmatch(r"learn_[a-f0-9]{32}", recording_id):
        raise OctopError(ErrorCode.NOT_FOUND, "learning not found")
    store = _store()
    try:
        manifest = store.read_manifest(recording_id)
    except (FileNotFoundError, ValueError) as exc:
        raise OctopError(ErrorCode.NOT_FOUND, "learning not found") from exc
    if manifest.profile != profile:
        raise OctopError(ErrorCode.NOT_FOUND, "learning not found")
    return store, manifest


def status(profile: str) -> dict[str, Any]:
    learning = _active.get(profile)
    if learning is None:
        return {"active": None}
    manifest = learning.recorder.manifest
    return {
        "active": {
            "recordingId": manifest.recording_id,
            "name": manifest.target.title,
            "events": manifest.stats.events,
            "startedAt": manifest.created_at,
        }
    }


def restrict_action(profile: str, action: str) -> bool:
    return profile in _active and action in {"new_tab", "switch_tab", "close_tab", "close_session"}


async def _attach(profile: str, name: str, session: Any) -> Any:
    from octop_browser.cdp.client import CDPClient
    from octop_browser.record.models import PrivacySettings, RecordingManifest, RecordingTarget
    from octop_browser.record.privacy import redact_url

    internal = session._internal  # noqa: SLF001
    target_id = internal._profile.load_target()  # noqa: SLF001
    cfg = internal._cfg  # noqa: SLF001
    port = internal._profile.cdp_port  # noqa: SLF001
    async with (
        aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=3)) as http,
        http.get(f"http://{cfg.cdp_host}:{port}/json") as response,
    ):
        response.raise_for_status()
        pages = await response.json(content_type=None)
    page = next((p for p in pages if p.get("id") == target_id and p.get("type") == "page"), None)
    if page is None:
        raise OctopError(ErrorCode.NOT_FOUND, "current browser page not found")
    privacy = PrivacySettings(input_policy="mask-sensitive", screenshot_policy="off")
    manifest = RecordingManifest(
        recordingId="learn_" + uuid4().hex,
        createdAt=datetime.now(UTC).isoformat(),
        profile=profile,
        privacy=privacy,
        target=RecordingTarget(
            target_id=target_id,
            start_url=redact_url(str(page.get("url") or ""), privacy),
            title=name,
        ),
    )
    store = _store()
    await asyncio.to_thread(store.create, manifest)
    client = CDPClient(timeout=5)
    recorder = make_recorder(client, store, manifest, target_id)
    try:
        async with asyncio.timeout(8):
            await client.connect(page["webSocketDebuggerUrl"])
            # No cdp_host/port: observe this page only, without touching other tabs.
            await recorder.start()
        return recorder
    except BaseException:
        with contextlib.suppress(Exception):
            await recorder.stop(generate_steps=True)
        await recorder.close()
        raise


async def start(profile: str, client_id: str, name: str, session: Any) -> dict[str, Any]:
    async with _lock(profile):
        current = _active.get(profile)
        if current:
            if current.client_id != client_id:
                raise OctopError(ErrorCode.SLASH_BAD_ARGS, "learning already active", status=409)
            current.expires_at = time.monotonic() + LEASE_SECONDS
            return status(profile)
        recorder = await _attach(profile, name, session)
        learning = Learning(recorder, client_id, time.monotonic() + LEASE_SECONDS)
        _active[profile] = learning
        learning.watchdog = asyncio.create_task(_expire(profile, learning))
        return status(profile)


async def _expire(profile: str, learning: Learning) -> None:
    try:
        while _active.get(profile) is learning:
            await asyncio.sleep(max(0.01, learning.expires_at - time.monotonic()))
            if time.monotonic() >= learning.expires_at:
                await stop_if_client(profile, learning.client_id)
                return
    except asyncio.CancelledError:
        pass


def renew(profile: str, client_id: str, recording_id: str) -> dict[str, Any]:
    learning = _active.get(profile)
    if (
        learning
        and learning.client_id == client_id
        and learning.recorder.manifest.recording_id == recording_id
    ):
        learning.expires_at = time.monotonic() + LEASE_SECONDS
    return status(profile)


async def _stop(profile: str) -> None:
    learning = _active.pop(profile, None)
    if learning is None:
        return
    if learning.watchdog and learning.watchdog is not asyncio.current_task():
        learning.watchdog.cancel()
    try:
        await learning.recorder.stop(generate_steps=True)
    finally:
        await learning.recorder.close()


async def stop_if_client(profile: str, client_id: str) -> None:
    async with _lock(profile):
        learning = _active.get(profile)
        if learning and learning.client_id == client_id:
            await _stop(profile)


async def stop(profile: str, recording_id: str) -> dict[str, Any]:
    async with _lock(profile):
        await asyncio.to_thread(_owned, profile, recording_id)
        learning = _active.get(profile)
        if learning and learning.recorder.manifest.recording_id == recording_id:
            await _stop(profile)
        return await asyncio.to_thread(draft, profile, recording_id)


def _final_field_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep final field values within an edit, without merging across actions."""
    result: list[dict[str, Any]] = []
    pending: dict[tuple[str, str, str], dict[str, Any]] = {}
    for event in events:
        kind = event.get("kind")
        target = event.get("target") or {}
        if kind in {"input", "change"}:
            # Hidden editor mirrors are implementation details, not user inputs.
            if target.get("type") == "hidden" or target.get("visible") is False:
                continue
            identity = target.get("id") or target.get("xpath")
            if identity:
                page = event.get("page") or {}
                key = (
                    str(event.get("targetId") or page.get("targetId") or ""),
                    str(page.get("url") or ""),
                    str(identity),
                )
                pending[key] = event
                continue
        if kind == "scroll" and pending:
            # Scrolling while editing does not commit a field value.
            result.append(event)
            continue
        # Preserve action order: submitting or navigating must see the values
        # demonstrated at that point, not values from a later form visit.
        result.extend(pending.values())
        pending.clear()
        result.append(event)
    result.extend(pending.values())
    return result


def draft(profile: str, recording_id: str) -> dict[str, Any]:
    from octop_browser.record.semantic import SemanticProcessor

    store, manifest = _owned(profile, recording_id)
    current = _active.get(profile)
    if current and current.recorder.manifest.recording_id == recording_id:
        raise OctopError(ErrorCode.SLASH_BAD_ARGS, "finish learning before reviewing", status=409)
    # A backend restart ends capture. Recover the retained events into a draft.
    steps = SemanticProcessor(
        recording_id, _final_field_events(store.read_events(recording_id))
    ).process()
    if manifest.status == "recording":
        manifest.status = "stopped"
        manifest.ended_at = datetime.now(UTC).isoformat()
        manifest.stats.steps = len(steps.steps)
        store.write_manifest(manifest)
    return {
        "recordingId": recording_id,
        "name": manifest.target.title,
        "events": manifest.stats.events,
        "document": steps.model_dump(mode="json", by_alias=True),
    }
