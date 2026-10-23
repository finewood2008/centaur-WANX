import test from "node:test";
import assert from "node:assert/strict";
import { createAccount } from "../account/index.mjs";

const reply = (data) =>
  new Response(JSON.stringify({ code: 200, data }), { status: 200 });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("a stalled network revocation does not delay auth logout or the next login", async (t) => {
  let stored = null;
  let loginCount = 0;
  let pendingLogin;
  const calls = [];
  const network = deferred();
  const authLogout = deferred();
  const account = createAccount({
    store: {
      load: async () => structuredClone(stored),
      save: async (value) => { stored = structuredClone(value); },
      clear: async () => { stored = null; },
    },
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path, options, body });
      if (path.endsWith("/login")) {
        loginCount++;
        return reply({
          accountId: "account-one",
          clientId: body.clientId,
          accessToken: `access-${loginCount}`,
          refreshToken: `refresh-${loginCount}`,
          expiresIn: 3600,
        });
      }
      if (path.endsWith("/network/current")) return network.promise;
      if (path.endsWith("/auth/logout")) return authLogout.promise;
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  t.after(async () => {
    // Release even requests that the old serial implementation starts later.
    network.resolve(reply({}));
    authLogout.resolve(reply({}));
    await pendingLogin;
    await account.close();
  });

  const credentials = { phone: "13800138000", password: "password-test" };
  await account.loginPassword(credentials);
  await account.logout({ revokeNetwork: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(account.snapshot().phase, "signed_out");
  assert.equal(account.getIdentity(), null);
  assert.equal(stored.active, null);
  const logoutRequest = calls.find((call) => call.path.endsWith("/auth/logout"));
  assert.ok(logoutRequest, "auth logout must start while the network DELETE is unresolved");
  assert.equal(logoutRequest.options.headers.Authorization, "Bearer access-1");
  assert.equal(logoutRequest.body.refreshToken, "refresh-1");

  pendingLogin = account.loginPassword(credentials);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loginCount, 1, "new login must still wait for auth logout to prevent session revocation");

  authLogout.resolve(reply({}));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loginCount, 2, "completed auth logout must unblock login while network cleanup is stalled");
  await pendingLogin;
  assert.equal(account.snapshot().logoutPending, false);
  assert.equal(account.snapshot().phase, "authenticated");
  assert.equal(stored.active.session.accessToken, "access-2");
});
