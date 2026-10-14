"""Automatic application grants preserve explicit access decisions atomically."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest
from tests.support.app import octop_client
from tests.support.auth import auth_header, bootstrap_admin, create_user

from octop.infra.db.repos import applications

ACCESS = "/api/admin/applications/example.product/access"


@pytest.fixture
async def access_client(tmp_octop_home: Path) -> AsyncIterator[Any]:
    async with octop_client(tmp_octop_home) as (client, server):
        await bootstrap_admin(client, tmp_octop_home)
        admin = await auth_header(client)
        regular = await create_user(client, admin, username="reader")
        result = await client.post(
            "/api/admin/applications",
            headers=admin,
            json={"application_id": "example.product", "name": "Example"},
        )
        assert result.status_code == 201, result.text
        yield client, server, admin, regular, server.user_manager.get("reader").id


async def test_conditional_first_grant_is_persisted_and_response_remains_compatible(
    access_client: Any,
) -> None:
    client, server, admin, _, user_id = access_client
    result = await client.put(
        ACCESS,
        headers=admin,
        json={"user_id": user_id, "enabled": True, "only_if_missing": True},
    )
    assert result.status_code == 200, result.text
    assert result.json()["enabled"] is True
    assert set(result.json()) == {"user_id", "enabled", "username", "updated_at"}
    assert server.services.application_repo.user_access("example.product", user_id) is True


@pytest.mark.parametrize("enabled", [True, False])
async def test_conditional_grant_preserves_existing_decision_timestamp_and_audit(
    access_client: Any, monkeypatch: pytest.MonkeyPatch, enabled: bool
) -> None:
    client, server, admin, _, user_id = access_client
    monkeypatch.setattr(applications, "now_ts", lambda: 100)
    original = await client.put(
        ACCESS, headers=admin, json={"user_id": user_id, "enabled": enabled}
    )
    assert original.status_code == 200, original.text
    audit = Mock(wraps=server.services.audit_repo.write)
    monkeypatch.setattr(server.services.audit_repo, "write", audit)
    monkeypatch.setattr(applications, "now_ts", lambda: 200)
    result = await client.put(
        ACCESS,
        headers=admin,
        json={"user_id": user_id, "enabled": True, "only_if_missing": True},
    )
    assert result.status_code == 200, result.text
    assert result.json() == original.json()
    assert result.json()["enabled"] is enabled
    assert result.json()["updated_at"] == 100
    audit.assert_not_called()
    # Explicit administrative changes still use the existing update semantics.
    updated = await client.put(
        ACCESS, headers=admin, json={"user_id": user_id, "enabled": not enabled}
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["enabled"] is not enabled
    assert updated.json()["updated_at"] == 200
    audit.assert_called_once()


async def test_conditional_revoke_is_invalid_and_cannot_create_access(access_client: Any) -> None:
    client, server, admin, _, user_id = access_client
    result = await client.put(
        ACCESS,
        headers=admin,
        json={"user_id": user_id, "enabled": False, "only_if_missing": True},
    )
    assert result.status_code == 400, result.text
    assert result.json()["error"]["code"] == "APPLICATION_INVALID"
    assert server.services.application_repo.user_access("example.product", user_id) is None


async def test_regular_user_cannot_self_grant_with_conditional_flag(access_client: Any) -> None:
    client, server, _, regular, user_id = access_client
    result = await client.put(
        ACCESS,
        headers=regular,
        json={"user_id": user_id, "enabled": True, "only_if_missing": True},
    )
    assert result.status_code == 403, result.text
    assert server.services.application_repo.user_access("example.product", user_id) is None
