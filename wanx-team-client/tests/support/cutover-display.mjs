// Real TB09 Admin HTTP responses: original intent remains recoverable through cutover.
import assert from 'node:assert/strict';
import { decodeCreditEnvelope } from '../../account/credit-wallet.mjs';
import { createWalletView } from '../../local-ui/renderer/wallet-view.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const values = JSON.parse(input);
for (const envelope of Object.values(values)) decodeCreditEnvelope(envelope, 200);
const account = values.wallet.data.account_id, order = values.pending.data;
const key = `wanx.credit.purchase.v1:${account}`;
const saved = new Map([[key, JSON.stringify({ purchase_intent_id: order.purchase_intent_id, order_id: order.order_id, amount_fen: order.amount_fen })]]);
const seen = [];
let complete = false;
const wrap = data => ({ schema_version:'1', request_id:'cutover-display', data });
const view = createWalletView({
  request: async action => {
    seen.push(action);
    if (action === 'wallet.order') return complete ? values.paid : values.pending;
    if (action === 'wallet.wallet') return complete ? values.wallet : values.pending_wallet;
    if (action === 'wallet.catalog') return wrap({ recharge_enabled:false, timezone:'Asia/Shanghai', tiers:[] });
    if (action === 'wallet.balance') return wrap({ billing_backend:'qeetoken', balance_credit_atoms:'0', debt_credit_atoms:'0', ledger_sequence:3 });
    if (action === 'wallet.usage') return wrap({ view_version:'2',account_id:account,currency_rule_id:'usd-credit-100-v2',credit_scale:6,remote_sequence:complete?'3':'1',items:[],next_before_sequence:null });
    if (action === 'wallet.orders') return wrap({ items:[complete ? values.paid.data : order] });
    throw new Error(action);
  },
  changed() {}, schedule:()=>null, cancel() {},
  storage:{ getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k) },
});
view.reset(JSON.stringify([account,'cutover-client']));
await view.refresh();
await view.action('credits-open');
assert.match(view.render(), /支付成功，积分到账中/);
assert.match(view.render(), /2,000/);
assert.doesNotMatch(view.render(), /4,500|点积分已记入当前账号/);
assert.ok(saved.has(key));
complete = true;
await view.refresh();
assert.match(view.render(), /4,500/);
assert.match(view.render(), /2,000 点积分已记入当前账号/);
assert.match(view.render(), /注册赠送已到账 · 500 新积分/);
assert.doesNotMatch(view.render(), /USD|tokens?|无法校验/i);
assert.equal(saved.size,0);
assert.equal(seen.some(action=>/createOrder|closeOrder|claim/i.test(action)),false);
process.stdout.write('pending preserved 2000; original 20-credit order -> 2000; final balance 4500 and registration 500; no new intent\n');
