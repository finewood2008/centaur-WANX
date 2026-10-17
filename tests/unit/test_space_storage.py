import hashlib
import uuid
from pathlib import Path

import pytest

from octop.infra.personal_space import storage
from octop.infra.personal_space.service import PersonalSpace, SpaceError
from octop.infra.personal_space.workspaces import Workspaces


def write(service, connection, content, target=None, expected=None):
    upload = uuid.uuid4().hex
    service.agent_execute(
        connection["token"],
        "begin-write",
        target=target or connection["root"],
        name="sample.txt",
        size=len(content),
        upload_id=upload,
        expected=expected,
    )
    service.agent_execute(
        connection["token"],
        "write-chunk",
        upload_id=upload,
        data=content,
        digest=hashlib.sha256(content).hexdigest(),
    )
    return service.agent_execute(
        connection["token"],
        "commit-write",
        upload_id=upload,
        digest=hashlib.sha256(content).hexdigest(),
    )


def test_migration_preserves_ids_versions_links_trash_and_pending_upload(tmp_path):
    s = Workspaces(tmp_path / "index", 1)
    a = s.approve("a", "A")
    first = write(s, a, b"previous")
    current = write(s, a, b"current", first["id"], first["version"])
    link = s.create_link(first["id"])
    deleted = write(s, a, b"trash")
    s.trash(deleted["id"])
    pending = uuid.uuid4().hex
    s.upload_create(a["root"], "pending.txt", 5, pending)
    s.upload_chunk(pending, 0, b"abc", hashlib.sha256(b"abc").hexdigest())
    base = tmp_path / "volume"
    base.mkdir()
    (base / "unrelated.txt").write_text("untouched")
    before = s.metadata(first["id"])
    old_paths = list(s.objects.glob("*"))
    location = s.storage_location(a["space_id"], str(base))
    directory = Path(location["directory"])
    assert directory.is_relative_to(base) and location["available"]
    assert s.metadata(first["id"]) == before
    assert s.execute(link["token"], "read")[0] == b"current"
    assert s.agent_execute(a["token"], "read", target=first["id"])[0] == b"current"
    assert all(not p.exists() for p in old_paths)
    legacy = PersonalSpace(tmp_path / "index", 1)
    assert legacy.read_chunk(first["id"], 0, 100)[0] == b"current"
    legacy.upload_chunk(pending, 3, b"de", hashlib.sha256(b"de").hexdigest())
    legacy.upload_complete(pending, hashlib.sha256(b"abcde").hexdigest())
    assert legacy.read_chunk(pending, 0, 100)[0] == b"abcde"
    s.restore(deleted["id"])
    assert s.read_chunk(deleted["id"], 0, 100)[0] == b"trash"
    s.restore_version(first["id"], current["version"])
    assert s.read_chunk(first["id"], 0, 100)[0] == b"previous"
    extra = write(s, a, b"new location")
    assert s._object(extra["id"]).parent == directory
    assert (base / "unrelated.txt").read_text() == "untouched"
    restored = s.storage_location(a["space_id"], "")
    assert restored["path"] == "" and s.read_chunk(extra["id"], 0, 100)[0] == b"new location"
    assert not list(directory.glob("*.blob"))


def test_failed_copy_keeps_old_location_and_content(tmp_path, monkeypatch):
    s = Workspaces(tmp_path / "index", 1)
    a = s.approve("a", "A")
    file = write(s, a, b"safe")
    base = tmp_path / "volume"
    base.mkdir()

    def fail(reader, writer, length):
        writer.write(b"partial")
        raise OSError("simulated disk full")

    monkeypatch.setattr(storage.shutil, "copyfileobj", fail)
    with pytest.raises(OSError, match="disk full"):
        s.storage_location(a["space_id"], str(base))
    assert s.read_chunk(file["id"], 0, 100)[0] == b"safe"
    assert s.spaces()[1]["storage"]["path"] == ""
    assert not list(base.rglob("*.blob"))
    assert not list(base.rglob(".migrating-*"))


def test_cross_space_move_and_copy_use_destination_storage(tmp_path):
    s = Workspaces(tmp_path / "index", 1)
    a, b = s.approve("a", "A"), s.approve("b", "B")
    base = tmp_path / "volume"
    base.mkdir()
    target = Path(s.storage_location(b["space_id"], str(base))["directory"])
    file = write(s, a, b"move")
    copied = s.transfer(file["id"], "", b["space_id"], True)
    assert s._object(copied["id"]).parent == target
    source = s._object(file["id"])
    s.transfer(file["id"], "", b["space_id"])
    assert not source.exists()
    assert s._object(file["id"]).parent == target
    assert s.agent_execute(b["token"], "read", target=file["id"])[0] == b"move"
    with pytest.raises(SpaceError, match="SPACE_LINK_SCOPE"):
        s.agent_execute(a["token"], "read", target=file["id"])
    s.transfer(file["id"], "", a["space_id"])
    assert s._object(file["id"]).parent == s.objects
    assert s.read_chunk(copied["id"], 0, 100)[0] == b"move"


def test_paths_and_missing_volume_fail_closed(tmp_path):
    s = Workspaces(tmp_path / "index", 1)
    a = s.approve("a", "A")
    file = write(s, a, b"safe")
    for invalid in ("relative", str(tmp_path / "missing"), str(s.root)):
        with pytest.raises(SpaceError, match="SPACE_STORAGE_PATH_INVALID"):
            s.storage_location(a["space_id"], invalid)
    base = tmp_path / "volume"
    base.mkdir()
    directory = Path(s.storage_location(a["space_id"], str(base))["directory"])
    directory.rename(directory.with_name("offline"))
    assert not s.spaces()[1]["storage"]["available"]
    with pytest.raises(SpaceError, match="SPACE_STORAGE_UNAVAILABLE"):
        s.read_chunk(file["id"], 0, 100)
    with pytest.raises(SpaceError, match="SPACE_ACTION_INVALID"):
        s.agent_execute(a["token"], "storage-set")
