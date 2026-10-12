import test from "node:test";
import assert from "node:assert/strict";
import { registerControlActions } from "../shell/control.mjs";
import { createMarketSessionGuard } from "../shell/market-session.mjs";

for (const method of ["list", "candidate", "install", "uninstall", "rollback"]) {
  test(`market ${method} is control-only and login-only, without requiring a box`, () => {
    const handlers = new Map();
    const frame = { url: "file:///control.html" };
    const webContents = { mainFrame: frame };
    let phase = "authenticated";
    const calls = [];
    registerControlActions({
      ipcMain: { handle: (name, action) => handlers.set(name, action) },
      control: { webContents, isDestroyed: () => false }, controlURL: frame.url,
      client: { snapshot: () => ({ account: { phase }, phase: "disconnected" }) },
      market: { [method]: (...args) => { calls.push(args); return "ok"; } },
    });
    const invoke = handlers.get(`wanx-client:market-${method}`);
    const event = { sender: webContents, senderFrame: frame };
    const input = { applicationId: "centaurai.zhijun", url: "https://evil.invalid", sourceDir: "/tmp/evil" };
    assert.throws(() => invoke({ ...event, senderFrame: { url: frame.url } }, input), /无权/);
    assert.equal(invoke(event, input), "ok");
    assert.deepEqual(calls, [method === "list" ? [] : ["centaurai.zhijun"]]);
    phase = "signed_out";
    assert.throws(() => invoke(event, input), /ACCOUNT_LOGIN_REQUIRED/);
    assert.equal(calls.length, 1);
  });
}

function accountFixture() {
  let phase = "authenticated";
  let identity = { accountId: "alice", clientId: "laptop" };
  const listeners = new Set();
  return {
    snapshot: () => ({ phase }), getIdentity: () => identity,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    publish(nextPhase, nextIdentity = identity) {
      phase = nextPhase; identity = nextIdentity;
      for (const fn of listeners) fn({ phase });
    },
  };
}

test("logout and same-account login revoke an in-flight install authorization", () => {
  const account = accountFixture(), guard = createMarketSessionGuard(account);
  const check = guard.captureSession();
  check();
  account.publish("signed_out", null);
  account.publish("authenticated", { accountId: "alice", clientId: "laptop" });
  assert.throws(check, { code: "MARKET_SESSION_CHANGED" });
  const fresh = guard.captureSession();
  fresh();
  guard.close();
  assert.throws(fresh, { code: "MARKET_SESSION_CHANGED" });
});

test("token refresh preserves authorization, identity replacement revokes it", () => {
  const account = accountFixture(), guard = createMarketSessionGuard(account);
  const check = guard.captureSession();
  account.publish("authenticated");
  check();
  account.publish("authenticated", { accountId: "bob", clientId: "laptop" });
  assert.throws(check, { code: "MARKET_SESSION_CHANGED" });
  guard.close();
});
