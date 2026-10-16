"""Signed distribution and user-scoped preparation contract regressions."""

import base64
import copy
import hashlib
import time
from types import SimpleNamespace

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.resources import ResourceCatalog, ResourceConfig
from wanx_bridge.resources_contract import (
    canonical,
    expert_files,
    validate_package,
    verify_envelope,
)
from wanx_bridge.resources_runtime import ResourceRuntime


def signed(
    private, *, kind="expert", resource_id="companion", version="1.0.0", files=None, deps=None
):
    package = {
        "schemaVersion": 1,
        "kind": kind,
        "resourceId": resource_id,
        "version": version,
        "name": "知君",
        "description": "source",
        "dependencies": deps or [],
        "metadata": {},
        "files": files
        or [
            {"path": "AGENTS.md", "contentBase64": base64.b64encode(b"Be helpful").decode()},
            {"path": "manifest.json", "contentBase64": base64.b64encode(b"{}").decode()},
        ],
    }
    raw = canonical(package)
    payload = {key: value for key, value in package.items() if key != "files"}
    payload.update(
        {
            "purpose": "wanx.resource.v1",
            "package": {
                "format": "wanx-resource-json",
                "sha256": hashlib.sha256(raw).hexdigest(),
                "sizeBytes": len(raw),
            },
            "publishedAt": "2026-10-15T00:00:00Z",
        }
    )
    envelope = {
        "payload": payload,
        "signature": {
            "algorithm": "ed25519",
            "keyId": "resources-1",
            "signatureBase64": base64.b64encode(private.sign(canonical(payload))).decode(),
        },
    }
    return package, raw, envelope


@pytest.fixture
def setup(tmp_path):
    private = Ed25519PrivateKey.generate()
    trust = {
        "schemaVersion": 1,
        "keys": {
            "resources-1": private.public_key()
            .public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
            )
            .decode()
        },
    }
    trust_file = tmp_path / "trust.json"
    trust_file.write_bytes(canonical(trust))
    key_file = tmp_path / "device.key"
    key_file.write_text("device-secret")
    key_file.chmod(0o600)
    config = ResourceConfig(
        "box-1",
        key_file,
        "https://admin.example/prod-api",
        trust_file,
        tmp_path / "state",
        frozenset({"artifacts.example"}),
    )
    return private, trust, config


def test_signatures_and_raw_digest_are_independent_of_server_claims(setup):
    private, trust, _ = setup
    package, raw, envelope = signed(private)
    assert verify_envelope(envelope, trust) == envelope["payload"]
    assert validate_package(raw, envelope["payload"]) == package
    changed = copy.deepcopy(envelope)
    changed["payload"]["version"] = "99.0.0"
    with pytest.raises(BridgeAuthError, match="RESOURCE_SIGNATURE_INVALID"):
        verify_envelope(changed, trust)
    with pytest.raises(BridgeAuthError, match="RESOURCE_PACKAGE_DIGEST_MISMATCH"):
        validate_package(raw + b" ", envelope["payload"])
    other = Ed25519PrivateKey.generate()
    with pytest.raises(BridgeAuthError, match="RESOURCE_SIGNATURE_INVALID"):
        verify_envelope(signed(other)[2], trust)


@pytest.mark.parametrize(
    "path",
    [
        "../secret",
        "/absolute",
        "a/../../b",
        "a\\b",
        "AUX.txt",
        "a//b",
        "a:ads",
        "a/..",
        "a. ",
        ".octop/auth/key",
    ],
)
def test_host_paths_and_expert_secrets_rejected(setup, path):
    private, _, _ = setup
    package, raw, envelope = signed(private, files=[{"path": path, "contentBase64": "eA=="}])
    with pytest.raises(BridgeAuthError):
        expert_files(validate_package(raw, envelope["payload"]))


def test_manifest_maps_to_public_workspace_system_manifest(setup):
    package = signed(setup[0])[0]
    assert expert_files(package)[".octop/manifest.json"] == b"{}"


async def test_download_no_redirects_and_no_device_secret_to_artifact_host(setup):
    private, _, config = setup
    _, raw, envelope = signed(private)
    requests = []
    redirect = False

    async def handler(request):
        requests.append(request)
        if request.url.host == "admin.example":
            assert request.headers["authorization"] == "CentaurOS-DeviceKey device-secret"
            return httpx.Response(
                200,
                json={
                    "code": 200,
                    "success": True,
                    "data": {
                        "envelope": envelope,
                        "url": "https://artifacts.example/package",
                        "expiresAt": int(time.time()) + 300,
                    },
                },
            )
        assert "authorization" not in request.headers
        return (
            httpx.Response(302, headers={"Location": "https://evil.example/steal"})
            if redirect
            else httpx.Response(200, content=raw)
        )

    catalog = ResourceCatalog(config, transport=httpx.MockTransport(handler))
    assert (await catalog.package(envelope))["resourceId"] == "companion"
    requests.clear()
    assert (await catalog.package(envelope))["resourceId"] == "companion"
    assert not requests
    (config.state_dir / "packages" / (envelope["payload"]["package"]["sha256"] + ".json")).unlink()
    redirect = True
    with pytest.raises(BridgeAuthError, match="RESOURCE_DOWNLOAD_FAILED"):
        await catalog.package(envelope)
    assert not any(r.url.host == "evil.example" for r in requests)
    await catalog.close()


async def test_changed_download_envelope_and_corrupt_cache_fail_closed(setup):
    private, _, config = setup
    _, raw, envelope = signed(private)
    changed = signed(private, version="2.0.0")[2]

    async def handler(request):
        return httpx.Response(
            200,
            json={
                "code": 200,
                "success": True,
                "data": {
                    "envelope": changed,
                    "url": "https://artifacts.example/p",
                    "expiresAt": int(time.time()) + 300,
                },
            },
        )

    catalog = ResourceCatalog(config, transport=httpx.MockTransport(handler))
    with pytest.raises(BridgeAuthError, match="RESOURCE_PACKAGE_IDENTITY_MISMATCH"):
        await catalog.package(envelope)
    cached = config.state_dir / "packages" / (envelope["payload"]["package"]["sha256"] + ".json")
    cached.parent.mkdir()
    cached.write_bytes(raw + b"x")
    with pytest.raises(BridgeAuthError, match="RESOURCE_PACKAGE_DIGEST_MISMATCH"):
        await catalog.package(envelope)
    await catalog.close()


class FakeCatalog:
    def __init__(self, config, private, trust):
        self.config, self.directory, self.private, self.trust = (
            config,
            config.state_dir,
            private,
            trust,
        )
        self.directory.mkdir()
        self.package_value, _, self.envelope = signed(private)
        self.product = "wanx"
        self.calls = 0
        self.minimum = "1.0.0"

    def verify(self, envelope):
        return verify_envelope(envelope, self.trust)

    async def resolve(self, application, artifact):
        return {
            "schemaVersion": 1,
            "applicationId": application,
            "artifactId": artifact,
            "backendProductId": self.product,
            "requirements": [
                {"kind": "expert", "resourceId": "companion", "minVersion": self.minimum}
            ],
            "resources": [self.envelope],
        }

    async def package(self, envelope):
        self.calls += 1
        return self.package_value


class PublicOctopProtocol:
    """Fault injection against the public API shape, not an invented endpoint."""

    def __init__(self):
        self.user = {"id": 17, "application_id": "wanx"}
        self.rows, self.files = {}, {}
        self.calls = []
        self.fail_upload = False
        self.lost_create = False

    async def __call__(self, method, path, **kwargs):
        self.calls.append((method, path))
        url = httpx.URL("http://127.0.0.1" + path)
        if path == "/api/auth/me":
            return httpx.Response(200, json=self.user)
        if method == "GET" and url.path == "/api/agents":
            return httpx.Response(200, json=list(self.rows.values()))
        if method == "POST" and path == "/api/agents":
            body = kwargs["json"]
            key = "agent-" + str(len(self.rows) + 1)
            row = {
                **body,
                "agent_id": key,
                "user_id": self.user["id"],
                "application_id": self.user["application_id"],
                "state": "running",
                "kind": "expert",
            }
            self.rows[key], self.files[key] = row, {"AGENTS.md": b"seed"}
            if self.lost_create:
                raise BridgeAuthError("RESOURCE_UPSTREAM_OPERATION_FAILED", 502)
            return httpx.Response(201, json=row)
        parts = url.path.split("/")
        row = self.rows.get(parts[3]) if len(parts) > 3 else None
        if row is None:
            return httpx.Response(404)
        if len(parts) == 4:
            return httpx.Response(200, json=row)
        if parts[-1] in {"reload", "start"}:
            row["state"] = "running"
            return httpx.Response(204)
        if parts[-1] == "status":
            return httpx.Response(200, json={"state": row["state"]})
        if parts[-1] == "skill-packages":
            row["skill_package_ids"] = kwargs["json"]["package_ids"]
            return httpx.Response(200, json=kwargs["json"])
        file_path = url.params["path"]
        files = self.files[row["agent_id"]]
        if parts[-1] == "download":
            return (
                httpx.Response(200, content=files[file_path])
                if file_path in files
                else httpx.Response(404)
            )
        if parts[-1] == "upload":
            if self.fail_upload:
                self.fail_upload = False
                raise BridgeAuthError("RESOURCE_UPSTREAM_OPERATION_FAILED", 502)
            files[file_path] = kwargs["files"]["file"][1]
            return httpx.Response(200, json={"path": file_path, "size": len(files[file_path])})
        if method == "DELETE":
            files.pop(file_path, None)
            return httpx.Response(204)
        raise AssertionError((method, path))


@pytest.fixture
async def runtime(setup):
    private, trust, config = setup
    catalog = FakeCatalog(config, private, trust)
    runtime = ResourceRuntime(catalog, object())
    upstream = PublicOctopProtocol()

    async def live():
        return None

    session = SimpleNamespace(user=upstream.user)
    scope = {"device_id": "box-1", "ownership_epoch": 1, "sub": "consumer-1"}
    body = {"schemaVersion": 1, "applicationId": "centaurai.test", "artifactId": "artifact-1"}
    return runtime, upstream, session, scope, body, live


async def prepare(env, **kwargs):
    runtime, upstream, session, scope, body, live = env
    return await runtime.prepare(body, session, scope, upstream, live, **kwargs)


async def test_private_install_is_idempotent_and_readonly_proves_bytes(runtime):
    result = await prepare(runtime)
    assert result["status"] == "ready"
    assert result["backendProductId"] == "wanx"
    assert result["observedAt"].endswith("Z")
    assert len(runtime[1].rows) == 1
    assert runtime[1].files["agent-1"][".octop/manifest.json"] == b"{}"
    before = len(runtime[1].calls)
    assert (await prepare(runtime))["bindings"] == result["bindings"]
    assert all(method == "GET" for method, _ in runtime[1].calls[before:])
    assert (await prepare(runtime, read_only=True))["status"] == "ready"
    assert len(runtime[1].rows) == 1


async def test_user_changes_are_never_overwritten(runtime):
    assert (await prepare(runtime))["status"] == "ready"
    runtime[1].files["agent-1"]["AGENTS.md"] = b"customer edits"
    result = await prepare(runtime)
    assert result["status"] == "blocked" and result["code"] == "RESOURCE_USER_MODIFIED"
    assert runtime[1].files["agent-1"]["AGENTS.md"] == b"customer edits"


async def test_ownership_epoch_produces_new_isolated_instance(runtime):
    assert (await prepare(runtime))["status"] == "ready"
    runtime[3]["ownership_epoch"] = 2
    result = await prepare(runtime)
    assert result["status"] == "ready"
    assert len(runtime[1].rows) == 2
    assert result["bindings"][0]["instanceId"] == "agent-2"


async def test_lost_create_response_recovers_exact_marker_without_duplicate(runtime):
    runtime[1].lost_create = True
    assert (await prepare(runtime))["status"] == "blocked"
    runtime[1].lost_create = False
    assert (await prepare(runtime))["status"] == "ready"
    assert len(runtime[1].rows) == 1


async def test_interrupted_install_does_not_replace_user_edit_on_retry(runtime):
    runtime[1].fail_upload = True
    assert (await prepare(runtime))["status"] == "blocked"
    runtime[1].files["agent-1"]["AGENTS.md"] = b"customer during interruption"
    result = await prepare(runtime)
    assert result["status"] == "blocked" and result["code"] == "RESOURCE_USER_MODIFIED"


async def test_download_does_not_mean_application_ready_and_old_profile_blocked(runtime):
    runtime[0].catalog.product = "super-advisory"
    result = await prepare(runtime)
    assert result["authorization"]["status"] == "blocked"
    runtime[1].user["application_id"] = "super-advisory"
    result = await prepare(runtime)
    assert (
        result["status"] == "blocked" and result["code"] == "RESOURCE_PRODUCT_PROFILE_UNSUPPORTED"
    )
    assert not runtime[1].rows and runtime[0].catalog.calls == 0


async def test_non_managed_same_name_is_not_adopted(runtime):
    runtime[1].rows["unmanaged"] = {
        "agent_id": "unmanaged",
        "name": "知君",
        "user_id": 17,
        "application_id": "wanx",
        "is_shared": False,
        "config": {},
    }
    result = await prepare(runtime)
    assert result["status"] == "ready"
    assert result["bindings"][0]["instanceId"] != "unmanaged"
    assert runtime[1].rows["unmanaged"]["config"] == {}


async def test_readonly_missing_dependency_never_downloads_or_creates(runtime):
    result = await prepare(runtime, read_only=True)
    assert result["status"] == "blocked"
    assert result["code"] == "RESOURCE_NOT_PREPARED"
    assert not runtime[1].rows and runtime[0].catalog.calls == 0


async def test_published_update_keeps_instance_and_private_memory(runtime):
    first = await prepare(runtime)
    runtime[1].files["agent-1"]["memory/customer.md"] = b"keep private memory"
    catalog = runtime[0].catalog
    files = [
        {"path": "AGENTS.md", "contentBase64": base64.b64encode(b"New compatible prompt").decode()},
        {"path": "manifest.json", "contentBase64": "e30="},
    ]
    catalog.package_value, _, catalog.envelope = signed(
        catalog.private, version="2.0.0", files=files
    )
    second = await prepare(runtime)
    assert second["status"] == "ready"
    assert second["bindings"] == first["bindings"]
    assert second["updateAvailable"][0]["latestVersion"] == "2.0.0"
    assert runtime[1].files["agent-1"]["memory/customer.md"] == b"keep private memory"
    assert runtime[1].files["agent-1"]["AGENTS.md"] == b"Be helpful"
    catalog.package_value, _, catalog.envelope = signed(catalog.private)
    assert (await prepare(runtime))["bindings"][0]["version"] == "1.0.0"


async def test_failed_new_version_keeps_old_compatible_binding_available(runtime):
    first = await prepare(runtime)
    catalog = runtime[0].catalog
    catalog.package_value, _, catalog.envelope = signed(catalog.private, version="2.0.0")
    runtime[1].fail_upload = True
    second = await prepare(runtime)
    assert second["status"] == "ready", second
    assert second["bindings"] == first["bindings"]
    assert second["updateAvailable"][0]["latestVersion"] == "2.0.0"
    assert (await prepare(runtime, read_only=True))["bindings"] == first["bindings"]
    assert runtime[1].files["agent-1"]["AGENTS.md"] == b"Be helpful"


async def test_real_http_transport_failure_does_not_block_compatible_old_instance(runtime):
    first = await prepare(runtime)
    catalog = runtime[0].catalog
    catalog.package_value, _, catalog.envelope = signed(catalog.private, version="2.0.0")
    original = runtime[1]

    async def unavailable(method, path, **kwargs):
        if method == "POST":
            raise httpx.ConnectError("local unavailable")
        return await original(method, path, **kwargs)

    second = await runtime[0].prepare(runtime[4], runtime[2], runtime[3], unavailable, runtime[5])
    assert second["status"] == "ready"
    assert second["bindings"] == first["bindings"]
    assert second["updateAvailable"][0]["latestVersion"] == "2.0.0"


async def test_minimum_upgrade_requires_migration_and_old_artifact_stays_usable(runtime):
    first = await prepare(runtime)
    catalog = runtime[0].catalog
    catalog.package_value, _, catalog.envelope = signed(catalog.private, version="2.0.0")
    catalog.minimum = "2.0.0"
    result = await prepare(runtime)
    assert result["status"] == "blocked" and result["code"] == "RESOURCE_MIGRATION_REQUIRED"
    assert len(runtime[1].rows) == 1
    catalog.minimum = "1.0.0"
    assert (await prepare(runtime))["bindings"] == first["bindings"]


async def test_reused_new_artifact_caches_resolution_for_cloud_outage(runtime):
    first = await prepare(runtime)
    runtime[4]["artifactId"] = "artifact-2"
    second = await prepare(runtime)
    assert second["bindings"] == first["bindings"]

    async def unavailable(*args):
        raise BridgeAuthError("RESOURCE_API_UNAVAILABLE", 503)

    runtime[0].catalog.resolve = unavailable
    assert (await prepare(runtime))["bindings"] == first["bindings"]


async def test_empty_resource_nonwanx_product_preserves_existing_profile_flow(runtime):
    catalog = runtime[0].catalog
    catalog.product = "super-advisory"
    runtime[1].user["application_id"] = "super-advisory"

    async def empty(application, artifact):
        return {
            "schemaVersion": 1,
            "applicationId": application,
            "artifactId": artifact,
            "backendProductId": "super-advisory",
            "requirements": [],
            "resources": [],
        }

    catalog.resolve = empty
    result = await prepare(runtime)
    assert result["status"] == "ready" and result["bindings"] == []
    assert not runtime[1].rows


async def test_publication_denial_never_uses_offline_resolution(runtime):
    assert (await prepare(runtime))["status"] == "ready"

    async def revoked(*args):
        raise BridgeAuthError("RESOURCE_PUBLICATION_UNAVAILABLE", 409)

    runtime[0].catalog.resolve = revoked
    with pytest.raises(BridgeAuthError, match="RESOURCE_PUBLICATION_UNAVAILABLE"):
        await prepare(runtime)


async def test_revoked_live_session_never_uses_previously_ready_binding(runtime):
    assert (await prepare(runtime))["status"] == "ready"

    async def revoked():
        raise BridgeAuthError("BOX_PLATFORM_SESSION_EXPIRED", 401)

    with pytest.raises(BridgeAuthError, match="BOX_PLATFORM_SESSION_EXPIRED"):
        await runtime[0].prepare(runtime[4], runtime[2], runtime[3], runtime[1], revoked)
