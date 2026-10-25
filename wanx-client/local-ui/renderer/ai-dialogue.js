(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text || '').join('\n') : '';
  const safeLink = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? esc(u.href) : ''; } catch { return ''; } };
  function inline(text) {
    const code = [];
    let value = esc(text).replace(/`([^`\n]+)`/g, (_, s) => { code.push(`<code>${s}</code>`); return `\u0000${code.length - 1}\u0000`; });
    value = value.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
      const href = safeLink(url.replace(/&amp;/g, '&')); return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    }).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return value.replace(/\u0000(\d+)\u0000/g, (_, n) => code[Number(n)] || '');
  }
  function markdown(text) {
    const lines = String(text || '').split('\n'); let html = '', list = null;
    const closeList = () => { if (list) html += `</${list}>`; list = null; };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        closeList(); const lang = line.replace(/^\s*```/, '').trim(); const body = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
        const code = body.join('\n');
        html += `<div class="ai-code"><div><span>${esc(lang || '代码')}</span><button type="button" data-chat-action="copy-code" data-code="${esc(code)}">复制代码</button></div><pre><code>${esc(code)}</code></pre></div>`;
        continue;
      }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) { closeList(); const level = Math.min(6, heading[1].length + 2); html += `<h${level}>${inline(heading[2])}</h${level}>`; continue; }
      const item = /^\s*(?:([-*+])|\d+\.)\s+(.+)$/.exec(line);
      if (item) { const tag = item[1] ? 'ul' : 'ol'; if (list !== tag) { closeList(); list = tag; html += `<${tag}>`; } html += `<li>${inline(item[2])}</li>`; continue; }
      closeList();
      if (/^\s*\|.+\|\s*$/.test(line) && /^\s*\|?\s*:?-+/.test(lines[i + 1] || '')) {
        const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
        html += `<div class="ai-table"><table><thead><tr>${cells(line).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`; i++;
        while (i + 1 < lines.length && /^\s*\|.+\|\s*$/.test(lines[i + 1])) html += `<tr>${cells(lines[++i]).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`;
        html += '</tbody></table></div>'; continue;
      }
      html += /^>\s?/.test(line) ? `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>` : line.trim() ? `<p>${inline(line)}</p>` : '<div class="ai-paragraph-gap"></div>';
    }
    closeList(); return html;
  }
  function icon(model) {
    const name = `${model?.name || ''} ${model?.provider || ''}`.toLowerCase();
    const brand = [['deepseek', /deepseek/], ['anthropic', /claude|anthropic/], ['gemini', /gemini|google/], ['moonshot', /kimi|moonshot/], ['dashscope', /qwen|千问|通义|dashscope/], ['zhipu', /glm|智谱|zhipu/], ['minimax', /minimax/], ['volces', /doubao|豆包|volces/], ['ollama', /ollama/], ['openai', /openai|gpt|chatgpt|o[134]-/]].find(([, re]) => re.test(name))?.[0];
    return brand ? `<img src="./assets/model-icons/${brand}.${brand === 'moonshot' ? 'webp' : brand === 'volces' ? 'svg' : 'png'}" alt="" />` : '<span aria-hidden="true">AI</span>';
  }
  function historyMessages(raw) {
    let model = null; const result = [];
    for (const [index, message] of (raw || []).entries()) {
      if (message.role === 'system') continue;
      if (message.role === 'user') model = message.composer_context?.model || null;
      const blocks = Array.isArray(message.content) ? message.content : [];
      const text = textOf(message.content);
      const id = message.id || `history-${index}`;
      if (text || message.role === 'user') result.push({ id, role: message.role, text, model: message.model_ref || message.usage?.model || model,
        files: message.inbound_attachments || [], status: message.status || 'completed' });
      for (const [n, b] of blocks.entries()) {
        if (['tool_use', 'tool_call', 'tool_result'].includes(b.type)) result.push({ id: `${id}-tool-${n}`, role: 'tool', callId: b.id,
          name: b.display_name || b.name || '工具', text: typeof b.output === 'string' ? b.output : b.output == null ? JSON.stringify(b.input || b.args || {}, null, 2) : JSON.stringify(b.output, null, 2),
          status: b.error_code ? 'error' : b.type === 'tool_result' ? 'completed' : 'called' });
      }
    }
    return result;
  }
  function applyFrame(state, event) {
    if (event.type === 'turn_status') { state.active = Boolean(event.active); return; }
    if (event.type === 'token') {
      state.active = true;
      let last = state.messages.at(-1);
      if (!last || last.role !== 'assistant' || last.status !== 'running') {
        last = { id: `live-${++state.sequence}`, role: 'assistant', text: '', model: state.runModel, status: 'running' };
        state.messages.push(last);
      }
      last.text += String(event.content || '');
    }
    if (event.type === 'tool_call_chunk') {
      state.active = true; const key = event.id || `index-${event.index ?? 0}`;
      let tool = state.messages.findLast(m => m.role === 'tool' && m.status === 'running' && (m.callId === key || m.index === event.index && event.index != null));
      if (!tool) { tool = { id: `live-${++state.sequence}`, role: 'tool', callId: key, index: event.index, name: event.display_name || event.name || '工具', text: '', status: 'running' }; state.messages.push(tool); }
      if (event.id) tool.callId = event.id;
      if (event.name || event.display_name) tool.name = event.display_name || event.name;
      tool.text += typeof event.args === 'string' ? event.args : event.args ? JSON.stringify(event.args) : '';
    }
    if (event.type === 'tool_result') {
      for (const result of event.messages || []) {
        const key = result.tool_call_id || result.toolCallId;
        let tool = state.messages.findLast(m => m.role === 'tool' && m.callId === key);
        if (!tool) { tool = { id: `live-${++state.sequence}`, role: 'tool', callId: key, name: result.name || '工具' }; state.messages.push(tool); }
        tool.status = result.status === 'error' ? 'error' : 'completed';
        tool.text = textOf(result.content) || (typeof result.content === 'object' ? JSON.stringify(result.content, null, 2) : String(result.content || '已完成'));
      }
    }
    if (event.type === 'hitl_required') { state.pending = event.request; state.active = false; }
    if (event.type === 'error') { state.error = event.message || '本次任务未完成，请检查后重试。'; state.active = false; }
    if (event.type === 'done') {
      state.active = false;
      for (const m of state.messages) if (m.status === 'running') m.status = m.role === 'tool' ? 'interrupted' : 'completed';
    }
  }
  function legacyTrail(session, answerId) {
    const items = [], seen = new Set();
    while (answerId && !seen.has(answerId)) {
      seen.add(answerId); const group = session?.groups?.find(g => g.answers.some(a => a.id === answerId));
      if (!group) break;
      items.unshift({ group, answer: group.answers.find(a => a.id === answerId) }); answerId = group.parent_answer;
    }
    return items;
  }
  function legacyReference(session, answerId) {
    return `【来自旧版对话的历史参考：${session.title || '旧版对话'}】\n以下内容仅作为参考，保留原作者和回答来源。\n\n` + legacyTrail(session, answerId).map(({ group, answer }) => `用户：${group.prompt}\n${answer.name || 'AI'}：${answer.text || '（没有回答内容）'}`).join('\n\n') + '\n\n【请在此补充要继续处理的问题】\n';
  }
  const errors = {
    AGENT_QUOTA_EXCEEDED: '当前账号的专家数量已达到上限，请在后台调整配额后重试。',
    FORBIDDEN: '通用专家已停用或当前账号无权访问，请联系管理员。',
    AGENT_NOT_RUNNING: '通用专家暂时未运行，请检查后台状态后恢复连接。',
    AGENT_FAILED: '通用专家启动失败，请检查后台配置后恢复连接。',
    BOX_CONNECTION_REQUIRED: '连接万象盒子后，即可使用万象·助理。', ASSISTANT_API_NOT_INSTALLED: '当前盒子需要更新万象·助理接口。已有对话数据会保留。',
    DIALOGUE_CONTEXT_CHANGED: '账号或盒子已改变，请重新连接。', DIALOGUE_ACCESS_DENIED: '当前账号暂时无法使用助理，请检查盒子授权。',
    ASSISTANT_MODEL_NEEDS_IMAGE: '当前模型不支持图片，请在顶部选择支持图片的模型，或移除图片后再发送。',
    MODEL_UNAVAILABLE: '所选模型已不可用，请在顶部重新选择；草稿和附件已保留。', ASSISTANT_TURN_ACTIVE: '这段对话仍在工作，完成或停止后即可继续。',
    ASSISTANT_ATTACHMENT_EXPIRED: '附件连接已过期，请重新添加。', ASSISTANT_UPLOAD_TOO_LARGE: '附件超过当前可上传大小，请缩小文件后重试。',
    ASSISTANT_TOO_MANY_ATTACHMENTS: '一条消息最多添加 8 个附件。', ASSISTANT_SEND_UNCERTAIN: '发送结果尚未确认，请恢复连接读取结果，避免重复发送。',
    ASSISTANT_ARTIFACT_DENIED: '这份产物当前无法读取，请恢复连接后重试。', ASSISTANT_FILE_TOO_LARGE: '文件过大，暂时无法预览。',
    CONNECTOR_NOT_BOUND: '空间连接已停用或变更，草稿已保留。请恢复连接后重试。',
    ASSISTANT_KNOWLEDGE_DENIED: '当前账号或本次选择无权读取此数据仓，请联系管理员授权。',
    ASSISTANT_KNOWLEDGE_EXPIRED: '知识库接入已取消或过期，请在对话设置中重新确认。',
    ASSISTANT_KNOWLEDGE_UNAVAILABLE: '星图数据仓暂时不可用，草稿和附件已保留。',
    ASSISTANT_KNOWLEDGE_CONFLICT: '授权已被其他管理员修改，请刷新后重试。',
    ASSISTANT_SPACE_SCOPE_REQUIRED: '请在对话设置中选择空间访问范围，草稿已保留。',
    SPACE_ACCESS_DENIED: '空间授权已取消、过期或超出所选范围，请重新选择访问范围。',
    CONNECTOR_MCP_LOAD_FAILED: '资料来源暂时无法连接，草稿已保留。请恢复连接后重试。',
  };
  const errorText = error => errors[error?.code] || '操作未完成，草稿已保留。请恢复连接后重试。';
  function historyItems(sessions, legacySessions, organization = {}, options = {}) {
    const needle = (options.query || '').trim().toLocaleLowerCase();
    return [...sessions.map(s => ({ ...s, kind: 'thread', id: s.thread_id })), ...legacySessions.map(s => ({ ...s, kind: 'legacy', id: s.session_id }))].map(s => {
      const key = `${s.kind}:${s.id}`, meta = organization[key] || {};
      return { ...s, key, title: meta.title || s.title || '新对话', pinned: meta.pinned ?? s.pinned ?? false,
        status: meta.status || 'active', time: Number(s.last_active || s.updated_at || s.created_at || 0) };
    }).filter(s => (!options.status || s.status === options.status) && (!options.kind || options.kind === 'all' || s.kind === options.kind) && s.title.toLocaleLowerCase().includes(needle))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (options.sort === 'title' ? a.title.localeCompare(b.title, 'zh-CN') : options.sort === 'oldest' ? a.time - b.time : b.time - a.time) || a.key.localeCompare(b.key));
  }
  window.wanxAssistantState = { esc, markdown, historyMessages, applyFrame, legacyReference, legacyTrail, historyItems };
  window.wanxDialogueState = { trail: legacyTrail, richText: markdown, isLocalModel: m => Boolean(m.is_local) };

  window.createAIDialogueView = ({ request, onBoxes }) => {
    let root, context = null, generation = 0, epoch = 0, visible = false, connected = false, loaded = false, loading = false;
    let scope = null, models = [], selected = null, sessions = [], legacySessions = [], legacy = null, legacyId = null, legacyAnswer = null;
    let threadId = null, messages = [], draft = '', attachments = [], reference = '', historyOpen = false, query = '', pickerOpen = false, modelQuery = '';
    let busy = false, uploading = false, opening = false, active = false, uncertain = false, pending = null, runModel = null, sequence = 0;
    let error = '', notice = '', hasMore = false, historyCount = 0, boxName = '', pendingPaint = '', submitted = null, refreshTimer = null;
    let organization = {}, historyAvailable = false, historyStatus = 'active', historyKind = 'all', historySort = 'newest', historyPage = 1, historyBatch = false, historyBusy = false, managedKey = null, timezone = 'UTC';
    let spaceEnabled = false, spaceSelection = null, spaceLabel = '', spaceBusy = false, scopeSpaces = [], scopeMode = 'space', scopeSpaceId = 'personal', scopeFolderId = '', scopeFolders = [], scopeCrumbs = [];
    let knowledgeAvailable = false, knowledgeEnabled = false, knowledgeWarehouses = [], knowledgeCatalog = [], knowledgeBusy = false, savedModel = null;
    let knowledgeQuery = '', knowledgeChoices = new Set(), artifactPath = null; const sourceLinks = new Map();
    const historySelection = new Set();
    const $ = s => root?.querySelector(s);
    const modelFor = id => models.find(m => m.id === id) || { name: id?.split('/').at(-1) || '通用专家', id };
    const state = () => ({ messages, active, pending, runModel, sequence, error });
    async function call(method, input = {}) {
      const response = await request(`dialogue.${method}`, { ...(method !== 'load' ? { scope } : {}), ...input });
      if (!response?.ok) throw Object.assign(new Error(response?.code || 'ASSISTANT_REQUEST_FAILED'), { code: response?.code });
      return response.value;
    }
    function stopWatch() { if (scope) void call('unwatch').catch(() => {}); }
    function release(files = attachments) { if (scope && files.length) void call('release', { handles: files.map(f => f.handle) }).catch(() => {}); }
    function reset() {
      clearTimeout(refreshTimer); epoch++; stopWatch(); scope = null; loaded = false; loading = false; models = []; sessions = []; legacySessions = [];
      selected = null; legacy = null; legacyId = null; threadId = null; messages = []; draft = ''; attachments = []; reference = ''; submitted = null;
      busy = false; active = false; uncertain = false; uploading = false; opening = false; pending = null; pendingPaint = ''; error = ''; notice = ''; pickerOpen = false;
      if ($('[data-chat-artifact-dialog]')?.open) $('[data-chat-artifact-dialog]').close();
      if ($('[data-chat-history-dialog]')?.open) $('[data-chat-history-dialog]').close();
      knowledgeAvailable = false; knowledgeEnabled = false; knowledgeWarehouses = []; knowledgeCatalog = []; knowledgeBusy = false; savedModel = null; artifactPath = null; sourceLinks.clear();
      for (const d of root?.querySelectorAll('dialog[open]') || []) d.close();
      if ($('[data-chat-space-dialog]')?.open) $('[data-chat-space-dialog]').close();
      spaceEnabled = false; spaceSelection = null; spaceLabel = ''; spaceBusy = false; scopeSpaces = []; organization = {}; historyAvailable = false; historyStatus = 'active'; historyKind = 'all'; historySort = 'newest'; historyPage = 1; historyBatch = false; historyBusy = false; managedKey = null; historySelection.clear();
      $('[data-artifact-content]')?.replaceChildren();
      if ($('[data-chat-artifacts]')) $('[data-chat-artifacts]').innerHTML = '';
      if ($('[data-chat-input]')) $('[data-chat-input]').value = '';
      if ($('[data-chat-search]')) $('[data-chat-search]').value = '';
      query = ''; paint();
    }
    async function load() {
      if (!connected || loading) return;
      const gen = generation, turn = epoch; loading = true; error = ''; paintStatus();
      try {
        const result = await call('load');
        if (gen !== generation) return;
        scope = result.scope; models = result.models; sessions = result.sessions; legacySessions = result.legacySessions; loaded = true;
        knowledgeAvailable = result.capabilities?.knowledge === true;
        const settings = result.settings || {}; savedModel = settings.model || null;
        spaceEnabled = settings.space?.enabled === true; spaceSelection = settings.space?.selection || null; spaceLabel = settings.space?.label || '';
        knowledgeEnabled = knowledgeAvailable && settings.knowledge?.enabled === true; knowledgeWarehouses = settings.knowledge?.warehouses || [];
        organization = result.organization || {}; historyAvailable = result.historyManagementAvailable === true; timezone = result.timezone || 'UTC';
        if (!selected) selected = result.defaultModel;
        else if (!models.some(m => m.id === selected)) error = errors.MODEL_UNAVAILABLE;
        if (result.legacyUnavailable) notice = '旧版记录暂时无法读取，可稍后恢复连接重试。';
        if (threadId && turn === epoch) await openThread(threadId, false);
      } catch (e) { if (gen === generation) error = errorText(e); }
      finally { if (gen === generation) { loading = false; paint(); } }
    }
    function acceptHistory(history, older = false) {
      for (const ref of history.knowledge_sources || []) sourceLinks.set(ref.warehouse_id + ':' + ref.evidence_id, ref);
      const incoming = historyMessages(history.messages);
      if (older) {
        const ids = new Set(messages.map(m => m.id)); messages = [...incoming.filter(m => !ids.has(m.id)), ...messages];
      } else {
        const serverHasReply = incoming.some(m => m.role === 'assistant');
        if (incoming.length && (!submitted || serverHasReply || !messages.some(m => m.role === 'assistant' && m.id.startsWith('live-')))) messages = incoming;
      }
      active = Boolean(history.turn_active); pending = history.hitl_pending || null; uncertain = false;
      hasMore = Boolean(history.has_more); historyCount = Number(history.offset || 0) + Number(history.limit || (history.messages || []).length);
      const refs = history.artifact_refs?.length ? history.artifact_refs : history.artifacts || [];
      if ($('[data-chat-artifacts]')) $('[data-chat-artifacts]').innerHTML = refs.length ? `<span>本次产物</span>${refs.map(ref => {
        const path = typeof ref === 'string' ? ref : ref.path; return `<button type="button" data-chat-action="artifact" data-path="${esc(path)}">▤ ${esc(path.split('/').at(-1))}</button>`;
      }).join('')}` : '';
    }
    async function openThread(id, choose = true) {
      if (!scope || busy || uploading) return;
      if (threadId !== id && (spaceEnabled || knowledgeEnabled)) await call('release-context');
      const turn = ++epoch, gen = generation; opening = true; error = ''; stopWatch(); paintStatus();
      try {
        const result = await call('open', { threadId: id });
        if (turn !== epoch || gen !== generation) return;
        const changedThread = threadId !== id; threadId = id; legacy = null; legacyId = null; submitted = null;
        if (changedThread) { messages = []; sourceLinks.clear(); }
        acceptHistory(result.history);
        if (choose && !savedModel && result.history.model_ref) selected = result.history.model_ref;
        if (selected && !models.some(m => m.id === selected)) error = errors.MODEL_UNAVAILABLE;
        runModel = result.history.model_ref || selected;
        await call('watch', { threadId });
      } catch (e) { if (turn === epoch && gen === generation) error = errorText(e); }
      finally { if (turn === epoch && gen === generation) { opening = false; paint(); } }
    }
    async function newChat() {
      if (busy || uploading) return;
      if (spaceEnabled || knowledgeEnabled) await call('release-context');
      epoch++; clearTimeout(refreshTimer); stopWatch(); release(); threadId = null; legacy = null; legacyId = null; legacyAnswer = null;
      messages = []; sourceLinks.clear(); active = false; uncertain = false; pending = null; pendingPaint = ''; draft = ''; attachments = []; reference = ''; submitted = null; hasMore = false;
      error = ''; notice = ''; if ($('[data-chat-input]')) { $('[data-chat-input]').value = ''; $('[data-chat-input]').style.height = ''; }
      if ($('[data-chat-artifacts]')) $('[data-chat-artifacts]').innerHTML = '';
      paint(); $('[data-chat-input]')?.focus();
    }
    async function refreshCurrent() {
      if (!scope || !threadId || legacy || busy || opening) return;
      const turn = epoch, gen = generation, id = threadId;
      try {
        const result = await call('open', { threadId: id });
        if (gen !== generation || turn !== epoch) return;
        acceptHistory(result.history); paint();
        if (result.history.history_loading) refreshTimer = setTimeout(() => void refreshCurrent(), Math.max(500, result.history.history_retry_after_ms || 1000));
      } catch (e) { if (gen === generation && turn === epoch) { error = errorText(e); paintStatus(); } }
    }
    async function send() {
      if (busy || uploading || opening || active || uncertain || spaceBusy || knowledgeBusy || pending || legacy || !scope || !models.some(m => m.id === selected)) return;
      const text = draft.trim(); if (!text && !attachments.length && !reference.trim()) return;
      const prompt = reference.trim() ? `${reference.trim()}\n\n【现在的请求】\n${text}` : text;
      if (prompt.length > 32000) { error = '历史参考与消息合计最多 32000 字符，请删减参考内容后发送。'; paintStatus(); return; }
      const gen = generation, turn = epoch, sentFiles = attachments.slice(), sentDraft = draft, sentReference = reference;
      submitted = { draft: sentDraft, reference: sentReference, attachments: sentFiles, prompt, model: selected, ended: false, failed: false };
      busy = true; error = ''; active = true; runModel = selected;
      messages.push({ id: `optimistic-${++sequence}`, role: 'user', text, reference: sentReference, files: sentFiles }); paint();
      try {
        const result = await call('send', { threadId, model: selected, prompt, attachments: sentFiles.map(f => f.handle), spaceEnabled, knowledgeEnabled });
        if (gen !== generation || turn !== epoch) return;
        threadId = result.threadId;
        if (!submitted.failed && draft === sentDraft) { draft = ''; $('[data-chat-input]').value = ''; $('[data-chat-input]').style.height = ''; }
        if (!submitted.failed && reference === sentReference) reference = '';
        if (!submitted.failed) attachments = attachments.filter(f => !sentFiles.some(item => item.handle === f.handle));
        active = !submitted.ended && !pending;
        if (!sessions.some(s => s.thread_id === threadId)) sessions.unshift({ thread_id: threadId, title: text.slice(0, 35) || '附件对话', last_active: Date.now() / 1000 });
        paintHistory();
      } catch (e) {
        if (gen !== generation || turn !== epoch) return;
        active = false; error = errorText(e); uncertain = Boolean(threadId) && !['MODEL_UNAVAILABLE', 'ASSISTANT_ATTACHMENT_EXPIRED', 'ASSISTANT_TURN_ACTIVE', 'ASSISTANT_MODEL_NEEDS_IMAGE', 'ASSISTANT_KNOWLEDGE_DENIED', 'ASSISTANT_KNOWLEDGE_EXPIRED', 'ASSISTANT_KNOWLEDGE_UNAVAILABLE', 'SPACE_ACCESS_DENIED'].includes(e.code);
        if (!uncertain) messages = messages.filter(m => !m.id.startsWith('optimistic-'));
      } finally { if (gen === generation && turn === epoch) { busy = false; paint(); } }
    }
    function paintModels() {
      const node = $('[data-chat-models]'); if (!node) return;
      const chosen = modelFor(selected), quick = models.filter(m => m.id !== selected).slice(0, 4);
      node.innerHTML = `<div class="ai-model-current"><span class="ai-model-eyebrow">当前 AI</span><button class="ai-current-choice" data-chat-action="models" aria-haspopup="dialog" aria-expanded="${pickerOpen}"><span class="ai-model-icon">${icon(chosen)}</span><strong>${esc(selected ? chosen.name : '选择模型')}</strong><span class="ai-chevron">⌄</span></button></div><div class="ai-quick-models">${quick.map(m => `<button data-chat-action="model" data-id="${esc(m.id)}" class="ai-model"><span class="ai-model-icon">${icon(m)}</span><span>${esc(m.name)}</span></button>`).join('')}</div><button class="ai-more-models" data-chat-action="models" aria-expanded="${pickerOpen}">更多模型 <span>⌄</span></button>`;
      const picker = $('[data-chat-model-picker]'); picker.hidden = false;
      const needle = modelQuery.trim().toLowerCase();
      $('[data-chat-model-options]').innerHTML = models.filter(m => `${m.name} ${m.provider}`.toLowerCase().includes(needle)).map(m => `<button data-chat-action="model" data-id="${esc(m.id)}" class="ai-model-option" aria-pressed="${m.id === selected}"><span class="ai-model-icon">${icon(m)}</span><span><strong>${esc(m.name)}</strong><small>${esc(m.provider)}</small></span>${m.id === selected ? '<span class="ai-selected-tick">✓</span>' : ''}</button>`).join('') || '<p class="ai-empty-label">没有找到可用模型</p>';
      $('[data-chat-next-model]').textContent = active && selected !== runModel ? `下一条消息使用 ${chosen.name}，当前回答继续完成。` : '设置会记住，之后可随时在这里调整。';
    }
    function messageMarkup(message) {
      if (message.role === 'tool') return `<details class="ai-tool"><summary><span class="ai-tool-dot ${message.status}"></span>${esc(/wanx_knowledge_.*_xingtu_|Xingtu |星图知识库/i.test(message.name || '') ? '读取星图知识库' : /wanx_space_.*_space_|万象空间/i.test(message.name || '') ? '读取万象空间' : message.name || '工具')}<span>${message.status === 'running' ? '正在执行' : message.status === 'error' ? '未完成' : message.status === 'interrupted' ? '已中断' : message.status === 'called' ? '已调用' : '已完成'}</span></summary><pre>${esc(message.text || '正在处理…')}</pre></details>` + sourceButtons(message.text || '');
      const files = (message.files || []).map(f => `<span class="ai-sent-file">▤ ${esc(f.name || f.filename || '附件')}</span>`).join('');
      if (message.role === 'user') return `<article class="ai-user-message"><div>${message.reference ? '<small>含旧版对话参考</small>' : ''}<p>${esc(message.text)}</p>${files}</div></article>`;
      const model = modelFor(message.model);
      return `<article class="ai-answer"><header><span class="ai-answer-icon">${icon(model)}</span><strong>${esc(message.model ? model.name : '通用专家')}</strong>${message.status === 'running' ? '<span class="ai-answer-status">正在回答</span>' : ''}</header><div class="ai-answer-text">${markdown(message.text)}</div>${message.text ? `<footer><button data-chat-action="copy" data-id="${esc(message.id)}">复制回答</button></footer>` : ''}</article>`;
    }
    function paintMessages() {
      const area = $('[data-chat-messages]'); if (!area) return;
      const follow = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
      if (legacy) {
        const leaves = legacy.groups?.flatMap(g => g.answers) || [];
        area.innerHTML = `<div class="ai-transcript"><div class="ai-legacy-banner"><div><strong>旧版对话 · 只读</strong><p>保留原始内容，选择要参考的回答后带入助理。</p></div><button data-chat-action="bring-legacy">带入助理继续 ↗</button></div>${legacy.groups.map(g => `<article class="ai-user-message"><div><p>${esc(g.prompt)}</p></div></article>${g.answers.map(a => `<article class="ai-answer"><header><strong>${esc(a.name || a.model)}</strong><label><input type="radio" name="legacy-answer" data-legacy-answer="${esc(a.id)}" ${a.id === legacyAnswer ? 'checked' : ''}/> 以此为参考终点</label></header><div class="ai-answer-text">${markdown(a.text || '')}</div><footer><button data-chat-action="copy-legacy" data-id="${esc(a.id)}">复制回答</button></footer></article>`).join('')}`).join('')}</div>`;
        if (!leaves.length) area.innerHTML += '<p class="ai-empty-label">这段旧版对话没有回答内容。</p>';
        return;
      }
      if (!messages.length && !active) {
        area.innerHTML = `<div class="ai-welcome"><p class="ai-welcome-eyebrow">从一个想法，到下一步行动</p><h3>今天，想完成什么？</h3><p>把问题、材料或想法交给我，一起推进手头的工作。</p>${!connected ? '<button class="ai-connect" data-chat-action="boxes">连接万象盒子</button>' : ''}</div>`;
      } else {
        area.innerHTML = `<div class="ai-transcript">${hasMore ? '<button class="ai-load-older" data-chat-action="older">查看更早的消息</button>' : ''}${messages.map(messageMarkup).join('')}${active && messages.at(-1)?.role !== 'assistant' ? `<div class="ai-working"><span></span>正在处理…</div>` : ''}</div>`;
      }
      if (!legacy && sourceLinks.size && !area.querySelector('.ai-knowledge-sources')) area.querySelector('.ai-transcript')?.insertAdjacentHTML('beforeend', sourceButtons(JSON.stringify({ assistant_knowledge_sources: [...sourceLinks.values()] })));
      if (follow) area.scrollTop = area.scrollHeight;
    }
    const allHistory = () => historyItems(sessions, legacySessions, organization);
    const filteredHistory = () => historyItems(sessions, legacySessions, organization, { query, status: historyStatus, kind: historyKind, sort: historySort });
    const historyDate = time => {
      if (!time) return '';
      try { return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time * 1000)); }
      catch { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: '2-digit', day: '2-digit' }).format(new Date(time * 1000)); }
    };
    function paintHistory() {
      if (!$('[data-chat-history]')) return;
      $('[data-chat-history]').hidden = !historyOpen; $('.ai-dialogue').classList.toggle('history-collapsed', !historyOpen);
      for (const button of root.querySelectorAll('[data-chat-action="history"]')) button.setAttribute('aria-expanded', String(historyOpen));
      for (const button of root.querySelectorAll('[data-history-status]')) button.setAttribute('aria-selected', String(button.dataset.historyStatus === historyStatus));
      $('[data-history-kind]').value = historyKind; $('[data-history-sort]').value = historySort;
      $('[data-history-manage]').textContent = historyBatch ? '完成' : '批量管理';
      $('[data-history-manage]').disabled = !historyAvailable || historyBusy;
      $('[data-history-refresh]').disabled = loading || historyBusy || !connected;
      const list = filteredHistory(), pages = Math.max(1, Math.ceil(list.length / 50)); historyPage = Math.min(historyPage, pages);
      const page = list.slice((historyPage - 1) * 50, historyPage * 50);
      let lastGroup;
      $('[data-chat-history-list]').innerHTML = page.map(s => {
        const group = s.pinned ? '置顶' : historyStatus === 'trash' ? '已删除' : historyStatus === 'archived' ? '已归档' : '最近对话';
        const caption = group !== lastGroup ? `<p class="ai-history-caption">${group}</p>` : ''; lastGroup = group;
        const current = s.kind === 'thread' ? threadId === s.id && !legacy : legacyId === s.id;
        return caption + `<div class="ai-history-row ${current ? 'current' : ''}">${historyBatch ? `<input type="checkbox" data-history-select="${esc(s.key)}" aria-label="选择 ${esc(s.title)}" ${historySelection.has(s.key) ? 'checked' : ''} ${historyBusy ? 'disabled' : ''}/>` : ''}<button class="ai-history-item" data-chat-action="${historyStatus === 'trash' ? 'history-menu' : s.kind === 'legacy' ? 'legacy' : 'open'}" data-id="${esc(s.id)}" data-key="${esc(s.key)}" title="${esc(s.title)}" ${current ? 'aria-current="page"' : ''}><span>${esc(s.title)}</span><small>${s.kind === 'legacy' ? '旧版 · ' : ''}${s.pinned ? '置顶 · ' : ''}${esc(historyDate(s.time))}</small></button><button class="ai-history-more" data-chat-action="history-menu" data-key="${esc(s.key)}" aria-label="管理 ${esc(s.title)}">⋯</button></div>`;
      }).join('') || `<p class="ai-history-empty">${query ? '没有找到匹配的对话。' : historyStatus === 'trash' ? '回收站是空的。删除的对话可在这里恢复。' : historyStatus === 'archived' ? '还没有归档的对话。' : '从第一句开始，聊过的内容会留在这里。'}</p>`;
      $('[data-history-pagination]').innerHTML = `<span>${list.length} 段对话</span><button data-chat-action="history-prev" aria-label="上一页历史" ${historyPage === 1 ? 'disabled' : ''}>‹</button><span>${historyPage} / ${pages}</span><button data-chat-action="history-next" aria-label="下一页历史" ${historyPage === pages ? 'disabled' : ''}>›</button>`;
      $('[data-history-batch]').hidden = !historyBatch;
      $('[data-history-batch]').innerHTML = `<div><span>已选 ${historySelection.size} 项</span><button data-chat-action="history-select-page">${page.length && page.every(s => historySelection.has(s.key)) ? '取消本页' : '选择本页'}</button></div><div>${(historyStatus === 'trash' ? [['restore', '恢复']] : [['pin', '置顶'], [historyStatus === 'archived' ? 'unarchive' : 'archive', historyStatus === 'archived' ? '取消归档' : '归档'], ['trash', '删除']]).map(([op, label]) => `<button data-chat-action="history-bulk" data-operation="${op}" ${!historySelection.size || historyBusy ? 'disabled' : ''}>${label}</button>`).join('')}</div>`;
    }
    function openHistoryMenu(key) {
      const row = allHistory().find(s => s.key === key); if (!row) return;
      managedKey = key;
      $('[data-history-dialog-title]').textContent = row.title;
      $('[data-history-rename-input]').value = row.title;
      $('[data-history-dialog-note]').textContent = historyAvailable ? '管理仅调整助理中的列表，不改写原对话内容。' : '当前盒子需要更新历史管理接口；原对话仍可查看和导出。';
      $('[data-history-rename-form]').hidden = row.status === 'trash' || !historyAvailable;
      $('[data-history-dialog-actions]').innerHTML = `${(row.status === 'trash' ? [['restore', '恢复对话']] : [[row.pinned ? 'unpin' : 'pin', row.pinned ? '取消置顶' : '置顶对话'], [row.status === 'archived' ? 'unarchive' : 'archive', row.status === 'archived' ? '取消归档' : '归档对话'], ['trash', '移到回收站']]).map(([op, label]) => `<button data-chat-action="history-apply" data-operation="${op}" ${!historyAvailable ? 'disabled' : ''}>${label}</button>`).join('')}<button data-chat-action="history-export">导出 JSON</button>`;
      $('[data-chat-history-dialog]').showModal();
    }
    async function organizeHistory(operation, keys, title) {
      if (historyBusy || !historyAvailable || !keys.length) return;
      const rows = allHistory().filter(s => keys.includes(s.key));
      if (rows.length > 100) { error = '每次最多选择 100 段对话。'; paintStatus(); return; }
      if (['trash', 'archive'].includes(operation) && (active || pending || busy || uploading) && rows.some(s => s.kind === 'thread' && s.id === threadId || s.kind === 'legacy' && s.id === legacyId)) {
        $('[data-history-dialog-note]').textContent = '这段对话正在工作，请完成或停止后再调整。'; return;
      }
      const gen = generation; historyBusy = true; paintHistory();
      for (const b of $('[data-chat-history-dialog]').querySelectorAll('button')) b.disabled = true;
      try {
        if (['trash', 'archive'].includes(operation) && (spaceEnabled || knowledgeEnabled) && rows.some(s => s.kind === 'thread' && s.id === threadId || s.kind === 'legacy' && s.id === legacyId)) await call('release-context');
        const result = await call('history-update', { operation, items: rows.map(s => ({ kind: s.kind, id: s.id })), ...(title !== undefined ? { title } : {}) });
        if (gen !== generation) return;
        organization = result.entries; historySelection.clear();
        if (['trash', 'archive'].includes(operation) && rows.some(s => s.kind === 'thread' && s.id === threadId || s.kind === 'legacy' && s.id === legacyId)) {
          epoch++; stopWatch(); threadId = null; legacy = null; legacyId = null; messages = []; active = false; pending = null; pendingPaint = ''; submitted = null; hasMore = false;
          $('[data-chat-artifacts]').innerHTML = ''; paintMessages(); paintPending(); paintStatus();
        }
        $('[data-chat-history-dialog]').close(); notice = operation === 'trash' ? '已移到回收站，可以随时恢复。' : '历史对话已更新。'; error = ''; paintStatus();
      } catch (e) {
        if (gen === generation) { $('[data-history-dialog-note]').textContent = errorText(e); error = errorText(e); paintStatus(); }
      } finally {
        if (gen === generation) { historyBusy = false; for (const b of $('[data-chat-history-dialog]').querySelectorAll('button')) b.disabled = false; paintHistory(); }
      }
    }
    function paintSpaceDialog() {
      if (!$('[data-chat-space-dialog]')) return;
      for (const radio of root.querySelectorAll('[data-space-mode]')) { radio.checked = radio.value === scopeMode; radio.disabled = spaceBusy; }
      $('[data-space-choice]').hidden = scopeMode === 'all';
      $('[data-space-directory]').hidden = scopeMode !== 'folder';
      $('[data-space-select]').innerHTML = scopeSpaces.map(s => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('');
      $('[data-space-select]').value = scopeSpaceId; $('[data-space-select]').disabled = spaceBusy;
      $('[data-space-crumbs]').innerHTML = '<button type="button" data-chat-action="space-root">空间根目录</button>' + scopeCrumbs.map(c => '<span> / </span><button type="button" data-chat-action="space-folder" data-id="' + esc(c.id) + '">' + esc(c.name) + '</button>').join('');
      $('[data-space-folders]').innerHTML = scopeFolders.map(f => '<button type="button" data-chat-action="space-folder" data-id="' + esc(f.id) + '"><span>▱ ' + esc(f.name) + '</span><span>›</span></button>').join('') || '<p>当前目录没有子文件夹。</p>';
      const name = scopeSpaces.find(s => s.id === scopeSpaceId)?.name || '所选空间';
      $('[data-space-selection]').textContent = scopeMode === 'all' ? '允许读取当前账号全部空间的内容' : scopeMode === 'space' ? '允许读取：' + name + ' · 全部内容' : '允许读取：' + name + (scopeCrumbs.length ? ' / ' + scopeCrumbs.map(c => c.name).join(' / ') : '') + ' · 含子文件夹';
      $('[data-space-confirm]').disabled = spaceBusy || !scopeSpaces.length || scopeMode === 'folder' && !scopeFolderId;
      for (const b of $('[data-space-directory]').querySelectorAll('button')) b.disabled = spaceBusy;
    }
    async function browseSpace(parent = '') {
      const gen = generation, sid = scopeSpaceId; spaceBusy = true; paintSpaceDialog(); paintStatus();
      try {
        const result = await call('space-list', { spaceId: sid, parent });
        if (gen !== generation || sid !== scopeSpaceId) return;
        scopeFolderId = result.parent; scopeFolders = result.folders; scopeCrumbs = result.breadcrumbs;
        $('[data-space-note]').textContent = '';
      } catch (e) { if (gen === generation) $('[data-space-note]').textContent = errorText(e); }
      finally { if (gen === generation) { spaceBusy = false; paintSpaceDialog(); paintStatus(); } }
    }
    async function showSpaceSettings() {
      if (spaceBusy || active || busy || pending || legacy || !scope) return;
      const gen = generation; scopeMode = spaceSelection?.mode || 'space'; scopeSpaceId = spaceSelection?.space_id || 'personal';
      scopeFolderId = spaceSelection?.folder_id || ''; scopeFolders = []; scopeCrumbs = []; spaceBusy = true;
      $('[data-space-note]').textContent = '正在读取空间目录…'; paintSpaceDialog(); paintStatus(); $('[data-chat-space-dialog]').showModal();
      try {
        const result = await call('space-list');
        if (gen !== generation) return;
        scopeSpaces = result.spaces;
        if (!scopeSpaces.some(s => s.id === scopeSpaceId)) scopeSpaceId = scopeSpaces[0]?.id || 'personal';
        spaceBusy = false;
        if (scopeMode === 'folder') await browseSpace(scopeFolderId);
        else $('[data-space-note]').textContent = '确认后才允许读取；取消勾选可随时停止后续读取。';
      } catch (e) { if (gen === generation) $('[data-space-note]').textContent = errorText(e); }
      finally { if (gen === generation) { spaceBusy = false; paintSpaceDialog(); paintStatus(); } }
    }
    async function disableSpace() {
      if (!spaceEnabled) return;
      const gen = generation; spaceBusy = true; paintStatus();
      try { await call('space-grant', { enabled: false }); if (gen === generation) { spaceEnabled = false; spaceSelection = null; spaceLabel = ''; } }
      finally { if (gen === generation) { spaceBusy = false; paintStatus(); } }
    }
    async function confirmSpace() {
      if (spaceBusy) return;
      const selection = { mode: scopeMode, ...(scopeMode !== 'all' ? { space_id: scopeSpaceId } : {}), ...(scopeMode === 'folder' ? { folder_id: scopeFolderId } : {}) };
      const gen = generation; spaceBusy = true; paintSpaceDialog(); paintStatus();
      try {
        const result = await call('space-grant', { enabled: true, selection, threadId });
        if (gen !== generation) return;
        spaceEnabled = result.enabled; spaceSelection = result.selection; spaceLabel = result.label;
        $('[data-chat-space-dialog]').close(); error = '';
      } catch (e) { if (gen === generation) $('[data-space-note]').textContent = errorText(e); }
      finally { if (gen === generation) { spaceBusy = false; paintSpaceDialog(); paintStatus(); } }
    }
    function sourceButtons(text) {
      let data; try { data = JSON.parse(text); } catch { return ''; }
      if (!Array.isArray(data?.assistant_knowledge_sources) || !data.assistant_knowledge_sources.length) return '';
      return '<div class="ai-knowledge-sources">' + data.assistant_knowledge_sources.filter(r => /^[A-Za-z0-9_-]{1,128}$/.test(r.evidence_id || '') && /^[a-f0-9-]{36}$/.test(r.warehouse_id || '')).map(r => {
        const key = r.warehouse_id + ':' + r.evidence_id; sourceLinks.set(key, r);
        return '<button type="button" data-chat-action="knowledge-source" data-id="' + esc(key) + '"><span>◈ ' + esc(r.warehouse_name) + '</span>' + esc(r.document_name || '查看证据来源') + ' ↗</button>';
      }).join('') + '</div>';
    }
    function paintKnowledgeDialog() {
      const list = $('[data-knowledge-options]'); if (!list) return;
      const needle = knowledgeQuery.trim().toLowerCase();
      list.innerHTML = knowledgeCatalog.filter(w => w.name.toLowerCase().includes(needle)).map(w => '<label><input type="checkbox" data-knowledge-choice value="' + esc(w.id) + '"' + (knowledgeChoices.has(w.id) ? ' checked' : '') + (!w.available || knowledgeBusy ? ' disabled' : '') + '/><span><strong>' + esc(w.name) + '</strong><small>' + (w.available ? '只读 · 检索、图谱和证据' : '暂不可用，请联系管理员') + '</small></span></label>').join('') || '<p>没有可用数据仓。请联系管理员在星图中授权。</p>';
      $('[data-knowledge-confirm]').disabled = knowledgeBusy || !knowledgeChoices.size;
    }
    async function showKnowledgeSettings() {
      if (!knowledgeAvailable || knowledgeBusy || active || busy || pending) return;
      const gen = generation; knowledgeBusy = true; knowledgeChoices = new Set(knowledgeWarehouses.map(w => w.id)); knowledgeQuery = '';
      $('[data-knowledge-search]').value = ''; $('[data-knowledge-note]').textContent = '正在读取已授权仓库…';
      paintKnowledgeDialog(); paintStatus(); $('[data-chat-knowledge-dialog]').showModal();
      try {
        const value = await call('knowledge-list'); if (gen !== generation) return;
        knowledgeCatalog = value.items; knowledgeChoices = new Set([...knowledgeChoices].filter(id => knowledgeCatalog.some(w => w.id === id && w.available)));
        $('[data-knowledge-note]').textContent = '可多选；仅查询你有权使用的仓库。';
      } catch (e) { if (gen === generation) $('[data-knowledge-note]').textContent = errorText(e); }
      finally { if (gen === generation) { knowledgeBusy = false; paintKnowledgeDialog(); paintStatus(); } }
    }
    async function confirmKnowledge() {
      if (knowledgeBusy || !knowledgeChoices.size) return;
      const gen = generation; knowledgeBusy = true; paintKnowledgeDialog(); paintStatus();
      try {
        const value = await call('knowledge-grant', { enabled: true, warehouses: [...knowledgeChoices], threadId });
        if (gen !== generation) return;
        knowledgeEnabled = value.enabled; knowledgeWarehouses = value.warehouses; error = ''; $('[data-chat-knowledge-dialog]').close();
      } catch (e) { if (gen === generation) $('[data-knowledge-note]').textContent = errorText(e); }
      finally { if (gen === generation) { knowledgeBusy = false; paintKnowledgeDialog(); paintStatus(); } }
    }
    async function disableKnowledge() {
      const gen = generation; knowledgeBusy = true; paintStatus();
      try { await call('knowledge-grant', { enabled: false }); if (gen === generation) { knowledgeEnabled = false; knowledgeWarehouses = []; } }
      finally { if (gen === generation) { knowledgeBusy = false; paintStatus(); } }
    }
    async function previewKnowledge(key) {
      const ref = sourceLinks.get(key); if (!ref || !threadId) return;
      const gen = generation, current = threadId;
      const value = await call('knowledge-evidence', { threadId, warehouseId: ref.warehouse_id, evidenceId: ref.evidence_id });
      if (gen !== generation || threadId !== current) return;
      artifactPath = null; $('[data-artifact-name]').textContent = value.warehouse.name + ' · ' + (ref.document_name || '证据来源');
      $('[data-artifact-content]').innerHTML = markdown(value.result.text || value.result.excerpt || JSON.stringify(value.result, null, 2));
      $('[data-artifact-note]').textContent = '只读证据 · 遵循数据仓保护规则';
      $('[data-chat-artifact-dialog] [data-chat-action="save-artifact"]').hidden = true;
      $('[data-chat-artifact-dialog]').showModal();
    }
    function paintPending() {
      const node = $('[data-chat-pending]'); if (!node) return;
      const key = JSON.stringify(pending?.action_requests || null); if (key === pendingPaint) return; pendingPaint = key;
      if (!pending?.action_requests?.length) { node.innerHTML = ''; return; }
      node.innerHTML = `<form data-chat-approval><div class="ai-approval-heading"><strong>助理需要你的确认</strong><span>确认后继续当前任务</span></div>${pending.action_requests.map((action, i) => {
        const questions = action.name === 'ask_user_question' ? action.args?.questions || [] : [];
        const allowed = pending.review_configs?.find(c => c.action_name === action.name)?.allowed_decisions || ['approve', 'reject'];
        return `<fieldset data-approval-index="${i}"><legend>${esc(action.description || (questions.length ? '请补充信息' : action.name))}</legend>${questions.length ? questions.map((q, n) => `<div class="ai-question"><p>${esc(q.question)}</p>${(q.options || []).map(o => `<label><input type="${q.multi_select ? 'checkbox' : 'radio'}" name="q-${i}-${n}" value="${esc(o.label)}"/> ${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</label>`).join('')}<textarea name="free-${i}-${n}" rows="2" placeholder="也可以直接填写你的回答" maxlength="8000"></textarea></div>`).join('') : `<pre>${esc(JSON.stringify(action.args || {}, null, 2))}</pre><div class="ai-approval-choices">${allowed.includes('approve') ? `<label><input type="radio" name="decision-${i}" value="approve" required/> 同意本次操作</label>` : ''}${allowed.includes('reject') ? `<label><input type="radio" name="decision-${i}" value="reject" required/> 拒绝本次操作</label>` : ''}${allowed.includes('respond') ? `<textarea name="response-${i}" rows="2" placeholder="填写回复" required></textarea>` : ''}</div>`}</fieldset>`;
      }).join('')}<button type="submit" class="ai-approval-submit">提交并继续</button></form>`;
    }
    function paintStatus() {
      if (!root) return;
      const line = error || notice || (loading ? '正在连接助理…' : !connected ? '连接万象盒子后开始工作。' : !models.length && loaded ? '后台暂无可用的对话模型。配置后可恢复连接。' : '');
      const node = $('[data-chat-notice]'); node.hidden = !line;
      node.innerHTML = `<span>${esc(line)}</span>${connected && (error || uncertain || !models.length && loaded) ? '<button data-chat-action="reconnect">恢复连接</button>' : ''}`;
      const input = $('[data-chat-input]'); input.disabled = !connected || !scope || Boolean(legacy);
      const send = $('[data-chat-send]'); send.disabled = !scope || busy || uploading || opening || active || uncertain || spaceBusy || knowledgeBusy || Boolean(pending) || Boolean(legacy) || !models.some(m => m.id === selected) || !draft.trim() && !attachments.length && !reference.trim();
      send.textContent = busy ? '发送中' : '发送 ↑';
      $('[data-chat-stop]').hidden = !active || Boolean(legacy); $('[data-chat-stop]').disabled = busy;
      $('[data-chat-attach]').disabled = !scope || busy || uploading || Boolean(legacy) || attachments.length >= 8;
      $('[data-chat-attach]').textContent = uploading ? '正在添加…' : '＋ 添加附件';
      $('[data-chat-space-toggle]').checked = spaceEnabled;
      $('[data-chat-space-toggle]').disabled = !scope || spaceBusy || Boolean(legacy) || (!spaceEnabled && (active || busy || Boolean(pending)));
      $('[data-chat-space-settings]').hidden = !spaceEnabled;
      $('[data-chat-space-settings]').disabled = spaceBusy || active || busy || Boolean(pending);
      $('[data-chat-space-settings]').textContent = spaceLabel ? `${spaceLabel} ⌄` : '选择访问范围';
      $('[data-chat-space-settings]').title = spaceLabel;
      $('[data-chat-knowledge-entry]').hidden = !knowledgeAvailable;
      $('[data-chat-knowledge-toggle]').checked = knowledgeEnabled;
      $('[data-chat-knowledge-toggle]').disabled = !scope || knowledgeBusy || Boolean(legacy) || (!knowledgeEnabled && (active || busy || Boolean(pending)));
      $('[data-chat-knowledge-settings]').hidden = !knowledgeEnabled;
      $('[data-chat-knowledge-settings]').disabled = knowledgeBusy || active || busy || Boolean(pending);
      $('[data-chat-knowledge-settings]').textContent = knowledgeWarehouses.length ? knowledgeWarehouses.map(w => w.name).join('、') + ' ⌄' : '选择数据仓';
      $('[data-chat-settings-open]').disabled = !scope;
      $('[data-chat-composer]').hidden = Boolean(legacy);
      $('[data-chat-attachments]').innerHTML = attachments.map(file => `<span class="ai-attachment">▤ ${esc(file.name)}<button type="button" data-chat-action="remove-file" data-id="${esc(file.handle)}" aria-label="移除 ${esc(file.name)}">×</button></span>`).join('');
      $('[data-chat-reference]').hidden = !reference;
      if ($('[data-chat-reference-text]').value !== reference) $('[data-chat-reference-text]').value = reference;
      $('[data-chat-reference-count]').textContent = `${reference.length} / 32000 字符，可编辑删减`;
      for (const button of root.querySelectorAll('[data-chat-action="new"]')) button.disabled = busy || uploading;
      for (const button of root.querySelectorAll('[data-chat-action="model"]')) button.disabled = !scope || opening;
    }
    function paint() { if (!root) return; paintModels(); paintMessages(); paintHistory(); paintPending(); paintStatus(); }
    function mountConversationSettings() {
      $('.ai-page-actions').insertAdjacentHTML('afterbegin', '<button class="ai-history-toggle ai-settings-trigger" data-chat-action="settings" data-chat-settings-open aria-label="对话设置">⚙ <span>设置</span></button>');
      $('.ai-dialogue').insertAdjacentHTML('beforeend', '<dialog class="ai-settings-dialog" data-chat-settings-dialog aria-labelledby="assistant-settings-title"><header><div><h3 id="assistant-settings-title">对话设置</h3><p>按当前账号与盒子记住，日常对话无需重复配置。</p></div><button data-chat-action="settings-close" aria-label="关闭对话设置">×</button></header><section><h4>AI 模型</h4><div data-settings-model></div></section><section><h4>资料来源</h4><div data-settings-space></div><div class="ai-composer-context" data-chat-knowledge-entry hidden><label class="ai-space-toggle"><input type="checkbox" data-chat-knowledge-toggle/>星图知识库</label><button type="button" class="ai-space-scope" data-chat-action="knowledge-settings" data-chat-knowledge-settings hidden>选择数据仓</button></div><p class="ai-settings-caption">仅使用所选范围；可随时关闭接入。</p></section><footer><button data-chat-action="settings-close">完成</button></footer></dialog><dialog class="ai-space-dialog ai-knowledge-dialog" data-chat-knowledge-dialog aria-labelledby="knowledge-dialog-title"><header><div><h3 id="knowledge-dialog-title">选择星图知识库</h3><p>可同时使用多个已授权数据仓。</p></div><button data-chat-action="knowledge-close" aria-label="关闭知识库选择">×</button></header><input type="search" data-knowledge-search placeholder="搜索数据仓" aria-label="搜索数据仓"/><div class="ai-knowledge-options" data-knowledge-options></div><p class="ai-space-note" data-knowledge-note role="status"></p><footer><button data-chat-action="knowledge-close">取消</button><button data-chat-action="knowledge-confirm" data-knowledge-confirm>使用所选数据仓</button></footer></dialog>');
      $('[data-settings-model]').append($('.ai-model-section'));
      $('[data-settings-space]').append($('.ai-composer-context'));
      $('[data-chat-input]').rows = 1;
      $('[data-chat-knowledge-toggle]').addEventListener('change', async event => { try { if (event.target.checked) await showKnowledgeSettings(); else await disableKnowledge(); } catch (e) { error = errorText(e); } paintStatus(); });
      $('[data-knowledge-search]').addEventListener('input', event => { knowledgeQuery = event.target.value; paintKnowledgeDialog(); });
      $('[data-knowledge-options]').addEventListener('change', event => { if (!event.target.matches('[data-knowledge-choice]')) return; if (event.target.checked) knowledgeChoices.add(event.target.value); else knowledgeChoices.delete(event.target.value); paintKnowledgeDialog(); });
    }
    function setup(element) {
      root = element;
      root.innerHTML = `<section class="ai-dialogue history-collapsed"><header class="ai-dialogue-heading"><div class="ai-page-title"><span class="ai-page-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M8 5.5h16a4 4 0 0 1 4 4v11a4 4 0 0 1-4 4H15l-7 4v-4a4 4 0 0 1-4-4v-11a4 4 0 0 1 4-4Z"/><path class="ai-mark-spark" d="m17 9 1.8 4.2L23 15l-4.2 1.8L17 21l-1.8-4.2L11 15l4.2-1.8Z"/><path d="M23 7.5v4m-2-2h4"/></svg></span><div><h2>万象·助理</h2><p>多种 AI，随时为你所用。</p></div></div><div class="ai-page-actions"><button data-chat-action="history" class="ai-history-toggle" aria-label="展开或收起历史对话">☰ <span>历史</span></button><button class="ai-sidebar-new ai-collapsed-new" data-chat-action="new">＋ 新对话</button></div></header><div class="ai-assistant-workbench"><aside class="ai-history" data-chat-history hidden><div class="ai-sidebar-heading"><div class="ai-sidebar-brand"><strong>历史对话</strong></div><button data-chat-action="history" aria-label="收起历史对话">‹</button></div><label class="ai-history-search"><span class="sr-only">搜索对话</span><input type="search" data-chat-search placeholder="搜索对话标题"/></label><nav class="ai-history-tabs" aria-label="历史对话分类"><button data-chat-action="history-filter" data-history-status="active" role="tab">对话</button><button data-chat-action="history-filter" data-history-status="archived" role="tab">已归档</button><button data-chat-action="history-filter" data-history-status="trash" role="tab">回收站</button></nav><div class="ai-history-filters"><select data-history-kind aria-label="对话类型"><option value="all">全部类型</option><option value="thread">助理会话</option><option value="legacy">旧版对话</option></select><select data-history-sort aria-label="历史排序"><option value="newest">最近使用</option><option value="oldest">最早使用</option><option value="title">按名称</option></select></div><div class="ai-history-tools"><button data-chat-action="history-manage" data-history-manage>批量管理</button><button data-chat-action="history-refresh" data-history-refresh aria-label="刷新历史对话">刷新</button></div><div class="ai-history-batch" data-history-batch hidden></div><div data-chat-history-list></div><footer class="ai-history-pagination" data-history-pagination></footer></aside><div class="ai-chat-workspace"><div class="ai-model-section"><div class="ai-model-strip" data-chat-models></div><div class="ai-model-picker" data-chat-model-picker hidden role="dialog" aria-label="选择 AI 模型"><div><strong>选择 AI 模型</strong><button data-chat-action="close-models" aria-label="关闭模型选择">×</button></div><input type="search" data-chat-model-search placeholder="搜索模型或提供商" aria-label="搜索模型或提供商"/><div data-chat-model-options></div></div><p class="ai-model-hint" data-chat-next-model></p></div><div class="ai-chat-notice" data-chat-notice role="status" hidden></div><div class="ai-messages" data-chat-messages role="log" aria-label="助理对话记录"></div><div class="ai-bottom-dock"><div class="ai-artifacts" data-chat-artifacts></div><div class="ai-pending" data-chat-pending></div><form class="ai-composer" data-chat-composer><details class="ai-reference" data-chat-reference hidden open><summary>旧版对话参考 <span data-chat-reference-count></span><button type="button" data-chat-action="remove-reference">移除</button></summary><textarea data-chat-reference-text rows="4" aria-label="编辑旧版对话参考"></textarea></details><div class="ai-composer-context"><label class="ai-space-toggle"><input type="checkbox" data-chat-space-toggle/>万象空间</label><button type="button" class="ai-space-scope" data-chat-action="space-settings" data-chat-space-settings hidden>选择访问范围</button><span class="ai-space-readonly">按所选范围只读</span></div><div class="ai-attachments" data-chat-attachments></div><textarea data-chat-input rows="2" maxlength="32000" placeholder="把问题、材料或想法交给我…" aria-label="给万象·助理发消息"></textarea><div class="ai-composer-bottom"><button type="button" data-chat-action="upload" data-chat-attach>＋ 添加附件</button><span>Enter 发送 · Shift + Enter 换行</span><button type="button" class="ai-stop" data-chat-action="stop" data-chat-stop hidden>■ 停止生成</button><button type="submit" class="ai-send" data-chat-send>发送 ↑</button></div></form></div></div></div><dialog class="ai-space-dialog" data-chat-space-dialog aria-labelledby="space-dialog-heading"><header><div><h3 id="space-dialog-heading">空间访问范围</h3><p>只读使用，配置按当前账号与盒子记住。</p></div><button data-chat-action="space-close" aria-label="关闭空间范围设置">×</button></header><fieldset class="ai-space-modes"><legend class="sr-only">选择访问范围</legend><label><input type="radio" name="assistant-space-mode" value="all" data-space-mode/>全部空间</label><label><input type="radio" name="assistant-space-mode" value="space" data-space-mode/>指定空间</label><label><input type="radio" name="assistant-space-mode" value="folder" data-space-mode/>指定文件夹</label></fieldset><label class="ai-space-choice" data-space-choice>选择空间<select data-space-select aria-label="选择空间"></select></label><div class="ai-space-directory" data-space-directory hidden><nav data-space-crumbs aria-label="文件夹路径"></nav><div data-space-folders></div></div><p class="ai-space-selection" data-space-selection></p><p class="ai-space-note" data-space-note role="status"></p><footer><button data-chat-action="space-close">取消</button><button data-chat-action="space-confirm" data-space-confirm>使用所选范围</button></footer></dialog><dialog class="ai-history-dialog" data-chat-history-dialog aria-labelledby="history-dialog-heading"><header><h3 id="history-dialog-heading">管理对话</h3><button data-chat-action="history-close" aria-label="关闭历史管理">×</button></header><p class="ai-history-dialog-title" data-history-dialog-title></p><form data-history-rename-form><label>对话名称<input data-history-rename-input maxlength="100" required aria-label="对话名称"/></label><button type="submit">保存名称</button></form><div class="ai-history-dialog-actions" data-history-dialog-actions></div><p data-history-dialog-note role="status"></p></dialog><dialog class="ai-artifact-dialog" data-chat-artifact-dialog><div class="ai-artifact-title"><strong data-artifact-name></strong><button data-chat-action="close-artifact" aria-label="关闭产物预览">×</button></div><div data-artifact-content></div><div class="ai-artifact-footer"><span data-artifact-note></span><button data-chat-action="save-artifact">保存文件</button></div></dialog></section>`;
      $('[data-chat-input]').value = draft;
      mountConversationSettings();
      $('[data-chat-input]').addEventListener('input', event => { draft = event.target.value; event.target.style.height = 'auto'; event.target.style.height = `${Math.min(160, event.target.scrollHeight)}px`; paintStatus(); });
      $('[data-chat-input]').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } });
      $('[data-chat-composer]').addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); void send(); });
      $('[data-chat-reference-text]').addEventListener('input', event => { reference = event.target.value; paintStatus(); });
      $('[data-chat-search]').addEventListener('input', event => { query = event.target.value; historyPage = 1; historySelection.clear(); paintHistory(); });
      $('[data-history-kind]').addEventListener('change', event => { historyKind = event.target.value; historyPage = 1; historySelection.clear(); paintHistory(); });
      $('[data-history-sort]').addEventListener('change', event => { historySort = event.target.value; historyPage = 1; paintHistory(); });
      $('[data-history-rename-form]').addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); if (managedKey) void organizeHistory('rename', [managedKey], $('[data-history-rename-input]').value.trim()); });
      $('[data-chat-space-toggle]').addEventListener('change', async event => {
        if (event.target.checked) { await showSpaceSettings(); paintStatus(); }
        else { try { await disableSpace(); } catch (e) { error = errorText(e); paintStatus(); } }
      });
      $('[data-chat-space-dialog]').addEventListener('cancel', () => { paintStatus(); });
      $('[data-space-select]').addEventListener('change', async event => { scopeSpaceId = event.target.value; scopeFolderId = ''; scopeFolders = []; scopeCrumbs = []; if (scopeMode === 'folder') await browseSpace(); else paintSpaceDialog(); });
      $('[data-chat-model-search]').addEventListener('input', event => { modelQuery = event.target.value; paintModels(); });
      root.addEventListener('keydown', event => { if (event.key === 'Escape' && !root.querySelector('dialog[open]')) { pickerOpen = false; historyOpen = false; paintModels(); paintHistory(); } });
      root.addEventListener('submit', async event => {
        const form = event.target.closest('[data-chat-approval]'); if (!form) return;
        event.preventDefault(); event.stopPropagation(); if (busy || !pending) return;
        const data = new FormData(form);
        let decisions;
        try { decisions = pending.action_requests.map((action, i) => {
          if (action.name === 'ask_user_question') {
            const answers = (action.args?.questions || []).map((q, n) => {
              const values = data.getAll(`q-${i}-${n}`).map(String), free = String(data.get(`free-${i}-${n}`) || '').trim();
              if (free) values.push(free);
              if (!values.length) throw new Error('请回答每个问题后再提交。');
              return `${q.question}\n${values.join('; ')}`;
            });
            return { type: 'respond', message: answers.join('\n\n') };
          }
          const response = String(data.get(`response-${i}`) || '').trim();
          return response ? { type: 'respond', message: response } : { type: String(data.get(`decision-${i}`)) };
        });
        } catch (e) { error = e.message; paintStatus(); return; }
        const gen = generation, turn = epoch; busy = true; paintStatus();
        try { await call('resume', { threadId, decisions }); if (gen !== generation || turn !== epoch) return; pending = null; active = true; paintPending(); }
        catch (e) { if (gen === generation && turn === epoch) error = errorText(e); }
        finally { if (gen === generation && turn === epoch) { busy = false; paintStatus(); } }
      });
      async function previewArtifact(filePath, save = false) {
      $('[data-chat-artifact-dialog] [data-chat-action="save-artifact"]').hidden = false;
        const gen = generation, turn = epoch;
        try {
          const value = await call('artifact', { threadId, path: filePath, save });
          if (gen !== generation || turn !== epoch) return;
          if (save) { $('[data-artifact-note]').textContent = value.saved ? '文件已保存。' : '已取消保存。'; return; }
          artifactPath = filePath; $('[data-artifact-name]').textContent = value.name;
          const node = $('[data-artifact-content]'); node.replaceChildren();
          if (value.dataURL) { const img = document.createElement('img'); img.src = value.dataURL; img.alt = value.name; node.append(img); }
          else if (value.text != null) { const pre = document.createElement('pre'); pre.textContent = value.text; node.append(pre); }
          else node.textContent = '这类文件暂不支持内嵌预览，可以保存后打开。';
          $('[data-artifact-note]').textContent = value.truncated ? '预览显示前 500000 字节，保存可获取完整文件。' : '';
          $('[data-chat-artifact-dialog]').showModal();
        } catch (e) { if (gen === generation && turn === epoch) { error = errorText(e); paintStatus(); } }
      }
      root.addEventListener('change', async event => { if (event.target.matches('[data-space-mode]')) { scopeMode = event.target.value; if (scopeMode === 'folder') await browseSpace(scopeFolderId); else paintSpaceDialog(); } if (event.target.dataset.historySelect) { const key = event.target.dataset.historySelect; event.target.checked ? historySelection.add(key) : historySelection.delete(key); paintHistory(); } if (event.target.dataset.legacyAnswer) legacyAnswer = event.target.dataset.legacyAnswer; });
      root.addEventListener('click', async event => {
        const button = event.target.closest('[data-chat-action]'); if (!button || button.disabled) return;
        const action = button.dataset.chatAction, id = button.dataset.id, gen = generation, turn = epoch;
        try {
          if (action === 'history') { historyOpen = !historyOpen; paintHistory(); }
          if (action === 'history-menu') openHistoryMenu(button.dataset.key);
          if (action === 'history-close') $('[data-chat-history-dialog]').close();
          if (action === 'history-manage') { historyBatch = !historyBatch; historySelection.clear(); paintHistory(); }
          if (action === 'history-filter') { historyStatus = button.dataset.historyStatus; historyPage = 1; historySelection.clear(); paintHistory(); }
          if (action === 'history-prev') { historyPage--; historySelection.clear(); paintHistory(); }
          if (action === 'history-next') { historyPage++; historySelection.clear(); paintHistory(); }
          if (action === 'history-refresh') await load();
          if (action === 'history-select-page') { const page = filteredHistory().slice((historyPage - 1) * 50, historyPage * 50), all = page.every(s => historySelection.has(s.key)); for (const row of page) all ? historySelection.delete(row.key) : historySelection.add(row.key); paintHistory(); }
          if (action === 'history-apply' && managedKey) await organizeHistory(button.dataset.operation, [managedKey]);
          if (action === 'history-bulk') await organizeHistory(button.dataset.operation, [...historySelection]);
          if (action === 'history-export' && managedKey && !historyBusy) {
            const row = allHistory().find(s => s.key === managedKey);
            if (row) { const result = await call('history-export', { kind: row.kind, id: row.id }); if (gen === generation) $('[data-history-dialog-note]').textContent = result.saved ? '对话文件已保存。' : '已取消导出。'; }
          }
          if (action === 'space-settings') await showSpaceSettings();
          if (action === 'space-root') await browseSpace();
          if (action === 'space-folder') await browseSpace(id);
          if (action === 'settings') { paintModels(); paintStatus(); $('[data-chat-settings-dialog]').showModal(); }
          if (action === 'settings-close') $('[data-chat-settings-dialog]').close();
          if (action === 'knowledge-settings') await showKnowledgeSettings();
          if (action === 'knowledge-close') { $('[data-chat-knowledge-dialog]').close(); paintStatus(); }
          if (action === 'knowledge-confirm') await confirmKnowledge();
          if (action === 'knowledge-source') await previewKnowledge(id);
          if (action === 'space-close') { $('[data-chat-space-dialog]').close(); paintStatus(); }
          if (action === 'space-confirm') await confirmSpace();
          if (action === 'models') { pickerOpen = !pickerOpen; paintModels(); if (pickerOpen) $('[data-chat-model-search]').focus(); }
          if (action === 'close-models') { pickerOpen = false; paintModels(); }
          if (action === 'model' && models.some(m => m.id === id)) {
            const previous = selected; selected = id; savedModel = id; pickerOpen = false; paintModels(); paintStatus();
            try { await call('model', { threadId: legacy ? null : threadId, model: id }); }
            catch (e) { if (gen === generation && turn === epoch && selected === id) { selected = previous; savedModel = previous; error = errorText(e); paintModels(); paintStatus(); } }
          }
          if (action === 'new') await newChat();
          if (action === 'reconnect') { error = ''; await load(); }
          if (action === 'boxes') onBoxes();
          if (action === 'open') { if (legacy) { legacy = null; legacyId = null; } await openThread(id); }
          if (action === 'legacy' && !busy && !uploading) {
            if (spaceEnabled || knowledgeEnabled) await call('release-context');
            epoch++; const expected = epoch; stopWatch(); opening = true; paintStatus();
            const result = await call('legacy-open', { sessionId: id });
            if (gen !== generation || expected !== epoch) return;
            legacy = result.session; legacyId = id; legacyAnswer = legacy.groups?.at(-1)?.answers[0]?.id || null; opening = false; paint();
          }
          if (action === 'bring-legacy' && legacy) {
            const value = legacyReference(legacy, legacyAnswer); await newChat(); reference = value;
            if (value.length > 32000) error = '参考内容超过 32000 字符，请在下方删减后再发送。';
            paintStatus(); $('[data-chat-reference-text]').focus();
          }
          if (action === 'remove-reference') { reference = ''; paintStatus(); }
          if (action === 'older' && !active && !busy) {
            const value = await call('open', { threadId, offset: historyCount });
            if (gen !== generation || turn !== epoch) return;
            const area = $('[data-chat-messages]'), before = area.scrollHeight; acceptHistory(value.history, true); paintMessages(); area.scrollTop += area.scrollHeight - before;
          }
          if (action === 'upload' && !uploading) {
            uploading = true; error = ''; paintStatus();
            try {
              const value = await call('upload');
              if (gen !== generation || turn !== epoch) return;
              const extra = value.files.slice(Math.max(0, 8 - attachments.length)); release(extra); attachments.push(...value.files.slice(0, 8 - attachments.length));
              if (extra.length) error = '一条消息最多添加 8 个附件，多余的附件未加入消息。';
            } finally { if (gen === generation && turn === epoch) { uploading = false; paintStatus(); } }
          }
          if (action === 'remove-file') { release(attachments.filter(f => f.handle === id)); attachments = attachments.filter(f => f.handle !== id); paintStatus(); }
          if (action === 'stop') { await call('stop', { threadId }); if (gen === generation && turn === epoch) { notice = '正在停止，已生成的内容会保留。'; paintStatus(); } }
          if (['copy', 'copy-code', 'copy-legacy'].includes(action)) {
            const value = action === 'copy-code' ? button.dataset.code : action === 'copy-legacy' ? legacy.groups.flatMap(g => g.answers).find(a => a.id === id)?.text : messages.find(m => m.id === id)?.text;
            if (value) { await navigator.clipboard.writeText(value); button.textContent = '已复制'; }
          }
          if (action === 'artifact') await previewArtifact(button.dataset.path);
          if (action === 'close-artifact') $('[data-chat-artifact-dialog]').close();
          if (action === 'save-artifact' && artifactPath) await previewArtifact(artifactPath, true);
        } catch (e) { if (gen === generation) { opening = false; error = errorText(e); paintStatus(); } }
      });
      paint();
    }
    return {
      hostState(value) {
        const boxId = value.activeDeviceId || value.selectedDeviceId || value.connection?.deviceId;
        const phase = value.connectionPhase || value.phase;
        const ready = (!phase || ['ready', 'recovering', 'connected'].includes(phase)) && (value.canLaunchApplications !== false || phase === 'recovering');
        const next = ready && value.account?.phase === 'authenticated' && boxId ? JSON.stringify([value.account.accountId, value.account.clientId, boxId, value.connection?.gatewayURL]) : null;
        connected = Boolean(next && boxId); boxName = value.connection?.name || '万象盒子';
        if (next !== context) { generation++; reset(); context = next; if (visible && connected) void load(); }
        else paintStatus();
      },
      modelsChanged() { loaded = false; if (visible && connected) void load(); },
      mount(element) { if (!element) return; if (root !== element) setup(element); if (connected && !loaded && !loading) void load(); },
      visible(value) { if (visible === value) return; visible = value; if (!visible) stopWatch(); else if (connected && !loaded) void load(); else if (scope && threadId && !legacy) void openThread(threadId, false); },
      event(value) {
        if (value.type === 'invalidated') { generation++; context = null; reset(); return; }
        if (value.scope !== scope) return;
        if (value.type === 'turn-submitting') { threadId = value.threadId; runModel = value.model; return; }
        if (value.threadId !== threadId || legacy) return;
        if (value.type === 'assistant-event') {
          if (value.event.type === 'turn_status' && submitted && !submitted.ended && !value.event.active) return;
          if (submitted && ['done', 'error', 'hitl_required'].includes(value.event.type)) submitted.ended = true;
          if (submitted && value.event.type === 'error') submitted.failed = true;
          const snapshot = state(); applyFrame(snapshot, value.event);
          messages = snapshot.messages; active = snapshot.active; pending = snapshot.pending; sequence = snapshot.sequence; error = snapshot.error;
          if (value.event.type === 'error' && submitted && !messages.some(m => m.role === 'assistant' && m.status === 'running')) {
            if (!draft) { draft = submitted.draft; $('[data-chat-input]').value = draft; }
            if (!reference) reference = submitted.reference;
            if (!attachments.length) attachments = submitted.attachments;
          }
          if (value.event.type === 'done' || value.event.type === 'hitl_required') { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void refreshCurrent(), 350); }
          paintMessages(); paintPending(); paintStatus();
        }
        if (value.type === 'resume-ended') { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void refreshCurrent(), 200); }
        if (value.type === 'stream-error') { uncertain = true; error = '连接中断。恢复连接后读取已有结果，不会自动重复发送。'; paintStatus(); }
      },
    };
  };
  // Old settings routes may still be reached by a saved navigation state. Keep
  // them harmless; model choice now lives in the persistent conversation header.
  window.createDialogueModelSettingsView = () => ({ hostState() {}, visible() {}, mount(element) { if (element) element.innerHTML = '<p class="muted">模型现在可以在 助理顶部直接切换。</p>'; } });
})();
