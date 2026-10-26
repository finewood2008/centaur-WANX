"""Studio's trusted policy must survive installation without the checkout."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
STUDIO = REPO / "wanx-studio"


def run(*args: str, cwd: Path) -> str:
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout


@pytest.fixture(scope="module", params=["octop", "standalone"])
def studio_wheels(request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory):
    uv = shutil.which("uv")
    assert uv is not None, "Packaging regression tests require the repository's uv toolchain"
    project = REPO if request.param == "octop" else STUDIO / "backend"
    output = tmp_path_factory.mktemp(f"studio-{request.param}-distributions")
    run(uv, "build", "--wheel", "--out-dir", str(output / "direct"), str(project), cwd=output)
    run(uv, "build", "--sdist", "--out-dir", str(output / "sdist"), str(project), cwd=output)
    sdist = next((output / "sdist").glob("*.tar.gz"))
    run(uv, "build", "--wheel", "--out-dir", str(output / "rebuilt"), str(sdist), cwd=output)
    return uv, {kind: next((output / kind).glob("*.whl")) for kind in ["direct", "rebuilt"]}


def assert_policy_import(package_root: Path, cwd: Path) -> None:
    # -I -S excludes PYTHONPATH, the checkout, and editable-install .pth hooks.
    # Dependencies come from the test environment, but Studio must come from
    # the installed wheel (or the explicitly selected source-layout root).
    dependencies = sorted({sysconfig.get_path("purelib"), sysconfig.get_path("platlib")})
    result = run(
        sys.executable,
        "-I",
        "-S",
        "-c",
        """
import json, sys
from pathlib import Path
sys.path[:0] = [sys.argv[1], *json.loads(sys.argv[2])]
from wanx_studio.wanx import mount_wanx
from wanx_studio import foundation
assert callable(mount_wanx)
assert Path(foundation.__file__).resolve().is_relative_to(Path(sys.argv[1]).resolve())
policy = foundation.foundation_policy()
for key in policy['forbiddenCredentialFields']:
    assert foundation.has_auth_storage({'accounts': {key: 'string'}})
assert not foundation.has_auth_storage({'staff': {'businessRole': 'string'}})
policy['identity']['roles'].append('project-admin')
assert foundation.foundation_policy()['identity']['roles'] == ['admin', 'user']
print(json.dumps({**foundation.foundation_policy(), 'instruction': foundation.FOUNDATION_PROMPT}))
""",
        str(package_root),
        json.dumps(dependencies),
        cwd=cwd,
    )
    policies = list((STUDIO / "core").glob("wanx-foundation.json")) + list(
        (STUDIO / "backend" / "wanx_studio").glob("wanx-foundation.json")
    )
    assert len(policies) == 1, "JavaScript and Python must share one trusted policy source"
    assert json.loads(result) == json.loads(policies[0].read_text(encoding="utf-8"))


@pytest.mark.parametrize("distribution", ["direct", "rebuilt"])
def test_installed_studio_wheel_loads_trusted_policy(studio_wheels, distribution, tmp_path):
    uv, wheels = studio_wheels
    installed = tmp_path / "installed"
    run(
        uv,
        "pip",
        "install",
        "--no-deps",
        "--no-index",
        "--target",
        str(installed),
        str(wheels[distribution]),
        cwd=tmp_path,
    )
    assert_policy_import(installed, tmp_path)


def test_studio_source_layout_loads_same_trusted_policy(tmp_path):
    assert_policy_import(STUDIO / "backend", tmp_path)
