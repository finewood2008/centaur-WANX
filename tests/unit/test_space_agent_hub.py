"""Real storage and authorization tests; no user data or model calls."""

import base64
import secrets
import uuid
from pathlib import Path

import pytest

from octop.infra.personal_space.agent_hub import AgentHub, checksum
from octop.infra.personal_space.service import SpaceError


def connection(hub, destination="company"):
    key = secrets.token_urlsafe(32)
    agent = hub.register(
        {
            "kind": "codex",
            "machine": uuid.uuid4().hex,
            "profile": checksum("profile"),
            "name": "Codex",
            "destination": destination,
            "credential": key,
        }
    )
    project = {"id": checksum("project"), "name": "项目A", "conversations": True, "memory": True}
    hub.configure(
        agent["id"],
        {
            "expected": 0,
            "collection": {"enabled": True, "projects": [project], "userMemory": False},
        },
    )
    return agent["id"], key, project["id"]


def record(project, **changes):
    return {
        "id": "event-1",
        "project": project,
        "category": "conversation",
        "session": "session-A",
        "role": "user",
        "title": "真实会话",
        "text": "只保留所选项目的文本",
        "timestamp": "2026-10-25T09:00:00Z",
        "origin": {"file": "session.jsonl", "line": 2},
        **changes,
    }


def test_company_archives_shared_and_personal_archives_isolated(tmp_path: Path):
    a, b, admin = [
        AgentHub(tmp_path, n, name, admin=n == 3)
        for n, name in [(1, "成员A"), (2, "成员B"), (3, "管理员")]
    ]
    aid, key, pid = connection(a)
    saved = a.ingest(aid, [record(pid)])
    for viewer in [a, b, admin]:
        sources = viewer.archives("company")["sources"]
        assert sources[0]["member"] == "成员A"
        assert sources[0]["projects"][0]["name"] == "项目A"
        assert viewer.record(saved["saved"][0])["text"] == record(pid)["text"]
    private, _, pid = connection(a, "personal")
    private_saved = a.ingest(private, [record(pid)])
    assert b.archives("personal")["sources"] == []
    for viewer in [b, admin]:
        with pytest.raises(SpaceError):
            viewer.record(private_saved["saved"][0])
        with pytest.raises(SpaceError):
            viewer.configure(aid, {"expected": 1, "collection": {}})
        with pytest.raises(SpaceError):
            viewer.invoke(aid, key, {"action": "access"})
    assert a.storage("company").root.name == "company"
    assert a.storage("personal").root.name == "1"


def test_collection_scope_pause_dedupe_and_atomic_batch(tmp_path: Path):
    h = AgentHub(tmp_path, 1, "A")
    aid, _, pid = connection(h)
    one = h.ingest(aid, [record(pid)])
    assert h.ingest(aid, [record(pid)]) == one
    assert h.ingest(aid, [record(pid, origin={"file": "rotated.jsonl", "offset": 0})]) == one
    with pytest.raises(SpaceError, match="AGENT_RECORD_CONFLICT"):
        h.ingest(aid, [record(pid, text="changed")])
    with pytest.raises(SpaceError, match="AGENT_COLLECTION_SCOPE"):
        h.ingest(aid, [record(pid, id="event-2"), record(checksum("unselected"), id="event-3")])
    assert len(h.records(aid, pid)["items"]) == 1
    with pytest.raises(SpaceError):
        h.ingest(aid, [record("global", category="user_memory")])
    h.configure(aid, {"expected": 1, "collection": {"enabled": False, "projects": []}})
    with pytest.raises(SpaceError, match="AGENT_COLLECTION_PAUSED"):
        h.ingest(aid, [record(pid, id="event-2")])
    assert h.archives("company")["sources"][0]["projects"][0]["name"] == "项目A"
    with pytest.raises(SpaceError, match="AGENT_CONFIG_CHANGED"):
        h.configure(aid, {"expected": 0, "collection": {}})


def test_read_only_and_output_writes_cannot_cross_grants(tmp_path: Path):
    h = AgentHub(tmp_path, 1, "A")
    aid, key, pid = connection(h)
    store = h.storage("personal")
    folder = store.mkdir("", "资料")
    output = store.mkdir("", "成果")
    raw = b"source"
    fid = uuid.uuid4().hex
    store.upload_create(folder["id"], "input.txt", len(raw), fid)
    store.upload_chunk(fid, 0, raw, checksum(raw))
    store.upload_complete(fid, checksum(raw))
    read = h.grant(aid, "personal", folder["id"], "read")
    write = h.grant(aid, "personal", output["id"], "write")

    def invoke(action, grant=read["id"], **params):
        return h.invoke(aid, key, {"action": action, "grant_id": grant, **params})

    assert base64.b64decode(invoke("read", target=fid)["data"]) == raw
    for action in [
        "mkdir",
        "begin-write",
        "write-chunk",
        "commit-write",
        "trash",
        "move",
        "restore-version",
    ]:
        with pytest.raises(SpaceError, match="AGENT_READ_ONLY"):
            invoke(action)
    with pytest.raises(SpaceError):
        invoke("read", target=output["id"])
    upload = uuid.uuid4().hex
    content = b"new output"
    invoke("begin-write", grant=write["id"], upload_id=upload, name="result.txt", size=len(content))
    invoke(
        "write-chunk",
        grant=write["id"],
        upload_id=upload,
        offset=0,
        data=base64.b64encode(content).decode(),
        digest=checksum(content),
    )
    file = invoke("commit-write", grant=write["id"], upload_id=upload, digest=checksum(content))
    assert store.read_chunk(file["id"], 0, 100)[0] == content
    for action in ["trash", "move"]:
        with pytest.raises(SpaceError):
            invoke(action, grant=write["id"], target=file["id"])
    h.revoke(aid, read["id"])
    with pytest.raises(SpaceError, match="AGENT_GRANT_DENIED"):
        invoke("read", target=fid)
    # A permission check is repeated at the final commit, not just begin-write.
    pending = uuid.uuid4().hex
    invoke("begin-write", grant=write["id"], upload_id=pending, name="pending.txt", size=0)
    h.revoke(aid, write["id"])
    with pytest.raises(SpaceError):
        invoke("commit-write", grant=write["id"], upload_id=pending, digest=checksum(b""))


def test_company_record_folders_are_read_only_and_disconnect_retains_archives(tmp_path: Path):
    h = AgentHub(tmp_path, 1, "A", admin=True)
    aid, key, pid = connection(h)
    h.ingest(aid, [record(pid)])
    root = h.archives("company")["sources"][0]["projects"][0]["root"]
    with pytest.raises(SpaceError, match="AGENT_ARCHIVE_READ_ONLY"):
        h.grant(aid, "company", root, "write")
    read = h.grant(aid, "company", root, "read")
    assert h.invoke(aid, key, {"action": "list", "grant_id": read["id"]})["items"]
    h.disconnect(aid)
    with pytest.raises(SpaceError):
        h.invoke(aid, key, {"action": "access"})
    assert h.archives("company")["sources"]


def test_downgrade_reconnect_and_legacy_revocation(tmp_path: Path):
    h = AgentHub(tmp_path, 1, "A")
    aid, key, _ = connection(h)
    store = h.storage("personal")
    root = store.mkdir("", "shared")["id"]
    old = store.approve(checksum("legacy"), "Legacy")
    store.grant(old["id"], root)
    legacy_link = store.create_link(root)
    write = h.grant(aid, "personal", root, "write")
    assert h.grant(aid, "personal", root, "write")["id"] == write["id"]
    read = h.grant(aid, "personal", root, "read")
    with pytest.raises(SpaceError, match="AGENT_GRANT_DENIED"):
        h.invoke(aid, key, {"action": "list", "grant_id": write["id"]})
    assert h.invoke(aid, key, {"action": "list", "grant_id": read["id"]})
    assert h.migrate_legacy(aid, "connection", old["id"])["legacyRevoked"]
    with pytest.raises(SpaceError):
        store.agent_execute(old["token"], "access")
    assert h.migrate_legacy(aid, "link", legacy_link["id"])["legacyRevoked"]
    with pytest.raises(SpaceError):
        store.execute(legacy_link["token"], "list")
    with h.db() as db:
        agent = dict(h.agent(db, aid))
    h.disconnect(aid)
    newkey = secrets.token_urlsafe(32)
    reconnected = h.register({**agent, "credential": newkey})
    assert reconnected["id"] == aid
    assert reconnected["collection"] == {}
    with pytest.raises(SpaceError):
        h.invoke(aid, key, {"action": "access"})
    assert h.invoke(aid, newkey, {"action": "access"})["grants"] == []


def test_company_admin_archive_management_fences_existing_grants(tmp_path: Path):
    owner, member, admin = (
        AgentHub(tmp_path, 1, "A"),
        AgentHub(tmp_path, 2, "B"),
        AgentHub(tmp_path, 3, "Admin", admin=True),
    )
    aid, key, pid = connection(owner)
    saved = owner.ingest(aid, [record(pid)])
    root = owner.archives("company")["sources"][0]["projects"][0]["root"]
    grant = owner.grant(aid, "company", root, "read")
    with pytest.raises(SpaceError, match="AGENT_ADMIN_REQUIRED"):
        owner.archive_action(aid, pid, True)
    admin.archive_action(aid, pid, True)
    assert member.archives("company")["sources"] == []
    assert admin.archives("company")["sources"][0]["projects"][0]["hidden"]
    with pytest.raises(SpaceError):
        owner.record(saved["saved"][0])
    with pytest.raises(SpaceError):
        owner.invoke(aid, key, {"action": "list", "grant_id": grant["id"]})
    with pytest.raises(SpaceError, match="AGENT_ARCHIVE_PAUSED"):
        owner.ingest(aid, [record(pid, id="new")])
    admin.archive_action(aid, pid, False)
    assert owner.record(saved["saved"][0])["text"]
    assert owner.invoke(aid, key, {"action": "list", "grant_id": grant["id"]})


def test_company_output_grant_is_rechecked_after_role_downgrade(tmp_path: Path):
    admin = AgentHub(tmp_path, 1, "A", admin=True)
    aid, key, _ = connection(admin)
    root = admin.storage("company").mkdir("", "成果")["id"]
    grant = admin.grant(aid, "company", root, "write")
    downgraded = AgentHub(tmp_path, 1, "A", admin=False)
    assert downgraded.invoke(aid, key, {"action": "access"})["grants"][0]["permission"] == "read"
    with pytest.raises(SpaceError, match="AGENT_ADMIN_REQUIRED"):
        downgraded.invoke(aid, key, {"action": "mkdir", "grant_id": grant["id"], "name": "denied"})
    assert downgraded.invoke(aid, key, {"action": "list", "grant_id": grant["id"]})
