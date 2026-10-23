import test from "node:test";
import assert from "node:assert/strict";
import { createAccount } from "../account/index.mjs";

const id = (n) => `centauros-${n.toString(16).padStart(24, "0")}`;
const reply = (data, status = 200) => new Response(JSON.stringify({ code: status, data }), { status });

async function fixture(t, discovery) {
  const calls = [];
  let stored = null;
  const account = createAccount({
    store: { load: async () => stored, save: async (value) => { stored = value; }, clear: async () => { stored = null; } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/login")) return reply({ accountId: "account-one", clientId: JSON.parse(options.body).clientId,
        accessToken: "secret-access", refreshToken: "secret-refresh", expiresIn: 3600 });
      if (url.includes("/v1/device-discovery?")) return discovery(url, options);
      return reply({});
    },
  });
  t.after(() => account.close());
  await account.loginPassword({ phone: "13800138000", password: "password" });
  return { account, calls };
}

test("discovery metadata uses signed read-only requests and returns names independently of ownership", async t => {
  const h = await fixture(t, () => reply({ devices: [
    { deviceId: id(2), deviceName: null, claimStatus: "unknown", ownerAccountId: "never-expose" },
    { deviceId: id(1), deviceName: "  新盒子  ", claimStatus: "unclaimed", deviceKey: "never-expose" },
    { deviceId: id(3), deviceName: "其他用户的盒子", claimStatus: "claimed" },
  ] }));
  const value = await h.account.lookupDeviceDiscovery([id(1), id(2), id(3)]);
  assert.deepEqual(value, { devices: [
    { deviceId: id(1), deviceName: "新盒子", claimStatus: "unclaimed" },
    { deviceId: id(2), deviceName: null, claimStatus: "unknown" },
    { deviceId: id(3), deviceName: "其他用户的盒子", claimStatus: "claimed" },
  ] });
  const { url, options } = h.calls.at(-1);
  assert.equal(new URL(url).searchParams.get("ids"), [id(1), id(2), id(3)].join(","));
  assert.equal(options.method, "GET");
  assert.equal(options.body, undefined);
  assert.equal(options.headers["X-Nexus-Signature-Version"], "NEXUSAOS-CONSUMER-APP-V1");
  assert.ok(options.headers.Authorization.startsWith("Bearer "));
  assert.ok(options.headers["X-Nexus-Signature"]);
  assert.doesNotMatch(JSON.stringify(value), /never-expose|secret/);
});

test("discovery rejects invalid, duplicate and oversized IDs before network access", async t => {
  const h = await fixture(t, () => { throw Error("must not request"); });
  for (const ids of [null, [], [id(1), id(1)], ["box-one"], [id(1).slice(0, -1)],
    [id(1) + "a"], [id(1) + "," + id(2)], [id(1).toUpperCase()], [null], Array.from({ length: 17 }, (_, n) => id(n))]) {
    await assert.rejects(h.account.lookupDeviceDiscovery(ids), { code: "ACCOUNT_INVALID_INPUT" });
  }
  assert.equal(h.calls.length, 1);
});

test("discovery does not turn absent, malformed or mismatched server data into unclaimed", async t => {
  let response;
  const h = await fixture(t, () => reply(response));
  const valid = { deviceId: id(1), deviceName: "盒子", claimStatus: "unclaimed" };
  for (const data of [{}, { devices: [] }, { devices: [null] }, { devices: [valid, valid] },
    ...[{ deviceId: id(2) }, { claimStatus: false }, { claimStatus: "ready" },
      { deviceName: undefined }, { deviceName: "" }, { deviceName: " \n " },
      { deviceName: "a".repeat(129) }].map(change => ({ devices: [{ ...valid, ...change }] }))]) {
    response = data;
    await assert.rejects(h.account.lookupDeviceDiscovery([id(1)]), { code: "ACCOUNT_INVALID_RESPONSE" });
  }
  response = { devices: [valid, valid] };
  await assert.rejects(h.account.lookupDeviceDiscovery([id(1), id(2)]), { code: "ACCOUNT_INVALID_RESPONSE" });
});

test("unsupported discovery services remain errors for the UI's unknown fallback", async t => {
  const h = await fixture(t, () => reply({}, 404));
  await assert.rejects(h.account.lookupDeviceDiscovery([id(1)]), error => error.status === 404);
});

test("a discovery response arriving after logout cannot enter another account's view", async t => {
  let finish, requested;
  const started = new Promise(resolve => { requested = resolve; });
  const waiting = new Promise(resolve => { finish = resolve; });
  const h = await fixture(t, () => { requested(); return waiting; });
  const result = h.account.lookupDeviceDiscovery([id(1)]);
  const rejected = assert.rejects(result, { code: "ACCOUNT_CANCELLED" });
  await started;
  await h.account.logout();
  finish(reply({ devices: [{ deviceId: id(1), deviceName: "旧账号的盒子", claimStatus: "claimed" }] }));
  await rejected;
});
