import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from wanx_clipboard import __main__ as cli
from wanx_clipboard.app import create_app


def test_os_required_marker_rejects_legacy_before_business_storage(tmp_path, monkeypatch):
    import centuarai_local_data_gate as gate

    monkeypatch.setattr(gate, "load_required_policy", lambda: {"boxId": "box", "gatewayId": "gateway"})
    with pytest.raises(ValueError, match="mode must be required"):
        create_app(tmp_path / "business", "http://native")
    assert not (tmp_path / "business").exists()


def test_gate_configuration_failure_never_launches_http(tmp_path, monkeypatch):
    import centuarai_local_data_gate as gate

    launched = []
    monkeypatch.setattr(cli, "prepare_native_staging", lambda: tmp_path)
    monkeypatch.setattr(gate.GateConfig, "load", lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("invalid fixture config")))
    monkeypatch.setattr(cli.uvicorn, "run", lambda *args, **kwargs: launched.append(True))
    monkeypatch.setattr("sys.argv", ["wanx-clipboard", "--upstream", "http://127.0.0.1:8080", "--data", str(tmp_path / "business"),
        "--local-data-mode", "required", "--local-data-gate-config", str(tmp_path / "bad-config.json")])
    with pytest.raises(ValueError, match="invalid fixture config"):
        cli.main()
    assert launched == [] and not (tmp_path / "business").exists()


@pytest.mark.skipif(os.name != "posix", reason="Native staging uses Unix ownership")
def test_fixed_native_child_created_private_and_existing_symlink_refused(tmp_path, monkeypatch):
    parent = tmp_path.resolve() / "protected-parent"
    parent.mkdir(mode=0o755)
    monkeypatch.setattr(cli, "_STAGING_PARENT", parent)
    real_lstat = Path.lstat
    ancestors = {parent, *parent.parents}

    def synthetic_system_parent(value):
        info = real_lstat(value)
        if value in ancestors:
            return SimpleNamespace(st_mode=info.st_mode & ~0o022, st_uid=0)
        return info

    # Only the parent ownership fixture is synthetic; creation, O_NOFOLLOW,
    # inode type and child uid/mode checks use the actual filesystem.
    monkeypatch.setattr(Path, "lstat", synthetic_system_parent)
    stage = cli.prepare_native_staging()
    assert stage == parent / "clipboard"
    assert stage.stat().st_mode & 0o777 == 0o700
    assert stage.stat().st_uid == os.geteuid()
    assert cli.prepare_native_staging() == stage
    stage.rmdir()
    outside = tmp_path / "unrelated"
    outside.mkdir()
    stage.symlink_to(outside, target_is_directory=True)
    with pytest.raises(OSError):
        cli.prepare_native_staging()


@pytest.mark.skipif(os.name != "posix", reason="Native staging uses Unix ownership")
def test_untrusted_fixed_parent_is_not_repaired_or_created(tmp_path, monkeypatch):
    parent = tmp_path / "untrusted"
    parent.mkdir(mode=0o777)
    parent.chmod(0o777)
    monkeypatch.setattr(cli, "_STAGING_PARENT", parent)
    with pytest.raises(ValueError, match="parent is not protected"):
        cli.prepare_native_staging()
    assert not (parent / "clipboard").exists()
