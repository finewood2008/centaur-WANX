"""Offline signatures and real SQLite/workspace preparation; no cloud or LLM calls."""

from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from octop.config import OctopConfig
from octop.infra.agents.manager import AgentCreateSpec, AgentManager
from octop.infra.applications.local_catalog import LocalResourceCatalog, install_catalog, main
from octop.infra.applications.local_contract import LocalResourceError, canonical
from octop.infra.applications.local_resources import LocalApplicationResources
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.services import build_shared_services
from octop.infra.users.identity import User
from octop.infra.utils.paths import PathLayout

pytestmark = pytest.mark.skipif(
    os.name != "posix", reason="Offline catalog deployment is POSIX-only"
)
ARTIFACT = "11111111-2222-4333-8444-555555555555"
APPLICATION = "centaurai.wanx.ai-browser"


def signed_fixture(tmp_path: Path, *, resource_version: str = "1.0.0", key=None, expert=True):
    tmp_path.mkdir(parents=True, exist_ok=True)
    key = key or Ed25519PrivateKey.generate()
    pem = (
        key.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    trust = tmp_path / "trust.json"
    trust.write_bytes(
        canonical(
            {
                "schemaVersion": 1,
                "applicationKeys": {"fixture": pem},
                "resourceKeys": {"fixture": pem},
            }
        )
    )
    requirements = [{"kind": "skill-package", "resourceId": "research", "minVersion": "1.0.0"}]
    if expert:
        requirements.append({"kind": "expert", "resourceId": "researcher", "minVersion": "1.0.0"})
    compatibility = {
        "backendProductId": "wanx",
        "clientRange": ">=0.1.0",
        "hostProtocolRange": ">=1.0.0",
        "backendContracts": [
            {"id": "wanx-bridge.readiness", "range": ">=1.0.0 <2.0.0", "features": ["read-only"]}
        ],
        "resourceDependencies": requirements,
        "localDataSchema": {"readRange": ">=1.0.0", "writeVersion": "1.0.0"},
    }
    manifest = {
        "applicationId": APPLICATION,
        "name": "Fixture",
        "version": "1.0.0",
        "protocolVersion": 3,
        "runtime": "electron",
        "launchMode": "shared",
        "entrypoint": "main.mjs",
        "capabilities": ["http.request"],
        "compatibility": compatibility,
    }
    descriptor = {
        "schemaVersion": 3,
        "artifactId": ARTIFACT,
        "applicationId": APPLICATION,
        "version": "1.0.0",
        "os": "universal",
        "arch": "universal",
        "packageType": "wanxapp",
        "hostProtocol": 1,
        "fileName": "fixture.wanxapp",
        "sha256": "a" * 64,
        "size": 1,
        "minWanxVersion": "0.1.0",
        "manifest": manifest,
        "compatibility": compatibility,
    }

    def sign_application(value):
        raw = canonical(value)
        return {
            "keyId": "fixture",
            "descriptorBase64": base64.b64encode(raw).decode(),
            "signatureBase64": base64.b64encode(key.sign(raw)).decode(),
        }

    application = tmp_path / "application-envelope.json"
    application.write_bytes(canonical(sign_application(descriptor)))
    resources = []
    packages = {}
    for requirement in requirements:
        kind, resource_id = requirement["kind"], requirement["resourceId"]
        contents = (
            {"skills/research/SKILL.md": b"---\nname: Research\n---\nSafe fixture content\n"}
            if kind == "skill-package"
            else {
                "manifest.json": b'{"name":"Researcher"}',
                "SOUL.md": b"Research only the current principal's material.\n",
            }
        )
        package = {
            "schemaVersion": 1,
            "kind": kind,
            "resourceId": resource_id,
            "version": resource_version,
            "name": resource_id,
            "description": "fixture",
            "dependencies": [] if kind == "skill-package" else [requirements[0]],
            "metadata": {},
            "files": [
                {"path": name, "contentBase64": base64.b64encode(content).decode()}
                for name, content in contents.items()
            ],
        }
        raw = canonical(package)
        payload = {name: value for name, value in package.items() if name != "files"}
        payload.update(
            {
                "purpose": "wanx.resource.v1",
                "publishedAt": "2026-01-01T00:00:00Z",
                "package": {
                    "format": "wanx-resource-json",
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    "sizeBytes": len(raw),
                },
            }
        )
        envelope = {
            "payload": payload,
            "signature": {
                "algorithm": "ed25519",
                "keyId": "fixture",
                "signatureBase64": base64.b64encode(key.sign(canonical(payload))).decode(),
            },
        }
        envelope_path, package_path = (
            tmp_path / f"{resource_id}.envelope.json",
            tmp_path / f"{resource_id}.package.json",
        )
        envelope_path.write_bytes(canonical(envelope))
        package_path.write_bytes(raw)
        resources.append((envelope_path, package_path))
        packages[resource_id] = package
    return {
        "key": key,
        "trust": trust,
        "application": application,
        "resources": resources,
        "compatibility": compatibility,
        "descriptor": descriptor,
        "sign_application": sign_application,
        "packages": packages,
    }


def install_fixture(tmp_path: Path, fixture):
    root = tmp_path / "catalog"
    arguments = [
        "install",
        "--catalog",
        str(root),
        "--trust",
        str(fixture["trust"]),
        "--application-envelope",
        str(fixture["application"]),
    ]
    for envelope, package in fixture["resources"]:
        arguments.extend(["--resource", str(envelope), str(package)])
    assert main(arguments) == 0
    return LocalResourceCatalog(root, fixture["trust"])


def test_real_offline_cli_and_signature_digest_validation(tmp_path):
    fixture = signed_fixture(tmp_path / "input")
    catalog = install_fixture(tmp_path, fixture)
    resolved = catalog.resolve(APPLICATION, ARTIFACT)
    assert [p["kind"] for p in resolved["payloads"]] == ["skill-package", "expert"]
    assert resolved["descriptor"]["artifactId"] == ARTIFACT
    package_file = next((catalog.root / "packages").iterdir())
    package_file.write_bytes(package_file.read_bytes() + b" ")
    with pytest.raises(LocalResourceError, match="RESOURCE_PACKAGE_DIGEST_MISMATCH"):
        catalog.resolve(APPLICATION, ARTIFACT)


def test_install_rejects_untrusted_tampered_and_missing_dependencies(tmp_path):
    fixture = signed_fixture(tmp_path / "input")
    envelope = json.loads(fixture["application"].read_bytes())
    envelope["signatureBase64"] = base64.b64encode(bytes(64)).decode()
    fixture["application"].write_bytes(canonical(envelope))
    with pytest.raises(LocalResourceError, match="RESOURCE_SIGNATURE_INVALID"):
        install_fixture(tmp_path, fixture)
    fixture["application"].write_bytes(
        canonical(fixture["sign_application"](fixture["descriptor"]))
    )
    fixture["resources"] = fixture["resources"][:1]
    with pytest.raises(LocalResourceError, match="RESOURCE_DEPENDENCY_UNAVAILABLE"):
        install_fixture(tmp_path, fixture)
    assert not (tmp_path / "catalog").exists()


def test_catalog_rejects_rollback_and_immutable_artifact_changes(tmp_path):
    fixture = signed_fixture(tmp_path / "input", resource_version="2.0.0")
    catalog = install_fixture(tmp_path, fixture)
    lower = signed_fixture(tmp_path / "lower", key=fixture["key"])
    with pytest.raises(LocalResourceError, match="RESOURCE_VERSION_ROLLBACK"):
        install_catalog(
            root=catalog.root,
            trust_path=lower["trust"],
            application_envelope=lower["application"],
            resources=lower["resources"],
        )
    changed = copy.deepcopy(fixture["descriptor"])
    changed["sha256"] = "b" * 64
    fixture["application"].write_bytes(canonical(fixture["sign_application"](changed)))
    with pytest.raises(LocalResourceError, match="RESOURCE_ARTIFACT_IMMUTABLE"):
        install_fixture(tmp_path, fixture)
    assert catalog.resolve(APPLICATION, ARTIFACT)["payloads"][0]["version"] == "2.0.0"


def test_catalog_rejects_license_and_symlink_and_arbitrary_artifact_path(tmp_path):
    fixture = signed_fixture(tmp_path / "input")
    changed = copy.deepcopy(fixture["descriptor"])
    changed["manifest"]["releaseAccess"] = "account"
    fixture["application"].write_bytes(canonical(fixture["sign_application"](changed)))
    with pytest.raises(LocalResourceError, match="RESOURCE_ONLINE_LICENSE_REQUIRED"):
        install_fixture(tmp_path, fixture)
    fixture["application"].write_bytes(
        canonical(fixture["sign_application"](fixture["descriptor"]))
    )
    original = fixture["resources"][0][1]
    symlink = original.with_name("linked-package.json")
    symlink.symlink_to(original)
    fixture["resources"][0] = (fixture["resources"][0][0], symlink)
    with pytest.raises(LocalResourceError, match="RESOURCE_CATALOG_UNSAFE"):
        install_fixture(tmp_path, fixture)
    with pytest.raises(LocalResourceError, match="APPLICATION_RESOURCE_ARTIFACT_REQUIRED"):
        LocalResourceCatalog(tmp_path, fixture["trust"]).resolve(APPLICATION, "../../file")


class Context:
    def __init__(self, principal="principal1", *, allow=True):
        self.claims = {
            "applicationId": "wanx-host",
            "boxId": "box1",
            "boxKeyThumbprint": "A" * 43,
            "principalId": principal,
            "ownershipEpoch": 1,
        }
        self.live = True
        self.allow = allow
        self.grants = None
        self.checks = 0

    def require_live(self):
        self.checks += 1
        if not self.live:
            raise PermissionError("revoked")

    async def authorize_resources(self, grants):
        self.require_live()
        if not self.allow:
            raise PermissionError("scope denied")
        self.grants = grants


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    fixture = signed_fixture(tmp_path / "input")
    catalog = install_fixture(tmp_path, fixture)
    home = tmp_path / "octop"
    home.mkdir()
    db = SqlitePool(home / "octop.db")
    run_migrations(db)
    services = build_shared_services(db=db, paths=PathLayout(home), config=OctopConfig())
    registry = AgentManager(repos=services.repos, paths=services.paths)
    # Only model startup is substituted. Registry ownership, DB transactions,
    # BackendWorkspace writes/reads and all catalog verification run normally.
    monkeypatch.setattr(registry, "_start_agent", AsyncMock(return_value=None))
    uid = services.user_repo.create(username="local_fixture1", role="user")
    user = User(uid, "local_fixture1", "user", "Fixture", local_data=True)
    resource = LocalApplicationResources(services=services, registry=registry, catalog=catalog)
    yield resource, services, registry, user, fixture
    db.close()


def body(fixture, *, operation="candidate", operation_id="op1", binding_id=None):
    value = {
        "schemaVersion": 2 if operation == "candidate" or binding_id else 1,
        "applicationId": APPLICATION,
        "artifactId": ARTIFACT,
    }
    if operation == "candidate":
        value["operationId"] = operation_id
    if operation == "readiness":
        value["compatibility"] = fixture["compatibility"]
        if binding_id:
            value["bindingSetId"] = binding_id
    return value


@pytest.mark.asyncio
async def test_native_private_prepare_readiness_idempotence_and_user_isolation(runtime):
    resource, services, registry, user, fixture = runtime
    context = Context()
    first = await resource.handle("candidate", body(fixture), user=user, context=context)
    assert context.grants == [{"resourceId": "wanx", "actions": ["read", "write"]}]
    assert first["bindingScope"]["schemaVersion"] == 2
    assert "accountId" not in first["bindingScope"]
    skill, expert = first["bindings"]
    assert services.skill_package_repo.get(skill["packageId"]).created_by == str(user.id)
    assert registry.get_row(expert["instanceId"]).user_id == user.id
    workspace = registry.workspace_for_agent(expert["instanceId"])
    assert b"Safe fixture" in await workspace.adownload_bytes("skills/research/SKILL.md")
    again = await resource.handle("candidate", body(fixture), user=user, context=Context())
    assert again["bindings"] == first["bindings"]
    ready = await resource.handle(
        "readiness",
        body(fixture, operation="readiness", binding_id=first["bindingSetId"]),
        user=user,
        context=Context(),
    )
    assert ready["status"] == "ready"
    assert len(services.skill_package_repo.list_all()) == len(registry.list_rows()) == 1
    uid2 = services.user_repo.create(username="local_fixture2", role="user")
    user2 = User(uid2, "local_fixture2", "user", "Second", local_data=True)
    second = await resource.handle(
        "candidate", body(fixture), user=user2, context=Context("principal2")
    )
    assert second["bindings"] != first["bindings"]
    assert second["bindingSetId"] != first["bindingSetId"]
    with pytest.raises(LocalResourceError, match="APPLICATION_RESOURCES_NOT_READY"):
        await resource.handle(
            "readiness",
            body(fixture, operation="readiness", binding_id=first["bindingSetId"]),
            user=user2,
            context=Context("principal2"),
        )


@pytest.mark.asyncio
async def test_denied_grants_have_no_resource_side_effects_and_readiness_is_read_only(runtime):
    resource, services, registry, user, fixture = runtime
    with pytest.raises(PermissionError, match="scope denied"):
        await resource.handle("candidate", body(fixture), user=user, context=Context(allow=False))
    assert not resource.root.exists()
    assert not services.skill_package_repo.list_all()
    assert not registry.list_rows()
    with pytest.raises(LocalResourceError, match="APPLICATION_RESOURCES_NOT_READY"):
        await resource.handle(
            "readiness", body(fixture, operation="readiness"), user=user, context=Context()
        )
    assert not resource.root.exists()


@pytest.mark.asyncio
async def test_resource_modification_cannot_be_reported_ready_or_overwritten(runtime):
    resource, services, registry, user, fixture = runtime
    first = await resource.handle("candidate", body(fixture), user=user, context=Context())
    package_id = first["bindings"][0]["packageId"]
    target = services.paths.skill_packages_dir / package_id / "skills/research/SKILL.md"
    target.write_text("User change")
    for operation, request in [
        ("candidate", body(fixture)),
        ("readiness", body(fixture, operation="readiness", binding_id=first["bindingSetId"])),
    ]:
        with pytest.raises(LocalResourceError, match="RESOURCE_USER_MODIFIED"):
            await resource.handle(operation, request, user=user, context=Context())
    assert target.read_text() == "User change"


@pytest.mark.asyncio
async def test_frontend_artifact_update_reuses_unchanged_signed_private_resources(runtime):
    resource, services, registry, user, fixture = runtime
    first = await resource.handle("candidate", body(fixture), user=user, context=Context())
    descriptor = copy.deepcopy(fixture["descriptor"])
    descriptor["artifactId"] = "99999999-2222-4333-8444-555555555555"
    descriptor["version"] = descriptor["manifest"]["version"] = "1.1.0"
    fixture["application"].write_bytes(canonical(fixture["sign_application"](descriptor)))
    install_catalog(
        root=resource.catalog.root,
        trust_path=fixture["trust"],
        application_envelope=fixture["application"],
        resources=fixture["resources"],
    )
    request = {**body(fixture), "artifactId": descriptor["artifactId"]}
    second = await resource.handle("candidate", request, user=user, context=Context())
    assert second["bindingSetId"] != first["bindingSetId"]
    assert second["bindings"] == first["bindings"]
    assert len(services.skill_package_repo.list_all()) == len(registry.list_rows()) == 1


@pytest.mark.asyncio
async def test_manager_lock_wait_rechecks_authority_before_any_row_or_workspace(runtime):
    _, services, registry, user, _ = runtime
    context = Context()
    await registry._lock.acquire()
    task = asyncio.create_task(
        registry.create(
            AgentCreateSpec(name="Should not exist", user_id=user.id),
            before_side_effect=context.require_live,
        )
    )
    await asyncio.sleep(0)
    context.live = False
    registry._lock.release()
    with pytest.raises(PermissionError, match="revoked"):
        await task
    assert not registry.list_rows()
    assert not services.paths.agents_dir.exists()


@pytest.mark.asyncio
async def test_concurrent_prepare_reuses_one_real_instance(runtime):
    resource, services, registry, user, fixture = runtime
    first, second = await asyncio.gather(
        *[
            resource.handle("candidate", body(fixture), user=user, context=Context())
            for _ in range(2)
        ]
    )
    assert first["bindings"] == second["bindings"]
    assert len(services.skill_package_repo.list_all()) == len(registry.list_rows()) == 1


@pytest.mark.asyncio
async def test_cloud_or_app_child_cannot_invoke_host_preparation(runtime):
    resource, services, _, user, fixture = runtime
    user.local_data = False
    with pytest.raises(LocalResourceError, match="LOCAL_DATA_SCOPE_DENIED"):
        await resource.handle("candidate", body(fixture), user=user, context=Context())
    user.local_data = True
    child = Context()
    child.claims["applicationId"] = APPLICATION
    with pytest.raises(LocalResourceError, match="LOCAL_DATA_SCOPE_DENIED"):
        await resource.handle("candidate", body(fixture), user=user, context=child)
    assert not services.skill_package_repo.list_all()


@pytest.mark.asyncio
async def test_native_http_adapter_returns_real_preparation_and_typed_openapi(runtime, monkeypatch):
    import httpx
    from fastapi import FastAPI

    from octop.api.deps import current_user, get_server
    from octop.api.routers import local_applications

    resource, services, registry, user, fixture = runtime
    app = FastAPI()
    app.include_router(local_applications.router)
    app.dependency_overrides[current_user] = lambda: user
    app.dependency_overrides[get_server] = lambda: SimpleNamespace(
        services=services, app_runtime=SimpleNamespace(agent_registry=registry)
    )
    context = Context()
    monkeypatch.setattr(local_applications, "get_context", lambda scope: context)
    monkeypatch.setenv("OCTOP_LOCAL_RESOURCE_CATALOG", str(resource.catalog.root))
    monkeypatch.setenv("OCTOP_LOCAL_RESOURCE_TRUST", str(resource.catalog.trust_path))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://fixture"
    ) as client:
        prepared = await client.post(
            "/api/platform/applications/candidates/prepare", json=body(fixture)
        )
        assert prepared.status_code == 200, prepared.text
        result = prepared.json()
        assert result["status"] == "ready"
        assert registry.get_row(result["bindings"][1]["instanceId"]).user_id == user.id
        ready = await client.post(
            "/api/platform/applications/readiness",
            json=body(fixture, operation="readiness", binding_id=result["bindingSetId"]),
        )
        assert ready.status_code == 200
        assert context.grants == [{"resourceId": "wanx", "actions": ["read"]}]
        malformed = await client.post(
            "/api/platform/applications/candidates/prepare",
            json={**body(fixture), "accountId": "old-cloud-account"},
        )
        assert malformed.status_code == 422
        openapi = (await client.get("/openapi.json")).json()
        operation = openapi["paths"]["/api/platform/applications/candidates/prepare"]["post"]
        assert operation["summary"] and operation["responses"]["200"]["content"][
            "application/json"
        ]["schema"]["$ref"].endswith("PreparationResult")
