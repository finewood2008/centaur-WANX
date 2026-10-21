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

test('product and channel choices remain drafts until explicit payment confirmation', async () => {
  const store = storage();
  const { view, seen } = setup({ storage: store, request: (action, input) => {
    if (action === 'wallet.catalog') return envelope({ recharge_enabled: true, payment_channels: ['alipay', 'wechat'],
      products: [1, 100, 200].map(value => ({ product_id: `product-${value}`, version: 'v1',
        name: `${value}元积分`, amount_fen: value * 100, grant_credit_atoms: String(value * 100000000) })) });
    if (action === 'wallet.createOrder') return envelope({ ...order, product_id: input.product_id,
      payment_channel: input.payment_channel, amount_fen: 20000, grant_credit_atoms: '20000000000' });
  } });
  await view.refresh(); await view.action('credits-open');
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
  assert.match(view.render(), /data-action="credits-pay"/);
  for (const value of [100, 1, 200]) {
    await view.action('credits-buy', { amount: `product-${value}` });
    assert.match(view.render(), new RegExp(`data-amount="product-${value}" aria-pressed="true"`));
    assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
    assert.equal(store.getItem('wanx.credit.purchase.v1:alice'), null);
  }
  await view.action('credits-channel', { channel: 'wechat' });
  await view.action('credits-channel', { channel: 'alipay' });
  await view.action('credits-channel', { channel: 'wechat' });
  assert.match(view.render(), /data-channel="wechat" aria-pressed="true"/);
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
  await view.action('credits-dismiss'); await view.action('credits-open');
  assert.match(view.render(), /data-amount="product-200" aria-pressed="true"/);
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
  await view.action('credits-pay'); await view.action('credits-pay');
  const creates = seen.filter(([action]) => action === 'wallet.createOrder');
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0][1], { purchase_intent_id: 'intent-1', product_id: 'product-200',
    product_version: 'v1', payment_channel: 'wechat' });
  assert.match(view.render(), /data-amount="product-200" aria-pressed="true"/);
});

test('background balance refresh permits draft edits and payment after active order recovery', async () => {
  let delayBalance = false, resolve;
  const { view, seen } = setup({ request: action => {
    if (action === 'wallet.catalog') return envelope({ recharge_enabled: true, payment_channels: ['alipay', 'wechat'],
      tiers: [{ amount_fen: 5000, grant_credit_atoms: '1000000000' }, { amount_fen: 10000, grant_credit_atoms: '2000000000' }] });
    if (action === 'wallet.balance' && delayBalance) return new Promise(done => { resolve = done; });
  } });
  await view.refresh(); await view.action('credits-open');
  await view.action('credits-buy', { amount: '10000' });
  delayBalance = true;
  const refresh = view.refresh();
  while (!resolve) await new Promise(done => setImmediate(done));
  await view.action('credits-buy', { amount: '5000' });
  await view.action('credits-channel', { channel: 'wechat' });
  const html = view.render();
  await view.action('credits-pay');
  const createsBeforeBalance = seen.filter(([action]) => action === 'wallet.createOrder');
  resolve(envelope(balance)); await refresh;
  assert.match(html, /data-amount="5000" aria-pressed="true"(?![^>]*disabled)/);
  assert.match(html, /data-channel="wechat" aria-pressed="true"(?![^>]*disabled)/);
  assert.equal(createsBeforeBalance.length, 1);
  await view.action('credits-pay');
  assert.deepEqual(seen.find(([action]) => action === 'wallet.createOrder')[1],
    { purchase_intent_id: 'intent-1', amount_fen: 5000, payment_channel: 'wechat' });
});

test('automatic polling leaves an unchanged purchase draft visually stable', async () => {
  const frames = []; let poll;
  const { view, seen } = setup({ changed: () => frames.push(view.render()),
    schedule: callback => { poll = callback; return null; } });
  await view.refresh(); await view.action('credits-open'); await view.action('credits-buy', { amount: '10000' });
  const before = view.render(); frames.length = 0;
  poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames.every(html => html === before), true, 'background recovery must not flash a disabled pay button');
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
});

test('automatic pending order polling keeps payment controls stable and still reports a paid transition', async () => {
  const frames = []; let poll, current = order;
  const { view } = setup({ changed: () => frames.push(view.render()),
    schedule: (callback, delay) => { if (delay === 5000) poll = callback; return null; },
    request: action => {
      if (action === 'wallet.orders') return envelope({ items: [current] });
      if (action === 'wallet.order') return envelope(current);
    } });
  await view.refresh(); await view.action('credits-open');
  const before = view.render(); frames.length = 0;
  poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames.every(html => html === before), true, 'automatic status reads must not flash busy or disabled controls');
  assert.match(view.render(), /支付二维码/);
  frames.length = 0;
  current = { ...order, payment_state: 'paid', display_state: 'paid_pending', fulfillment_state: 'pending', payment_action: null };
  poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames.some(html => html.includes('支付成功，积分到账中')), true);
  assert.doesNotMatch(view.render(), /支付二维码/);
});

test('automatic QeeToken polling updates sync time and retains an unchanged failure notice during retry', async () => {
  const frames = []; let poll, unavailable = false, syncedAt = remoteWallet.synced_at;
  const { view } = setup({ changed: () => frames.push(view.render()),
    schedule: (callback, delay) => { if (delay === 5000 || delay === 30000) poll = callback; return null; },
    request: action => {
      if (action === 'wallet.balance') return envelope({ ...balance, billing_backend: 'qeetoken' });
      if (action === 'wallet.wallet') {
        if (unavailable) throw new Error('QEETOKEN_UNAVAILABLE');
        return envelope({ ...remoteWallet, synced_at: syncedAt });
      }
      if (action === 'wallet.usage') return envelope({ items: [], next_before_sequence: null });
    } });
  await view.refresh();
  const before = view.render(); frames.length = 0;
  syncedAt = '2026-10-18T02:00:05Z';
  poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames.some(html => html.includes('10:00:05')), true, 'real sync time changes must still notify');
  assert.equal(before.replace('10:00:00', 'SYNC_TIME'), view.render().replace('10:00:05', 'SYNC_TIME'));
  unavailable = true;
  poll(); await new Promise(resolve => setImmediate(resolve));
  assert.match(view.render(), /余额服务暂不可用/);
  frames.length = 0;
  poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames.every(html => html.includes('余额服务暂不可用')), true, 'a background retry must not clear the visible failure before success');
});

test('automatic polling keeps an initializing wallet label stable until its balance arrives', async () => {
  const labels = []; let poll, pending = true;
  const { view } = setup({ changed: () => labels.push(view.label()),
    schedule: (callback, delay) => { if (delay === 5000) poll = callback; return null; },
    request: action => {
      if (action === 'wallet.balance') return envelope({ ...balance, billing_backend: 'qeetoken' });
      if (action === 'wallet.wallet') return envelope(pending
        ? { ...remoteWallet, balance_credit_atoms: null, balance_usd_atoms: null, spent_usd_atoms: null,
          sync_state: 'pending', synced_at: null }
        : { ...remoteWallet, balance_credit_atoms: '0', balance_usd_atoms: '0', spent_usd_atoms: '0' });
      if (action === 'wallet.usage') return envelope({ items: [], next_before_sequence: null });
    } });
  await view.refresh();
  const before = view.label(); labels.length = 0;
  poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(labels.every(label => label === before), true, 'background polling must not flash the initializing balance label');
  pending = false; labels.length = 0;
  poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.label(), '0.00 点');
  assert.equal(labels.includes('0.00 点'), true, 'a real initialized balance must still notify');
});

test('manual payment refresh still shows its busy state until the requested read completes', async () => {
  let delayOrder = false, resolveOrder;
  const { view } = setup({ request: action => {
    if (action === 'wallet.orders') return envelope({ items: [order] });
    if (action === 'wallet.order' && delayOrder) return new Promise(resolve => { resolveOrder = resolve; });
  } });
  await view.refresh(); await view.action('credits-open'); delayOrder = true;
  const refresh = view.action('credits-refresh');
  while (!resolveOrder) await new Promise(resolve => setImmediate(resolve));
  try {
    assert.match(view.render(), /正在确认…/);
    assert.match(view.render(), /data-action="credits-refresh"[^>]*disabled/);
  } finally { resolveOrder(envelope(order)); await refresh; }
  assert.doesNotMatch(view.render(), /正在确认…/);
});

for (const recovered of ['empty', 'existing', 'account-switched']) {
  test(`payment waits for background recovery and handles ${recovered} without a duplicate order`, async () => {
    let delayRecovery = false, resolveRecovery;
    const { view, seen } = setup({ request: action => {
      if (action === 'wallet.orders' && delayRecovery) return new Promise(resolve => { resolveRecovery = resolve; });
    } });
    await view.refresh(); await view.action('credits-open'); await view.action('credits-buy', { amount: '10000' });
    delayRecovery = true;
    const refresh = view.refresh({ background: true });
    while (!resolveRecovery) await new Promise(resolve => setImmediate(resolve));
    let finished = 0;
    const payments = [view.action('credits-pay'), view.action('credits-pay')].map(promise => promise.then(() => { finished++; }));
    await new Promise(resolve => setImmediate(resolve));
    const finishedBeforeRecovery = finished;
    assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
    if (recovered === 'account-switched') view.reset(JSON.stringify(['bob', 'client-2']));
    resolveRecovery(envelope({ items: recovered === 'existing' ? [order] : [] }));
    await refresh; await Promise.all(payments);
    assert.equal(finishedBeforeRecovery, 0, 'pay must wait rather than silently discard a click during recovery');
    assert.equal(seen.filter(([action]) => action === 'wallet.createOrder').length, recovered === 'empty' ? 1 : 0);
    if (recovered === 'existing') assert.match(view.render(), /支付二维码/);
    if (recovered === 'account-switched') assert.doesNotMatch(view.render(), /role="dialog"|支付二维码/);
  });
}

test('waiting payment confirmation freezes the clicked product version and channel', async () => {
  let delayRecovery = false, resolveRecovery, version = 'v1';
  const { view, seen } = setup({ request: action => {
    if (action === 'wallet.orders' && delayRecovery) return new Promise(resolve => { resolveRecovery = resolve; });
    if (action === 'wallet.catalog') return envelope({ recharge_enabled: true, payment_channels: ['alipay', 'wechat'],
      products: [100, 200].map(value => ({ product_id: `product-${value}`, version,
        amount_fen: value * 100, grant_credit_atoms: String(value * 100000000) })) });
  } });
  await view.refresh(); await view.action('credits-open');
  await view.action('credits-buy', { amount: 'product-100' }); await view.action('credits-channel', { channel: 'wechat' });
  delayRecovery = true;
  const refresh = view.refresh({ background: true });
  while (!resolveRecovery) await new Promise(resolve => setImmediate(resolve));
  const payment = view.action('credits-pay');
  const waiting = view.render();
  await view.action('credits-buy', { amount: 'product-200' });
  await view.action('credits-channel', { channel: 'alipay' });
  const duplicate = view.action('credits-pay');
  version = 'v2';
  resolveRecovery(envelope({ items: [] })); await refresh; await Promise.all([payment, duplicate]);
  const creates = seen.filter(([action]) => action === 'wallet.createOrder');
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0][1], { purchase_intent_id: 'intent-1', product_id: 'product-100',
    product_version: 'v1', payment_channel: 'wechat' });
  assert.match(waiting, /正在确认购买/);
  assert.match(waiting, /data-amount="product-200"[^>]*disabled/);
  assert.match(waiting, /data-channel="alipay"[^>]*disabled/);
});

test('waiting payment confirmation freezes the clicked custom amount rule and channel', async () => {
  let delayRecovery = false, resolveRecovery, ruleVersion = 'cny-100-v1';
  const { view, seen } = setup({ request: action => {
    if (action === 'wallet.orders' && delayRecovery) return new Promise(resolve => { resolveRecovery = resolve; });
    if (action === 'wallet.catalog') return envelope({ recharge_enabled: true, payment_channels: ['alipay', 'wechat'],
      products: [], tiers: [], custom_recharge: { ...customRecharge, version: ruleVersion } });
  } });
  await view.refresh(); await view.action('credits-open'); await view.action('credits-custom');
  await view.action('credits-amount', { value: '12.34' }); await view.action('credits-channel', { channel: 'wechat' });
  delayRecovery = true;
  const refresh = view.refresh({ background: true });
  while (!resolveRecovery) await new Promise(resolve => setImmediate(resolve));
  const payment = view.action('credits-pay');
  const waiting = view.render();
  await view.action('credits-amount', { value: '98.76' });
  await view.action('credits-channel', { channel: 'alipay' });
  const duplicate = view.action('credits-pay');
  ruleVersion = 'cny-100-v2';
  resolveRecovery(envelope({ items: [] })); await refresh; await Promise.all([payment, duplicate]);
  const creates = seen.filter(([action]) => action === 'wallet.createOrder');
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0][1], { purchase_intent_id: 'intent-1', custom_amount_fen: 1234,
    custom_recharge_version: 'cny-100-v1', payment_channel: 'wechat' });
  assert.match(waiting, /正在确认购买/);
  assert.match(waiting, /id="wallet-custom-amount"[^>]*value="12\.34"[^>]*disabled/);
});

test('creating order polls its status after one second without waiting for balance reads', async () => {
  const timers = new Map();
  let current = { ...order, display_state: 'creating', payment_state: 'creating', payment_action: null };
  const { view, seen } = setup({ schedule: (callback, delay) => { timers.set(delay, callback); return delay; },
    cancel: timer => timers.delete(timer), request: action => {
      if (action === 'wallet.createOrder' || action === 'wallet.order') return envelope(current);
    } });
  await view.refresh(); await view.action('credits-buy', { amount: '10000' });
  await view.action('credits-pay');
  assert.match(view.render(), /正在生成付款码/);
  const statusPoll = timers.get(1000);
  assert.equal(typeof statusPoll, 'function');
  const start = seen.length;
  current = { ...order };
  statusPoll(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen.slice(start).map(([action]) => action), ['wallet.order']);
  assert.match(view.render(), /支付二维码/);
  assert.equal(seen.filter(([action]) => action === 'wallet.createOrder').length, 1);
});

test('a late balance failure preserves one-second creating order polling', async () => {
  const timers = new Map();
  let delayBalance = false, rejectBalance;
  let current = { ...order, display_state: 'creating', payment_state: 'creating', payment_action: null };
  const { view, seen } = setup({ schedule: (callback, delay) => { timers.set(delay, callback); return delay; },
    cancel: timer => timers.delete(timer), request: action => {
      if (action === 'wallet.balance' && delayBalance) return new Promise((resolve, reject) => { rejectBalance = reject; });
      if (action === 'wallet.createOrder' || action === 'wallet.order') return envelope(current);
    } });
  await view.refresh(); await view.action('credits-open'); await view.action('credits-buy', { amount: '10000' });
  delayBalance = true;
  const background = view.refresh();
  while (!rejectBalance) await new Promise(resolve => setImmediate(resolve));
  await view.action('credits-pay');
  assert.equal(typeof timers.get(1000), 'function');
  rejectBalance(new Error('QEETOKEN_UNAVAILABLE')); await background;
  assert.match(view.render(), /余额服务暂不可用/);
  assert.equal(typeof timers.get(1000), 'function', 'balance errors must not slow down QR creation checks');
  assert.equal(timers.has(30000), false);
  const start = seen.length;
  current = { ...order };
  timers.get(1000)(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen.slice(start).map(([action]) => action), ['wallet.order']);
  assert.match(view.render(), /支付二维码/);
});

test('a recovered creating order starts polling while the initial balance is still loading', async () => {
  const timers = new Map();
  let resolveBalance;
  const { view, seen } = setup({ schedule: (callback, delay) => { timers.set(delay, callback); return delay; },
    cancel: timer => timers.delete(timer), request: action => {
      if (action === 'wallet.orders') return envelope({ items: [{ ...order, display_state: 'creating',
        payment_state: 'creating', payment_action: null }] });
      if (action === 'wallet.balance') return new Promise(resolve => { resolveBalance = resolve; });
    } });
  const initial = view.refresh();
  while (!resolveBalance) await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(typeof timers.get(1000), 'function');
    timers.get(1000)(); await new Promise(resolve => setImmediate(resolve));
    await view.action('credits-open');
    assert.match(view.render(), /支付二维码/);
    assert.equal(seen.filter(([action]) => action === 'wallet.order').length, 1);
    assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
  } finally { resolveBalance(envelope(balance)); await initial; }
});

test('creating order lookup failure retries only that order after five seconds then resumes fast polling', async () => {
  const timers = new Map();
  let unavailable = true;
  const creating = { ...order, display_state: 'creating', payment_state: 'creating', payment_action: null };
  const { view, seen } = setup({ schedule: (callback, delay) => { timers.set(delay, callback); return delay; },
    cancel: timer => timers.delete(timer), request: action => {
      if (action === 'wallet.createOrder') return envelope(creating);
      if (action === 'wallet.order') {
        if (unavailable) throw new Error('NETWORK_ERROR');
        return envelope(creating);
      }
    } });
  await view.refresh(); await view.action('credits-buy', { amount: '10000' }); await view.action('credits-pay');
  const initialPoll = timers.get(1000); timers.delete(1000);
  initialPoll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof timers.get(5000), 'function', 'order lookup failures should back off to five seconds');
  assert.equal(timers.has(30000), false);
  unavailable = false;
  const start = seen.length, retry = timers.get(5000); timers.delete(5000);
  retry(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen.slice(start).map(([action]) => action), ['wallet.order']);
  assert.equal(typeof timers.get(1000), 'function', 'successful order reads should restore fast creation polling');
  assert.equal(seen.filter(([action]) => action === 'wallet.createOrder').length, 1);
});

test('status polling reuses the same QR image without re-encoding an unchanged payload', async () => {
  let encodes = 0;
  const { view } = setup({ qr: async () => { encodes++; return 'data:image/png;base64,local'; },
    request: action => action === 'wallet.order' ? envelope({ ...order, payment_action: { ...order.payment_action } }) : undefined });
  await view.refresh(); await view.action('credits-buy', { amount: '10000' }); await view.action('credits-pay');
  assert.equal(encodes, 1);
  await view.refresh(); await view.refresh();
  assert.equal(encodes, 1);
  assert.match(view.render(), /支付二维码/);
});

const customRecharge = { enabled: true, version: 'cny-100-v1', min_amount_fen: 1,
  max_amount_fen: 10000000000, points_per_yuan: '100' };

test('custom yuan amount previews 100 points per yuan and submits only after confirmation', async () => {
  const store = storage();
  const { view, seen } = setup({ storage: store, request: (action, input) => {
    if (action === 'wallet.catalog') return envelope({ recharge_enabled: true, payment_channels: ['alipay', 'wechat'],
      products: [], tiers: [], custom_recharge: customRecharge });
    if (action === 'wallet.createOrder') return envelope({ ...order, amount_fen: input.custom_amount_fen,
      grant_credit_atoms: String(input.custom_amount_fen * 1000000), payment_channel: input.payment_channel });
  } });
  await view.refresh(); await view.action('credits-open'); await view.action('credits-custom');
  await view.action('credits-amount', { value: '1' });
  assert.match(view.render(), /100(?:<\/[^>]+>|\s)*点积分/);
  await view.action('credits-amount', { value: '12.34' });
  assert.match(view.render(), /1,234(?:<\/[^>]+>|\s)*点积分/);
  assert.match(view.render(), /id="wallet-custom-amount"[^>]*value="12\.34"/);
  await view.action('credits-custom');
  assert.match(view.render(), /id="wallet-custom-amount"[^>]*value="12\.34"/);
  await view.action('credits-channel', { channel: 'wechat' });
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
  assert.equal(store.getItem('wanx.credit.purchase.v1:alice'), null);
  await view.action('credits-pay');
  assert.deepEqual(seen.find(([action]) => action === 'wallet.createOrder')[1], {
    purchase_intent_id: 'intent-1', custom_amount_fen: 1234, custom_recharge_version: 'cny-100-v1', payment_channel: 'wechat',
  });
  assert.match(view.render(), /应付 ¥12\.34/);
  assert.match(view.render(), /到账 1,234 点积分/);
});

test('invalid custom amounts never create an order or persist a purchase intent', async () => {
  const store = storage();
  const { view, seen } = setup({ storage: store, request: action => action === 'wallet.catalog' ? envelope({
    recharge_enabled: true, products: [], tiers: [], custom_recharge: customRecharge,
  }) : undefined });
  await view.refresh(); await view.action('credits-open'); await view.action('credits-custom');
  for (const value of ['', '0', '-1', '1.001', 'NaN', '1e2', '100000000.01']) {
    await view.action('credits-amount', { value });
    await view.action('credits-pay');
    assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false, value);
    assert.equal(store.getItem('wanx.credit.purchase.v1:alice'), null, value);
  }
});

test('a lost custom purchase response recovers the same amount version channel and intent after restart', async () => {
  const store = storage();
  const catalog = { recharge_enabled: true, payment_channels: ['alipay', 'wechat'], products: [], tiers: [],
    custom_recharge: customRecharge };
  const first = setup({ storage: store, request: action => {
    if (action === 'wallet.catalog') return envelope(catalog);
    if (action === 'wallet.createOrder') throw new Error('NETWORK_ERROR');
  } });
  await first.view.refresh(); await first.view.action('credits-open'); await first.view.action('credits-custom');
  await first.view.action('credits-amount', { value: '12.34' });
  await first.view.action('credits-channel', { channel: 'wechat' });
  await first.view.action('credits-pay');
  const original = first.seen.find(([action]) => action === 'wallet.createOrder')?.[1];
  assert.deepEqual(original, { purchase_intent_id: 'intent-1', custom_amount_fen: 1234,
    custom_recharge_version: 'cny-100-v1', payment_channel: 'wechat' });
  const restarted = setup({ storage: store, request: action => {
    if (action === 'wallet.catalog') return envelope(catalog);
    if (action === 'wallet.createOrder') return envelope({ ...order, amount_fen: 1234, grant_credit_atoms: '1234000000',
      payment_channel: 'wechat' });
  } });
  await restarted.view.refresh(); await restarted.view.action('credits-open');
  assert.deepEqual(restarted.seen.find(([action]) => action === 'wallet.createOrder')[1], original);
  assert.match(restarted.view.render(), /到账 1,234 点积分/);
});

test('servers without a custom recharge contract expose an unavailable custom amount choice', async () => {
  const { view, seen } = setup();
  await view.refresh(); await view.action('credits-open');
  assert.match(view.render(), /data-action="credits-custom"[^>]*disabled/);
  assert.match(view.render(), /自定义[\s\S]*暂不可用/);
  await view.action('credits-custom'); await view.action('credits-amount', { value: '12.34' }); await view.action('credits-pay');
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
});

test('Native channel selection is frozen and renders only the selected WeChat QR', async () => {
  const payload = 'weixin://wxpay/bizpayurl?pr=native-test';
  const native = { ...order, payment_channel: 'wechat', payment_action: { ...order.payment_action, payload } };
  const { view, seen } = setup({ request: async action => {
    if (action === 'wallet.catalog') return envelope({ recharge_enabled: true, payment_channels: ['alipay', 'wechat'], tiers: [{ amount_fen: 10000, grant_credit_atoms: '2000000000' }] });
    if (action === 'wallet.createOrder' || action === 'wallet.order') return envelope(native);
  }, qr: async value => { assert.equal(value, payload); return 'data:image/png;base64,local'; } });
  await view.refresh(); await view.action('credits-open');
  await view.action('credits-channel', { channel: 'wechat' });
  await view.action('credits-buy', { amount: '10000' }); await view.action('credits-pay');
  assert.equal(seen.find(([action]) => action === 'wallet.createOrder')[1].payment_channel, 'wechat');
  await view.action('credits-channel', { channel: 'alipay' });
  await view.action('credits-buy', { amount: '10000' }); await view.action('credits-pay');
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
  await first.view.action('credits-buy', { amount: '10000' }); await first.view.action('credits-pay');
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
  await first.view.refresh(); await first.view.action('credits-buy', { amount: '10000' }); await first.view.action('credits-pay');
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
  await first.view.refresh(); await first.view.action('credits-buy', { amount: '10000' }); await first.view.action('credits-pay');
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
  await view.action('credits-buy', { amount: '5000' }); await view.action('credits-pay');
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
});

test('expired payment material is hidden and request IDs remain visible', async () => {
  const old = setup({ now: () => Date.parse('2026-10-18T02:16:00Z') });
  await old.view.refresh(); await old.view.action('credits-buy', { amount: '10000' }); await old.view.action('credits-pay');
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
  await first.view.refresh(); await first.view.action('credits-buy', { amount: '10000' }); await first.view.action('credits-pay');
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
  await view.action('credits-buy', { amount: '10000' });
  await view.action('credits-channel', { channel: 'wechat' });
  await view.action('credits-pay');
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
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
  await view.action('credits-buy', { amount: '10000' }); await view.action('credits-pay');
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
  await first.view.refresh(); await first.view.action('credits-buy', { amount: '5000' }); await first.view.action('credits-pay');
  await first.view.action('credits-close-order');
  assert.match(first.view.render(), /关闭确认中/);
  assert.doesNotMatch(first.view.render(), /支付二维码/);
  const restarted = setup(options);
  await restarted.view.refresh(); await restarted.view.action('credits-open');
  assert.equal(restarted.seen.some(([action]) => action === 'wallet.createOrder'), false);
  closed = true;
  await restarted.view.refresh(); await restarted.view.action('credits-open');
  assert.match(restarted.view.render(), /已关闭/);
  await restarted.view.action('credits-buy', { amount: '10000' }); await restarted.view.action('credits-pay');
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
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
  assert.doesNotMatch(view.render(), /支付二维码/);
  await view.action('credits-pay');
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
  await view.refresh(); await view.action('credits-buy', { amount: '10000' }); await view.action('credits-pay');
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
  await view.action('credits-buy', { amount: '10000' }); await view.action('credits-pay');
  assert.equal(seen.some(([action]) => action === 'wallet.createOrder'), false);
  offline = false; await view.refresh();
  await view.action('credits-buy', { amount: '10000' }); await view.action('credits-pay');
  assert.match(view.render(), /支付二维码/);
});

test('payment confirmation and fulfillment are distinct and neither permits a second payment', async () => {
  let value = order;
  const { view, seen } = setup({ request: action => action === 'wallet.order' ? envelope(value) : undefined });
  await view.refresh(); await view.action('credits-buy', { amount: '10000' }); await view.action('credits-pay');
  await view.action('credits-buy', { amount: '10000' }); await view.action('credits-pay');
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
  const purchase = view.action('credits-pay');
  assert.match(view.render(), /正在生成付款码/);
  await view.action('credits-dismiss'); await view.action('credits-open');
  await view.action('credits-buy', { amount: '10000' }); await view.action('credits-pay');
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
  await view.refresh(); await view.action('credits-buy', { amount: '10000' }); await view.action('credits-pay');
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
  await view.refresh(); await view.action('credits-buy', { amount: '10000' }); await view.action('credits-pay');
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
  await first.view.action('credits-buy', { amount: 'penny' }); await first.view.action('credits-pay');
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
  await view.refresh(); await view.action('credits-buy', { amount: 'penny' }); await view.action('credits-pay');
  assert.match(view.render(), /商品已调整/);
  await view.action('credits-buy', { amount: 'penny' }); await view.action('credits-pay');
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

const remoteWallet = { account_id: 'alice', billing_backend: 'qeetoken', currency_rule_id: 'usd-credit-1-v1',
  usd_per_credit: '1', credit_scale: 6, currency: 'USD', currency_scale: 8,
  balance_credit_atoms: '1999999999', balance_usd_atoms: '199999999940', spent_usd_atoms: '60',
  remote_sequence: '2', sync_state: 'synced', synced_at: '2026-10-18T02:00:00Z', pending_executions: 1 };

test('QeeToken wallet displays exact balance, tiny consumption and server timezone with escaped metadata', async () => {
  const { view } = setup({ request: async action => {
    if (action === 'wallet.balance') return envelope({ ...balance, billing_backend: 'qeetoken' });
    if (action === 'wallet.wallet') return envelope(remoteWallet);
    if (action === 'wallet.usage') return envelope({ items: [{ event_id: 'event', account_sequence: '2', debit_usd_atoms: '60', debit_credit_atoms: '1',
      occurred_at: '2026-10-18T02:00:00Z', device_id: '<script>box</script>', model: 'model-x', input_tokens: 7, output_tokens: 2 }], next_before_sequence: null });
  } });
  await view.refresh();
  const html = view.render();
  assert.match(html, /class="credits-total">1,999\.999999<span>/);
  assert.match(html, /1 USD = 1 积分/); assert.match(html, /1999\.99999940/); assert.match(html, /0\.00000060/);
  assert.match(html, /10:00:00/); assert.match(html, /1 笔调用正在结算/);
  assert.match(html, /&lt;script&gt;box/); assert.doesNotMatch(html, /<script>/);
});

test('QeeToken initialization remains unknown and a stale wallet is labelled explicitly', async () => {
  let pending = true;
  const { view } = setup({ request: async action => {
    if (action === 'wallet.balance') return envelope({ ...balance, billing_backend: 'qeetoken' });
    if (action === 'wallet.wallet') return envelope(pending ? { ...remoteWallet, balance_credit_atoms: null, balance_usd_atoms: null, spent_usd_atoms: null, sync_state: 'pending', synced_at: null } : { ...remoteWallet, sync_state: 'stale' });
    if (action === 'wallet.usage') return envelope({ items: [], next_before_sequence: null });
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
    if (action === 'wallet.usage') return envelope({ items: [], next_before_sequence: null });
  } });
  const refresh = view.refresh();
  while (!seen.some(([action]) => action === 'wallet.wallet')) await new Promise(resolve => setImmediate(resolve));
  view.reset(JSON.stringify(['bob', 'client-2'])); release(); await refresh;
  assert.doesNotMatch(view.render(), /1999\.99999940|余额已同步/);
});
