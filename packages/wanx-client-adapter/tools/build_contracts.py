"""Historical comparison generator; do not run over the implemented SDK.

Runtime generation uses generate_runtime.py. This tool resets candidate review
artifacts and is retained only for reproducing the earlier comparison.
"""

from __future__ import annotations

import csv
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
DESIGN = HERE.parent / "github-publish/wanx-sdk"
LATEST = HERE.parent / "nexusaos-centuarai-conn-sdks"

# Stable public method names for this candidate; these are not authority grants.
MEMORY_NAMES = {
    ("POST", "/atoms"): "createAtom",
    ("POST", "/atoms/list"): "listAtoms",
    ("GET", "/atoms/{atom_id}"): "getAtom",
    ("POST", "/atoms/{atom_id}:deprecate"): "deprecateAtom",
    ("POST", "/atoms/{atom_id}:replace"): "replaceAtom",
    ("POST", "/candidates/list"): "listCandidates",
    ("GET", "/candidates/{candidate_id}"): "getCandidate",
    ("POST", "/candidates/{candidate_id}:promote"): "promoteCandidate",
    ("POST", "/candidates/{candidate_id}:reject"): "rejectCandidate",
    ("POST", "/entities/list"): "listEntities",
    ("GET", "/entities/{entity_id}"): "getEntity",
    ("POST", "/episodes/list"): "listEpisodes",
    ("GET", "/episodes/{episode_id}"): "getEpisode",
    ("GET", "/extract-config"): "getExtractConfig",
    ("PUT", "/extract-config"): "updateExtractConfig",
    ("POST", "/journal/list"): "listJournal",
    ("GET", "/journal/recent"): "recentJournal",
    ("POST", "/portable/adopt"): "adoptPortable",
    ("POST", "/portable/doctor"): "doctorPortable",
    ("POST", "/portable/pack"): "packPortable",
    ("POST", "/raw_events/list"): "listRawEvents",
    ("GET", "/raw_events/{event_id}"): "getRawEvent",
    ("GET", "/stats/atom_kinds"): "statsAtomKinds",
    ("GET", "/stats/counts"): "statsCounts",
    ("GET", "/stats/growth"): "statsGrowth",
    ("GET", "/terminal/about_me"): "terminalAboutMe",
    ("GET", "/terminal/current_focus"): "terminalCurrentFocus",
    ("GET", "/terminal/entities"): "terminalEntities",
    ("GET", "/terminal/recent_stories"): "terminalRecentStories",
    ("GET", "/terminal/things_you_told_me"): "terminalThingsYouToldMe",
}
PREFIX = "/api/agents/{agent_id}/memory"


def head(path: Path) -> str:
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=path, text=True).strip()


def main() -> None:
    for directory in ("contracts", "third-party", "examples"):
        (HERE / directory).mkdir(exist_ok=True)
    shutil.copyfile(DESIGN / "contracts/native-api.d.ts", HERE / "contracts/native-api.d.ts")
    license_text = (DESIGN / "LICENSE").read_text(encoding="utf-8")
    license_lines = license_text.splitlines(keepends=True)
    license_lines[0] = "centaurai-wanx — Proprietary\n"
    (HERE / "LICENSE").write_text("".join(license_lines), encoding="utf-8")
    shutil.copyfile(DESIGN / "platform/centaurai-wanx/NOTICE", HERE / "third-party/native-platform-NOTICE")
    registry = json.loads((DESIGN / "api-baseline/operation-registry.json").read_text())
    memory = [row for row in registry if "memory" in row["tags"]]
    agents = [row for row in memory if row["path"].startswith(PREFIX + "/")]
    global_rows = [row for row in memory if row not in agents]
    legacy = [row for row in registry if row["path"].startswith(PREFIX + "/daily")]
    assert len(registry) == 457 and len(memory) == 31 and len(agents) == 30
    assert len(global_rows) == 1 and len(legacy) == 3
    assert {(row["method"], row["path"][len(PREFIX):]) for row in agents} == set(MEMORY_NAMES)
    mappings = {}
    with (HERE / "memory-api-map.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        fields = ["method", "path", "operationId", "public_method", "scope_kind", "transport", "classification", "policy_status"]
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for row in memory + legacy:
            is_global = row in global_rows
            is_legacy = row in legacy
            name = "listPortableSources" if is_global else (
                "compatibility." + row["operationId"].split("_api_")[0] if is_legacy
                else MEMORY_NAMES[(row["method"], row["path"][len(PREFIX):])]
            )
            if not is_global and not is_legacy:
                mappings[name] = row["operationId"]
            writer.writerow({
                **{key: row[key] for key in ("method", "path", "operationId")},
                "public_method": name,
                "scope_kind": "host_migration" if is_global else "agent_owner",
                "transport": "response_stream" if name == "packPortable" else "native_http",
                "classification": "agent_files_compatibility" if is_legacy else "native_memory",
                "policy_status": "requires_platform_review_not_granted",
            })
    mapping_lines = "\n".join(f"  readonly {name}: {json.dumps(operation)};" for name, operation in mappings.items())
    (HERE / "contracts/memory-methods.d.ts").write_text(
        "/** Candidate method aliases only. No implementation or permission grants. */\n"
        "export interface AgentMemoryMethods {\n" + mapping_lines + "\n}\n"
        "export interface GlobalMemoryMethods {\n  readonly listPortableSources: "
        + json.dumps(global_rows[0]["operationId"]) + ";\n}\n", encoding="utf-8",
    )
    with (HERE / "api-policy-review.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=["operationId", "method", "path", "tags", "application_scope", "native_role", "resource_rule", "effect", "release_status"])
        writer.writeheader()
        for row in registry:
            writer.writerow({
                "operationId": row["operationId"], "method": row["method"], "path": row["path"],
                "tags": ";".join(row["tags"]), "application_scope": "REQUIRES_REVIEW",
                "native_role": "REQUIRES_REVIEW", "resource_rule": "REQUIRES_REVIEW",
                "effect": "REQUIRES_REVIEW", "release_status": "candidate_not_authorized",
            })
    paths = {
        "last_night_native_types": DESIGN / "contracts/native-api.d.ts",
        "last_night_registry": DESIGN / "api-baseline/operation-registry.json",
        "last_night_openapi": DESIGN / "api-baseline/openapi.json",
        "latest_go_binding": LATEST / "go/connectivity/client.go",
        "latest_go_sso": LATEST / "go/omniaauth/session.go",
        "latest_go_grant": LATEST / "go/consumer/octop.go",
        "latest_electron_carrier": LATEST / "packages/connectivity-electron/src/admin-ticket-provider.ts",
    }
    evidence = {
        "date": "2026-10-01", "standard_name": "centaurai-wanx",
        "artifact_status": "comparison_and_candidate_contracts",
        "runtime_sdk_implemented": False, "standard_sdk_released": False,
        "latest_sdk": {"branch": "feature/go-connectivity-sdk-20260930", "commit": head(LATEST), "go_sdk": "0.2.0", "core": "v0.1.1", "electron": "2.0.0", "contracts": "1.3.0"},
        "last_night_design": {"commit": head(DESIGN), "runtime_status": "design_only"},
        "native_inventory": {"public_candidates": len(registry), "memory_tag": len(memory), "agent_memory": len(agents), "global_memory": len(global_rows), "legacy_daily_files": len(legacy)},
        "input_hashes": {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in paths.items()},
        "release_checks": {
            "last_night_make_all": "passed_design_only",
            "latest_typescript_build": "passed_node_22.23.1",
            "latest_verify_release": "incomplete_missing_java_runtime_at_android_aar_check",
            "remaining_desktop_and_device_checks": "passed",
            "zhijun_session_tests": 26, "zhijun_main_tests": 16,
            "existing_npm_consumer_check": "passed_script_selected_packages_only",
            "go_race_vet": "not_run_go_toolchain_unavailable",
            "live_box_sso_memory_and_streams": "not_performed",
            "remote_publication": "not_performed",
        },
        "server_source_audit": {
            "tracked_sdk_and_release_source_reviewed": True, "archive_entry_inventories_checked": 87,
            "found": ["client SSO calls", "schema route declarations", "httptest synthetic handlers"],
            "production_admin_or_wanx_sso_handler_located": False,
            "meaning": "matching_server_implementation_and_live_deployment_require_validation",
        },
    }
    (HERE / "comparison.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence["native_inventory"], ensure_ascii=False))


if __name__ == "__main__":
    main()
