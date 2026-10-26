"""Publish native objects into explicit box-local resource ACL scopes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from octop.api.deps import current_user, get_server
from octop.infra.users.team_authority import require_team_permission
from octop.infra.users.team_resources import publish

router = APIRouter(prefix="/api/team/resources", tags=["applications"])


class PublishResource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resource_id: str = Field(
        pattern=r"^team:(agent|knowledge|space):[A-Za-z0-9][A-Za-z0-9._-]{0,95}$"
    )
    name: str = Field(default="", max_length=240)


class PublishedResource(BaseModel):
    box_id: str
    ownership_epoch: int
    resource_id: str
    kind: str
    object_id: str
    owner_user_id: int
    created_at: int


@router.get(
    "",
    response_model=list[PublishedResource],
    summary="List this team's explicitly published native resources",
)
def list_resources(user: Any = Depends(current_user), server: Any = Depends(get_server)) -> Any:
    team = require_team_permission(user, "resources.manage")
    return server.services.local_team_resource_repo.list(team["boxId"], team["ownershipEpoch"])


@router.post(
    "",
    response_model=PublishedResource,
    summary="Publish one owned object into a team resource scope",
)
def publish_resource(
    body: PublishResource, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> Any:
    return publish(server, user, body.resource_id, body.name)
