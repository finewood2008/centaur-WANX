"""Bridge resource assumptions against actual Octop routers, SQLite and files.

Run from the repository root with its full Octop test environment:
    uv run pytest wanx-bridge/tests/test_resource_octop_api.py -q

Only the model harness is replaced by the existing upstream test fixture. No
HTTP endpoint, ownership check, package store, database or workspace API is mocked.
The standalone bridge dependency environment intentionally skips this module.
"""

from __future__ import annotations

import base64
import importlib.util
import json
from typing import Any

import pytest

if importlib.util.find_spec("octop") is None:
    pytest.skip("requires repository Octop integration dependencies", allow_module_level=True)

from tests.conftest import (  # noqa: E402
    _isolated_user_home as _isolated_user_home,
)
from tests.conftest import (
    _suspend_proactive_care_loops as _suspend_proactive_care_loops,
)
from tests.conftest import (
    tmp_octop_home as tmp_octop_home,
)
from tests.integration.conftest import (  # noqa: E402
    env as env,
)
from tests.integration.conftest import (
    env_admin_alice as env_admin_alice,
)
from tests.integration.conftest import (
    env_with_provider as env_with_provider,
)
from tests.support.auth import create_user  # noqa: E402


async def resource_agent(client: Any, auth: dict[str, str]) -> dict[str, Any]:
    result = await client.post(
        "/api/agents",
        headers=auth,
        json={
            "name": "Resource API fixture",
            "description": "wanx-resource:opaque-install-operation",
            "is_shared": False,
            "config": {
                "backend": {"type": "filesystem", "virtual_mode": True},
                "providers": ["openai"],
                "default_model": "openai:gpt-4o",
                "wanx_resource": {"resourceId": "test-expert", "version": "1.0.0"},
            },
            "knowledge_base_ids": [],
            "mcp_servers": [],
            "skill_package_ids": [],
        },
    )
    assert result.status_code == 201, result.text
    return result.json()


async def test_private_creation_marker_files_and_other_user_rejection(env_admin_alice: Any) -> None:
    client, _server, admin, alice = env_admin_alice
    me = (await client.get("/api/auth/me", headers=alice)).json()
    created = await resource_agent(client, alice)
    identity = created["agent_id"]
    row = (await client.get(f"/api/agents/{identity}", headers=alice)).json()
    assert row["user_id"] == me["id"]
    assert row["is_shared"] is False
    assert row["application_id"] == "wanx"
    assert row["config"]["wanx_resource"] == {"resourceId": "test-expert", "version": "1.0.0"}
    assert row["description"] == "wanx-resource:opaque-install-operation"

    manifest = json.dumps({"id": "test-expert", "prompt_files": ["AGENTS.md"]})
    for path, content in ((".octop/manifest.json", manifest), ("AGENTS.md", "Resource template")):
        written = await client.put(
            f"/api/agents/{identity}/workspace/file",
            params={"path": path, "from_workspace": "true"},
            headers=alice,
            json={"content": content},
        )
        assert written.status_code == 200, written.text
        read = await client.get(
            f"/api/agents/{identity}/workspace/file",
            params={"path": path, "from_workspace": "true"},
            headers=alice,
        )
        assert read.status_code == 200, read.text
        assert read.json()["content"] == content

    binary = b"\x00\xff\x01binary"
    binary_path = "skills/demo/assets/data.bin"
    uploaded = await client.post(
        f"/api/agents/{identity}/workspace/upload",
        params={"path": binary_path, "from_workspace": "true"},
        headers=alice,
        files={"file": ("data.bin", binary, "application/octet-stream")},
    )
    assert uploaded.status_code == 200, uploaded.text
    downloaded = await client.get(
        f"/api/agents/{identity}/workspace/download",
        params={"path": binary_path, "from_workspace": "true"},
        headers=alice,
    )
    assert downloaded.status_code == 200, downloaded.text
    assert downloaded.content == binary
    bob = await create_user(client, admin, username="resource-bob")
    denied = await client.put(
        f"/api/agents/{identity}/workspace/file",
        params={"path": "AGENTS.md", "from_workspace": "true"},
        headers=bob,
        json={"content": "attempted overwrite"},
    )
    assert denied.status_code == 403, denied.text


async def test_global_package_copy_preserves_private_filesystem_isolation(
    env_admin_alice: Any,
) -> None:
    client, _server, admin, alice = env_admin_alice
    created = await resource_agent(client, alice)
    identity = created["agent_id"]
    result = await client.post(
        "/api/skill-packages",
        headers=admin,
        json={"name": "wanx-resource-demo-1.0.0", "description": "immutable resource fixture"},
    )
    assert result.status_code == 200, result.text
    package_id = result.json()["id"]
    skill = "---\nname: demo\ndescription: Fixture skill\n---\n# Demo\n"
    binary = b"\x00\xfffixture-file"
    result = await client.post(
        f"/api/skill-packages/{package_id}/skills",
        headers=admin,
        json={
            "name": "demo",
            "overwrite": False,
            "files": [
                {"path": "SKILL.md", "content_base64": base64.b64encode(skill.encode()).decode()},
                {"path": "assets/data.bin", "content_base64": base64.b64encode(binary).decode()},
            ],
        },
    )
    assert result.status_code == 200, result.text
    assert result.json()["slug"] == "demo"
    detail = await client.get(f"/api/skill-packages/{package_id}/skills/demo", headers=admin)
    assert detail.status_code == 200, detail.text
    assert detail.json()["raw"] == skill
    # The public detail route is a manifest preview, not an attachment digest proof.
    assert "files" not in detail.json()

    mount = await client.put(
        f"/api/agents/{identity}/skill-packages",
        headers=alice,
        json={"package_ids": [package_id]},
    )
    # Octop only mounts global packages on a nonvirtual host-root backend.
    # Resource installation must not widen the private agent's filesystem scope.
    assert mount.status_code == 400, mount.text
    assert mount.json()["error"]["code"] == "SKILL_PACKAGE_BACKEND_UNSUPPORTED"
    mounted = await client.get(f"/api/agents/{identity}/skill-packages", headers=alice)
    assert mounted.status_code == 200, mounted.text
    assert mounted.json()["package_ids"] == []

    # The existing copy route provides an explicit path to verify binary exports.
    copied = await client.post(
        f"/api/agents/{identity}/skill-packages/{package_id}/copy",
        headers=alice,
        json={"skill_slugs": ["demo"], "overwrite": False},
    )
    assert copied.status_code == 200, copied.text
    assert copied.json() == {"copied": ["demo"]}
    downloaded = await client.get(
        f"/api/agents/{identity}/workspace/download",
        params={"path": "skills/demo/assets/data.bin", "from_workspace": "true"},
        headers=alice,
    )
    assert downloaded.status_code == 200, downloaded.text
    assert downloaded.content == binary


@pytest.mark.parametrize("controlled_resources", [False, True])
@pytest.mark.parametrize("share_experts", [False, True])
async def test_resource_runtime_pins_existing_history_through_real_octop(
    env_admin_alice: Any, tmp_path: Any, controlled_resources: bool, share_experts: bool
) -> None:
    """Exercise the bridge implementation, not just hand-written endpoint shapes."""
    import hashlib
    import os
    import sys
    import time
    from pathlib import Path
    from types import SimpleNamespace

    import httpx
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from wanx_bridge.resources import ResourceCatalog, ResourceConfig
    from wanx_bridge.resources_contract import canonical
    from wanx_bridge.resources_runtime import ResourceRuntime

    client, _server, admin, alice = env_admin_alice
    me = (await client.get("/api/auth/me", headers=alice)).json()
    key = Ed25519PrivateKey.generate()
    trust_file = tmp_path / "resource-trust.json"
    trust_file.write_bytes(
        canonical(
            {
                "schemaVersion": 1,
                "keys": {
                    "test": key.public_key()
                    .public_bytes(
                        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
                    )
                    .decode()
                },
            }
        )
    )
    credential_file = tmp_path / "device.key"
    credential_file.write_text("resource-api-test-device-only")
    credential_file.chmod(0o600)
    artifact_packages, all_envelopes, envelopes = {}, {}, []
    skill_text = "---\nname: file_reader\ndescription: test\n---\n# Private resource skill"
    asset_bytes = b"\x00\xffprivate-package"

    def bundle(
        kind: str, resource_id: str, version: str, files: dict[str, bytes], dependencies: list[Any]
    ) -> dict[str, Any]:
        package = {
            "schemaVersion": 1,
            "kind": kind,
            "resourceId": resource_id,
            "version": version,
            "name": "资源测试" + resource_id,
            "description": "Integration fixture",
            "dependencies": dependencies,
            "metadata": {"expertInstanceScope": "account"}
            if kind == "expert" and share_experts
            else {},
            "files": [
                {"path": path, "contentBase64": base64.b64encode(content).decode()}
                for path, content in files.items()
            ],
        }
        raw = canonical(package)
        payload = {name: value for name, value in package.items() if name != "files"}
        digest = hashlib.sha256(raw).hexdigest()
        payload.update(
            {
                "purpose": "wanx.resource.v1",
                "package": {
                    "format": "wanx-resource-json",
                    "sha256": digest,
                    "sizeBytes": len(raw),
                },
                "publishedAt": "2026-10-15T00:00:00Z",
            }
        )
        if controlled_resources:
            payload["releaseAccess"] = "account"
        envelope = {
            "payload": payload,
            "signature": {
                "algorithm": "ed25519",
                "keyId": "test",
                "signatureBase64": base64.b64encode(key.sign(canonical(payload))).decode(),
            },
        }
        artifact_packages[digest] = raw
        all_envelopes[(kind, resource_id, version)] = envelope
        return envelope

    skill = bundle(
        "skill-package",
        "fixture-skills",
        "1.0.0",
        {
            "skills/file_reader/SKILL.md": skill_text.encode(),
            "skills/file_reader/assets/binary.dat": asset_bytes,
        },
        [],
    )
    dep = {"kind": "skill-package", "resourceId": "fixture-skills", "minVersion": "1.0.0"}
    expert = bundle(
        "expert",
        "fixture-expert",
        "1.0.0",
        {
            "manifest.json": b'{"id":"fixture-expert","prompt_files":["AGENTS.md"]}',
            "AGENTS.md": b"Original verified expert",
        },
        [dep],
    )
    envelopes[:] = [skill, expert]
    requirements = [{"kind": "expert", "resourceId": "fixture-expert", "minVersion": "1.0.0"}]

    async def cloud(request: Any) -> Any:
        if request.url.host == "resource-download.test":
            assert "authorization" not in request.headers
            return httpx.Response(
                200, content=artifact_packages[request.url.path.rsplit("/", 1)[-1]]
            )
        assert (
            request.headers["authorization"] == "CentaurOS-DeviceKey resource-api-test-device-only"
        )
        if request.url.path.endswith("/resolve"):
            body = json.loads(request.content)
            assert body["resourceProtocol"] == 2
            data = {
                "schemaVersion": 1,
                "applicationId": body["applicationId"],
                "artifactId": body["artifactId"],
                "backendProductId": "wanx",
                "requirements": requirements,
                "resources": envelopes,
            }
            if controlled_resources:
                data["releaseAccess"] = "account"
        elif request.url.path.endswith(("/download", "/access")):
            body = json.loads(request.content)
            envelope = all_envelopes[
                tuple(body[name] for name in ("kind", "resourceId", "version"))
            ]
            data = {
                "envelope": envelope,
                "url": "https://resource-download.test/package/"
                + envelope["payload"]["package"]["sha256"],
                "expiresAt": int(time.time()) + 300,
            }
            if request.url.path.endswith("/access"):
                data = {"envelope": envelope, "channel": "stable"}
        else:
            raise AssertionError(request.url)
        return httpx.Response(200, json={"code": 200, "success": True, "data": data})

    class LocalAdmin:
        async def _admin(
            self, method: str, path: str, *, retry_auth: bool = True, **kwargs: Any
        ) -> Any:
            if method == "POST" and path.startswith("/api/skill-packages"):
                assert retry_auth is False
            return await client.request(method, path, headers=admin, **kwargs)

        async def request(self, method: str, path: str, **kwargs: Any) -> Any:
            result = await self._admin(method, path, **kwargs)
            assert result.status_code in {200, 201}, result.text
            return result.json()

    async def user_request(method: str, path: str, **kwargs: Any) -> Any:
        return await client.request(method, path, headers=alice, **kwargs)

    async def live() -> None:
        pass

    config = ResourceConfig(
        "fixture-box",
        credential_file,
        "https://resource-admin.test",
        trust_file,
        tmp_path / "resource-state",
        frozenset({"resource-download.test"}),
    )
    catalog = ResourceCatalog(config, transport=httpx.MockTransport(cloud))
    runtime = ResourceRuntime(catalog, LocalAdmin())
    body = {
        "schemaVersion": 1,
        "applicationId": "centaurai.resource-fixture",
        "artifactId": "fixture-artifact-1",
    }
    context = {
        "device_id": "fixture-box",
        "ownership_epoch": 1,
        "sub": "a898cd6c-bca4-42dc-9a35-4165c20b5d21",
    }
    session = SimpleNamespace(user=me)
    result = await runtime.prepare(body, session, context, user_request, live)
    assert result["status"] == "ready", result
    assert len(result["bindings"]) == 2
    agent = next(item["instanceId"] for item in result["bindings"] if item["kind"] == "expert")
    private = await client.get(f"/api/agents/{agent}", headers=alice)
    assert private.json()["is_shared"] is False
    assert private.json()["config"]["backend"]["virtual_mode"] is True
    assert private.json()["skill_package_ids"] == []
    binary = await client.get(
        f"/api/agents/{agent}/workspace/download",
        headers=alice,
        params={"path": "skills/file_reader/assets/binary.dat", "from_workspace": "true"},
    )
    assert binary.content == asset_bytes
    repeated = await runtime.prepare(body, session, context, user_request, live)
    assert repeated["bindings"] == result["bindings"]
    other_body = {**body, "applicationId": "centaurai.resource-other"}
    other = await runtime.prepare(other_body, session, context, user_request, live)
    assert other["status"] == "ready", other
    initial_skill = next(item for item in result["bindings"] if item["kind"] == "skill-package")
    assert (
        next(item for item in other["bindings"] if item["kind"] == "skill-package") == initial_skill
    )
    other_agent = next(item["instanceId"] for item in other["bindings"] if item["kind"] == "expert")
    assert (other_agent == agent) is share_experts
    global_packages = await client.get("/api/skill-packages", headers=admin)
    assert len(global_packages.json()) == 1
    inspected = await runtime.inspect(body, session, context, user_request, live)
    assert inspected["status"] == "ready"
    # A schema-2 artifact prepares its own durable selection without rewriting
    # the live schema-1 application ledger or the customer's private workspace.
    active_ledgers = {
        path: path.read_bytes() for path in (catalog.directory / "bindings").glob("*.json")
    }
    candidate_body = {
        **body,
        "schemaVersion": 2,
        "artifactId": "a81c64e2-5ce7-4f73-a312-0bbef6c54071",
        "operationId": "fixture-install-2",
    }
    candidate = await runtime.prepare_candidate(
        candidate_body, session, context, user_request, live
    )
    assert candidate["status"] == "ready", candidate
    assert candidate["bindings"] == result["bindings"]
    assert all(path.read_bytes() == raw for path, raw in active_ledgers.items())
    candidate_inspect = {
        key: candidate[key]
        for key in ("schemaVersion", "applicationId", "artifactId", "bindingSetId")
    }
    assert (
        await runtime.inspect_candidate(candidate_inspect, session, context, user_request, live)
    )["bindings"] == candidate["bindings"]
    if (
        not controlled_resources
        and not share_experts
        and os.environ.get("WANX_WRITE_RESOURCE_CANDIDATE_FIXTURE") == "1"
    ):
        destination = Path(__file__).parent / "fixtures/resources-prepare-v2.json"
        destination.parent.mkdir(exist_ok=True)
        destination.write_text(json.dumps(candidate, ensure_ascii=False, indent=2) + "\n")
    if (
        not controlled_resources
        and not share_experts
        and os.environ.get("WANX_WRITE_RESOURCE_FIXTURE") == "1"
    ):
        destination = Path(__file__).parent / "fixtures/resources-prepare-v1.json"
        destination.parent.mkdir(exist_ok=True)
        destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    envelopes[:] = [
        skill,
        bundle(
            "expert",
            "fixture-expert",
            "2.0.0",
            {
                "manifest.json": b'{"id":"fixture-expert","prompt_files":["AGENTS.md"]}',
                "AGENTS.md": b"New compatible verified expert",
            },
            [dep],
        ),
    ]
    reused = await runtime.prepare(body, session, context, user_request, live)
    assert reused["status"] == "ready", reused
    assert reused["bindings"] == result["bindings"]
    assert reused["updateAvailable"][0]["latestVersion"] == "2.0.0"
    second_skill = bundle(
        "skill-package",
        "fixture-skills",
        "2.0.0",
        {
            "skills/file_reader/SKILL.md": (skill_text + "\nVersion two").encode(),
            "skills/file_reader/assets/binary.dat": b"updated-private-skill",
        },
        [],
    )
    envelopes[:] = [second_skill, envelopes[1]]
    skill_update = await runtime.prepare(body, session, context, user_request, live)
    assert skill_update["bindings"] == result["bindings"]
    assert len(skill_update["updateAvailable"]) == 2
    unchanged = await client.get(
        f"/api/agents/{agent}/workspace/download",
        headers=alice,
        params={"path": "skills/file_reader/assets/binary.dat", "from_workspace": "true"},
    )
    assert unchanged.content == asset_bytes
    if share_experts:
        old_requirements = list(requirements)
        requirements[:] = [{**dep, "minVersion": "2.0.0"}]
        skill_only = await runtime.prepare(
            {**body, "applicationId": "centaurai.resource-skill-only"},
            session,
            context,
            user_request,
            live,
        )
        assert skill_only["status"] == "ready", skill_only
        assert skill_only["bindings"][0]["version"] == "2.0.0"
        requirements[:] = [dep, *old_requirements]
        # A new application must adopt the private expert's complete old graph,
        # even if the first root selects a skill with a newer shared installation.
        third = await runtime.prepare(
            {**body, "applicationId": "centaurai.resource-third"},
            session,
            context,
            user_request,
            live,
        )
        assert third["bindings"] == result["bindings"], third
        assert len((await client.get("/api/skill-packages", headers=admin)).json()) == 2
        requirements[0] = {**dep, "minVersion": "2.0.0"}
        incompatible = await runtime.prepare(
            {**body, "applicationId": "centaurai.resource-fourth"},
            session,
            context,
            user_request,
            live,
        )
        assert incompatible["code"] == "RESOURCE_MIGRATION_REQUIRED"
        requirements[:] = old_requirements

    # A higher required skill version would change this existing expert's private
    # working files; no implicit agent switch or misleading version success.
    requirements.append(
        {"kind": "skill-package", "resourceId": "fixture-skills", "minVersion": "2.0.0"}
    )
    blocked_skill = await runtime.prepare(body, session, context, user_request, live)
    assert (
        blocked_skill["status"] == "blocked"
        and blocked_skill["code"] == "RESOURCE_MIGRATION_REQUIRED"
    )
    requirements.pop()
    requirements[0]["minVersion"] = "2.0.0"
    blocked_expert = await runtime.prepare(body, session, context, user_request, live)
    assert blocked_expert["code"] == "RESOURCE_MIGRATION_REQUIRED"
    requirements[0]["minVersion"] = "1.0.0"
    assert (await runtime.prepare(body, session, context, user_request, live))[
        "bindings"
    ] == result["bindings"]

    # Adding an unrelated expert is permitted but must not incidentally replace
    # the first expert because its catalog now contains a newer version.
    extra = bundle(
        "expert",
        "fixture-second-expert",
        "1.0.0",
        {
            "manifest.json": b'{"id":"fixture-second-expert","prompt_files":["AGENTS.md"]}',
            "AGENTS.md": b"Second expert",
        },
        [],
    )
    envelopes.append(extra)
    requirements.append(
        {"kind": "expert", "resourceId": "fixture-second-expert", "minVersion": "1.0.0"}
    )
    expanded = await runtime.prepare(body, session, context, user_request, live)
    assert expanded["status"] == "ready", expanded
    assert (
        next(x for x in expanded["bindings"] if x["resourceId"] == "fixture-expert")["instanceId"]
        == agent
    )
    assert (
        next(x for x in expanded["bindings"] if x["kind"] == "skill-package")["version"] == "1.0.0"
    )
    assert len(expanded["bindings"]) == 3
    restarted = ResourceRuntime(catalog, LocalAdmin())
    checked = await restarted.inspect(body, session, context, user_request, live)
    assert checked["bindings"] == expanded["bindings"]

    # Real transport exceptions on install-only endpoints are never reached just
    # because a catalog version changes; current verified bindings remain usable.
    from wanx_bridge.admin_client import BridgeUpstreamError

    class FailingAdmin(LocalAdmin):
        async def request(self, method: str, path: str, **kwargs: Any) -> Any:
            if method == "POST":
                raise BridgeUpstreamError("BOX_UPSTREAM_UNAVAILABLE")
            return await super().request(method, path, **kwargs)

    async def no_install_request(method: str, path: str, **kwargs: Any) -> Any:
        if method != "GET":
            raise httpx.ConnectError("install-only transport unavailable")
        return await user_request(method, path, **kwargs)

    failing = ResourceRuntime(catalog, FailingAdmin())
    still_ready = await failing.prepare(body, session, context, no_install_request, live)
    assert still_ready["status"] == "ready", still_ready
    assert still_ready["bindings"] == expanded["bindings"]
    # Stable pool reads/copies are safe; shared writes/mounts are not. Gray pool
    # content remains completely internal to the verified resource workflow.
    from wanx_bridge.server import create_app

    bob = await create_user(client, admin, username="resource-guard-bob")
    package_id = next(
        item["packageId"] for item in result["bindings"] if item["kind"] == "skill-package"
    )
    direct = await client.get(f"/api/skill-packages/{package_id}", headers=bob)
    assert direct.status_code == 200
    assert direct.json()["description"].startswith(
        "wanx-resource:account:" if controlled_resources else "wanx-resource:shared:"
    )
    bob_agent = (await resource_agent(client, bob))["agent_id"]

    class BridgeAuth:
        async def authorize(self, marker: str) -> Any:
            assert marker == "fixture-bridge-session"
            return {"upstream_token": bob["Authorization"].removeprefix("Bearer ")}

        async def assert_live(self, session: Any) -> None:
            pass

    app = create_app(
        BridgeAuth(),
        LocalAdmin(),
        http_transport=httpx.ASGITransport(app=client._transport.app),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://bridge.test",
        headers={"Authorization": "Bearer fixture-bridge-session"},
    ) as public:
        listed = await public.get("/api/skill-packages")
        assert listed.status_code == 200, listed.text
        assert any(row["id"] == package_id for row in listed.json()) is not controlled_resources
        assert listed.headers["cache-control"] == "no-store"
        for path in (
            f"/api/skill-packages/{package_id}",
            f"/api/skill-packages/{package_id}/skills/file_reader",
        ):
            response = await public.get(path)
            assert response.status_code == (403 if controlled_resources else 200), response.text
        copied = await public.post(
            f"/api/agents/{bob_agent}/skill-packages/{package_id}/copy",
            json={"skill_slugs": ["file_reader"], "overwrite": False},
        )
        assert copied.status_code == (403 if controlled_resources else 200), copied.text
        if not controlled_resources:
            private_copy = await public.get(
                f"/api/agents/{bob_agent}/workspace/download",
                params={"path": "skills/file_reader/assets/binary.dat", "from_workspace": "true"},
            )
            assert private_copy.content == asset_bytes
        for method, path, payload in (
            (
                "PATCH",
                f"/api/skill-packages/{package_id}",
                {"description": "remove the immutable marker"},
            ),
            ("DELETE", f"/api/skill-packages/{package_id}", {}),
            ("POST", f"/api/skill-packages/{package_id}/skills", {"name": "injected", "files": []}),
            ("PUT", f"/api/agents/{bob_agent}/skill-packages", {"package_ids": [package_id]}),
            ("POST", "/api/agents", {"name": "Bypass", "skill_package_ids": [package_id]}),
            (
                "PATCH",
                f"/api/agents/{bob_agent}",
                {"config": {"skill_package_ids": [package_id]}},
            ),
        ):
            response = await public.request(method, path, json=payload)
            assert response.status_code == 403, response.text
            if controlled_resources:
                assert response.json()["code"] == "RESOURCE_MANAGED_PACKAGE_PRIVATE"
    preserved = await client.get(
        f"/api/agents/{agent}/workspace/download",
        headers=alice,
        params={"path": "skills/file_reader/assets/binary.dat", "from_workspace": "true"},
    )
    assert preserved.content == asset_bytes
    await catalog.close()
