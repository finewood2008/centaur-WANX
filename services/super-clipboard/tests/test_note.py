import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
from fastapi.testclient import TestClient
from test_business import C, P, post, save
from wanx_clipboard import note, service
from wanx_clipboard.app import create_app


def put(e, blocks, expected=0, operation=None, action="save"):
    return e.business.put(
        C + "/note",
        json={
            "expected": expected,
            "operation": operation or uuid.uuid4().hex,
            "blocks": blocks,
            "action": action,
        },
    )


def test_one_note_ordered_images_unicode_replay_restart_and_account_isolation(environment):
    e = environment
    image = save(
        e, b"\x89PNG\r\n\x1a\nsynthetic", kind="image", mime="image/png", name="合成 图片.png"
    )
    blocks = [
        {"type": "text", "text": "标题\n中文  spaces 🐎 <script>not executable</script>\n"},
        {"type": "image", "item": image["id"]},
        {"type": "text", "text": "\n图片之后"},
    ]
    operation = uuid.uuid4().hex
    first = put(e, blocks, operation=operation)
    assert first.status_code == 200, first.text
    assert first.json()["revision"] == 1
    assert put(e, blocks, operation=operation).json()["revision"] == 1
    second = TestClient(
        create_app(e.path / "business", "http://core", transport=e.transport),
        headers={"authorization": "Bearer owner-1"},
    )
    with second:
        assert second.get(C + "/note").json()["blocks"] == blocks
        assert second.get(C + "/note?since=1").json()["unchanged"]
        assert (
            second.get(C + "/note", headers={"authorization": "Bearer owner-2"}).json()["blocks"]
            == []
        )
    assert put(e, [{"type": "text", "text": "stale"}]).status_code == 409
    assert e.business.get(C + "/note").json()["blocks"] == blocks
    # One current manifest, one image. A retry did not create another body object.
    app_folder = post(
        e.owner, P + "/app-folders", {"application": "wanx.clipboard", "name": "超级剪贴板"}
    )["id"]
    assert len(e.owner.get(P + "/files", params={"parent": app_folder}).json()["items"]) == 2


def test_lost_core_commit_reply_preserves_old_note_and_replays_without_duplicates(environment):
    e = environment
    original = [{"type": "text", "text": "原内容"}]
    assert put(e, original).status_code == 200
    body = {
        "expected": 1,
        "operation": uuid.uuid4().hex,
        "blocks": [{"type": "text", "text": "更新\n" * 10000}],
    }

    def drop(request, response):
        if request.url.path.endswith("/complete"):
            e.fault["after"] = None
            raise httpx.ReadError("synthetic lost receipt")

    e.fault["after"] = drop
    assert e.business.put(C + "/note", json=body).status_code == 503
    assert e.business.get(C + "/note").json()["blocks"] == original
    retried = e.business.put(C + "/note", json=body)
    assert retried.status_code == 200, retried.text
    assert retried.json()["revision"] == 2
    assert e.business.put(C + "/note", json=body).json()["revision"] == 2
    assert e.business.get(C + "/note").json()["blocks"] == body["blocks"]
    assert not e.owner.get(P + "/files", params={"trash": True}).json()["items"]


def test_note_and_clear_backup_follow_storage_migration_and_do_not_expire(environment, monkeypatch):
    e = environment
    image = save(e, b"\x89PNG\r\n\x1a\nimage", kind="image", mime="image/png")
    blocks = [{"type": "text", "text": "长期保存"}, {"type": "image", "item": image["id"]}]
    assert put(e, blocks).status_code == 200
    target = e.path / "destination"
    target.mkdir()
    post(e.owner, P + "/spaces/personal/storage", {"path": str(target)})
    assert e.business.get(C + "/note").json()["blocks"] == blocks
    assert put(e, [], expected=1, action="clear").json()["has_backup"]
    real_now = service.time.time()
    monkeypatch.setattr(service.time, "time", lambda: real_now + service.RETENTION * 2)
    assert e.business.get(C + f"/{image['id']}/content").content.startswith(b"\x89PNG")
    assert put(e, [], expected=2, action="restore").json()["blocks"] == blocks
    post(e.owner, P + "/spaces/personal/storage", {"path": ""})
    assert e.business.get(C + "/note").json()["blocks"] == blocks
    assert (
        e.business.post(
            C + "/manage", json={"action": "trash", "targets": [{"id": image["id"], "expected": 1}]}
        ).status_code
        == 409
    )


def test_bad_reference_limits_and_quota_never_replace_saved_note(environment, monkeypatch):
    e = environment
    original = [{"type": "text", "text": "keep"}]
    assert put(e, original).status_code == 200
    assert put(e, [{"type": "image", "item": uuid.uuid4().hex}], expected=1).status_code == 404
    assert put(e, [{"type": "text", "text": "x" * note.NOTE_LIMIT}], expected=1).status_code == 413
    assert (
        put(e, [{"type": "html", "text": "<img src=http://evil>"}], expected=1).status_code == 422
    )
    monkeypatch.setattr(service, "CLIPBOARD_LIMIT", 1)
    assert put(e, [{"type": "text", "text": "new"}], expected=1).status_code == 413
    assert e.business.get(C + "/note").json()["blocks"] == original


def test_two_devices_cas_one_winner_and_bounded_internal_manifests(environment):
    e = environment

    def edit(n):
        return put(e, [{"type": "text", "text": str(n)}])

    with ThreadPoolExecutor(2) as pool:
        assert sorted(r.status_code for r in pool.map(edit, range(2))) == [200, 409]
    for revision in range(1, 5):
        assert (
            put(e, [{"type": "text", "text": str(revision)}], expected=revision).status_code == 200
        )
    with sqlite3.connect(next((e.path / "business").rglob("clipboard.sqlite3"))) as db:
        assert db.execute("SELECT COUNT(*) FROM clipboard_note_gc").fetchone()[0] == 0
    folder = post(
        e.owner, P + "/app-folders", {"application": "wanx.clipboard", "name": "超级剪贴板"}
    )["id"]
    assert len(e.owner.get(P + "/files", params={"parent": folder}).json()["items"]) == 1


def test_approved_agent_reads_single_note_and_pause_revokes_it(environment):
    e = environment
    assert (
        put(e, [{"type": "text", "text": "Agent can read this synthetic note"}]).status_code == 200
    )
    a = post(e.owner, P + "/connections", {"profile": "note-test", "name": "note-test"})
    headers = {"X-Space-Link": a["token"]}
    assert (
        e.business.post(
            C + "/agent-access",
            headers=headers,
            json={"action": "clipboard-read", "target": "note"},
        )
        .json()["text"]
        .startswith("Agent")
    )
    listing = e.business.post(
        C + "/agent-access", headers=headers, json={"action": "clipboard-list"}
    )
    assert listing.json()["note"]["revision"] == 1
    post(e.owner, P + f"/connections/{a['id']}/manage", {"action": "pause"})
    assert (
        e.business.post(
            C + "/agent-access",
            headers=headers,
            json={"action": "clipboard-read", "target": "note"},
        ).status_code
        == 403
    )
