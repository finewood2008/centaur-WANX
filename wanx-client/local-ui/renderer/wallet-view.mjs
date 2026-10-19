import { creditAtoms, formatCreditAtoms } from '../../account/credit-wallet.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const pendingOrder = value => value && !['credited', 'closed'].includes(value.display_state);

export function createWalletView({ request, changed, storage = globalThis.localStorage,
  uuid = () => globalThis.crypto.randomUUID(), now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = timer => clearTimeout(timer), qr }) {
  let identity = null, account = null, generation = 0, timer = null, qrTimer = null, loading = false, writing = false;
  let catalog = null, balance = null, order = null, dialogOpen = false, selectedAmount = null;
  let error = '', intent = null, qrImage = null, recoveryReady = false;
  let selectedChannel = 'alipay';
  const channels = () => catalog?.payment_channels?.filter(name => ['alipay', 'wechat'].includes(name)) ?? ['alipay'];
  const key = () => `wanx.credit.purchase.v1:${account}`;
  const data = response => {
    if (response?.schema_version !== '1' || !response.data || !response.request_id) throw new Error('CREDITS_INVALID_RESPONSE');
    return response.data;
  };
  const read = async (name, input) => data(await request(`wallet.${name}`, input));
  const amount = value => { const formatted = formatCreditAtoms(value); return `${formatted.direction === 'debt' && formatted.text === '<0.01' ? '-' : ''}${formatted.text}`; };
  const exactPoints = value => {
    const [whole, fraction] = formatCreditAtoms(value).exact.split('.');
    const tail = fraction.replace(/0+$/, '');
    return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (tail ? `.${tail}` : '');
  };
  const notify = () => changed();
  function message(cause, fallback = '暂时无法连接积分服务，请稍后重试。') {
    const code = cause?.code || cause?.message;
    const messages = { CONTRACT_NOT_CONFIGURED: '积分服务暂未开放，请稍后再试。',
      CREDITS_SERVICE_UNAVAILABLE: '积分接口暂不可用，请联系管理员检查服务部署。',
      REVISION_CONFLICT: '商品已调整，请刷新后重新选择。',
      ORDER_IN_PROGRESS: '账号已有购买流程，正在恢复原订单。', ORDER_ALREADY_PAID: '订单已支付，请等待到账。',
      ACCOUNT_SESSION_CHANGED: '账号已切换，请刷新。', UNAUTHORIZED: '登录已失效，请重新登录。',
      INTENT_STORAGE_FAILED: '无法保存购买意图，请恢复本地存储后重试；尚未提交新购买请求。',
      CREDITS_INVALID_RESPONSE: '积分响应无法校验，请刷新重试。' };
    return (messages[code] || fallback) +
      (cause?.request_id ? ` 请求追踪号：${cause.request_id}` : '');
  }
  function save(value) {
    try { if (value) storage.setItem(key(), JSON.stringify(value)); else storage.removeItem(key()); }
    catch { throw new Error('INTENT_STORAGE_FAILED'); }
    intent = value;
  }
  function load() {
    try {
      const value = JSON.parse(storage.getItem(key()) || 'null');
      if (value && typeof value.purchase_intent_id === 'string' && ((typeof value.product_id === 'string' && typeof value.product_version === 'string') || [5000, 10000, 20000].includes(value.amount_fen))) return value;
    } catch { /* No new purchase is sent until a durable write succeeds. */ }
    return null;
  }
  function discardRejectedIntent(cause) {
    if (intent && !intent.order_id && !pendingOrder(order) && ['REVISION_CONFLICT', 'CONTRACT_NOT_CONFIGURED', 'VALIDATION_ERROR'].includes(cause?.code || cause?.message)) save(null);
  }
  async function acceptOrder(value, g) {
    if (g !== generation) return;
    if (qrTimer !== null) cancel(qrTimer);
    qrTimer = null; order = value; qrImage = null;
    if (value.payment_channel) selectedChannel = value.payment_channel;
    if (intent) {
      if (['credited', 'closed'].includes(value.display_state)) save(null);
      else save({ ...intent, order_id: value.order_id });
    }
    const action = value.payment_action;
    if (!intent?.close_intent_id && action?.type === 'qr' && value.payment_state === 'pending' && now() < Date.parse(value.expires_at) && now() < Date.parse(action.expires_at) && qr) {
      const image = await qr(action.payload);
      if (g === generation && order === value) {
        qrImage = image;
        const remaining = Math.min(Date.parse(value.expires_at), Date.parse(action.expires_at)) - now();
        if (remaining <= 0) qrImage = null;
        else qrTimer = schedule(() => {
          if (g === generation && order === value) { qrImage = null; qrTimer = null; notify(); }
        }, remaining);
      }
    }
  }
  function poll() {
    if (timer !== null) cancel(timer);
    timer = null;
    if (identity && (pendingOrder(order) || intent || error || balance?.execution_slot_state === 'held')) {
      timer = schedule(() => { timer = null; void refresh(); }, error ? 30000 : 5000);
      timer?.unref?.();
    }
  }
  async function recover(g) {
    let value;
    if (intent?.close_intent_id && intent.order_id) {
      try { value = await read('closeOrder', { order_id: intent.order_id, close_intent_id: intent.close_intent_id }); }
      catch (cause) {
        if (g !== generation) return;
        if (cause?.code !== 'ORDER_ALREADY_PAID') throw cause;
        value = await read('order', { order_id: intent.order_id });
      }
    } else if (intent) {
      value = intent.order_id ? await read('order', { order_id: intent.order_id }) :
        await read('createOrder', { purchase_intent_id: intent.purchase_intent_id, ...(intent.product_id ? { product_id: intent.product_id, product_version: intent.product_version } : { amount_fen: intent.amount_fen }),
          ...(intent.payment_channel ? { payment_channel: intent.payment_channel } : {}) });
    } else if (pendingOrder(order)) {
      value = await read('order', { order_id: order.order_id });
    } else {
      const active = await read('orders', { active: true });
      value = active.items[0];
    }
    if (value) await acceptOrder(value, g);
    // Keep a completed purchase visible until the user chooses another product.
  }
  async function refresh() {
    if (!identity || loading || writing) return;
    const g = generation; loading = true; error = ''; notify();
    try {
      // Recover the original purchase even when balance or catalog reads fail.
      try { await recover(g); if (g === generation) recoveryReady = true; }
      catch (cause) { if (g === generation) { discardRejectedIntent(cause); recoveryReady = false; error = message(cause); } }
      if (g !== generation) return;
      const [c, b] = await Promise.all([read('catalog'), read('balance')]);
      if (g !== generation) return;
      creditAtoms(b.balance_credit_atoms); creditAtoms(b.debt_credit_atoms);
      if (!Number.isSafeInteger(b.ledger_sequence) || b.ledger_sequence < 0) throw new Error('CREDITS_INVALID_RESPONSE');
      catalog = c;
      if (!pendingOrder(order) && !intent && !channels().includes(selectedChannel)) selectedChannel = channels()[0];
      if (!balance || b.ledger_sequence >= balance.ledger_sequence) balance = b;
    } catch (cause) { if (g === generation) error = message(cause); }
    finally { if (g === generation) { loading = false; notify(); poll(); } }
  }
  const products = () => catalog?.products?.length ? catalog.products : (catalog?.tiers || []);
  const productKey = product => product.product_id || String(product.amount_fen);
  async function purchase(key) {
    const product = products().find(item => productKey(item) === key);
    if (!identity || !recoveryReady || writing || loading || pendingOrder(order) || intent || !catalog?.recharge_enabled || !product || !channels().includes(selectedChannel)) return;
    const g = generation; writing = true; error = ''; dialogOpen = true; selectedAmount = key; order = null; notify();
    try {
      if (!intent) save({ purchase_intent_id: uuid(), ...(product.product_id ? { product_id: product.product_id, product_version: product.version } : { amount_fen: product.amount_fen }),
        ...(catalog.payment_channels ? { payment_channel: selectedChannel } : {}) });
      await recover(g);
    } catch (cause) {
      if (g !== generation) return;
      error = message(cause);
      if (!order && ['REVISION_CONFLICT', 'CONTRACT_NOT_CONFIGURED', 'VALIDATION_ERROR'].includes(cause?.code || cause?.message)) {
        discardRejectedIntent(cause);
        try { const value = await read('catalog'); if (g === generation) catalog = value; } catch { /* Keep the rejection visible; refresh can retry. */ }
      }
      const original = cause?.details?.blocking_order_ids?.[0];
      if (original) {
        try { await acceptOrder(await read('order', { order_id: original }), g); }
        catch (failure) { if (g === generation) error = message(failure); }
      }
    } finally { if (g === generation) { writing = false; notify(); poll(); } }
  }
  async function close() {
    if (!order || writing || loading || order.payment_state === 'paid') return;
    const g = generation; writing = true; error = ''; qrImage = null; notify();
    try {
      const value = { ...(intent || { purchase_intent_id: order.purchase_intent_id, amount_fen: order.amount_fen }),
        order_id: order.order_id, close_intent_id: intent?.close_intent_id || uuid() };
      save(value);
      await recover(g);
    } catch (cause) { if (g === generation) error = message(cause); }
    finally { if (g === generation) { writing = false; notify(); poll(); } }
  }
  const paymentImage = () => qrImage && order && !intent?.close_intent_id && order.payment_state === 'pending' &&
    now() < Date.parse(order.expires_at) && now() < Date.parse(order.payment_action?.expires_at) ? qrImage : null;
  function paymentView() {
    const state = order?.display_state;
    const expired = order && (now() >= Date.parse(order.expires_at) ||
      (order.payment_action && now() >= Date.parse(order.payment_action.expires_at)));
    let title = '选择积分商品', description = '选择上方商品后，这里会生成付款码。', success = false;
    if (order?.review_state === 'open') {
      title = '支付结果待核对';
      description = `${order.payment_state === 'paid' ? '已支付。' : '付款结果尚待核实。'}${order.fulfillment_state === 'credited' ? '积分已到账。' : '积分到账情况正在核对。'}请勿重复支付。`;
    } else if (state === 'credited') {
      title = '积分已到账'; description = `${amount(order.grant_credit_atoms)} 点积分已记入当前账号。`; success = true;
    } else if (order?.payment_state === 'paid') {
      title = '支付成功，积分到账中'; description = '正在更新积分余额，请勿重复支付。关闭弹框后仍会继续确认到账。';
    } else if (state === 'closed') {
      title = '本次购买已关闭'; description = '可以重新选择积分商品，生成新的付款码。';
    } else if (intent?.close_intent_id || order?.payment_state === 'close_pending') {
      title = '关闭确认中'; description = '正在确认原付款码已失效，确认后即可重新选择。请勿继续支付原付款码。';
    } else if (expired) {
      title = '付款码已到期'; description = '正在确认支付或关闭结果，确认前请勿重复购买。';
    } else if (paymentImage()) {
      const wechat = order.payment_action.payload.startsWith('weixin://');
      title = wechat ? '微信扫码支付' : '支付宝扫码支付'; description = `应付 ¥${order.amount_fen / 100} · 到账 ${exactPoints(order.grant_credit_atoms)} 点积分`;
    } else if (order?.payment_state === 'creating' || writing) {
      title = '正在生成付款码'; description = '请稍候，付款码生成后会显示在下方。';
    } else if (intent && !order) {
      title = '购买结果确认中'; description = '已保留本次购买，正在恢复付款结果，请勿重复购买。';
    } else if (order?.payment_state === 'pending') {
      title = '正在获取付款码'; description = '正在恢复本次购买，请稍候或刷新支付状态。';
    } else if (!catalog?.recharge_enabled || !products().length) {
      title = loading ? '正在读取商品' : '购买暂不可用'; description = loading ? '请稍候。' : '积分购买暂未开放，请稍后再试。';
    }
    return `<section class="wallet-payment ${success ? 'is-success' : ''}" aria-label="支付进度">
      ${paymentImage() ? `<img class="wallet-qr" alt="积分支付二维码" src="${esc(qrImage)}">` : `<div class="wallet-payment-mark" aria-hidden="true">${success ? '✓' : state === 'closed' || expired ? '—' : '·'}</div>`}
      <div role="status" aria-live="polite"><h3>${esc(title)}</h3><p>${esc(description)}</p></div>
      ${error ? `<p class="notice" role="alert">${esc(error)}</p>` : ''}
      <div class="wallet-payment-actions">
        ${(order || intent || error) && (!success || error) ? `<button class="text-button" data-action="credits-refresh" ${loading || writing ? 'disabled' : ''}>${loading ? '正在确认…' : '刷新支付状态'}</button>` : ''}
        ${order && ['creating', 'pending'].includes(order.payment_state) && !intent?.close_intent_id ? `<button class="text-button" data-action="credits-close-order" ${loading || writing ? 'disabled' : ''}>取消并重新选择</button>` : ''}
        ${success ? '<button class="button primary" data-action="credits-dismiss">完成</button>' : ''}
      </div>
      ${pendingOrder(order) || intent ? '<p class="wallet-payment-footnote">收起弹框不会取消支付，我们会继续确认结果。</p>' : ''}
    </section>`;
  }
  function dialog() {
    if (!dialogOpen) return '';
    const selected = pendingOrder(order) ? intent?.product_id || String(order.amount_fen) : selectedAmount;
    return `<div class="wallet-modal"><section class="wallet-purchase-dialog" role="dialog" aria-modal="true" aria-labelledby="wallet-purchase-title" tabindex="-1">
      <header class="wallet-purchase-heading"><div><h2 id="wallet-purchase-title">购买积分</h2><p>按商品标注的金额和积分购买 · 充值积分长期有效</p></div><button class="wallet-dialog-close" data-action="credits-dismiss" aria-label="关闭购买弹框">×</button></header>
      <div class="wallet-payment-actions wallet-channel-picker" aria-label="支付方式">${channels().map(channel => `<button class="button ${selectedChannel === channel ? 'primary' : ''}" data-action="credits-channel" data-channel="${channel}" aria-pressed="${selectedChannel === channel}" ${writing || loading || pendingOrder(order) || intent ? 'disabled' : ''}>${channel === 'wechat' ? '微信支付' : '支付宝'}</button>`).join('')}</div>
      <div class="wallet-products" aria-label="积分商品">${products().map(tier => `<button class="wallet-product" data-action="credits-buy" data-amount="${esc(productKey(tier))}" aria-pressed="${selected === productKey(tier)}" ${!catalog?.recharge_enabled || !recoveryReady || writing || loading || pendingOrder(order) || intent ? 'disabled' : ''}>
        ${tier.name ? `<span>${esc(tier.name)}</span>` : ''}<span class="wallet-product-points">${esc(exactPoints(tier.grant_credit_atoms))}<small>点积分</small></span><strong>¥${tier.amount_fen / 100}</strong><span class="wallet-product-selection">${selected === productKey(tier) ? '已选择' : '选择商品'}</span></button>`).join('')}</div>
      ${paymentView()}
    </section></div>`;
  }
  return {
    reset(value) {
      if (identity === value) return false;
      if (timer !== null) cancel(timer);
      if (qrTimer !== null) cancel(qrTimer);
      qrTimer = null;
      identity = value; generation++; account = value ? JSON.parse(value)[0] : null;
      catalog = balance = order = qrImage = selectedAmount = null;
      dialogOpen = loading = writing = recoveryReady = false; error = ''; timer = null;
      selectedChannel = 'alipay';
      intent = account ? load() : null;
      if (intent?.payment_channel) selectedChannel = intent.payment_channel;
      return true;
    },
    refresh,
    paymentImage,
    isOpen: () => dialogOpen,
    label: () => balance ? `${creditAtoms(balance.balance_credit_atoms) < 0n ? '欠款 ' : ''}${amount(balance.balance_credit_atoms)} 点` : loading ? '读取中…' : '暂不可用',
    async action(action, dataset = {}) {
      if (action === 'credits-open') { dialogOpen = true; notify(); return; }
      if (action === 'credits-dismiss') { dialogOpen = false; notify(); return; }
      if (action === 'credits-refresh') return refresh();
      if (action === 'credits-channel') {
        if (!writing && !loading && !pendingOrder(order) && !intent && channels().includes(dataset.channel)) {
          selectedChannel = dataset.channel; notify();
        }
        return;
      }
      if (action === 'credits-buy') return purchase(String(dataset.amount));
      if (action === 'credits-close-order') return close();
    },
    render() {
      const debt = balance && creditAtoms(balance.balance_credit_atoms) < 0n;
      return `<div class="page-content credits-page" ${dialogOpen ? 'inert' : ''}>
        <div class="page-heading"><div><h2>账号积分</h2><p class="muted">用于平台模型服务，充值积分长期有效。</p></div></div>
        ${error && !dialogOpen ? `<div class="notice" role="status">${esc(error)}${balance ? ' 当前显示上次读取的余额。' : ''}</div>` : ''}
        <section class="credits-overview"><div><p class="eyebrow">${debt ? '账号欠款' : '积分余额'}</p><div class="credits-total">${balance ? esc(amount(debt ? balance.debt_credit_atoms : balance.balance_credit_atoms)) : '—'}<span>点</span></div>
        <p class="muted">${debt ? '充值后先抵扣欠款；余额恢复为正才可使用平台 Provider。' : balance?.execution_slot_state === 'held' ? '平台 Provider 当前调用尚未完成，等待结果或核对。' : balance && creditAtoms(balance.balance_credit_atoms) === 0n ? '积分不足，平台 Provider 暂不可用，请充值后再发起请求。' : '积分由当前账号下的盒子共享。'}</p></div>
        <div class="credits-recharge"><button class="button primary" data-action="credits-open">购买积分</button>${pendingOrder(order) || intent ? '<p>有一笔购买正在处理中，点击继续查看。</p>' : ''}</div></section>
        <p class="credits-hint">仅平台 Provider 的模型调用消耗积分，BYOK 和本地模型不使用此积分。</p>
      </div>${dialog()}`;
    },
  };
}
