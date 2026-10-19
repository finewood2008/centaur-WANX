import assert from 'node:assert/strict';
import test from 'node:test';
import { createWalletView } from '../local-ui/renderer/wallet-view.mjs';

const envelope = data => ({ schema_version: '1', request_id: 'req-test', data });
const balance = { balance_credit_atoms: '1998060000', debt_credit_atoms: '0', ledger_sequence: 2,
  inflight_call_id: null, execution_slot_state: 'none', pending_call_count: 0 };
const order = { order_id: 'order-1', purchase_intent_id: 'intent-1', amount_fen: 10000,
  grant_credit_atoms: '2000000000', display_state: 'pending', payment_state: 'pending', fulfillment_state: 'not_due',
  review_state: 'none', created_at: '2026-10-18T02:00:00Z', expires_at: '2026-10-18T02:15:00Z',
  payment_action: { type: 'qr', payload: 'provider-pay:private-payload', expires_at: '2026-10-18T02:15:00Z' } };
function storage() { const data = new Map(); return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; }
function setup(overrides = {}) {
  const seen = [];
  const request = async (action, input) => {
    seen.push([action, input]);
    if (overrides.request) { const response = await overrides.request(action, input); if (response !== undefined) return response; }
    if (action === 'wallet.catalog') return envelope({ recharge_enabled: true, timezone: 'Asia/Shanghai', tiers: [{ amount_fen: 10000, grant_credit_atoms: '2000000000' }] });
    if (action === 'wallet.balance') return envelope(balance);
    if (action === 'wallet.summary') return envelope({ net_consumed_credit_atoms: '1940000', gross_consumed_credit_atoms: '1940000', correction_credit_atoms: '0', pending_call_count: 0, ledger_sequence: 2 });
    if (action === 'wallet.createOrder' || action === 'wallet.order') return envelope(order);
    return envelope({ items: [], next_cursor: null, through_ledger_sequence: 2 });
  };
  const view = createWalletView({ request, changed() {}, storage: overrides.storage || storage(),
    uuid: () => 'intent-1', now: () => Date.parse('2026-10-18T02:01:00Z'),
    schedule: () => null, cancel() {}, qr: async value => { assert.equal(value, order.payment_action.payload); return 'data:image/png;base64,local'; }, ...overrides, request });
  view.reset(JSON.stringify(['alice', 'client-1']));
  return { view, seen };
}

test('Native channel selection is frozen and renders only the selected WeChat QR', async () => {
  const payload = 'weixin://wxpay/bizpayurl?pr=native-test';
  const native = { ...order, payment_channel: 'wechat', payment_action: { ...order.payment_action, payload } };
  const { view, seen } = setup({ request: async action => {
    if (action === 'wallet.catalog') return envelope({ recharge_enabled: true, payment_channels: ['alipay', 'wechat'], tiers: [{ amount_fen: 10000, grant_credit_atoms: '2000000000' }] });
    if (action === 'wallet.createOrder' || action === 'wallet.order') return envelope(native);
  }, qr: async value => { assert.equal(value, payload); return 'data:image/png;base64,local'; } });
  await view.refresh(); await view.action('credits-open');
  await view.action('credits-channel', { channel: 'wechat' });
  await view.action('credits-buy', { amount: '10000' });
  assert.equal(seen.find(([action]) => action === 'wallet.createOrder')[1].payment_channel, 'wechat');
  await view.action('credits-channel', { channel: 'alipay' });
  await view.action('credits-buy', { amount: '10000' });
  assert.equal(seen.filter(([action]) => action === 'wallet.createOrder').length, 1);
  assert.match(view.render(), /微信扫码支付/);
  assert.doesNotMatch(view.render(), /微信 \/ 支付宝扫码支付/);
  assert.equal((view.render().match(/class="wallet-qr"/g) || []).length, 1);
});

test('lost Native create response preserves channel and intent across restart', async () => {
  const store = storage();
  const request = async action => {
    if (action === 'wallet.catalog') return envelope({ recharge_enabled: true, payment_channels: ['alipay', 'wechat'], tiers: [{ amount_fen: 10000, grant_credit_atoms: '2000000000' }] });
    if (action === 'wallet.createOrder') throw new Error('NETWORK_ERROR');
  };
  const first = setup({ storage: store, request });
  await first.view.refresh();
  await first.view.action('credits-channel', { channel: 'wechat' });
  await first.view.action('credits-buy', { amount: '10000' });
  const restarted = setup({ storage: store, request });
  await restarted.view.refresh();
  const initial = first.seen.find(([action]) => action === 'wallet.createOrder')[1];
  const retry = restarted.seen.find(([action]) => action === 'wallet.createOrder')[1];
  assert.deepEqual(retry, initial);
  assert.equal(retry.payment_channel, 'wechat');
});

test('purchase retry survives restart with same account intent and local QR only', async () => {
  const store = storage(); let failed = false;
  const first = setup({ storage: store, request: async action => {
    if (action === 'wallet.createOrder' && !failed) { failed = true; throw new Error('NETWORK_ERROR'); }
  } });
  await first.view.refresh(); await first.view.action('credits-buy', { amount: '10000' });
  const second = setup({ storage: store });
  second.view.reset(JSON.stringify(['alice', 'new-client']));
  await second.view.refresh(); await second.view.action('credits-open');
  const creates = [...first.seen, ...second.seen].filter(([action]) => action === 'wallet.createOrder');
  assert.equal(creates.length, 2);
  assert.equal(creates[0][1].purchase_intent_id, creates[1][1].purchase_intent_id);
  assert.match(second.view.render(), /data:image\/png;base64,local/);
  assert.doesNotMatch(second.view.render(), /provider-pay:private-payload|已支付.*确认按钮|赠送积分|预算/);
  assert.match(second.view.render(), /1,998\.06/);
});

test('storage failure prevents a purchase and account switch discards old reads', async () => {
  const store = { getItem() { return null; }, setItem() { throw new Error('disk full'); }, removeItem() {} };
  const first = setup({ storage: store });
  await first.view.refresh(); await first.view.action('credits-buy', { amount: '10000' });
  assert.equal(first.seen.some(([action]) => action === 'wallet.createOrder'), false);
  assert.match(first.view.render(), /无法保存购买意图/);
  let resolve;
  const pending = setup({ request: action => action === 'wallet.balance' ? new Promise(r => { resolve = r; }) : undefined });
  const read = pending.view.refresh();
  while (!resolve) await Promise.resolve();
  pending.view.reset(JSON.stringify(['bob', 'client-2']));
  resolve(envelope(balance)); await read;
  assert.doesNotMatch(pending.view.render(), /1,998\.06/);
});

test('unavailable credits routes explain the deployment issue and keep purchase disabled', async () => {
  const { view, seen } = setup({ request: async () => { throw new Error('CREDITS_SERVICE_UNAVAILABLE'); } });
  await view.refresh();
  await view.action('credits-open');
  assert.match(view.render(), /积分接口暂不可用，请联系管理员检查服务部署/);
  assert.doesNotMatch(view.render(), /响应无法校验/);
  await view.action('credits-buy', { amount: '5000' });
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
});

test('expired payment material is hidden and request IDs remain visible', async () => {
  const old = setup({ now: () => Date.parse('2026-10-18T02:16:00Z') });
  await old.view.refresh(); await old.view.action('credits-buy', { amount: '10000' });
  assert.doesNotMatch(old.view.render(), /data:image/);
  assert.match(old.view.render(), /已到期/);
  const failure = setup({ request: async action => { if (action === 'wallet.balance') throw Object.assign(new Error('SERVICE_UNAVAILABLE'), { request_id: 'support-123' }); } });
  await failure.view.refresh(); assert.match(failure.view.render(), /support-123/);
});


test('close recovery survives balance failure and hides uncertain or expired QR', async () => {
  const store = storage();
  let closing = false, timestamp = Date.parse('2026-10-18T02:01:00Z');
  const first = setup({ storage: store, now: () => timestamp, request: async action => {
    if (action === 'wallet.createOrder') return envelope({ ...order, payment_action: { ...order.payment_action, expires_at: '2026-10-18T02:02:00Z' } });
    if (action === 'wallet.closeOrder') { closing = true; throw new Error('NETWORK_ERROR'); }
  } });
  await first.view.refresh(); await first.view.action('credits-buy', { amount: '10000' });
  assert.match(first.view.render(), /data:image/);
  timestamp = Date.parse('2026-10-18T02:03:00Z');
  assert.doesNotMatch(first.view.render(), /data:image/);
  timestamp = Date.parse('2026-10-18T02:01:00Z');
  await first.view.action('credits-close-order');
  assert.equal(closing, true);
  assert.doesNotMatch(first.view.render(), /data:image/);
  const restarted = setup({ storage: store, request: async action => {
    if (action === 'wallet.balance') throw new Error('SERVICE_UNAVAILABLE');
    if (action === 'wallet.closeOrder') return envelope({ ...order, display_state: 'close_pending', payment_state: 'close_pending', payment_action: null });
  } });
  await restarted.view.refresh(); await restarted.view.action('credits-open');
  assert.equal(restarted.seen.filter(([action]) => action === 'wallet.closeOrder').length, 1);
  assert.doesNotMatch(restarted.view.render(), /data:image/);
  assert.match(restarted.view.render(), /关闭确认中/);
});

test('an active order discovered after login is polled by ID through its terminal state', async () => {
  let paid = false, poll;
  const { view, seen } = setup({ schedule: callback => { poll = callback; return null; }, request: (action, input) => {
    if (action === 'wallet.orders' && input?.active) return envelope({ items: paid ? [] : [order], next_cursor: null });
    if (action === 'wallet.order') return envelope({ ...order, payment_state: 'paid', fulfillment_state: 'credited', display_state: 'credited', payment_action: null });
  } });
  await view.refresh();
  await view.action('credits-open');
  assert.match(view.render(), /支付二维码/);
  paid = true;
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(view.render(), /已到账/);
  assert.doesNotMatch(view.render(), /支付二维码/);
  assert.ok(seen.some(([action, input]) => action === 'wallet.order' && input?.order_id === 'order-1'));
});

test('review keeps paid and credited facts visible without a payable QR', async () => {
  const reviewed = { ...order, display_state: 'review_required', payment_state: 'paid',
    fulfillment_state: 'credited', review_state: 'open', payment_action: null };
  const { view } = setup({ request: async action =>
    ['wallet.createOrder', 'wallet.order'].includes(action) ? envelope(reviewed) : undefined });
  await view.refresh();
  await view.action('credits-buy', { amount: '10000' });
  const html = view.render();
  assert.match(html, /待核对/);
  assert.match(html, /已支付/);
  assert.match(html, /已到账/);
  assert.doesNotMatch(html, /data:image|provider-pay:private-payload/);
});

test('wallet limits credit warnings to our provider and never controls model execution', async () => {
  for (const [atoms, slot, expected] of [
    ['0', 'none', /积分不足.*平台 Provider/],
    ['-1000000', 'none', /充值后先抵扣欠款/],
    ['1000000', 'held', /平台 Provider.*等待结果或核对/],
  ]) {
    const { view, seen } = setup({ request: action => action === 'wallet.balance' ? envelope({
      ...balance, balance_credit_atoms: atoms, debt_credit_atoms: atoms.startsWith('-') ? '1000000' : '0', execution_slot_state: slot,
    }) : undefined });
    await view.refresh();
    assert.match(view.render(), /仅平台 Provider 的模型调用消耗积分/);
    assert.match(view.render(), /BYOK 和本地模型不使用此积分/);
    assert.match(view.render(), expected);
    assert.ok(seen.every(([action]) => action.startsWith('wallet.')));
    await view.action('credits-refresh');
    assert.ok(seen.every(([action]) => action.startsWith('wallet.')));
  }
});

test('expired order stays blocked until Admin closes it, then restart can purchase a new tier', async () => {
  const store = storage(); let closed = false, sequence = 0;
  const request = (action, input) => {
    if (action === 'wallet.catalog') return envelope({ recharge_enabled: true, timezone: 'Asia/Shanghai', tiers: [
      { amount_fen: 5000, grant_credit_atoms: '1000000000' }, { amount_fen: 10000, grant_credit_atoms: '2000000000' }
    ] });
    if (action === 'wallet.createOrder') return envelope({ ...order, purchase_intent_id: input.purchase_intent_id, amount_fen: input.amount_fen,
      order_id: input.amount_fen === 5000 ? 'old-order' : 'new-order', payment_action: null });
    if (action === 'wallet.closeOrder' || action === 'wallet.order') return envelope({ ...order, order_id: 'old-order', amount_fen: 5000,
      payment_state: closed ? 'closed' : 'close_pending', display_state: closed ? 'closed' : 'close_pending', payment_action: null });
  };
  const options = { storage: store, uuid: () => `purchase-${++sequence}`, now: () => Date.parse('2026-10-18T02:16:00Z'), request };
  const first = setup(options);
  await first.view.refresh(); await first.view.action('credits-buy', { amount: '5000' });
  await first.view.action('credits-close-order');
  assert.match(first.view.render(), /关闭确认中/);
  assert.doesNotMatch(first.view.render(), /支付二维码/);
  const restarted = setup(options);
  await restarted.view.refresh(); await restarted.view.action('credits-open');
  assert.equal(restarted.seen.some(([action]) => action === 'wallet.createOrder'), false);
  closed = true;
  await restarted.view.refresh(); await restarted.view.action('credits-open');
  assert.match(restarted.view.render(), /已关闭/);
  await restarted.view.action('credits-buy', { amount: '10000' });
  const oldIntent = first.seen.find(([action]) => action === 'wallet.createOrder')[1];
  const newIntent = restarted.seen.find(([action]) => action === 'wallet.createOrder')[1];
  assert.notEqual(oldIntent.purchase_intent_id, newIntent.purchase_intent_id);
  assert.equal(newIntent.amount_fen, 10000);
  assert.match(restarted.view.render(), /data-amount="10000" aria-pressed="true"/);
  assert.doesNotMatch(restarted.view.render(), /new-order|old-order/);
});

test('credits offers one purchase entry and shows products only inside the purchase dialog', async () => {
  const { view, seen } = setup();
  await view.refresh();
  assert.match(view.render(), /data-action="credits-open"/);
  assert.doesNotMatch(view.render(), /data-action="credits-buy"|role="dialog"|积分流水|调用记录|充值订单|消费统计/);
  assert.equal(seen.some(([action, input]) => ['wallet.entries', 'wallet.calls', 'wallet.summary'].includes(action) || (action === 'wallet.orders' && !input?.active)), false);
  await view.action('credits-open');
  assert.match(view.render(), /role="dialog"/);
  assert.match(view.render(), /data-action="credits-buy"/);
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
  await view.action('credits-buy', { amount: '10000' });
  assert.match(view.render(), /支付二维码/);
  await view.action('credits-dismiss');
  assert.doesNotMatch(view.render(), /role="dialog"|支付二维码/);
  assert.equal(seen.some(([action]) => action === 'wallet.closeOrder'), false);
  await view.action('credits-open');
  assert.match(view.render(), /支付二维码/);
  assert.equal(seen.filter(([action]) => action === 'wallet.createOrder').length, 1);
});

test('QR expires on time even when a payment status request is still in flight', async () => {
  const timers = new Map(); let timestamp = Date.parse('2026-10-18T02:01:00Z'), resolve;
  const { view } = setup({ now: () => timestamp, schedule: (callback, delay) => { timers.set(delay, callback); return delay; },
    request: action => action === 'wallet.order' ? new Promise(done => { resolve = done; }) : undefined });
  await view.refresh(); await view.action('credits-buy', { amount: '10000' });
  assert.equal(typeof timers.get(14 * 60 * 1000), 'function');
  const inFlight = view.refresh();
  timestamp = Date.parse('2026-10-18T02:15:00Z');
  timers.get(14 * 60 * 1000)();
  assert.doesNotMatch(view.render(), /data:image/);
  assert.match(view.render(), /付款码已到期/);
  resolve(envelope(order)); await inFlight;
});

test('an unavailable active purchase lookup prevents new purchases until recovery succeeds', async () => {
  let offline = true;
  const { view, seen } = setup({ request: (action, input) => {
    if (action === 'wallet.orders' && input?.active && offline) throw new Error('NETWORK_ERROR');
  } });
  await view.refresh(); await view.action('credits-open');
  await view.action('credits-buy', { amount: '10000' });
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
  offline = false; await view.refresh();
  await view.action('credits-buy', { amount: '10000' });
  assert.match(view.render(), /支付二维码/);
});

test('payment confirmation and fulfillment are distinct and neither permits a second payment', async () => {
  let value = order;
  const { view, seen } = setup({ request: action => action === 'wallet.order' ? envelope(value) : undefined });
  await view.refresh(); await view.action('credits-buy', { amount: '10000' });
  await view.action('credits-buy', { amount: '10000' });
  assert.equal(seen.filter(([action]) => action === 'wallet.createOrder').length, 1);
  value = { ...order, display_state: 'paid_pending', payment_state: 'paid', fulfillment_state: 'pending', payment_action: null };
  await view.refresh();
  assert.match(view.render(), /支付成功，积分到账中/);
  assert.doesNotMatch(view.render(), /积分已到账|支付二维码|credits-close-order/);
  await view.action('credits-dismiss');
  value = { ...value, display_state: 'credited', fulfillment_state: 'credited' };
  await view.refresh(); await view.action('credits-open');
  assert.match(view.render(), /积分已到账/);
  assert.doesNotMatch(view.render(), /支付二维码/);
  await view.refresh();
  assert.match(view.render(), /积分已到账/);
  assert.equal(seen.filter(([action]) => action === 'wallet.createOrder').length, 1);
});

test('creating purchase can be dismissed and reopened without losing its in-flight intent', async () => {
  let resolve;
  const { view, seen } = setup({ request: action => action === 'wallet.createOrder' ? new Promise(done => { resolve = done; }) : undefined });
  await view.refresh();
  const purchase = view.action('credits-buy', { amount: '10000' });
  assert.match(view.render(), /正在生成付款码/);
  await view.action('credits-dismiss'); await view.action('credits-open');
  await view.action('credits-buy', { amount: '10000' });
  assert.equal(seen.filter(([action]) => action === 'wallet.createOrder').length, 1);
  resolve(envelope(order)); await purchase;
  assert.match(view.render(), /支付二维码/);
  view.reset(JSON.stringify(['bob', 'client-2']));
  assert.doesNotMatch(view.render(), /role="dialog"|data:image|2,000\.00/);
});

test('payment winning a cancellation immediately transitions to fulfillment instead of close pending', async () => {
  const { view } = setup({ request: action => {
    if (action === 'wallet.closeOrder') throw Object.assign(new Error('ORDER_ALREADY_PAID'), { code: 'ORDER_ALREADY_PAID' });
    if (action === 'wallet.order') return envelope({ ...order, payment_state: 'paid', display_state: 'paid_pending', fulfillment_state: 'pending', payment_action: null });
  } });
  await view.refresh(); await view.action('credits-buy', { amount: '10000' });
  await view.action('credits-close-order');
  assert.match(view.render(), /支付成功，积分到账中/);
  assert.doesNotMatch(view.render(), /关闭确认中|支付二维码/);
});

test('credited purchase still retries a failed balance read without recharging again', async () => {
  let paid = false, failBalance = false, retry;
  const { view, seen } = setup({ schedule: (callback, delay) => { if (delay === 30000) retry = callback; return null; },
    request: action => {
      if (action === 'wallet.order' && paid) return envelope({ ...order, payment_state: 'paid', display_state: 'credited', fulfillment_state: 'credited', payment_action: null });
      if (action === 'wallet.balance' && failBalance) throw new Error('NETWORK_ERROR');
      if (action === 'wallet.balance' && paid) return envelope({ ...balance, balance_credit_atoms: '3998060000', ledger_sequence: 3 });
    } });
  await view.refresh(); await view.action('credits-buy', { amount: '10000' });
  paid = failBalance = true; await view.refresh();
  assert.match(view.render(), /积分已到账/);
  assert.match(view.render(), /data-action="credits-refresh"/);
  assert.equal(typeof retry, 'function');
  failBalance = false; retry(); await new Promise(resolve => setImmediate(resolve));
  assert.match(view.render(), /3,998\.06/);
  assert.equal(seen.filter(([action]) => action === 'wallet.createOrder').length, 1);
});

test('penny product displays its own grant and recovers the same version after restart', async () => {
  const store = storage();
  const penny = { product_id: 'penny', version: 'v1', name: '小额支付测试', amount_fen: 1, grant_credit_atoms: '200000', enabled: true };
  const request = async action => {
    if (action === 'wallet.catalog') return envelope({ recharge_enabled: true, products: [penny], tiers: [] });
    if (action === 'wallet.createOrder') throw new Error('NETWORK_ERROR');
  };
  const first = setup({ storage: store, request });
  await first.view.refresh(); await first.view.action('credits-open');
  assert.match(first.view.render(), /小额支付测试/);
  assert.match(first.view.render(), /¥0\.01/);
  assert.match(first.view.render(), /0\.2/);
  assert.doesNotMatch(first.view.render(), /1 元 = 20/);
  await first.view.action('credits-buy', { amount: 'penny' });
  const second = setup({ storage: store, request: async action => {
    if (action === 'wallet.createOrder') return envelope({ ...order, amount_fen: 1, grant_credit_atoms: '200000' });
    return request(action);
  } });
  await second.view.refresh();
  const creates = [...first.seen, ...second.seen].filter(([action]) => action === 'wallet.createOrder');
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0][1], { purchase_intent_id: 'intent-1', product_id: 'penny', product_version: 'v1' });
  assert.deepEqual(creates[1][1], creates[0][1]);
});

test('a rejected stale product clears the purchase intent and permits choosing the refreshed version', async () => {
  let version = 'v1';
  const { view, seen } = setup({ request: async (action, input) => {
    if (action === 'wallet.catalog') return envelope({ recharge_enabled: true, tiers: [], products: [{ product_id: 'penny', version, name: '测试', amount_fen: 1, grant_credit_atoms: '200000' }] });
    if (action === 'wallet.createOrder' && input.product_version === 'v1') {
      version = 'v2'; throw Object.assign(new Error('REVISION_CONFLICT'), { code: 'REVISION_CONFLICT' });
    }
  } });
  await view.refresh(); await view.action('credits-buy', { amount: 'penny' });
  assert.match(view.render(), /商品已调整/);
  await view.action('credits-buy', { amount: 'penny' });
  assert.deepEqual(seen.filter(([action]) => action === 'wallet.createOrder').map(([, value]) => value.product_version), ['v1', 'v2']);
});

test('restart releases only a definitively rejected product intent and recovers normally', async () => {
  const store = storage();
  store.setItem('wanx.credit.purchase.v1:alice', JSON.stringify({ purchase_intent_id: 'old', product_id: 'penny', product_version: 'old-version' }));
  const { view, seen } = setup({ storage: store, request: async action => {
    if (action === 'wallet.createOrder') throw Object.assign(new Error('REVISION_CONFLICT'), { code: 'REVISION_CONFLICT' });
  } });
  await view.refresh();
  assert.equal(store.getItem('wanx.credit.purchase.v1:alice'), null);
  await view.refresh();
  assert.equal(seen.filter(([action]) => action === 'wallet.createOrder').length, 1);
  assert.equal(seen.filter(([action]) => action === 'wallet.orders').length, 1);
});
