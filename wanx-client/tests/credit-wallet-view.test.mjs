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

test('v2 wallet renders rounded credits and contextual tiny usage without internal currency or token details', async () => {
  const wallet = { view_version: '2', account_id: 'alice', currency_rule_id: 'usd-credit-100-v2', credit_scale: 6,
    balance_credit_atoms: '-12345000', spent_credit_atoms: '1009999', correction_credit_atoms: '0',
    net_spent_credit_atoms: '1009999', remote_sequence: '4', sync_state: 'synced',
    synced_at: '2026-10-18T02:00:00Z', pending_executions: 0, error_code: null };
  const page = { view_version: '2', account_id: 'alice', currency_rule_id: 'usd-credit-100-v2', credit_scale: 6,
    remote_sequence: '4', next_before_sequence: null, items: [
      { event_id: 'tiny', account_sequence: '4', debit_credit_atoms: '9999', occurred_at: wallet.synced_at, model: 'model', device_id: 'box' },
      { event_id: 'normal', account_sequence: '3', debit_credit_atoms: '1000000', occurred_at: wallet.synced_at, model: 'model', device_id: 'box' },
    ] };
  const { view } = setup({ request: action => {
    if (action === 'wallet.balance') return envelope({ ...balance, billing_backend: 'qeetoken' });
    if (action === 'wallet.wallet') return envelope(wallet);
    if (action === 'wallet.usage') return envelope(page);
  } });
  await view.refresh();
  assert.match(view.render(), /-12\.35/);
  assert.match(view.render(), /消耗不足 0\.01 积分/);
  assert.match(view.render(), />1\.00</);
  assert.doesNotMatch(view.render(), /USD|tokens?|\$|12\.345|1\.009999|账本变动|无法校验/i);
});

test('recovered old order renders the explicitly versioned current grant without creating a new intent', async () => {
  const store = storage();
  store.setItem('wanx.credit.purchase.v1:alice', JSON.stringify({
    purchase_intent_id: 'old-intent', order_id: 'order-1', amount_fen: 5000,
  }));
  const recovered = { ...order, grant_credit_atoms: '20000000',
    credit_display: { currency_rule_id: 'usd-credit-100-v2', credit_scale: 6, grant_credit_atoms: '2000000000' },
    display_state: 'credited', payment_state: 'paid', fulfillment_state: 'credited', payment_action: null };
  const { view, seen } = setup({ storage: store, request: action =>
    action === 'wallet.order' ? envelope(recovered) : undefined });
  await view.refresh(); await view.action('credits-open');
  assert.match(view.render(), /2,000\.00 点积分已记入当前账号/);
  assert.doesNotMatch(view.render(), /20\.00 点积分已记入当前账号/);
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
  assert.equal(store.getItem('wanx.credit.purchase.v1:alice'), null);
});

test('unknown order display version retains the persisted purchase for recovery', async () => {
  const store = storage();
  const saved = JSON.stringify({ purchase_intent_id: 'old-intent', order_id: 'order-1', amount_fen: 5000 });
  store.setItem('wanx.credit.purchase.v1:alice', saved);
  const { view, seen } = setup({ storage: store, request: action => action === 'wallet.order' ? envelope({
    ...order, display_state: 'credited',
    credit_display: { currency_rule_id: 'unknown', credit_scale: 6, grant_credit_atoms: '2000000000' },
  }) : undefined });
  await view.refresh(); await view.action('credits-open');
  assert.match(view.render(), /积分响应无法校验/);
  assert.doesNotMatch(view.render(), /积分已到账/);
  assert.equal(store.getItem('wanx.credit.purchase.v1:alice'), saved);
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
});

test('unavailable order projection preserves close recovery and never shows the original amount as current', async () => {
  const store = storage();
  store.setItem('wanx.credit.purchase.v1:alice', JSON.stringify({
    purchase_intent_id: 'old-intent', order_id: 'order-1', amount_fen: 5000,
  }));
  const uncertain = { ...order, grant_credit_atoms: '20000000', credit_display: null };
  const { view, seen } = setup({ storage: store, request: action => {
    if (action === 'wallet.order') return envelope(uncertain);
    if (action === 'wallet.closeOrder') return envelope({ ...uncertain, display_state: 'closed', payment_state: 'closed' });
  } });
  await view.refresh(); await view.action('credits-open');
  assert.match(view.render(), /到账积分待核对/);
  assert.doesNotMatch(view.render(), /到账 20|wallet-qr/);
  assert.notEqual(store.getItem('wanx.credit.purchase.v1:alice'), null);
  await view.action('credits-close-order');
  assert.equal(seen.some(([action]) => action === 'wallet.closeOrder'), true);
  assert.equal(store.getItem('wanx.credit.purchase.v1:alice'), null);
});

test('product and channel selection stay local until confirmation creates one frozen payment', async () => {
  const payload = 'weixin://wxpay/bizpayurl?pr=native-test';
  const native = { ...order, payment_channel: 'wechat', payment_action: { ...order.payment_action, payload } };
  const { view, seen } = setup({ request: async action => {
    if (action === 'wallet.catalog') return envelope({ recharge_enabled: true, payment_channels: ['alipay', 'wechat'], tiers: [{ amount_fen: 10000, grant_credit_atoms: '2000000000' }] });
    if (action === 'wallet.createOrder' || action === 'wallet.order') return envelope(native);
  }, qr: async value => { assert.equal(value, payload); return 'data:image/png;base64,local'; } });
  await view.refresh(); await view.action('credits-open');
  assert.doesNotMatch(view.render(), /data-action="credits-channel"|支付二维码/);
  const beforeSelection = seen.length;
  await view.action('credits-buy', { amount: '10000' });
  assert.doesNotMatch(view.render(), /data-action="credits-buy"/);
  await view.action('credits-reselect');
  assert.match(view.render(), /data-action="credits-buy"/);
  await view.action('credits-buy', { amount: '10000' });
  await view.action('credits-channel', { channel: 'wechat' });
  await view.action('credits-channel', { channel: 'alipay' });
  await view.action('credits-channel', { channel: 'wechat' });
  assert.equal(seen.length, beforeSelection, 'selection must not create, close or query an order');
  assert.match(view.render(), /确定支付 ¥100/);
  assert.doesNotMatch(view.render(), /支付二维码/);
  await view.action('credits-confirm');
  assert.equal(seen.find(([action]) => action === 'wallet.createOrder')[1].payment_channel, 'wechat');
  await view.action('credits-channel', { channel: 'alipay' });
  await view.action('credits-buy', { amount: '10000' });
  await view.action('credits-confirm');
  assert.equal(seen.filter(([action]) => action === 'wallet.createOrder').length, 1);
  assert.match(view.render(), /微信扫码支付/);
  assert.doesNotMatch(view.render(), /data-action="credits-buy"|data-action="credits-channel"/);
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
  await first.view.action('credits-buy', { amount: '10000' });
  await first.view.action('credits-channel', { channel: 'wechat' });
  await first.view.action('credits-confirm');
  const restarted = setup({ storage: store, request });
  await restarted.view.refresh();
  const initial = first.seen.find(([action]) => action === 'wallet.createOrder')[1];
  const retry = restarted.seen.find(([action]) => action === 'wallet.createOrder')[1];
  assert.deepEqual(retry, initial);
  assert.equal(retry.payment_channel, 'wechat');
});

test('cancelling product selection has no payment side effects and requires selecting again', async () => {
  const store = storage();
  const { view, seen } = setup({ storage: store });
  await view.refresh(); await view.action('credits-open');
  const before = seen.length;
  await view.action('credits-buy', { amount: '10000' });
  await view.action('credits-dismiss');
  assert.equal(seen.length, before);
  assert.equal(store.getItem('wanx.credit.purchase.v1:alice'), null);
  await view.action('credits-open');
  await view.action('credits-confirm');
  assert.equal(seen.length, before);
  assert.doesNotMatch(view.render(), /data-action="credits-confirm"|支付二维码/);
});

test('purchase retry survives restart with same account intent and local QR only', async () => {
  const store = storage(); let failed = false;
  const first = setup({ storage: store, request: async action => {
    if (action === 'wallet.createOrder' && !failed) { failed = true; throw new Error('NETWORK_ERROR'); }
  } });
  await first.view.refresh(); await first.view.action('credits-buy', { amount: '10000' }); await first.view.action('credits-confirm');
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
  await first.view.refresh(); await first.view.action('credits-buy', { amount: '10000' }); await first.view.action('credits-confirm');
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
  await view.action('credits-buy', { amount: '5000' }); await view.action('credits-confirm');
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
});

test('expired payment material is hidden and request IDs remain visible', async () => {
  const old = setup({ now: () => Date.parse('2026-10-18T02:16:00Z') });
  await old.view.refresh(); await old.view.action('credits-buy', { amount: '10000' }); await old.view.action('credits-confirm');
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
  await first.view.refresh(); await first.view.action('credits-buy', { amount: '10000' }); await first.view.action('credits-confirm');
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
  await view.action('credits-buy', { amount: '10000' }); await view.action('credits-confirm');
  const html = view.render();
  assert.match(html, /待核对/);
  assert.match(html, /已支付/);
  assert.match(html, /已到账/);
  assert.doesNotMatch(html, /data:image|provider-pay:private-payload/);
});

test('wallet displays authoritative balances without promising undesigned consumption rules', async () => {
  for (const [atoms, slot, expected] of [
    ['0', 'none', '0.00 点'],
    ['-1000000', 'none', '-1.00 点'],
    ['1000000', 'held', '1.00 点'],
  ]) {
    const { view, seen } = setup({ request: action => action === 'wallet.balance' ? envelope({
      ...balance, balance_credit_atoms: atoms, debt_credit_atoms: atoms.startsWith('-') ? '1000000' : '0', execution_slot_state: slot,
    }) : undefined });
    await view.refresh();
    assert.match(view.render(), /积分归当前万象账号所有，跨设备共享/);
    assert.doesNotMatch(view.render(), /Provider|BYOK|欠款|消耗积分|模型服务/);
    assert.equal(view.label(), expected);
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
  await first.view.refresh(); await first.view.action('credits-buy', { amount: '5000' }); await first.view.action('credits-confirm');
  await first.view.action('credits-close-order');
  assert.match(first.view.render(), /关闭确认中/);
  assert.doesNotMatch(first.view.render(), /支付二维码/);
  const restarted = setup(options);
  await restarted.view.refresh(); await restarted.view.action('credits-open');
  assert.equal(restarted.seen.some(([action]) => action === 'wallet.createOrder'), false);
  closed = true;
  await restarted.view.refresh(); await restarted.view.action('credits-open');
  assert.match(restarted.view.render(), /已关闭/);
  await restarted.view.action('credits-reselect');
  await restarted.view.action('credits-buy', { amount: '10000' }); await restarted.view.action('credits-confirm');
  const oldIntent = first.seen.find(([action]) => action === 'wallet.createOrder')[1];
  const newIntent = restarted.seen.find(([action]) => action === 'wallet.createOrder')[1];
  assert.notEqual(oldIntent.purchase_intent_id, newIntent.purchase_intent_id);
  assert.equal(newIntent.amount_fen, 10000);
  assert.match(restarted.view.render(), /付款码已到期/);
  assert.doesNotMatch(restarted.view.render(), /data-action="credits-buy"/);
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
  await view.action('credits-buy', { amount: '10000' }); await view.action('credits-confirm');
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
  await view.refresh(); await view.action('credits-buy', { amount: '10000' }); await view.action('credits-confirm');
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
  await view.action('credits-buy', { amount: '10000' }); await view.action('credits-confirm');
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
  offline = false; await view.refresh();
  await view.action('credits-buy', { amount: '10000' }); await view.action('credits-confirm');
  assert.match(view.render(), /支付二维码/);
});

test('payment confirmation and fulfillment are distinct and neither permits a second payment', async () => {
  let value = order;
  const { view, seen } = setup({ request: action => action === 'wallet.order' ? envelope(value) : undefined });
  await view.refresh(); await view.action('credits-buy', { amount: '10000' }); await view.action('credits-confirm');
  await view.action('credits-buy', { amount: '10000' }); await view.action('credits-confirm');
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
  await view.action('credits-buy', { amount: '10000' });
  const purchase = view.action('credits-confirm');
  assert.match(view.render(), /正在生成付款码/);
  await view.action('credits-dismiss'); await view.action('credits-open');
  await view.action('credits-buy', { amount: '10000' }); await view.action('credits-confirm');
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
  await view.refresh(); await view.action('credits-buy', { amount: '10000' }); await view.action('credits-confirm');
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
  await view.refresh(); await view.action('credits-buy', { amount: '10000' }); await view.action('credits-confirm');
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
  await first.view.action('credits-buy', { amount: 'penny' }); await first.view.action('credits-confirm');
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
  await view.refresh(); await view.action('credits-buy', { amount: 'penny' }); await view.action('credits-confirm');
  assert.match(view.render(), /商品已调整/);
  await view.action('credits-buy', { amount: 'penny' }); await view.action('credits-confirm');
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


test('closing a recovered configurable-price order survives a lost response and restart', async () => {
  const store = storage();
  const recovered = { ...order, amount_fen: 1 };
  const first = setup({ storage: store, request: async action => {
    if (action === 'wallet.orders') return envelope({ items: [recovered], next_cursor: null });
    if (action === 'wallet.closeOrder') throw new Error('NETWORK_ERROR');
  } });
  await first.view.refresh();
  assert.ok(first.view.paymentImage());
  await first.view.action('credits-close-order');
  assert.equal(first.view.paymentImage(), null);
  const closeRequest = first.seen.find(([action]) => action === 'wallet.closeOrder')[1];
  const restarted = setup({ storage: store, request: async action => {
    if (action === 'wallet.closeOrder') return envelope({ ...recovered,
      display_state: 'close_pending', payment_state: 'close_pending', payment_action: null });
  } });
  await restarted.view.refresh();
  assert.deepEqual(restarted.seen.find(([action]) => action === 'wallet.closeOrder')[1], closeRequest);
  assert.equal(restarted.view.paymentImage(), null);
  assert.equal(restarted.seen.some(([action]) => action === 'wallet.createOrder'), false);
});

const remoteWallet = { view_version: '2', account_id: 'alice', currency_rule_id: 'usd-credit-100-v2', credit_scale: 6,
  balance_credit_atoms: '199999999940', spent_credit_atoms: '60', correction_credit_atoms: '0', net_spent_credit_atoms: '60',
  remote_sequence: '2', sync_state: 'synced', synced_at: '2026-10-18T02:00:00Z', pending_executions: 1 };
const remotePage = (items = []) => ({ view_version: '2', account_id: 'alice', currency_rule_id: 'usd-credit-100-v2',
  credit_scale: 6, remote_sequence: '2', items, next_before_sequence: null });

test('QeeToken wallet displays rounded balance, tiny consumption and server timezone with escaped metadata', async () => {
  const { view } = setup({ request: async action => {
    if (action === 'wallet.balance') return envelope({ ...balance, billing_backend: 'qeetoken' });
    if (action === 'wallet.wallet') return envelope(remoteWallet);
    if (action === 'wallet.usage') return envelope(remotePage([{ event_id: 'event', account_sequence: '2', debit_credit_atoms: '60',
      occurred_at: '2026-10-18T02:00:00Z', device_id: '<script>box</script>', model: 'model-x' }]));
  } });
  await view.refresh();
  const html = view.render();
  assert.match(html, /class="credits-total">200,000\.00<span>/);
  assert.doesNotMatch(html, /USD|tokens?|\$/i); assert.match(html, /消耗不足 0\.01 积分/);
  assert.match(html, /10:00:00/); assert.match(html, /1 笔调用正在结算/);
  assert.match(html, /&lt;script&gt;box/); assert.doesNotMatch(html, /<script>/);
});

test('QeeToken initialization remains unknown and a stale wallet is labelled explicitly', async () => {
  let pending = true;
  const { view } = setup({ request: async action => {
    if (action === 'wallet.balance') return envelope({ ...balance, billing_backend: 'qeetoken' });
    if (action === 'wallet.wallet') return envelope(pending ? { ...remoteWallet, balance_credit_atoms: null, spent_credit_atoms: null, correction_credit_atoms: null, net_spent_credit_atoms: null, sync_state: 'pending', synced_at: null } : { ...remoteWallet, sync_state: 'stale' });
    if (action === 'wallet.usage') return envelope(remotePage());
  } });
  await view.refresh(); assert.match(view.render(), /余额初始化中/); assert.doesNotMatch(view.label(), /0\.00/);
  pending = false; await view.refresh(); assert.match(view.render(), /显示上次同步余额/);
});

test('account switch discards in-flight QeeToken wallet and consumption', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { view, seen } = setup({ request: async action => {
    if (action === 'wallet.balance') return envelope({ ...balance, billing_backend: 'qeetoken' });
    if (action === 'wallet.wallet') { await waiting; return envelope(remoteWallet); }
    if (action === 'wallet.usage') return envelope(remotePage());
  } });
  const refresh = view.refresh();
  while (!seen.some(([action]) => action === 'wallet.wallet')) await new Promise(resolve => setImmediate(resolve));
  view.reset(JSON.stringify(['bob', 'client-2'])); release(); await refresh;
  assert.doesNotMatch(view.render(), /1999\.99999940|余额已同步/);
});

test('registration status shows the explicit new denomination without changing wallet totals or adding a claim action', async () => {
  let state = 'queued';
  const registration = () => ({ eligibility: 'new_account', grant_rule_id: 'registration-500-v1', state,
    credit_display: { currency_rule_id: 'usd-credit-100-v2', credit_scale: 6, grant_credit_atoms: '500000000' } });
  const { view, seen } = setup({ request: action => {
    if (action === 'wallet.balance') return envelope({ ...balance, billing_backend: 'qeetoken' });
    if (action === 'wallet.wallet') return envelope({ ...remoteWallet, registration_grant: registration() });
    if (action === 'wallet.usage') return envelope(remotePage());
  } });
  await view.refresh(); await view.action('credits-open');
  assert.match(view.render(), /注册赠送待到账 · 500\.00 新积分/);
  state = 'credited'; await view.refresh();
  assert.match(view.render(), /注册赠送已到账 · 500\.00 新积分/);
  assert.doesNotMatch(view.render(), /USD|tokens?|\$/i);
  assert.equal(seen.some(([action]) => /grant|claim/i.test(action)), false);
  state = 'unknown'; await view.refresh();
  assert.match(view.render(), /积分响应无法校验/);
});

test('v2 refresh keeps the last confirmed value on pending or older responses and rejects mixed account pages', async () => {
  let wallet = remoteWallet, page = remotePage();
  const { view } = setup({ request: action => {
    if (action === 'wallet.balance') return envelope({ ...balance, billing_backend: 'qeetoken' });
    if (action === 'wallet.wallet') return envelope(wallet);
    if (action === 'wallet.usage') return envelope(page);
  } });
  await view.refresh();
  for (const state of ['pending', 'older', 'wrong-account']) {
    wallet = state === 'pending' ? { ...remoteWallet, sync_state: 'pending', remote_sequence: '0', balance_credit_atoms: null,
      spent_credit_atoms: null, correction_credit_atoms: null, net_spent_credit_atoms: null } :
      state === 'older' ? { ...remoteWallet, remote_sequence: '1', balance_credit_atoms: '0' } : remoteWallet;
    page = state === 'wrong-account' ? { ...remotePage(), account_id: 'bob' } :
      state === 'older' ? { ...remotePage(), remote_sequence: '1' } : remotePage();
    await view.refresh();
    assert.match(view.render(), /200,000\.00/);
    if (state === 'pending') assert.match(view.render(), /显示上次同步余额/);
    assert.doesNotMatch(view.render(), /credits-total">0\.00/);
  }
  assert.match(view.render(), /无法校验/);
});

test('refresh invalidates an older in-flight usage page even when the cursor happens to match', async () => {
  let finish;
  const item = sequence => ({ event_id: `e${sequence}`, account_sequence: sequence, debit_credit_atoms: '1000000',
    occurred_at: remoteWallet.synced_at, device_id: 'box', model: 'model' });
  const first = { ...remotePage([item('2')]), next_before_sequence: '2' };
  const { view } = setup({ request: (action, input) => {
    if (action === 'wallet.balance') return envelope({ ...balance, billing_backend: 'qeetoken' });
    if (action === 'wallet.wallet') return envelope(remoteWallet);
    if (action === 'wallet.usage') return input.before_sequence ? new Promise(resolve => { finish = resolve; }) : envelope(first);
  } });
  await view.refresh();
  const old = view.action('credits-usage-more');
  await view.refresh();
  finish(envelope(remotePage([item('1')])));
  await old;
  assert.equal((view.render().match(/>model</g) || []).length, 1);
});

// The server commits a new snapshot while the first read is in flight.
test('v2 refresh reads usage before wallet to avoid independent snapshot races', async () => {
  let sequence = '2';
  const { view } = setup({ request: async action => {
    if (action === 'wallet.balance') return envelope({ ...balance, billing_backend: 'qeetoken' });
    if (action === 'wallet.wallet') return envelope({ ...remoteWallet, remote_sequence: sequence });
    if (action === 'wallet.usage') {
      await Promise.resolve();
      sequence = '3';
      return envelope({ ...remotePage(), remote_sequence: sequence });
    }
  } });
  await view.refresh();
  assert.match(view.render(), /200,000\.00/);
  assert.doesNotMatch(view.render(), /无法校验/);
});

test('custom recharge uses a server quote and persists the exact v2 intent across restart', async () => {
  const store = storage();
  const catalog = { view_version: '2', currency_rule_id: 'usd-credit-100-v2', recharge_enabled: true,
    payment_channels: ['alipay'], products: [{ product_id: 'wanx-v2-10', version: '2', amount_fen: 1000, grant_credit_atoms: '1000000000' }],
    custom_amount: { min_fen: 1000, max_fen: 100000, step_fen: 100 } };
  const request = (action, input) => {
    if (action === 'wallet.catalog') return envelope(catalog);
    if (action === 'wallet.quote') return envelope({ view_version: '2', currency_rule_id: 'usd-credit-100-v2', credit_scale: 6,
      rule_id: 'wanx-recharge-100-v2', amount_fen: input.amount_fen, grant_credit_atoms: '1100000000' });
    if (action === 'wallet.createOrder') throw new Error('NETWORK_ERROR');
  };
  const first = setup({ storage: store, request });
  await first.view.refresh(); await first.view.action('credits-open');
  assert.match(first.view.render(), /自定义金额/);
  for (const amount of ['9', '1001', '10.50', '1e2']) {
    await first.view.action('credits-quote', { amount });
    assert.equal(first.seen.some(([action]) => action === 'wallet.quote'), false);
  }
  await first.view.action('credits-quote', { amount: '11' });
  assert.match(first.view.render(), /1,100\.00/);
  await first.view.action('credits-custom-buy');
  assert.equal(first.seen.some(([action]) => action === 'wallet.createOrder'), false);
  await first.view.action('credits-custom-change', { amount: '12' });
  await first.view.action('credits-confirm');
  assert.equal(first.seen.some(([action]) => action === 'wallet.createOrder'), false, 'editing the amount invalidates its quote');
  await first.view.action('credits-quote', { amount: '11' });
  await first.view.action('credits-custom-buy'); await first.view.action('credits-confirm');
  const saved = JSON.parse(store.getItem('wanx.credit.purchase.v1:alice'));
  assert.equal(saved.amount_fen, 1100);
  assert.equal(saved.currency_rule_id, 'usd-credit-100-v2');
  assert.equal('grant_credit_atoms' in saved, false);
  const restarted = setup({ storage: store, request });
  await restarted.view.refresh();
  assert.deepEqual(restarted.seen.find(([name]) => name === 'wallet.createOrder')[1], first.seen.find(([name]) => name === 'wallet.createOrder')[1]);
});


test('an uncreated legacy intent rejected by the upgrade gate releases purchase recovery', async () => {
  const store = storage();
  store.setItem('wanx.credit.purchase.v1:alice', JSON.stringify({ purchase_intent_id: 'legacy-intent', amount_fen: 5000 }));
  const { view, seen } = setup({ storage: store, request: action => {
    if (action === 'wallet.createOrder') throw Object.assign(new Error('upgrade'), { code: 'UNSUPPORTED_SCHEMA' });
  } });
  await view.refresh();
  assert.equal(store.getItem('wanx.credit.purchase.v1:alice'), null);
  await view.refresh(); await view.action('credits-open');
  assert.equal(seen.filter(([action]) => action === 'wallet.createOrder').length, 1);
  assert.doesNotMatch(view.render(), /data-action="credits-buy"[^>]*disabled/);
});

test('approved historical registration gift displays the original pending and credited intent without a claim button', async () => {
  let state = 'queued';
  const { view, seen } = setup({ request: action => {
    if (action === 'wallet.balance') return envelope({ ...balance, billing_backend: 'qeetoken' });
    if (action === 'wallet.wallet') return envelope({ ...remoteWallet, registration_grant: {
      eligibility: 'history_unclaimed', state, grant_rule_id: 'registration-500-v1',
      credit_display: state === 'waiting_migration' ? null : { currency_rule_id:'usd-credit-100-v2', credit_scale:6, grant_credit_atoms:'500000000' },
    } });
    if (action === 'wallet.usage') return envelope(remotePage());
  } });
  for (const [next, label] of [['queued','注册赠送待到账'],['retry_wait','注册赠送正在重试'],['credited','注册赠送已到账']]) {
    state = next; await view.refresh();
    assert.match(view.render(), new RegExp(label + ' · 500\\.00 新积分'));
    assert.doesNotMatch(view.render(), /积分响应无法校验|USD|tokens?|\$/i);
  }
  state = 'waiting_migration'; await view.refresh();
  assert.match(view.render(), /注册赠送资格已核实，等待处理/);
  assert.equal(seen.some(([action]) => /grant|claim/i.test(action)), false);
});
