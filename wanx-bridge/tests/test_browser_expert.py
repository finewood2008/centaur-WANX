import asyncio
import copy
import json
import multiprocessing
import os
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from wanx_bridge.browser_expert import APPLICATION, BrowserExpertPreparer, browser_configuration
from wanx_bridge.config import BridgeAuthError
from wanx_bridge.server import create_app


def configuration():
    # Keep the Bridge suite runnable without sibling application checkouts.
    return {
        "configuration": {
            "name": "万象浏览器",
            "description": "浏览器助手",
            "default_model": None,
            "is_shared": False,
            "icon_name": "globe",
            "color": "#A75E43",
            "welcome_message": "告诉我你想在网页上做什么。",
            "mcp_servers": [],
            "knowledge_base_ids": [],
            "skill_package_ids": [],
            "config": {
                "wanx_browser_expert": {"application_id": APPLICATION, "version": 1},
                "tools_disabled": [
                    "execute",
                    "read_env_file",
                    "write_env_file",
                    "write_file",
                    "edit_file",
                    "cronjob_create",
                ],
                "skills_disabled": [],
                "enable_trajectory": False,
                "backend": {"type": "filesystem", "virtual_mode": True},
            },
            "system_prompt": "Use the browser tools provided by this application.",
        }
    }


def row(uid=7, **extra):
    return {
        "agent_id": f"browser-{uid}",
        "user_id": uid,
        "is_owner": True,
        "is_shared": False,
        "application_id": "wanx",
        "kind": "expert",
        "name": "我的浏览器",
        "config": {"wanx_browser_expert": {"application_id": APPLICATION, "version": 1}},
        **extra,
    }


async def live():
    return None


class Native:
    def __init__(self):
        self.rows = []
        self.posts = []
        self.behavior = "created"

    async def request(self, method, path, **kwargs):
        if path == "/api/auth/me":
            return httpx.Response(200, json={"id": 7, "application_id": "wanx"})
        if method == "GET":
            return httpx.Response(200, json=self.rows)
        assert path == "/api/agents"
        self.posts.append(kwargs["json"])
        await asyncio.sleep(0.01)
        if self.behavior == "denied":
            return httpx.Response(403)
        if self.behavior == "conflict":
            return httpx.Response(409)
        if self.behavior == "pending":
            raise httpx.ReadTimeout("response lost before commit")
        self.rows.append(row())
        if self.behavior == "lost":
            raise httpx.ReadTimeout("response lost after commit")
        return httpx.Response(201, json=self.rows[-1])


async def test_separate_preparers_coordinate_and_preserve_existing_configuration(tmp_path):
    native = Native()
    user = {"id": 7, "application_id": "wanx"}
    first, second = BrowserExpertPreparer(tmp_path), BrowserExpertPreparer(tmp_path)
    results = await asyncio.gather(
        *(item.ensure(configuration(), user, native.request, live) for item in (first, second))
    )
    assert results[0] == results[1]
    assert len(native.posts) == 1
    native.rows[0]["config"]["customer_setting"] = "preserve"
    before = copy.deepcopy(native.rows[0])
    assert await second.ensure(configuration(), user, native.request, live) == before
    assert len(native.posts) == 1


async def test_lost_response_reconciles_and_unknown_result_survives_restart_without_repost(
    tmp_path,
):
    native, user = Native(), {"id": 7}
    native.behavior = "pending"
    with pytest.raises(BridgeAuthError, match="BROWSER_EXPERT_PREPARATION_PENDING"):
        await BrowserExpertPreparer(tmp_path).ensure(configuration(), user, native.request, live)
    with pytest.raises(BridgeAuthError, match="BROWSER_EXPERT_PREPARATION_PENDING"):
        await BrowserExpertPreparer(tmp_path).ensure(configuration(), user, native.request, live)
    assert len(native.posts) == 1
    native.rows.append(row())  # The original native operation eventually commits.
    assert (
        await BrowserExpertPreparer(tmp_path).ensure(configuration(), user, native.request, live)
        == row()
    )
    assert not list((tmp_path / "browser-experts").glob("*.pending"))
    assert len(native.posts) == 1


async def test_committed_post_with_lost_response_is_recovered(tmp_path):
    native = Native()
    native.behavior = "lost"
    assert (
        await BrowserExpertPreparer(tmp_path).ensure(
            configuration(), {"id": 7}, native.request, live
        )
        == row()
    )
    assert len(native.posts) == 1


@pytest.mark.parametrize("error", [httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout])
async def test_failure_before_sending_clears_intent_and_can_retry_after_recovery(tmp_path, error):
    native, user = Native(), {"id": 7}

    async def disconnected_request(method, path, **kwargs):
        if method == "POST":
            raise error("internal connection diagnostic must not be returned")
        return await native.request(method, path, **kwargs)

    with pytest.raises(BridgeAuthError, match="BROWSER_EXPERT_UNAVAILABLE") as exc:
        await BrowserExpertPreparer(tmp_path).ensure(
            configuration(), user, disconnected_request, live
        )
    assert "internal connection" not in str(exc.value)
    assert not native.posts
    assert not list((tmp_path / "browser-experts").glob("*.pending"))
    assert (
        await BrowserExpertPreparer(tmp_path).ensure(configuration(), user, native.request, live)
        == row()
    )
    assert len(native.posts) == 1


@pytest.mark.parametrize("error", [httpx.ReadTimeout, httpx.WriteTimeout, httpx.WriteError])
async def test_failure_after_possible_send_retains_intent_and_never_reposts(tmp_path, error):
    native, user, attempts = Native(), {"id": 7}, []

    async def uncertain_request(method, path, **kwargs):
        if method == "POST":
            attempts.append(method)
            raise error("request may have been committed")
        return await native.request(method, path, **kwargs)

    with pytest.raises(BridgeAuthError, match="BROWSER_EXPERT_PREPARATION_PENDING"):
        await BrowserExpertPreparer(tmp_path).ensure(configuration(), user, uncertain_request, live)
    assert len(list((tmp_path / "browser-experts").glob("*.pending"))) == 1
    with pytest.raises(BridgeAuthError, match="BROWSER_EXPERT_PREPARATION_PENDING"):
        await BrowserExpertPreparer(tmp_path).ensure(configuration(), user, native.request, live)
    assert attempts == ["POST"]
    assert not native.posts
    native.rows.append(row())
    assert (
        await BrowserExpertPreparer(tmp_path).ensure(configuration(), user, native.request, live)
        == row()
    )
    assert not native.posts
    assert not list((tmp_path / "browser-experts").glob("*.pending"))


async def test_definite_prewrite_rejection_can_retry_but_unknown_conflict_cannot(tmp_path):
    native, user = Native(), {"id": 7}
    preparer = BrowserExpertPreparer(tmp_path)
    native.behavior = "denied"
    with pytest.raises(BridgeAuthError, match="BROWSER_EXPERT_CREATE_FAILED"):
        await preparer.ensure(configuration(), user, native.request, live)
    assert not list((tmp_path / "browser-experts").glob("*.pending"))
    native.behavior = "conflict"
    with pytest.raises(BridgeAuthError, match="BROWSER_EXPERT_PREPARATION_PENDING"):
        await preparer.ensure(configuration(), user, native.request, live)
    native.behavior = "created"
    with pytest.raises(BridgeAuthError, match="BROWSER_EXPERT_PREPARATION_PENDING"):
        await preparer.ensure(configuration(), user, native.request, live)
    assert len(native.posts) == 2


@pytest.mark.parametrize(
    "existing,code",
    [
        ([row(is_shared=True)], "BROWSER_EXPERT_OWNERSHIP_CONFLICT"),
        ([row(kind="team")], "BROWSER_EXPERT_OWNERSHIP_CONFLICT"),
        ([row(is_owner=False)], "BROWSER_EXPERT_OWNERSHIP_CONFLICT"),
        ([row(), row(agent_id="duplicate")], "BROWSER_EXPERT_AMBIGUOUS"),
        ([row(name="万象浏览器", config={})], "BROWSER_EXPERT_NAME_CONFLICT"),
    ],
)
async def test_conflicting_existing_sources_are_never_adopted_or_modified(tmp_path, existing, code):
    native = Native()
    native.rows = existing
    with pytest.raises(BridgeAuthError, match=code):
        await BrowserExpertPreparer(tmp_path).ensure(
            configuration(), {"id": 7}, native.request, live
        )
    assert not native.posts
    assert native.rows == existing


@pytest.mark.parametrize(
    "mutate",
    [
        lambda b: b.update(user_id=9),
        lambda b: b["configuration"].update(user_id=9),
        lambda b: b["configuration"].update(is_shared=True),
        lambda b: b["configuration"].update(default_model="unreviewed/provider"),
        lambda b: b["configuration"]["config"]["backend"].update(root_dir="/private"),
        lambda b: b["configuration"]["config"]["backend"].update(virtual_mode=1),
        lambda b: b["configuration"]["config"].update(providers=[{"api_key": "secret"}]),
        lambda b: b["configuration"]["config"].update(tools_disabled=[]),
        lambda b: b["configuration"].update(system_prompt="x" * 32769),
    ],
)
def test_configuration_rejects_identity_credentials_storage_and_unsafe_shape(mutate):
    body = configuration()
    mutate(body)
    with pytest.raises(BridgeAuthError, match="BROWSER_EXPERT_CONFIGURATION_INVALID"):
        browser_configuration(body)


async def test_state_symlink_is_rejected_without_post(tmp_path):
    native = Native()
    other = tmp_path / "other"
    other.mkdir()
    (tmp_path / "browser-experts").symlink_to(other, target_is_directory=True)
    with pytest.raises(BridgeAuthError, match="BROWSER_EXPERT_STATE_UNAVAILABLE"):
        await BrowserExpertPreparer(tmp_path).ensure(
            configuration(), {"id": 7}, native.request, live
        )
    assert not native.posts
    assert not list(other.iterdir())


async def test_busy_wait_is_bounded_and_cancelled_creation_keeps_intent(tmp_path):
    native, user = Native(), {"id": 7}
    preparer = BrowserExpertPreparer(tmp_path, lock_timeout=0.01)
    entered = asyncio.Event()

    async def slow_request(method, path, **kwargs):
        if method == "POST":
            entered.set()
            await asyncio.Event().wait()
        return await native.request(method, path, **kwargs)

    creation = asyncio.create_task(preparer.ensure(configuration(), user, slow_request, live))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        with pytest.raises(BridgeAuthError, match="BROWSER_EXPERT_BUSY"):
            await preparer.ensure(configuration(), user, native.request, live)
    finally:
        creation.cancel()
        with pytest.raises(asyncio.CancelledError):
            await creation
    with pytest.raises(BridgeAuthError, match="BROWSER_EXPERT_PREPARATION_PENDING"):
        await preparer.ensure(configuration(), user, native.request, live)
    assert not native.posts


async def test_route_uses_only_current_upstream_token_and_rechecks_authority(tmp_path):
    class Auth:
        config = SimpleNamespace(state_dir=tmp_path)
        valid = True
        session = SimpleNamespace(
            user={"id": 7, "application_id": "wanx"}, upstream_token="user-token"
        )

        def authorize(self, token):
            if token != "opaque":
                raise BridgeAuthError()
            return self.session

        def assert_live(self, session):
            if not self.valid:
                raise BridgeAuthError("LEASE_EXPIRED")

    native, auth = Native(), Auth()

    async def transport(request):
        assert request.headers["authorization"] == "Bearer user-token"
        assert "cookie" not in request.headers
        arguments = {"json": json.loads(request.content)} if request.method == "POST" else {}
        return await native.request(request.method, request.url.path, **arguments)

    app = create_app(auth, object(), http_transport=httpx.MockTransport(transport))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://box") as client,
    ):
        path = "/api/platform/browser/expert/ensure"
        assert (await client.post(path, json=configuration())).status_code == 401
        headers = {"authorization": "Bearer opaque", "cookie": "never-forward=secret"}
        prepared = await client.post(path, json=configuration(), headers=headers)
        assert prepared.status_code == 200, prepared.text
        assert prepared.json() == row()
        assert prepared.headers["cache-control"] == "no-store"
        auth.session.user["application_id"] = "super-advisory"
        assert (await client.post(path, json=configuration(), headers=headers)).status_code == 403
        auth.session.user["application_id"] = "wanx"
        auth.valid = False
        assert (await client.post(path, json=configuration(), headers=headers)).status_code == 401
        assert len(native.posts) == 1


def _process_prepare(directory, queue):
    directory = Path(directory)

    async def request(method, path, **kwargs):
        if path == "/api/auth/me":
            return httpx.Response(200, json={"id": 7, "application_id": "wanx"})
        saved = directory / "native.json"
        if method == "GET":
            return httpx.Response(200, json=json.loads(saved.read_text()) if saved.exists() else [])
        with (directory / "posts.log").open("a") as stream:
            stream.write("POST\n")
        await asyncio.sleep(0.15)
        saved.write_text(json.dumps([row()]))
        return httpx.Response(201, json=row())

    async def run():
        return await BrowserExpertPreparer(directory).ensure(
            configuration(), {"id": 7}, request, live
        )

    try:
        queue.put(asyncio.run(run())["agent_id"])
    except Exception as exc:
        queue.put(str(exc))


@pytest.mark.skipif(os.name != "posix", reason="Linux box file-lock protocol")
async def test_two_real_processes_cannot_create_duplicate_browser_experts(tmp_path):
    context = multiprocessing.get_context("spawn")
    queue = context.Queue()
    processes = [
        context.Process(target=_process_prepare, args=(str(tmp_path), queue)) for _ in range(2)
    ]
    try:
        for process in processes:
            process.start()
        for process in processes:
            await asyncio.to_thread(process.join, 10)
            assert process.exitcode == 0
        assert [queue.get(timeout=2) for _ in processes] == ["browser-7", "browser-7"]
        assert (tmp_path / "posts.log").read_text().splitlines() == ["POST"]
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(2)
        queue.close()


@pytest.mark.usefixtures("setup_auth")
async def test_ensure_through_real_unmodified_octop_api(real_octop, oidc_server, setup_auth):
    from test_auth import issue

    from wanx_bridge.upstream import OctopAdapter

    upstream, _, credentials = real_octop
    auth, key, _ = setup_auth
    transport = httpx.ASGITransport(app=upstream._octop_app)
    adapter = OctopAdapter("http://127.0.0.1:18088", oidc_server, credentials, transport=transport)
    try:
        await adapter.initialize()
        parent = await auth.exchange(issue(auth, key), adapter)
        app = create_app(auth, adapter, http_transport=transport)
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://box",
                headers={"authorization": "Bearer " + parent["access_token"]},
            ) as client,
        ):
            results = await asyncio.gather(
                *(
                    client.post("/api/platform/browser/expert/ensure", json=configuration())
                    for _ in range(2)
                )
            )
            assert all(result.status_code == 200 for result in results), [
                result.text for result in results
            ]
            assert results[0].json()["agent_id"] == results[1].json()["agent_id"]
            created = results[0].json()
            assert created["user_id"] == parent["user"]["id"]
            assert created["is_shared"] is False
            assert created["config"]["wanx_browser_expert"]["application_id"] == APPLICATION
            assert (
                created["config"]["tools_disabled"]
                == configuration()["configuration"]["config"]["tools_disabled"]
            )
            agents = (await client.get("/api/agents?scope=mine")).json()
            assert (
                len(
                    [
                        agent
                        for agent in agents
                        if agent.get("config", {}).get("wanx_browser_expert")
                    ]
                )
                == 1
            )
    finally:
        await adapter.close()


pytest_plugins = ["test_auth", "test_upstream"]
