"""Skill demonstration lifecycle for the WANX browser app."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator

from octop.api.deps import current_user
from octop.api.routers.browser.harness import resolve_harness_session
from octop.infra.browser import learning
from octop.infra.browser.control import control_for
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.users.permissions import user_has_permission
from octop.infra.utils.browser_media import user_browser_profile

router = APIRouter()


class StartBody(BaseModel):
    client_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,128}$")
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def nonempty_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("name must not be blank")
        return value.strip()


class RecordingBody(BaseModel):
    recording_id: str = Field(pattern=r"^learn_[a-f0-9]{32}$")


class LeaseBody(RecordingBody):
    client_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,128}$")


def _profile(user: Any) -> str:
    if not user_has_permission(user, "browser"):
        raise OctopError(ErrorCode.FORBIDDEN, "browser permission required")
    return user_browser_profile(user.id)


@router.get("/browser/learning/status", summary="Read current user's skill learning status")
async def status(user: Any = Depends(current_user)) -> dict[str, Any]:
    return learning.status(_profile(user))


@router.post("/browser/learning/start", summary="Learn from the current browser tab")
async def start(body: StartBody, user: Any = Depends(current_user)) -> dict[str, Any]:
    profile = _profile(user)
    control = control_for(profile)
    async with control.lock:
        if control.owner != "user":
            raise OctopError(ErrorCode.SLASH_BAD_ARGS, "take over the browser first", status=409)
        session = await resolve_harness_session(profile, create=False)
        if session is None:
            raise OctopError(ErrorCode.NOT_FOUND, "connect the browser first")
        return await learning.start(profile, body.client_id, body.name.strip(), session)


@router.post("/browser/learning/lease", summary="Keep this app's learning session active")
async def lease(body: LeaseBody, user: Any = Depends(current_user)) -> dict[str, Any]:
    return learning.renew(_profile(user), body.client_id, body.recording_id)


@router.post("/browser/learning/stop", summary="Finish learning and review the draft")
async def stop(body: RecordingBody, user: Any = Depends(current_user)) -> dict[str, Any]:
    profile = _profile(user)
    control = control_for(profile)
    async with control.lock:
        if control.owner != "user":
            raise OctopError(ErrorCode.SLASH_BAD_ARGS, "take over the browser first", status=409)
        return await learning.stop(profile, body.recording_id)


@router.post("/browser/learning/draft", summary="Recover an owned learning draft")
async def draft(body: RecordingBody, user: Any = Depends(current_user)) -> dict[str, Any]:
    return await asyncio.to_thread(learning.draft, _profile(user), body.recording_id)
