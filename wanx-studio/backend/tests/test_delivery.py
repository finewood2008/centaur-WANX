"""Finished-app model selection is independent of interviews and source versions."""

from copy import deepcopy
from pathlib import Path
from uuid import uuid4

import pytest
from wanx_studio.contracts import StudioError
from wanx_studio.delivery import read, save
from wanx_studio.runner import Runner
from wanx_studio.service import StudioService
from wanx_studio.store import public

ROOT = Path(__file__).resolve().parents[2]


class Models:
    def __init__(self):
        self.enabled = {"one", "two"}
        self.calls = []

    def runtime_catalog(self):
        return {
            "models": [
                {"id": key, "name": key, "provider": "WANX"} for key in sorted(self.enabled)
            ],
            "defaultId": "one",
        }

    def for_runtime(self, key):
        if key not in self.enabled:
            return None

        async def chosen(owner, body):
            self.calls.append((owner, key))
            return {"choices": [{"message": {"content": key}}]}

        return chosen

    async def __call__(self, owner, body):
        self.calls.append((owner, "default"))
        return {"choices": [{"message": {"content": "default"}}]}


@pytest.fixture
async def fixture(tmp_path):
    models = Models()
    svc = StudioService(tmp_path, ROOT, models)
    svc.runner = Runner(svc)
    p = svc.store.create("admin", "成品模型测试", "用户主动生成内容", uuid4().hex)
    p = await svc.runner.example("admin", p["id"], uuid4().hex)
    yield svc, models, p
    await svc.close()


async def test_project_model_does_not_rewrite_prd_artifacts_or_global_model(fixture):
    svc, models, p = fixture
    before = deepcopy(svc.store.get("admin", p["id"]))
    runtime = svc.open_runtime("admin", p["id"], p["artifacts"][-1]["hash"], "preview")["session"]
    body = {"operationId": uuid4().hex, "expectedRevision": 0, "modelId": "two"}
    value = save(svc, "admin", p["id"], body)
    assert value["modelId"] == "two" and value["revision"] == 1
    assert save(svc, "admin", p["id"], body)["revision"] == 1
    after = svc.store.get("admin", p["id"])
    for key in ["solution", "confirmation", "tasks", "artifacts", "engine", "versioning"]:
        assert after.get(key) == before.get(key)
    assert "_runtimeModel" not in public(after)
    assert models.runtime_catalog()["defaultId"] == "one"
    assert (await svc.invoke("admin", runtime, "model.generate", {"prompt": "hello"}))[
        "text"
    ] == "two"
    await svc.generate("admin", p["id"], {"messages": []})
    assert models.calls == [("admin", "two"), ("admin", "default")]
    save(
        svc, "admin", p["id"], {"operationId": uuid4().hex, "expectedRevision": 1, "modelId": None}
    )
    assert (await svc.invoke("admin", runtime, "model.generate", {"prompt": "hello"}))[
        "text"
    ] == "default"


async def test_stale_invalid_unavailable_and_cross_project_selection_fail_closed(fixture):
    svc, models, p = fixture
    save(
        svc, "admin", p["id"], {"operationId": uuid4().hex, "expectedRevision": 0, "modelId": "two"}
    )
    with pytest.raises(StudioError, match="RUNTIME_MODEL_CHANGED"):
        save(
            svc,
            "admin",
            p["id"],
            {"operationId": uuid4().hex, "expectedRevision": 0, "modelId": "one"},
        )
    with pytest.raises(StudioError, match="RUNTIME_MODEL_UNAVAILABLE"):
        save(
            svc,
            "admin",
            p["id"],
            {"operationId": uuid4().hex, "expectedRevision": 1, "modelId": "unknown"},
        )
    with pytest.raises(StudioError, match="PROJECT_NOT_FOUND"):
        read(svc, "other", p["id"])
    models.enabled.remove("two")
    assert read(svc, "admin", p["id"])["available"] is False
    token = svc.open_runtime("admin", p["id"], p["artifacts"][-1]["hash"], "preview")["session"]
    with pytest.raises(StudioError, match="RUNTIME_MODEL_UNAVAILABLE"):
        await svc.invoke("admin", token, "model.generate", {"prompt": "hello"})
    assert models.calls == []


async def test_runtime_model_persists_on_restart(fixture):
    svc, models, p = fixture
    save(
        svc, "admin", p["id"], {"operationId": uuid4().hex, "expectedRevision": 0, "modelId": "two"}
    )
    folder = svc.store.root
    await svc.close()
    reopened = StudioService(folder, ROOT, models)
    try:
        assert read(reopened, "admin", p["id"])["modelId"] == "two"
    finally:
        await reopened.close()


async def test_published_app_uses_creator_setting_but_member_identity(fixture):
    from types import SimpleNamespace

    svc, models, p = fixture
    svc.team = SimpleNamespace(
        is_admin=lambda owner: owner == "admin",
        resolve=lambda owner, **kwargs: {"owner": "admin"},
        assert_session=lambda owner, session: None,
    )
    save(
        svc, "admin", p["id"], {"operationId": uuid4().hex, "expectedRevision": 0, "modelId": "two"}
    )
    with pytest.raises(StudioError, match="STUDIO_ADMIN_REQUIRED"):
        read(svc, "member", p["id"])
    svc.runtime_sessions["published-token"] = {
        "owner": "member",
        "project": p["id"],
        "app": p["appId"],
        "artifact": p["artifacts"][-1]["hash"],
        "expires": float("inf"),
        "publicationDigest": "sealed",
        "manifest": {"capabilities": ["model"]},
    }
    value = await svc.invoke("member", "published-token", "model.generate", {"prompt": "test"})
    assert value["text"] == "two"
    assert models.calls == [("member", "two")]


async def test_runtime_model_selection_does_not_start_model_after_local_revoke(fixture, monkeypatch):
    import asyncio
    import threading
    from types import SimpleNamespace
    from wanx_studio import delivery
    from wanx_studio.local_authority import Actor, _actor

    svc, models, project = fixture
    token = svc.open_runtime("admin", project["id"], project["artifacts"][-1]["hash"], "preview")["session"]
    started, release = threading.Event(), threading.Event()
    revoked = False

    def check():
        if revoked:
            raise RuntimeError("revoked")

    def selection(*_args):
        started.set()
        release.wait(3)
        return "one"

    monkeypatch.setattr(delivery, "selection", selection)
    actor_token = _actor.set(Actor(None, None, SimpleNamespace(require_live=check)))
    try:
        pending = asyncio.create_task(svc.invoke("admin", token, "model.generate", {"prompt": "test"}))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            revoked = True
        finally:
            release.set()
        with pytest.raises(RuntimeError, match="revoked"):
            await pending
        assert models.calls == []
    finally:
        _actor.reset(actor_token)
