import test from "node:test";
import assert from "node:assert/strict";
import { createAccount } from "../account/index.mjs";

const identity = { packaged: true, distributionClass: "formal", productVersion: "1.0.0", channel: "stable",
  platform: "darwin", arch: "arm64", osVersion: "25.0.0", hostProtocol: 1, securityEpoch: 1 };

async function harness(getClientUpdateContext, options = {}) {
  const calls = [];
  const account = createAccount({ store: { load: async () => null, save: async () => {}, clear: async () => {} },
    getClientUpdateContext, ...options,
    fetch: async (url, input) => {
      calls.push({ url, input });
      if (url.endsWith("/login")) return new Response(JSON.stringify({ code: 200, data: {
        accountId: "account", clientId: JSON.parse(input.body).clientId, accessToken: "token", refreshToken: "refresh", expiresIn: 3600,
      } }));
      return options.reply ? options.reply() : new Response(JSON.stringify({ code: 200, data: {} }));
    } });
  await account.loginPassword({ phone: "13800138000", password: "password" });
  return { account, calls };
}

test("formal requests report immutable main-process client scope without changing login bodies", async t => {
  let current = null;
  const h = await harness(() => current); t.after(() => h.account.close());
  assert.equal(h.calls[0].input.headers["X-Wanx-Client"], undefined);
  current = identity;
  await h.account.request({ path: "/app-api/market/apps" });
  const headers = h.calls.at(-1).input.headers;
  assert.deepEqual(JSON.parse(headers["X-Wanx-Client"]), { product: "wanx-client", channel: "stable",
    platform: { os: "darwin", arch: "arm64", osVersion: "25.0.0" }, currentVersion: "1.0.0",
    backendContract: 1, hostProtocol: 1, securityEpoch: 1 });
  assert.ok(headers["X-Nexus-Signature"]);
});

test("development and internal clients do not claim formal update policy scope", async t => {
  for (const current of [null, { ...identity, packaged: false }, { ...identity, distributionClass: "unsigned-internal-only" }]) {
    const h = await harness(() => current); t.after(() => h.account.close());
    await h.account.request({ path: "/app-api/market/apps" });
    assert.equal(h.calls.at(-1).input.headers["X-Wanx-Client"], undefined);
  }
});

test("server required-update errors trigger a policy refresh and keep arbitrary server text private", async t => {
  let checks = 0;
  const h = await harness(() => identity, { onClientUpdateRequired: () => { checks++; },
    reply: () => new Response(JSON.stringify({ success: false, code: 426, errorCode: "CLIENT_UPDATE_REQUIRED", msg: "private server details" }), { status: 426 }) });
  t.after(() => h.account.close());
  await assert.rejects(h.account.request({ method: "POST", path: "/app-api/market/apps/example.app/candidate", body: {} }),
    { code: "CLIENT_UPDATE_REQUIRED", message: "CLIENT_UPDATE_REQUIRED", status: 426 });
  assert.equal(checks, 1);
  assert.equal(h.account.snapshot().phase, "authenticated");
});
