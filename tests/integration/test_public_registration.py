"""Public registration shares identity while keeping Zhijun archives explicit."""

from __future__ import annotations

import asyncio
import threading
from typing import Any

import httpx
import pytest

from octop.api.deps import decode_token
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.users.identity import Role, User
from octop.infra.users.manager import UserManager

PASSWORD = "NewAccount12"


async def register(client: Any, **overrides: Any) -> httpx.Response:
    body = {"username": "new-user", "password": PASSWORD, **overrides}
    return await client.post("/api/auth/register", json=body)


async def test_shared_regular_account_starts_without_profile(env: Any) -> None:
    client, server, _auth = env
    agents_before = server.services.agent_repo.list_all(include_disabled=True)
    response = await register(client, username="  new-user  ")
    assert response.status_code == 201, response.text
    payload = response.json()
    user = payload["user"]
    assert user["username"] == "new-user"
    assert user["role"] == "user"
    assert user["permissions"] == []
    assert user["application_id"] == "zhijun"
    assert server.user_manager.get("new-user").application_id == "wanx"
    signed = decode_token(server.services.secret_repo.get("jwt"), payload["access_token"])
    assert signed["application_id"] == "zhijun"
    auth = {"Authorization": f"Bearer {payload['access_token']}"}
    profile = await client.get("/api/zhijun/profile", headers=auth)
    assert profile.status_code == 200
    assert profile.json() == {"profile": None}
    assert server.services.agent_repo.list_all(include_disabled=True) == agents_before
    assert (await client.get("/api/agents/main", headers=auth)).status_code == 404
    wanx_login = await client.post(
        "/api/auth/login", json={"username": "new-user", "password": PASSWORD}
    )
    assert wanx_login.status_code == 200
    assert wanx_login.json()["user"]["id"] == user["id"]
    assert wanx_login.json()["user"]["application_id"] == "wanx"
    wanx_auth = {"Authorization": f"Bearer {wanx_login.json()['access_token']}"}
    assert (await client.get("/api/zhijun/profile", headers=wanx_auth)).status_code == 404
    # Empty management permissions still allow explicit ownership of a main profile.
    created = await client.post("/api/zhijun/profile", headers=auth)
    assert created.status_code == 200, created.text
    profile = created.json()["profile"]
    assert profile["user_id"] == user["id"]
    assert profile["application_id"] == "zhijun"
    assert (
        await client.get(f"/api/agents/{profile['agent_id']}", headers=wanx_auth)
    ).status_code == 404


@pytest.mark.parametrize(
    "overrides",
    [
        {"role": "admin"},
        {"permissions": ["users"]},
        {"application_id": "wanx"},
        {"application_id": "unknown"},
        {"agent_id": "main"},
        {"workspace_dir": "external-workspace"},
        {"memory_path": "existing-memory"},
        {"display_name": "Name"},
        {"email": "new@example.com"},
        {"username": "   "},
        {"username": "u" * 65},
        {"password": ""},
        {"password": "p" * 201},
    ],
)
async def test_untrusted_registration_fields_are_rejected(env: Any, overrides: Any) -> None:
    client, server, _auth = env
    before = server.user_manager.count()
    assert (await register(client, **overrides)).status_code == 422
    assert server.user_manager.count() == before


@pytest.mark.parametrize("password", ["Abc123", "OnlyLetters", "password123"])
async def test_registration_uses_native_password_policy(env: Any, password: str) -> None:
    client, server, _auth = env
    before = server.user_manager.count()
    response = await register(client, password=password)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "PASSWORD_TOO_WEAK"
    assert server.user_manager.count() == before


async def test_concurrent_registration_returns_one_account(env: Any) -> None:
    client, server, _auth = env
    responses = await asyncio.gather(register(client), register(client))
    assert sorted(response.status_code for response in responses) == [201, 409]
    conflict = next(response for response in responses if response.status_code == 409)
    assert conflict.json()["error"]["code"] == "USERNAME_TAKEN"
    assert [row.username for row in server.services.user_repo.list()].count("new-user") == 1


async def test_separate_managers_map_unique_race_to_conflict(
    env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    _client, server, _auth = env
    managers = [UserManager(server.services), UserManager(server.services)]
    original_create = server.services.user_repo.create
    barrier = threading.Barrier(2)

    def racing_insert(**kwargs: Any) -> int:
        if kwargs["username"] == "racing-user":
            barrier.wait(timeout=10)
        return original_create(**kwargs)

    monkeypatch.setattr(server.services.user_repo, "create", racing_insert)

    def create(manager: UserManager) -> User:
        return asyncio.run(
            manager.create(username="racing-user", password=PASSWORD, role=Role.USER)
        )

    results = await asyncio.gather(
        *[asyncio.to_thread(create, manager) for manager in managers], return_exceptions=True
    )
    assert sum(isinstance(result, User) for result in results) == 1
    conflict = next(result for result in results if isinstance(result, OctopError))
    assert conflict.code == ErrorCode.USERNAME_TAKEN
    assert conflict.status == 409


async def test_registered_token_works_on_preexisting_worker(env: Any) -> None:
    client, server, _auth = env
    original = server.user_manager
    second = UserManager(server.services)
    await second.boot()
    response = await register(client)
    auth = {"Authorization": f"Bearer {response.json()['access_token']}"}
    assert second.get("new-user") is None
    server.app_runtime.user_manager = second
    try:
        profile = await client.get("/api/zhijun/profile", headers=auth)
        assert profile.status_code == 200, profile.text
        assert profile.json() == {"profile": None}
        me = await client.get("/api/auth/me", headers=auth)
        assert me.status_code == 200
        assert me.json()["application_id"] == "zhijun"
        assert second.get("new-user").application_id == "wanx"
    finally:
        server.app_runtime.user_manager = original


async def test_worker_cache_miss_does_not_reactivate_disabled_user(env: Any) -> None:
    _client, server, _auth = env
    second = UserManager(server.services)
    await second.boot()
    user = await server.user_manager.create(
        username="disabled-user", password=PASSWORD, role=Role.USER
    )
    await server.user_manager.disable(user.username)
    assert second.get_by_id(user.id) is None
    assert second.get(user.username) is None


async def test_captcha_failures_never_create_user(
    env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from octop.infra.auth import captcha
    from octop.infra.auth.captcha.config import CaptchaEnv

    client, server, _auth = env
    before = server.user_manager.count()
    monkeypatch.setattr(
        captcha,
        "current_env",
        lambda: CaptchaEnv(provider="turnstile", site_key="test-site", secret="test-secret"),
    )
    missing = await register(client)
    assert missing.status_code == 400
    assert missing.json()["error"]["code"] == "CAPTCHA_REQUIRED"
    assert server.user_manager.count() == before
    native_client = httpx.AsyncClient
    verification_calls: list[httpx.Request] = []

    def reject(request: httpx.Request) -> httpx.Response:
        verification_calls.append(request)
        return httpx.Response(200, json={"success": False})

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: native_client(transport=httpx.MockTransport(reject), **kwargs),
    )
    failed = await register(client, captcha_token="bad-token")
    assert failed.status_code == 400
    assert failed.json()["error"]["code"] == "CAPTCHA_FAILED"
    assert len(verification_calls) == 1
    assert server.user_manager.count() == before


async def test_registration_limit_ignores_untrusted_forwarding_headers(env: Any) -> None:
    client, server, _auth = env
    before = server.user_manager.count()
    for attempt in range(20):
        response = await client.post(
            "/api/auth/register",
            json={"username": "new-user", "password": "weak"},
            headers={"X-Forwarded-For": f"forged-client-{attempt}"},
        )
        assert response.status_code == 400
    limited = await register(client)
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "REGISTRATION_RATE_LIMITED"
    assert server.user_manager.count() == before


async def test_registration_cannot_initialize_platform(patched_app_client: Any) -> None:
    client, server, _home = patched_app_client
    response = await register(client)
    assert response.status_code == 503
    assert response.json() == {"setup_required": True}
    assert server.user_manager.count() == 0
    assert server.services.agent_repo.list_all(include_disabled=True) == []


async def test_registration_openapi_is_public_and_typed(env: Any) -> None:
    from octop.api.app import build_app

    _client, server, _auth = env
    schema = build_app(server).openapi()
    operation = schema["paths"]["/api/auth/register"]["post"]
    assert not operation.get("security")
    assert operation["summary"]
    assert operation["responses"]["201"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/RegistrationResponse"
    }
    body = schema["components"]["schemas"]["RegistrationBody"]
    assert body["additionalProperties"] is False
    assert body["required"] == ["username", "password"]
    assert body["properties"]["application_id"]["const"] == "zhijun"
