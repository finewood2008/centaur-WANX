import hashlib
import uuid

import pytest

from octop.infra.personal_space.local_scope import ClipboardSpace
from octop.infra.personal_space.service import SpaceError
from octop.infra.personal_space.workspaces import Workspaces


def identifier():
    return uuid.uuid4().hex


@pytest.fixture
def spaces(tmp_path):
    ordinary = Workspaces(tmp_path, 1)
    clipboard = ClipboardSpace(
        tmp_path,
        1,
        clipboard_scope={"application": "wanx.clipboard", "exportId": None, "parent": None},
        live=lambda: None,
    )
    folder = clipboard.app_folder("wanx.clipboard", "超级剪贴板")["id"]
    return ordinary, clipboard, folder


def put(space, parent, content=b"private note"):
    file = identifier()
    space.upload_create(parent, file + ".txt", len(content), file)
    space.upload_chunk(file, 0, content, hashlib.sha256(content).hexdigest())
    space.upload_complete(file, hashlib.sha256(content).hexdigest())
    return file


def test_clipboard_crud_and_principal_private_storage(spaces, tmp_path):
    ordinary, clipboard, folder = spaces
    file = put(clipboard, folder)
    assert clipboard.read_chunk(file, 0, 1024)[0] == b"private note"
    clipboard.trash(file)
    other = ClipboardSpace(
        tmp_path, 2, clipboard_scope=clipboard.clipboard_scope, live=lambda: None
    )
    with pytest.raises(SpaceError):
        other.metadata(file)


def test_child_cannot_read_mutate_or_upload_outside_application(spaces):
    ordinary, clipboard, folder = spaces
    outside = put(ordinary, "")
    for operation in (
        lambda: clipboard.metadata(outside),
        lambda: clipboard.read_chunk(outside, 0, 1024),
        lambda: clipboard.trash(outside),
        lambda: clipboard.upload_create("", "bad.txt", 1, identifier()),
        lambda: clipboard.app_folder("other-app", "Other"),
    ):
        with pytest.raises(SpaceError) as error:
            operation()
        assert error.value.code == "SPACE_LINK_SCOPE"
    assert ordinary.metadata(outside)["size"] == len(b"private note")


def test_move_after_listing_is_checked_again_inside_write_transaction(spaces):
    ordinary, clipboard, folder = spaces
    file = put(clipboard, folder)
    assert clipboard.metadata(file)["parent"] == folder
    ordinary.move(file, "", "moved.txt")
    with pytest.raises(SpaceError):
        clipboard.trash(file)
    assert ordinary.metadata(file)["name"] == "moved.txt"


def test_export_only_fixed_new_id_and_target(spaces, tmp_path):
    ordinary, clipboard, folder = spaces
    target = ordinary.mkdir("", "Export")["id"]
    file = identifier()
    scoped = ClipboardSpace(
        tmp_path,
        1,
        clipboard_scope={"application": "wanx.clipboard", "exportId": file, "parent": target},
        live=lambda: None,
    )
    with pytest.raises(SpaceError) as missing:
        scoped.metadata(file)
    assert missing.value.code == "SPACE_NOT_FOUND"
    body = b"exported"
    scoped.upload_create(target, "note.txt", len(body), file)
    scoped.upload_chunk(file, 0, body, hashlib.sha256(body).hexdigest())
    scoped.upload_complete(file, hashlib.sha256(body).hexdigest())
    assert ordinary.read_chunk(file, 0, 100)[0] == body
    with pytest.raises(SpaceError):
        scoped.metadata(file)
    with pytest.raises(SpaceError):
        scoped.upload_create(target, "other.txt", 1, identifier())


def test_export_cannot_adopt_an_existing_personal_upload(spaces, tmp_path):
    ordinary, _, _ = spaces
    file = identifier()
    ordinary.upload_create("", "user.txt", 5, file)
    scoped = ClipboardSpace(
        tmp_path,
        1,
        clipboard_scope={"application": "wanx.clipboard", "exportId": file, "parent": ""},
        live=lambda: None,
    )
    with pytest.raises(SpaceError):
        scoped.upload_create("", "user.txt", 5, file)
    with pytest.raises(SpaceError):
        scoped.upload_chunk(file, 0, b"other", hashlib.sha256(b"other").hexdigest())
    assert ordinary.upload_status(file)["offset"] == 0
