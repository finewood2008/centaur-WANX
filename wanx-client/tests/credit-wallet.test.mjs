import test from "node:test";
import assert from "node:assert/strict";
import { formatCreditAtoms, sumCreditAtoms, createCreditWallet, decodeCreditEnvelope } from "../account/credit-wallet.mjs";

test("six-place accounting displays tiny debt, true zero and half-up totals exactly", () => {
  assert.deepEqual(formatCreditAtoms("4000"), { text: "<0.01", direction: "credit", exact: "0.004000" });
  assert.deepEqual(formatCreditAtoms("-4000"), { text: "<0.01", direction: "debt", exact: "-0.004000" });
  assert.deepEqual(formatCreditAtoms("0"), { text: "0.00", direction: "zero", exact: "0.000000" });
  assert.equal(formatCreditAtoms("15000").text, "0.02");
  assert.equal(formatCreditAtoms("-15000").text, "-0.02");
  assert.equal(formatCreditAtoms("1998060000").text, "1,998.06");
  assert.equal(formatCreditAtoms(sumCreditAtoms(Array(100).fill("4000"))).text, "0.40");
  assert.equal(formatCreditAtoms(sumCreditAtoms(Array(100).fill("6000"))).text, "0.60");
  for (const value of ["-0", "01", "1.0", 1, "9223372036854775808"]) {
    assert.throws(() => formatCreditAtoms(value), { code: "CREDITS_INVALID_RESPONSE" });
  }
});

test("wallet exposes fixed signed operations and preserves the versioned envelope", async () => {
  const sent = [];
  const envelope = { schema_version: "1", request_id: "req-1", data: { order_id: "order-1" } };
  const wallet = createCreditWallet({ request: async (input) => { sent.push(input); return envelope; } });
  assert.deepEqual(await wallet.createOrder({ purchase_intent_id: "buy:1", amount_fen: 10000 }), envelope);
  assert.deepEqual(sent[0], { method: "POST", path: "/app-api/v1/credits/orders",
    idempotencyKey: "buy:1", body: { schema_version: "1", purchase_intent_id: "buy:1", amount_fen: 10000 } });
  await assert.rejects(() => wallet.createOrder({ purchase_intent_id: "buy:2", amount_fen: 10000, url: "https://evil.invalid" }),
    { code: "CREDITS_INVALID_INPUT" });
  await assert.rejects(() => wallet.order({ order_id: "../balance" }), { code: "CREDITS_INVALID_INPUT" });
  assert.equal(sent.length, 1);
});

test("envelope error retains stable code and request ID instead of arbitrary server text", () => {
  assert.throws(() => decodeCreditEnvelope({ schema_version: "1", request_id: "req-conflict",
    error: { code: "ORDER_IN_PROGRESS", message: "sensitive server text", retryable: false,
      details: { blocking_order_ids: ["order-1"] } } }, 409),
  error => error.code === "ORDER_IN_PROGRESS" && error.request_id === "req-conflict" &&
    error.details.blocking_order_ids[0] === "order-1" && !error.message.includes("sensitive"));
  assert.throws(() => decodeCreditEnvelope({ schema_version: 1, request_id: "x", data: {} }, 200),
    { code: "CREDITS_INVALID_RESPONSE" });
});

test('wallet sends selected channel in the signed body and rejects arbitrary channels', async () => {
  const sent = [];
  const wallet = createCreditWallet({ request: async value => { sent.push(value); return {}; } });
  await wallet.createOrder({ purchase_intent_id: 'wx-buy', amount_fen: 5000, payment_channel: 'wechat' });
  assert.equal(sent[0].body.payment_channel, 'wechat');
  for (const channel of ['unified', 'native', '', null, { channel: 'wechat' }]) {
    await assert.rejects(wallet.createOrder({ purchase_intent_id: 'bad', amount_fen: 5000, payment_channel: channel }), { code: 'CREDITS_INVALID_INPUT' });
  }
  assert.equal(sent.length, 1);
});

test('product purchase sends only the selected ID and version; amount and credits stay server-owned', async () => {
  const sent = [];
  const wallet = createCreditWallet({ request: async value => { sent.push(value); return {}; } });
  await wallet.createOrder({ purchase_intent_id: 'penny-buy', product_id: 'penny', product_version: 'v1' });
  assert.deepEqual(sent[0].body, { schema_version: '1', purchase_intent_id: 'penny-buy', product_id: 'penny', product_version: 'v1' });
  for (const extra of [{ amount_fen: 1 }, { grant_credit_atoms: '999999999' }, { product_version: undefined }]) {
    await assert.rejects(() => wallet.createOrder({ purchase_intent_id: 'penny-buy', product_id: 'penny', product_version: 'v1', ...extra }), { code: 'CREDITS_INVALID_INPUT' });
  }
  assert.equal(sent.length, 1);
});
