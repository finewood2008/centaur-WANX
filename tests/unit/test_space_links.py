from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

import pytest

from octop.infra.personal_space.links import SpaceLinks
from octop.infra.personal_space.service import PersonalSpace, SpaceError
from tests.unit.test_personal_space import upload


def write(
    s: SpaceLinks,
    token: str,
    target: str,
    data: bytes,
    expected: int | None = None,
    name: str = "result.txt",
) -> dict:
    uid = uuid.uuid4().hex
    s.execute(
        token,
        "begin-write",
        target=target,
        upload_id=uid,
        size=len(data),
        expected=expected,
        name=name,
    )
    if data:
        s.execute(
            token, "write-chunk", upload_id=uid, data=data, digest=hashlib.sha256(data).hexdigest()
        )
    return s.execute(token, "commit-write", upload_id=uid, digest=hashlib.sha256(data).hexdigest())


def test_links_scope_dynamic_descendants_and_account_isolation(tmp_path: Path) -> None:
    s = SpaceLinks(tmp_path, 1)
    folder = s.mkdir("", "allowed")["id"]
    token = s.create_link(folder)["token"]
    outside = upload(s, b"secret")["id"]
    for action in ("stat", "read", "trash", "move", "begin-write"):
        with pytest.raises(SpaceError, match="SPACE_LINK_SCOPE"):
            s.execute(token, action, target=outside)
    child = s.execute(token, "mkdir", name="nested")["id"]
    file = write(s, token, child, b"hello")
    assert s.execute(token, "read", target=file["id"])[0] == b"hello"
    s.move(file["id"], "", file["name"])
    with pytest.raises(SpaceError, match="SPACE_LINK_SCOPE"):
        s.execute(token, "read", target=file["id"])
    with pytest.raises(SpaceError, match="SPACE_LINK_REVOKED"):
        SpaceLinks(tmp_path, 2).execute(token, "describe")
    assert s.execute(token, "describe")["parent"] == ""
    assert "token_hash" not in s.links()[0]


def test_file_link_rename_replace_version_restore_and_restart(tmp_path: Path) -> None:
    s = SpaceLinks(tmp_path, 1)
    original = upload(s, b"old")
    token = s.create_link(original["id"])["token"]
    renamed = s.execute(token, "move", name="renamed.txt", expected=1)
    with pytest.raises(SpaceError, match="SPACE_VERSION_CONFLICT"):
        write(s, token, original["id"], b"stale", 1)
    changed = write(s, token, original["id"], b"new", renamed["version"])
    assert changed["id"] == original["id"]
    assert len(s.listing()["items"]) == 1
    owner = PersonalSpace(tmp_path, 1)
    assert owner.read_chunk(original["id"], 0, 100)[0] == b"new"
    assert owner.overview()["filesBytes"] == 6
    restarted = SpaceLinks(tmp_path, 1)
    restored = restarted.execute(token, "restore-version", expected=changed["version"])
    assert restarted.execute(token, "read", expected=restored["version"])[0] == b"old"
    with pytest.raises(SpaceError):
        s.execute(token, "list")
    with pytest.raises(SpaceError):
        s.execute(token, "mkdir", name="sibling")
    other = s.mkdir("", "other")
    with pytest.raises(SpaceError, match="SPACE_LINK_SCOPE"):
        s.execute(token, "move", parent=other["id"], name="x", expected=restored["version"])


def test_revoke_expiry_and_scope_rechecked_at_commit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = SpaceLinks(tmp_path, 1)
    folder = s.mkdir("", "f")["id"]
    file = upload(s, b"old", parent=folder)
    link = s.create_link(folder)
    uid = uuid.uuid4().hex
    s.execute(link["token"], "begin-write", target=file["id"], upload_id=uid, size=3, expected=1)
    s.execute(
        link["token"],
        "write-chunk",
        upload_id=uid,
        data=b"new",
        digest=hashlib.sha256(b"new").hexdigest(),
    )
    s.move(file["id"], "", "moved")
    with pytest.raises(SpaceError, match="SPACE_LINK_SCOPE"):
        s.execute(
            link["token"], "commit-write", upload_id=uid, digest=hashlib.sha256(b"new").hexdigest()
        )
    assert s.read_chunk(file["id"], 0, 100)[0] == b"old"
    s.revoke(link["id"])
    with pytest.raises(SpaceError, match="SPACE_LINK_REVOKED"):
        s.execute(link["token"], "describe")
    monkeypatch.setattr("octop.infra.personal_space.links.time.time", lambda: 100)
    link = s.create_link(folder, 101)
    monkeypatch.setattr("octop.infra.personal_space.links.time.time", lambda: 102)
    with pytest.raises(SpaceError, match="SPACE_LINK_EXPIRED"):
        s.execute(link["token"], "describe")


def test_incomplete_bad_digest_and_concurrent_write_preserve_original(tmp_path: Path) -> None:
    s = SpaceLinks(tmp_path, 1)
    file = upload(s, b"old")
    token = s.create_link(file["id"])["token"]
    uid = uuid.uuid4().hex
    s.execute(token, "begin-write", upload_id=uid, size=3, expected=1)
    with pytest.raises(SpaceError, match="SPACE_UPLOAD_INCOMPLETE"):
        s.execute(token, "commit-write", upload_id=uid, digest=hashlib.sha256(b"new").hexdigest())
    s.execute(
        token, "write-chunk", upload_id=uid, data=b"new", digest=hashlib.sha256(b"new").hexdigest()
    )
    with pytest.raises(SpaceError, match="SPACE_CHUNK_INVALID"):
        s.execute(token, "commit-write", upload_id=uid, digest="0" * 64)
    assert s.read_chunk(file["id"], 0, 100)[0] == b"old"
    write(s, token, file["id"], b"winner", 1)
    with pytest.raises(SpaceError, match="SPACE_VERSION_CONFLICT"):
        s.execute(token, "commit-write", upload_id=uid, digest=hashlib.sha256(b"new").hexdigest())
    assert s.read_chunk(file["id"], 0, 100)[0] == b"winner"


def test_folder_pagination_moves_trash_restore_and_audit(tmp_path: Path) -> None:
    s = SpaceLinks(tmp_path, 1)
    folder = s.mkdir("", "f")["id"]
    link = s.create_link(folder)
    token = link["token"]
    file = write(s, token, folder, b"first")
    child = s.execute(token, "mkdir", name="child")
    page = s.execute(token, "list", length=1)
    assert len(page["items"]) == 1 and page["next"] == 1
    file = s.execute(
        token, "move", target=file["id"], parent=child["id"], name=file["name"], expected=1
    )
    s.execute(token, "trash", target=file["id"], expected=file["version"])
    with pytest.raises(SpaceError, match="SPACE_NOT_FOUND"):
        s.execute(token, "read", target=file["id"])
    restored = s.execute(token, "restore", target=file["id"], expected=file["version"] + 1)
    assert restored["parent"] == child["id"]
    assert any(r["action"] == "restore" and r["result"] == "ok" for r in s.audit(link["id"]))
    s.trash(folder)
    with pytest.raises(SpaceError, match="SPACE_NOT_FOUND"):
        s.execute(token, "describe")


def test_write_cannot_reuse_existing_upload_and_traversal_rejected(tmp_path: Path) -> None:
    s = SpaceLinks(tmp_path, 1)
    file = upload(s, b"original")
    token = s.create_link(file["id"])["token"]
    with pytest.raises(SpaceError, match="SPACE_UPLOAD_CONFLICT"):
        s.execute(token, "begin-write", upload_id=file["id"], expected=1, size=8)
    with pytest.raises(SpaceError):
        s.execute(token, "stat", target="../other")
    assert s.read_chunk(file["id"], 0, 100)[0] == b"original"


def test_previous_version_retention_and_disk_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import errno

    s = SpaceLinks(tmp_path, 1)
    f = upload(s, b"one")
    token = s.create_link(f["id"])["token"]
    f = write(s, token, f["id"], b"two", f["version"])
    f = write(s, token, f["id"], b"three", f["version"])
    assert s.overview()["filesBytes"] == len(b"two") + len(b"three")
    assert len(list(s.objects.glob("*.blob"))) == 2
    original_open = s._open

    def full(*args: object, **kwargs: object):
        if kwargs.get("write"):
            raise OSError(errno.ENOSPC, "synthetic disk full")
        return original_open(*args, **kwargs)

    monkeypatch.setattr(s, "_open", full)
    with pytest.raises(OSError):
        write(s, token, f["id"], b"not published", f["version"])
    assert s.read_chunk(f["id"], 0, 100)[0] == b"three"
    monkeypatch.setattr(s, "_open", original_open)
    s.trash(f["id"])
    s.purge(f["id"])
    assert s.overview()["filesBytes"] == 0
    assert not list(s.objects.glob("*.blob"))
