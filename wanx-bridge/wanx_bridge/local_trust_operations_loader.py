"""Load the explicitly installed root-owned OS worker, never a caller module."""

from __future__ import annotations

import importlib
import importlib.machinery
import importlib.util
import os
import stat
import sys
from pathlib import Path

from .local_trust_config import LocalTrustError

OPERATIONS_CONFIG = Path("/etc/centuarai/local-trust/operations.json")
OS_MODULE_ROOT = Path("/opt/centuarai/os")


def _trusted(path: Path, *, directory: bool):
    info = path.lstat()
    if (
        info.st_uid != 0
        or info.st_mode & 0o022
        or (not stat.S_ISDIR(info.st_mode) if directory else not stat.S_ISREG(info.st_mode))
        or (not directory and info.st_nlink != 1)
    ):
        raise LocalTrustError("LOCAL_TRUST_OPERATION_PROVIDER_INVALID")


def _load_fixed_module(name):
    """Bind one validated deployment tree; callers choose no import path."""
    try:
        for parent in (OS_MODULE_ROOT, *OS_MODULE_ROOT.parents):
            _trusted(parent, directory=True)
        package = OS_MODULE_ROOT / "deployment"
        _trusted(package, directory=True)
        remaining = [package]
        count = 0
        while remaining:
            folder = remaining.pop()
            for item in folder.iterdir():
                count += 1
                if count > 4096:
                    raise ValueError()
                info = item.lstat()
                is_directory = stat.S_ISDIR(info.st_mode)
                _trusted(item, directory=is_directory)
                if is_directory:
                    remaining.append(item)
        previous = sys.modules.get("deployment")
        if previous is not None and tuple(getattr(previous, "__path__", ())) != (str(package),):
            raise ValueError()
        if previous is None:
            spec = importlib.machinery.ModuleSpec("deployment", loader=None, is_package=True)
            spec.submodule_search_locations = [str(package)]
            sys.modules["deployment"] = importlib.util.module_from_spec(spec)
        # Any previously imported child must also belong to the validated tree.
        # Checking only the entry module would allow a dependency to be shadowed.
        for module_name, module in tuple(sys.modules.items()):
            if module_name.startswith("deployment."):
                filename = getattr(module, "__file__", None)
                if filename is None or not Path(filename).resolve(strict=True).is_relative_to(
                    package
                ):
                    raise ValueError()
        module = importlib.import_module("deployment." + name)
        if Path(module.__file__) != package / (name + ".py"):
            raise ValueError()
        return module
    except LocalTrustError:
        raise
    except Exception:
        raise LocalTrustError("LOCAL_TRUST_OPERATION_PROVIDER_INVALID") from None


def create_operation_provider(authority):
    if not os.path.lexists(OPERATIONS_CONFIG):
        return None
    try:
        for parent in OPERATIONS_CONFIG.parents:
            _trusted(parent, directory=True)
        _trusted(OPERATIONS_CONFIG, directory=False)
        module = _load_fixed_module("local_trust_operations")
        provider = module.create_provider(authority)
        authority.configure_operation_provider(provider)
        return provider
    except LocalTrustError:
        raise
    except Exception:
        raise LocalTrustError("LOCAL_TRUST_OPERATION_PROVIDER_INVALID") from None


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Run the installed fixed local-trust executor")
    parser.add_argument("--run-fixed-executor", action="store_true", required=True)
    parser.parse_args()
    try:
        if os.name != "posix" or os.geteuid() != 0:
            raise LocalTrustError("LOCAL_TRUST_OPERATION_PROVIDER_INVALID")
        module = _load_fixed_module("local_trust_transfer")
        result = module.run_fixed_executor()
        if type(result) is not int or result not in (0, 1):
            raise LocalTrustError("LOCAL_TRUST_OPERATION_PROVIDER_INVALID")
        raise SystemExit(result)
    except LocalTrustError as error:
        print(error.code, file=sys.stderr)
        raise SystemExit(1) from None
    except Exception:
        print("LOCAL_TRUST_OPERATION_PROVIDER_INVALID", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
