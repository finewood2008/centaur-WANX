import test from "node:test";
import assert from "node:assert/strict";
import { createAccount } from "../account/index.mjs";
const reply = data => new Response(JSON.stringify({ code: 200, data }));
const row = (extra = {}) => ({ transferId: "transfer-one", deviceId: "box-one", direction: "incoming", state: "pending_target", retainData: true, ownershipEpoch: 2, expiresAt: "2099-01-01T00:00:00Z", ...extra });
async function fixture(t, override = () => undefined) {
  let saved, clientId;
  const calls = [];
  const account = createAccount({ store: { load: async () => saved, save: async value => { saved = value; } },
    fetch: async (url, options) => {
      const call = { path: new URL(url).pathname, method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : undefined };
      calls.push(call);
      if (url.endsWith("/login")) {
        clientId = call.body.clientId;
        return reply({ accountId: call.body.phone, clientId, accessToken: "private", refreshToken: "refresh", expiresIn: 3600 });
      }
      const replacement = await override(call);
      if (replacement) return replacement;
      if (url.endsWith("/devices")) return reply([{ deviceId: "box-one", role: "owner", status: "active" }]);
      if (url.endsWith("/ownership/transfers")) return reply([row()]);
      if (url.endsWith("/ownership/transfer")) return reply(row({ direction: "outgoing" }));
      if (url.endsWith("/accept")) return reply(row({ state: "completed" }));
      return reply({});
    } });
  t.after(() => account.close());
  await account.loginPassword({ phone: "13800138000", password: "test" });
  return { account, calls };
}
const input = { deviceId: "box-one", targetPhone: "13900139000", verificationCode: "012345", retainData: true };

test("transfer pins original owner phone and retainData, signs API, strips secrets from result", async t => {
  const { account, calls } = await fixture(t, call => call.path.endsWith("/ownership/transfer") ? reply(row({ direction: "outgoing", privateToken: "secret" })) : undefined);
  await account.sendTransferCode();
  assert.deepEqual(calls.at(-1).body, { phone: "13800138000", scene: "consumer_login" });
  const value = await account.createOwnershipTransfer({ ...input, ownerPhone: "injected" });
  assert.equal(value.direction, "outgoing");
  assert.equal(value.privateToken, undefined);
  assert.deepEqual(calls.at(-1).body, { ownerPhone: "13800138000", targetPhone: input.targetPhone, verificationCode: input.verificationCode, retainData: true });
  assert.match(calls.at(-1).headers["X-Nexus-Signature"], /.+/);
  assert.equal(calls.at(-1).headers.Authorization, "Bearer private");
});

test("nonowner and unsafe transfer parameters never reach mutation endpoint", async t => {
  const { account, calls } = await fixture(t, call => call.path.endsWith("/devices") ? reply([{ deviceId: "box-one", role: "member", status: "active" }]) : undefined);
  await assert.rejects(account.createOwnershipTransfer(input), { code: "OWNERSHIP_OWNER_REQUIRED" });
  for (const extra of [{ retainData: false }, { deviceId: "../box" }, { targetPhone: "bad" }, { verificationCode: "bad" }])
    await assert.rejects(account.createOwnershipTransfer({ ...input, ...extra }), { code: "ACCOUNT_INVALID_INPUT" });
  await assert.rejects(account.createOwnershipTransfer({ ...input, targetPhone: "13800138000" }), { code: "OWNERSHIP_TARGET_SELF" });
  assert.equal(calls.some(call => call.path.endsWith("/ownership/transfer")), false);
});

test("incoming transfer must be live, intended for current account, and preserve data", async t => {
  for (const change of [{ direction: "outgoing" }, { retainData: false }, { state: "completed" }, { expiresAt: "2000-01-01" }]) {
    const { account, calls } = await fixture(t, call => call.path.endsWith("/ownership/transfers") ? reply([row(change)]) : undefined);
    await assert.rejects(account.acceptOwnershipTransfer({ transferId: "transfer-one", retainData: true }), { code: "OWNERSHIP_TRANSFER_UNAVAILABLE" });
    assert.equal(calls.some(call => call.path.endsWith("/accept")), false);
  }
});

test("accept returns committed ownership and endpoint errors remain errors", async t => {
  const { account, calls } = await fixture(t);
  const value = await account.acceptOwnershipTransfer({ transferId: "transfer-one", retainData: true });
  assert.equal(value.state, "completed");
  assert.equal(value.ownershipEpoch, 2);
  assert.equal(calls.at(-1).path, "/prod-api/app-api/ownership/transfers/transfer-one/accept");
  const failed = await fixture(t, call => call.path.endsWith("/accept") ? new Response(JSON.stringify({ code: 403, msg: "private" }), { status: 403 }) : undefined);
  await assert.rejects(failed.account.acceptOwnershipTransfer({ transferId: "transfer-one", retainData: true }), { code: "ACCOUNT_ACCESS_DENIED" });
});

test("logout while verifying ownership prevents transfer under a new login", async t => {
  let resolve, seen;
  const entered = new Promise(r => { seen = r; });
  const paused = new Promise(r => { resolve = r; });
  const { account, calls } = await fixture(t, async call => {
    if (call.path.endsWith("/devices")) { seen(); await paused; return reply([{ deviceId: "box-one", role: "owner", status: "active" }]); }
  });
  const change = account.createOwnershipTransfer(input);
  await entered;
  await account.logout();
  await account.loginPassword({ phone: "13900139000", password: "test" });
  resolve();
  await assert.rejects(change, { code: "ACCOUNT_CANCELLED" });
  assert.equal(calls.some(call => call.path.endsWith("/ownership/transfer")), false);
});

test("console claim signs request, keeps retry intent and never exposes device credentials", async t => {
  const { account, calls } = await fixture(t, call => call.path.endsWith('/device-console-claims/redeem') ? reply({
    deviceId: 'box-one', ownership: 'claimed', authorization: { secret: 'private' }, apiKey: 'private',
  }) : undefined);
  const claim = { claimCode: 'ABCDEFG234', clientAttemptId: 'b338f42e-e1ab-46e0-89a7-b2c6f79f45f1' };
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await account.redeemConsoleClaim(claim), { deviceId: 'box-one', ownership: 'claimed' });
    assert.deepEqual(calls.at(-1).body, claim);
    assert.equal(calls.at(-1).headers['Idempotency-Key'], claim.clientAttemptId);
    assert.match(calls.at(-1).headers['X-Nexus-Signature'], /.+/);
  }
  for (const invalid of [{ claimCode: '123456' }, { clientAttemptId: 'bad' }])
    await assert.rejects(account.redeemConsoleClaim({ ...claim, ...invalid }), { code: 'ACCOUNT_INVALID_INPUT' });
  await account.logout();
  await assert.rejects(account.redeemConsoleClaim(claim), { code: 'ACCOUNT_LOGIN_REQUIRED' });
});

test("console claim carries safe API error codes while withholding server diagnostics", async t => {
  for (const code of ['CONSOLE_CLAIM_EXPIRED', 'CONSOLE_CLAIM_NOT_FOUND', 'OWNER_ALREADY_CHANGED']) {
    const { account } = await fixture(t, call => call.path.endsWith('/device-console-claims/redeem')
      ? new Response(JSON.stringify({ success: false, errorCode: code, message: 'private server details' }), { status: 409 }) : undefined);
    await assert.rejects(account.redeemConsoleClaim({ claimCode: 'ABCDEFG234', clientAttemptId: 'b338f42e-e1ab-46e0-89a7-b2c6f79f45f1' }),
      error => error.code === code && !error.message.includes('private'));
  }
});
