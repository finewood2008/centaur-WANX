import { creditAtoms, displayCreditAtoms, validateCreditWallet, orderGrantCreditAtoms } from '../../account/credit-wallet.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const pendingOrder = value => value && !['credited', 'closed'].includes(value.display_state);

export function createWalletView({ request, changed, storage = globalThis.localStorage,
  uuid = () => globalThis.crypto.randomUUID(), now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = timer => clearTimeout(timer), qr,
  onTiming = () => {}, monotonic = () => globalThis.performance?.now?.() ?? now() }) {
  let identity = null, account = null, generation = 0, timer = null, qrTimer = null, loading = false, writing = false;
  let catalog = null, balance = null, order = null, dialogOpen = false, selectedAmount = null;
  let error = '', intent = null, qrImage = null, recoveryReady = false;
  let customText = '', customQuote = null;
  let selectedChannel = 'alipay', remote = null, usage = [], nextUsage = null, usageLoading = false, usageRevision = 0;
  const channels = () => catalog?.payment_channels?.filter(name => ['alipay', 'wechat'].includes(name)) ?? ['alipay'];
  const key = () => `wanx.credit.purchase.v1:${account}`;
  const data = response => {
    if (response?.schema_version !== '1' || !response.data || !response.request_id) throw new Error('CREDITS_INVALID_RESPONSE');
    return response.data;
  };
  const read = async (name, input) => data(await request(`wallet.${name}`, input));
  const amount = value => displayCreditAtoms(value);
  const points = (value, context = 'balance') => { const text = displayCreditAtoms(value, context); return text.includes('积分') ? text : `${text} 积分`; };
  const notify = () => changed();
  const timing = (stage, started, details = {}) => {
    try { onTiming({ stage, durationMs: Math.max(0, Math.round(monotonic() - started)), ...details }); }
    catch { /* Diagnostics must never interrupt payment recovery. */ }
  };
  function message(cause, fallback = '暂时无法连接积分服务，请稍后重试。') {
    const code = cause?.code || cause?.message;
    const messages = { UNSUPPORTED_SCHEMA: '请升级万象客户端后再充值，原订单仍会继续处理。',
      VALIDATION_ERROR: '请输入 10～1000 的整数元金额。', CONTRACT_NOT_CONFIGURED: '积分服务暂未开放，请稍后再试。',
      QEETOKEN_UNAVAILABLE: '余额服务暂不可用，正在重试同步。',
      QEETOKEN_MIGRATION_PENDING: '旧调用正在结算，完成后将同步账号余额。',
      QEETOKEN_SYNC_PENDING: '消费流水正在同步，请稍候。',
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
      if (value && typeof value.purchase_intent_id === 'string' && (
        (typeof value.order_id === 'string' && typeof value.close_intent_id === 'string') ||
        (typeof value.product_id === 'string' && typeof value.product_version === 'string') ||
        (value.currency_rule_id === 'usd-credit-100-v2' && Number.isSafeInteger(value.amount_fen) && value.amount_fen >= 1000 && value.amount_fen <= 100000 && value.amount_fen % 100 === 0) ||
        [5000, 10000, 20000].includes(value.amount_fen)
      )) return value;
    } catch { /* No new purchase is sent until a durable write succeeds. */ }
    return null;
  }
  function discardRejectedIntent(cause) {
    if (intent && !intent.order_id && !pendingOrder(order) && ['REVISION_CONFLICT', 'CONTRACT_NOT_CONFIGURED', 'VALIDATION_ERROR', 'UNSUPPORTED_SCHEMA'].includes(cause?.code || cause?.message)) save(null);
  }
  async function acceptOrder(value, g) {
    if (g !== generation) return;
    const grant = orderGrantCreditAtoms(value);
    if (qrTimer !== null) cancel(qrTimer);
    qrTimer = null; order = value; qrImage = null;
    if (value.payment_channel) selectedChannel = value.payment_channel;
    if (intent) {
      if (value.display_state === 'closed' || (value.display_state === 'credited' && grant !== null)) save(null);
      else save({ ...intent, order_id: value.order_id });
    }
    const action = value.payment_action;
    if (grant !== null && !intent?.close_intent_id && action?.type === 'qr' && value.payment_state === 'pending' && now() < Date.parse(value.expires_at) && now() < Date.parse(action.expires_at) && qr) {
      const qrStarted = monotonic();
      let image;
      try {
        image = await qr(action.payload);
      } finally {
        timing('qr', qrStarted, { ready: Boolean(image) });
      }
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
    if (identity) {
      timer = schedule(() => { timer = null; void refresh(); }, error || (!pendingOrder(order) && !intent && !remote) ? 30000 : 5000);
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
          ...(intent.payment_channel ? { payment_channel: intent.payment_channel } : {}),
          ...(intent.currency_rule_id ? { currency_rule_id: intent.currency_rule_id } : {}) });
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
      let q = null, u = null;
      if (b.billing_backend === 'qeetoken') {
        // Read the page first: a later wallet snapshot can safely include newer events.
        u = await read('usage', { limit: 20 });
        if (g !== generation) return;
        q = await read('wallet');
        if (g !== generation) return;
        validateWallet(q); validateUsage(u);
        if (q.sync_state !== 'pending' && BigInt(u.remote_sequence) > BigInt(q.remote_sequence)) {
          q = { ...q, sync_state: 'stale' };
          u = null;
        }
      }
      catalog = c;
      if (q?.sync_state === 'pending' && remote?.balance_credit_atoms != null) {
        remote = { ...remote, sync_state: 'stale' };
      } else if (!remote || !q || BigInt(q.remote_sequence) >= BigInt(remote.remote_sequence)) {
        remote = q;
        if (u) { usage = u.items; nextUsage = u.next_before_sequence; usageRevision++; }
      }
      if (!pendingOrder(order) && !intent && !channels().includes(selectedChannel)) selectedChannel = channels()[0];
      if (!balance || b.ledger_sequence >= balance.ledger_sequence) balance = b;
    } catch (cause) { if (g === generation) error = message(cause); }
    finally { if (g === generation) { loading = false; notify(); poll(); } }
  }
  function validateWallet(q) {
    const grant = q.registration_grant;
    if (grant != null) {
      const deliveryStates = ['queued', 'running', 'retry_wait', 'review_required', 'credited'];
      const payable = grant.eligibility === 'new_account' ||
        (grant.eligibility === 'history_unclaimed' && deliveryStates.includes(grant.state));
      const states = grant.eligibility === 'new_account' ? deliveryStates :
        grant.eligibility === 'history_received' ? ['historical_received'] :
        grant.eligibility === 'history_unclaimed' ? ['waiting_migration', ...deliveryStates] : [];
      if (grant.grant_rule_id !== 'registration-500-v1' || !states.includes(grant.state) ||
          (payable ? grant.credit_display?.currency_rule_id !== 'usd-credit-100-v2' ||
            grant.credit_display.credit_scale !== 6 || grant.credit_display.grant_credit_atoms !== '500000000' :
            grant.credit_display !== null)) throw new Error('CREDITS_INVALID_RESPONSE');
    }
    validateCreditWallet(q, account);
  }
  function validateUsage(value, before = null) {
    if (value.view_version !== '2' || value.account_id !== account || value.currency_rule_id !== 'usd-credit-100-v2' || value.credit_scale !== 6 ||
        !Array.isArray(value.items) || value.items.length > 100 || creditAtoms(value.remote_sequence) < 0n) throw new Error('CREDITS_INVALID_RESPONSE');
    let previous = before === null ? creditAtoms(value.remote_sequence) + 1n : creditAtoms(before);
    const ids = new Set();
    for (const item of value.items) {
      const sequence = creditAtoms(item.account_sequence);
      if (creditAtoms(item.debit_credit_atoms) < 0n || !Number.isFinite(Date.parse(item.occurred_at)) ||
          typeof item.event_id !== 'string' || ids.has(item.event_id) || sequence <= 0n || sequence >= previous ||
          sequence > creditAtoms(value.remote_sequence)) throw new Error('CREDITS_INVALID_RESPONSE');
      previous = sequence; ids.add(item.event_id);
    }
    if (value.next_before_sequence !== null && (!value.items.length || value.next_before_sequence !== value.items.at(-1).account_sequence)) throw new Error('CREDITS_INVALID_RESPONSE');
  }
  const displayedBalance = () => remote ? remote.balance_credit_atoms : balance?.billing_backend === 'qeetoken' ? null : balance?.balance_credit_atoms;
  const date = value => new Intl.DateTimeFormat('zh-CN', { timeZone: catalog?.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
  async function loadUsage() {
    if (!identity || usageLoading || !nextUsage) return;
    const g = generation, cursor = nextUsage, revision = usageRevision; usageLoading = true;
    try {
      const value = await read('usage', { before_sequence: cursor, limit: 20 });
      if (g !== generation || cursor !== nextUsage || revision !== usageRevision) return;
      validateUsage(value, cursor); usage.push(...value.items); nextUsage = value.next_before_sequence;
    } catch (cause) { if (g === generation) error = message(cause); }
    finally { if (g === generation) { usageLoading = false; notify(); } }
  }
  function remoteView() {
    if (!remote) return '';
    const state = remote.sync_state === 'pending' ? '余额初始化中' : remote.sync_state === 'stale' || error ? '显示上次同步余额' : '余额已同步';
    return `<section aria-label="余额同步状态"><p>${esc(state)}${remote.synced_at ? ` · ${esc(date(remote.synced_at))}` : ''}</p>
      ${registrationView()}
      ${remote.spent_credit_atoms !== null ? `<p class="muted">累计消耗 ${esc(points(remote.spent_credit_atoms, 'consumption'))} · 已纠正 ${esc(points(remote.correction_credit_atoms))} · 净消耗 ${esc(points(remote.net_spent_credit_atoms, 'consumption'))}</p>` : ''}
      ${remote.pending_executions ? `<p role="status">${esc(remote.pending_executions)} 笔调用正在结算或核对，最终消耗以结算结果为准。</p>` : ''}</section>
      <section class="wallet-usage" aria-label="消费流水"><h3>消费流水</h3>${usage.length ? `<div class="wallet-usage-scroll" tabindex="0" aria-label="可滚动消费记录"><table><thead><tr><th>时间</th><th>盒子</th><th>模型</th><th>消耗积分</th></tr></thead><tbody>${usage.map(item => `<tr><td>${esc(date(item.occurred_at))}</td><td>${esc(item.device_id)}</td><td>${esc(item.model)}</td><td>${esc(displayCreditAtoms(item.debit_credit_atoms, 'consumption'))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">暂无已结算消费。</p>'}
      ${nextUsage ? `<button class="text-button" data-action="credits-usage-more" ${usageLoading ? 'disabled' : ''}>查看更多</button>` : ''}</section>`;
  }
  function registrationView() {
    const grant = remote?.registration_grant;
    if (!grant) return '';
    const labels = { queued: '注册赠送待到账', running: '注册赠送处理中', retry_wait: '注册赠送正在重试',
      review_required: '注册赠送待核对', credited: '注册赠送已到账',
      historical_received: '历史注册赠送已领取', waiting_migration: '注册赠送资格已核实，等待处理' };
    return `<p role="status">${esc(labels[grant.state])}${grant.credit_display ? ` · ${esc(amount(grant.credit_display.grant_credit_atoms))} 新积分` : ''}</p>`;
  }
  const products = () => catalog?.products?.length ? catalog.products : (catalog?.tiers || []);
  const productKey = product => product.product_id || String(product.amount_fen);
  const selectedProduct = () => selectedAmount === 'custom' ? customQuote : products().find(item => productKey(item) === selectedAmount);
  function selectProduct(key) {
    if (!identity || !recoveryReady || writing || pendingOrder(order) || intent || !catalog?.recharge_enabled) return;
    if (key === 'custom' ? !customQuote : !products().some(item => productKey(item) === key)) return;
    selectedAmount = key; order = null; error = ''; dialogOpen = true; notify();
  }
  async function quoteCustom(value) {
    if (!identity || writing || loading || pendingOrder(order) || intent || !catalog?.recharge_enabled || !catalog.custom_amount) return;
    customText = String(value); customQuote = null; error = '';
    if (!/^[1-9][0-9]{1,3}$/.test(customText) || Number(customText) < 10 || Number(customText) > 1000) {
      error = message({ code: 'VALIDATION_ERROR' }); notify(); return;
    }
    const g = generation, requested = Number(customText) * 100;
    writing = true; notify();
    try {
      const value = await read('quote', { amount_fen: requested });
      if (g !== generation) return;
      if (value.view_version !== '2' || value.currency_rule_id !== 'usd-credit-100-v2' || value.credit_scale !== 6 ||
          value.amount_fen !== requested || creditAtoms(value.grant_credit_atoms) <= 0n) throw new Error('CREDITS_INVALID_RESPONSE');
      customQuote = value;
    } catch (cause) { if (g === generation) error = message(cause); }
    finally { if (g === generation) { writing = false; notify(); } }
  }
  async function purchase() {
    const product = selectedProduct();
    if (!identity || !recoveryReady || writing || loading || pendingOrder(order) || intent || !catalog?.recharge_enabled || !product || !channels().includes(selectedChannel)) return;
    const g = generation; writing = true; error = ''; dialogOpen = true; order = null; notify();
    const confirmStarted = monotonic();
    let outcome = 'failed';
    try {
      if (!intent) save({ purchase_intent_id: uuid(), ...(product.product_id ? { product_id: product.product_id, product_version: product.version } : { amount_fen: product.amount_fen }),
        ...(catalog.payment_channels ? { payment_channel: selectedChannel } : {}),
        ...(catalog.view_version === '2' ? { currency_rule_id: 'usd-credit-100-v2' } : {}) });
      notify();
      await recover(g);
      outcome = 'completed';
    } catch (cause) {
      if (g !== generation) return;
      error = message(cause);
      if (!order && ['REVISION_CONFLICT', 'CONTRACT_NOT_CONFIGURED', 'VALIDATION_ERROR', 'UNSUPPORTED_SCHEMA'].includes(cause?.code || cause?.message)) {
        discardRejectedIntent(cause);
        try { const value = await read('catalog'); if (g === generation) catalog = value; } catch { /* Keep the rejection visible; refresh can retry. */ }
      }
      const original = cause?.details?.blocking_order_ids?.[0];
      if (original) {
        try { await acceptOrder(await read('order', { order_id: original }), g); }
        catch (failure) { if (g === generation) error = message(failure); }
      }
    } finally {
      if (g === generation) {
        timing('confirm', confirmStarted, { outcome, qrReady: Boolean(paymentImage()) });
        writing = false; notify(); poll();
      }
    }
  }
  async function close() {
    if (!order || writing || loading || order.payment_state === 'paid') return;
    const g = generation; writing = true; error = ''; qrImage = null; notify();
    const closeStarted = monotonic();
    let outcome = 'failed';
    try {
      const value = { ...(intent || { purchase_intent_id: order.purchase_intent_id, amount_fen: order.amount_fen }),
        order_id: order.order_id, close_intent_id: intent?.close_intent_id || uuid() };
      save(value);
      await recover(g);
      outcome = 'completed';
    } catch (cause) { if (g === generation) error = message(cause); }
    finally {
      if (g === generation) {
        timing('close', closeStarted, { outcome });
        writing = false; notify(); poll();
      }
    }
  }
  const paymentImage = () => qrImage && order && !intent?.close_intent_id && order.payment_state === 'pending' &&
    now() < Date.parse(order.expires_at) && now() < Date.parse(order.payment_action?.expires_at) ? qrImage : null;
  function paymentView() {
    const state = order?.display_state;
    const grant = order ? orderGrantCreditAtoms(order) : null;
    const expired = order && (now() >= Date.parse(order.expires_at) ||
      (order.payment_action && now() >= Date.parse(order.payment_action.expires_at)));
    let title = '选择积分商品', description = '选择上方商品后，这里会生成付款码。', success = false;
    if (order?.review_state === 'open') {
      title = '支付结果待核对';
      description = `${order.payment_state === 'paid' ? '已支付。' : '付款结果尚待核实。'}${order.fulfillment_state === 'credited' ? '积分已到账。' : '积分到账情况正在核对。'}请勿重复支付。`;
    } else if (state === 'credited') {
      title = '积分已到账'; description = grant === null ? '到账积分待核对，请稍后刷新。' : `${amount(grant)} 点积分已记入当前账号。`; success = true;
    } else if (order?.payment_state === 'paid') {
      title = '支付成功，积分到账中'; description = '正在更新积分余额，请勿重复支付。关闭弹框后仍会继续确认到账。';
    } else if (state === 'closed') {
      title = '本次购买已关闭'; description = '可以重新选择积分商品，生成新的付款码。';
    } else if (intent?.close_intent_id || order?.payment_state === 'close_pending') {
      title = '关闭确认中'; description = '正在确认原付款码已失效，确认后即可重新选择。请勿继续支付原付款码。';
    } else if (expired) {
      title = '付款码已到期'; description = '正在确认支付或关闭结果，确认前请勿重复购买。';
    } else if (order && grant === null) {
      title = '到账积分待核对'; description = '本次购买的积分数额正在核对，请稍后刷新或取消本次购买。';
    } else if (paymentImage()) {
      const wechat = order.payment_action.payload.startsWith('weixin://');
      title = wechat ? '微信扫码支付' : '支付宝扫码支付'; description = `应付 ¥${order.amount_fen / 100} · 到账 ${amount(grant)} 点积分`;
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
        ${(order || intent || error) && (!success || error || grant === null) ? `<button class="text-button" data-action="credits-refresh" ${loading || writing ? 'disabled' : ''}>${loading ? '正在确认…' : '刷新支付状态'}</button>` : ''}
        ${order && ['creating', 'pending'].includes(order.payment_state) && !intent?.close_intent_id ? `<button class="text-button" data-action="credits-close-order" ${loading || writing ? 'disabled' : ''}>取消支付</button>` : ''}
        ${state === 'closed' && !intent ? '<button class="button primary" data-action="credits-reselect">重新选择</button>' : ''}
        ${success ? '<button class="button primary" data-action="credits-dismiss">完成</button>' : ''}
      </div>
      ${pendingOrder(order) || intent ? '<p class="wallet-payment-footnote">收起弹框不会取消支付，我们会继续确认结果。</p>' : ''}
    </section>`;
  }
  function dialog() {
    if (!dialogOpen) return '';
    const paying = Boolean(order || intent), product = selectedProduct();
    return `<div class="wallet-modal"><section class="wallet-purchase-dialog" role="dialog" aria-modal="true" aria-labelledby="wallet-purchase-title" tabindex="-1">
      <header class="wallet-purchase-heading"><div><h2 id="wallet-purchase-title">${paying ? '扫码支付' : product ? '选择支付方式' : '购买积分'}</h2><p>${paying ? '付款后自动确认到账，无需重复支付' : '先选商品，再选支付方式 · 充值积分长期有效'}</p></div><button class="wallet-dialog-close" data-action="credits-dismiss" aria-label="${paying ? '收起支付弹框' : '关闭购买弹框'}">×</button></header>
      ${paying ? paymentView() : `
      ${!product ? `
      <h3 class="wallet-step-title">1. 选择积分商品</h3>
      <div class="wallet-products" aria-label="积分商品">${products().map(tier => `<button class="wallet-product" data-action="credits-buy" data-amount="${esc(productKey(tier))}" aria-pressed="${selectedAmount === productKey(tier)}" ${!catalog?.recharge_enabled || !recoveryReady || writing ? 'disabled' : ''}>
        ${tier.name ? `<span>${esc(tier.name)}</span>` : ''}<span class="wallet-product-points">${esc(amount(tier.grant_credit_atoms))}<small>点积分</small></span><strong>¥${tier.amount_fen / 100}</strong><span class="wallet-product-selection">${selectedAmount === productKey(tier) ? '已选择' : '选择商品'}</span></button>`).join('')}</div>
      ${catalog?.custom_amount ? `<div class="wallet-custom"><label for="wallet-custom-amount">自定义金额（10～1000 整数元）</label>
        <input id="wallet-custom-amount" data-wallet-input="custom-amount" inputmode="numeric" autocomplete="off" maxlength="4" value="${esc(customText)}" ${writing || loading || pendingOrder(order) || intent ? 'disabled' : ''}>
        <button class="button" data-action="credits-quote" ${!catalog.recharge_enabled || writing || loading || pendingOrder(order) || intent ? 'disabled' : ''}>获取报价</button>
        ${customQuote ? `<p>支付 ¥${customQuote.amount_fen / 100} · 到账 ${esc(amount(customQuote.grant_credit_atoms))} 积分</p><button class="button" data-action="credits-custom-buy" aria-pressed="${selectedAmount === 'custom'}" ${writing || loading ? 'disabled' : ''}>${selectedAmount === 'custom' ? '已选择自定义金额' : '选择此金额'}</button>` : ''}</div>` : ''}
      <p class="muted wallet-selection-hint">选择商品后，可选择支付方式并确认支付。</p>
      ` : `<section class="wallet-checkout" aria-label="确认购买">
        <div class="wallet-order-summary"><p>${product.name ? esc(product.name) + ' · ' : ''}到账 ${esc(amount(product.grant_credit_atoms))} 积分<br><strong>应付 ¥${product.amount_fen / 100}</strong></p><button class="text-button" data-action="credits-reselect" ${writing ? 'disabled' : ''}>更换商品</button></div>
        <h3 class="wallet-step-title">2. 选择支付方式</h3>
        <div class="wallet-payment-actions wallet-channel-picker" aria-label="支付方式">${channels().map(channel => `<button class="button ${selectedChannel === channel ? 'primary' : ''}" data-action="credits-channel" data-channel="${channel}" aria-pressed="${selectedChannel === channel}" ${writing ? 'disabled' : ''}>${channel === 'wechat' ? '微信支付' : '支付宝'}</button>`).join('')}</div>
        <div class="wallet-payment-actions"><button class="button" data-action="credits-dismiss">取消</button><button class="button primary" data-action="credits-confirm" ${!catalog?.recharge_enabled || !recoveryReady || writing || loading || !channels().includes(selectedChannel) ? 'disabled' : ''}>确定支付 ¥${product.amount_fen / 100}</button></div>
      </section>`}
      ${catalog?.upgrade_required ? '<p role="status">请升级万象客户端后再充值，原订单仍会继续处理。</p>' : ''}
      ${!catalog?.recharge_enabled ? '<p role="status">购买暂不可用，请稍后再试。</p>' : ''}
      ${error ? `<p class="notice" role="alert">${esc(error)}</p>` : ''}
      ${error || !recoveryReady ? `<button class="text-button" data-action="credits-refresh" ${loading || writing ? 'disabled' : ''}>刷新重试</button>` : ''}
      `}
    </section></div>`;
  }
  return {
    reset(value) {
      if (identity === value) return false;
      if (timer !== null) cancel(timer);
      if (qrTimer !== null) cancel(qrTimer);
      qrTimer = null;
      identity = value; generation++; account = value ? JSON.parse(value)[0] : null;
      catalog = balance = order = qrImage = selectedAmount = remote = null;
      customText = ''; customQuote = null;
      usage = []; nextUsage = null; usageLoading = false;
      dialogOpen = loading = writing = recoveryReady = false; error = ''; timer = null;
      selectedChannel = 'alipay';
      intent = account ? load() : null;
      if (intent?.payment_channel) selectedChannel = intent.payment_channel;
      return true;
    },
    refresh,
    paymentImage,
    isOpen: () => dialogOpen,
    label: () => displayedBalance() != null ? (amount(displayedBalance()).includes('积分') ? amount(displayedBalance()) : `${amount(displayedBalance())} 点`) : loading ? '读取中…' : '暂不可用',
    async action(action, dataset = {}) {
      if (action === 'credits-open') { dialogOpen = true; notify(); return; }
      if (action === 'credits-dismiss') {
        dialogOpen = false;
        if (!pendingOrder(order) && !intent) { selectedAmount = null; order = null; }
        notify(); return;
      }
      if (action === 'credits-reselect') {
        if (!writing && !pendingOrder(order) && !intent) { order = null; selectedAmount = null; error = ''; notify(); }
        return;
      }
      if (action === 'credits-refresh') return refresh();
      if (action === 'credits-usage-more') return loadUsage();
      if (action === 'credits-channel') {
        if (selectedProduct() && !writing && !pendingOrder(order) && !intent && channels().includes(dataset.channel)) {
          selectedChannel = dataset.channel; notify();
        }
        return;
      }
      if (action === 'credits-custom-change') { if (!writing && !loading && !intent && !pendingOrder(order)) { customText = String(dataset.amount); customQuote = null; notify(); } return; }
      if (action === 'credits-quote') return quoteCustom(dataset.amount);
      if (action === 'credits-custom-buy') return selectProduct('custom');
      if (action === 'credits-buy') return selectProduct(String(dataset.amount));
      if (action === 'credits-confirm') return purchase();
      if (action === 'credits-close-order') return close();
    },
    render() {
      return `<div class="page-content credits-page" ${dialogOpen ? 'inert' : ''}>
        <div class="page-heading"><div><h2>账号积分</h2><p class="muted">查看账号余额，购买的积分长期有效。</p></div></div>
        ${error && !dialogOpen ? `<div class="notice" role="status">${esc(error)}${balance ? ' 当前显示上次读取的余额。' : ''}</div>` : ''}
        <section class="credits-overview"><div><p class="eyebrow">积分余额</p><div class="credits-total">${displayedBalance() != null ? esc(amount(displayedBalance())) : '—'}${displayedBalance() != null && amount(displayedBalance()).includes('积分') ? '' : '<span>点</span>'}</div>
        <p class="muted">积分归当前万象账号所有，跨设备共享。</p></div>
        <div class="credits-recharge"><button class="button primary" data-action="credits-open">购买积分</button>${pendingOrder(order) || intent ? '<p>有一笔购买正在处理中，点击继续查看。</p>' : ''}</div></section>
        ${remoteView()}
        <p class="credits-hint">付款后请等待积分到账，可在购买弹框中查看处理状态。</p>
      </div>${dialog()}`;
    },
  };
}
