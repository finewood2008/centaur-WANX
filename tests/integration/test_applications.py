"""Product lifecycle, server-owned privileges, and isolation of private instances."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from starlette.websockets import WebSocketDisconnect

from octop.api.deps import resolve_user_from_token
from octop.infra.errors import OctopError
from tests.support.app import octop_client
from tests.support.auth import (
    auth_header,
    bearer,
    bootstrap_admin,
    create_user,
    seed_openai_provider,
)
from tests.support.http import ws_connect, ws_token


@pytest.fixture
async def products(tmp_octop_home: Path) -> AsyncIterator[Any]:
    async with octop_client(tmp_octop_home) as (client, server):
        await bootstrap_admin(client, tmp_octop_home)
        admin = await auth_header(client)
        await seed_openai_provider(client, admin)
        regular = await create_user(client, admin, username="reader")
        developer = await create_user(
            client, admin, username="builder", permissions=["applications_develop"]
        )
        second = await create_user(
            client, admin, username="builder2", permissions=["applications_develop"]
        )
        yield client, server, admin, regular, developer, second


async def register_product(
    client: Any, auth: dict[str, str], application_id: str = "example.product"
) -> dict[str, Any]:
    result = await client.post(
        "/api/admin/applications",
        headers=auth,
        json={
            "application_id": application_id,
            "name": "Example",
            "capabilities": ["chat", "memory", "knowledge"],
            "agent_template": {
                "default_model": "openai/gpt-4o",
                "system_prompt": "Private synthetic example",
            },
            "resource_requirements": {"default_model": {"kind": "model"}},
        },
    )
    assert result.status_code == 201, result.text
    return result.json()


async def grant_product(
    client: Any,
    server: Any,
    admin: dict[str, str],
    username: str,
    application_id: str = "example.product",
) -> dict[str, str]:
    deployment = await client.put(
        f"/api/admin/applications/{application_id}/deployment",
        headers=admin,
        json={
            "enabled": True,
            "resource_bindings": {"default_model": "openai/gpt-4o"},
            "configuration": {},
        },
    )
    assert deployment.status_code == 200, deployment.text
    access = await client.put(
        f"/api/admin/applications/{application_id}/access",
        headers=admin,
        json={"user_id": server.user_manager.get(username).id, "enabled": True},
    )
    assert access.status_code == 200
    login = await client.post(
        "/api/auth/login",
        json={"username": username, "password": "TestPass12", "application_id": application_id},
    )
    assert login.status_code == 200, login.text
    return bearer(login.json()["access_token"])


async def test_management_permission_and_developer_ownership(products: Any) -> None:
    client, _server, admin, regular, developer, second = products
    assert (await client.get("/api/admin/applications", headers=regular)).status_code == 403
    own = await register_product(client, developer)
    assert own["connection_identity"] == {
        "status": "pending",
        "application_id": "example.product",
        "remote_enabled": False,
    }
    assert (await client.get("/api/admin/applications", headers=second)).json() == []
    assert (
        await client.patch(
            "/api/admin/applications/example.product", headers=second, json={"name": "stolen"}
        )
    ).status_code == 404
    assert (
        await client.get("/api/admin/applications/example.product", headers=admin)
    ).status_code == 200
    assert (
        await client.post(
            "/api/admin/applications",
            headers=developer,
            json={"application_id": "example.product", "name": "duplicate"},
        )
    ).status_code == 409
    assert (
        await client.get("/api/admin/applications/example.product/manifest", headers=developer)
    ).json()["schema_version"] == 1


async def test_product_creator_can_be_disabled_but_not_deleted(products: Any) -> None:
    client, server, admin, _regular, developer, _second = products
    await register_product(client, developer)
    user_id = server.user_manager.get("builder").id
    result = await client.delete(f"/api/users/{user_id}", headers=admin)
    assert result.status_code == 409
    assert result.json()["error"]["code"] == "APPLICATION_OWNER_CONFLICT"
    assert server.services.user_repo.get(user_id) is not None
    assert (
        await client.patch(f"/api/users/{user_id}", headers=admin, json={"disabled": True})
    ).status_code == 200
    assert (
        await client.get("/api/admin/applications/example.product", headers=admin)
    ).status_code == 200


async def test_unknown_scope_and_inactive_deployment_cannot_login(products: Any) -> None:
    client, _server, admin, *_ = products
    body = {"username": "reader", "password": "TestPass12", "application_id": "unregistered"}
    assert (await client.post("/api/auth/login", json=body)).status_code == 401
    await register_product(client, admin)
    assert (
        await client.post("/api/auth/login", json={**body, "application_id": "example.product"})
    ).status_code == 403


async def test_native_user_permission_changes_are_rechecked_without_process_cache_refresh(
    products: Any,
) -> None:
    client, server, _admin, _regular, developer, _second = products
    assert (await client.get("/api/admin/applications", headers=developer)).status_code == 200
    developer_id = server.user_manager.get("builder").id
    server.services.user_repo.set_permissions(developer_id, [])
    assert (await client.get("/api/admin/applications", headers=developer)).status_code == 403
    server.services.user_repo.set_disabled(developer_id, True)
    assert (await client.get("/api/auth/me", headers=developer)).status_code == 403


async def test_revoke_access_and_disable_immediately_invalidate_old_tokens(products: Any) -> None:
    client, server, admin, *_ = products
    await register_product(client, admin)
    auth = await grant_product(client, server, admin, "reader")
    assert (await client.get("/api/auth/me", headers=auth)).status_code == 200
    await client.put(
        "/api/admin/applications/example.product/access",
        headers=admin,
        json={"user_id": server.user_manager.get("reader").id, "enabled": False},
    )
    assert (await client.get("/api/auth/me", headers=auth)).status_code == 403

    with pytest.raises(OctopError):
        resolve_user_from_token(server, ws_token(auth))
    auth = await grant_product(client, server, admin, "reader")
    await client.put(
        "/api/admin/applications/example.product/deployment", headers=admin, json={"enabled": False}
    )
    assert (await client.get("/api/auth/me", headers=auth)).status_code == 403


async def test_open_product_websocket_closes_after_access_revocation(products: Any) -> None:
    client, server, admin, *_ = products
    await register_product(client, admin)
    auth = await grant_product(client, server, admin, "reader")
    async with ws_connect(
        client._octop_app, f"/api/notifications/ws?token={ws_token(auth)}"
    ) as socket:
        await socket.send_json({"type": "ping"})
        assert await socket.receive_json() == {"type": "pong"}
        await client.put(
            "/api/admin/applications/example.product/access",
            headers=admin,
            json={"user_id": server.user_manager.get("reader").id, "enabled": False},
        )
        with pytest.raises(WebSocketDisconnect):
            await socket.receive_json(timeout=3.0)


async def test_product_tokens_cannot_read_admin_or_other_application_data(products: Any) -> None:
    client, server, admin, *_ = products
    await register_product(client, admin)
    user = server.user_manager.get("reader")
    auth = await grant_product(client, server, admin, "reader")
    # Rows stay native; no product-owned memory storage is created.
    server.services.agent_repo.create(
        agent_id="private-instance",
        user_id=user.id,
        name="Example",
        application_id="example.product",
    )
    assert (await client.get("/api/applications/example.product/profile", headers=auth)).json()[
        "agent_id"
    ] == "private-instance"
    assert (await client.get("/api/agents/private-instance", headers=admin)).status_code == 404
    assert (await client.get("/api/admin/applications", headers=auth)).status_code == 404
    assert (await client.get("/api/agents/main", headers=auth)).status_code == 404
    assert (
        await client.put(
            "/api/agents/private-instance/workspace/file",
            headers=auth,
            json={"path": "SOUL.md", "content": "changed"},
        )
    ).status_code == 404
    # An admin-role product login cannot read another owner's same-product instance.
    scoped_admin = await grant_product(client, server, admin, "admin")
    assert (
        await client.get("/api/agents/private-instance", headers=scoped_admin)
    ).status_code == 403
    listing = (await client.get("/api/admin/applications", headers=admin)).json()
    assert "private-instance" not in str(listing)


async def test_release_compatibility_recommendation_and_architecture(products: Any) -> None:
    client, server, admin, *_ = products
    await register_product(client, admin)
    auth = await grant_product(client, server, admin, "reader")
    for version, minimum in [("1.0.0", "1.0.2b4"), ("2.0.0", "99.0.0")]:
        result = await client.post(
            "/api/admin/applications/example.product/releases",
            headers=admin,
            json={
                "version": version,
                "platform": "macos",
                "arch": "arm64",
                "url": "https://example.com/app.dmg",
                "sha256": "a" * 64,
                "min_wanx_version": minimum,
                "recommended": True,
            },
        )
        assert result.status_code == 201, result.text
    query = "platform=macos&arch=arm64&current_version=0.1.0"
    assert (
        await client.get(f"/api/applications/example.product/release?{query}", headers=auth)
    ).json()["release"] is None
    result = await client.post(
        "/api/admin/applications/example.product/releases/1.0.0/recommend",
        headers=admin,
        json={"platform": "macos", "arch": "arm64"},
    )
    assert result.status_code == 200
    update = (
        await client.get(f"/api/applications/example.product/release?{query}", headers=auth)
    ).json()
    assert update["update_available"] is True and update["release"]["version"] == "1.0.0"
    assert (
        await client.get(
            "/api/applications/example.product/release?platform=windows&arch=x64", headers=auth
        )
    ).json()["release"] is None


async def test_credentials_and_nonexistent_resource_bindings_rejected(products: Any) -> None:
    client, _server, admin, *_ = products
    await register_product(client, admin)
    for bindings in [
        {"default_model": "missing/model"},
        {"private_agent": "main"},
        {"api_key": "synthetic-secret"},
    ]:
        result = await client.put(
            "/api/admin/applications/example.product/deployment",
            headers=admin,
            json={"enabled": True, "resource_bindings": bindings},
        )
        assert result.status_code in {400, 422}, result.text
    assert (
        await client.patch(
            "/api/admin/applications/example.product",
            headers=admin,
            json={"resource_requirements": {"private_kb": {"kind": "knowledge"}}},
        )
    ).status_code == 400
    assert (
        await client.patch(
            "/api/admin/applications/example.product",
            headers=admin,
            json={"agent_template": {"api_key": "synthetic-secret"}},
        )
    ).status_code == 400


async def test_profile_creation_preserves_private_configuration_and_existing_template(
    products: Any,
) -> None:
    client, server, admin, *_ = products
    await register_product(client, admin)
    auth = await grant_product(client, server, admin, "reader")
    created = await client.post("/api/applications/example.product/profile", headers=auth)
    assert created.status_code == 201, created.text
    agent_id = created.json()["agent_id"]
    assert agent_id
    row = server.services.agent_repo.get(agent_id)
    assert (
        row.application_id == "example.product"
        and row.user_id == server.user_manager.get("reader").id
    )
    config = server.app_runtime.agent_registry.get_config(agent_id)
    assert config["backend"]["virtual_mode"] is True
    runtime = server.app_runtime.agent_registry._build_harness_config(row)
    assert runtime.team_enabled is False and runtime.team_peers == () and runtime.acp_runners == {}
    await client.patch(
        "/api/admin/applications/example.product",
        headers=admin,
        json={"agent_template": {"system_prompt": "new template"}},
    )
    assert (await client.post("/api/applications/example.product/profile", headers=auth)).json()[
        "agent_id"
    ] == agent_id
    assert server.services.agent_repo.get(agent_id).system_prompt == "Private synthetic example"
    await client.put(
        "/api/admin/applications/example.product/deployment", headers=admin, json={"enabled": False}
    )
    assert server.services.agent_repo.get(agent_id) is not None


async def test_management_openapi_contains_summaries_and_typed_responses(products: Any) -> None:
    client, _server, *_ = products
    schema = client._octop_app.openapi()
    selected = {
        path: operations
        for path, operations in schema["paths"].items()
        if path.startswith("/api/admin/applications") or path.startswith("/api/applications/")
    }
    assert len(selected) == 9
    for operations in selected.values():
        for operation in operations.values():
            assert operation["summary"]
            success = next(
                response
                for code, response in operation["responses"].items()
                if code.startswith("2")
            )
            response_schema = success["content"]["application/json"]["schema"]
            assert "$ref" in response_schema or response_schema.get("type") == "array"
