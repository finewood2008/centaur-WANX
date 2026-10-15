import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm, chmod, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createLocalBoxes } from "../octop/local-boxes.mjs";
import { createDashboardGateway } from "../octop/gateway.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-local-"));
  let rejectLogin = false;
  const calls = [];
  const server = http.createServer(async (request, response) => {
    calls.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/health") return response.end(JSON.stringify({ ok: true, db: true, started_at: 1, users_loaded: 1, agents_running: 1 }));
    if (request.url === "/api/auth/login") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { username: "local-admin", password: "private-password" });
      if (rejectLogin) { response.statusCode = 401; return response.end('{}'); }
      return response.end(JSON.stringify({ access_token: "private-token", token_type: "Bearer", expires_in: 3600 }));
    }
    if (request.url === "/api/auth/application/exchange") {
      assert.equal(request.headers.authorization, "Bearer private-token");
      return response.end(JSON.stringify({ access_token: "private-app-token", token_type: "Bearer", expires_in: 60, user: { application_id: "super-advisory" } }));
    }
    assert.equal(request.headers.authorization, request.url === "/api/scoped" ? "Bearer private-app-token" : "Bearer private-token");
    response.end(JSON.stringify({ username: "local-admin" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const registration = { version: 1, deviceId: "local-0123456789abcdef01234567", displayName: "本机万象", serviceUrl: `http://127.0.0.1:${server.address().port}`, username: "local-admin", password: "private-password" };
  const file = path.join(directory, `${registration.deviceId}.json`);
  const save = value => writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await save(registration);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { directory, file, registration, save, server, calls, boxes: createLocalBoxes({ directory }), rejectLogin: () => { rejectLogin = true; } };
}

test("local registration discovers health and authenticates a real private gateway", async t => {
  const h = await fixture(t);
  const rows = await h.boxes.list();
  assert.equal(rows[0].canOpen, true);
  assert.equal(JSON.stringify(rows).includes("private"), false);
  assert.equal(JSON.stringify(rows).includes("username"), false);
  const session = await h.boxes.createSession(h.registration.deviceId, { url: h.registration.serviceUrl });
  const gateway = await createDashboardGateway({ targetURL: h.registration.serviceUrl, session });
  t.after(() => gateway.close());
  const result = await gateway.request({ path: "/api/auth/me" });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).username, "local-admin");
  assert.equal((await gateway.request({ path: "/api/scoped", applicationScope: "super-advisory" })).status, 200);
  assert.ok(h.calls.includes("/api/auth/application/exchange"));
  await assert.rejects(gateway.request({ path: "/api/auth/application/exchange", method: "POST" }), /PLATFORM_SESSION_EXPIRED/);
  await gateway.close();
  assert.equal(session.getToken(), "");
  h.rejectLogin();
  await assert.rejects(h.boxes.createSession(h.registration.deviceId, { url: h.registration.serviceUrl }), { code: "LOCAL_BOX_AUTH_FAILED" });
});

test("untrusted targets, invalid registrations and symlinks are never discovered", async t => {
  const h = await fixture(t);
  for (const serviceUrl of ["http://192.168.1.10:8089", "https://example.com", "http://localhost:8089", "http://u:p@127.0.0.1:8089", "http://127.0.0.1:8089/?key=secret"]) {
    await h.save({ ...h.registration, serviceUrl });
    assert.deepEqual(await h.boxes.list(), []);
  }
  assert.deepEqual(h.calls, []);
  await h.save(h.registration);
  if (process.platform !== "win32") {
    await chmod(h.file, 0o644); assert.deepEqual(await h.boxes.list(), []); await chmod(h.file, 0o600);
    const target = path.join(h.directory, "secret.json"); await writeFile(target, JSON.stringify(h.registration), { mode: 0o600 });
    await rm(h.file); await symlink(target, h.file); assert.deepEqual(await h.boxes.list(), []);
  }
  await assert.rejects(h.boxes.createSession("../escape", { url: h.registration.serviceUrl }));
});

test("stopped backend remains visible but cannot be opened; cancellation cancels login", async t => {
  const h = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.boxes.createSession(h.registration.deviceId, { url: h.registration.serviceUrl, signal: controller.signal }));
  h.server.closeAllConnections(); await new Promise(resolve => h.server.close(resolve));
  const rows = await h.boxes.list();
  assert.equal(rows[0].accessState, "offline"); assert.equal(rows[0].canOpen, false);
});
