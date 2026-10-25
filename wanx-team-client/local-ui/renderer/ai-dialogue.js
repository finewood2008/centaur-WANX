(function () {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const active = answer => ['queued', 'running'].includes(answer.status);
  const running = session => Boolean(session?.groups?.some(g => g.answers.some(active)));
  function trail(session, answerId) {
    const items = [], seen = new Set();
    while (answerId && !seen.has(answerId)) {
      seen.add(answerId);
      const group = session?.groups?.find(g => g.answers.some(a => a.id === answerId));
      if (!group) break;
      items.unshift({ group, answer: group.answers.find(a => a.id === answerId) });
      answerId = group.parent_answer;
    }
    return items;
  }
  const errors = {
    BOX_CONNECTION_REQUIRED: '连接一台盒子，即可开始 AI 对话。',
    DIALOGUE_API_NOT_INSTALLED: '当前盒子尚未安装 AI 对话接口，请更新盒子后重试。',
    DIALOGUE_ACCESS_DENIED: '当前账号暂时没有 AI 对话权限，请检查盒子授权。',
    GATEWAY_NOT_CONFIGURED: '盒子尚未配置模型服务，请联系管理员完成配置。',
    GATEWAY_UNAVAILABLE: '模型服务暂时不可用，已发送的任务不会自动重复调用。',
    MODEL_UNAVAILABLE: '这个模型当前不可用，请刷新模型列表。',
    CONTEXT_LIMIT: '当前对话超出模型的上下文容量，请开启新对话。已有内容会保留。',
    ANSWER_NOT_COMPLETE: '请等待回答结束，或重新生成后继续。',
    CONCURRENCY_LIMIT: '当前回答任务较多，请稍后再试。',
    UPSTREAM_UNAVAILABLE: '模型暂未完成回答，可以点击重新生成。',
    INCOMPLETE_STREAM: '回答中断，已收到的内容会保留。',
    SERVICE_RESTARTED: '盒子服务重启使回答中断，已有内容已保留。',
    DIALOGUE_CONTEXT_CHANGED: '账号或盒子连接已改变，请刷新后继续。',
  };
  const errorText = code => errors[code] || '操作暂未完成，请刷新连接后重试。';
  function icon(model) {
    const name = `${model?.name || ''} ${model?.provider || ''}`.toLowerCase();
    const brands = [['deepseek', /deepseek/], ['anthropic', /claude|anthropic/], ['gemini', /gemini|google/], ['moonshot', /kimi|moonshot/], ['dashscope', /qwen|千问|通义|dashscope/], ['zhipu', /glm|智谱|zhipu/], ['minimax', /minimax/], ['volces', /doubao|豆包|volces/], ['ollama', /ollama/], ['openai', /openai|gpt|chatgpt|o[134]-/]];
    const brand = brands.find(([, pattern]) => pattern.test(name))?.[0];
    return brand ? `<img src="./assets/model-icons/${brand}.${brand === 'moonshot' ? 'webp' : brand === 'volces' ? 'svg' : 'png'}" alt="" />`
      : `<span aria-hidden="true">${escape(Array.from(model?.name || 'AI').slice(0, 2).join(''))}</span>`;
  }
  function richText(text) {
    return String(text || '').split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g).map(part => {
      if (part.startsWith('```')) return `<pre><code>${escape(part.replace(/^```[^\n]*\n/, '').replace(/```$/, ''))}</code></pre>`;
      return escape(part).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    }).join('');
  }
  function isLocalModel(model) {
    if (typeof model.is_local === 'boolean') return model.is_local;
    // Compatibility for older boxes with explicitly labelled local runtimes.
    return ['local', 'ollama_local', 'onnx_local'].includes(model.source) ||
      /本机|本地/.test(`${model.name || ''} ${model.provider || ''}`) ||
      /^(?:ollama|onnx)(?: \(local\))?$/i.test(model.provider || '');
  }
  window.wanxDialogueState = { trail, richText, isLocalModel };
  window.createAIDialogueView = ({ request, onBoxes }) => {
    let root = null, context = null, scope = null, generation = 0, visible = false, connected = false;
    let models = [], sessions = [], session = null, selected = [], parentId = null, boxName = '', error = null;
    let loading = false, loaded = false, busy = false, historyOpen = false, pending = null, watchingId = null;
    let configuredModels = 0, visibilityConfigured = false;
    let draft = '', conversationEpoch = 0, opening = false, historyQuery = '', displayName = '';
    const $ = selector => root?.querySelector(selector);
    async function call(method, input = {}) {
      const result = await request(`dialogue.${method}`, input);
      if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
      return result.value;
    }
    function stopWatch() {
      if (scope && watchingId) void call('unwatch', { scope }).catch(() => {});
      watchingId = null;
    }
    async function watch() {
      if (!visible || !scope || !session || !running(session) || watchingId === session.id) return;
      const expected = generation, sid = session.id; watchingId = sid;
      try { await call('watch', { scope, sessionId: sid }); }
      catch { if (expected === generation && watchingId === sid) { watchingId = null; error = '回答连接中断，点击刷新读取已生成的内容。'; paintNotice(); } }
    }
    function accept(value, choose = false) {
      if (!value || session?.id === value.id && Number(value.revision) < Number(session.revision)) return;
      session = value;
      if (choose || !value.groups.some(g => g.answers.some(a => a.id === parentId))) parentId = value.groups.at(-1)?.answers[0]?.id || null;
      const index = sessions.findIndex(s => s.session_id === value.id);
      const item = { session_id: value.id, title: value.title, updated_at: Date.now() / 1000 };
      if (index >= 0) sessions.splice(index, 1);
      sessions.unshift(item);
      paintMessages(); paintHistory(); paintComposer();
    }
    function reset() {
      conversationEpoch++; opening = false;
      stopWatch(); scope = null; models = []; sessions = []; session = null; selected = []; parentId = null;
      loading = false; loaded = false; busy = false; pending = null; draft = ''; historyQuery = ''; displayName = ''; error = null; configuredModels = 0; visibilityConfigured = false;
      if ($('textarea')) $('textarea').value = '';
      if ($('[data-chat-search]')) $('[data-chat-search]').value = '';
    }
    async function load() {
      if (!connected || loading || busy || pending) return;
      loading = true; error = null; const expected = generation; paint();
      try {
        const result = await call('load');
        if (expected !== generation) return;
        scope = result.scope; configuredModels = result.models.filter(model => !isLocalModel(model)).length; visibilityConfigured = Array.isArray(result.visibleModelIds); models = result.models.filter(model => !isLocalModel(model) && (!Array.isArray(result.visibleModelIds) || result.visibleModelIds.includes(model.id))); sessions = result.sessions; loaded = true;
        selected = selected.filter(id => models.some(m => m.id === id));
        if (!selected.length && models.length) selected = [models.find(m => /deepseek/i.test(m.name))?.id || models[0].id];
        if (session && selected[0] !== selectedParent()?.model) newConversation(false);
        if (session && !opening && !busy && !pending) await open(session.id, false);
      } catch (e) { if (expected === generation) error = errorText(e.code); }
      finally { if (expected === generation) { loading = false; paint(); } }
    }
    async function open(id, choose = true) {
      if (pending || busy || !scope) return;
      stopWatch(); const expected = generation, turn = ++conversationEpoch; opening = true; paintComposer();
      try {
        const result = await call('open', { scope, sessionId: id });
        if (expected !== generation || turn !== conversationEpoch) return;
        error = null; accept(result.session, choose);
        if (choose) {
          const answer = session.groups.at(-1)?.answers[0];
          selected = models.some(m => m.id === answer?.model) ? [answer.model] : [];
        }
        paint(); await watch();
      } catch (e) { if (expected === generation && turn === conversationEpoch) { error = errorText(e.code); paintNotice(); } }
      finally { if (expected === generation && turn === conversationEpoch) { opening = false; paintComposer(); } }
    }
    function selectedParent() { return session?.groups.flatMap(g => g.answers).find(a => a.id === parentId); }
    function newConversation(clearDraft) {
      conversationEpoch++; opening = false; stopWatch(); session = null; parentId = null; error = null;
      if (clearDraft) { draft = ''; if ($('textarea')) { $('textarea').value = ''; $('textarea').style.height = ''; } }
    }
    async function mutate(method, input) {
      if (busy || !scope) return;
      if (pending && (pending.method !== method || JSON.stringify(pending.input) !== JSON.stringify(input))) {
        error = '请先确认上次发送的结果，再开始新的操作。'; paintNotice(); return;
      }
      const expected = generation, turn = conversationEpoch;
      busy = true; error = null; pending = { method, input }; paintComposer(); paintNotice();
      try {
        const result = await call(method, input);
        if (expected !== generation || turn !== conversationEpoch) return;
        pending = null; accept(result.session, method === 'send');
        if (method === 'send' && draft.trim() === input.prompt.trim()) { draft = ''; if ($('textarea')) { $('textarea').value = ''; $('textarea').style.height = ''; } }
        await watch();
      } catch (e) {
        if (expected !== generation || turn !== conversationEpoch) return;
        if (/TIMEOUT|NETWORK|CONNECTION|SESSION_CLOSED|DIALOGUE_REQUEST_FAILED|CLIENT_REQUEST_FAILED/.test(e.code || '')) error = '发送结果尚未确认。点击“确认上次发送”会使用原请求编号，不会重复生成。';
        else { pending = null; error = errorText(e.code); }
      } finally { if (expected === generation && turn === conversationEpoch) { busy = false; paintMessages(); paintNotice(); paintComposer(); if (!loaded && visible) void load(); } }
    }
    async function send() {
      if (busy || opening || !connected || !selected.length || running(session)) return;
      if (pending) return mutate(pending.method, pending.input);
      const prompt = draft.trim(); if (!prompt) return;
      if (session && selected[0] !== selectedParent()?.model) newConversation(false);
      const parent = selectedParent();
      if (session && (!parent || parent.status !== 'completed' || !parent.text)) { error = '请先选择一条已完成的回答继续，或开启新对话。'; paintNotice(); return; }
      const input = { scope, requestId: crypto.randomUUID(), prompt, models: [selected[0]],
        ...(session ? { sessionId: session.id, answerId: parentId, keepModel: true } : {}) };
      await mutate('send', input);
    }
    function paintModels() {
      const strip = $('[data-chat-models]'); if (!strip) return;
      const markup = models.map(m => `<button class="ai-model ${selected.includes(m.id) ? 'selected' : ''}" data-chat-action="model" data-id="${escape(m.id)}" aria-pressed="${selected.includes(m.id)}" title="${escape(`${m.name} · ${m.provider || ''}`)}"><span class="ai-model-icon">${icon(m)}</span><span class="ai-model-name">${escape(m.name)}</span></button>`).join('');
      if (strip.innerHTML !== markup) strip.innerHTML = markup;
    }
    function paintMessages() {
      const area = $('[data-chat-messages]'); if (!area) return;
      const stick = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
      $('.ai-dialogue').classList.toggle('is-empty', !session);
      if (!session) {
        const hour = new Date().getHours();
        const greeting = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
        area.innerHTML = `<div class="ai-welcome"><img class="ai-welcome-mark" src="./assets/centaurai-mark.png" alt="" /><h2>${connected ? `${greeting}${displayName ? `，${escape(displayName)}` : ''}` : '让每个想法，都有回应'}</h2><p>${connected ? loading ? '正在读取你的模型和对话…' : models.length ? '今天想聊些什么？' : visibilityConfigured && configuredModels ? '已选择的模型暂不可用，请到设置中重新选择显示的模型。' : '当前盒子还没有可用的云端模型，配置完成后刷新即可。' : '连接万象盒子，选择一个模型，开始你的第一句话。'}</p>${!connected ? '<button class="button primary" data-chat-action="boxes">连接盒子</button>' : ''}</div>`;
        return;
      }
      const chain = trail(session, parentId);
      area.innerHTML = `<div class="ai-transcript">${chain.map(({ group, answer }, index) => {
        const answers = index === chain.length - 1 ? group.answers : [answer];
        return `<div class="ai-user-message"><div>${escape(group.prompt)}</div></div>${answers.map(a => {
          const model = models.find(m => m.id === a.model) || { name: a.name };
          return `<article class="ai-answer ${answers.length > 1 && a.id === parentId ? 'chosen' : ''}"><header><span class="ai-answer-icon">${icon(model)}</span><strong>${escape(a.name || model.name)}</strong><span class="ai-answer-status">${active(a) ? '正在回答…' : a.status === 'stopped' ? '已停止' : a.status === 'interrupted' ? '已中断' : ''}</span></header><div class="ai-answer-text">${richText(a.text) || (active(a) ? '<span class="ai-typing" aria-label="正在生成">···</span>' : '<span class="muted">本次没有生成内容</span>')}</div>${a.error ? `<p class="ai-answer-error">${escape(errorText(a.error))}</p>` : ''}<footer>${a.text ? `<button data-chat-action="copy" data-id="${escape(a.id)}">复制</button>` : ''}${active(a) ? `<button data-chat-action="stop" data-id="${escape(a.id)}">停止生成</button>` : a.status !== 'completed' ? `<button data-chat-action="regenerate" data-id="${escape(a.id)}">重新生成</button>` : answers.length > 1 ? `<button data-chat-action="branch" data-id="${escape(a.id)}" aria-pressed="${a.id === parentId}">${a.id === parentId ? '将沿这条回答继续' : '沿这条回答继续'}</button>` : ''}</footer></article>`;
        }).join('')}`;
      }).join('')}</div>`;
      if (stick) area.scrollTop = area.scrollHeight;
    }
    function paintHistory() {
      const drawer = $('[data-chat-history]'); if (!drawer) return;
      drawer.hidden = !historyOpen;
      $('.ai-dialogue').classList.toggle('history-collapsed', !historyOpen);
      for (const button of root.querySelectorAll('[data-chat-action="history"]')) button.setAttribute('aria-expanded', String(historyOpen));
      const filtered = sessions.filter(item => (item.title || '').toLocaleLowerCase().includes(historyQuery.toLocaleLowerCase()));
      $('[data-chat-history-list]').innerHTML = filtered.length ? filtered.map(s => `<button data-chat-action="open" data-id="${escape(s.session_id)}" ${session?.id === s.session_id ? 'aria-current="page"' : ''}><strong>${escape(s.title || '新的对话')}</strong><small>${escape(new Date(s.updated_at * 1000).toLocaleDateString())}</small></button>`).join('') : `<p class="ai-history-empty">${historyQuery ? '没有找到相关对话' : '还没有历史对话。<br>聊过的内容会留在这里。'}</p>`;
    }
    function paintNotice() {
      const node = $('[data-chat-notice]'); if (!node) return;
      node.hidden = !error;
      node.innerHTML = `${escape(error || '')}${pending && error ? '<button data-chat-action="confirm">确认上次发送</button>' : ''}`;
    }
    function paintComposer() {
      if (!root) return;
      const names = selected.map(id => models.find(m => m.id === id)?.name).filter(Boolean);
      $('[data-chat-composer-label]').textContent = names[0] ? `发给 ${names[0]}` : '请选择一个模型';
      $('[data-chat-context]').textContent = session ? '沿用这段对话的上下文' : '开启一段新的对话';
      $('[data-chat-box]').textContent = boxName || '尚未连接盒子';
      $('textarea').disabled = !connected || !models.length;
      const button = $('[data-chat-send]');
      button.disabled = busy || opening || !scope || !selected.length || !draft.trim() && !pending || running(session);
      button.textContent = busy ? '发送中' : '发送';
      for (const button of root.querySelectorAll('[data-chat-action="new"]')) button.disabled = busy || Boolean(pending);
      $('[data-chat-action="refresh"]').disabled = busy || Boolean(pending);
      for (const model of root.querySelectorAll('[data-chat-action="model"]')) model.disabled = busy || Boolean(pending);
      for (const button of root.querySelectorAll('[data-chat-action="stop"], [data-chat-action="regenerate"], [data-chat-action="branch"]')) button.disabled = busy || opening || Boolean(pending);
    }
    function paint() { if (!root) return; paintModels(); paintMessages(); paintHistory(); paintNotice(); paintComposer(); }
    function setup(element) {
      root = element;
      root.innerHTML = `<section class="ai-dialogue"><aside class="ai-history" data-chat-history aria-label="历史对话"><div class="ai-sidebar-heading"><div class="ai-sidebar-brand"><img src="./assets/centaurai-mark.png" alt="" /><strong>半人马AI</strong></div><button data-chat-action="history" aria-label="收起历史对话" title="收起历史"><img src="./assets/ui-icons/collapse.svg" alt="" /></button></div><label class="ai-history-search"><span class="sr-only">搜索历史对话</span><img src="./assets/ui-icons/search.svg" alt="" /><input type="search" placeholder="搜索对话" aria-label="搜索历史对话" data-chat-search /></label><button data-chat-action="new" class="ai-sidebar-new"><img src="./assets/ui-icons/plus.svg" alt="" />新对话</button><p class="ai-history-caption">最近对话</p><div data-chat-history-list></div></aside><div class="ai-chat-workspace"><header class="ai-dialogue-heading"><div><button data-chat-action="history" class="ai-history-toggle" aria-expanded="true">历史</button><h2>AI 对话</h2><span data-chat-box></span></div><div class="ai-heading-actions"><button data-chat-action="refresh" title="刷新模型与对话" aria-label="刷新模型与对话">刷新</button><button data-chat-action="new" class="ai-new-chat">新对话</button></div></header><div class="ai-dialogue-body"><div class="ai-chat-notice" data-chat-notice role="status" hidden></div><div class="ai-messages" data-chat-messages role="log" aria-label="AI 对话记录"></div></div><div class="ai-compose-dock"><section class="ai-model-section" aria-label="选择对话模型"><div class="ai-model-strip" data-chat-models></div></section><form class="ai-composer"><textarea rows="2" maxlength="16000" aria-label="给 AI 发消息" placeholder="发消息，和 AI 一起想清楚…"></textarea><div class="ai-composer-meta"><strong data-chat-composer-label></strong><span data-chat-context></span></div><div class="ai-composer-bottom"><span>Enter 发送 · Shift + Enter 换行</span><button type="submit" data-chat-send aria-label="发送消息">发送</button></div></form></div></div></section>`;
      const textarea = $('textarea'); textarea.value = draft;
      $('[data-chat-search]').addEventListener('input', e => { historyQuery = e.target.value; paintHistory(); });
      textarea.addEventListener('input', () => { draft = textarea.value; textarea.style.height = 'auto'; textarea.style.height = `${Math.min(128, textarea.scrollHeight)}px`; paintComposer(); });
      textarea.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); void send(); } });
      $('form').addEventListener('submit', e => { e.preventDefault(); e.stopPropagation(); void send(); });
      root.addEventListener('keydown', e => { if (e.key === 'Escape' && historyOpen) { historyOpen = false; paintHistory(); } });
      root.addEventListener('click', async e => {
        const button = e.target.closest('[data-chat-action]'); if (!button || button.disabled) return;
        const action = button.dataset.chatAction, id = button.dataset.id;
        if (action === 'boxes') onBoxes();
        if (action === 'refresh') await load();
        if (action === 'history') { historyOpen = !historyOpen; paintHistory(); }
        if (action === 'open' && !busy) await open(id);
        if (action === 'confirm' && pending) await mutate(pending.method, pending.input);
        if (action === 'model' && models.some(m => m.id === id)) {
          if (selected[0] !== id) newConversation(false);
          selected = [id];
          paint();
        }
        if (action === 'new' && !pending && !busy) { newConversation(true); paint(); textarea.focus(); }
        const answer = session?.groups.flatMap(g => g.answers).find(a => a.id === id);
        if (action === 'branch' && !pending && !busy && answer?.status === 'completed') { parentId = id; selected = [answer.model]; paint(); }
        if (action === 'copy' && answer) { try { await navigator.clipboard.writeText(answer.text); button.textContent = '已复制'; } catch { error = '复制未完成，可以选中回答文字手动复制。'; paintNotice(); } }
        if (action === 'stop' && answer && !busy) await mutate('stop', { scope, sessionId: session.id, answerId: id });
        if (action === 'regenerate' && answer && !busy) await mutate('retry', { scope, sessionId: session.id, answerId: id, requestId: crypto.randomUUID() });
      });
      paint();
    }
    return {
      hostState(state) {
        const next = state.account?.phase === 'authenticated' && state.activeDeviceId ? JSON.stringify([state.account.accountId, state.account.clientId, state.activeDeviceId, state.connection?.gatewayURL]) : null;
        const nextName = state.account?.profile?.displayName || '';
        const nameChanged = displayName !== nextName;
        connected = Boolean(next); boxName = state.connection?.name || state.devices?.find(d => d.deviceId === state.activeDeviceId)?.displayName || '当前盒子';
        if (next !== context) { generation++; reset(); displayName = nextName; context = next; paint(); if (visible && connected) void load(); }
        else if (nameChanged) { displayName = nextName; paintMessages(); }
      },
      modelsChanged() { loaded = false; if (visible && connected) void load(); },
      mount(element) { if (!element) return; if (root !== element) setup(element); if (connected && !loaded && !loading) void load(); },
      visible(value) { if (visible === value) return; visible = value; if (!visible) stopWatch(); else if (connected && !loaded) void load(); else void watch(); },
      event(value) {
        if (value.type === 'invalidated') { generation++; reset(); context = null; paint(); return; }
        if (value.scope !== scope || !session) return;
        if (value.type === 'snapshot' && value.session.id === session.id) accept(value.session);
        if (['stream-ended', 'stream-error'].includes(value.type) && value.sessionId === session.id) {
          watchingId = null;
          if (running(session)) { error = '回答连接中断，点击刷新读取已生成的内容，不会重复发送。'; paintNotice(); }
        }
      },
    };
  };
  window.createDialogueModelSettingsView = ({ request, onSaved = () => {} }) => {
    let root = null, context = null, generation = 0, visible = false, connected = false;
    let scope = null, catalog = [], choice = null, checked = new Set(), boxName = '', loaded = false;
    let loading = false, saving = false, restore = false, notice = '', error = '';
    const choices = () => catalog.filter(model => !isLocalModel(model));
    const initialIds = () => (choice === null ? choices().map(model => model.id) : choice.filter(id => choices().some(model => model.id === id)));
    const dirty = () => restore && choice !== null || JSON.stringify([...checked].sort()) !== JSON.stringify(initialIds().sort());
    function paint() {
      if (!root) return;
      const focusId = root.contains(document.activeElement) ? document.activeElement?.dataset?.modelChoice : null;
      const models = choices();
      root.innerHTML = `<div class="page-heading model-settings-heading"><div><button class="text-button" data-action="show-settings">‹ 返回设置</button><h2>AI 对话模型</h2><p class="muted">选择出现在 AI 对话中的模型，按你的习惯整理。</p></div><button class="button small" data-model-settings="refresh" ${loading || saving || !connected ? 'disabled' : ''}>刷新模型</button></div>
        <section class="model-settings-card"><div class="model-settings-summary"><div><h3>${escape(boxName || '当前盒子')}</h3><p class="muted">${connected ? '关闭显示不会删除模型配置或历史对话。' : '连接盒子后，即可选择它提供的云端模型。'}</p></div><span>${checked.size} / ${models.length} 已选择</span></div>
        ${error ? `<p class="notice error" role="alert">${escape(error)}</p>` : ''}
        <div class="model-settings-list" aria-label="选择显示的模型">${loading && !loaded ? '<p class="muted">正在读取模型…</p>' : models.length ? models.map(model => `<label class="model-settings-option ${checked.has(model.id) ? 'selected' : ''}"><span class="model-settings-icon">${icon(model)}</span><span class="model-settings-copy"><strong>${escape(model.name)}</strong><small>${escape(model.provider || '云端模型')}</small></span><input type="checkbox" data-model-choice="${escape(model.id)}" aria-label="显示 ${escape(model.name)}" ${checked.has(model.id) ? 'checked' : ''} ${loading || saving ? 'disabled' : ''} /></label>`).join('') : `<p class="model-settings-empty muted">${connected ? '当前盒子暂无可用的云端模型。配置完成后点击刷新。' : '尚未连接盒子。'}</p>`}</div>
        <div class="model-settings-footer"><div><p class="muted">默认显示全部可用云端模型。</p><p class="muted">选择按当前账号和盒子保存在这台电脑。</p></div><div class="settings-actions"><button class="text-button" data-model-settings="reset" ${!models.length || loading || saving ? 'disabled' : ''}>恢复默认</button><button class="button primary" data-model-settings="save" ${!checked.size || !dirty() || loading || saving ? 'disabled' : ''}>${saving ? '正在保存…' : '保存选择'}</button></div></div>
        <p class="model-settings-status ${!checked.size && models.length ? 'warning' : ''}" data-model-save-status role="status">${!checked.size && models.length ? '至少选择一个模型后再保存。' : escape(notice)}</p></section>`;
      if (focusId) Array.from(root.querySelectorAll('[data-model-choice]')).find(input => input.dataset.modelChoice === focusId)?.focus();
    }
    async function refresh() {
      if (!connected || loading || saving) return;
      const expected = generation; loading = true; error = ''; notice = ''; paint();
      try {
        const result = await request('dialogue.load');
        if (expected !== generation) return;
        if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
        scope = result.value.scope; catalog = result.value.models || [];
        choice = Array.isArray(result.value.visibleModelIds) ? result.value.visibleModelIds : null;
        checked = new Set(initialIds()); loaded = true; restore = false;
      } catch (e) { if (expected === generation) error = errorText(e.code); }
      finally { if (expected === generation) { loading = false; paint(); } }
    }
    async function save() {
      if (!connected || !scope || saving || loading || !checked.size || !dirty()) return;
      const expected = generation; saving = true; error = ''; notice = ''; paint();
      try {
        const result = await request('dialogue.preferences', { scope, modelIds: restore ? null : [...checked] });
        if (expected !== generation) return;
        if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
        choice = Array.isArray(result.value.visibleModelIds) ? result.value.visibleModelIds : null;
        checked = new Set(initialIds()); restore = false;
        notice = '已保存，AI 对话中的模型列表已更新。'; onSaved(result.value);
      } catch (e) { if (expected === generation) error = e.code === 'DIALOGUE_INVALID_MODEL_SELECTION' ? '模型列表已变化，请刷新后重新选择。' : '保存未完成，原来的选择仍保留，请重试。'; }
      finally { if (expected === generation) { saving = false; paint(); } }
    }
    return {
      hostState(state) {
        const next = state.account?.phase === 'authenticated' && state.activeDeviceId ? JSON.stringify([state.account.accountId, state.account.clientId, state.activeDeviceId, state.connection?.gatewayURL]) : null;
        connected = Boolean(next); boxName = state.connection?.name || '当前盒子';
        if (next === context) return;
        context = next; generation++; scope = null; catalog = []; choice = null; checked = new Set();
        loaded = false; loading = false; saving = false; restore = false; notice = ''; error = ''; paint();
        if (visible && connected) void refresh();
      },
      visible(value) { if (visible === value) return; visible = value; if (visible && connected && !loaded) void refresh(); },
      mount(element) {
        if (!element || root === element) return;
        root = element;
        root.addEventListener('change', event => {
          const id = event.target.dataset?.modelChoice;
          if (!id || saving || loading || !choices().some(model => model.id === id)) return;
          if (event.target.checked) checked.add(id); else checked.delete(id);
          restore = false; notice = ''; paint();
        });
        root.addEventListener('click', event => {
          const action = event.target.closest('[data-model-settings]')?.dataset.modelSettings;
          if (action === 'refresh') void refresh();
          if (action === 'save') void save();
          if (action === 'reset' && !saving && !loading) { checked = new Set(choices().map(model => model.id)); restore = true; notice = '已恢复默认选择，保存后生效。'; error = ''; paint(); }
        });
        paint(); if (visible && connected && !loaded && !loading) void refresh();
      },
    };
  };
})();
