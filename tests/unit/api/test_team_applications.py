"""Company application ownership with a pre-verified native capability boundary.

The broker/cryptographic admission is exercised by the separate cross-runtime
integration suite. These tests use real SQL and isolate application decisions.
"""

from __future__ import annotations

import time
from dataclasses import replace
from types import SimpleNamespace

import pytest
from centuarai_local_data_gate.client import GateContext
from centuarai_local_data_gate.protocol import encode, principal_namespace
from pydantic import ValidationError

from octop.infra.applications.models import AccessBody, DeploymentBody, ProductDefinition
from octop.infra.applications.service import ApplicationService
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.services import RepoBundle
from octop.infra.errors import OctopError
from octop.infra.users.identity import User


@pytest.fixture
def company(tmp_path):
    db = SqlitePool(tmp_path / "company.sqlite")
    run_migrations(db)
    services = RepoBundle.from_pool(db)
    pin = encode(b"b" * 32)
    roster = [
        {
            "membershipId": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "principalId": "principal-a",
            "status": "active",
            "revision": 1,
        },
        {
            "membershipId": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
            "principalId": "principal-b",
            "status": "active",
            "revision": 1,
        },
    ]
    principal = roster[0]["principalId"]
    namespace = principal_namespace(pin, 1, principal)
    uid = services.local_data_principal_repo.resolve(namespace, pin, 1, principal)
    team = {
        "schemaVersion": 1,
        "boxId": "box-a",
        "ownershipEpoch": 1,
        "principalId": principal,
        "membershipId": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "membershipRevision": 1,
        "roleId": "manager",
        "permissions": ["applications.manage"],
    }
    context = GateContext(
        SimpleNamespace(),
        None,
        {
            "boxKeyThumbprint": pin,
            "ownershipEpoch": 1,
            "resourceId": "team:management",
            "serviceContext": {"principalNamespace": namespace},
            "team": team,
        },
        "unit-admission-fixture",
        "native-generation",
    )
    context._deadline = time.monotonic() + 60
    context.require_live = context.check_cached
    context.team_members_sync = lambda: tuple(roster)
    user = User(
        uid,
        "local_" + namespace,
        "user",
        "Manager",
        local_data=True,
        local_team=context.claims["team"],
        local_team_context=context,
    )
    service = ApplicationService(services)
    yield services, service, user, context, roster
    db.close()


def product(identifier="company.example"):
    return ProductDefinition(application_id=identifier, name="Company app")


def test_manager_creates_scoped_application_without_becoming_native_admin(company):
    services, service, user, _, _ = company
    result = service.create(user, product())
    assert result.created_by == user.id
    assert not user.is_admin
    row = services.team_application_repo.get(result.application_id)
    assert (row["box_id"], row["ownership_epoch"]) == ("box-a", 1)
    assert services.user_repo.get(user.id).role == "user"
    assert services.user_repo.get(user.id).password_hash is None
    assert [item.application_id for item in service.list_products(user)] == ["company.example"]


def test_team_registry_cannot_be_forged_through_deployment_configuration(company):
    services, service, user, _, _ = company
    services.application_repo.create(product("private.example").model_dump(), created_by=user.id)
    services.application_repo.put_deployment(
        "private.example",
        {
            "enabled": False,
            "resource_bindings": {},
            "configuration": {"studio_team": {"boxId": "box-a", "ownershipEpoch": 1}},
        },
    )
    assert service.list_products(user) == []
    with pytest.raises(OctopError):
        service.get(user, "private.example")
    with pytest.raises(OctopError):
        service.put_deployment(user, "private.example", DeploymentBody(enabled=False))


@pytest.mark.parametrize("scope", [("box-b", 1), ("box-a", 2)])
def test_other_box_or_ownership_epoch_is_not_a_company_application(company, scope):
    services, service, user, _, _ = company
    services.application_repo.create(product().model_dump(), created_by=user.id, team_scope=scope)
    with pytest.raises(OctopError):
        service.get(user, "company.example")
    assert service.list_products(user) == []


def test_access_requires_current_membership_instead_of_a_caller_native_uid(company):
    services, service, user, _, roster = company
    service.create(user, product())
    legacy = services.user_repo.create(username="legacy", role="user", password_hash="old-hash")
    with pytest.raises(OctopError):
        service.put_access(user, "company.example", legacy, True)
    with pytest.raises(OctopError):
        service.put_access(user, "company.example", None, True, membership_id="unknown")
    response = service.put_access(
        user,
        "company.example",
        None,
        True,
        membership_id="BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
    )
    assert response.membership_id == "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"
    assert response.user_id != legacy
    assert services.user_repo.get(response.user_id).password_hash is None
    assert services.application_repo.user_access("company.example", legacy) is None
    roster.pop()
    with pytest.raises(OctopError):
        service.put_access(
            user,
            "company.example",
            None,
            True,
            membership_id="BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
        )
    assert service.access(user, "company.example") == []


def test_cached_or_replaced_team_claims_cannot_manage(company):
    _, service, user, context, _ = company
    with pytest.raises(OctopError):
        service.create(replace(user, local_team=dict(user.local_team)), product())
    with pytest.raises(OctopError):
        service.create(replace(user, role="admin"), product())
    context._closed = True
    with pytest.raises(OctopError):
        service.create(user, product())


def test_local_private_user_does_not_gain_company_permissions_from_legacy_permissions(company):
    _, service, user, _, _ = company
    private = replace(
        user,
        local_team=None,
        local_team_context=None,
        permissions=["applications_manage", "applications_develop"],
    )
    with pytest.raises(OctopError):
        service.create(private, product())


def test_failed_company_registration_rolls_back_product_and_deployment(company):
    services, _, user, _, _ = company
    with services.db.transaction() as connection:
        connection.execute(
            "CREATE TRIGGER reject_company BEFORE INSERT ON team_applications "
            "BEGIN SELECT RAISE(ABORT, 'test simulated registration failure'); END"
        )
    with pytest.raises(Exception, match="simulated registration failure"):
        services.application_repo.create(
            product().model_dump(), created_by=user.id, team_scope=("box-a", 1)
        )
    assert services.application_repo.get("company.example") is None
    assert services.application_repo.deployment("company.example") is None


@pytest.mark.parametrize(
    "body",
    [
        {"enabled": True},
        {
            "user_id": 1,
            "membership_id": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "enabled": True,
        },
        {"membership_id": "../member", "enabled": True},
    ],
)
def test_access_contract_has_one_unambiguous_identity(body):
    with pytest.raises(ValidationError):
        AccessBody.model_validate(body)


@pytest.mark.parametrize("prefix", ["_", "-", "A"])
def test_access_membership_accepts_full_canonical_digest_alphabet(prefix):
    value = prefix + "A" * 42
    assert (
        AccessBody.model_validate({"membership_id": value, "enabled": True}).membership_id == value
    )


def test_access_membership_rejects_noncanonical_digest_tail():
    with pytest.raises(ValueError):
        AccessBody.model_validate({"membership_id": "A" * 42 + "B", "enabled": True})
