import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAccount } from "../account/index.mjs";
import { createCreditWallet } from "../account/credit-wallet.mjs";

const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status });
function fixture(handler, options = {}) {
  let stored = null, clientId;
  const requests = [];
  const account = createAccount({
    measure: options.measure,
    store: { load: async () => structuredClone(stored), save: async value => { stored = structuredClone(value); },
      clear: async () => { stored = null; } },
    fetch: async (url, options) => {
      if (url.endsWith("/login") || url.endsWith("/refresh")) {
        clientId ||= JSON.parse(options.body).clientId;
        return response({ code: 200, data: { accountId: "wallet-account", clientId, accessToken: "test-access",
          refreshToken: "test-refresh", expiresIn: 3600 } });
      }
      if (url.includes("/v1/credits/")) {
        requests.push({ url, ...options });
        return handler(requests.length, options);
      }
      return response({ code: 200, data: {} });
    },
  });
  return { account, requests, wallet: createCreditWallet({ request: input => account.request(input) }) };
}

test('credit payment requests emit stage timings for the local diagnostic recorder', async () => {
  const steps = [];
  const { account, wallet } = fixture(
    () => response({ schema_version: '1', request_id: 'timed-create', data: { order_id: 'order-1' } }, 202),
    { measure: async (step, operation) => { steps.push(step); return operation(); } },
  );
  await account.loginPassword({ phone: '13800138000', password: 'test-password', remember: false });
  await wallet.createOrder({ purchase_intent_id: 'timed-buy', amount_fen: 10000 });
  assert.ok(steps.includes('credit.payment.create'));
  await account.close();
});

test("undeployed credits routes report service availability without weakening the contract", async () => {
  for (const [reply, expected] of [
    [() => response({ detail: "Not Found" }, 404), "CREDITS_SERVICE_UNAVAILABLE"],
    [() => new Response("<html>Not Found</html>", { status: 404 }), "CREDITS_SERVICE_UNAVAILABLE"],
    [() => response({ detail: "Not Found" }), "CREDITS_INVALID_RESPONSE"],
    [() => response({ schema_version: "2", request_id: "bad", data: {} }, 404), "CREDITS_INVALID_RESPONSE"],
    [() => response({ schema_version: "1", request_id: "missing", error: {
      code: "ORDER_NOT_FOUND", message: "missing", retryable: false, details: {},
    } }, 404), "ORDER_NOT_FOUND"],
  ]) {
    const { account, wallet, requests } = fixture(reply);
    try {
      await account.loginPassword({ phone: "13800138000", password: "test-password", remember: false });
      await assert.rejects(wallet.order({ order_id: "order-1" }), error => error.code === expected);
      assert.equal(requests.length, 1);
    } finally { await account.close(); }
  }
});

test("credits wire preserves snake-case metadata across signed 401 refresh with the same intent", async () => {
  const { account, wallet, requests } = fixture(count => count === 1
    ? response({ schema_version: "1", request_id: "expired", error: { code: "UNAUTHORIZED", message: "expired",
      retryable: false, details: {} } }, 401)
    : response({ schema_version: "1", request_id: "created", data: { order_id: "order-1" } }, 202));
  await account.loginPassword({ phone: "13800138000", password: "test-password", remember: false });
  const result = await wallet.createOrder({ purchase_intent_id: "buy:stable.1", amount_fen: 10000 });
  assert.equal(result.schema_version, "1");
  assert.equal(result.request_id, "created");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.headers["Idempotency-Key"], "buy:stable.1");
    assert.equal(request.headers["X-Nexus-Signature-Version"], "NEXUSAOS-CONSUMER-APP-V1");
    assert.equal(request.headers["X-Nexus-Body-SHA256"], createHash("sha256").update(request.body).digest("hex"));
  }
  assert.equal(requests[0].body, requests[1].body);
  assert.notEqual(requests[0].headers["X-Nexus-Nonce"], requests[1].headers["X-Nexus-Nonce"]);
  await account.close();
});

test("credits error survives wire adaptation and an old account response is discarded", async () => {
  let resolve;
  const { account, wallet } = fixture(() => new Promise(done => { resolve = done; }));
  await account.loginPassword({ phone: "13800138000", password: "test-password", remember: false });
  const pending = wallet.balance();
  while (!resolve) await new Promise(done => setImmediate(done));
  await account.logout();
  resolve(response({ schema_version: "1", request_id: "old-account", data: { balance_credit_atoms: "1000000" } }));
  await assert.rejects(pending, error => error.code.startsWith("ACCOUNT_"));
  await account.close();
});

test('v2 wallet uses versioned catalog, quote, wallet and usage routes', async () => {
  const { account, wallet, requests } = fixture(() => response({ schema_version: '1', request_id: 'v2', data: {} }));
  await account.loginPassword({ phone: '13800138000', password: 'test-password', remember: false });
  await wallet.catalog(); await wallet.quote({ amount_fen: 1100 }); await wallet.wallet(); await wallet.usage({ limit: 20 });
  assert.deepEqual(requests.map(request => new URL(request.url).pathname.replace('/prod-api', '')), [
    '/app-api/v1/credits/catalog/v2', '/app-api/v1/credits/quote/v2', '/app-api/v1/credits/wallet/v2', '/app-api/v1/credits/usage/v2',
  ]);
  assert.equal(new URL(requests[1].url).search, '?amount_fen=1100');
  await account.close();
});

test('v2 custom orders carry only the quoted amount and currency rule', async () => {
  const { account, wallet, requests } = fixture(() => response({ schema_version: '1', request_id: 'order', data: { order_id: 'order-1' } }, 202));
  await account.loginPassword({ phone: '13800138000', password: 'test-password', remember: false });
  await wallet.createOrder({ purchase_intent_id: 'v2-buy', amount_fen: 1100, currency_rule_id: 'usd-credit-100-v2' });
  const body = JSON.parse(requests[0].body);
  assert.deepEqual(body, { schema_version: '1', purchase_intent_id: 'v2-buy', amount_fen: 1100, currency_rule_id: 'usd-credit-100-v2' });
  await assert.rejects(wallet.createOrder({ purchase_intent_id: 'v2-bad', amount_fen: 1100, currency_rule_id: 'usd-credit-100-v2', grant_credit_atoms: '1100000000' }), { code: 'CREDITS_INVALID_INPUT' });
  await account.close();
});
