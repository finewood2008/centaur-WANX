"""Signed application scopes and the central transport boundary."""

from __future__ import annotations

import time
from types import SimpleNamespace

import jwt
import pytest

from octop.api.common.agent import assert_agent_access_row, assert_agent_owner
from octop.api.common.application_access import assert_application_request
from octop.api.deps import (
    decode_token,
    maybe_sliding_renew_token,
    resolve_user_from_token,
    sign_token,
)
from octop.infra.errors import OctopError
from octop.infra.users.identity import User


def _server(user: User) -> SimpleNamespace:
    return SimpleNamespace(
        user_manager=SimpleNamespace(get_by_id=lambda _id: user),
        services=SimpleNamespace(
            secret_repo=SimpleNamespace(get=lambda _key: b"scope-test-secret" * 2),
            config=SimpleNamespace(access_token_ttl_seconds=86400),
        ),
    )


def test_scope_is_request_local_and_renewed_from_signed_claim() -> None:
    cached = User(1, "owner", "admin", None)
    srv = _server(cached)
    secret = srv.services.secret_repo.get("jwt")
    token = sign_token(
        secret, sub=1, uname="owner", role="admin", ttl_seconds=60, application_id="zhijun"
    )
    scoped = resolve_user_from_token(srv, token)
    assert scoped is not cached
    assert scoped.application_id == "zhijun"
    assert cached.application_id == "wanx"
    # Even passing the cached WANX user cannot change the token's signed scope.
    renewed = maybe_sliding_renew_token(srv, token, cached)
    assert renewed is not None
    assert decode_token(secret, renewed)["application_id"] == "zhijun"


def test_legacy_token_belongs_to_wanx_and_unknown_scope_rejected() -> None:
    srv = _server(User(1, "owner", "admin", None))
    secret = srv.services.secret_repo.get("jwt")
    payload = {"sub": "1", "exp": int(time.time()) + 1000}
    assert (
        resolve_user_from_token(srv, jwt.encode(payload, secret, algorithm="HS256")).application_id
        == "wanx"
    )
    with pytest.raises(OctopError) as error:
        resolve_user_from_token(
            srv, jwt.encode({**payload, "application_id": "other"}, secret, algorithm="HS256")
        )
    assert error.value.status == 401


@pytest.mark.parametrize("admin", [False, True])
@pytest.mark.parametrize("checker", [assert_agent_owner, assert_agent_access_row])
def test_admin_cannot_cross_application(admin: bool, checker: object) -> None:
    row = SimpleNamespace(user_id=1, application_id="zhijun", is_shared=1)
    user = SimpleNamespace(id=1, application_id="wanx", is_admin=admin)
    with pytest.raises(OctopError) as error:
        checker(row, user)  # type: ignore[operator]
    assert error.value.status == 404


def test_zhijun_admin_cannot_read_another_owners_profile() -> None:
    row = SimpleNamespace(user_id=2, application_id="zhijun", is_shared=0)
    user = SimpleNamespace(id=1, application_id="zhijun", is_admin=True)
    with pytest.raises(OctopError) as error:
        assert_agent_access_row(row, user)
    assert error.value.status == 403


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/agents"),
        ("GET", "/api/agents"),
        ("PATCH", "/api/agents/profile"),
        ("PUT", "/api/agents/profile/workspace/file"),
        ("POST", "/api/agents/profile/memory/portable/adopt"),
        ("GET", "/api/admin/providers"),
        ("GET", "/api/connectors"),
        ("PUT", "/api/knowledge-bases/feature"),
        ("POST", "/api/knowledge-bases/onnx-download"),
        ("GET", "/api/knowledge-bases/embedding-options"),
        ("GET", "/api/agents/profile/workspace/download"),
        ("WEBSOCKET", "/api/browser-stream/ws"),
    ],
)
def test_zhijun_token_denies_global_and_configuration_surfaces(method: str, path: str) -> None:
    srv = SimpleNamespace(
        app_runtime=SimpleNamespace(
            agent_registry=SimpleNamespace(
                get_row=lambda _id: SimpleNamespace(application_id="zhijun")
            )
        )
    )
    user = SimpleNamespace(application_id="zhijun")
    with pytest.raises(OctopError) as error:
        assert_application_request(srv, user, path=path, method=method)
    assert error.value.status == 404


@pytest.mark.parametrize(
    ("method", "suffix"),
    [
        ("POST", "threads"),
        ("GET", "threads/t/history"),
        ("WEBSOCKET", "chat/ws"),
        ("POST", "memory/episodes/list"),
        ("POST", "memory/atoms/a:replace"),
        ("GET", "memory/terminal/about_me"),
        ("PUT", "memory/extract-config"),
        ("POST", "memory/atoms"),
        ("GET", "channels"),
        ("PATCH", "channels/wx"),
        ("POST", "channels/weixin/qrcode/generate"),
        ("POST", "channels/weixin/qrcode/poll"),
        ("POST", "upload"),
        ("GET", "upload/source"),
    ],
)
def test_zhijun_profile_operations_allowed(method: str, suffix: str) -> None:
    srv = SimpleNamespace(
        app_runtime=SimpleNamespace(
            agent_registry=SimpleNamespace(
                get_row=lambda _id: SimpleNamespace(application_id="zhijun")
            )
        )
    )
    assert_application_request(
        srv,
        SimpleNamespace(application_id="zhijun"),
        path=f"/api/agents/profile/{suffix}",
        method=method,
    )


def test_collection_action_does_not_require_existing_agent_row() -> None:
    from unittest.mock import Mock

    registry = Mock()
    srv = SimpleNamespace(app_runtime=SimpleNamespace(agent_registry=registry))
    assert_application_request(
        srv,
        SimpleNamespace(application_id="wanx"),
        path="/api/agents/from-expert/default",
        method="POST",
    )
    registry.get_row.assert_not_called()
    with pytest.raises(OctopError) as error:
        assert_application_request(
            srv,
            SimpleNamespace(application_id="zhijun"),
            path="/api/agents/from-expert/default",
            method="POST",
        )
    assert error.value.status == 404


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/settings/upload"),
        ("GET", "/api/knowledge-bases/capability"),
        ("GET", "/api/knowledge-bases"),
        ("POST", "/api/knowledge-bases"),
        ("GET", "/api/knowledge-bases/OWNKB1"),
        ("POST", "/api/knowledge-bases/OWNKB1/documents"),
        ("GET", "/api/knowledge-bases/OWNKB1/documents/doc/preview"),
        ("POST", "/api/knowledge-bases/OWNKB1/documents/doc/reindex"),
    ],
)
def test_private_library_transport_allowed(method: str, path: str) -> None:
    server = SimpleNamespace(
        services=SimpleNamespace(
            knowledge_repo=SimpleNamespace(
                get_base=lambda _id, **_kwargs: SimpleNamespace(application_id="zhijun")
            )
        )
    )
    assert_application_request(
        server, SimpleNamespace(application_id="zhijun"), path=path, method=method
    )


@pytest.mark.parametrize("application_id", ["wanx", "zhijun"])
def test_cross_application_library_rejected_before_operation(application_id: str) -> None:
    server = SimpleNamespace(
        services=SimpleNamespace(
            knowledge_repo=SimpleNamespace(
                get_base=lambda _id, **_kwargs: SimpleNamespace(
                    application_id="zhijun" if application_id == "wanx" else "wanx"
                )
            )
        )
    )
    with pytest.raises(OctopError) as error:
        assert_application_request(
            server,
            SimpleNamespace(application_id=application_id, is_admin=True),
            path="/api/knowledge-bases/OWNKB1/documents",
            method="POST",
        )
    assert error.value.status == 404


def test_legacy_mock_identity_uses_same_default_as_application_helper() -> None:
    from unittest.mock import MagicMock

    user = MagicMock(id=1, is_admin=True)
    assert_agent_owner(MagicMock(user_id=2), user)
    with pytest.raises(OctopError) as error:
        assert_agent_owner(SimpleNamespace(user_id=1, application_id="zhijun"), user)
    assert error.value.status == 404
