// Actual TB10 HTTP data, decoded and rendered by the shipping wallet.
import assert from 'node:assert/strict';
import { decodeCreditEnvelope } from '../../account/credit-wallet.mjs';
import { createWalletView } from '../../local-ui/renderer/wallet-view.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const values = JSON.parse(input);
for (const envelope of Object.values(values)) decodeCreditEnvelope(envelope, 200);
const wrap = data => ({ schema_version:'1', request_id:'tb10', data });
const view = createWalletView({
  request: async action => {
    if (action === 'wallet.wallet') return values.wallet;
    if (action === 'wallet.usage') return values.usage;
    if (action === 'wallet.catalog') return wrap({ recharge_enabled:false, timezone:'Asia/Shanghai', tiers:[] });
    if (action === 'wallet.balance') return wrap({ billing_backend:'qeetoken', balance_credit_atoms:'0', debt_credit_atoms:'0', ledger_sequence:6 });
    if (action === 'wallet.orders') return wrap({ items:[] });
    throw new Error(action);
  },
  changed() {}, schedule:()=>null, cancel() {},
});
view.reset(JSON.stringify([values.wallet.data.account_id,'tb10-client']));
await view.refresh();
const html = view.render();
assert.match(html, /975\.00/);
assert.match(html, /495\.00/);
assert.match(html, /10\.00/);
assert.match(html, /注册赠送已到账 · 500\.00 新积分/);
assert.doesNotMatch(html, /USD|tokens?|[$]|无法校验/i);
process.stdout.write('balance 975.00; consumption 495.00 + 3 x 10.00; registration 500.00; no USD/token leakage\n');
