"""Space boundaries are tested at the transaction service, not only the UI."""

import hashlib
import uuid

import pytest

from octop.infra.personal_space.service import PersonalSpace, SpaceError
from octop.infra.personal_space.workspaces import Workspaces


def write(s, token, target, text=b"small", grant_id="", expected=None):
    upload = uuid.uuid4().hex
    s.agent_execute(
        token,
        "begin-write",
        grant_id,
        target=target,
        name="result.txt",
        upload_id=upload,
        size=len(text),
        expected=expected,
    )
    s.agent_execute(
        token,
        "write-chunk",
        grant_id,
        upload_id=upload,
        data=text,
        digest=hashlib.sha256(text).hexdigest(),
    )
    return s.agent_execute(
        token, "commit-write", grant_id, upload_id=upload, digest=hashlib.sha256(text).hexdigest()
    )


def test_legacy_migration_and_two_independent_agents(tmp_path):
    old = PersonalSpace(tmp_path, 1)
    folder = old.mkdir("", "existing")
    s = Workspaces(tmp_path, 1)
    a = s.approve("profile-a", "Same name")
    b = s.approve("profile-b", "Same name")
    assert a["space_id"] != b["space_id"]
    assert [r["id"] for r in s.listing()["items"]] == [folder["id"]]
    assert s.listing(space_id=a["space_id"])["items"] == []
    f = write(s, a["token"], a["root"])
    assert f["space_id"] == a["space_id"]
    for target in (folder["id"], b["root"]):
        with pytest.raises(SpaceError, match="SPACE_LINK_SCOPE"):
            s.agent_execute(a["token"], "stat", target=target)
    with pytest.raises(SpaceError, match="SPACE_AGENT_DISCONNECTED"):
        Workspaces(tmp_path, 2).agent_execute(a["token"], "stat")
    with pytest.raises(SpaceError, match="SPACE_ALREADY_CONNECTED"):
        s.approve("profile-a", "Changed name")
    assert Workspaces(tmp_path, 1).agent_execute(a["token"], "stat")["id"] == a["root"]


def test_pause_revoke_and_recycle_stop_write_commit(tmp_path):
    s = Workspaces(tmp_path, 1)
    a = s.approve("a", "Agent")
    f = write(s, a["token"], a["root"])
    pending = uuid.uuid4().hex
    s.agent_execute(
        a["token"], "begin-write", target=f["id"], expected=f["version"], upload_id=pending, size=0
    )
    s.connection_action(a["id"], "pause")
    with pytest.raises(SpaceError, match="SPACE_AGENT_PAUSED"):
        s.agent_execute(
            a["token"], "commit-write", upload_id=pending, digest=hashlib.sha256(b"").hexdigest()
        )
    s.connection_action(a["id"], "resume")
    assert s.agent_execute(a["token"], "stat", target=f["id"])["size"] == 5
    s.manage_space(a["space_id"], "trash")
    with pytest.raises(SpaceError):
        s.agent_execute(a["token"], "stat")
    s.manage_space(a["space_id"], "restore")
    with pytest.raises(SpaceError):
        s.agent_execute(a["token"], "stat")
    fresh = s.approve("a", "Agent", a["space_id"])
    assert fresh["root"] == a["root"] and fresh["token"] != a["token"]
    assert len(s.listing(space_id=a["space_id"])["items"]) == 1


def test_extra_grants_and_cross_space_moves_do_not_expand_access(tmp_path):
    s = Workspaces(tmp_path, 1)
    a = s.approve("a", "A")
    b = s.approve("b", "B")
    folder = s.mkdir("", "Materials")
    grant = s.grant(a["id"], folder["id"])
    f = write(s, a["token"], folder["id"], grant_id=grant["id"])
    with pytest.raises(SpaceError):
        s.agent_execute(a["token"], "stat", target=f["id"])
    with pytest.raises(SpaceError):
        s.agent_execute(
            a["token"],
            "move",
            grant["id"],
            target=f["id"],
            parent=a["root"],
            name="escape",
            expected=f["version"],
        )
    moved = s.transfer(folder["id"], "", b["space_id"])
    assert moved["space_id"] == b["space_id"]
    with pytest.raises(SpaceError):
        s.agent_execute(a["token"], "stat", grant["id"], target=f["id"])
    assert s.agent_execute(b["token"], "stat", target=f["id"])["space_id"] == b["space_id"]
    s.transfer(folder["id"], "", "personal")
    with pytest.raises(SpaceError):
        s.agent_execute(a["token"], "stat", grant["id"], target=f["id"])


def test_owner_copy_and_application_directory_compatibility(tmp_path):
    s = Workspaces(tmp_path, 1)
    a = s.approve("a", "A")
    folder = s.mkdir(a["root"], "Nested")
    f = write(s, a["token"], folder["id"])
    clone = s.transfer(folder["id"], "", "personal", True)
    copied = s.listing(clone["id"])["items"][0]
    assert copied["id"] != f["id"] and copied["digest"] == f["digest"]
    assert s.agent_execute(a["token"], "stat", target=f["id"])["id"] == f["id"]
    first = s.app_folder("test-app", "App")
    assert s.app_folder("test-app", "New label")["id"] == first["id"]
    s.move(first["id"], "", "Renamed")
    assert s.app_folder("test-app", "App")["id"] == first["id"]
    s.trash(first["id"])
    assert s.app_folder("test-app", "App")["id"] != first["id"]
    with pytest.raises(SpaceError, match="SPACE_MANAGED_ROOT"):
        s.agent_execute(a["token"], "trash", expected=1)


def test_atomic_revision_in_agent_space_and_revoked_staging(tmp_path):
    s = Workspaces(tmp_path, 1)
    a = s.approve("a", "A")
    f = write(s, a["token"], a["root"])
    newer = write(s, a["token"], f["id"], b"new", expected=f["version"])
    assert newer["id"] == f["id"] and newer["previous_size"] == 5
    with pytest.raises(SpaceError, match="SPACE_VERSION_CONFLICT"):
        write(s, a["token"], f["id"], expected=f["version"])
    assert s.spaces()[1]["bytes"] == 8
    personal = s.mkdir("", "extra")
    grant = s.grant(a["id"], personal["id"])
    pending = uuid.uuid4().hex
    s.agent_execute(
        a["token"],
        "begin-write",
        grant["id"],
        target=personal["id"],
        upload_id=pending,
        name="x",
        size=0,
    )
    s.revoke_grant(a["id"], grant["id"])
    with pytest.raises(SpaceError):
        s.agent_execute(
            a["token"],
            "commit-write",
            grant["id"],
            upload_id=pending,
            digest=hashlib.sha256(b"").hexdigest(),
        )
    assert s.listing(personal["id"])["items"] == []
