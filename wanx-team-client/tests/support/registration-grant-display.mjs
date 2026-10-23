// Actual Admin wallet response from the Go/PostgreSQL + Admin/MySQL tracer.
import assert from 'node:assert/strict';
import { decodeCreditEnvelope } from '../../account/credit-wallet.mjs';
import { createWalletView } from '../../local-ui/renderer/wallet-view.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const envelope = decodeCreditEnvelope(JSON.parse(input), 200);
const wallet = envelope.data;
const seen = [];
const wrap = data => ({ schema_version: '1', request_id: 'grant-render', data });
const view = createWalletView({
  request: async action => {
    seen.push(action);
    if (action === 'wallet.wallet') return envelope;
    if (action === 'wallet.catalog') return wrap({ recharge_enabled: false, timezone: 'Asia/Shanghai', tiers: [] });
    if (action === 'wallet.balance') return wrap({ billing_backend: 'qeetoken', balance_credit_atoms: '0', debt_credit_atoms: '0', ledger_sequence: 1 });
    if (action === 'wallet.usage') return wrap({ view_version: '2', account_id: wallet.account_id, currency_rule_id: 'usd-credit-100-v2', credit_scale: 6, remote_sequence: wallet.remote_sequence, items: [], next_before_sequence: null });
    if (action === 'wallet.orders') return wrap({ items: [] });
    throw new Error(action);
  },
  changed() {}, schedule: () => null, cancel() {},
  storage: { getItem: () => null, setItem() {}, removeItem() {} },
});
view.reset(JSON.stringify([wallet.account_id, 'cross-service-client']));
await view.refresh();
assert.match(view.render(), /注册赠送已到账 · 500\.00 新积分/);
if (process.argv.includes('--migrated')) {
  assert.match(view.render(), /2,500\.00/);
  assert.doesNotMatch(view.render(), /余额初始化中/);
} else assert.match(view.render(), /余额初始化中/);
assert.doesNotMatch(view.render(), /USD|tokens?|\$/i);
assert.doesNotMatch(view.render(), /积分响应无法校验/);
assert.equal(seen.some(action => /claim|grant/i.test(action)), false);
process.stdout.write(`registration credited: 500.00 new credits; ${process.argv.includes('--migrated') ? 'balance 2500.00 credits' : 'display baseline pending'}; no claim action\n`);
