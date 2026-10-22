from __future__ import annotations

import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

from octop.infra.personal_space.service import PersonalSpace, SpaceError, _safe_file


def test_deleted_sqlite_journal_during_lstat_does_not_reject_a_valid_listing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    space = PersonalSpace(tmp_path, 1)
    journal = Path(str(space.database) + "-journal")
    original = Path.lstat
    injected = False

    def racing_lstat(path: Path, *args: object, **kwargs: object) -> object:
        nonlocal injected
        if path == journal and not injected:
            injected = True
            return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_nlink=0)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", racing_lstat)
    assert space.listing()["items"] == []
    assert injected
    assert space.mkdir("", "still writable")["name"] == "still writable"


@pytest.mark.parametrize(
    ("mode", "links"),
    [(stat.S_IFLNK | 0o777, 1), (stat.S_IFREG | 0o600, 2), (stat.S_IFDIR | 0o700, 1)],
)
def test_unlinked_file_recheck_still_rejects_a_replacement_link_or_unsafe_type(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: int, links: int
) -> None:
    target = tmp_path / "index.sqlite3-journal"
    observed = iter(
        [
            SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_nlink=0),
            SimpleNamespace(st_mode=mode, st_nlink=links),
        ]
    )
    monkeypatch.setattr(Path, "lstat", lambda *args, **kwargs: next(observed))
    with pytest.raises(SpaceError, match="SPACE_UNSAFE_STORAGE"):
        _safe_file(target, missing=True)


def test_required_unlinked_content_never_gets_the_optional_journal_exception(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        Path, "lstat", lambda *args, **kwargs: SimpleNamespace(st_mode=stat.S_IFREG, st_nlink=0)
    )
    with pytest.raises(SpaceError, match="SPACE_UNSAFE_STORAGE"):
        _safe_file(tmp_path / "required-content")
