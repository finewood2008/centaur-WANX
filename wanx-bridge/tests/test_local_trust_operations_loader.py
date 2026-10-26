"""Fixed installed code loader never accepts paths/modules from callers."""

import os
import stat
from types import SimpleNamespace

import pytest

from wanx_bridge import local_trust_operations_loader as loader
from wanx_bridge.local_trust_config import LocalTrustError


def test_absent_operations_config_has_no_import_or_initialization(tmp_path, monkeypatch):
    monkeypatch.setattr(loader, "OPERATIONS_CONFIG", tmp_path / "absent.json")
    monkeypatch.setattr(loader, "_load_fixed_module", lambda _: pytest.fail("must not import"))
    assert loader.create_operation_provider(object()) is None


@pytest.mark.parametrize(
    "change",
    [
        {"st_uid": 1},
        {"st_mode": stat.S_IFREG | 0o666},
        {"st_mode": stat.S_IFLNK | 0o600},
        {"st_nlink": 2},
    ],
)
def test_fixed_code_rejects_untrusted_ownership_modes_links(change):
    info = {"st_uid": 0, "st_mode": stat.S_IFREG | 0o600, "st_nlink": 1} | change
    path = SimpleNamespace(lstat=lambda: SimpleNamespace(**info))
    with pytest.raises(LocalTrustError, match="PROVIDER_INVALID"):
        loader._trusted(path, directory=False)


def test_fixed_executor_cli_has_no_path_or_module_arguments(monkeypatch):
    monkeypatch.setattr(
        loader.sys, "argv", ["loader", "--run-fixed-executor", "--module", "unsafe"]
    )
    monkeypatch.setattr(loader, "_load_fixed_module", lambda _: pytest.fail("must not import"))
    with pytest.raises(SystemExit) as error:
        loader.main()
    assert error.value.code == 2


@pytest.mark.skipif(os.name != "posix", reason="root-only fixed executor")
def test_fixed_executor_selects_only_installed_transfer_module(monkeypatch):
    calls = []
    monkeypatch.setattr(loader.sys, "argv", ["loader", "--run-fixed-executor"])
    monkeypatch.setattr(loader.os, "geteuid", lambda: 0)
    monkeypatch.setattr(
        loader,
        "_load_fixed_module",
        lambda name: calls.append(name) or SimpleNamespace(run_fixed_executor=lambda: 0),
    )
    with pytest.raises(SystemExit) as error:
        loader.main()
    assert error.value.code == 0 and calls == ["local_trust_transfer"]
