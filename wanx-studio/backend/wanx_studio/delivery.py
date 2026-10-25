"""Private client configuration for a finished application's runtime model."""

from copy import deepcopy

from fastapi import Depends
from pydantic import Field

from .contracts import Operation, StudioError


class RuntimeModel(Operation):
    expectedRevision: int = Field(ge=0)
    modelId: str | None = Field(default=None, min_length=1, max_length=128)


def catalog(svc):
    reader = getattr(svc.model, "runtime_catalog", None)
    if not reader:
        raise StudioError("RUNTIME_MODEL_UPDATE_REQUIRED", 409)
    return reader()


def read(svc, owner, pid):
    svc.authorize_management(owner)
    p = svc.store.get(owner, pid)
    values = catalog(svc)
    setting = p.get("_runtimeModel", {})
    chosen = next((m for m in values["models"] if m["id"] == setting.get("modelId")), None)
    return {
        **values,
        "revision": setting.get("revision", 0),
        "modelId": setting.get("modelId"),
        "selected": chosen,
        "available": not setting.get("modelId") or chosen is not None,
        "previousLabel": setting.get("label"),
        "usesModel": any("model" in a["manifest"]["capabilities"] for a in p["artifacts"]),
    }


def save(svc, owner, pid, body):
    svc.authorize_management(owner)
    values = catalog(svc)
    chosen = next((m for m in values["models"] if m["id"] == body["modelId"]), None)
    if body["modelId"] and chosen is None:
        raise StudioError("RUNTIME_MODEL_UNAVAILABLE", 409)

    def change(p):
        if not p["artifacts"]:
            raise StudioError("ARTIFACT_NOT_FOUND", 404)
        if not any("model" in a["manifest"]["capabilities"] for a in p["artifacts"]):
            raise StudioError("RUNTIME_MODEL_NOT_USED", 409)
        current = p.get("_runtimeModel", {})
        if current.get("revision", 0) != body["expectedRevision"]:
            raise StudioError("RUNTIME_MODEL_CHANGED", 409)
        p["_runtimeModel"] = {
            "revision": current.get("revision", 0) + 1,
            "modelId": body["modelId"],
            "label": f"{chosen['provider']} · {chosen['name']}" if chosen else None,
        }

    svc.store.mutate(owner, pid, body["operationId"], {"action": "runtime-model", **body}, change)
    return read(svc, owner, pid)


def selection(svc, session):
    publisher = session["owner"]
    if "publicationDigest" in session:
        publisher = svc.team.resolve(
            session["owner"], app_id=session["app"], artifact_hash=session["artifact"]
        )["owner"]
    project = svc.store.get(publisher, session["project"], allow_deleted=True)
    return deepcopy(project.get("_runtimeModel", {})).get("modelId")


def mount(router, svc, identity):
    import asyncio

    auth = Depends(identity)

    @router.get("/_client/projects/{project_id}/runtime-model", include_in_schema=False)
    async def runtime_model(project_id: str, owner=auth):
        return await asyncio.to_thread(read, svc, owner, project_id)

    @router.put("/_client/projects/{project_id}/runtime-model", include_in_schema=False)
    async def update_runtime_model(project_id: str, body: RuntimeModel, owner=auth):
        return await asyncio.to_thread(save, svc, owner, project_id, body.model_dump())
