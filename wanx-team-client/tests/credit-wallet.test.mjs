import test from "node:test";
import assert from "node:assert/strict";
import { formatCreditAtoms, displayCreditAtoms, sumCreditAtoms, createCreditWallet, decodeCreditEnvelope } from "../account/credit-wallet.mjs";

test("six-place accounting displays tiny debt, true zero and half-up totals exactly", () => {
  assert.deepEqual(formatCreditAtoms("4000"), { text: "<1", direction: "credit", exact: "0.004000" });
  assert.deepEqual(formatCreditAtoms("-4000"), { text: "<1", direction: "debt", exact: "-0.004000" });
  assert.deepEqual(formatCreditAtoms("0"), { text: "0", direction: "zero", exact: "0.000000" });
  assert.equal(formatCreditAtoms("15000").text, "<1");
  assert.equal(formatCreditAtoms("-15000").text, "<1");
  assert.equal(formatCreditAtoms("1998060000").text, "1,998");
  assert.equal(formatCreditAtoms(sumCreditAtoms(Array(100).fill("4000"))).text, "<1");
  assert.equal(formatCreditAtoms(sumCreditAtoms(Array(100).fill("6000"))).text, "<1");
  for (const [value, text] of [['999999', '<1'], ['-999999', '<1'], ['1000000', '1'],
    ['-1000000', '-1'], ['1499999', '1'], ['1500000', '2'], ['-1500000', '-2'],
    ['999500000', '1,000'], ['9223372036854775807', '9,223,372,036,855']]) {
    assert.equal(formatCreditAtoms(value).text, text);
  }
  assert.equal(displayCreditAtoms('1'), '余额不足 1 积分');
  assert.equal(displayCreditAtoms('-1'), '欠费不足 1 积分');
  assert.equal(displayCreditAtoms('1', 'consumption'), '消耗不足 1 积分');
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

test('v2 custom recharge uses the quoted integer amount and cannot accept client grants', async () => {
  const sent = [];
  const wallet = createCreditWallet({ request: async value => { sent.push(value); return {}; } });
  const purchase = { purchase_intent_id: 'custom-buy', amount_fen: 1200,
    currency_rule_id: 'usd-credit-100-v2', payment_channel: 'wechat' };
  await wallet.createOrder(purchase);
  assert.deepEqual(sent[0], { method: 'POST', path: '/app-api/v1/credits/orders',
    idempotencyKey: purchase.purchase_intent_id, body: { schema_version: '1', ...purchase } });
  for (const extra of [
    { grant_credit_atoms: '1234000000' }, { product_id: 'product', product_version: 'v1' },
    { currency_rule_id: 'cny-100-v1' },
    ...[0, 1101, 100100, 1.5, '1200'].map(amount_fen => ({ amount_fen })),
  ]) {
    await assert.rejects(wallet.createOrder({ ...purchase, ...extra }), { code: 'CREDITS_INVALID_INPUT' });
  }
  await assert.rejects(wallet.createOrder({ purchase_intent_id: 'old', amount_fen: 1200,
    currency_rule_id: 'usd-credit-100-v2', custom_recharge_version: 'cny-100-v1' }), { code: 'CREDITS_INVALID_INPUT' });
  assert.equal(sent.length, 1);
});

test('v2 product purchase keeps server-owned product pricing and the denomination marker', async () => {
  const sent = [];
  const wallet = createCreditWallet({ request: async value => { sent.push(value); return {}; } });
  const purchase = { purchase_intent_id: 'product-v2', product_id: 'p50', product_version: 'v2', currency_rule_id: 'usd-credit-100-v2', payment_channel: 'alipay' };
  await wallet.createOrder(purchase);
  assert.deepEqual(sent[0].body, { schema_version: '1', ...purchase });
  await assert.rejects(wallet.createOrder({ ...purchase, amount_fen: 5000 }), { code: 'CREDITS_INVALID_INPUT' });
});
