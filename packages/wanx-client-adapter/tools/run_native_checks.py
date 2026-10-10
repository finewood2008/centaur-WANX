"""Validate the host and both frozen upstream Go modules; no live service calls."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from source_state import native_state

HERE = Path(__file__).resolve().parent.parent
SDK = "codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/nexusaos/nexusaos-centuarai-conn-sdks.git/go"
CORE = "codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/nexusaos/nexusaos-centuarai-os.git/p2p-core-go"

def main() -> None:
    go = os.environ.get("WANX_GO") or shutil.which("go")
    if not go:
        raise SystemExit("Go >=1.24 required; set WANX_GO or install Go")
    env = {**os.environ, "GOFLAGS": "-trimpath", "NEXUSAOS_CONTRACTS_ROOT": str(HERE / "native/core-test-contracts")}
    packages = ["./...", SDK + "/...", CORE + "/..."]
    artifacts = HERE / "artifacts"
    artifacts.mkdir(exist_ok=True)
    receipt = artifacts / "native-checks.json"
    receipt.unlink(missing_ok=True)
    subprocess.run([go, "vet", *packages], cwd=HERE / "native", env=env, check=True)
    with (artifacts / "go-race.jsonl").open("w") as log:
        subprocess.run([go, "test", "-race", "-json", *packages], cwd=HERE / "native", env=env, stdout=log, check=True)
    results = [json.loads(line) for line in (artifacts / "go-race.jsonl").read_text().splitlines() if line.startswith("{")]
    assert not any(r["Action"] == "fail" for r in results)
    passed = sum(r["Action"] == "pass" and bool(r.get("Test")) for r in results)
    result = {"vet": "passed", "race_tests": "passed", "test_cases": passed, "go": subprocess.check_output([go, "version"], text=True).strip(), "source_sha256": native_state(), "hardware_integration": "not_performed"}
    receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
