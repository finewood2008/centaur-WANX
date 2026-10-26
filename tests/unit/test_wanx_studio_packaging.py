"""Exercise Studio policy loading from both distributions after wheel installation."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CANONICAL_POLICY = _REPO_ROOT / "wanx-studio" / "core" / "wanx-foundation.json"
_IMPORT_INSTALLED = """
import sys
from pathlib import Path

installed = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(installed))
from wanx_studio import foundation
assert Path(foundation.__file__).resolve() == installed / "wanx_studio" / "foundation.py"
"""
_CHECK_POLICY = (
    _IMPORT_INSTALLED
    + """
import importlib.util
import json

policy = foundation.foundation_policy()
policy['identity']['roles'].append('project-superuser')
assert foundation.foundation_policy()['identity']['roles'] == ['admin', 'user']
for field in ['password', 'password_hash', 'refreshToken', 'access_token']:
    assert foundation.has_auth_storage({'accounts': {field: 'string'}})
assert not foundation.has_auth_storage({'staff': {'businessRole': 'string'}})

if importlib.util.find_spec('pydantic') is not None:
    from wanx_studio.contracts import StudioError, check_manifest
    manifest = {
        'schemaVersion': 1, 'entry': 'src/app.js', 'name': 'Package regression',
        'capabilities': ['data'], 'collections': {'accounts': {'password': 'string'}},
    }
    try:
        check_manifest(manifest)
    except StudioError as exc:
        assert exc.code == 'WANX_AUTH_REQUIRED'
    else:
        raise AssertionError('Installed policy allowed credential storage')

if all(importlib.util.find_spec(name) is not None for name in ['fastapi', 'pydantic']):
    import wanx_studio.wanx
    assert Path(wanx_studio.wanx.__file__).resolve() == installed / 'wanx_studio' / 'wanx.py'

print(json.dumps({**foundation.foundation_policy(), 'instruction': foundation.FOUNDATION_PROMPT}))
"""
)


def _run(command: list[str], *, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command, cwd=cwd, env=env, text=True, capture_output=True, encoding="utf-8", timeout=120
    )


def _assert_success(result: subprocess.CompletedProcess[str]) -> None:
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("project", [".", "wanx-studio/backend"], ids=["octop", "studio"])
@pytest.mark.parametrize("from_sdist", [False, True], ids=["direct-wheel", "sdist-wheel"])
def test_installed_wheel_owns_foundation_policy(
    project: str, from_sdist: bool, tmp_path: Path
) -> None:
    uv = shutil.which("uv")
    assert uv is not None, "Packaging regression requires the repository's uv package manager"
    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    env.pop("PYTHONHOME", None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    dist = tmp_path / "dist"
    installed = tmp_path / "installed"
    outside_source = tmp_path / "unrelated-cwd"
    outside_source.mkdir()
    source = _REPO_ROOT / project

    if from_sdist:
        _assert_success(
            _run(
                [
                    uv,
                    "build",
                    "--sdist",
                    "--python",
                    sys.executable,
                    "--out-dir",
                    str(dist),
                    str(source),
                ],
                cwd=outside_source,
                env=env,
            )
        )
        archives = list(dist.glob("*.tar.gz"))
        assert len(archives) == 1
        source = archives[0]

    built = _run(
        [
            uv,
            "build",
            "--wheel",
            "--python",
            sys.executable,
            "--out-dir",
            str(dist),
            str(source),
        ],
        cwd=outside_source,
        env=env,
    )
    _assert_success(built)
    wheels = list(dist.glob("*.whl"))
    assert len(wheels) == 1
    _assert_success(
        _run(
            [
                uv,
                "pip",
                "install",
                "--python",
                sys.executable,
                "--no-deps",
                "--target",
                str(installed),
                str(wheels[0]),
            ],
            cwd=outside_source,
            env=env,
        )
    )
    imported = _run(
        [sys.executable, "-I", "-c", _CHECK_POLICY, str(installed)],
        cwd=outside_source,
        env=env,
    )
    _assert_success(imported)
    expected = json.loads(_CANONICAL_POLICY.read_text(encoding="utf-8"))
    assert json.loads(imported.stdout) == expected

    # An incomplete installation must not borrow policy from the working directory
    # or a source checkout exposed through the environment.
    (installed / "wanx_studio" / "wanx-foundation.json").unlink()
    decoy = outside_source / "core" / "wanx-foundation.json"
    decoy.parent.mkdir()
    decoy.write_text(json.dumps(expected), encoding="utf-8")
    env["PYTHONPATH"] = str(_REPO_ROOT / "wanx-studio" / "backend")
    env["WANX_FOUNDATION_PATH"] = str(_CANONICAL_POLICY)
    missing = _run(
        [sys.executable, "-I", "-c", _IMPORT_INSTALLED, str(installed)],
        cwd=outside_source,
        env=env,
    )
    assert missing.returncode != 0, (
        "Installed package borrowed external policy after resource removal"
    )
    assert "FileNotFoundError" in missing.stderr
    assert "wanx-foundation.json" in missing.stderr
