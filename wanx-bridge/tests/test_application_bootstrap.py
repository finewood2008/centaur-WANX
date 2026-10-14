"""Box policy grants only the authenticated platform user's own application access."""

import json

import httpx
import pytest

from wanx_bridge.application_bootstrap import ensure_application_access
from wanx_bridge.upstream import BridgeUpstreamError, OctopAdapter

APP = "super-advisory"
DEPLOYMENT = f"/api/admin/applications/{APP}/deployment"
ACCESS = f"/api/admin/applications/{APP}/access"
ME = "/api/auth/me"
ERROR = "BOX_APPLICATION_BOOTSTRAP_FAILED"


@pytest.fixture
def upstream():
    class State:
        def __init__(self):
            self.me = {
                "id": 7,
                "application_id": "wanx",
                "has_password": False,
                "sso_identities": [{"kind": "oidc"}],
            }
            self.deployment = {
                "application_id": APP,
                "enabled": True,
                "configuration": {"auto_grant_box_users": True},
            }
            self.access = [{"user_id": 19, "enabled": False}]
            self.calls = []
            self.overrides = {}
            self.persist = True
            self.revoke_on_put = False

        def handle(self, request):
            self.calls.append(request)
            method, path = request.method, request.url.path
            expected = "user-token" if path == ME else "admin"
            assert request.headers["authorization"] == f"Bearer {expected}"
            assert "cookie" not in request.headers
            if (method, path) in self.overrides:
                return self.overrides[method, path]
            if (method, path) == ("GET", ME):
                return httpx.Response(200, json=self.me)
            if (method, path) == ("GET", DEPLOYMENT):
                return httpx.Response(200, json=self.deployment)
            if (method, path) == ("GET", ACCESS):
                return httpx.Response(200, json=self.access)
            if (method, path) == ("PUT", ACCESS):
                data = json.loads(request.content)
                assert data == {"user_id": 7, "enabled": True, "only_if_missing": True}
                data.pop("only_if_missing")
                if self.revoke_on_put:
                    data["enabled"] = False
                if self.persist:
                    self.access.append(data)
                return httpx.Response(200, json=data)
            raise AssertionError(f"Unexpected API call: {method} {path}")

    return State()


@pytest.fixture
async def adapter(tmp_path, upstream):
    value = OctopAdapter(
        "http://127.0.0.1:18088",
        None,
        tmp_path / "unused-credentials",
        transport=httpx.MockTransport(upstream.handle),
    )
    value._admin_token = "admin"
    value._admin_id = 1
    value._users = {"platform-subject": 7}
    yield value
    await value.close()


def writes(upstream):
    return [request for request in upstream.calls if request.method != "GET"]


async def test_grants_only_verified_account_and_repeated_access_is_idempotent(adapter, upstream):
    assert await ensure_application_access(adapter, "user-token", APP) is True
    assert await ensure_application_access(adapter, "user-token", APP) is True
    assert len(writes(upstream)) == 1
    assert upstream.access == [
        {"user_id": 19, "enabled": False},
        {"user_id": 7, "enabled": True},
    ]
    calls = [(request.method, request.url.path) for request in upstream.calls]
    assert calls[:5] == [
        ("GET", ME),
        ("GET", DEPLOYMENT),
        ("GET", ACCESS),
        ("PUT", ACCESS),
        ("GET", ACCESS),
    ]


@pytest.mark.parametrize("application_id", ["wanx", "zhijun", "unregistered", "../access"])
async def test_unknown_app_cannot_trigger_admin_requests(adapter, upstream, application_id):
    assert await ensure_application_access(adapter, "user-token", application_id) is False
    assert upstream.calls == []


async def test_conditional_grant_preserves_revocation_racing_with_write(adapter, upstream):
    upstream.revoke_on_put = True
    assert await ensure_application_access(adapter, "user-token", APP) is False
    assert upstream.access[-1] == {"user_id": 7, "enabled": False}


@pytest.mark.parametrize(
    "changes",
    [
        {"id": 1},
        {"id": 19},
        {"id": 0},
        {"id": -1},
        {"id": True},
        {"id": "7"},
        {"application_id": APP},
        {"application_id": None},
        {"has_password": True},
        {"has_password": 0},
        {"sso_identities": []},
        {"sso_identities": [{"kind": "oauth"}]},
    ],
)
async def test_unverified_or_non_platform_identity_is_not_granted(adapter, upstream, changes):
    upstream.me.update(changes)
    assert await ensure_application_access(adapter, "user-token", APP) is False
    assert not writes(upstream)
    assert all(request.url.path == ME for request in upstream.calls)


async def test_oidc_profile_alone_is_not_enough_without_bridge_login_mapping(adapter, upstream):
    adapter._users.clear()
    assert await ensure_application_access(adapter, "user-token", APP) is False
    assert not writes(upstream)


@pytest.mark.parametrize(
    "deployment",
    [
        {"enabled": False, "configuration": {"auto_grant_box_users": True}},
        {"enabled": "true", "configuration": {"auto_grant_box_users": True}},
        {"enabled": True, "configuration": {"auto_grant_box_users": False}},
        {"enabled": True, "configuration": {"auto_grant_box_users": "true"}},
        {"enabled": True, "configuration": {"auto_grant_box_users": 1}},
        {"enabled": True, "configuration": {}},
    ],
)
async def test_missing_or_disabled_auto_grant_policy_does_not_grant(adapter, upstream, deployment):
    upstream.deployment = deployment
    assert await ensure_application_access(adapter, "user-token", APP) is False
    assert not writes(upstream)
    assert not any(request.url.path == ACCESS for request in upstream.calls)


async def test_unregistered_deployment_is_not_created_on_user_access(adapter, upstream):
    upstream.overrides["GET", DEPLOYMENT] = httpx.Response(404)
    assert await ensure_application_access(adapter, "user-token", APP) is False
    assert not writes(upstream)


@pytest.mark.parametrize("status", [401, 403])
async def test_rejected_user_session_does_not_call_admin_api(adapter, upstream, status):
    upstream.overrides["GET", ME] = httpx.Response(status)
    assert await ensure_application_access(adapter, "user-token", APP) is False
    assert [(request.method, request.url.path) for request in upstream.calls] == [("GET", ME)]


@pytest.mark.parametrize("enabled", [True, False])
async def test_preserves_existing_grant_and_explicit_revocation(adapter, upstream, enabled):
    upstream.access.append({"user_id": 7, "enabled": enabled})
    assert await ensure_application_access(adapter, "user-token", APP) is enabled
    assert not writes(upstream)
    assert upstream.access[-1] == {"user_id": 7, "enabled": enabled}


async def test_successful_write_requires_readback_confirmation(adapter, upstream):
    upstream.persist = False
    with pytest.raises(BridgeUpstreamError, match=f"^{ERROR}$") as caught:
        await ensure_application_access(adapter, "user-token", APP)
    assert caught.value.status == 503
    assert len(writes(upstream)) == 1
    assert upstream.access == [{"user_id": 19, "enabled": False}]


@pytest.mark.parametrize(
    "rows",
    [
        [None],
        [{"user_id": "7", "enabled": True}],
        [{"user_id": 7, "enabled": "true"}],
        [{"user_id": 7, "enabled": True}, {"user_id": 7, "enabled": False}],
    ],
)
async def test_invalid_or_ambiguous_access_rows_cannot_trigger_grant(adapter, upstream, rows):
    upstream.access = rows
    with pytest.raises(BridgeUpstreamError, match=f"^{ERROR}$"):
        await ensure_application_access(adapter, "user-token", APP)
    assert not writes(upstream)


@pytest.mark.parametrize("path", [ME, DEPLOYMENT, ACCESS])
@pytest.mark.parametrize("payload", ["invalid-json", "wrong-shape"])
async def test_invalid_json_or_response_shape_is_safe_error(adapter, upstream, path, payload):
    content = (
        "private upstream diagnostic"
        if payload == "invalid-json"
        else ("{}" if path == ACCESS else "[]")
    )
    upstream.overrides["GET", path] = httpx.Response(200, text=content)
    with pytest.raises(BridgeUpstreamError, match=f"^{ERROR}$") as caught:
        await ensure_application_access(adapter, "user-token", APP)
    assert caught.value.status == 503
    assert "private upstream" not in str(caught.value)
    assert not writes(upstream)


@pytest.mark.parametrize(
    "method,path,status",
    [
        ("GET", ME, 500),
        ("GET", DEPLOYMENT, 500),
        ("GET", ACCESS, 404),
        ("PUT", ACCESS, 403),
        ("PUT", ACCESS, 500),
    ],
)
async def test_upstream_failure_is_reported_without_secrets(
    adapter, upstream, method, path, status
):
    upstream.overrides[method, path] = httpx.Response(
        status, json={"detail": "private password admin-token user-token"}
    )
    with pytest.raises(BridgeUpstreamError, match=f"^{ERROR}$") as caught:
        await ensure_application_access(adapter, "user-token", APP)
    assert caught.value.status == 503
    assert str(caught.value) == ERROR
    assert upstream.access == [{"user_id": 19, "enabled": False}]
