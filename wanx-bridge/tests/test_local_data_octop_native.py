"""Run in the Octop environment: real gate, SQL mapping and native dependencies."""

import hashlib
import secrets
from types import SimpleNamespace

import httpx
import pytest

pytest.importorskip("octop")
from centuarai_local_data_gate.protocol import encode, principal_namespace, sign_gateway_request
from fastapi import Depends, FastAPI
from octop.api.common import local_data
from octop.api.deps import current_user
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.local_data_principals import LocalDataPrincipalRepo
from octop.infra.db.repos.users import UserRepo
from test_local_data_gate import native as native


@pytest.fixture
def installed(native, tmp_path, monkeypatch):
    config, key, proof, state, _, broker = native
    import centuarai_local_data_gate.middleware as middleware

    monkeypatch.setenv("OCTOP_LOCAL_DATA_MODE", "required")
    monkeypatch.setattr(local_data, "load_required_policy", lambda: None)
    monkeypatch.setattr(local_data.GateConfig, "load", lambda *a, **k: config)
    monkeypatch.setattr(middleware, "BrokerClient", lambda _: broker)
    db = SqlitePool(tmp_path / "native.sqlite")
    run_migrations(db)
    users = {}
    rows = {}
    server = SimpleNamespace(
        _started=True,
        services=SimpleNamespace(
            local_data_principal_repo=LocalDataPrincipalRepo(db), user_repo=UserRepo(db)
        ),
        user_manager=SimpleNamespace(
            get_by_id=users.get, register_cached_user=lambda user: users.setdefault(user.id, user)
        ),
        app_runtime=SimpleNamespace(agent_registry=SimpleNamespace(get_row=rows.get)),
    )
    app = FastAPI()
    app.state.octop_server = server

    @app.get("/api/auth/me")
    async def me(user=Depends(current_user)):
        return {"id": user.id, "role": user.role, "local": user.local_data}

    @app.get("/api/agents/{agent_id}")
    async def agent(agent_id, user=Depends(current_user)):
        return {"id": agent_id, "owner": user.id}

    local_data.install(app, server)
    proof.update(
        method="GET",
        rawTarget="/api/auth/me",
        action="read",
        bodyBytes=0,
        bodySha256=encode(hashlib.sha256(b"").digest()),
    )
    proof["headers"]["contentType"] = None
    yield app, server, rows, proof, key, db
    db.close()


def headers(proof, key):
    proof["jti"] = secrets.token_urlsafe(32)
    proof["operationId"] = secrets.token_urlsafe(32)
    return {"X-Centuarai-Gateway-Proof": sign_gateway_request(proof, key)}


async def test_two_principals_real_native_uid_no_jwt_or_admin(installed):
    app, server, rows, proof, key, db = installed
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://native"
    ) as client:
        first = await client.get("/api/auth/me", headers=headers(proof, key))
        assert first.status_code == 200, first.text
        assert first.json()["role"] == "user" and first.json()["local"] is True
        first_uid = first.json()["id"]
        repeated = await client.get("/api/auth/me", headers=headers(proof, key))
        assert repeated.json()["id"] == first_uid
        proof["principalId"] = "second"
        proof["serviceContext"]["principalNamespace"] = principal_namespace(
            proof["boxKeyThumbprint"], 1, "second"
        )
        second = await client.get("/api/auth/me", headers=headers(proof, key))
        assert second.status_code == 200 and second.json()["id"] != first_uid
        assert (
            await client.get("/api/auth/me", headers={"Authorization": "Bearer old-native-jwt"})
        ).status_code == 403
        assert (await client.get("/api/auth/me?access_token=old-native-jwt")).status_code == 403
    with db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM local_data_principals").fetchone()[0] == 2
        assert (
            conn.execute(
                "SELECT count(*) FROM users WHERE password_hash IS NOT NULL OR role='admin'"
            ).fetchone()[0]
            == 0
        )


async def test_legacy_shared_agent_does_not_cross_local_principals(installed):
    app, server, rows, proof, key, db = installed
    rows["shared"] = SimpleNamespace(
        agent_id="shared", user_id=999, is_shared=1, application_id="wanx"
    )
    proof["rawTarget"] = "/api/agents/shared"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://native"
    ) as client:
        response = await client.get("/api/agents/shared", headers=headers(proof, key))
        assert response.status_code == 403


@pytest.mark.parametrize(
    "path",
    [
        "/api/auth/login",
        "/api/auth/oidc/callback",
        "/api/admin/users",
        "/api/terminal",
        "/api/mobile-stream/ws",
        "/api/desktop-stream/ws",
    ],
)
async def test_signed_data_grant_does_not_reenable_native_admin_entry(installed, path):
    app, server, rows, proof, key, db = installed
    proof["rawTarget"] = path
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://native"
    ) as client:
        assert (await client.get(path, headers=headers(proof, key))).status_code == 403
