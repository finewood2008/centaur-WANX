import hashlib
import sqlite3
import uuid
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from wanx_clipboard import service
from wanx_clipboard.app import PREFIX, create_app


def descriptor(data=b"synthetic", **fields):
    return {
        "id": uuid.uuid4().hex,
        "kind": "text",
        "name": "中文 空格 #%.txt",
        "mime": "text/plain",
        "size": len(data),
        "digest": hashlib.sha256(data).hexdigest(),
        "device": "test",
        **fields,
    }


C = PREFIX
P = "/api/personal-space"


def post(client, route, data):
    response = client.post(route, json=data)
    assert response.status_code == 200, response.text
    return response.json()


def reserve(e, data=b"synthetic", **fields):
    item = descriptor(data, **fields)
    batch = {"id": uuid.uuid4().hex, "items": [item]}
    post(e.business, C + "/batches", batch)
    return item, batch


def chunk(e, item, data, offset=0):
    return e.business.put(
        C + f"/{item['id']}/content?offset={offset}",
        content=data,
        headers={"X-Content-SHA256": hashlib.sha256(data).hexdigest()},
    )


def save(e, data=b"synthetic", **fields):
    item, _ = reserve(e, data, **fields)
    for offset in range(0, len(data), 1024 * 1024):
        assert chunk(e, item, data[offset : offset + 1024 * 1024], offset).status_code == 200
    return post(e.business, C + f"/{item['id']}/complete", {"digest": item["digest"]})


def manage(e, item, action, **fields):
    return post(
        e.business,
        C + "/manage",
        {"action": action, "targets": [{"id": item["id"], "expected": item["version"]}], **fields},
    )


def test_core_contract_and_schema_are_clipboard_free(environment):
    e = environment
    save(e)
    assert not any("clipboard" in route for route in e.core.openapi()["paths"])
    assert "clipboardBytes" not in e.owner.get(P + "/overview").json()
    for database in (e.path / "core").rglob("index.sqlite3"):
        with sqlite3.connect(database) as db:
            assert not db.execute(
                "SELECT name FROM sqlite_master WHERE name LIKE 'clipboard_%'"
            ).fetchall()
    for source in Path(__file__).parents[1].joinpath("wanx_clipboard").glob("*.py"):
        assert "from octop" not in source.read_text() and "import octop" not in source.read_text()
    assert e.business.get(C + "/openapi.json").status_code == 200
    assert e.business.get(C, headers={"origin": "http://evil.example"}).status_code == 403
    assert e.business.get(C, headers={"authorization": ""}).status_code == 401


def test_two_devices_restart_and_original_name_bytes(environment):
    e = environment
    content = "中文\n  spaces # % & 🐎".encode()
    item = save(e, content)
    second = TestClient(
        create_app(e.path / "business", "http://core", transport=e.transport),
        headers={"authorization": "Bearer owner-1"},
    )
    with second:
        listed = second.get(C).json()
        assert len(listed["items"]) == 1
        assert second.get(C + f"/{item['id']}/content").content == content
        assert listed["items"][0]["original_name"] == item["name"]
        manage(e, item, "rename", name="新显示名")
        assert second.get(C).json()["items"][0]["original_name"] == item["name"]
    assert e.business.get(C, headers={"authorization": "Bearer owner-2"}).json()["items"] == []
    assert (
        e.business.get(
            C + f"/{item['id']}", headers={"authorization": "Bearer owner-2"}
        ).status_code
        == 404
    )
    # Payloads are ordinary existing-API files, under a dedicated application folder.
    root = e.owner.get(P + "/files").json()["items"]
    assert [r["name"] for r in root] == ["应用文件"]


@pytest.mark.parametrize(
    "invalid", ["count", "file", "image", "empty_image", "mime", "text", "duplicate"]
)
def test_whole_batch_preflight_no_core_upload(environment, invalid):
    e = environment
    item = descriptor()
    items = [descriptor() for _ in range(21)] if invalid == "count" else [item, descriptor()]
    if invalid == "file":
        items[1].update(kind="file")
    if invalid == "image":
        items[1].update(kind="image", mime="image/png", size=20 * 1024 * 1024 + 1)
    if invalid == "empty_image":
        items[1].update(kind="image", mime="image/png", size=0)
    if invalid == "mime":
        items[1].update(kind="image", mime="application/pdf")
    if invalid == "text":
        items[1]["size"] = 1024 * 1024 + 1
    if invalid == "duplicate":
        items[1] = item
    assert (
        e.business.post(C + "/batches", json={"id": uuid.uuid4().hex, "items": items}).status_code
        >= 400
    )
    assert e.business.get(C).json()["usage"]["reserved"] == 0
    assert not any(path.endswith("/uploads") for _, path in e.calls)


def test_exact_limits_and_atomic_quota(environment, monkeypatch):
    e = environment
    items = [descriptor(kind="image", mime="image/png", size=20 * 1024 * 1024) for _ in range(20)]
    post(e.business, C + "/batches", {"id": uuid.uuid4().hex, "items": items})
    assert e.business.get(C).json()["usage"]["reserved"] == 400 * 1024 * 1024
    assert not any(method == "POST" and path.endswith("/uploads") for method, path in e.calls)
    monkeypatch.setattr(service, "CLIPBOARD_LIMIT", 400 * 1024 * 1024)
    response = e.business.post(
        C + "/batches", json={"id": uuid.uuid4().hex, "items": [descriptor()]}
    )
    assert response.status_code == 413 and response.json()["detail"]["code"] == "CLIPBOARD_QUOTA"


def test_resume_after_business_restart_and_lost_core_commit_reply(environment):
    e = environment
    data = b"\x89PNG\r\n\x1a\n" + b"x" * (1024 * 1024 - 8) + "尾部".encode()
    item, batch = reserve(e, data, kind="image", mime="image/png")
    assert chunk(e, item, data[: 1024 * 1024]).json()["offset"] == 1024 * 1024
    e.app.state.locks.clear()  # no process-local receipt is needed for recovery
    retry = post(e.business, C + "/batches", batch)
    assert retry["items"][0]["offset"] == 1024 * 1024
    assert chunk(e, item, data[1024 * 1024 :], 1024 * 1024).status_code == 200

    def drop(request, response):
        if request.url.path.endswith("/complete"):
            e.fault["after"] = None
            raise httpx.ReadError("reply lost after core committed")

    e.fault["after"] = drop
    assert (
        e.business.post(C + f"/{item['id']}/complete", json={"digest": item["digest"]}).status_code
        == 503
    )
    post(e.business, C + f"/{item['id']}/complete", {"digest": item["digest"]})
    assert len(e.business.get(C).json()["items"]) == 1
    assert (
        e.business.get(C + f"/{item['id']}/content?length=1048576").content == data[: 1024 * 1024]
    )
    assert (
        e.business.get(C + f"/{item['id']}/content?offset=1048576").content == data[1024 * 1024 :]
    )
    assert e.owner.get(P + f"/files/{item['id']}").json()["digest"] == item["digest"]


def test_existing_storage_migration_includes_ready_pending_trash_and_export(environment):
    e = environment
    item = save(e, b"immutable payload")
    pending, _ = reserve(e, b"pending-tail")
    assert chunk(e, pending, b"pending-").status_code == 200
    recycled = save(e, b"recycled")
    manage(e, recycled, "trash")
    target = e.path / "destination"
    target.mkdir()
    result = post(e.owner, P + "/spaces/personal/storage", {"path": str(target)})
    assert result["migrated_objects"] >= 2
    assert e.business.get(C + f"/{pending['id']}").json()["offset"] == 8
    assert e.business.get(C + f"/{item['id']}/content").content == b"immutable payload"
    assert chunk(e, pending, b"tail", 8).status_code == 200
    post(e.business, C + f"/{pending['id']}/complete", {"digest": pending["digest"]})
    trash = e.business.get(C + "?trash=true").json()["items"][0]
    manage(e, trash, "restore")
    export_id = uuid.uuid4().hex
    copied = post(e.business, C + f"/{item['id']}/export", {"id": export_id, "expected": 1})
    assert copied["id"] == export_id
    assert (
        post(e.business, C + f"/{item['id']}/export", {"id": export_id, "expected": 1})["id"]
        == export_id
    )
    post(e.owner, P + "/spaces/personal/storage", {"path": ""})
    assert e.business.get(C + f"/{pending['id']}/content").content == b"pending-tail"
    assert e.business.get(C + f"/{recycled['id']}/content").content == b"recycled"
    manage(e, item, "trash")
    trash = next(
        i for i in e.business.get(C + "?trash=true").json()["items"] if i["id"] == item["id"]
    )
    manage(e, trash, "purge")
    assert e.owner.get(P + f"/files/{export_id}/content").content == b"immutable payload"
    assert e.owner.get(P + f"/files/{item['id']}").status_code == 404


def test_pin_expiry_restore_and_observed_versions(environment, monkeypatch):
    e = environment
    now = 1800000000.0
    monkeypatch.setattr(service.time, "time", lambda: now)
    pinned = save(e)
    normal = save(e)
    manage(e, pinned, "pin")
    assert (
        e.business.post(
            C + "/manage",
            json={
                "action": "rename",
                "name": "stale",
                "targets": [{"id": pinned["id"], "expected": 1}],
            },
        ).status_code
        == 409
    )
    now += service.RETENTION + 1
    assert [i["id"] for i in e.business.get(C).json()["items"]] == [pinned["id"]]
    expired = e.business.get(C + "?trash=true").json()["items"][0]
    assert expired["id"] == normal["id"]
    assert e.business.get(C + f"/{normal['id']}/content").status_code == 404
    manage(e, expired, "restore")
    assert e.business.get(C + f"/{normal['id']}").json()["expires"] == now + service.RETENTION


def test_approved_agents_read_only_isolated_and_live_pause_recheck(environment):
    e = environment
    item = save(e, b"shared")

    def access(token, **args):
        return e.business.post(
            C + "/agent-access",
            headers={"X-Space-Link": token},
            json={"action": "clipboard-read", "target": item["id"], **args},
        )

    assert access("unapproved").status_code == 403
    a = post(e.owner, P + "/connections", {"profile": "a", "name": "same-name"})
    b = post(e.owner, P + "/connections", {"profile": "b", "name": "same-name"})
    assert a["space_id"] != b["space_id"]
    for agent in (a, b):
        assert access(agent["token"]).json()["text"] == "shared"
        assert access(agent["token"], action="clipboard-manage").status_code == 422
    assert (
        e.owner.post(
            P + "/connection-access",
            headers={"X-Space-Link": a["token"]},
            json={"action": "stat", "target": item["id"]},
        ).status_code
        == 403
    )
    assert access(a["token"], grant_id=uuid.uuid4().hex).status_code == 403
    assert (
        e.business.post(
            C + "/agent-access",
            headers={"Authorization": "Bearer owner-2", "X-Space-Link": a["token"]},
            json={"action": "clipboard-list"},
        ).status_code
        == 403
    )
    post(e.owner, P + f"/connections/{a['id']}/manage", {"action": "pause"})
    assert access(a["token"]).status_code == 403
    assert access(b["token"]).status_code == 200
    post(e.owner, P + f"/connections/{a['id']}/manage", {"action": "resume"})

    def pause_mid_read(request, response):
        if request.url.path.endswith("/content"):
            e.fault["after"] = None
            post(e.owner, P + f"/connections/{a['id']}/manage", {"action": "pause"})

    e.fault["after"] = pause_mid_read
    assert access(a["token"]).status_code == 403
    post(e.owner, P + f"/connections/{a['id']}/manage", {"action": "disconnect"})
    assert access(a["token"]).status_code == 403


def test_agent_context_policy_still_enforced_by_existing_core(environment):
    e = environment
    item = save(e)
    agent = post(
        e.owner,
        P + "/connections",
        {"profile": "policy", "name": "Agent", "sync_policy": {"context": True}},
    )

    def call(**args):
        return e.business.post(
            C + "/agent-access",
            headers={"X-Space-Link": agent["token"]},
            json={"action": "clipboard-read", "target": item["id"], **args},
        )

    assert call().json()["detail"]["code"] == "SPACE_CONTEXT_REQUIRED"
    task = post_agent(
        e,
        agent,
        {
            "action": "task-begin",
            "request_id": "begin",
            "title": "synthetic",
            "policy_revision": 1,
            "categories": {
                "context": {"status": "provided", "summary": "test only", "sources": []}
            },
        },
    )
    assert call(task_id=task["task_id"], policy_revision=1).status_code == 200
    assert call(task_id=task["task_id"], policy_revision=0).status_code == 409
    assert call(task_id=uuid.uuid4().hex, policy_revision=1).status_code == 403


def post_agent(e, agent, body):
    response = e.owner.post(
        P + "/connection-access", headers={"X-Space-Link": agent["token"]}, json=body
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_export_lost_reply_reuses_same_file_and_cancel_collects_completed_payload(environment):
    e = environment
    item = save(e)
    export_id = uuid.uuid4().hex

    def drop_export(request, response):
        if request.url.path.endswith(export_id + "/complete"):
            e.fault["after"] = None
            raise httpx.ReadError("export complete reply lost")

    e.fault["after"] = drop_export
    payload = {"id": export_id, "expected": 1}
    assert e.business.post(C + f"/{item['id']}/export", json=payload).status_code == 503
    assert post(e.business, C + f"/{item['id']}/export", payload)["id"] == export_id
    pending, _ = reserve(e)
    assert chunk(e, pending, b"synthetic").status_code == 200

    def drop_commit(request, response):
        if request.url.path.endswith(pending["id"] + "/complete"):
            e.fault["after"] = None
            raise httpx.ReadError("commit reply lost")

    e.fault["after"] = drop_commit
    assert (
        e.business.post(
            C + f"/{pending['id']}/complete", json={"digest": pending["digest"]}
        ).status_code
        == 503
    )
    manage(e, {**pending, "version": 1}, "cancel")
    assert e.owner.get(P + f"/files/{pending['id']}").status_code == 404
    assert e.business.get(C).json()["usage"]["reserved"] == item["size"]


def test_concurrent_devices_cannot_overreserve_quota(environment, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    e = environment
    monkeypatch.setattr(service, "CLIPBOARD_LIMIT", 10)

    def reserve_one(_):
        return e.business.post(
            C + "/batches", json={"id": uuid.uuid4().hex, "items": [descriptor(b"123456")]}
        )

    with ThreadPoolExecutor(2) as pool:
        statuses = sorted(r.status_code for r in pool.map(reserve_one, range(2)))
    assert statuses == [200, 413]
    assert e.business.get(C).json()["usage"]["reserved"] == 6


def test_spoofed_image_does_not_open_upstream_upload(environment):
    e = environment
    item, _ = reserve(e, b"not an image", kind="image", mime="image/png")
    result = chunk(e, item, b"not an image")
    assert result.status_code == 400
    assert result.json()["detail"]["code"] == "CLIPBOARD_IMAGES_ONLY"
    assert not any(method == "POST" and path.endswith("/uploads") for method, path in e.calls)
    assert e.business.get(C).json()["items"] == []


def test_historical_file_records_remain_downloadable_and_manageable(environment):
    e = environment
    item = save(e, b"legacy attachment")
    database = next((e.path / "business").rglob("clipboard.sqlite3"))
    with sqlite3.connect(database) as db:
        db.execute(
            "UPDATE clipboard_items SET kind='file',mime='application/octet-stream' WHERE id=?",
            (item["id"],),
        )
    listed = e.business.get(C).json()["items"][0]
    assert listed["kind"] == "file"
    assert e.business.get(C + f"/{item['id']}/content").content == b"legacy attachment"
    manage(e, listed, "trash")
    recycled = e.business.get(C + "?trash=true").json()["items"][0]
    manage(e, recycled, "restore")
    assert e.business.get(C).json()["items"][0]["id"] == item["id"]
