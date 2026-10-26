"""Business boundary tests independent of the gateway's cryptographic test suite."""

import hashlib
import json
import sqlite3

import httpx
import pytest
from wanx_clipboard.app import create_app
from wanx_clipboard.service import ClipboardService
from wanx_clipboard.upstream import APPLICATION_ID, PREFIX, BusinessError, WanxAPI


class Context:
    def __init__(self, namespace="principal-one", token=None):
        self.principal_namespace = namespace
        self.claims = {"headers": {"spaceLink": token}}
        self.calls = []
        self.active = True

    def require_live(self):
        if not self.active:
            raise BusinessError("LOCAL_DATA_SESSION_REVOKED", 403)

    def child_headers(self, **request):
        self.require_live()
        self.calls.append(request)
        return request["headers"] | {"X-Centuarai-Gateway-Proof": "child-hop"}


def test_required_mode_cannot_start_without_gate(tmp_path):
    with pytest.raises(ValueError, match="configuration is required"):
        create_app(tmp_path / "clipboard", "http://native", local_data_required=True)
    assert not (tmp_path / "clipboard").exists()


def test_child_binds_actual_bytes_and_does_not_inherit_bearer_cookies_or_renewal():
    context = Context()
    requests = []

    def upstream(request):
        requests.append(request)
        return httpx.Response(200, json={"id": "folder"}, headers={
            "X-Octop-Access-Token": "must-not-be-adopted", "Set-Cookie": "account=old-cloud",
        })

    with httpx.Client(
        base_url="http://native", transport=httpx.MockTransport(upstream),
        headers={"Authorization": "Bearer shared-default"}, cookies={"account": "old-cloud"},
        auth=("cloud", "credential"),
    ) as client:
        api = WanxAPI(client, "Bearer old-cloud", context=context)
        assert api.owner() == "centuarai.local-data.clipboard.v1:principal-one"
        assert requests == []
        api.folder()
        data = b"\x89PNG\r\n\x1a\n\x00\xff"
        api.request(PREFIX + "/uploads/" + "a" * 32 + "?offset=0", "PUT", data=data)
        assert api.authorization == "" and api.renewed is None

    assert json.loads(requests[0].content) == {
        "application": APPLICATION_ID, "name": "超级剪贴板",
    }
    for request, signed in zip(requests, context.calls, strict=True):
        assert signed["audience"] == "octop"
        assert signed["raw_target"] == request.url.raw_path.decode("ascii")
        assert signed["body"] == request.content
        assert "authorization" not in request.headers and "cookie" not in request.headers
        assert request.headers["X-Centuarai-Gateway-Proof"] == "child-hop"
    assert requests[1].content == data
    assert requests[1].headers["X-Content-SHA256"] == hashlib.sha256(data).hexdigest()


@pytest.mark.parametrize("route,method,body", [
    ("/api/auth/me", "GET", None),
    ("https://elsewhere/api/personal-space/uploads", "POST", {"space_id": "personal"}),
    (PREFIX + "/../auth/me", "GET", None),
    (PREFIX + "/files/" + "a" * 32 + "?owner=2", "GET", None),
    (PREFIX + "/app-folders", "POST", {"application": "another-app", "name": "other"}),
    (PREFIX + "/uploads", "POST", {"space_id": "shared"}),
    (PREFIX + "/connection-access", "POST", {"action": "write"}),
])
def test_adapter_is_not_a_general_authenticated_proxy(route, method, body):
    context = Context()
    with httpx.Client(base_url="http://native") as client:
        api = WanxAPI(client, "", context=context)
        with pytest.raises(BusinessError, match="LOCAL_DATA_SCOPE_DENIED"):
            api.request(route, method, body=body)
    assert context.calls == []


def test_agent_requires_exact_signed_link_and_preserves_task_policy_checks():
    context = Context(token="signed-space-link")
    requests = []

    def upstream(request):
        requests.append(json.loads(request.content))
        assert request.headers["X-Space-Link"] == "signed-space-link"
        return httpx.Response(200, json={"sync": {"revision": 4, "options": {"context": True}}})

    with httpx.Client(base_url="http://native", transport=httpx.MockTransport(upstream)) as client:
        api = WanxAPI(client, "", context=context)
        with pytest.raises(BusinessError, match="SPACE_APPROVAL_REQUIRED"):
            api.agent_token("different-link")
        token = api.agent_token("signed-space-link")
        with pytest.raises(BusinessError, match="SPACE_CONTEXT_REQUIRED"):
            api.check_agent(token, {})
        with pytest.raises(BusinessError, match="SPACE_SYNC_POLICY_CHANGED"):
            api.check_agent(token, {"task_id": "task", "policy_revision": 3})
        api.check_agent(token, {"task_id": "task", "policy_revision": 4})
        assert requests[-1] == {"action": "stat", "task_id": "task", "policy_revision": 4}


def test_revocation_during_upstream_response_does_not_return_data():
    context = Context()

    def upstream(request):
        context.active = False
        return httpx.Response(200, json={"private": "content"})

    with httpx.Client(base_url="http://native", transport=httpx.MockTransport(upstream)) as client:
        api = WanxAPI(client, "", context=context)
        with pytest.raises(BusinessError, match="LOCAL_DATA_SESSION_REVOKED"):
            api.metadata("a" * 32)


def test_principal_metadata_is_separate_from_other_principals_and_legacy_uid(tmp_path):
    with httpx.Client(base_url="http://native") as client:
        api = WanxAPI(client, "", context=Context("first"))
        first = ClipboardService(tmp_path, api.owner(), api, {})
        legacy = ClipboardService(tmp_path, "1", WanxAPI(client, "Bearer legacy"), {})
        other_api = WanxAPI(client, "", context=Context("second"))
        second = ClipboardService(tmp_path, other_api.owner(), other_api, {})
        assert len({first.directory, legacy.directory, second.directory}) == 3
        with first._db() as db:
            db.execute("UPDATE clipboard_meta SET revision=99")
        assert legacy.clipboard_list()["revision"] == 0
        assert second.clipboard_list()["revision"] == 0
        assert first.clipboard_list()["revision"] == 99


def test_revocation_rolls_back_local_manifest_and_blocks_cross_space_export(tmp_path):
    context = Context()
    with httpx.Client(base_url="http://native") as client:
        api = WanxAPI(client, "", context=context)
        store = ClipboardService(tmp_path, api.owner(), api, {})
        with pytest.raises(BusinessError, match="LOCAL_DATA_SCOPE_DENIED"):
            store.clipboard_export("a" * 32, 1, "b" * 32, "", "shared")
        with pytest.raises(BusinessError, match="LOCAL_DATA_SESSION_REVOKED"), store._db() as db:
            db.execute("UPDATE clipboard_meta SET revision=42")
            context.active = False
        with sqlite3.connect(store.directory / "clipboard.sqlite3") as db:
            assert db.execute("SELECT revision FROM clipboard_meta").fetchone()[0] == 0
        assert context.calls == []
