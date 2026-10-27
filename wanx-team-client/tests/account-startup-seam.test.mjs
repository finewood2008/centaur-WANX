import test from "node:test";
import assert from "node:assert/strict";
import { createAccount } from "../account/index.mjs";
import { createPlatformClient } from "../platform.mjs";

const input = { phone: "13800138000", password: "test-password", code: "123456" };
const reply = (data, status = 200) => new Response(JSON.stringify({ code: status, data }), { status });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, restoreStatus = 200) {
  let saved, restoring = false;
  const entered = deferred(), gate = deferred(), calls = [];
  const store = {
    load: async () => structuredClone(saved),
    save: async value => { saved = structuredClone(value); },
  };
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith("/login")) return reply({
      accountId: "account-one", clientId: JSON.parse(options.body).clientId,
      accessToken: "test-access", refreshToken: "test-refresh", expiresIn: 3600,
    });
    if (path.endsWith("/refresh")) {
      const session = { ...saved.active.session, expiresIn: 3600 };
      if (restoring) { entered.resolve(); await gate.promise; }
      return reply(session, restoreStatus);
    }
    if (path.endsWith("/network/boxes")) return reply({ boxes: [
      { deviceId: "box-one", displayName: "测试盒子", accessState: "ready" },
    ] });
    if (path.endsWith("/logout")) return reply({});
    assert.fail(`unexpected request: ${path}`);
  };
  const previous = createAccount({ store, fetch });
  await previous.loginPassword(input);
  await previous.close();
  restoring = true;
  const account = createAccount({ store, fetch });
  const client = createPlatformClient({ account, readPreference: async () => false });
  const initialized = client.initialize();
  t.after(async () => { gate.resolve(); await initialized; await client.close(); });
  await entered.promise;
  return { account, client, calls, initialized, release: gate.resolve };
}

for (const method of ["loginPassword", "loginSMS", "register"]) {
  test(`${method} during session restoration cannot cancel the linked-device directory`, async t => {
    const h = await fixture(t);
    await assert.rejects(h.client[method](input), { code: "ACCOUNT_ALREADY_SIGNED_IN" });
    h.release();
    await h.initialized;
    assert.equal(h.client.snapshot().account.phase, "authenticated");
    assert.equal(h.client.snapshot().directory.phase, "ready");
    assert.deepEqual(h.client.snapshot().devices.map(device => device.deviceId), ["box-one"]);
    assert.equal(h.calls.filter(path => path.endsWith("/network/boxes")).length, 1);
    assert.equal(h.calls.filter(path => path.endsWith("/login")).length, 1);
  });
}

test("session restoration reports authentication in progress until refresh completes", async t => {
  const h = await fixture(t);
  assert.equal(h.client.snapshot().account.phase, "authenticating");
  assert.deepEqual(h.client.snapshot().devices, []);
  h.release();
  await h.initialized;
  assert.equal(h.client.snapshot().account.phase, "authenticated");
});

for (const status of [401, 503]) {
  test(`a failed restoration (${status}) still allows explicit login and device loading`, async t => {
    const h = await fixture(t, status);
    await assert.rejects(h.client.loginPassword(input), { code: "ACCOUNT_ALREADY_SIGNED_IN" });
    h.release();
    await h.initialized;
    assert.equal(h.client.snapshot().account.phase, "signed_out");
    await h.client.loginPassword(input);
    assert.equal(h.client.snapshot().account.phase, "authenticated");
    assert.deepEqual(h.client.snapshot().devices.map(device => device.deviceId), ["box-one"]);
  });
}

test("logout during restoration cannot publish the old account or devices afterwards", async t => {
  const h = await fixture(t);
  await h.client.logout();
  h.release();
  await h.initialized;
  assert.equal(h.client.snapshot().account.phase, "signed_out");
  assert.deepEqual(h.client.snapshot().devices, []);
  assert.equal(h.calls.some(path => path.endsWith("/network/boxes")), false);
});
