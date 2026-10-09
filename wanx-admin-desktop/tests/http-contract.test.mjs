import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createAdminSession } = require("../dist-shell/session-test.cjs");

test("合成 HTTP 服务通过真实 SDK 验证管理员登录与产品全链", async t => {
  const requests = [], products = [], releases = [], grants = [];
  let deployment = { application_id: "synthetic.product", enabled: false, resource_bindings: {}, configuration: {} };
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null, method = request.method, url = new URL(request.url, "http://localhost");
    requests.push({ method, path: url.pathname, body, authorization: request.headers.authorization });
    response.setHeader("Content-Type", "application/json");
    const send = value => response.end(JSON.stringify(value));
    if (url.pathname === "/api/auth/login") { assert.equal(body.application_id, "wanx"); return send({ access_token: "synthetic-main-process-only" }); }
    if (request.headers.authorization !== "Bearer synthetic-main-process-only") { response.statusCode = 401; return send({ message: "unauthorized" }); }
    if (url.pathname === "/api/auth/me") return send({ id: 1, username: "synthetic-admin", role: "admin", application_id: "wanx", permissions: [] });
    if (url.pathname === "/api/settings/capabilities") return send({ server_version: "1.0.0", sdk_management: { applications: true, protocol_version: 1, remote_identity_registration: false }, permissions: [] });
    if (url.pathname === "/api/settings/timezone") return send({ timezone: "Asia/Shanghai" });
    if (url.pathname === "/api/admin/applications") { if (method === "POST") { products.push(body); response.statusCode = 201; return send(body); } return send(products); }
    if (url.pathname === "/api/admin/applications/synthetic.product" && method === "PATCH") { assert.equal("application_id" in body, false); Object.assign(products[0], body); return send(products[0]); }
    if (url.pathname.endsWith("/deployment")) { if (method === "PUT") deployment = { ...deployment, ...body }; return send(deployment); }
    if (url.pathname.endsWith("/releases/1.0.0/recommend")) { releases[0].recommended = true; return send(releases[0]); }
    if (url.pathname.endsWith("/releases")) { if (method === "POST") { releases.push(body); response.statusCode = 201; return send(body); } return send(releases); }
    if (url.pathname.endsWith("/access")) { if (method === "PUT") { grants.push(body); return send(body); } return send(grants); }
    response.statusCode = 404; send({ message: `synthetic route missing ${method} ${url.pathname}` });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const service = createAdminSession({ initialBoxes: [{ id: "synthetic", name: "合成验收盒子", connection: "https", baseURL: `http://127.0.0.1:${server.address().port}` }] });
  t.after(() => service.disconnect());
  const state = await service.request("connect", { boxId: "synthetic", username: "synthetic-admin", password: "synthetic-password" });
  assert.equal(state.status, "connected"); assert.ok(!JSON.stringify(state).includes("synthetic-main-process-only"));
  const sid = state.sessionId, id = "synthetic.product";
  await service.request("products.create", { body: { application_id: id, name: "合成测试产品", description: "not a real box", capabilities: ["chat", "memory"], agent_template: {}, resource_requirements: {} } }, sid);
  assert.equal((await service.request("products.list", {}, sid))[0].application_id, id);
  await service.request("products.update", { applicationId: id, body: { application_id: id, name: "更新后的合成产品" } }, sid);
  assert.equal((await service.request("products.list", {}, sid))[0].name, "更新后的合成产品");
  assert.equal((await service.request("deployment.put", { applicationId: id, body: { enabled: true, resource_bindings: {}, configuration: {} } }, sid)).enabled, true);
  await service.request("releases.create", { applicationId: id, body: { version: "1.0.0", platform: "macos", arch: "arm64", url: "https://example.invalid/synthetic.dmg", sha256: "a".repeat(64), min_wanx_version: "1.0.0", min_sdk_version: "0.1.0-alpha.2", recommended: false } }, sid);
  await service.request("releases.recommend", { applicationId: id, version: "1.0.0", body: { platform: "macos", arch: "arm64" } }, sid);
  assert.equal((await service.request("releases.list", { applicationId: id }, sid))[0].recommended, true);
  await service.request("access.put", { applicationId: id, userId: 42, body: { enabled: true } }, sid);
  assert.deepEqual((await service.request("access.list", { applicationId: id }, sid))[0], { user_id: 42, enabled: true });
  assert.ok(requests.every(item => !/memory|history|chat|workspace/.test(item.path)));
  assert.ok(requests.some(item => item.method === "PUT" && item.path.endsWith("/access") && item.body.user_id === 42));
});
