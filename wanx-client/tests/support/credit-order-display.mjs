// Receives a real Admin OrderView from the isolated cross-service test.
import assert from 'node:assert/strict';
import { decodeCreditEnvelope } from '../../account/credit-wallet.mjs';
import { createWalletView } from '../../local-ui/renderer/wallet-view.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const envelope = decodeCreditEnvelope(JSON.parse(input), 200);
const order = envelope.data;
const saved = new Map([['wanx.credit.purchase.v1:alice', JSON.stringify({
  purchase_intent_id: order.purchase_intent_id, order_id: order.order_id, amount_fen: order.amount_fen,
})]]);
const requests = [];
const view = createWalletView({
  request: async action => {
    requests.push(action);
    if (action === 'wallet.order') return envelope;
    // Recovery must work even while the wallet is unavailable during cutover.
    throw new Error('QEETOKEN_SYNC_PENDING');
  },
  changed() {}, schedule: () => null, cancel() {},
  storage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key) },
});
view.reset(JSON.stringify(['alice', 'cross-service-client']));
await view.refresh();
await view.action('credits-open');
assert.equal(order.grant_credit_atoms, '20000000');
assert.equal(order.credit_display.currency_rule_id, 'usd-credit-100-v2');
assert.match(view.render(), /2,000 点积分已记入当前账号/);
assert.doesNotMatch(view.render(), /20 点积分已记入当前账号/);
assert.equal(requests.includes('wallet.createOrder'), false);
assert.equal(saved.size, 0);
process.stdout.write('old order: 20 original credits -> 2000 displayed credits; original intent recovered\n');
