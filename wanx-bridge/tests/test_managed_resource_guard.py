import copy
import json

import pytest

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.managed_resource_guard import (
    CONTROLLED_MARKER,
    SHARED_MARKER,
    ManagedResourceGuard,
)


class Admin:
    def __init__(self):
        self.rows = {
            "gray": {"id": "gray", "description": CONTROLLED_MARKER + "nonce"},
            "ordinary": {"id": "ordinary", "description": "Created by a customer"},
            "legacy": {"id": "legacy", "description": "wanx-resource:old-stable-nonce"},
        }
        self.calls = []

    async def request(self, method, path):
        self.calls.append((method, path))
        return copy.deepcopy(self.rows[path.rsplit("/", 1)[1]])


@pytest.fixture
def guard():
    return ManagedResourceGuard(Admin())


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/api/skill-packages/gray"),
        ("HEAD", "/api/skill-packages/gray/"),
        ("GET", "/api/skill-packages/gray/skills"),
        ("GET", "/api/skill-packages/gray/skills/example"),
        ("PUT", "/api/skill-packages/gray/skills/example"),
        ("POST", "/api/skill-packages/gray/skills"),
        ("DELETE", "/api/skill-packages/gray"),
        ("PATCH", "/api/skill-packages/gray"),
        ("POST", "/api/agents/my-private-expert/skill-packages/gray/copy"),
    ],
)
async def test_native_reads_copy_and_all_mutations_reject_internal_controlled_package(
    guard, method, path
):
    # A PATCH clearing the marker cannot make a managed package public.
    with pytest.raises(BridgeAuthError) as error:
        await guard.inspect_request(method, path, b'{"description":"public"}')
    assert error.value.code == "RESOURCE_MANAGED_PACKAGE_PRIVATE"
    assert error.value.status == 403


@pytest.mark.parametrize(
    "method,path,value",
    [
        ("POST", "/api/agents", {"skill_package_ids": ["gray"]}),
        ("PATCH", "/api/agents/mine", {"config": {"skill_package_ids": ["gray"]}}),
        ("PUT", "/api/agents/mine/skill-packages", {"package_ids": ["gray"]}),
        ("POST", "/api/agents/from-expert/template", {"skill_package_ids": ["gray"]}),
        ("POST", "/api/experts/published/template/install", {"skill_package_ids": ["gray"]}),
        ("POST", "/api/experts/hub/template/install", {"skill_package_ids": ["gray"]}),
        ("POST", "/api/agents/mine/skills/hello/push-to-package", {"package_id": "gray"}),
    ],
)
async def test_mount_and_creation_cannot_bypass_native_global_package_guard(
    guard, method, path, value
):
    assert guard.needs_body(method, path)
    with pytest.raises(BridgeAuthError) as error:
        await guard.inspect_request(method, path, json.dumps(value).encode())
    assert error.value.code == "RESOURCE_MANAGED_PACKAGE_PRIVATE"


async def test_all_accounts_see_only_native_or_historical_stable_packages(guard):
    source = list(guard.admin.rows.values())
    filtered = await guard.filter_response("GET", "/api/skill-packages/", source)
    assert [row["id"] for row in filtered] == ["ordinary", "legacy"]
    assert len(source) == 3
    assert guard.admin.calls == []
    mounts = {"package_ids": ["gray", "ordinary", "missing"], "packages": source[:2]}
    filtered_mounts = await guard.filter_response("GET", "/api/agents/mine/skill-packages", mounts)
    assert filtered_mounts == {"package_ids": ["ordinary"], "packages": [source[1]]}


async def test_native_and_historical_stable_packages_remain_accessible(guard):
    await guard.inspect_request("GET", "/api/skill-packages/ordinary/skills/example")
    await guard.inspect_request("POST", "/api/agents/mine/skill-packages/legacy/copy")
    await guard.inspect_request(
        "POST", "/api/agents", b'{"skill_package_ids":["ordinary","legacy"]}'
    )
    assert {path.rsplit("/", 1)[1] for _, path in guard.admin.calls} == {"ordinary", "legacy"}


async def test_metadata_is_rechecked_and_never_cached_across_requests(guard):
    await guard.inspect_request("GET", "/api/skill-packages/ordinary")
    guard.admin.rows["ordinary"]["description"] = CONTROLLED_MARKER + "now-managed"
    with pytest.raises(BridgeAuthError):
        await guard.inspect_request("GET", "/api/skill-packages/ordinary")
    assert len(guard.admin.calls) == 2


@pytest.mark.parametrize("path", ["/api/skill-packages", "/api/skill-packages/ordinary"])
async def test_native_user_cannot_forge_reserved_internal_marker(guard, path):
    method = "POST" if path == "/api/skill-packages" else "PATCH"
    with pytest.raises(BridgeAuthError) as error:
        await guard.inspect_request(
            method, path, json.dumps({"description": CONTROLLED_MARKER + "fake"}).encode()
        )
    assert error.value.code == "RESOURCE_MANAGED_PACKAGE_PRIVATE"


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/api/agents/mine/avatar"),
        ("POST", "/api/agents/mine/workspace/upload"),
        ("POST", "/api/chat"),
        ("GET", "/api/skill-packages/hub/search"),
        ("POST", "/api/skill-packages/from-skillhub"),
        ("GET", "/api/agents/mine/status"),
    ],
)
async def test_unrelated_native_routes_do_not_inspect_or_buffer_customer_content(
    guard, method, path
):
    assert not guard.needs_body(method, path)
    assert not guard.needs_response(method, path)
    await guard.inspect_request(method, path, b"This is not JSON")
    assert guard.admin.calls == []


@pytest.mark.parametrize("value", [None, {"description": None}, {"id": "gray"}])
async def test_missing_package_metadata_never_bypasses_guard(guard, value):
    guard.admin.rows["gray"] = value
    with pytest.raises(BridgeAuthError) as error:
        await guard.inspect_request("GET", "/api/skill-packages/gray")
    assert error.value.code == "RESOURCE_UPSTREAM_RESPONSE_INVALID"


@pytest.mark.parametrize("body", [b"not json", b"[]", b'{"package_ids":[null]}'])
async def test_invalid_mount_request_is_not_forwarded(guard, body):
    with pytest.raises(BridgeAuthError):
        await guard.inspect_request("PUT", "/api/agents/mine/skill-packages", body)


@pytest.fixture
def shared_guard(guard):
    guard.admin.rows["shared"] = {"id": "shared", "description": SHARED_MARKER + "immutable"}
    return guard


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/api/skill-packages/shared"),
        ("HEAD", "/api/skill-packages/shared"),
        ("GET", "/api/skill-packages/shared/skills"),
        ("GET", "/api/skill-packages/shared/skills/example"),
        ("POST", "/api/agents/my-private-expert/skill-packages/shared/copy"),
    ],
)
async def test_stable_shared_pool_allows_read_and_private_copy(shared_guard, method, path):
    await shared_guard.inspect_request(method, path)
    rows = await shared_guard.filter_response(
        "GET", "/api/skill-packages", list(shared_guard.admin.rows.values())
    )
    assert "shared" in {row["id"] for row in rows}
    assert "gray" not in {row["id"] for row in rows}


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("DELETE", "/api/skill-packages/shared", {}),
        ("PATCH", "/api/skill-packages/shared", {"description": "ordinary"}),
        ("PUT", "/api/skill-packages/shared/skills/example", {"content": "changed"}),
        ("POST", "/api/skill-packages/shared/skills", {"name": "changed"}),
        ("PUT", "/api/agents/mine/skill-packages", {"package_ids": ["shared"]}),
        ("POST", "/api/agents", {"config": {"skill_package_ids": ["shared"]}}),
        ("PATCH", "/api/agents/mine", {"config": {"skill_package_ids": ["shared"]}}),
        ("POST", "/api/agents/mine/skills/example/push-to-package", {"package_id": "shared"}),
        ("DELETE", "/api/agents/mine/skill-packages/shared/copy", {}),
    ],
)
async def test_shared_source_cannot_be_mutated_or_mounted(shared_guard, method, path, body):
    with pytest.raises(BridgeAuthError) as error:
        await shared_guard.inspect_request(method, path, json.dumps(body).encode())
    assert error.value.code == "RESOURCE_MANAGED_PACKAGE_READ_ONLY"


async def test_native_user_cannot_forge_shared_marker(guard):
    with pytest.raises(BridgeAuthError):
        await guard.inspect_request(
            "POST",
            "/api/skill-packages",
            json.dumps({"description": SHARED_MARKER + "fake"}).encode(),
        )
