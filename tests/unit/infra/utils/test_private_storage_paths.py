import os
from pathlib import Path

import pytest

from octop.infra.utils.private_paths import is_private_storage_path, is_untrusted_workspace


def test_reserved_files_and_encoded_aliases(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OCTOP_HOME", str(tmp_path / "control"))
    report = tmp_path / "control" / "knowledge" / "library" / "report.md"
    assert is_private_storage_path(report)
    assert is_private_storage_path(report.as_uri())
    assert is_private_storage_path(str(report).replace("knowledge", "KNOWLEDGE"))
    assert is_private_storage_path(str(report).replace("/", "%2F"))
    assert is_private_storage_path(tmp_path / "control" / "octop.db-wal")
    assert is_private_storage_path(tmp_path / "control" / "config.json")
    assert not is_private_storage_path(tmp_path / "own-report.md")
    assert not is_private_storage_path((tmp_path / "own-report.md").as_uri())
    assert is_untrusted_workspace(tmp_path / "control", "CURRENT")
    assert is_untrusted_workspace(tmp_path, "CURRENT")
    assert is_untrusted_workspace(tmp_path / "control/agents/FOREIGN", "CURRENT")
    assert not is_untrusted_workspace(tmp_path / "control/agents/CURRENT", "CURRENT")
    assert not is_untrusted_workspace(tmp_path / "ordinary-project", "CURRENT")


@pytest.mark.skipif(os.name != "posix", reason="symlink fixture needs POSIX")
def test_symlink_cannot_hide_private_storage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OCTOP_HOME", str(tmp_path / "control"))
    target = tmp_path / "control" / "knowledge"
    target.mkdir(parents=True)
    alias = tmp_path / "ordinary-alias"
    alias.symlink_to(target, target_is_directory=True)
    assert is_private_storage_path(alias / "report.md")


@pytest.mark.skipif(os.name != "posix", reason="symlink fixture needs POSIX")
async def test_workspace_facade_checks_real_alias_but_keeps_own_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from deepagents.backends.filesystem import FilesystemBackend
    from octop_harness.backends.workspace import BackendWorkspace

    from octop.infra.backend.private_workspace import PrivateStorageWorkspace
    from octop.infra.errors import OctopError

    monkeypatch.setenv("OCTOP_HOME", str(tmp_path / "control"))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    base = BackendWorkspace(FilesystemBackend(root_dir=tmp_path, virtual_mode=False), workspace)
    await base.aupload_bytes("own.md", b"own workspace file")
    guarded = PrivateStorageWorkspace(base, confined=True)
    assert await guarded.aread_text("own.md") == "own workspace file"
    private = tmp_path / "control" / "knowledge" / "report.md"
    (workspace / "alias.md").symlink_to(private)
    for path in [str(private), "alias.md"]:
        with pytest.raises(OctopError):
            await guarded.aread_text(path)
    with pytest.raises(OctopError):
        await guarded.agrep("private", str(tmp_path))
    with pytest.raises(OctopError):
        await guarded.aglob("../../control/knowledge/**")
