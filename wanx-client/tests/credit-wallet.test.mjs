import test from "node:test";
import assert from "node:assert/strict";
import { formatCreditAtoms, displayCreditAtoms, sumCreditAtoms, createCreditWallet, decodeCreditEnvelope, orderGrantCreditAtoms } from "../account/credit-wallet.mjs";

test('all wallet surfaces use half-up credits and distinguish tiny balances, consumption and debt', () => {
  for (const [atoms, expected] of [
    ['123400000', '123.40'], ['12344000', '12.34'], ['12345000', '12.35'], ['-12345000', '-12.35'],
    ['0', '0.00'], ['9999', '余额不足 0.01 积分'], ['-9999', '欠费不足 0.01 积分'],
    ['10000', '0.01'], ['-10000', '-0.01'], ['9007199254740993', '9,007,199,254.74'],
  ]) assert.equal(displayCreditAtoms(atoms), expected);
  assert.equal(displayCreditAtoms('9999', 'consumption'), '消耗不足 0.01 积分');
});

test('wallet transport explicitly requests v2 read contracts without falling back to raw v1', async () => {
  const sent = [], wallet = createCreditWallet({ request: async value => { sent.push(value); return {}; } });
  await wallet.wallet(); await wallet.usage({ before_sequence: '3', limit: 1 });
  assert.deepEqual(sent.map(value => value.path), [
    '/app-api/v1/credits/wallet/v2', '/app-api/v1/credits/usage/v2?before_sequence=3&limit=1',
  ]);
});

test("versioned order display preserves exact integer strings and rejects invalid amounts", () => {
  const original = { grant_credit_atoms: "20000000" };
  assert.equal(orderGrantCreditAtoms(original), "20000000");
  assert.equal(orderGrantCreditAtoms({ ...original, credit_display: null }), null);
  const display = { currency_rule_id: "usd-credit-100-v2", credit_scale: 6, grant_credit_atoms: "2000000000" };
  assert.equal(orderGrantCreditAtoms({ ...original, credit_display: display }), "2000000000");
  for (const value of ["-0", "01", "-1", "0", "1.0", 2000000000, "9223372036854775808"]) {
    assert.throws(() => orderGrantCreditAtoms({ ...original,
      credit_display: { ...display, grant_credit_atoms: value } }), { code: "CREDITS_INVALID_RESPONSE" });
  }
  assert.throws(() => orderGrantCreditAtoms({ ...original,
    credit_display: { ...display, credit_scale: 8 } }), { code: "CREDITS_INVALID_RESPONSE" });
});

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


test('v2 recharge transport quotes custom amounts and signs only the frozen intent inputs', async () => {
  const sent = [], wallet = createCreditWallet({ request: async value => { sent.push(value); return {}; } });
  await wallet.catalog(); await wallet.quote({ amount_fen: 1100 });
  await wallet.createOrder({ purchase_intent_id: 'v2-buy', amount_fen: 1100, currency_rule_id: 'usd-credit-100-v2' });
  assert.deepEqual(sent.map(v => v.path), ['/app-api/v1/credits/catalog/v2', '/app-api/v1/credits/quote/v2?amount_fen=1100', '/app-api/v1/credits/orders']);
  assert.deepEqual(sent[2].body, { schema_version:'1', purchase_intent_id:'v2-buy', amount_fen:1100, currency_rule_id:'usd-credit-100-v2' });
  for (const amount_fen of [900, 100100, 1050, '1100', true]) {
    await assert.rejects(wallet.createOrder({ purchase_intent_id:'bad', amount_fen, currency_rule_id:'usd-credit-100-v2' }), { code:'CREDITS_INVALID_INPUT' });
  }
  await assert.rejects(wallet.createOrder({ purchase_intent_id:'bad', amount_fen:1100, currency_rule_id:'usd-credit-100-v2', grant_credit_atoms:'1' }), { code:'CREDITS_INVALID_INPUT' });
  assert.equal(sent.length, 3);
});
