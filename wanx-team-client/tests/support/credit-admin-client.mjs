// Test-only subprocess: real WANX signing and wallet decoding, injected HTTP.
// The parent owns a disposable Admin/MySQL app; this never uses global fetch.
import { createInterface } from 'node:readline';
import { createAccount } from '../../account/index.mjs';
import { createCreditWallet, formatCreditAtoms } from '../../account/credit-wallet.mjs';
import { createWalletView } from '../../local-ui/renderer/wallet-view.mjs';
import QRCode from 'qrcode';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const input = lines[Symbol.asyncIterator]();
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const read = async () => {
  const next = await input.next();
  return next.done ? null : JSON.parse(next.value);
};
const actions = new Set(['catalog', 'balance', 'orders', 'entries', 'calls', 'summary',
  'order', 'call', 'createOrder', 'closeOrder']);
let account, wallet, view;
const storage = new Map();

async function login(phone, now) {
  view?.reset(null);
  await account?.close();
  let stored = null;
  account = createAccount({
    baseURL: 'https://credits.test',
    store: {
      load: async () => structuredClone(stored),
      save: async value => { stored = structuredClone(value); },
      clear: async () => { stored = null; },
    },
    fetch: async (url, options) => {
      emit({ fetch: { url: String(url), method: options.method, headers: options.headers, body: options.body ?? '' } });
      const reply = await read();
      if (!reply) throw new Error('TEST_PARENT_CLOSED');
      return new Response(reply.body, { status: reply.status, headers: { 'Content-Type': 'application/json' } });
    },
  });
  wallet = createCreditWallet({ request: value => account.request(value) });
  const identity = await account.loginPassword({ phone, password: 'isolated-test-password', remember: false });
  view = createWalletView({
    request: (name, input) => wallet[name.slice('wallet.'.length)](input),
    changed: () => {},
    storage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    now: () => Date.parse(now), schedule: () => null, cancel: () => {},
    qr: payload => QRCode.toDataURL(payload),
  });
  view.reset(JSON.stringify([identity.accountId, identity.clientId]));
  return identity;
}

try {
  emit({ ready: 'credit-admin-client-1' });
  for (let command; (command = await read());) {
    try {
      let result;
      if (command.operation === 'login') result = await login(command.phone, command.now);
      else if (command.operation === 'view' && view) {
        if (command.action) await view.action(command.action, command.dataset);
        else await view.refresh();
        result = { html: view.render(), label: view.label(), payment_image: Boolean(view.paymentImage()) };
      }
      else if (command.operation === 'format') result = formatCreditAtoms(command.atoms);
      else if (command.operation === 'wallet' && wallet && actions.has(command.action)) {
        result = await wallet[command.action](command.input);
      } else throw new Error('TEST_INVALID_OPERATION');
      emit({ result });
    } catch (error) {
      emit({ error: { code: error.code || error.message, status: error.status, request_id: error.request_id } });
    }
  }
} finally {
  await account?.close();
  lines.close();
}
