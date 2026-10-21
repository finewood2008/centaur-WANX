// Actual Go/PostgreSQL → Admin/MySQL HTTP responses enter the production renderer.
import assert from 'node:assert/strict';
import { decodeCreditEnvelope } from '../../account/credit-wallet.mjs';
import { createWalletView } from '../../local-ui/renderer/wallet-view.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const values = JSON.parse(input);
for (const key of ['wallet', 'usage', 'older']) decodeCreditEnvelope(values[key], 200);
const wrap = data => ({ schema_version: '1', request_id: 'v2-render', data });
const view = createWalletView({
  request: async (action, query) => {
    if (action === 'wallet.wallet') return values.wallet;
    if (action === 'wallet.usage') return query.before_sequence ? values.older : values.usage;
    if (action === 'wallet.orders') return wrap({ items: [values.order] });
    if (action === 'wallet.catalog') return wrap({ recharge_enabled: false, timezone: 'Asia/Shanghai', tiers: [] });
    if (action === 'wallet.balance') return wrap({ billing_backend: 'qeetoken', balance_credit_atoms: '0', debt_credit_atoms: '0', ledger_sequence: 4 });
    throw new Error(action);
  },
  changed() {}, schedule: () => null, cancel() {},
  storage: { getItem: () => null, setItem() {}, removeItem() {} },
});
view.reset(JSON.stringify(['alice', 'v2-client']));
await view.refresh();
await view.action('credits-usage-more');
await view.action('credits-open');
const html = view.render();
assert.match(html, /1,499\.94/);
assert.match(html, /累计消耗 0\.06 积分/);
assert.match(html, /1,000\.00 点积分已记入当前账号/);
assert.equal((html.match(/>0\.03</g) || []).length, 2);
assert.doesNotMatch(html, /USD|tokens?|\$|无法校验|1499\.9397/i);
process.stdout.write('v2: balance 1499.94; mixed history 0.03 + 0.03; total 0.06; original paid order 1000.00; no raw currency or tokens\n');
