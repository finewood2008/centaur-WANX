"""Actual native ES256 admission, SQL users, company APIs and mounted Studio.

The transport fixture signs broker leases; native verification, current_user,
team permissions, publication records and runtime decisions are production code.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import importlib
import json
import secrets
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from centuarai_local_data_gate.observations import observed_headers
from centuarai_local_data_gate.protocol import encode, principal_namespace, sign_gateway_request
from tests.integration.team_identity.test_cross_runtime import bridge as bridge
from tests.integration.team_identity.test_real_enrollment import history as history

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def native(tmp_path):
    directory = str(ROOT / "wanx-bridge/tests")
    if directory not in sys.path:
        sys.path.insert(0, directory)
    return importlib.import_module("test_local_data_gate").native.__wrapped__(tmp_path)


@pytest.fixture
def installed(native, tmp_path, monkeypatch):
    setup = importlib.import_module("test_local_data_octop_native")
    fixture = setup.installed.__wrapped__(native, tmp_path, monkeypatch)
    try:
        yield next(fixture)
    finally:
        fixture.close()


@pytest.fixture
async def studio(installed, native, tmp_path):
    from wanx_studio.runner import Runner
    from wanx_studio.service import StudioService
    from wanx_studio.wanx import mount_wanx

    from octop.api.routers.applications import router
    from octop.infra.db.services import RepoBundle

    app, server, _, initial, key, database = installed
    server.services = RepoBundle.from_pool(database)
    server.paths = SimpleNamespace(root=tmp_path / "octop")
    app.include_router(router, prefix="/api")
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://native")

    async def request(
        method,
        path,
        *,
        body=None,
        principal="manager",
        application="wanx-host",
        resource="team:management",
        action=None,
        manager=True,
        data_context=None,
    ):
        raw = b"" if body is None else json.dumps(body, separators=(",", ":")).encode()
        headers = {"Content-Type": "application/json"} if body is not None else {}
        if data_context is not None:
            headers["X-Wanx-Data-Context"] = data_context
        proof = copy.deepcopy(initial)
        moment = int(time.time() * 1000)
        proof.update(
            schemaVersion=2,
            jti=secrets.token_urlsafe(32),
            operationId=secrets.token_urlsafe(32),
            issuedAtMs=moment,
            expiresAtMs=moment + 2000,
            principalId=principal,
            applicationId=application,
            method=method,
            rawTarget=path,
            resourceId=resource,
            action=action or ("read" if method == "GET" else "write"),
            bodyBytes=len(raw),
            bodySha256=encode(hashlib.sha256(raw).digest()),
            headers=observed_headers(headers),
        )
        proof["serviceContext"]["principalNamespace"] = principal_namespace(
            proof["boxKeyThumbprint"], proof["ownershipEpoch"], principal
        )
        proof["team"] = {
            "schemaVersion": 1,
            "boxId": proof["boxId"],
            "ownershipEpoch": proof["ownershipEpoch"],
            "principalId": principal,
            "membershipId": encode(hashlib.sha256(principal.encode()).digest()),
            "membershipRevision": 1,
            "roleId": "manager" if manager else "member",
            "permissions": ["applications.manage", "members.read", "resources.manage"]
            if manager
            else [],
        }
        headers["X-Centuarai-Gateway-Proof"] = sign_gateway_request(proof, key)
        return await client.request(method, path, content=raw, headers=headers)

    namespace = principal_namespace(
        initial["boxKeyThumbprint"], initial["ownershipEpoch"], "manager"
    )
    uid = server.services.local_data_principal_repo.resolve(
        namespace, initial["boxKeyThumbprint"], initial["ownershipEpoch"], "manager"
    )
    owner = "wanx:" + str(uid)
    service = StudioService(tmp_path / "studio", ROOT / "wanx-studio")
    service.runner = Runner(service)
    # A local deterministic sample supplies artifact bytes, without any model or cloud call.
    project = service.store.create(owner, "Approved company app", "Private draft", uuid4().hex)
    project = await service.runner.example(owner, project["id"], uuid4().hex)
    artifact = project["artifacts"][-1]
    service.accept(
        owner,
        project["id"],
        {
            "operationId": uuid4().hex,
            "artifactHash": artifact["hash"],
            "criteria": list(range(len(project["solution"]["acceptance"]))),
            "confirmedByUser": True,
        },
    )
    server._wanx_studio_service = service
    mount_wanx(app, server, ROOT / "wanx-studio")
    manager = await request("GET", "/api/auth/me")
    assert manager.status_code == 200, manager.text
    assert manager.json()["role"] == "user" and manager.json()["id"] == uid
    application = project["appId"]
    created = await request(
        "POST",
        "/api/admin/applications",
        body={"application_id": application, "name": "Approved company app"},
    )
    assert created.status_code == 201, created.text
    deployment = {
        "enabled": False,
        "configuration": {
            "studio_team": {
                "projectId": project["id"],
                "artifactHash": artifact["hash"],
                "audience": "all",
            }
        },
    }
    path = "/api/admin/applications/" + application + "/deployment"
    configured = await request("PUT", path, body=deployment)
    assert configured.status_code == 200, configured.text
    sealed = await request(
        "POST",
        "/api/app-studio/projects/" + project["id"] + "/installed",
        application="ai.wanx.studio",
        body={
            "operationId": uuid4().hex,
            "artifactHash": artifact["hash"],
            "applicationId": application,
            "version": artifact["version"],
        },
    )
    assert sealed.status_code == 200, sealed.text
    deployment["enabled"] = True
    enabled = await request("PUT", path, body=deployment)
    assert enabled.status_code == 200, enabled.text
    try:
        yield SimpleNamespace(
            app=app,
            server=server,
            client=client,
            request=request,
            service=service,
            application=application,
            artifact=artifact,
            database=database,
            state=native[3],
        )
    finally:
        await client.aclose()
        await service.close()
        await native[-1].close()


async def open_runtime(studio):
    resource = "team:application:" + studio.application
    response = await studio.request(
        "POST",
        "/api/app-studio/apps/" + studio.application + "/runtime",
        principal="ordinary-member",
        manager=False,
        application=studio.application,
        resource=resource,
        data_context=resource,
        action="execute",
        body={"artifactHash": studio.artifact["hash"], "environment": "production"},
    )
    assert response.status_code == 200, response.text
    return response.json()["session"]


async def test_real_member_install_and_dynamic_runtime_do_not_grant_management(studio):
    resource = "team:application:" + studio.application
    installed = await studio.request(
        "GET",
        "/api/app-studio/apps/" + studio.application + "/install",
        principal="ordinary-member",
        manager=False,
        resource=resource,
        data_context=resource,
    )
    assert installed.status_code == 200, installed.text
    assert installed.json()["applicationId"] == studio.application
    assert not ({"owner", "solution", "preparation", "acceptance"} & installed.json().keys())
    session = await open_runtime(studio)
    result = await studio.request(
        "POST",
        "/api/app-studio/runtime/" + session + "/invoke",
        principal="ordinary-member",
        manager=False,
        application=studio.application,
        resource=resource,
        data_context=resource,
        action="execute",
        body={"method": "data.list", "params": {"collection": "items"}},
    )
    assert result.status_code == 200, result.text
    other = "ai.wanx.selfmade." + "f" * 32
    for method, path, body in (
        ("GET", "/api/admin/applications", None),
        ("GET", "/api/app-studio/projects", None),
        (
            "POST",
            "/api/app-studio/apps/" + other + "/runtime",
            {"artifactHash": studio.artifact["hash"], "environment": "production"},
        ),
    ):
        denied = await studio.request(
            method,
            path,
            body=body,
            principal="ordinary-member",
            manager=False,
            application=studio.application,
            resource=resource,
            data_context=resource,
            action="execute" if method == "POST" else "read",
        )
        assert denied.status_code == 403, denied.text
    with studio.database.connect() as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM users WHERE role='admin' OR password_hash IS NOT NULL"
            ).fetchone()[0]
            == 0
        )


async def test_real_runtime_rechecks_company_revocation_and_native_device_revocation(studio):
    resource = "team:application:" + studio.application
    session = await open_runtime(studio)
    member = await studio.request(
        "GET",
        "/api/auth/me",
        principal="ordinary-member",
        manager=False,
        application=studio.application,
        resource=resource,
        data_context=resource,
    )
    assert member.status_code == 200, member.text
    studio.server.services.application_repo.put_access(
        studio.application, member.json()["id"], False
    )
    response = await studio.request(
        "POST",
        "/api/app-studio/runtime/" + session + "/invoke",
        principal="ordinary-member",
        manager=False,
        application=studio.application,
        resource=resource,
        data_context=resource,
        action="execute",
        body={"method": "data.list", "params": {"collection": "items"}},
    )
    assert response.status_code == 404, response.text
    studio.state["revoked"] = True
    response = await studio.request(
        "GET",
        "/api/auth/me",
        principal="ordinary-member",
        manager=False,
        application=studio.application,
        resource=resource,
        data_context=resource,
    )
    assert response.status_code == 403
    assert (
        await studio.client.get("/api/auth/me", headers={"Authorization": "Bearer cloud-token"})
    ).status_code == 403


async def test_actual_ledger_revocation_cancels_real_gate_task_only_after_io_drains(
    history, tmp_path, monkeypatch
):
    """No authorization stub: real ledger, session engine, signed broker and native GateTask."""
    from centuarai_local_data_gate import GateConfig
    from centuarai_local_data_gate.client import BrokerClient, GateTaskContext
    from centuarai_local_data_gate.protocol import DataProtocolError, public_jwk
    from fastapi import Depends, FastAPI
    from wanx_bridge import local_data_protocol as wire
    from wanx_bridge.local_data_routes import application_policy, route_policy
    from wanx_bridge.local_data_sessions import LocalDataSessions
    from wanx_studio.local_authority import LocalStudioAuthority, to_thread

    from octop.api.common import local_data
    from octop.api.deps import current_user
    from octop.infra.db.migrate import run_migrations
    from octop.infra.db.pool import SqlitePool
    from octop.infra.db.services import RepoBundle

    setup = importlib.import_module("test_local_team")
    harness_module = importlib.import_module("test_local_data_sessions")
    ledger = history.ledger
    ledger.team = setup.activate_team(ledger)
    target = setup.invite_member(ledger, role="manager")
    setup.admit_member(ledger, target)
    harness = harness_module.Harness()

    class RealtimeClock:
        @property
        def wall(self):
            return int(time.time() * 1000)

    harness.clock = RealtimeClock()
    harness.access, harness.box = target.access, ledger.authority._key
    harness.view = ledger.authority.get_authorization(target.binding_id, harness.clock.wall // 1000)
    sessions = LocalDataSessions(
        authority=ledger.authority,
        execute_authority=asyncio.to_thread,
        box_id=harness.view["boxId"],
        box_key_thumbprint=harness.view["boxKeyThumbprint"],
        gateway_id="gateway:test",
        application_policy=application_policy,
        route_policy=route_policy,
        box_response_signer=lambda kind, body, now: wire.sign_data_response(
            harness.box, box_id=harness.view["boxId"], kind=kind, body=body, now_ms=now
        ),
        gateway_signer=lambda payload: wire.sign_gateway_request(payload, harness.gateway),
        gateway_verifier=lambda proof, now: wire.verify_gateway_request(
            proof, public_jwk(harness.gateway), now
        ),
        gateway_lease_signer=lambda payload: wire.sign_gateway_lease(payload, harness.gateway),
        gateway_task_signer=lambda payload: wire.sign_gateway_task(payload, harness.gateway),
        gateway_observation_signer=lambda payload: wire.sign_gateway_observation(
            payload, harness.gateway
        ),
    )
    harness.service = sessions
    harness.session = harness.response(
        await sessions.create_session(await harness.session_proof("ai.wanx.studio")), "session"
    )
    project, task_id = uuid4().hex, uuid4().hex
    path = "/api/app-studio/projects/" + project + "/build"
    operation, proof = await harness.operation(
        applicationId="ai.wanx.studio", method="POST", rawTarget=path
    )
    directory = tmp_path / "native-task"
    directory.mkdir(mode=0o700)
    config = GateConfig(
        "octop",
        "gateway:test",
        public_jwk(harness.gateway),
        harness.view["boxId"],
        harness.view["boxKeyThumbprint"],
        str(directory / "unused.sock"),
        directory,
    )
    methods = {
        "admit": sessions.native_admit,
        "activate": sessions.native_activate,
        "check": sessions.native_check,
        "closed": sessions.native_closed,
        "observe": sessions.native_observe,
        "task-start": sessions.native_task_start,
        "task-check": sessions.native_task_check,
        "task-close": sessions.native_task_close,
    }

    async def dispatch(request):
        method = request.url.path.rsplit("/", 1)[1]
        try:
            response = await methods[method](json.loads(request.content), audience="octop")
            return httpx.Response(200, text=response)
        except DataProtocolError as error:
            return httpx.Response(403, json={"code": error.code})

    loop = asyncio.get_running_loop()

    def synchronous(request):
        return asyncio.run_coroutine_threadsafe(dispatch(request), loop).result(timeout=2)

    broker = BrokerClient(
        config,
        async_transport=httpx.MockTransport(dispatch),
        sync_transport=httpx.MockTransport(synchronous),
    )
    import centuarai_local_data_gate.middleware as middleware

    monkeypatch.setenv("OCTOP_LOCAL_DATA_MODE", "required")
    monkeypatch.setattr(local_data, "load_required_policy", lambda: None)
    monkeypatch.setattr(local_data.GateConfig, "load", lambda *a, **k: config)
    monkeypatch.setattr(middleware, "BrokerClient", lambda _: broker)
    database = SqlitePool(tmp_path / "task-native.sqlite")
    run_migrations(database)
    cache = {}
    server = SimpleNamespace(
        _started=True,
        services=RepoBundle.from_pool(database),
        user_manager=SimpleNamespace(
            get_by_id=cache.get,
            register_cached_user=lambda value: cache.setdefault(value.id, value),
        ),
        app_runtime=SimpleNamespace(agent_registry=SimpleNamespace(get_row=lambda _: None)),
    )
    app = FastAPI()
    app.state.octop_server = server
    authority = LocalStudioAuthority(server.services, lambda: True)
    entered, parent_closed, continued = asyncio.Event(), asyncio.Event(), asyncio.Event()
    thread_started, drain = threading.Event(), threading.Event()
    captured = {}

    def blocking_io():
        thread_started.set()
        assert drain.wait(timeout=5), "test thread was not drained"

    current_dependency = Depends(current_user)

    @app.post(path)
    async def build(user=current_dependency):
        assert user.role == "user" and not user.is_admin
        owner = "wanx:" + str(user.id)
        token = authority.enter(user)
        captured["request_context"] = user.local_team_context

        async def work():
            context = authority.context(owner)
            assert isinstance(context, GateTaskContext)
            captured["task_context"] = context
            entered.set()
            await parent_closed.wait()
            await context.check()
            continued.set()
            await to_thread(blocking_io)

        try:
            captured["task"] = await authority.spawn(owner, project, task_id, "build", work)
            await entered.wait()
            return {"accepted": True}
        finally:
            authority.reset(token)

    local_data.install(app, server)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://native"
        ) as client:
            response = await client.post(
                path, headers={"X-Centuarai-Gateway-Proof": proof}, content=b""
            )
        assert response.status_code == 200, response.text
        await sessions.finish_operation(operation["operationId"], transport_closed=True)
        with pytest.raises(DataProtocolError):
            captured["request_context"].check_cached()
        parent_closed.set()
        await asyncio.wait_for(continued.wait(), 2)
        assert await asyncio.to_thread(thread_started.wait, 2)
        record = sessions._operations[captured["task_context"].claims["operationId"]]
        assert record["nativeClosed"] is False
        now = int(time.time())
        review = history.setup.prepare(
            ledger, "team.member-revoke", {"principalId": target.payload["principalId"]}, now=now
        )
        history.setup.commit(ledger, review, now=now)
        await sessions.invalidate_authority()
        await asyncio.sleep(0.4)
        assert record["nativeClosed"] is False and sessions._reserved(record)
        drain.set()
        result = await asyncio.wait_for(asyncio.gather(captured["task"], return_exceptions=True), 2)
        assert isinstance(result[0], asyncio.CancelledError)
        assert record["nativeClosed"] is True and not sessions._reserved(record)
    finally:
        drain.set()
        if "task" in captured and not captured["task"].done():
            captured["task"].cancel()
            await asyncio.gather(captured["task"], return_exceptions=True)
        await broker.close()
        await sessions.close()
        database.close()
