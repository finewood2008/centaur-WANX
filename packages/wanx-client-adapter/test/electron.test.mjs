import test from "node:test";
import assert from "node:assert/strict";
import { createCentaurAIWanxClient, createCentaurAIWanxHost, operationRegistry } from "../dist/index.js";
import { bindCentaurAIWanxElectron, IPC_CHANNEL } from "../dist/electron-main.js";
import { exposeCentaurAIWanxPreload } from "../dist/electron-preload.js";
import { createCentaurAIWanxApp } from "../dist/renderer.js";

test("Electron main rejects other windows, iframes, navigation, credentials and unknown routes", async () => {
  let handler; const requests = [];
  const transport = {
    capabilities: { httpUnary: true, httpResponseStream: true, websocketMessages: false, uploadStream: false, maxRequestBodyBytes: 2097152, networkPath: "direct" },
    async request(request) { requests.push(request); return { status: 200, headers: { "content-type": "application/json" }, chunks: (async function*(){ yield new TextEncoder().encode(JSON.stringify({ native: true })); })(), close: async () => {} }; },
    async openSocket() { throw new Error("not selected"); }, async close() {},
  };
  const policy = { applicationId: "omnia-desktop", operations: operationRegistry.map(o => o.operationId), sockets: [], agents: ["agent-1"] };
  const host = { auth: { current: async () => ({ accountId: "owner", clientId: "client" }) }, devices: { list: async () => [] }, connection: { status: () => ({ generation: 1, phase: "ready" }), connect: async () => createCentaurAIWanxClient({ transport, policy }), disconnect: async () => {} }, dispose: async () => {} };
  const dispose = bindCentaurAIWanxElectron({ ipcMain: { handle(channel, callback) { assert.equal(channel, IPC_CHANNEL); handler = callback; }, removeHandler() {} }, webContentsId: 11, documentURL: "file:///app/index.html", host });
  const event = { sender: { id: 11 }, senderFrame: { url: "file:///app/index.html#/memory", parent: null } };
  try {
    for (const bad of [{ ...event, sender: { id: 12 } }, { ...event, senderFrame: { url: "https://untrusted.test", parent: null } }, { ...event, senderFrame: { ...event.senderFrame, parent: {} } }]) assert.equal((await handler(bad, { method: "auth.current" })).code, "IPC_SENDER_NOT_ALLOWED");
    assert.equal((await handler(event, { method: "owner.initialize" })).code, "IPC_METHOD_NOT_ALLOWED");
    let exposed;
    exposeCentaurAIWanxPreload({ contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "centauraiWanx"); exposed = value; } }, ipcRenderer: { invoke: (channel, value) => { assert.equal(channel, IPC_CHANNEL); return handler(event, value); } } });
    assert.deepEqual(Object.keys(exposed), ["call"]);
    const app = createCentaurAIWanxApp({ bridge: exposed, policy });
    const session = await app.connection.connect({ deviceId: "approved-device" });
    assert.equal("native" in session, false);
    const result = await session.agents.use("agent-1").memory.getAtom({ path: { atom_id: "a" } }); assert.deepEqual(result.body, { native: true });
    assert.equal(requests[0].path, "/api/agents/agent-1/memory/atoms/a");
    for (const path of ["/api/auth/login", "/api/auth/invite/redeem", "/api/auth/oauth/exchange", "/api/auth/oidc/exchange", "/api/setup/initial-admin", "/api/setup/begin", "/api/setup/verify-password", "/api/setup/resume-wizard"]) {
      const reply = await handler(event, { method: "http.open", params: { request: { method: "POST", path, headers: {} } } });
      assert.equal(reply.code, "HOST_ONLY_OPERATION", path);
    }
    const legacy = operationRegistry.find(o => o.parameters.some(p => p.in === "header" && p.name.toLowerCase() === "x-octop-agent-id") && o.method === "GET");
    assert.ok(legacy);
    for (const [id, allowed] of [["agent-1", true], ["another", false]]) {
      const reply = await handler(event, { method: "http.open", params: { request: { method: legacy.method, path: legacy.path, headers: { "x-octop-agent-id": id } } } });
      assert.equal(reply.ok, allowed);
      if (allowed) await handler(event, { method: "http.close", params: { handle: reply.value.handle } });
    }
    for (const request of [{ method: "GET", path: "/api/auth/me?access_token=injected", headers: {} }, { method: "GET", path: "/api/auth/me", headers: { Authorization: "Bearer injected" } }, { method: "GET", path: "/api/internal/private", headers: {} }]) {
      const response = await handler(event, { method: "http.open", params: { request } }); assert.equal(response.ok, false);
    }
    await app.dispose();
  } finally { await dispose(); }
});

test("native host preserves generated P256 identity and never exposes keys through account facade", async () => {
  let secret = null; const storage = { load: async () => secret, save: async value => { secret = value; }, clear: async () => { secret = null; } };
  const config = { consumerBaseURL: "https://control.example.invalid/prod-api", trustedGatewayHosts: ["gateway.example.invalid"], trustedICEHosts: ["ice.example.invalid"], secureStore: storage, policy: { applicationId: "ordinary-app", operations: [], sockets: [] } };
  const host = await createCentaurAIWanxHost(config);
  const identity = JSON.parse(secret).identity; assert.ok(identity.privateKeyPEM.includes("PRIVATE KEY")); assert.ok(identity.publicKeyPEM.includes("PUBLIC KEY"));
  assert.equal(await host.auth.current(), null);
  await assert.rejects(host.connection.connect({ deviceId: "device-1" }), { code: "APPLICATION_CONTRACT_NOT_SUPPORTED" });
  await host.dispose();
  const restored = await createCentaurAIWanxHost(config); assert.deepEqual(JSON.parse(secret).identity, identity); await restored.dispose();
  assert.ok(!Object.values(host).some(v => typeof v === "string" && v.includes("PRIVATE KEY")));
});
