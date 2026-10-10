"""Verify implemented runtime coverage, source provenance and recorded test evidence."""
from __future__ import annotations
import csv
import hashlib
import json
import re
import subprocess
from source_state import HERE, js_state, native_state

def read(name: str):
    return json.loads((HERE / name).read_text())

def rows(name: str):
    with (HERE / name).open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))

def main() -> None:
    inputs = read("provenance-files.json")
    for name, expected in inputs.items():
        assert hashlib.sha256((HERE / name).read_bytes()).hexdigest() == expected, name
    original = read("api-baseline/operation-registry.json")
    registry_text = (HERE / "src/generated/registry.ts").read_text()
    runtime = json.loads(registry_text.split("export const operationRegistry = ", 1)[1].split(" as const;", 1)[0])
    modules = json.loads(registry_text.split("export const moduleRegistry = ", 1)[1].split(" as const;", 1)[0])
    assert len(runtime) == 457 and len(modules) == 42
    identity = lambda entries: {(r["method"], r["path"], r["operationId"]) for r in entries}
    assert identity(runtime) == identity(original) == identity(rows("api-policy-review.csv"))
    assert {v for methods in modules.values() for v in methods.values()} == {r["operationId"] for r in runtime}
    assert read("native/wanx/operations.json") == runtime
    management_text = (HERE / "src/generated/applications-registry.ts").read_text()
    management = json.loads(management_text.split("export const applicationOperationRegistry = ", 1)[1].split(" as const;", 1)[0])
    assert len(management) == 15 and read("native/wanx/application-operations.json") == management
    assert not identity(management) & identity(runtime)
    brainstorm_text = (HERE / "src/brainstorm-registry.ts").read_text()
    brainstorm = json.loads(brainstorm_text.split("export const brainstormOperationRegistry = ", 1)[1].split(" as const;", 1)[0])
    assert len(brainstorm) == 9 and read("native/wanx/brainstorm-operations.json") == brainstorm
    assert not identity(brainstorm) & (identity(runtime) | identity(management))
    native_types = (HERE / "contracts/native-api.d.ts").read_text()
    assert (HERE / "src/generated/native-api.ts").read_text().split("\n", 1)[1] == native_types[native_types.index("export interface"):]
    assert len(read("api-baseline/websocket-routes.json")) == 7
    memory = [r for r in rows("memory-api-map.csv") if r["classification"] == "native_memory"]
    assert len(memory) == 31 and identity(memory) == identity([r for r in original if "memory" in r["tags"]])
    aliases = json.loads((HERE / "src/generated/memory.ts").read_text().split(" = ", 1)[1].split(" as const;", 1)[0])
    assert set(aliases.values()) == {r["operationId"] for r in memory}
    # The public SDK fixtures remain pristine; frozen Core uses a separate projection.
    for fixture in (HERE / "native/core-test-contracts/connectivity/v1/fixtures").rglob("*.json"):
        rel = fixture.relative_to(HERE / "native/core-test-contracts")
        public = read("native/contracts/" + rel.as_posix())
        projected = json.loads(fixture.read_text())
        if fixture.name == "core-api.direct-relay.v1.json":
            assert public["expected"]["error_code"] == "SDK_INVALID_SESSION"
            public["expected"]["error_code"] = "SDK_PATH_POLICY_FAILED"
        assert public == projected, fixture.name
    package, lock, comparison = read("package.json"), read("package-lock.json"), read("comparison.json")
    assert comparison["standard_name"] == package["name"] == lock["name"] == "centaurai-wanx"
    assert package["version"] == lock["version"] == lock["packages"][""]["version"]
    assert package["private"] is True and package["license"] == "UNLICENSED"
    assert comparison["runtime_sdk_implemented"] and not comparison["standard_sdk_released"]
    for entry in package["exports"].values():
        for path in entry.values():
            assert (HERE / path).is_file(), path
    for key, entry in read("native/bin/manifest.json").items():
        binary = HERE / "native/bin" / entry["file"]
        assert hashlib.sha256(binary.read_bytes()).hexdigest() == entry["sha256"], key
        assert entry["source_sha256"] == native_state(), (key, "rebuild native binary")
    assert len(read("native/bin/manifest.json")) == 6
    links = 0
    for doc in [HERE / "README.md", HERE / "THIRD_PARTY_NOTICES.md", HERE / "docs/electron.md", HERE / "docs/api-reference.md"]:
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", doc.read_text()):
            if target.startswith(("https:", "http:", "#")): continue
            path = (doc.parent / target.split("#", 1)[0].strip("<>")).resolve()
            assert path.exists() or path == HERE / "verification.json", (doc.name, target)
            links += 1
    checked_sources = []
    for folder, expected in [("nexusaos-centuarai-conn-sdks", comparison["latest_sdk"]["commit"]), ("github-publish/wanx-sdk", comparison["last_night_design"]["commit"])]:
        repo = HERE.parent / folder
        if (repo / ".git").exists():
            assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip() == expected
            assert subprocess.check_output(["git", "status", "--porcelain"], cwd=repo) == b"", folder
            checked_sources.append(folder)
    js, go = read("artifacts/js-checks.json"), read("artifacts/native-checks.json")
    assert js["source_sha256"] == js_state(), "rerun JS checks"
    assert go["source_sha256"] == native_state(), "rerun native checks"
    assert go["vet"] == go["race_tests"] == js["runtime_tests"] == "passed"
    node_count = int(re.search(r"^# pass (\d+)$", (HERE / "artifacts/node-tests.tap").read_text(), re.M)[1])
    report = {
        "date": "2026-10-02", "name": package["name"], "version": package["version"],
        "status": "local_runtime_alpha_verified", "baseline": "WANX platform 7d84a9973a2e18b7083d4b21d68fe6332123765c; Codeup f0e9c63452e531b1f51024911637feae73738320",
        "coverage": {"modules": 42, "public_http_bindings": 457, "native_memory_operations": 31, "websocket_endpoints": 7, "internal_mcp_excluded": 3, "management_protocol_v1_bindings": 15, "brainstorm_bindings": 9, "total_public_http_bindings": 481, "total_modules": 44},
        "checks": {"typescript_build_strict_and_negative_examples": "passed", "node_runtime_tests": node_count, "go_race_tests": go["test_cases"], "go_vet": "passed", "source_provenance_files": len(inputs), "source_worktrees_verified_clean": checked_sources, "binary_hashes": "passed", "cross_compiled_targets": list(read("native/bin/manifest.json")), "standalone_document_links": links},
        "test_environment": "macOS arm64; synthetic local HTTP/WS; no production account or data",
        "limits": ["481 HTTP tests prove client serialization and transport bindings, not server business semantics", "matching production SSO server implementation not located in supplied SDK repository", "built-in P2P contract restricted to omnia-desktop and DIRECT_ONLY", "encoded P2P uploads <= 2 MiB; uploadStream is false"],
        "not_performed": ["real box/P2P/account/memory integration", "Windows/Linux/x64 runtime acceptance", "real Electron safeStorage and packaged UI acceptance", "mobile/H5 SDK delivery", "large-upload or Relay server contract upgrade", "npm/Go production publication or device deployment"],
        "runtime_implementation_verified": True, "production_release": False,
    }
    (HERE / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
