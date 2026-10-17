"""Candidate bindings are exact, durable references, never the legacy active pointer."""

import copy
import json
import re

import pytest
from test_resources import prepare, signed
from test_resources import runtime as runtime
from test_resources import setup as setup

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.resources_contract import canonical


async def candidate(env, *, operation="install-1", artifact=None, scope=None):
    runtime, upstream, session, context, body, live = env
    return await runtime.prepare_candidate(
        {
            **body,
            "schemaVersion": 2,
            "artifactId": artifact or body["artifactId"],
            "operationId": operation,
        },
        session,
        scope or context,
        upstream,
        live,
    )


async def inspect(env, result, *, scope=None, artifact=None):
    runtime, upstream, session, context, body, live = env
    return await runtime.inspect_candidate(
        {
            "schemaVersion": 2,
            "applicationId": body["applicationId"],
            "artifactId": artifact or result["artifactId"],
            "bindingSetId": result["bindingSetId"],
        },
        session,
        scope or context,
        upstream,
        live,
    )


async def test_candidate_keeps_legacy_binding_byte_identical_and_reuses_private_history(runtime):
    old = await prepare(runtime)
    directory = runtime[0].catalog.directory
    legacy = next((directory / "bindings").glob("*.json"))
    original = legacy.read_bytes()
    result = await candidate(runtime, artifact="artifact-2")
    assert result["status"] == "ready"
    assert result["schemaVersion"] == 2
    assert re.fullmatch("[0-9a-f]{64}", result["bindingSetId"])
    assert result["bindingScope"] == {
        "accountId": "consumer-1",
        "deviceId": "box-1",
        "ownershipEpoch": 1,
        "artifactId": "artifact-2",
    }
    assert legacy.read_bytes() == original
    assert result["bindings"] == old["bindings"]
    assert len(runtime[1].rows) == 1
    path = directory / "binding-sets" / (result["bindingSetId"] + ".json")
    durable = path.read_bytes()
    runtime[1].calls.clear()
    assert (await candidate(runtime, artifact="artifact-2"))["bindingSetId"] == result[
        "bindingSetId"
    ]
    assert (await inspect(runtime, result))["bindings"] == result["bindings"]
    assert all(method == "GET" for method, _ in runtime[1].calls)
    assert path.read_bytes() == durable
    assert (await prepare(runtime, read_only=True))["bindings"] == old["bindings"]


async def test_new_candidate_does_not_create_legacy_active_pointer(runtime):
    first = await candidate(runtime)
    assert first["status"] == "ready"
    assert not (runtime[0].catalog.directory / "bindings").exists()
    assert (await prepare(runtime, read_only=True))["status"] == "blocked"
    second = await candidate(runtime, operation="install-2", artifact="artifact-2")
    assert second["status"] == "ready"
    assert second["bindingSetId"] != first["bindingSetId"]
    assert first["bindings"] == second["bindings"]
    assert len(runtime[1].rows) == 1
    assert len(list((runtime[0].catalog.directory / "binding-sets").glob("*.json"))) == 2


async def test_candidate_with_legacy_reference_is_reused_by_later_candidate(runtime):
    old = await prepare(runtime)
    first = await candidate(runtime, artifact="artifact-2")
    second = await candidate(runtime, artifact="artifact-3", operation="install-3")
    assert first["bindings"] == second["bindings"] == old["bindings"]
    assert len(runtime[1].rows) == 1


async def test_ready_candidate_never_mutates_its_binding_set_when_requirements_change(runtime):
    first = await candidate(runtime)
    path = runtime[0].catalog.directory / "binding-sets" / (first["bindingSetId"] + ".json")
    before = path.read_bytes()
    runtime[0].catalog.minimum = "2.0.0"
    runtime[1].calls.clear()
    result = await candidate(runtime)
    assert result["status"] == "blocked"
    assert result["code"] == "RESOURCE_NOT_PREPARED"
    assert path.read_bytes() == before
    assert all(method == "GET" for method, _ in runtime[1].calls)


async def test_legacy_uncoordinated_preparation_retries_same_candidate_without_duplicate_create(
    runtime,
):
    runtime[1].fail_upload = True
    failed = await candidate(runtime)
    assert failed["status"] == "blocked"
    path = runtime[0].catalog.directory / "binding-sets" / (failed["bindingSetId"] + ".json")
    assert json.loads(path.read_bytes())["bindingSetStatus"] == "preparing"
    result = await candidate(runtime)
    assert result["status"] == "ready"
    assert result["bindingSetId"] == failed["bindingSetId"]
    assert runtime[1].calls.count(("POST", "/api/agents")) == 1
    assert not (runtime[0].catalog.directory / "bindings").exists()


@pytest.mark.parametrize("change", [{"sub": "consumer-2"}, {"ownership_epoch": 2}])
async def test_same_operation_isolated_by_real_account_and_ownership_epoch(runtime, change):
    first = await candidate(runtime)
    scope = {**runtime[3], **change}
    with pytest.raises(BridgeAuthError, match="RESOURCE_BINDING_SET_SCOPE_MISMATCH"):
        await inspect(runtime, first, scope=scope)
    second = await candidate(runtime, scope=scope)
    assert second["status"] == "ready"
    assert first["bindingSetId"] != second["bindingSetId"]
    assert first["bindings"][0]["instanceId"] != second["bindings"][0]["instanceId"]
    assert (await inspect(runtime, first))["status"] == "ready"


async def test_candidate_cannot_inspect_as_other_artifact(runtime):
    first = await candidate(runtime)
    with pytest.raises(BridgeAuthError, match="RESOURCE_BINDING_SET_SCOPE_MISMATCH"):
        await inspect(runtime, first, artifact="artifact-other")


async def test_authoritative_resolution_must_match_requested_artifact(runtime, monkeypatch):
    original = runtime[0].catalog.resolve

    async def changed(*args, **kwargs):
        return {**await original(*args, **kwargs), "artifactId": "other-artifact"}

    monkeypatch.setattr(runtime[0].catalog, "resolve", changed)
    with pytest.raises(BridgeAuthError, match="RESOURCE_APPLICATION_IDENTITY_MISMATCH"):
        await candidate(runtime)
    assert all(method == "GET" for method, _ in runtime[1].calls)


async def test_failed_candidate_migration_preserves_old_bindings_and_private_files(runtime):
    first = await candidate(runtime)
    path = runtime[0].catalog.directory / "binding-sets" / (first["bindingSetId"] + ".json")
    previous = path.read_bytes()
    old_files = copy.deepcopy(runtime[1].files)
    catalog = runtime[0].catalog
    catalog.package_value, _, catalog.envelope = signed(catalog.private, version="2.0.0")
    catalog.minimum = "2.0.0"
    failed = await candidate(runtime, operation="install-2", artifact="artifact-2")
    assert failed["status"] == "blocked"
    assert failed["code"] == "RESOURCE_MIGRATION_REQUIRED"
    assert path.read_bytes() == previous
    assert runtime[1].files == old_files
    assert len(runtime[1].rows) == 1
    catalog.minimum = "1.0.0"
    assert (await inspect(runtime, first))["status"] == "ready"


async def test_candidate_inspection_never_adopts_pending_shared_binding(runtime):
    first = await candidate(runtime)
    path = runtime[0].catalog.directory / "binding-sets" / (first["bindingSetId"] + ".json")
    value = json.loads(path.read_bytes())
    value["pendingResources"] = value.pop("resources")
    value["resources"] = {}
    value["bindingSetStatus"] = "preparing"
    path.write_bytes(canonical(value))
    before = path.read_bytes()
    runtime[1].calls.clear()
    result = await inspect(runtime, first)
    assert result["status"] == "blocked"
    assert result["code"] == "RESOURCE_NOT_PREPARED"
    assert path.read_bytes() == before
    assert all(method == "GET" for method, _ in runtime[1].calls)


@pytest.mark.parametrize("operation", ["", "../another", "x" * 129, None, True])
async def test_candidate_rejects_invalid_operation_id(runtime, operation):
    with pytest.raises(BridgeAuthError):
        await candidate(runtime, operation=operation)
