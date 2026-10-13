"""Exercise real JWT verification and product authorization without a live box."""

import time
from types import SimpleNamespace

import httpx
import jwt
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from octop.api.deps import decode_token, sign_token
from octop.api.middleware.jwt_auth import install as install_jwt
from octop.api.routers.auth_application import router
from octop.infra.errors import OctopError
from octop.infra.users.identity import User

EXCHANGE_PATH = "/api/auth/application/exchange"

SECRET = b"application-exchange-test-secret-is-not-a-real-key"


class Products:
    exists = True
    enabled = True
    grants = {17}

    def get(self, application_id):
        return SimpleNamespace(capabilities=[]) if self.exists else None

    def deployment(self, application_id):
        return {"enabled": self.enabled}

    def user_access(self, application_id, uid):
        return uid in self.grants


@pytest.fixture
def environment():
    users = {
        17: User(17, "alice", "user", "Alice"),
        18: User(18, "bob", "admin", "Bob"),
    }
    products = Products()
    server = SimpleNamespace(
        _started=True,
        user_manager=SimpleNamespace(get_by_id=users.get),
        services=SimpleNamespace(
            secret_repo=SimpleNamespace(get=lambda name: SECRET),
            config=SimpleNamespace(access_token_ttl_seconds=3600),
            application_repo=products,
        ),
    )
    app = FastAPI()
    app.state.octop_server = server

    @app.exception_handler(OctopError)
    async def error_handler(request, exc):
        return JSONResponse(status_code=exc.status, content=exc.to_envelope())

    app.include_router(router, prefix="/api/auth", tags=["auth"])
    app.mount("/", FastAPI())
    return app, server, products, users


def token(*, uid=17, scope="wanx", ttl=600, secret=SECRET):
    return sign_token(
        secret, sub=uid, uname="stale-name", role="admin", application_id=scope, ttl_seconds=ttl
    )


async def exchange(app, bearer=None, body=None, query=""):
    headers = {"Authorization": "Bearer " + bearer} if bearer else {}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://box"
    ) as client:
        return await client.post(
            EXCHANGE_PATH + query,
            headers=headers,
            json=body if body is not None else {"application_id": "super-advisory"},
        )


@pytest.mark.asyncio
async def test_real_token_narrows_same_identity_and_never_extends_parent(environment):
    app, server, _, _ = environment
    parent = token(ttl=120)
    response = await exchange(app, parent)
    assert response.status_code == 200
    result = response.json()
    scoped = decode_token(SECRET, result["access_token"])
    assert scoped["sub"] == 17
    assert scoped["role"] == "user"  # Current DB role, not stale source claims.
    assert scoped["uname"] == "alice"
    assert scoped["application_id"] == "super-advisory"
    assert scoped["exp"] <= decode_token(SECRET, parent)["exp"]
    assert 0 < result["expires_in"] <= 120
    assert result["user"]["id"] == 17
    assert result["user"]["application_id"] == "super-advisory"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bearer",
    [None, "not-a-jwt", token(secret=b"wrong-signing-key-at-least-32-bytes"), token(ttl=-1)],
)
async def test_rejects_missing_invalid_and_expired_credentials(environment, bearer):
    assert (await exchange(environment[0], bearer)).status_code == 401


@pytest.mark.asyncio
async def test_query_and_cached_identity_are_not_credentials(environment):
    app = environment[0]

    @app.middleware("http")
    async def spoof_cached_user(request, call_next):
        request.state.octop_user = User(17, "alice", "admin", "Alice")
        return await call_next(request)

    assert (await exchange(app, query="?access_token=" + token())).status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"application_id": "super-advisory", "uid": 18},
        {"application_id": "super-advisory", "user_id": 18},
        {"application_id": "super-advisory", "role": "admin"},
        {"application_id": "wanx"},
        {"application_id": "zhijun"},
        {},
    ],
)
async def test_body_cannot_choose_identity_role_or_other_scope(environment, body):
    assert (await exchange(environment[0], token(), body)).status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["zhijun", "super-advisory", "another-product"])
async def test_product_tokens_cannot_exchange_again(environment, scope):
    assert (await exchange(environment[0], token(scope=scope))).status_code == 403


@pytest.mark.asyncio
async def test_other_users_cannot_borrow_grant_even_if_admin(environment):
    app, _, _, _ = environment
    assert (await exchange(app, token(uid=18))).status_code == 403
    assert (await exchange(app, token(uid=999))).status_code == 403


@pytest.mark.asyncio
async def test_product_and_account_revocations_take_effect_on_each_exchange(environment):
    app, _, products, users = environment
    assert (await exchange(app, token())).status_code == 200
    products.enabled = False
    assert (await exchange(app, token())).status_code == 403
    products.enabled = True
    products.grants = set()
    assert (await exchange(app, token())).status_code == 403
    products.grants = {17}
    products.exists = False
    assert (await exchange(app, token())).status_code == 401
    products.exists = True
    del users[17]
    assert (await exchange(app, token())).status_code == 403


@pytest.mark.asyncio
async def test_missing_expiry_and_bad_subject_fail_closed(environment):
    for claims in ({"sub": "17"}, {"sub": "not-an-id", "exp": int(time.time()) + 300}):
        bearer = jwt.encode(claims, SECRET, algorithm="HS256")
        assert (await exchange(environment[0], bearer)).status_code == 401


@pytest.mark.asyncio
async def test_configured_ttl_is_also_a_ceiling(environment):
    app, server, _, _ = environment
    server.services.config.access_token_ttl_seconds = 45
    result = (await exchange(app, token())).json()
    assert result["expires_in"] <= 45


@pytest.mark.asyncio
async def test_route_works_behind_native_middleware_and_scoped_token_is_rejected(environment):
    app, server, _, _ = environment
    install_jwt(app, server)
    response = await exchange(app, token())
    assert response.status_code == 200
    assert (await exchange(app, response.json()["access_token"])).status_code == 404
    assert (await exchange(app)).status_code == 401


def test_exchange_has_typed_openapi_request_and_response(environment):
    schema = environment[0].openapi()
    operation = schema["paths"][EXCHANGE_PATH]["post"]
    assert operation["summary"]
    assert operation["requestBody"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "/ApplicationExchangeBody"
    )
    assert operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "/ApplicationExchangeResponse"
    )
