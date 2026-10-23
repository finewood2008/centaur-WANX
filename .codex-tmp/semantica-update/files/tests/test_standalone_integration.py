"""Standalone accepts WANX grants without changing native REST or MCP access."""
import asyncio
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from pydantic import SecretStr
from starlette.responses import JSONResponse

from app.config import Settings
from app.integration.auth import ManagedAuthMiddleware, request_auth_headers, request_scope
from app.services.warehouses import workspace_for
from tests import test_managed_integration as managed


class StandaloneMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        managed.ScopeTests.setUp(self)
        self.settings.integration_mode = "standalone"

    headers = managed.ScopeTests.headers

    async def client(self, app, surface="workbench"):
        return await self.enterAsyncContext(httpx.AsyncClient(
            transport=httpx.ASGITransport(app=ManagedAuthMiddleware(
                app, settings=self.settings, surface=surface)), base_url="http://localhost"))

    async def test_concurrent_grants_are_isolated_and_cleaned_up(self):
        arrived = asyncio.Event()
        count = 0

        async def endpoint(scope, receive, send):
            nonlocal count
            count += 1
            if count == 2:
                arrived.set()
            await asyncio.wait_for(arrived.wait(), 2)
            await JSONResponse({"actor": request_scope.get().actor_id,
                "signed": bool(request_auth_headers.get().get("x-semantica-signature"))})(scope, receive, send)

        client = await self.client(endpoint)

        async def call(actor):
            result = await client.get("/api/integration/status", headers=self.headers(actor_id=actor))
            self.assertIsNone(request_scope.get())
            self.assertEqual(request_auth_headers.get(), {})
            return result.json()

        results = await asyncio.gather(call("actor-a"), call("actor-b"))
        self.assertEqual(results, [{"actor": "actor-a", "signed": True}, {"actor": "actor-b", "signed": True}])

    async def test_context_is_reset_after_handler_failure(self):
        async def endpoint(scope, receive, send):
            self.assertIsNotNone(request_scope.get())
            raise RuntimeError("synthetic failure")

        client = await self.client(endpoint)
        with self.assertRaisesRegex(RuntimeError, "synthetic failure"):
            await client.get("/api/integration/status", headers=self.headers())
        self.assertIsNone(request_scope.get())
        self.assertEqual(request_auth_headers.get(), {})

    async def test_unconfigured_or_invalid_credentials_do_not_break_native_access(self):
        async def endpoint(scope, receive, send):
            await JSONResponse({"native": True})(scope, receive, send)

        client = await self.client(endpoint)
        for changes in ({"integration_service_token": SecretStr("")},
                        {"integration_service_token": SecretStr("short")},
                        {"integration_application_id": ""},
                        {"integration_box_id": ""},
                        {"integration_application_tokens": SecretStr("invalid-json-private-secret")}):
            with self.subTest(fields=list(changes)), patch.multiple(self.settings, **changes):
                self.assertEqual((await client.get("/api/settings")).status_code, 200)
                result = await client.get("/api/integration/status")
                self.assertEqual(result.status_code, 401)
                self.assertNotIn("private-secret", result.text)

    async def test_native_and_mcp_remain_available_without_grants(self):
        async def endpoint(scope, receive, send):
            self.assertIsNone(request_scope.get())
            await JSONResponse({"ok": True})(scope, receive, send)

        client = await self.client(endpoint)
        self.assertEqual((await client.get("/api/documents")).status_code, 200)
        self.assertEqual((await client.get("/api/health/ready")).status_code, 200)
        self.assertEqual((await client.get("/api/integration/status")).status_code, 401)
        mcp = await self.client(endpoint, surface="mcp")
        self.assertEqual((await mcp.post("/mcp", headers={"Origin": "http://example.test"})).status_code, 200)

    async def test_public_key_surface_is_bounded_and_uncacheable_in_both_modes(self):
        async def endpoint(scope, receive, send):
            self.assertIsNone(request_scope.get())
            await JSONResponse({"ok": True}, headers={"Cache-Control": "public, max-age=300"})(scope, receive, send)

        client = await self.client(endpoint)
        for mode in ("standalone", "managed"):
            self.settings.integration_mode = mode
            with self.subTest(mode=mode):
                result = await client.post("/api/open/v1/search", content=b"x" * (128 * 1024))
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.headers["cache-control"], "no-store")
                self.assertEqual((await client.post("/api/open/v1/search", content=b"x" * (128 * 1024 + 1))).status_code, 413)
                self.assertEqual((await client.get("/api/open/v1/warehouse", headers={"Origin": "null"})).status_code, 403)

    async def test_signed_body_limits_and_disconnect(self):
        calls = []

        async def endpoint(scope, receive, send):
            calls.append(scope["path"])
            await JSONResponse({"ok": True})(scope, receive, send)

        client = await self.client(endpoint)
        for path, limit in (("/api/integration/documents", 2 * 1024**2),
                            ("/api/integration/skills/import", 6 * 1024**2)):
            with self.subTest(path=path):
                self.assertEqual((await client.post(path, headers=self.headers(), content=b"x" * limit)).status_code, 200)
                self.assertEqual((await client.post(path, headers=self.headers(), content=b"x" * (limit + 1))).status_code, 413)
        before = len(calls)

        async def receive():
            return {"type": "http.disconnect"}

        async def send(message):
            self.fail("disconnected request must not send a response")

        await ManagedAuthMiddleware(endpoint, settings=self.settings, surface="workbench")(
            {"type": "http", "path": "/api/integration/documents", "method": "POST",
             "headers": [(key.lower().encode(), value.encode()) for key, value in self.headers().items()]}, receive, send)
        self.assertEqual(len(calls), before)
        self.assertIsNone(request_scope.get())
        self.assertEqual(request_auth_headers.get(), {})


class StandaloneWorkbenchTests(unittest.TestCase):
    def setUp(self):
        managed.ScopeTests.setUp(self)
        self.settings.integration_mode = "standalone"
        self.settings.mcp_host = "0.0.0.0"
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.enterContext(patch("app.services.managed_readiness.probe_graph", return_value=True))
        from app.main import create_app
        with patch("app.main.get_settings", return_value=self.settings):
            self.app = create_app(data_dir=Path(self.directory.name), start_worker=False)
        self.client = self.enterContext(TestClient(self.app))

    headers = managed.ScopeTests.headers
    tool = managed.ManagedWorkbenchTests.tool
    test_real_upload_replay_cross_workspace_and_delete_replay = managed.ManagedWorkbenchTests.test_real_upload_replay_cross_workspace_and_delete_replay
    test_chunked_import_replay_scope_and_original_range = managed.ManagedWorkbenchTests.test_chunked_import_replay_scope_and_original_range

    def test_signed_write_operation_is_required(self):
        response = self.tool("upload_document", {"operation_id": "different", "filename": "notes.txt",
            "external_document_id": "synthetic-write", "content_base64": "dGVzdA=="})
        self.assertEqual(response.status_code, 403, response.text)

    def test_native_access_and_integration_validation(self):
        self.assertEqual(self.app.state.processing_models.base, "http://127.0.0.1:18089")
        self.assertEqual(self.client.get("/api/documents").status_code, 200)
        self.assertEqual(self.client.get("/api/health/ready").status_code, 200)
        self.assertEqual(self.client.get("/api/integration/status").status_code, 401)
        self.assertEqual(self.client.get("/api/integration/status", headers=self.headers()).status_code, 200)
        for headers, status in ((self.headers(expires_at=1), 401),
                                ({**self.headers(), "X-Semantica-Signature": "invalid"}, 401),
                                ({**self.headers(), "Origin": "http://localhost:8090"}, 403)):
            self.assertEqual(self.client.get("/api/integration/status", headers=headers).status_code, status)
        self.assertFalse(self.settings.public_status()["mcp_authentication"])

    def test_readiness_monitor_runs_and_stops_in_standalone(self):
        monitor = self.app.state.processing_readiness
        monitor.refresh()
        response = self.tool("get_capabilities", {})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["processing_checks"]["graph_ready"])
        self.assertFalse(response.json()["processing_checks"]["worker_ready"])
        self.assertFalse(response.json()["processing_ready"])
        self.assertTrue(monitor._thread.is_alive())
        # Exit the lifespan before temporary database cleanup.
        self.doCleanups()
        self.assertFalse(monitor._thread.is_alive())

    def test_warehouse_owner_and_public_key_revocation(self):
        from app.integration.auth import IntegrationScope
        root, resource = workspace_for(IntegrationScope(**self.claims))
        self.claims.update(workspace_id=root, workspace_bindings={root: resource})
        created = self.client.post("/api/integration/warehouses", headers=self.headers(),
            json={"operation_id": "operation-a", "name": "Synthetic standalone warehouse"})
        self.assertEqual(created.status_code, 200, created.text)
        path = "/api/integration/warehouses/" + created.json()["id"]
        denied = self.client.get(path, headers=self.headers(actor_id="other-owner"))
        self.assertEqual(denied.status_code, 404, denied.text)
        self.assertEqual(denied.json()["code"], "WAREHOUSE_NOT_FOUND")
        key = self.client.post(path + "/keys", headers=self.headers(operation_id="key-a"),
            json={"operation_id": "key-a", "name": "Synthetic key"})
        self.assertEqual(key.status_code, 200, key.text)
        self.assertEqual(len(key.json()["key"]["scopes"]), 5)
        headers = {"Authorization": "Bearer " + key.json()["token"]}
        response = self.client.get("/api/open/v1/warehouse", headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        revoked = self.client.post(path + "/keys/" + key.json()["key"]["id"] + "/revoke",
            headers=self.headers(operation_id="revoke-a"), json={"operation_id": "revoke-a"})
        self.assertEqual(revoked.status_code, 200, revoked.text)
        denied = self.client.get("/api/open/v1/warehouse", headers=headers)
        self.assertEqual(denied.status_code, 401, denied.text)
        self.assertEqual(denied.headers["cache-control"], "no-store")


class ModelRelayDefaultTests(unittest.TestCase):
    def test_default_private_listener_and_existing_override(self):
        for override in (None, "http://127.0.0.1:28089"):
            kwargs = {} if override is None else {"wanx_model_url": override}
            settings = Settings(_env_file=None, **kwargs)
            expected = override or "http://127.0.0.1:18089"
            self.assertEqual(settings.wanx_model_url, expected)
