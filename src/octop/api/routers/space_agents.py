"""Private desktop Agent discovery bindings, collection and file authorization."""

from __future__ import annotations

from functools import partial
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import Field

from octop.api.deps import current_user, get_server
from octop.api.routers.personal_space import Input, call
from octop.infra.personal_space.agent_hub import AgentHub
from octop.infra.personal_space.service import CHUNK_SIZE

router = APIRouter(include_in_schema=False)
Domain = Literal["personal", "company"]


async def hub(user: Any = Depends(current_user), server: Any = Depends(get_server)) -> AgentHub:
    if getattr(user, "application_id", "wanx") != "wanx":
        raise HTTPException(status_code=403, detail="AGENT_ACCESS_DENIED")
    return await call(
        partial(
            AgentHub,
            server.paths.root,
            user.id,
            user.display_name or user.username,
            admin=user.role == "admin",
        )
    )


class Registration(Input):
    machine: str = Field(pattern=r"^[a-f0-9]{32}$")
    kind: Literal["codex", "claude", "openclaw"]
    profile: str = Field(pattern=r"^[a-f0-9]{64}$")
    name: str = Field(min_length=1, max_length=80)
    destination: Domain
    credential: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


class Project(Input):
    id: str = Field(pattern=r"^[a-f0-9]{64}$")
    name: str = Field(min_length=1, max_length=200)
    conversations: bool = True
    memory: bool = True


class Collection(Input):
    enabled: bool = False
    projects: list[Project] = Field(default_factory=list, max_length=300)
    userMemory: bool = False


class Configuration(Input):
    expected: int = Field(ge=0)
    collection: Collection


class Record(Input):
    id: str = Field(min_length=1, max_length=128)
    project: str = Field(pattern=r"^([a-f0-9]{64}|global)$")
    category: Literal["conversation", "context", "project_memory", "user_memory"]
    session: str = Field(default="", max_length=200)
    role: Literal["user", "assistant", "memory", "context"]
    title: str = Field(default="", max_length=200)
    text: str = Field(max_length=600000)
    timestamp: str = Field(max_length=100)
    origin: dict[str, str | int] = Field(default_factory=dict, max_length=12)
    attachments: list[str] = Field(default_factory=list, max_length=30)
    part: int = Field(default=1, ge=1)
    parts: int = Field(default=1, ge=1)


class Batch(Input):
    records: list[Record] = Field(min_length=1, max_length=50)


class Grant(Input):
    domain: Domain
    root: str = Field(pattern=r"^[a-f0-9]{32}$")
    permission: Literal["read", "write"] = "read"


class AgentOperation(Input):
    action: str = Field(max_length=40)
    target: str = Field(default="", pattern=r"^([0-9a-f]{32})?$")
    parent: str | None = Field(default=None, pattern=r"^([0-9a-f]{32})?$")
    name: str = Field(default="", max_length=240)
    expected: int | None = Field(default=None, ge=1)
    upload_id: str = Field(default="", pattern=r"^([0-9a-f]{32})?$")
    size: int = Field(default=0, ge=0, le=2**53 - 1)
    offset: int = Field(default=0, ge=0)
    length: int = Field(default=200, ge=1, le=CHUNK_SIZE)
    digest: str = Field(default="", pattern=r"^([a-f0-9]{64})?$")
    data: str = Field(
        default="",
        max_length=(CHUNK_SIZE + 2) // 3 * 4,
        description="Base64 chunk, at most 4 MiB decoded.",
    )
    agent: str = Field(
        default="",
        max_length=80,
        description="Self-declared display name, not an authenticated identity.",
    )
    grant_id: str = Field(default="", pattern=r"^([a-f0-9]{32})?$")


class Migration(Input):
    kind: Literal["link", "connection"]
    id: str = Field(pattern=r"^[a-f0-9]{32}$")


class ArchiveAction(Input):
    project: str = Field(pattern=r"^([a-f0-9]{64}|global)$")
    hidden: bool


@router.put("/archives/{aid}")
async def archive_action(aid: str, body: ArchiveAction, service: AgentHub = Depends(hub)) -> Any:
    return await call(service.archive_action, aid, body.project, body.hidden)


@router.post("/connections/{aid}/migrate")
async def migrate(aid: str, body: Migration, service: AgentHub = Depends(hub)) -> Any:
    return await call(service.migrate_legacy, aid, body.kind, body.id)


@router.get("/connections")
async def listing(service: AgentHub = Depends(hub)) -> Any:
    return await call(service.listing)


@router.post("/connections")
async def register(body: Registration, service: AgentHub = Depends(hub)) -> Any:
    return await call(service.register, body.model_dump())


@router.put("/connections/{aid}/collection")
async def configure(aid: str, body: Configuration, service: AgentHub = Depends(hub)) -> Any:
    return await call(service.configure, aid, body.model_dump())


@router.delete("/connections/{aid}")
async def disconnect(aid: str, service: AgentHub = Depends(hub)) -> Any:
    return await call(service.disconnect, aid)


@router.post("/connections/{aid}/records")
async def ingest(aid: str, body: Batch, service: AgentHub = Depends(hub)) -> Any:
    return await call(service.ingest, aid, [r.model_dump() for r in body.records])


@router.get("/archives")
async def archives(destination: Domain = "personal", service: AgentHub = Depends(hub)) -> Any:
    return await call(service.archives, destination)


@router.get("/archives/{aid}/records")
async def records(
    aid: str, project: str, offset: int = Query(default=0, ge=0), service: AgentHub = Depends(hub)
) -> Any:
    return await call(service.records, aid, project, offset)


@router.get("/records/{rid}")
async def record(rid: str, service: AgentHub = Depends(hub)) -> Any:
    return await call(service.record, rid)


@router.get("/folders")
async def folders(
    domain: Domain = "personal", parent: str = "", service: AgentHub = Depends(hub)
) -> Any:
    return await call(service.browse, domain, parent)


@router.post("/connections/{aid}/grants")
async def grant(aid: str, body: Grant, service: AgentHub = Depends(hub)) -> Any:
    return await call(service.grant, aid, body.domain, body.root, body.permission)


@router.get("/connections/{aid}/grants")
async def grants(aid: str, service: AgentHub = Depends(hub)) -> Any:
    def read() -> list[dict[str, Any]]:
        with service.db() as db:
            service.agent(db, aid)
            return service._grants(db, aid)

    return await call(read)


@router.delete("/connections/{aid}/grants/{gid}")
async def revoke(aid: str, gid: str, service: AgentHub = Depends(hub)) -> Any:
    return await call(service.revoke, aid, gid)


@router.post("/connections/{aid}/invoke")
async def invoke(
    aid: str,
    body: AgentOperation,
    x_agent_connection: str = Header(default=""),
    service: AgentHub = Depends(hub),
) -> Any:
    return await call(service.invoke, aid, x_agent_connection, body.model_dump())
