"""Default companions belong to the signed-in account, never another user's workspace."""

import json

import httpx
import pytest

from wanx_bridge.admin_client import AdminClient, BridgeUpstreamError
from wanx_bridge.zhijun_bootstrap import ensure_private_expert

UID = 7
AID = f"centuarai-zhijun-{UID}"
CREATE = "/api/agents/from-expert/zhijun-personal-companion"


def expert(**changes):
    return {
        "agent_id": AID,
        "user_id": UID,
        "name": "知君 · 私人伙伴",
        "is_shared": False,
        "kind": "agent",
        **changes,
    }


class Adapter:
    _json = staticmethod(AdminClient._json)

    def __init__(self, rows=(), active=None, created=None, create_status=201):
        self.rows = list(rows)
        self.active = (
            {"provider_name": "local", "model": "configured-model"} if active is None else active
        )
        self.created = expert() if created is None else created
        self.create_status = create_status
        self.calls = []

    async def _request(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        assert kwargs["headers"]["Authorization"] == "Bearer user-session"
        if (method, path) == ("GET", "/api/agents?scope=mine"):
            return httpx.Response(200, json=self.rows)
        if (method, path) == ("GET", "/api/providers/active-model"):
            return httpx.Response(200, json=self.active)
        if (method, path) == ("POST", CREATE):
            if self.create_status == 201:
                self.rows.append(self.created)
            return httpx.Response(self.create_status, json=self.created)
        if (method, path) == ("GET", f"/api/agents/{AID}"):
            return httpx.Response(200, json=self.created)
        raise AssertionError(f"Unexpected API call: {method} {path}")


async def test_creates_private_companion_with_current_model_and_repeated_login_is_idempotent():
    adapter = Adapter()
    await ensure_private_expert(adapter, "user-session", UID)
    await ensure_private_expert(adapter, "user-session", UID)
    posts = [call for call in adapter.calls if call[0] == "POST"]
    assert len(posts) == 1
    body = posts[0][2]["json"]
    assert body["agent_id"] == AID
    assert "知君" in body["name"]
    assert body["default_model"] == "local/configured-model"
    assert body["backend"] == {"type": "filesystem", "virtual_mode": True}
    for field in ("knowledge_base_ids", "mcp_servers", "skill_package_ids"):
        assert body[field] == []
    assert not body.get("is_shared")
    assert "user_id" not in body
    assert not body.get("file_overrides")
    assert all(call[0] not in {"PUT", "PATCH", "DELETE"} for call in adapter.calls)


async def test_keeps_existing_personal_expert_and_model_untouched():
    existing = expert(agent_id="my-own-zhijun", default_model="my/custom-model")
    adapter = Adapter(rows=[existing])
    await ensure_private_expert(adapter, "user-session", UID)
    assert [(method, path) for method, path, _ in adapter.calls] == [
        ("GET", "/api/agents?scope=mine")
    ]
    assert adapter.rows == [existing]


@pytest.mark.parametrize(
    "unusable",
    [
        expert(agent_id="another-private", user_id=99),
        expert(agent_id="another-shared", user_id=99, is_shared=True),
        expert(agent_id="own-shared", is_shared=True),
        expert(agent_id="own-team", kind="team"),
        expert(agent_id="zhijun-lan-user-7-old"),
        expert(agent_id="zhijun-role-old"),
        expert(agent_id="general", name="General assistant"),
    ],
)
async def test_does_not_adopt_shared_other_account_team_or_internal_role(unusable):
    adapter = Adapter(rows=[unusable])
    await ensure_private_expert(adapter, "user-session", UID)
    assert len([call for call in adapter.calls if call[0] == "POST"]) == 1
    assert adapter.rows[0] == unusable
    assert all(call[0] not in {"PUT", "PATCH", "DELETE"} for call in adapter.calls)


async def test_no_active_model_does_not_invent_or_mutate_provider_configuration():
    adapter = Adapter(active={"provider_name": "", "model": ""})
    await ensure_private_expert(adapter, "user-session", UID)
    body = next(kwargs["json"] for method, _, kwargs in adapter.calls if method == "POST")
    assert not body.get("default_model")
    assert not body.get("providers")
    assert all(path != "/api/admin/providers" for _, path, _ in adapter.calls)


async def test_concurrent_create_conflict_rechecks_exact_private_ownership():
    adapter = Adapter(create_status=409)
    await ensure_private_expert(adapter, "user-session", UID)
    assert adapter.calls[-1][:2] == ("GET", f"/api/agents/{AID}")


@pytest.mark.parametrize("status", [201, 409])
@pytest.mark.parametrize(
    "bad",
    [
        expert(user_id=99),
        expert(is_shared=True),
        expert(kind="team"),
        expert(agent_id="different-agent"),
    ],
)
async def test_create_or_conflict_never_accepts_foreign_or_shared_instance(status, bad):
    adapter = Adapter(create_status=status, created=bad)
    with pytest.raises(BridgeUpstreamError):
        await ensure_private_expert(adapter, "user-session", UID)
    assert all(call[0] not in {"PUT", "PATCH", "DELETE"} for call in adapter.calls)


@pytest.mark.parametrize("status", [401, 403, 404, 500, 503])
async def test_failed_list_never_creates_fallback(status):
    adapter = Adapter()

    async def failed(method, path, **kwargs):
        adapter.calls.append((method, path, kwargs))
        return httpx.Response(status, json={"detail": "upstream failure"})

    adapter._request = failed
    with pytest.raises(BridgeUpstreamError):
        await ensure_private_expert(adapter, "user-session", UID)
    assert len(adapter.calls) == 1


@pytest.mark.parametrize("body", [{}, None, ["unexpected"]])
async def test_invalid_list_never_creates_fallback(body):
    adapter = Adapter()

    async def invalid(method, path, **kwargs):
        adapter.calls.append((method, path, kwargs))
        return httpx.Response(
            200, content=json.dumps(body), headers={"Content-Type": "application/json"}
        )

    adapter._request = invalid
    with pytest.raises(BridgeUpstreamError):
        await ensure_private_expert(adapter, "user-session", UID)
    assert len(adapter.calls) == 1


async def test_invalid_json_never_creates_fallback_or_leaks_response():
    adapter = Adapter()

    async def invalid(method, path, **kwargs):
        adapter.calls.append((method, path, kwargs))
        return httpx.Response(200, text="unexpected private upstream details")

    adapter._request = invalid
    with pytest.raises(BridgeUpstreamError) as exc:
        await ensure_private_expert(adapter, "user-session", UID)
    assert "private upstream" not in str(exc.value)
    assert len(adapter.calls) == 1


@pytest.mark.parametrize("bad", [expert(user_id=99), expert(is_shared=True), expert(kind="team")])
async def test_reserved_id_conflict_does_not_repurpose_existing_expert(bad):
    adapter = Adapter(rows=[bad])
    with pytest.raises(BridgeUpstreamError):
        await ensure_private_expert(adapter, "user-session", UID)
    assert all(method == "GET" for method, _, _ in adapter.calls)


@pytest.mark.parametrize("status", [401, 403, 404, 500])
async def test_failed_create_does_not_claim_ready_or_modify_other_resources(status):
    adapter = Adapter(create_status=status)
    with pytest.raises(BridgeUpstreamError):
        await ensure_private_expert(adapter, "user-session", UID)
    assert adapter.calls[-1][:2] == ("POST", CREATE)
