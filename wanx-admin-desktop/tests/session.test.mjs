import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdminSession, publicData, validateBox, retainSavedSecrets } from "../shell/session.mjs";

const box = { id: "box-one", name: "模拟盒子一", connection: "https", baseURL: "http://127.0.0.1:8011" };
const boxTwo = { id: "box-two", name: "模拟盒子二", connection: "https", baseURL: "https://box-two.invalid" };
const admin = { id: 1, username: "synthetic-admin", role: "admin", application_id: "wanx", permissions: [] };
const response = body => ({ status: 200, headers: {}, body });
function setup(user = admin, initialBoxes = [box, boxTwo]) {
  let effectiveUser = user, closeCount = 0, pending, socketClosed = 0;
  const requests = [], products = [], releases = [], grants = [], frames = [];
  const application = {
    async list() { return response([...products]); }, async create(input) { products.push(input); return response(input); }, async update(id, input) { Object.assign(products.find(item => item.application_id === id), input); return response(input); },
    async getDeployment(id) { return response({ application_id: id, enabled: false, resource_bindings: {}, configuration: {} }); }, async putDeployment(id, input) { return response({ application_id: id, ...input }); },
    async listReleases() { return response([...releases]); }, async createRelease(_id, input) { releases.push(input); return response(input); }, async recommendRelease(_id, version, body) { const release = releases.find(item => item.version === version && item.arch === body.arch && item.platform === body.platform); release.recommended = true; return response(release); },
    async listAccess() { return response([...grants]); }, async putAccess(_id, input) { grants.push(input); return response(input); }, async getManifest(id) { return response({ schema_version: 1, product: products.find(item => item.application_id === id), deployment: { enabled: true, resource_bindings: {}, configuration: {} } }); },
  };
  const service = createAdminSession({ initialBoxes, clientFactory: chosen => ({
    native: { async invoke(id, input) { requests.push({ box: chosen.id, id, input }); if (id.startsWith("login_")) return response({ access_token: "synthetic-token-do-not-export" }); if (id.startsWith("me_")) return response(effectiveUser); if (id.startsWith("get_capabilities_")) return response({ server_version: "1.0.0", sdk_management: { applications: true, protocol_version: 1 }, permissions: effectiveUser.permissions }); if (id.startsWith("get_timezone_")) return response({ timezone: "Asia/Shanghai" }); if (pending && id.startsWith("overview_")) return pending; if (id.startsWith("overview_")) return response({ private_key: "never", users: 5 }); if (id.startsWith("get_custom_mcp_")) return response({ servers: { demo: { transport: "http", url: "https://example.invalid/mcp", headers: { Authorization: "sensitive-synthetic" } } } }); if (id.startsWith("admin_list_providers_")) return response([{ id: "p", api_key: "do-not-export", name: "model" }]); return response([]); } },
    applications: application,
    async close() { closeCount++; },
    async openSocket() { return { frames: (async function* () { await new Promise(resolve => setTimeout(resolve, 20)); })(), send: async input => frames.push(input), close: async () => { socketClosed++; } }; },
  }) });
  return { service, requests, products, releases, grants, frames, setUser: value => { effectiveUser = value; }, setPending: value => { pending = value; }, closes: () => closeCount, socketCloses: () => socketClosed };
}
async function login(service, boxId = "box-one") { return service.request("connect", { boxId, username: "synthetic", password: "synthetic" }); }
test("只允许可信 HTTPS 或本机开发 HTTP，不允许地址携带凭据", () => {
  for (const baseURL of ["http://192.168.1.20", "https://name:password@box.example", "https://box.example/?token=x", "https://box.example/api"]) assert.throws(() => validateBox({ name: "box", baseURL }));
  assert.equal(validateBox({ name: "box", baseURL: "https://box.example" }).baseURL, "https://box.example");
});
test("普通使用者和跨应用账号无法进入管理员会话", async () => {
  for (const user of [{ ...admin, role: "user", permissions: [] }, { ...admin, application_id: "zhijun" }]) { const { service } = setup(user); await assert.rejects(login(service), /管理权限|管理作用域/); assert.equal(service.current().status, "disconnected"); }
});
test("主进程登录凭据和嵌套系统密钥不返回 renderer", async () => {
  const { service } = setup(); const state = await login(service); assert.equal(JSON.stringify(state).includes("synthetic-token"), false);
  const providers = await service.request("resource.list", { section: "providers" }, state.sessionId); assert.equal(providers[0].api_key, undefined);
  assert.deepEqual(publicData({ nested: { password: "x", access_token: "y", safe: 1 } }), { nested: { safe: 1 } });
  await service.disconnect();
});
test("产品定义、部署、版本推荐、访问开通形成完整调用闭环", async () => {
  const { service } = setup(); const { sessionId } = await login(service);
  const product = { application_id: "synthetic-product", name: "合成验收产品", description: "test-only", capabilities: ["memory", "chat"], agent_template: {}, resource_requirements: {} };
  await service.request("products.create", { body: product }, sessionId);
  assert.equal((await service.request("products.list", {}, sessionId))[0].name, product.name);
  const deployment = await service.request("deployment.put", { applicationId: product.application_id, body: { enabled: true, resource_bindings: {}, configuration: {} } }, sessionId); assert.equal(deployment.enabled, true);
  const release = { version: "1.0.0", platform: "macos", arch: "arm64", url: "https://example.invalid/app.dmg", sha256: "a".repeat(64), min_wanx_version: "1.0.0", min_sdk_version: "0.1.0-alpha.2", recommended: false };
  await service.request("releases.create", { applicationId: product.application_id, body: release }, sessionId);
  await service.request("releases.recommend", { applicationId: product.application_id, version: "1.0.0", body: { platform: "macos", arch: "arm64" } }, sessionId);
  assert.equal((await service.request("releases.list", { applicationId: product.application_id }, sessionId))[0].recommended, true);
  await service.request("access.put", { applicationId: product.application_id, userId: 3, body: { enabled: true } }, sessionId);
  assert.deepEqual((await service.request("access.list", { applicationId: product.application_id }, sessionId))[0], { user_id: 3, enabled: true });
  await service.disconnect();
});
test("远程正式身份未登记时不借用 omnia 连接", async () => {
  const { service } = setup(admin, [{ id: "remote", name: "远程盒", connection: "p2p", deviceId: "device-1" }]);
  await assert.rejects(login(service, "remote"), /正式远程连接身份尚未登记/); assert.equal(service.current().status, "disconnected");
});
test("权限撤销后重新检查，拒绝管理操作", async () => {
  const { service, setUser } = setup(); const state = await login(service); setUser({ ...admin, role: "user", permissions: [] });
  await assert.rejects(service.request("products.create", { body: {} }, state.sessionId), /没有产品管理/);
  await service.disconnect();
});
test("切盒释放旧会话和桌面，旧请求结果不返回新窗口", async () => {
  const { service, closes, socketCloses, setPending } = setup(); const old = await login(service);
  await service.request("desktop.open", { mode: "view" }, old.sessionId);
  let resolve; setPending(new Promise(done => { resolve = done; }));
  const work = service.request("overview", {}, old.sessionId); await new Promise(done => setTimeout(done, 5));
  const next = await login(service, "box-two"); resolve(response({ users: "old-box" }));
  await assert.rejects(work, /盒子已切换/);
  await assert.rejects(service.request("products.list", {}, old.sessionId), /连接已失效/);
  assert.notEqual(next.sessionId, old.sessionId); assert.ok(closes() >= 1); assert.ok(socketCloses() >= 1); await service.disconnect();
});
test("桌面查看模式与控制权限在主进程分别校验", async () => {
  const { service, frames } = setup({ ...admin, role: "user", permissions: ["desktop"] }); const state = await login(service);
  await service.request("desktop.open", { mode: "view" }, state.sessionId); assert.equal(JSON.parse(frames[0].text).mode, "view");
  await assert.rejects(service.request("desktop.open", { mode: "control" }, state.sessionId), /desktop_control/);
  await assert.rejects(service.request("desktop.input", { type: "click" }, state.sessionId), /desktop_control/);
  await assert.rejects(service.request("desktop.maintain", { operation: "install" }, state.sessionId), /desktop_manage/);
  await service.disconnect();
});
test("关闭或断线后没有写操作和私有数据通用调用入口", async () => {
  const { service, requests } = setup(); const { sessionId } = await login(service); await service.disconnect();
  const count = requests.length; await assert.rejects(service.request("products.create", { body: {} }, sessionId), /连接已失效/); assert.equal(requests.length, count);
  const live = await login(service); await assert.rejects(service.request("native.invoke", { operationId: "read-private-chat" }, live.sessionId), /未允许/); await service.disconnect();
});

test("MCP 修改保存 servers 合同并保留主进程敏感 header，界面不可读取密钥", async () => {
  const { service, requests } = setup(); const { sessionId } = await login(service);
  const view = await service.request("resource.list", { section: "connectors" }, sessionId);
  assert.equal(view.servers.demo.headers.Authorization, undefined);
  view.servers.demo.url = "https://example.invalid/updated";
  await service.request("resource.update", { section: "connectors", body: view }, sessionId);
  const saved = requests.find(item => item.id.startsWith("put_custom_mcp_"));
  assert.equal(saved.input.body.servers.demo.headers.Authorization, "sensitive-synthetic");
  assert.equal(saved.input.body.servers.demo.url, "https://example.invalid/updated");
  await assert.rejects(service.request("resource.update", { section: "connectors", body: { mcpServers: {} } }, sessionId), /MCP 配置必须/);
  assert.deepEqual(retainSavedSecrets({ servers: { removed: { headers: { Authorization: "secret" } } } }, { servers: {} }), { servers: {} });
  await service.disconnect();
});
