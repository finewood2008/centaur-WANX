from __future__ import annotations

import hashlib
import os
import uuid
from pathlib import Path

import pytest

from octop.infra.personal_space.service import CHUNK_SIZE, PersonalSpace, SpaceError


def upload(space: PersonalSpace, data: bytes, name: str = "hello.txt", parent: str = "") -> dict:
    item_id = uuid.uuid4().hex
    space.upload_create(parent, name, len(data), item_id)
    for offset in range(0, len(data), CHUNK_SIZE):
        chunk = data[offset : offset + CHUNK_SIZE]
        space.upload_chunk(item_id, offset, chunk, hashlib.sha256(chunk).hexdigest())
    return space.upload_complete(item_id, hashlib.sha256(data).hexdigest())


def test_private_space_never_uses_a_user_path(tmp_path: Path) -> None:
    first, second = PersonalSpace(tmp_path, 1), PersonalSpace(tmp_path, 2)
    entry = upload(first, b"secret")
    for operation in [second.metadata, second.trash, second.restore, second.purge]:
        with pytest.raises(SpaceError, match="SPACE_NOT_FOUND"):
            operation(entry["id"])
    with pytest.raises(SpaceError, match="SPACE_NOT_FOUND"):
        second.read_chunk(entry["id"], 0, 10)
    for name in ["../secret", "a/b", "a\\b", "..", "", "\x00name"]:
        with pytest.raises(SpaceError, match="SPACE_INVALID_NAME"):
            first.mkdir("", name)
    with pytest.raises(SpaceError):
        first.upload_create("", "x", 0, "../other")
    assert second.listing()["items"] == []


def test_folders_move_recycle_and_restore_preserve_conflicts(tmp_path: Path) -> None:
    space = PersonalSpace(tmp_path, 1)
    folder = space.mkdir("", "Projects")
    nested = space.mkdir(folder["id"], "notes")
    entry = upload(space, b"hello", parent=nested["id"])
    with pytest.raises(SpaceError, match="SPACE_INVALID_DESTINATION"):
        space.move(folder["id"], nested["id"], "recursive")
    assert len(space.listing(nested["id"])["breadcrumbs"]) == 2
    space.trash(folder["id"])
    with pytest.raises(SpaceError, match="SPACE_NOT_FOUND"):
        space.read_chunk(entry["id"], 0, 10)
    space.mkdir("", "Projects")
    restored = space.restore(folder["id"])
    assert restored["name"] == "Projects (1)"
    assert space.read_chunk(entry["id"], 0, 10)[0] == b"hello"
    space.trash(folder["id"])
    space.purge(folder["id"])
    assert not space._object(entry["id"]).exists()
    assert space.listing(trash=True)["items"] == []


def test_large_upload_recovers_uncommitted_chunk_and_stays_invisible(tmp_path: Path) -> None:
    space = PersonalSpace(tmp_path, 1)
    item_id = uuid.uuid4().hex
    data = b"a" * CHUNK_SIZE
    size = 9 * CHUNK_SIZE
    space.upload_create("", "large.bin", size, item_id)
    space.upload_chunk(item_id, 0, data, hashlib.sha256(data).hexdigest())
    # Simulate interruption after disk write and before recording the offset.
    with space._open(item_id, partial=True, write=True) as handle:
        handle.seek(CHUNK_SIZE)
        handle.write(b"uncommitted")
    restarted = PersonalSpace(tmp_path, 1)
    assert restarted.listing()["items"] == []
    assert restarted.upload_status(item_id)["offset"] == CHUNK_SIZE
    assert restarted.upload_create("", "large.bin", size, item_id)["offset"] == CHUNK_SIZE
    with pytest.raises(SpaceError, match="SPACE_UPLOAD_INCOMPLETE"):
        restarted.upload_complete(item_id, "0" * 64)
    for index in range(1, 9):
        restarted.upload_chunk(item_id, index * CHUNK_SIZE, data, hashlib.sha256(data).hexdigest())
    digest = hashlib.sha256()
    for _ in range(9):
        digest.update(data)
    entry = restarted.upload_complete(item_id, digest.hexdigest())
    assert entry["size"] == size
    assert restarted.upload_complete(item_id, digest.hexdigest()) == entry
    assert restarted.read_chunk(item_id, 8 * CHUNK_SIZE, CHUNK_SIZE)[0] == data
    assert restarted.overview()["filesBytes"] == size


def test_upload_checksums_offsets_cancel_empty_and_duplicate_names(tmp_path: Path) -> None:
    space = PersonalSpace(tmp_path, 1)
    item_id = uuid.uuid4().hex
    space.upload_create("", "hello.txt", 3, item_id)
    with pytest.raises(SpaceError, match="SPACE_CHUNK_INVALID"):
        space.upload_chunk(item_id, 0, b"abc", "0" * 64)
    with pytest.raises(SpaceError, match="SPACE_UPLOAD_OFFSET"):
        space.upload_chunk(item_id, 1, b"abc", hashlib.sha256(b"abc").hexdigest())
    space.upload_chunk(item_id, 0, b"abc", hashlib.sha256(b"abc").hexdigest())
    with pytest.raises(SpaceError, match="SPACE_CHUNK_INVALID"):
        space.upload_complete(item_id, "0" * 64)
    assert space.listing()["items"] == []
    space.upload_cancel(item_id)
    assert not space._object(item_id).exists()
    assert upload(space, b"")["size"] == 0
    assert upload(space, b"abc")["name"] == "hello (1).txt"


@pytest.mark.skipif(os.name != "posix", reason="POSIX symlink/hardlink behavior")
def test_rejects_symlinks_and_hardlinks(tmp_path: Path) -> None:
    space = PersonalSpace(tmp_path / "data", 1)
    entry = upload(space, b"secret")
    external = tmp_path / "external"
    external.write_bytes(b"outside")
    target = space._object(entry["id"])
    target.unlink()
    target.symlink_to(external)
    with pytest.raises(SpaceError, match="SPACE_UNSAFE_STORAGE"):
        space.read_chunk(entry["id"], 0, 10)
    target.unlink()
    os.link(external, target)
    with pytest.raises(SpaceError, match="SPACE_UNSAFE_STORAGE"):
        space.read_chunk(entry["id"], 0, 10)
    space.trash(entry["id"])
    space.purge(entry["id"])
    assert external.read_bytes() == b"outside"
    linked = tmp_path / "linked"
    linked.symlink_to(tmp_path / "data", target_is_directory=True)
    with pytest.raises(SpaceError, match="SPACE_UNSAFE_STORAGE"):
        PersonalSpace(linked, 1)


def test_disk_full_does_not_publish_or_advance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import shutil
    from collections import namedtuple

    space = PersonalSpace(tmp_path, 1)
    item_id = uuid.uuid4().hex
    space.upload_create("", "file", 3, item_id)
    disk = namedtuple("Disk", "total used free")
    monkeypatch.setattr(shutil, "disk_usage", lambda _: disk(100, 100, 0))
    with pytest.raises(SpaceError, match="SPACE_DISK_FULL"):
        space.upload_chunk(item_id, 0, b"abc", hashlib.sha256(b"abc").hexdigest())
    assert space.upload_status(item_id)["offset"] == 0
    assert space.listing()["items"] == []


def test_container_does_not_report_host_memory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OCTOP_IN_CONTAINER", "1")
    overview = PersonalSpace(tmp_path, 1).overview()
    assert overview["memory"] is None
    assert overview["cpu"] is None
    assert overview["volume"]["scope"] == "personal-files-volume"


def test_generic_workspace_and_download_paths_cannot_bypass_personal_files(tmp_path: Path) -> None:
    from octop.api.routers.workspace import _workspace_io_path
    from octop.infra.errors import OctopError
    from octop.infra.gateway.media.backend_files import is_allowed_host_download_abs_path
    from octop.infra.utils.host_dirs import assert_safe_host_path

    private = tmp_path / ".wanx-personal-space" / "2" / "objects" / "private.blob"
    private.parent.mkdir(parents=True)
    private.write_bytes(b"private")
    for value in [str(private), private.as_uri()]:
        with pytest.raises(OctopError):
            _workspace_io_path(value)
        assert not is_allowed_host_download_abs_path(value, workspace=tmp_path)
    with pytest.raises(ValueError):
        assert_safe_host_path(str(private.parent))
