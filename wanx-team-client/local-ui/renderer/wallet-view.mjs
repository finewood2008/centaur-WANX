import { creditAtoms, displayCreditAtoms, orderGrantCreditAtoms, validateCreditWallet } from '../../account/credit-wallet.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const pendingOrder = value => value && !['credited', 'closed'].includes(value.display_state);

export function createWalletView({ request, changed, storage = globalThis.localStorage,
  uuid = () => globalThis.crypto.randomUUID(), now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = timer => clearTimeout(timer), qr,
  onTiming = () => {}, monotonic = () => globalThis.performance?.now?.() ?? now() }) {
  let identity = null, account = null, generation = 0, timer = null, qrTimer = null, loading = false, writing = false;
  let catalog = null, balance = null, order = null, dialogOpen = false, selectedAmount = null;
  let error = '', intent = null, qrImage = null, recoveryReady = false, recovering = false;
  let checkingOrder = false, orderReadFailed = false, customAmount = '', customText = '', customQuote = null;
  let backgroundLoading = false, recoveryTask = null, confirmingPurchase = false;
  let cancellationAccepted = false, cancellationClosed = false;
  let selectedChannel = 'alipay', remote = null, usage = [], nextUsage = null, usageLoading = false;
  const channels = () => catalog?.payment_channels?.filter(name => ['alipay', 'wechat'].includes(name)) ?? ['alipay'];
  const key = () => `wanx.credit.purchase.v1:${account}`;
  const data = response => {
    if (response?.schema_version !== '1' || !response.data || !response.request_id) throw new Error('CREDITS_INVALID_RESPONSE');
    return response.data;
  };
  const read = async (name, input) => data(await request(`wallet.${name}`, input));
  const amount = value => displayCreditAtoms(value);
  const notify = () => changed();
  const timing = (stage, started, details = {}) => {
    try { onTiming({ stage, durationMs: Math.max(0, Math.round(monotonic() - started)), ...details }); }
    catch { /* Diagnostics must never interrupt payment recovery. */ }
  };
  const visibleLoading = () => loading && !backgroundLoading;
  const visibleRecovery = () => recovering && !backgroundLoading;
  function message(cause, fallback = '暂时无法连接积分服务，请稍后重试。') {
    const code = cause?.code || cause?.message;
    const messages = { CONTRACT_NOT_CONFIGURED: '积分服务暂未开放，请稍后再试。',
      QEETOKEN_UNAVAILABLE: '余额服务暂不可用，正在重试同步。',
      QEETOKEN_MIGRATION_PENDING: '旧调用正在结算，完成后将同步账号余额。',
      QEETOKEN_SYNC_PENDING: '消费流水正在同步，请稍候。',
      CREDITS_SERVICE_UNAVAILABLE: '积分接口暂不可用，请联系管理员检查服务部署。',
      REVISION_CONFLICT: '商品已调整，请刷新后重新选择。',
      UNSUPPORTED_SCHEMA: '积分购买规则已更新，请重新选择商品或获取报价。',
      VALIDATION_ERROR: '购买金额或商品无效，请重新选择。',
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
        (Number.isSafeInteger(value.custom_amount_fen) && value.custom_amount_fen > 0 && typeof value.custom_recharge_version === 'string') ||
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
    if (qrTimer !== null) cancel(qrTimer);
    const cachedImage = order?.order_id === value.order_id && order?.payment_action?.payload === value.payment_action?.payload ? qrImage : null;
    qrTimer = null; order = value; qrImage = null;
    // Only Admin can release a cancelled purchase while the channel is still
    // closing it. Paid or disputed results must remain visible.
    if (value.purchase_released === true && ['close_pending', 'closed'].includes(value.payment_state) &&
      ['close_pending', 'closed'].includes(value.display_state) && value.fulfillment_state === 'not_due' &&
      ['none', 'resolved'].includes(value.review_state)) {
      if (intent) save(null);
      order = null; cancellationAccepted = true; cancellationClosed = value.payment_state === 'closed';
      return;
    }
    cancellationAccepted = cancellationClosed = false;
    if (value.payment_channel) selectedChannel = value.payment_channel;
    const grant = orderGrantCreditAtoms(value);
    if (intent) {
      if (value.display_state === 'closed' || (value.display_state === 'credited' && grant !== null)) save(null);
      else save({ ...intent, order_id: value.order_id });
    }
    const action = value.payment_action;
    if (!intent?.close_intent_id && action?.type === 'qr' && value.payment_state === 'pending' && now() < Date.parse(value.expires_at) && now() < Date.parse(action.expires_at) && qr) {
      let image = cachedImage;
      if (!image) {
        const qrStarted = monotonic();
        let outcome = 'failed';
        try { image = await qr(action.payload); outcome = 'completed'; }
        finally { timing('qr', qrStarted, { outcome, ready: Boolean(image) }); }
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
      const creating = order?.payment_state === 'creating' && !intent?.close_intent_id;
      timer = schedule(() => { timer = null; void (creating ? refreshOrder() : refresh({ background: true })); },
        creating ? orderReadFailed ? 5000 : 1000 : error || (!pendingOrder(order) && !intent && !remote) ? 30000 : 5000);
      timer?.unref?.();
    }
  }
  async function refreshOrder() {
    if (!identity || recovering || writing || checkingOrder || !pendingOrder(order)) return;
    const g = generation; checkingOrder = true;
    try {
      await acceptOrder(await read('order', { order_id: order.order_id }), g);
      if (g === generation) orderReadFailed = false;
    } catch (cause) { if (g === generation) { orderReadFailed = true; error = message(cause); } }
    finally {
      if (g === generation) {
        checkingOrder = false; notify(); poll();
        if (!pendingOrder(order)) void refresh({ background: true });
      }
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
        await read('createOrder', { purchase_intent_id: intent.purchase_intent_id,
          ...(intent.custom_recharge_version ? { custom_amount_fen: intent.custom_amount_fen, custom_recharge_version: intent.custom_recharge_version }
            : intent.product_id ? { product_id: intent.product_id, product_version: intent.product_version } : { amount_fen: intent.amount_fen }),
          ...(intent.currency_rule_id ? { currency_rule_id: intent.currency_rule_id } : {}),
          ...(intent.payment_channel ? { payment_channel: intent.payment_channel } : {}) });
    } else if (pendingOrder(order)) {
      value = await read('order', { order_id: order.order_id });
    } else {
      const active = await read('orders', { active: true });
      value = active.items[0];
    }
    if (value) await acceptOrder(value, g);
    if (g === generation) orderReadFailed = false;
    // Keep a completed purchase visible until the user chooses another product.
  }
  async function refresh({ background = false } = {}) {
    if (!identity || loading || writing || checkingOrder) return;
    const g = generation, previousError = error;
    let failure = '';
    loading = recovering = true; backgroundLoading = background && Boolean(catalog);
    if (!backgroundLoading) error = '';
    notify();
    try {
      // Recover the original purchase even when balance or catalog reads fail.
      recoveryTask = (async () => {
        try { await recover(g); if (g === generation) recoveryReady = true; }
        catch (cause) {
          if (g === generation) {
            discardRejectedIntent(cause); recoveryReady = false; orderReadFailed = true; failure = message(cause);
            if (!backgroundLoading) error = failure;
          }
        } finally { if (g === generation) { recovering = false; notify(); } }
      })();
      await recoveryTask;
      if (g !== generation) return;
      recoveryTask = null;
      if (order?.payment_state === 'creating') poll();
      const [, b] = await Promise.all([read('catalog').then(c => {
        if (g !== generation) return;
        catalog = c;
        if (!pendingOrder(order) && !intent && !channels().includes(selectedChannel)) selectedChannel = channels()[0];
        notify();
      }), read('balance')]);
      if (g !== generation) return;
      creditAtoms(b.balance_credit_atoms); creditAtoms(b.debt_credit_atoms);
      if (!Number.isSafeInteger(b.ledger_sequence) || b.ledger_sequence < 0) throw new Error('CREDITS_INVALID_RESPONSE');
      let q = null, u = null;
      if (b.billing_backend === 'qeetoken') {
        u = await read('usage', { limit: 20 });
        if (g !== generation) return;
        q = await read('wallet');
        if (g !== generation) return;
        validateUsage(u); if (q.view_version === '2') validateCreditWallet(q, account); else validateWalletLegacy(q);
        if (q.view_version === '2' && q.sync_state !== 'pending' && BigInt(u.remote_sequence) > BigInt(q.remote_sequence)) {
          q = { ...q, sync_state: 'stale' }; u = null;
        }
      }
      if (!remote || !q || BigInt(q.remote_sequence) >= BigInt(remote.remote_sequence)) {
        remote = q;
        if (u) { usage = u.items; nextUsage = u.next_before_sequence; }
      }
      if (!balance || b.ledger_sequence >= balance.ledger_sequence) balance = b;
    } catch (cause) { if (g === generation) failure = message(cause); }
    finally {
      if (g === generation) {
        if (failure) error = failure;
        else if (backgroundLoading && error === previousError) error = '';
        loading = recovering = backgroundLoading = false; recoveryTask = null; notify(); poll();
      }
    }
  }
  function validateWalletLegacy(q) {
    if (q.account_id !== account || q.currency_rule_id !== 'usd-credit-1-v1' || q.currency !== 'USD' || q.currency_scale !== 8 || q.credit_scale !== 6 || q.usd_per_credit !== '1' ||
        !['pending', 'stale', 'synced'].includes(q.sync_state) || !Number.isSafeInteger(q.pending_executions) || q.pending_executions < 0 ||
        typeof q.remote_sequence !== 'string' || !/^(0|[1-9][0-9]*)$/.test(q.remote_sequence)) throw new Error('CREDITS_INVALID_RESPONSE');
    if (q.sync_state === 'pending') {
      if (q.balance_credit_atoms !== null || q.balance_usd_atoms !== null) throw new Error('CREDITS_INVALID_RESPONSE');
    } else {
      creditAtoms(q.balance_credit_atoms); creditAtoms(q.balance_usd_atoms); creditAtoms(q.spent_usd_atoms);
      if (!Number.isFinite(Date.parse(q.synced_at))) throw new Error('CREDITS_INVALID_RESPONSE');
    }
  }
  function validateUsage(value) {
    if (value.view_version === undefined) {
      if (!Array.isArray(value.items) || value.items.length > 100 || (value.next_before_sequence !== null && !/^[1-9][0-9]*$/.test(value.next_before_sequence))) throw new Error('CREDITS_INVALID_RESPONSE');
      for (const item of value.items) {
        creditAtoms(item.debit_usd_atoms); creditAtoms(item.debit_credit_atoms);
        if (!Number.isFinite(Date.parse(item.occurred_at)) || !/^[1-9][0-9]*$/.test(item.account_sequence)) throw new Error('CREDITS_INVALID_RESPONSE');
      }
      return;
    }
    if (value.view_version !== '2' || value.account_id !== account || value.currency_rule_id !== 'usd-credit-100-v2' || value.credit_scale !== 6 ||
        typeof value.remote_sequence !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.remote_sequence) ||
        !Array.isArray(value.items) || value.items.length > 100 || (value.next_before_sequence !== null && !/^[1-9][0-9]*$/.test(value.next_before_sequence))) throw new Error('CREDITS_INVALID_RESPONSE');
    let previous = BigInt(value.remote_sequence) + 1n;
    for (const item of value.items) {
      creditAtoms(item.debit_credit_atoms);
      if (!Number.isFinite(Date.parse(item.occurred_at)) || !/^[1-9][0-9]*$/.test(item.account_sequence) || BigInt(item.account_sequence) >= previous ||
          typeof item.device_id !== 'string' || typeof item.model !== 'string') throw new Error('CREDITS_INVALID_RESPONSE');
      previous = BigInt(item.account_sequence);
    }
  }
  const displayedBalance = () => remote ? remote.balance_credit_atoms : balance?.billing_backend === 'qeetoken' ? null : balance?.balance_credit_atoms;
  const date = value => new Intl.DateTimeFormat('zh-CN', { timeZone: catalog?.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
  async function loadUsage() {
    if (!identity || usageLoading || !nextUsage) return;
    const g = generation, cursor = nextUsage; usageLoading = true;
    try {
      const value = await read('usage', { before_sequence: cursor, limit: 20 });
      if (g !== generation || cursor !== nextUsage) return;
      validateUsage(value); usage.push(...value.items); nextUsage = value.next_before_sequence;
    } catch (cause) { if (g === generation) error = message(cause); }
    finally { if (g === generation) { usageLoading = false; notify(); } }
  }
  function remoteView() {
    if (!remote) return '';
    if (remote.currency_rule_id === 'usd-credit-1-v1') return legacyRemoteView();
    const state = remote.sync_state === 'pending' ? '余额初始化中' : remote.sync_state === 'stale' || error ? '显示上次同步余额' : '余额已同步';
    return `<section aria-label="余额同步状态"><p>${esc(state)}${remote.synced_at ? ` · ${esc(date(remote.synced_at))}` : ''}</p>
      ${registrationView()}
      ${typeof remote.spent_credit_atoms === 'string' ? `<p class="muted">累计消耗 ${esc(displayCreditAtoms(remote.spent_credit_atoms, 'consumption'))} · 已纠正 ${esc(displayCreditAtoms(remote.correction_credit_atoms))} · 净消耗 ${esc(displayCreditAtoms(remote.net_spent_credit_atoms, 'consumption'))}</p>` : ''}
      ${remote.pending_executions ? `<p role="status">${esc(remote.pending_executions)} 笔调用正在结算或核对，最终消耗以结算结果为准。</p>` : ''}</section>
      <section class="wallet-usage" aria-label="消费流水"><h3>消费流水</h3>${usage.length ? `<div class="wallet-usage-scroll" tabindex="0" aria-label="可滚动消费记录"><table><thead><tr><th>时间</th><th>盒子</th><th>模型</th><th>消耗积分</th></tr></thead><tbody>${usage.map(item => `<tr><td>${esc(date(item.occurred_at))}</td><td>${esc(item.device_id)}</td><td>${esc(item.model)}</td><td>${esc(displayCreditAtoms(item.debit_credit_atoms, 'consumption'))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">暂无已结算消费。</p>'}
      ${nextUsage ? `<button class="text-button" data-action="credits-usage-more" ${usageLoading ? 'disabled' : ''}>查看更多</button>` : ''}</section>`;
  }
  const usd = value => { const atoms = creditAtoms(value), magnitude = atoms < 0n ? -atoms : atoms;
    return `${atoms < 0n ? '-' : ''}${magnitude / 100000000n}.${String(magnitude % 100000000n).padStart(8, '0')}`; };
  function legacyRemoteView() {
    const state = remote.sync_state === 'pending' ? '余额初始化中' : remote.sync_state === 'stale' || error ? '显示上次同步余额' : '余额已同步';
    return `<section aria-label="余额同步状态"><p>${esc(state)}${remote.synced_at ? ` · ${esc(date(remote.synced_at))}` : ''}</p>
      <p class="muted">1 USD = 1 积分${remote.balance_usd_atoms !== null ? ` · 余额 $${esc(usd(remote.balance_usd_atoms))} · 累计消耗 $${esc(usd(remote.spent_usd_atoms))}` : ''}</p>
      ${remote.pending_executions ? `<p role="status">${esc(remote.pending_executions)} 笔调用正在结算或核对，最终消耗以结算结果为准。</p>` : ''}</section>
      <section class="wallet-usage" aria-label="消费流水"><h3>消费流水</h3>${usage.length ? `<div class="wallet-usage-scroll" tabindex="0" aria-label="可滚动消费记录"><table><thead><tr><th>时间</th><th>盒子</th><th>模型</th><th>输入 / 输出 tokens</th><th>消耗积分</th></tr></thead><tbody>${usage.map(item => `<tr><td>${esc(date(item.occurred_at))}</td><td>${esc(item.device_id)}</td><td>${esc(item.model)}</td><td>${esc(item.input_tokens)} / ${esc(item.output_tokens)}</td><td>${esc(displayCreditAtoms(item.debit_credit_atoms, 'consumption'))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">暂无已结算消费。</p>'}
      ${nextUsage ? `<button class="text-button" data-action="credits-usage-more" ${usageLoading ? 'disabled' : ''}>查看更多</button>` : ''}</section>`;
  }
  function registrationView() {
    const grant = remote?.registration_grant;
    if (!grant) return '';
    const labels = { queued: '注册赠送待到账', running: '注册赠送处理中', retry_wait: '注册赠送正在重试',
      review_required: '注册赠送待核对', credited: '注册赠送已到账', historical_received: '历史注册赠送已领取',
      waiting_migration: '注册赠送资格已核实，等待处理' };
    return `<p role="status">${esc(labels[grant.state] || grant.state)}${grant.credit_display ? ` · ${esc(amount(grant.credit_display.grant_credit_atoms))} 新积分` : ''}</p>`;
  }
  const products = () => catalog?.products?.length ? catalog.products : (catalog?.tiers || []);
  const productKey = product => product.product_id || String(product.amount_fen);
  const locked = () => writing || confirmingPurchase || Boolean(pendingOrder(order) || intent);
  const customRule = () => {
    const v2 = catalog?.custom_amount;
    if (v2 === true) return { enabled: true, version: 'usd-credit-100-v2', min_amount_fen: 1000, max_amount_fen: 100000, points_per_yuan: '100' };
    if (v2 && typeof v2 === 'object' && Number.isSafeInteger(v2.min_fen) && Number.isSafeInteger(v2.max_fen) &&
        Number.isSafeInteger(v2.step_fen) && v2.min_fen >= 1000 && v2.max_fen >= v2.min_fen && v2.step_fen > 0) {
      return { enabled: true, version: 'usd-credit-100-v2', min_amount_fen: v2.min_fen, max_amount_fen: v2.max_fen, step_fen: v2.step_fen, points_per_yuan: '100' };
    }
    const rule = catalog?.custom_recharge;
    return rule?.enabled && rule.points_per_yuan === '100' && typeof rule.version === 'string' &&
      Number.isSafeInteger(rule.min_amount_fen) && rule.min_amount_fen >= 1 &&
      Number.isSafeInteger(rule.max_amount_fen) && rule.max_amount_fen >= rule.min_amount_fen && rule.max_amount_fen <= 10000000000 ? rule : null;
  };
  const customFen = () => {
    const rule = customRule(), match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(customAmount.trim());
    if (!rule || !match) return null;
    const fen = Number(BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0')));
    return fen >= rule.min_amount_fen && fen <= rule.max_amount_fen ? fen : null;
  };
  async function quoteCustom(value) {
    const rule = customRule();
    if (!identity || locked() || visibleLoading() || !catalog?.recharge_enabled || !rule || catalog?.currency_rule_id !== 'usd-credit-100-v2') return;
    customText = String(value); customAmount = customText; customQuote = null; selectedAmount = 'custom'; error = '';
    const amountFen = Number(customText) * 100;
    if (!/^[1-9][0-9]{1,3}$/.test(customText) || amountFen < rule.min_amount_fen || amountFen > rule.max_amount_fen || amountFen % rule.step_fen !== 0) {
      error = message({ code: 'VALIDATION_ERROR' }); notify(); return;
    }
    const g = generation, requested = amountFen;
    writing = true; notify();
    try {
      const value = await read('quote', { amount_fen: requested });
      if (g !== generation || value.view_version !== '2' || value.currency_rule_id !== 'usd-credit-100-v2' || typeof value.rule_id !== 'string' || value.credit_scale !== 6 ||
          value.amount_fen !== requested || creditAtoms(value.grant_credit_atoms) <= 0n) throw new Error('CREDITS_INVALID_RESPONSE');
      customQuote = value;
    } catch (cause) { if (g === generation) error = message(cause); }
    finally { if (g === generation) { writing = false; notify(); } }
  }
  const draft = () => {
    if (selectedAmount === 'custom') {
      if (customQuote) return { ...customQuote, target: { amount_fen: customQuote.amount_fen, currency_rule_id: 'usd-credit-100-v2' } };
      if (catalog?.currency_rule_id === 'usd-credit-100-v2') return null;
      const fen = customFen();
      return fen === null ? null : { amount_fen: fen, grant_credit_atoms: (BigInt(fen) * 1000000n).toString(),
        target: { custom_amount_fen: fen, custom_recharge_version: customRule().version } };
    }
    const product = products().find(item => productKey(item) === selectedAmount && item.enabled !== false);
    return product ? { ...product, target: product.product_id
      ? { product_id: product.product_id, product_version: product.version, ...(catalog.currency_rule_id ? { currency_rule_id: catalog.currency_rule_id } : {}) }
      : { amount_fen: product.amount_fen, ...(catalog.currency_rule_id ? { currency_rule_id: catalog.currency_rule_id } : {}) } } : null;
  };
  function select(value) {
    if (locked()) return;
    selectedAmount = value; order = null; cancellationAccepted = cancellationClosed = false; error = ''; dialogOpen = true; notify();
  }
  async function purchase(selection = draft(), channel = selectedChannel) {
    if (!identity || !recoveryReady || recovering || checkingOrder || locked() || !catalog?.recharge_enabled || !selection || !channels().includes(channel)) return;
    const g = generation; writing = true; error = ''; dialogOpen = true; order = null; cancellationAccepted = false; notify();
    const confirmStarted = monotonic();
    let outcome = 'failed';
    try {
      if (!intent) save({ purchase_intent_id: uuid(), ...selection.target,
        ...(catalog.payment_channels ? { payment_channel: channel } : {}) });
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
    if (!order || writing || recovering || checkingOrder || order.payment_state === 'paid') return;
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
  const checkoutStep = () => {
    if (order?.review_state === 'open' || (order?.display_state === 'credited' && orderGrantCreditAtoms(order) === null)) return 'payment';
    return cancellationAccepted || ['credited', 'closed'].includes(order?.display_state) ? 'result' : order || intent || confirmingPurchase ? 'payment' : 'selection';
  };
  function paymentView() {
    const state = order?.display_state;
    const expired = order && (now() >= Date.parse(order.expires_at) ||
      (order.payment_action && now() >= Date.parse(order.payment_action.expires_at)));
    const selection = draft();
    const grant = order ? orderGrantCreditAtoms(order) : selection?.grant_credit_atoms;
    const grantText = grant == null ? '' : amount(grant);
    let title = selection ? '确认购买' : '选择充值金额', description = selection
      ? `应付 ¥${selection.amount_fen / 100} · 到账 ${amount(selection.grant_credit_atoms)} 点积分`
      : '选择商品或输入自定义金额，选择支付方式后确认购买。', success = false;
    if (cancellationAccepted) {
      title = cancellationClosed ? '订单已取消' : '取消请求已受理';
      description = cancellationClosed ? '您已取消本次支付，可重新选择充值商品。' : '请勿继续支付原付款码；如已付款，我们会继续确认到账。';
    } else if (order?.review_state === 'open') {
      title = '支付结果待核对';
      description = `${order.payment_state === 'paid' ? '已支付。' : '付款结果尚待核实。'}${order.fulfillment_state === 'credited' ? '积分已到账。' : '积分到账情况正在核对。'}请勿重复支付。`;
    } else if (state === 'credited') {
      title = '积分已到账'; description = grant === null ? '到账积分待核对，请稍后刷新。' : `${grantText} 点积分已记入当前账号。`; success = grant !== null;
    } else if (order?.payment_state === 'paid') {
      title = '支付成功，积分到账中'; description = '正在更新积分余额，请勿重复支付。关闭弹框后仍会继续确认到账。';
    } else if (state === 'closed') {
      title = '订单已取消'; description = '可以重新选择积分商品，生成新的付款码。';
    } else if (intent?.close_intent_id || order?.payment_state === 'close_pending') {
      title = '关闭确认中'; description = '正在确认原付款码已失效，确认后即可重新选择。请勿继续支付原付款码。';
    } else if (expired) {
      title = '付款码已到期'; description = '正在确认支付或关闭结果，确认前请勿重复购买。';
    } else if (order && grant === null) {
      title = '到账积分待核对'; description = '本次购买的积分数额正在核对，请稍后刷新或取消本次购买。';
    } else if (paymentImage()) {
      const wechat = order.payment_action.payload.startsWith('weixin://');
      title = wechat ? '微信扫码支付' : '支付宝扫码支付'; description = `应付 ¥${order.amount_fen / 100} · 到账 ${grantText} 点积分`;
    } else if (confirmingPurchase) {
      title = '正在确认购买'; description = '正在确认当前订单状态，请稍候。';
    } else if (order?.payment_state === 'creating' || writing) {
      title = '正在生成付款码'; description = '请稍候，付款码生成后会显示在下方。';
    } else if (intent && !order) {
      title = '购买结果确认中'; description = '已保留本次购买，正在恢复付款结果，请勿重复购买。';
    } else if (order?.payment_state === 'pending') {
      title = '正在获取付款码'; description = '正在恢复本次购买，请稍候或刷新支付状态。';
    } else if (!catalog?.recharge_enabled || (!products().length && !customRule())) {
      title = visibleLoading() ? '正在读取商品' : '购买暂不可用'; description = visibleLoading() ? '请稍候。' : '积分购买暂未开放，请稍后再试。';
    }
    const step = checkoutStep(), payable = paymentImage();
    const deadline = payable ? Math.min(Date.parse(order.expires_at), Date.parse(order.payment_action.expires_at)) : null;
    const seconds = deadline === null ? 0 : Math.max(0, Math.ceil((deadline - now()) / 1000));
    const countdown = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    const cancelled = cancellationAccepted || state === 'closed';
    return `<section class="wallet-payment ${success ? 'is-success' : ''} ${step === 'selection' ? 'is-selection' : ''}" aria-label="支付进度">
      ${step === 'selection' && catalog?.recharge_enabled && (products().length || customRule()) ? '' : `<div class="wallet-payment-status" role="status" aria-live="polite">${!payable && step !== 'selection' ? `<div class="wallet-payment-mark" aria-hidden="true">${success ? '✓' : cancelled ? '×' : '…'}</div>` : ''}<h3>${esc(title)}</h3><p>${esc(description)}</p></div>`}
      ${payable ? `<div class="wallet-qr-frame" data-channel="${selectedChannel}"><img class="wallet-qr" alt="积分支付二维码" src="${esc(qrImage)}"></div>
        <p class="wallet-scan-hint">请使用手机${selectedChannel === 'wechat' ? '微信' : '支付宝'}扫码完成支付</p>
        <div class="wallet-payment-clock"><span>剩余支付时间</span><strong data-wallet-deadline="${deadline}" role="timer" aria-live="off">${countdown}</strong><span>等待支付，付款后自动更新</span></div>` : ''}
      ${error ? `<p class="notice" role="alert">${esc(error)}</p>` : ''}
      ${step === 'selection' ? `<div class="wallet-checkout-total"><span>应付金额<strong>${selection ? `¥${selection.amount_fen / 100}` : '—'}</strong></span><span>${selection ? `到账 ${esc(amount(selection.grant_credit_atoms))} 积分` : '请选择商品或获取自定义报价'}</span></div>` : ''}
      <div class="wallet-payment-actions">
        ${step === 'selection' ? `<button class="button primary wallet-pay" data-action="credits-pay" ${!selection || locked() || !catalog?.recharge_enabled || !recoveryReady || visibleRecovery() || checkingOrder || !channels().includes(selectedChannel) ? 'disabled' : ''}>确认购买</button>` : ''}
        ${(step === 'payment' && (order || intent || error)) || error ? `<button class="text-button" data-action="credits-refresh" ${visibleLoading() || writing || checkingOrder ? 'disabled' : ''}>${visibleLoading() ? '正在确认…' : '刷新支付状态'}</button>` : ''}
        ${step === 'payment' && order && ['creating', 'pending'].includes(order.payment_state) && !intent?.close_intent_id ? `<button class="button wallet-cancel" data-action="credits-close-order" ${visibleRecovery() || checkingOrder || writing ? 'disabled' : ''}>取消订单</button>` : ''}
        ${step === 'result' ? `<button class="button primary" data-action="credits-result-confirm">${success ? '完成' : '确认'}</button>` : ''}
      </div>
      ${pendingOrder(order) || intent ? '<p class="wallet-payment-footnote">关闭窗口后仍可继续查看支付结果</p>' : ''}
    </section>`;
  }
  function dialog() {
    if (!dialogOpen) return '';
    const step = checkoutStep();
    const selected = pendingOrder(order) ? (intent?.custom_recharge_version || (intent?.currency_rule_id && !intent?.product_id)) ? 'custom' : intent?.product_id || String(order.amount_fen) : selectedAmount;
    const rule = customRule();
    const invalidAmount = selectedAmount === 'custom' && customAmount !== '' && customFen() === null;
    return `<div class="wallet-modal"><section class="wallet-purchase-dialog" data-step="${step}" role="dialog" aria-modal="true" aria-labelledby="wallet-purchase-title" tabindex="-1">
      <header class="wallet-purchase-heading"><div><h2 id="wallet-purchase-title">${step === 'selection' ? '购买积分' : step === 'payment' ? '订单支付' : '订单结果'}</h2><p>${step === 'selection' ? '选择充值金额与支付方式，充值积分长期有效' : step === 'payment' ? '请核对金额后扫码支付' : '本次购买的处理结果'}</p></div><button class="wallet-dialog-close" data-action="credits-dismiss" aria-label="关闭购买弹框">×</button></header>
      ${step === 'selection' ? `
      <div class="wallet-products" aria-label="积分商品">${products().map(tier => `<button class="wallet-product" data-action="credits-buy" data-amount="${esc(productKey(tier))}" aria-pressed="${selected === productKey(tier)}" ${!catalog?.recharge_enabled || tier.enabled === false || locked() ? 'disabled' : ''}>
        ${tier.name ? `<span>${esc(tier.name)}</span>` : ''}<span class="wallet-product-points">${esc(amount(tier.grant_credit_atoms))}<small>点积分</small></span><strong>¥${tier.amount_fen / 100}</strong><span class="wallet-product-selection">${selected === productKey(tier) ? '已选择' : '选择商品'}</span></button>`).join('')}</div>
      ${catalog?.custom_amount ? `<div class="wallet-custom" data-selected="${selected === 'custom'}">
        <label for="wallet-custom-amount">自定义金额（10～1000 整数元）</label>
        <input id="wallet-custom-amount" data-wallet-input="custom-amount" inputmode="numeric" autocomplete="off" maxlength="4" value="${esc(customText)}" ${locked() ? 'disabled' : ''}>
        <button class="button" data-action="credits-quote" ${!catalog.recharge_enabled || locked() ? 'disabled' : ''}>获取报价</button>
        ${customQuote ? `<p>支付 ¥${customQuote.amount_fen / 100} · 到账 ${esc(amount(customQuote.grant_credit_atoms))} 积分</p><button class="button" data-action="credits-custom-buy" aria-pressed="${selected === 'custom'}" ${locked() ? 'disabled' : ''}>${selected === 'custom' ? '已选择自定义金额' : '选择此金额'}</button>` : ''}
      </div>` : `<div class="wallet-custom" data-selected="${selected === 'custom'}">
        <button class="text-button" data-action="credits-custom" aria-pressed="${selected === 'custom'}" ${!catalog?.recharge_enabled || !rule || locked() ? 'disabled' : ''}>自定义金额</button>
        <label for="wallet-custom-amount">¥ <input id="wallet-custom-amount" type="text" inputmode="decimal" autocomplete="off" maxlength="12" placeholder="输入金额（元）" aria-label="自定义充值金额（元）" aria-describedby="wallet-custom-hint" aria-invalid="${invalidAmount}" value="${esc(customAmount)}" ${!catalog?.recharge_enabled || !rule || locked() ? 'disabled' : ''}></label>
        <p id="wallet-custom-hint" ${invalidAmount ? 'role="status"' : ''}>${!rule ? '自定义充值暂不可用' : invalidAmount ? `请输入 ¥${rule.min_amount_fen / 100} 至 ¥${rule.max_amount_fen / 100} 的金额，最多两位小数。` : `1 元兑换 100 积分${selectedAmount === 'custom' && customFen() !== null ? ` · 可得 ${amount((BigInt(customFen()) * 1000000n).toString())} 点积分` : ''}`}</p>
      </div>`}
      <div class="wallet-channel-section"><h3>支付方式</h3>      <div class="wallet-payment-actions wallet-channel-picker" aria-label="支付方式">${channels().map(channel => `<button class="button ${selectedChannel === channel ? 'primary' : ''}" data-action="credits-channel" data-channel="${channel}" aria-pressed="${selectedChannel === channel}" ${locked() ? 'disabled' : ''}>${channel === 'wechat' ? '微信支付' : '支付宝'}</button>`).join('')}</div></div>` : ''}
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
      catalog = balance = order = qrImage = selectedAmount = remote = null;
      usage = []; nextUsage = null; usageLoading = false;
      dialogOpen = loading = writing = recoveryReady = recovering = checkingOrder = orderReadFailed = false; error = ''; timer = null; customAmount = ''; customText = ''; customQuote = null;
      backgroundLoading = confirmingPurchase = cancellationAccepted = cancellationClosed = false; recoveryTask = null;
      selectedChannel = 'alipay';
      intent = account ? load() : null;
      if (intent?.payment_channel) selectedChannel = intent.payment_channel;
      if (intent?.custom_recharge_version) { selectedAmount = 'custom'; customAmount = String(intent.custom_amount_fen / 100); }
      if (intent?.currency_rule_id && !intent?.product_id) { selectedAmount = 'custom'; customText = String(intent.amount_fen / 100); }
      return true;
    },
    refresh,
    paymentImage,
    isOpen: () => dialogOpen,
    label: () => displayedBalance() != null ? `${amount(displayedBalance())} 点` : visibleLoading() ? '读取中…' : '暂不可用',
    async action(action, dataset = {}) {
      if (action === 'credits-open') { dialogOpen = true; notify(); return; }
      if (action === 'credits-dismiss') { dialogOpen = false; if (checkoutStep() === 'result' && !pendingOrder(order)) { order = null; cancellationAccepted = cancellationClosed = false; } notify(); return; }
      if (action === 'credits-result-confirm' && checkoutStep() === 'result' && !pendingOrder(order)) { order = null; cancellationAccepted = cancellationClosed = false; error = ''; notify(); return; }
      if (action === 'credits-refresh') return refresh();
      if (action === 'credits-usage-more') return loadUsage();
      if (action === 'credits-channel') {
        if (!locked() && channels().includes(dataset.channel)) {
          selectedChannel = dataset.channel; notify();
        }
        return;
      }
      if (action === 'credits-buy' && products().some(item => productKey(item) === String(dataset.amount) && item.enabled !== false)) return select(String(dataset.amount));
      if (action === 'credits-custom' && customRule()) return select('custom');
      if (action === 'credits-custom-change') { if (!locked()) { customText = String(dataset.amount ?? dataset.value); customAmount = customText; customQuote = null; notify(); } return; }
      if (action === 'credits-quote') return quoteCustom(dataset.amount ?? customText);
      if (action === 'credits-custom-buy' && customQuote) return select('custom');
      if (action === 'credits-amount' && customRule() && !locked()) { customAmount = String(dataset.value).slice(0, 12); return select('custom'); }
      if (action === 'credits-confirm') action = 'credits-pay';
      if (action === 'credits-pay' || action === 'credits-close-order') {
        const g = generation;
        if (action === 'credits-pay' && backgroundLoading && recoveryTask) {
          const selection = draft(), channel = selectedChannel;
          if (!selection || writing || pendingOrder(order) || intent) return;
          confirmingPurchase = true; notify();
          try {
            await recoveryTask;
            if (g !== generation) return;
            confirmingPurchase = false;
            return await purchase(selection, channel);
          } finally { if (g === generation) { confirmingPurchase = false; notify(); } }
        }
        if (backgroundLoading && recoveryTask) await recoveryTask;
        if (g !== generation) return;
        return action === 'credits-pay' ? purchase() : close();
      }
    },
    render() {
      return `<div class="page-content credits-page" ${dialogOpen ? 'inert' : ''}>
        <div class="page-heading"><div><h2>账号积分</h2><p class="muted">查看账号余额，购买的积分长期有效。</p></div></div>
        ${error && !dialogOpen ? `<div class="notice" role="status">${esc(error)}${balance ? ' 当前显示上次读取的余额。' : ''}</div>` : ''}
        <section class="credits-overview"><div><p class="eyebrow">积分余额</p><div class="credits-total">${displayedBalance() != null ? esc(amount(displayedBalance())) : '—'}<span>点</span></div>
        <p class="muted">积分归当前万象账号所有，跨设备共享。</p></div>
        <div class="credits-recharge"><button class="button primary" data-action="credits-open">购买积分</button>${pendingOrder(order) || intent ? '<p>有一笔购买正在处理中，点击继续查看。</p>' : ''}</div></section>
        ${remoteView()}
        <p class="credits-hint">付款后请等待积分到账，可在购买弹框中查看处理状态。</p>
      </div>${dialog()}`;
    },
  };
}
