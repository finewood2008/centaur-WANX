"""Independent advisory application over native Teams and owner context."""

from typing import Any

from fastapi import APIRouter, Depends, Response

from octop.api.deps import current_user, get_server
from octop.infra.agents.experts.skillhub_market import SkillHubMarketError, SkillHubMarketErrorKind
from octop.infra.agents.teams.brainstorm import service_for
from octop.infra.agents.teams.brainstorm_types import (
    BrainstormExpert,
    BrainstormProfile,
    BrainstormSession,
    MeetingReport,
    ProfileConfigure,
    SessionControl,
    SessionCreate,
)
from octop.infra.errors import ErrorCode, OctopError

router = APIRouter()


def _service(server: Any) -> Any:
    return service_for(server.app_runtime.agent_registry)


@router.get(
    "/profile",
    response_model=BrainstormProfile,
    summary="Get my advisory roster and WANX expert catalog",
)
async def profile(user: Any = Depends(current_user), server: Any = Depends(get_server)) -> Any:
    return await _service(server).profile(user)


@router.post(
    "/profile",
    response_model=BrainstormProfile,
    summary="Initialize or configure my advisory team",
    description="Selects two to twelve expert templates from WANX and optionally assigns each an enabled WANX chat model. Reuses private native Agents and histories. Rejects unknown, disabled or embedding models and changes during active discussions. Provider settings and host deployment bindings remain managed by WANX.",
)
async def configure(
    body: ProfileConfigure, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> Any:
    return await _service(server).configure(user, body)


@router.post(
    "/experts/{slug}/import",
    response_model=BrainstormExpert,
    summary="Import a SkillHub expert template into the WANX catalog",
    description="Uses WANX's existing SkillHub package installer. Imported experts can then be selected for the user's private advisory roster; this does not publish or change other agents.",
)
async def import_expert(
    slug: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> Any:
    try:
        return await _service(server).import_expert(user, slug, server.paths.expert_market_dir)
    except SkillHubMarketError as exc:
        code = (
            ErrorCode.NOT_FOUND
            if exc.kind == SkillHubMarketErrorKind.NOT_FOUND
            else ErrorCode.APPLICATION_INVALID
        )
        raise OctopError.localized(code) from exc


@router.get(
    "/sessions", response_model=list[BrainstormSession], summary="List my brainstorming topics"
)
async def list_sessions(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> Any:
    return await _service(server).list_sessions(user)


@router.post(
    "/sessions",
    response_model=BrainstormSession,
    status_code=201,
    summary="Open a user-centered meeting with the host",
    description="Retrieves owned Zhijun context and begins a short intake conversation. Advisors cannot be dispatched until the user confirms the proposed agenda.",
)
async def create(
    body: SessionCreate, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> Any:
    return await _service(server).create(user, body)


@router.get(
    "/sessions/{thread_id}",
    response_model=BrainstormSession,
    summary="Get my brainstorming state and sources",
)
async def get(
    thread_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> Any:
    return await _service(server).get(user, thread_id)


@router.get(
    "/sessions/{thread_id}/report",
    response_model=MeetingReport,
    summary="Read my final meeting report",
    description="Available after closure. Uses the frozen meeting findings and explicit owner ruling. Older closed meetings are compiled on first read. Ownership and application authorization are required.",
)
async def report(
    thread_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> Any:
    return await _service(server).report(user, thread_id)


@router.get(
    "/sessions/{thread_id}/report/document",
    response_class=Response,
    summary="Export my final meeting report as an editable Word document",
    description="Renders the same frozen report as a genuine DOCX. Requires ownership and active application authorization; does not rerun agents or adopt recommendations.",
    responses={
        200: {
            "content": {
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
                    "schema": {"type": "string", "format": "binary"}
                }
            }
        }
    },
)
async def report_document(
    thread_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> Response:
    data = await _service(server).report_document(user, thread_id)
    return Response(
        data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": 'attachment; filename="meeting-report.docx"'},
    )


@router.post(
    "/sessions/{thread_id}/control",
    response_model=BrainstormSession,
    summary="Respond, confirm the agenda or control my meeting",
    description="Text and decision-card selections share the respond action. Start requires the current agenda decision ID; selections require the current decision ID and option index. Revision rejects stale submissions. Adoption records the user's ruling and closes the meeting. Pause blocks future dispatches; in-flight results remain in history. Source changes pause and affect future context without retracting previous inputs.",
)
async def control(
    thread_id: str,
    body: SessionControl,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> Any:
    return await _service(server).control(user, thread_id, body)
