"""Run actual builds, type assertions and local runtime tests, retaining evidence."""
from __future__ import annotations
import json
import shutil
import subprocess
from source_state import HERE, js_state

def main() -> None:
    npm = shutil.which("npm")
    if not npm:
        raise SystemExit("Node.js 22 and npm required")
    artifacts = HERE / "artifacts"
    artifacts.mkdir(exist_ok=True)
    receipt = artifacts / "js-checks.json"
    receipt.unlink(missing_ok=True)
    for task in ("build", "typecheck"):
        subprocess.run([npm, "run", task], cwd=HERE, check=True)
    result = subprocess.run([npm, "test"], cwd=HERE, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (artifacts / "node-tests.tap").write_text(result.stdout)
    print(result.stdout, end="")
    result.check_returncode()
    report = {"build": "passed", "strict_typecheck_and_negative_examples": "passed", "runtime_tests": "passed", "source_sha256": js_state()}
    receipt.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

if __name__ == "__main__":
    main()
