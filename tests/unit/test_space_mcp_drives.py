import base64
import io
import secrets
import zipfile
from uuid import uuid4

import pytest

from octop.infra.personal_space.agent_hub import checksum
from octop.infra.personal_space.mcp_access import SpaceMcp, memory_import_prompt
from octop.infra.personal_space.service import SpaceError


def connect(service, destination="personal", operation=None, key=None):
    key = key or secrets.token_urlsafe(32)
    body = {
        "operation_id": operation or uuid4().hex,
        "name": "工作助手",
        "credential": key,
        "destination": destination,
    }
    return service.issue(body), key, body


def test_real_disk_root_retry_rotation_pause_and_disconnect(tmp_path, monkeypatch):
    s = SpaceMcp(tmp_path, 1, "Alice")
    c, key, body = connect(s)
    d = c["drive"]
    assert s.issue(body)["drive"] == d
    with s.storage("personal")._db() as db:
        root = s.storage("personal")._entry(db, d["root"])
        assert root["parent"] == "" and root["space_id"] == d["id"] != "personal"
    listing = s.drive_files(c["id"], "list", {})
    assert {i["name"] for i in listing["items"]} == {
        "记忆与上下文",
        "对话记录",
        "文件资料",
        "构建物",
    }
    s.manage_drive(c["id"], "rename", "重命名助手")
    s.manage_drive(c["id"], "pause")
    assert SpaceMcp.lookup(tmp_path, key) is None
    with pytest.raises(SpaceError, match="PAUSED"):
        s.access(c["id"], key)
    assert s.drive_files(c["id"], "list", {})["items"]
    s.manage_drive(c["id"], "resume")
    new = secrets.token_urlsafe(32)
    rotation = {"operation_id": uuid4().hex, "credential": new}
    assert s.rotate(c["id"], rotation)["drive"]["id"] == d["id"]
    assert s.rotate(c["id"], rotation)["drive"]["root"] == d["root"]
    assert SpaceMcp.lookup(tmp_path, key) is None
    assert SpaceMcp.lookup(tmp_path, new)["id"] == c["id"]
    s.revoke_connection(c["id"])
    with pytest.raises(SpaceError, match="REVOKED"):
        s.issue(body)
    assert SpaceMcp.lookup(tmp_path, new) is None
    assert s.drive_files(c["id"], "list", {})["items"]


def test_failed_provision_cannot_activate_key_and_retry_reuses_disk(tmp_path, monkeypatch):
    s = SpaceMcp(tmp_path, 1, "Alice")
    original = s.provision
    observed = []

    def fail_once(aid):
        original(aid)
        observed.append(aid)
        raise OSError("synthetic interrupted initialization")

    monkeypatch.setattr(s, "provision", fail_once)
    body = {
        "operation_id": uuid4().hex,
        "name": "助手",
        "credential": secrets.token_urlsafe(32),
        "destination": "personal",
    }
    with pytest.raises(OSError):
        s.issue(body)
    assert SpaceMcp.lookup(tmp_path, body["credential"]) is None
    monkeypatch.setattr(s, "provision", original)
    result = s.issue(body)
    assert result["id"] == observed[0]
    assert len(s.drives()) == 1


def test_two_members_and_admin_company_read_write_isolation(tmp_path):
    alice, bob, admin = [
        SpaceMcp(tmp_path, i, name, admin=i == 3)
        for i, name in [(1, "Alice"), (2, "Bob"), (3, "Admin")]
    ]
    a, ak, _ = connect(alice, "company")
    b, bk, _ = connect(bob, "company")
    private, _, _ = connect(alice)
    assert {d["id"] for d in bob.drives()} == {a["drive"]["id"], b["drive"]["id"]}
    assert private["drive"]["id"] not in {d["id"] for d in admin.drives()}
    value = alice.write_text(
        a["id"], ak, {"operation_id": uuid4().hex, "text": "company memory", "name": "test.txt"}
    )
    for viewer in (bob, admin):
        assert viewer.drive_files(a["id"], "stat", {"id": value["id"]})["digest"] == checksum(
            "company memory"
        )
    with pytest.raises(SpaceError, match="READ_ONLY"):
        bob.drive_files(a["id"], "mkdir", {"name": "forged"})
    with pytest.raises(SpaceError):
        bob.drive_files(a["id"], "upload-create", {"id": uuid4().hex, "name": "forged", "size": 1})
    admin.drive_files(a["id"], "mkdir", {"name": "admin managed"})
    with pytest.raises(SpaceError):
        bob.operation(b["id"], bk, {"action": "stat", "target": value["id"]})
    with pytest.raises(SpaceError):
        admin.drive_files(private["id"], "list", {})
    # Upload IDs and targets cannot be used to bypass disk boundaries.
    upload = uuid4().hex
    alice.drive_files(a["id"], "upload-create", {"id": upload, "name": "pending.txt", "size": 1})
    with pytest.raises(SpaceError):
        bob.drive_files(
            b["id"],
            "upload-chunk",
            {"id": upload, "offset": 0, "data": "eA==", "digest": checksum(b"x")},
        )
    with pytest.raises(SpaceError):
        alice.drive_files(
            a["id"], "move", {"id": value["id"], "parent": b["drive"]["root"], "name": "moved"}
        )


def test_own_memory_binary_versions_and_extra_revocation(tmp_path):
    s = SpaceMcp(tmp_path, 1, "Alice")
    c, key, _ = connect(s)
    aid, d = c["id"], c["drive"]
    args = {
        "operation_id": uuid4().hex,
        "title": "可访问记忆",
        "source": "合成会话",
        "coverage": "仅测试",
        "sections": [{"title": "偏好", "content": "简洁"}],
    }
    saved = s.archive_memory(aid, key, args)
    assert s.archive_memory(aid, key, args) == saved
    assert saved["file"]["parent"] == d["directories"]["memory"]
    assert "简洁" in s.read_text(aid, key, "", saved["file"]["id"])["text"]
    assert d["directories"]["memory"] in memory_import_prompt(d)
    assert "选择保存" not in memory_import_prompt(d)
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("test.txt", "synthetic")
    for name, raw, folder in [
        (
            "image.png",
            base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
            ),
            "files",
        ),
        ("artifact.zip", archive.getvalue(), "artifacts"),
    ]:
        upload = uuid4().hex
        s.operation(
            aid,
            key,
            {
                "action": "begin-write",
                "upload_id": upload,
                "name": name,
                "size": len(raw),
                "target": d["directories"][folder],
            },
        )
        s.operation(
            aid,
            key,
            {
                "action": "write-chunk",
                "upload_id": upload,
                "offset": 0,
                "data": base64.b64encode(raw).decode(),
                "digest": checksum(raw),
            },
        )
        result = s.operation(
            aid, key, {"action": "commit-write", "upload_id": upload, "digest": checksum(raw)}
        )
        read = s.operation(aid, key, {"action": "read", "target": result["id"], "length": len(raw)})
        assert base64.b64decode(read["data"]) == raw
        assert s.drive_files(aid, "stat", {"id": result["id"]})["space_id"] == d["id"]
    txt = s.write_text(
        aid, key, {"operation_id": uuid4().hex, "name": "version.txt", "text": "old"}
    )
    newer = s.write_text(
        aid,
        key,
        {
            "operation_id": uuid4().hex,
            "target": txt["id"],
            "expected": txt["version"],
            "text": "new",
        },
    )
    assert s.drive_files(aid, "stat", {"id": newer["id"]})["previous_digest"] == checksum("old")
    root = s.storage("personal").mkdir("", "extra")["id"]
    grant = s.authorize(aid, "personal", root, "reference")
    with pytest.raises(SpaceError):
        s.write_text(
            aid,
            key,
            {"grant_id": grant["id"], "operation_id": uuid4().hex, "name": "bad.txt", "text": "no"},
        )
    s.revoke(aid, grant["id"])
    with pytest.raises(SpaceError):
        s.operation(aid, key, {"action": "list", "grant_id": grant["id"]})
    assert s.operation(aid, key, {"action": "list"})
    assert len(SpaceMcp(tmp_path, 1, "Alice").drives()) == 1
