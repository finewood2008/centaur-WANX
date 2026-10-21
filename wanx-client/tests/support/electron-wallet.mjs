import { app, BrowserWindow } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

let window;
async function verifyWallet() {
try {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const htmlPath = app.getPath('userData') + '/wallet-test.html';
  await writeFile(htmlPath, '<!doctype html><html><body><div id="app"></div></body></html>');
  await window.loadFile(htmlPath);
  const js = source => window.webContents.executeJavaScript(source);
  await js(`
    window.snapshot = { route: 'applications', phase: 'ready', account: { phase: 'authenticated', accountId: 'alice', clientId: 'client-1' }, devices: [], applications: [] };
    window.activeOrder = null; window.nowOffset = 0; window.createCount = 0;
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + nowOffset;
    window.requests = [];
    const realTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => delay === 5000 || delay === 30000 ? (window.walletPoll = callback, 0) : delay > 30000 ? (window.qrExpiry = callback, 1) : realTimeout(callback, delay, ...args);
    window.wanxClient = {
      getLocalState: async () => snapshot,
      onLocalState: listener => { window.publish = listener; },
      action: async (action, input) => {
        requests.push({ action, input });
        let data = { items: [], next_cursor: null };
        if (action === 'wallet.orders') data = { items: activeOrder && !['credited', 'closed'].includes(activeOrder.display_state) ? [activeOrder] : [], next_cursor: null };
        if (action === 'wallet.order') data = activeOrder;
        if (action === 'wallet.catalog') data = { recharge_enabled: true, payment_channels: ['alipay', 'wechat'], timezone: 'Asia/Shanghai', tiers: [], products: [1, 100, 200].map(amount => ({ product_id: 'product-' + amount, version: 'v1', name: '充值商品 ' + amount, enabled: true, amount_fen: amount, grant_credit_atoms: String(amount * 200000) })) };
        if (action === 'wallet.catalog' && window.rechargeV2) data = { view_version: '2', currency_rule_id: 'usd-credit-100-v2', recharge_enabled: true, payment_channels: ['alipay', 'wechat'], timezone: 'Asia/Shanghai', custom_amount: { min_fen: 1000, max_fen: 100000, step_fen: 100 }, products: [10,50,100,200,500].map(yuan => ({product_id: 'v2-'+yuan,version:'2',amount_fen:yuan*100,grant_credit_atoms:String(yuan*100000000),name:yuan+'元充值',enabled:true})) };
        if (action === 'wallet.quote') data = { view_version: '2', currency_rule_id: 'usd-credit-100-v2', credit_scale: 6, rule_id: 'wanx-recharge-100-v2', amount_fen: input.amount_fen, grant_credit_atoms: '1100000000' };
        if (action === 'wallet.balance') data = { balance_credit_atoms: activeOrder?.display_state === 'credited' ? activeOrder.grant_credit_atoms : '0', debt_credit_atoms: '0', ledger_sequence: activeOrder?.display_state === 'credited' ? 1 : 0, execution_slot_state: 'none', pending_call_count: 0 };
        if (action === 'wallet.balance' && window.qeeMode) data.billing_backend = 'qeetoken';
        if (action === 'wallet.wallet') data = { view_version: '2', account_id: snapshot.account.accountId, currency_rule_id: 'usd-credit-100-v2', credit_scale: 6, balance_credit_atoms: '199999999940', spent_credit_atoms: '60', correction_credit_atoms: '0', net_spent_credit_atoms: '60', remote_sequence: '2', sync_state: 'synced', synced_at: '2026-10-19T12:00:00Z', pending_executions: 1 };
        if (action === 'wallet.usage') data = { view_version: '2', account_id: snapshot.account.accountId, currency_rule_id: 'usd-credit-100-v2', credit_scale: 6, remote_sequence: '2', items: [{ event_id: 'e1', account_sequence: '2', debit_credit_atoms: '60', occurred_at: '2026-10-19T12:00:00Z', device_id: '客厅盒子', model: 'test-model' }], next_before_sequence: null };
        if (action === 'wallet.createOrder') {
          if (window.rechargeV2) check(input.currency_rule_id === 'usd-credit-100-v2' && input.amount_fen === 1100 && !('grant_credit_atoms' in input), 'custom purchase must preserve server contract');
          else check(input.product_version === 'v1' && !('amount_fen' in input), 'purchase must use server-owned product price');
          const amountFen = window.rechargeV2 ? input.amount_fen : Number(input.product_id.replace('product-', ''));
          createCount++;
          activeOrder = { payment_channel: input.payment_channel, order_id: 'test-order-' + createCount, purchase_intent_id: input.purchase_intent_id, amount_fen: amountFen,
            grant_credit_atoms: String(amountFen * (window.rechargeV2 ? 1000000 : 200000)), created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(),
            payment_state: 'pending', fulfillment_state: 'not_due', review_state: 'none', display_state: 'pending',
            payment_action: { type: 'qr', payload: input.payment_channel === 'wechat' ? 'weixin://wxpay/bizpayurl?pr=isolated-test-not-payable' : 'isolated-test-not-payable', expires_at: new Date(Date.now() + 60000).toISOString() } };
          if (createCount === 1) await new Promise(resolve => { window.resolveCreate = resolve; });
          data = activeOrder;
        }
        if (action === 'wallet.closeOrder') data = activeOrder = { ...activeOrder, payment_state: activeOrder.payment_state === 'closed' ? 'closed' : 'close_pending', display_state: activeOrder.payment_state === 'closed' ? 'closed' : 'close_pending', payment_action: null };
        return { ok: true, state: snapshot, value: action.startsWith('wallet.') ? { schema_version: '1', request_id: 'req-test', data } : data };
      },
    };
    window.until = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => realTimeout(resolve, 10)); } throw Error('UI timeout: ' + predicate.toString()); };
    window.check = (condition, message) => { if (!condition) throw Error(message); };
    window.button = action => document.querySelector('[data-action="' + action + '"]');
    window.product = amount => document.querySelector('[data-action="credits-buy"][data-amount="' + amount + '"]');
    window.dialog = () => document.querySelector('.wallet-purchase-dialog');
    void 0;
  `);
  const files = ['discovery-selection.js', 'wallet.bundle.js', 'personal-space.js', 'app-catalog.js', 'store-carousel.js', 'support.js', 'renderer.js'];
  const source = (await Promise.all(files.map(name => readFile(new URL(`../../local-ui/renderer/${name}`, import.meta.url), 'utf8')))).join('\n');
  await window.webContents.insertCSS(await readFile(new URL('../../local-ui/renderer/styles.css', import.meta.url), 'utf8'));
  await js(source);
  await js(`(async () => {
    await until(() => !!button('show-credits'));
    button('show-credits').click();
    await until(() => !!button('credits-open') && document.body.textContent.includes('0.00'));
    check(!dialog() && !product('product-1'), 'products leaked outside purchase dialog');
    check(!requests.some(row => ['wallet.entries', 'wallet.calls', 'wallet.summary'].includes(row.action) || row.action === 'wallet.orders' && !row.input?.active), 'hidden histories still loaded');
    button('credits-open').click();
    await until(() => !!product('product-1') && !product('product-1').disabled);
    check(createCount === 0, 'opening dialog created a purchase');
    check(dialog().textContent.includes('¥0.01') && dialog().textContent.includes('充值商品 1'), 'penny product not displayed');
    check(document.querySelector('.credits-page').inert && button('show-applications').closest('[inert]'), 'background remained interactive');
    check(dialog().contains(document.activeElement), 'dialog did not take focus');
    check(!button('credits-channel') && !button('credits-confirm'), 'payment choice appeared before product selection');
    const beforeSelection = requests.length;
    product('product-200').click();
    check(!product('product-1'), 'product list remained in the channel step');
    button('credits-reselect').click();
    product('product-1').click();
    const wechat = document.querySelector('[data-action="credits-channel"][data-channel="wechat"]');
    check(wechat && !wechat.disabled, 'WeChat choice unavailable');
    wechat.click();
    document.querySelector('[data-action="credits-channel"][data-channel="alipay"]').click();
    document.querySelector('[data-action="credits-channel"][data-channel="wechat"]').click();
    check(requests.length === beforeSelection && createCount === 0, 'selection sent a network request');
    check(!document.querySelector('.wallet-qr'), 'selection generated a QR before confirmation');
    await until(() => !button('credits-confirm').disabled);
    button('credits-confirm').click();
    await until(() => document.body.textContent.includes('正在生成付款码'));
    check(createCount === 1, 'confirmation did not create exactly one purchase');
    check(activeOrder.payment_channel === 'wechat', 'selected channel did not reach order');
    check(!product('product-200') && !button('credits-channel') && !button('credits-confirm'), 'payment still allowed changing product/channel');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check(!dialog() && document.activeElement === button('credits-open'), 'Escape did not restore purchase entry focus');
    check(!requests.some(row => row.action === 'wallet.closeOrder'), 'dismiss unexpectedly cancelled payment');
    button('credits-open').click(); resolveCreate();
    await until(() => !!document.querySelector('.wallet-qr'));
    check(dialog().textContent.includes('微信扫码'), 'Native payment label missing');
    check(!product('product-1') && !product('product-200'), 'payment screen still displayed product selection');
    button('credits-dismiss').click(); button('credits-open').click();
    check(document.activeElement === dialog(), 'pending purchase should focus its dialog when product cards are disabled');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    check(document.activeElement === Array.from(dialog().querySelectorAll('button:not(:disabled)')).at(-1), 'reverse Tab from dialog skipped last control');
    const buttons = Array.from(dialog().querySelectorAll('button:not(:disabled)'));
    buttons.at(-1).focus();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    check(document.activeElement === buttons[0], 'Tab escaped purchase dialog');
  })()`);
  if (process.env.WALLET_SCREENSHOT_DIR) {
    await mkdir(process.env.WALLET_SCREENSHOT_DIR, { recursive: true });
    await writeFile(join(process.env.WALLET_SCREENSHOT_DIR, 'purchase.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(390, 780);
    await js('new Promise(resolve => realTimeout(resolve, 50))');
    await js(`check(dialog().scrollWidth <= dialog().clientWidth, 'dialog overflows narrow screen')`);
    await writeFile(join(process.env.WALLET_SCREENSHOT_DIR, 'purchase-narrow.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(1280, 900);
  }
  await js(`(async () => {
    activeOrder = { ...activeOrder, payment_state: 'paid', fulfillment_state: 'pending', display_state: 'paid_pending', payment_action: null };
    walletPoll();
    await until(() => document.body.textContent.includes('支付成功，积分到账中'));
    check(!document.querySelector('.wallet-qr') && !product('product-200'), 'paid purchase remained payable');
    activeOrder = { ...activeOrder, fulfillment_state: 'credited', display_state: 'credited' };
    walletPoll();
    await until(() => document.body.textContent.includes('积分已到账'));
    check(document.querySelector('.credits-total').textContent.includes('0.20'), 'credited balance did not refresh');
    button('credits-dismiss').click();
    check(!dialog() && document.activeElement === button('credits-open'), 'complete did not close dialog');
    button('credits-open').click(); product('product-100').click(); button('credits-confirm').click();
    await until(() => !!document.querySelector('.wallet-qr'));
    button('credits-close-order').click();
    await until(() => document.body.textContent.includes('关闭确认中'));
    check(!document.querySelector('.wallet-qr') && !product('product-200'), 'close-pending purchase allowed a replacement');
    activeOrder = { ...activeOrder, payment_state: 'closed', display_state: 'closed' }; walletPoll();
    await until(() => !!button('credits-reselect'));
    button('credits-reselect').click();
    product('product-200').click(); button('credits-confirm').click();
    await until(() => !!document.querySelector('.wallet-qr'));
    check(createCount === 3, 'closed order did not allow new purchase');
    nowOffset = 61000; qrExpiry();
    check(!document.querySelector('.wallet-qr') && document.body.textContent.includes('付款码已到期'), 'expiry left QR visible');
    activeOrder = null;
    snapshot = { ...snapshot, account: { ...snapshot.account, accountId: 'bob', clientId: 'client-2' } };
    publish(snapshot);
    check(!dialog() && !document.querySelector('.wallet-qr'), 'account change retained old purchase');
  })()`);
  await js(`(async () => {
    await new Promise(resolve => realTimeout(resolve, 50));
    window.qeeMode = true; if (button('show-credits')) button('show-credits').click(); walletPoll();
    await until(() => document.body.textContent.includes('200,000.00'));
    check(document.body.textContent.includes('消耗不足 0.01 积分') && document.body.textContent.includes('客厅盒子'), 'actual consumption missing');
    check(document.body.textContent.includes('20:00:00'), 'server timezone not applied');
    check(document.querySelector('.wallet-usage table tbody tr'), 'usage row missing');
    check(!/USD|tokens?|[$]|199999999940/i.test(document.querySelector('.credits-page').innerHTML), 'internal accounting leaked into wallet');
  })()`);
  if (process.env.WALLET_SCREENSHOT_DIR) {
    await js('new Promise(resolve => realTimeout(resolve, 100))');
    await writeFile(join(process.env.WALLET_SCREENSHOT_DIR, 'qeetoken-wallet.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(390, 780);
    await js('new Promise(resolve => realTimeout(resolve, 50))');
    await js(`check(document.querySelector('.wallet-usage-scroll').getBoundingClientRect().right <= innerWidth, 'usage table overflows screen')`);
    await writeFile(join(process.env.WALLET_SCREENSHOT_DIR, 'qeetoken-wallet-narrow.png'), (await window.webContents.capturePage()).toPNG());
  }
  // The desktop shell supports a minimum width of 760. The 390px captures
  // above only stress the wallet's scrolling components, not the whole shell.
  window.setSize(760, 560);
  await js('new Promise(resolve => realTimeout(resolve, 50))');
  await js(`check(document.documentElement.scrollWidth <= innerWidth, 'wallet overflows supported desktop width')`);
  if (process.env.WALLET_SCREENSHOT_DIR) {
    await writeFile(join(process.env.WALLET_SCREENSHOT_DIR, 'wallet-minimum-desktop.png'), (await window.webContents.capturePage()).toPNG());
  }
  window.setSize(1280, 900);
  await js(`(async () => {
    window.rechargeV2 = true; walletPoll();
    await new Promise(resolve => realTimeout(resolve, 50));
    button('credits-open').click();
    await until(() => !!document.querySelector('#wallet-custom-amount'));
    check(document.querySelectorAll('[data-action="credits-buy"]').length === 5, 'five tiers missing');
    let input = document.querySelector('#wallet-custom-amount'); input.click(); input.focus(); input.value = '11';
    input.dispatchEvent(new Event('input', { bubbles:true }));
    check(document.activeElement.id === 'wallet-custom-amount' && document.activeElement.value === '11', 'custom input lost focus/value');
    document.querySelector('#wallet-custom-amount').click();
    check(document.querySelector('#wallet-custom-amount').value === '11', 'click changed custom amount');
    document.querySelector('#wallet-custom-amount').dispatchEvent(new KeyboardEvent('keydown', { key:'Tab', bubbles:true }));
    check(document.activeElement.dataset.action === 'credits-quote', 'Tab from amount missed quote');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key:'Tab', shiftKey:true, bubbles:true }));
    check(document.activeElement.id === 'wallet-custom-amount', 'Shift Tab missed amount');
    walletPoll(); await new Promise(resolve => realTimeout(resolve, 50));
    check(document.querySelector('#wallet-custom-amount').value === '11', 'refresh lost draft amount');
    button('credits-quote').click();
    await until(() => !!button('credits-custom-buy'));
    check(dialog().textContent.includes('支付 ¥11 · 到账 1,100.00 积分'), 'server quote missing');
  })()`);
  if (process.env.WALLET_SCREENSHOT_DIR) {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await writeFile(join(process.env.WALLET_SCREENSHOT_DIR, 'recharge-v2.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(390, 780); await js('new Promise(resolve => realTimeout(resolve, 50))');
    await js(`check(dialog().scrollWidth <= dialog().clientWidth, 'v2 dialog overflows narrow screen');
      for (const product of document.querySelectorAll('.wallet-product')) check(product.scrollWidth <= product.clientWidth, 'tier amount overflows product');`);
    await writeFile(join(process.env.WALLET_SCREENSHOT_DIR, 'recharge-v2-narrow.png'), (await window.webContents.capturePage()).toPNG());
    await js(`button('credits-custom-buy').scrollIntoView({block:'center'})`);
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await writeFile(join(process.env.WALLET_SCREENSHOT_DIR, 'recharge-v2-narrow-quote.png'), (await window.webContents.capturePage()).toPNG());
  }
  await js(`(() => {
    const beforeSelection = requests.length;
    button('credits-custom-buy').click();
    document.querySelector('[data-action="credits-channel"][data-channel="wechat"]').click();
    check(requests.length === beforeSelection && !document.querySelector('.wallet-qr'), 'custom selection started payment before confirmation');
    check(button('credits-confirm').textContent.includes('确定支付 ¥11'), 'custom confirmation amount missing');
    check(!product('v2-10') && !document.querySelector('#wallet-custom-amount'), 'selection remained in confirmation step');
    check(dialog().scrollWidth <= dialog().clientWidth, 'confirmation overflows narrow screen');
  })()`);
  if (process.env.WALLET_SCREENSHOT_DIR) {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await writeFile(join(process.env.WALLET_SCREENSHOT_DIR, 'checkout-confirmation-narrow.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(1280, 900);
    await js('new Promise(resolve => realTimeout(resolve, 50))');
    await writeFile(join(process.env.WALLET_SCREENSHOT_DIR, 'checkout-confirmation.png'), (await window.webContents.capturePage()).toPNG());
  }
  await js(`(async () => {
    button('credits-confirm').click();
    await until(() => !!document.querySelector('.wallet-qr'));
    check(activeOrder.amount_fen === 1100 && activeOrder.grant_credit_atoms === '1100000000', 'custom payment amounts changed');
    check(!document.querySelector('#wallet-custom-amount'), 'payment screen still displayed custom amount input');
  })()`);
  console.log('WALLET_ELECTRON_PASS');
} catch (error) {
  console.error(error);
  if (window) console.error(await window.webContents.executeJavaScript('JSON.stringify({body:document.body.textContent, requests:window.requests?.slice(-12)})'));
  process.exitCode = 1;
} finally {
  window?.destroy();
  app.exit(process.exitCode || 0);
}
}
void verifyWallet();
