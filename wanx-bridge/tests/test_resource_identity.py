"""Instance identity and durable deduplication, independent of artifact caching."""

import asyncio
import base64
import json
import threading

import httpx
import pytest
from test_resources import prepare, signed
from test_resources import runtime as runtime
from test_resources import setup as setup

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.resources import atomic
from wanx_bridge.resources_contract import canonical
from wanx_bridge.resources_runtime import ResourceRuntime


def application(env, name):
    return (*env[:4], {**env[4], "applicationId": name}, env[5])


def account_expert(env, *, version="1.0.0"):
    catalog = env[0].catalog
    catalog.package_value, _, catalog.envelope = signed(
        catalog.private, version=version, metadata={"expertInstanceScope": "account"}
    )


class SkillAdmin:
    def __init__(self):
        self.rows, self.files = {}, {}
        self.creates = 0
        self.lost_create = False
        self.lost_import = False

    async def _admin(self, method, path, **kwargs):
        assert (method, path) == ("GET", "/api/skill-packages")
        return httpx.Response(200, json=list(self.rows.values()))

    async def request(self, method, path, **kwargs):
        parts = path.split("/")
        if (method, path) == ("POST", "/api/skill-packages"):
            self.creates += 1
            package_id = "package-" + str(self.creates)
            self.rows[package_id] = {"id": package_id, **kwargs["json"]}
            self.files[package_id] = {}
            if self.lost_create:
                raise BridgeAuthError("RESOURCE_UPSTREAM_OPERATION_FAILED", 502)
            return self.rows[package_id]
        package_id = parts[3]
        if method == "GET" and len(parts) == 4:
            return {
                **self.rows[package_id],
                "skills": [{"slug": slug} for slug in self.files[package_id]],
            }
        if method == "GET" and len(parts) == 6:
            return {"raw": self.files[package_id][parts[5]]["SKILL.md"].decode()}
        if method == "POST" and parts[-1] == "skills":
            body = kwargs["json"]
            self.files[package_id][body["name"]] = {
                item["path"]: base64.b64decode(item["content_base64"]) for item in body["files"]
            }
            if self.lost_import:
                raise BridgeAuthError("RESOURCE_UPSTREAM_OPERATION_FAILED", 502)
            return {"slug": body["name"]}
        raise AssertionError((method, path))


def skill_resource(env, *, version="1.0.0"):
    catalog = env[0].catalog
    package, _, envelope = signed(
        catalog.private,
        kind="skill-package",
        resource_id="shared-skills",
        version=version,
        files=[
            {
                "path": "skills/demo/SKILL.md",
                "contentBase64": base64.b64encode(b"---\nname: demo\n---\nDo things").decode(),
            }
        ],
    )
    catalog.package_value, catalog.envelope = package, envelope

    async def resolve(app, artifact, *, account_id=None):
        return {
            "schemaVersion": 1,
            "applicationId": app,
            "artifactId": artifact,
            "backendProductId": "wanx",
            "requirements": [
                {"kind": "skill-package", "resourceId": "shared-skills", "minVersion": "1.0.0"}
            ],
            "resources": [catalog.envelope],
        }

    catalog.resolve = resolve
    if not isinstance(env[0].admin, SkillAdmin):
        env[0].admin = SkillAdmin()


async def test_default_expert_stays_application_isolated(runtime):
    first = await prepare(runtime)
    other = await prepare(application(runtime, "centaurai.other"))
    assert first["status"] == other["status"] == "ready"
    assert first["bindings"][0]["instanceId"] != other["bindings"][0]["instanceId"]
    assert not (runtime[0].catalog.directory / "instances" / "experts").exists()


async def test_account_expert_reuses_one_instance_across_applications_and_restart(runtime):
    account_expert(runtime)
    first = await prepare(runtime)
    instance = first["bindings"][0]["instanceId"]
    runtime[1].files[instance]["memory/notes.md"] = b"customer history"
    second = await prepare(application(runtime, "centaurai.other"))
    assert second["bindings"] == first["bindings"]
    restarted = ResourceRuntime(runtime[0].catalog, runtime[0].admin)
    third_env = (restarted, *runtime[1:])
    third = await prepare(application(third_env, "centaurai.third"))
    assert third["bindings"] == first["bindings"] and len(runtime[1].rows) == 1
    assert runtime[1].files[instance]["memory/notes.md"] == b"customer history"
    assert len(list((runtime[0].catalog.directory / "instances" / "experts").glob("*.json"))) == 1


async def test_account_expert_never_crosses_customer_or_ownership_epoch(runtime):
    account_expert(runtime)
    first = await prepare(runtime)
    runtime[3]["sub"] = "consumer-other"
    runtime[1].user["id"] = 18
    second = await prepare(runtime)
    runtime[3]["ownership_epoch"] = 2
    third = await prepare(runtime)
    assert len({value["bindings"][0]["instanceId"] for value in (first, second, third)}) == 3


async def test_shared_expert_keeps_compatible_old_version_and_blocks_data_migration(runtime):
    account_expert(runtime)
    first = await prepare(runtime)
    account_expert(runtime, version="2.0.0")
    second = await prepare(application(runtime, "centaurai.other"))
    assert second["bindings"] == first["bindings"] and len(runtime[1].rows) == 1
    runtime[0].catalog.minimum = "2.0.0"
    blocked = await prepare(application(runtime, "centaurai.third"))
    assert blocked["code"] == "RESOURCE_MIGRATION_REQUIRED"
    assert len(runtime[1].rows) == 1


async def test_shared_expert_lost_create_recovers_from_different_application(runtime):
    account_expert(runtime)
    runtime[1].lost_create = True
    assert (await prepare(runtime))["status"] == "blocked"
    runtime[1].lost_create = False
    recovered = await prepare(application(runtime, "centaurai.other"))
    assert recovered["status"] == "ready" and len(runtime[1].rows) == 1
    assert (await prepare(runtime))["bindings"] == recovered["bindings"]


async def test_shared_expert_concurrent_applications_create_once(runtime):
    account_expert(runtime)
    results = await asyncio.gather(
        prepare(runtime),
        prepare(application(runtime, "centaurai.other")),
    )
    assert all(row["status"] == "ready" for row in results)
    assert results[0]["bindings"] == results[1]["bindings"] and len(runtime[1].rows) == 1


async def test_skill_shared_across_accounts_applications_and_exact_content_identity(runtime):
    skill_resource(runtime)
    first = await prepare(runtime)
    runtime[3]["sub"] = "consumer-other"
    runtime[1].user["id"] = 18
    other = await prepare(application(runtime, "centaurai.other"))
    assert other["bindings"] == first["bindings"]
    assert runtime[0].admin.creates == 1
    skill_resource(runtime, version="2.0.0")
    third = await prepare(application(runtime, "centaurai.third"))
    assert third["bindings"][0]["version"] == "2.0.0"
    assert third["bindings"][0]["packageId"] != first["bindings"][0]["packageId"]
    assert runtime[0].admin.creates == 2
    assert len(list((runtime[0].catalog.directory / "instances" / "skills").glob("*.json"))) == 2


async def test_skill_lost_create_and_interrupted_import_never_create_duplicates(runtime):
    skill_resource(runtime)
    admin = runtime[0].admin
    admin.lost_create = True
    assert (await prepare(runtime))["status"] == "blocked"
    admin.lost_create = False
    assert (await prepare(application(runtime, "centaurai.other")))["status"] == "ready"
    assert (await prepare(runtime))["status"] == "ready" and admin.creates == 1
    skill_resource(runtime, version="2.0.0")
    admin.lost_import = True
    assert (await prepare(application(runtime, "centaurai.third")))["status"] == "blocked"
    admin.lost_import = False
    result = await prepare(application(runtime, "centaurai.fourth"))
    assert result["code"] == "RESOURCE_SKILL_IMPORT_UNCERTAIN"
    assert admin.creates == 2


async def test_shared_skill_validation_rejects_modified_global_content(runtime):
    skill_resource(runtime)
    first = await prepare(runtime)
    package_id = first["bindings"][0]["packageId"]
    runtime[0].admin.files[package_id]["demo"]["SKILL.md"] = b"customer changed"
    second = await prepare(application(runtime, "centaurai.other"))
    assert second["status"] == "blocked" and second["code"] == "RESOURCE_USER_MODIFIED"
    assert runtime[0].admin.creates == 1


async def test_existing_scope_instances_are_not_merged_when_sharing_is_enabled(runtime):
    first = await prepare(runtime)
    other_env = application(runtime, "centaurai.other")
    second = await prepare(other_env)
    account_expert(runtime, version="2.0.0")
    assert (await prepare(runtime))["bindings"] == first["bindings"]
    assert (await prepare(other_env))["bindings"] == second["bindings"]
    third = await prepare(application(runtime, "centaurai.third"))
    fourth = await prepare(application(runtime, "centaurai.fourth"))
    assert third["bindings"] == fourth["bindings"]
    assert len(runtime[1].rows) == 3


async def test_corrupt_shared_index_stops_without_creating_or_overwriting(runtime):
    account_expert(runtime)
    first = await prepare(runtime)
    index = next((runtime[0].catalog.directory / "instances" / "experts").glob("*.json"))
    index.write_text('{"schemaVersion":99}')
    result = await prepare(application(runtime, "centaurai.other"))
    assert result["code"] == "RESOURCE_LOCAL_STATE_INVALID"
    assert (await prepare(runtime))["bindings"] == first["bindings"]
    assert len(runtime[1].rows) == 1


async def test_shared_state_precedes_first_external_create_and_remains_gc_reachable(runtime):
    account_expert(runtime)
    original = runtime[1]

    async def inspect(method, path, **kwargs):
        if (method, path) == ("POST", "/api/agents"):
            index = next((runtime[0].catalog.directory / "instances" / "experts").glob("*.json"))
            value = json.loads(index.read_bytes())
            assert value["record"]["createRequested"] is True
            assert (
                value["record"]["digest"]
                == runtime[0].catalog.envelope["payload"]["package"]["sha256"]
            )
            assert value["record"]["nonce"] == kwargs["json"]["config"]["wanx_resource_instance"]
        return await original(method, path, **kwargs)

    result = await runtime[0].prepare(runtime[4], runtime[2], runtime[3], inspect, runtime[5])
    assert result["status"] == "ready"


async def test_separate_runtime_process_locks_serialize_shared_creation(runtime):
    account_expert(runtime)
    entered, release = asyncio.Event(), asyncio.Event()
    original = runtime[1]

    async def delayed(method, path, **kwargs):
        if (method, path) == ("POST", "/api/agents"):
            entered.set()
            await release.wait()
        return await original(method, path, **kwargs)

    first = asyncio.create_task(
        runtime[0].prepare(runtime[4], runtime[2], runtime[3], delayed, runtime[5])
    )
    await asyncio.wait_for(entered.wait(), 2)
    second_runtime = ResourceRuntime(runtime[0].catalog, runtime[0].admin)
    other = application((second_runtime, *runtime[1:]), "centaurai.other")
    try:
        blocked = await prepare(other)
        assert blocked["code"] == "RESOURCE_PREPARATION_BUSY"
    finally:
        release.set()
    first_result = await first
    assert (await prepare(other))["bindings"] == first_result["bindings"]
    assert len(runtime[1].rows) == 1


async def test_shared_gray_skill_rechecks_each_account_and_revoked_binding(runtime):
    skill_resource(runtime)
    catalog = runtime[0].catalog
    envelope = catalog.envelope
    envelope["payload"]["releaseAccess"] = "account"
    envelope["signature"]["signatureBase64"] = base64.b64encode(
        catalog.private.sign(canonical(envelope["payload"]))
    ).decode()
    first_id = "f6f4bd3b-40c7-4b9d-b941-b46f9d9fa34d"
    second_id = "06a42750-8fdd-44af-b866-cf7a650af9df"
    allowed = {first_id}
    checks = []

    async def authorize(value, *, account_id):
        assert value == envelope
        checks.append(account_id)
        if account_id not in allowed:
            raise BridgeAuthError("RESOURCE_GRAY_ACCESS_DENIED", 403)

    catalog.authorize = authorize
    runtime[3]["sub"] = first_id
    first = await prepare(runtime)
    runtime[3]["sub"] = second_id
    runtime[1].user["id"] = 18
    other = application(runtime, "centaurai.other")
    assert (await prepare(other))["code"] == "RESOURCE_GRAY_ACCESS_DENIED"
    assert runtime[0].admin.creates == 1
    allowed.add(second_id)
    assert (await prepare(other))["bindings"] == first["bindings"]
    allowed.remove(second_id)
    assert (await prepare(other))["code"] == "RESOURCE_GRAY_ACCESS_DENIED"
    assert checks == [first_id, second_id, second_id, second_id]
    assert runtime[0].admin.creates == 1


async def test_legacy_unfinished_skill_resumes_without_rehoming(runtime):
    skill_resource(runtime)
    runtime[0].admin.lost_create = True
    assert (await prepare(runtime))["status"] == "blocked"
    binding_path = next((runtime[0].catalog.directory / "bindings").glob("*.json"))
    value = json.loads(binding_path.read_bytes())
    intent = value["pendingResources"]["skill-package:shared-skills"]
    intent.pop("sharedIdentity")
    intent["marker"] = intent["marker"].replace("wanx-resource:shared:", "wanx-resource:")
    runtime[0].admin.rows["package-1"]["description"] = intent["marker"]
    atomic(binding_path, canonical(value))
    index = next((runtime[0].catalog.directory / "instances" / "skills").glob("*.json"))
    index.unlink()  # Model a pre-index application ledger, not a migration.
    runtime[0].admin.lost_create = False
    assert (await prepare(runtime))["status"] == "ready"
    assert runtime[0].admin.creates == 1 and not index.exists()
    updated = json.loads(binding_path.read_bytes())
    assert "sharedIdentity" not in updated["resources"]["skill-package:shared-skills"]
    other = await prepare(application(runtime, "centaurai.other"))
    assert other["status"] == "ready" and runtime[0].admin.creates == 2
    assert runtime[0].admin.rows["package-2"]["description"].startswith("wanx-resource:shared:")


@pytest.mark.parametrize("target", ["resource_instances", "resources_runtime"])
async def test_cancel_waits_for_shared_state_write_before_unlocking(runtime, monkeypatch, target):
    import importlib

    account_expert(runtime)
    module = importlib.import_module("wanx_bridge." + target)
    entered, release = threading.Event(), threading.Event()
    original = module.atomic

    def delayed(path, raw):
        entered.set()
        assert release.wait(5)
        original(path, raw)

    monkeypatch.setattr(module, "atomic", delayed)
    first = asyncio.create_task(prepare(runtime))
    assert await asyncio.wait_for(asyncio.to_thread(entered.wait, 2), 3)
    first.cancel()
    await asyncio.sleep(0)
    other_runtime = ResourceRuntime(runtime[0].catalog, runtime[0].admin)
    other = application((other_runtime, *runtime[1:]), "centaurai.other")
    try:
        assert not first.done()
        assert (await prepare(other))["code"] == "RESOURCE_PREPARATION_BUSY"
        first.cancel()  # A second disconnect/shutdown signal must not free the lock either.
        for _ in range(4):  # Let cancellation propagate through the worker Task and its waiter.
            await asyncio.sleep(0)
        assert not first.done()
        assert (await prepare(other))["code"] == "RESOURCE_PREPARATION_BUSY"
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await first
    recovered = await prepare(other)
    assert recovered["status"] == "ready"
    assert (await prepare(runtime))["bindings"] == recovered["bindings"]
    assert len(runtime[1].rows) == 1
