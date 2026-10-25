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
  };
  const errorText = error => errors[error?.code] || '操作未完成，草稿已保留。请恢复连接后重试。';
  window.wanxAssistantState = { esc, markdown, historyMessages, applyFrame, legacyReference, legacyTrail };
  window.wanxDialogueState = { trail: legacyTrail, richText: markdown, isLocalModel: m => Boolean(m.is_local) };

  window.createAIDialogueView = ({ request, onBoxes }) => {
    let root, context = null, generation = 0, epoch = 0, visible = false, connected = false, loaded = false, loading = false;
    let scope = null, models = [], selected = null, sessions = [], legacySessions = [], legacy = null, legacyId = null, legacyAnswer = null;
    let threadId = null, messages = [], draft = '', attachments = [], reference = '', historyOpen = false, query = '', pickerOpen = false, modelQuery = '';
    let busy = false, uploading = false, opening = false, active = false, uncertain = false, pending = null, runModel = null, sequence = 0;
    let error = '', notice = '', hasMore = false, historyCount = 0, boxName = '', pendingPaint = '', submitted = null, refreshTimer = null;
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
        if (!selected) selected = result.defaultModel;
        else if (!models.some(m => m.id === selected)) error = errors.MODEL_UNAVAILABLE;
        if (result.legacyUnavailable) notice = '旧版记录暂时无法读取，可稍后恢复连接重试。';
        if (threadId && turn === epoch) await openThread(threadId, false);
      } catch (e) { if (gen === generation) error = errorText(e); }
      finally { if (gen === generation) { loading = false; paint(); } }
    }
    function acceptHistory(history, older = false) {
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
      const turn = ++epoch, gen = generation; opening = true; error = ''; stopWatch(); paintStatus();
      try {
        const result = await call('open', { threadId: id });
        if (turn !== epoch || gen !== generation) return;
        const changedThread = threadId !== id; threadId = id; legacy = null; legacyId = null; submitted = null;
        if (changedThread) messages = [];
        acceptHistory(result.history);
        if (choose && result.history.model_ref) selected = result.history.model_ref;
        if (selected && !models.some(m => m.id === selected)) error = errors.MODEL_UNAVAILABLE;
        runModel = result.history.model_ref || selected;
        await call('watch', { threadId });
      } catch (e) { if (turn === epoch && gen === generation) error = errorText(e); }
      finally { if (turn === epoch && gen === generation) { opening = false; paint(); } }
    }
    function newChat() {
      if (busy || uploading) return;
      epoch++; clearTimeout(refreshTimer); stopWatch(); release(); threadId = null; legacy = null; legacyId = null; legacyAnswer = null;
      messages = []; active = false; uncertain = false; pending = null; pendingPaint = ''; draft = ''; attachments = []; reference = ''; submitted = null; hasMore = false;
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
      if (busy || uploading || opening || active || uncertain || pending || legacy || !scope || !models.some(m => m.id === selected)) return;
      const text = draft.trim(); if (!text && !attachments.length && !reference.trim()) return;
      const prompt = reference.trim() ? `${reference.trim()}\n\n【现在的请求】\n${text}` : text;
      if (prompt.length > 32000) { error = '历史参考与消息合计最多 32000 字符，请删减参考内容后发送。'; paintStatus(); return; }
      const gen = generation, turn = epoch, sentFiles = attachments.slice(), sentDraft = draft, sentReference = reference;
      submitted = { draft: sentDraft, reference: sentReference, attachments: sentFiles, prompt, model: selected, ended: false, failed: false };
      busy = true; error = ''; active = true; runModel = selected;
      messages.push({ id: `optimistic-${++sequence}`, role: 'user', text, reference: sentReference, files: sentFiles }); paint();
      try {
        const result = await call('send', { threadId, model: selected, prompt, attachments: sentFiles.map(f => f.handle) });
        if (gen !== generation || turn !== epoch) return;
        threadId = result.threadId;
        if (!submitted.failed && draft === sentDraft) { draft = ''; $('[data-chat-input]').value = ''; $('[data-chat-input]').style.height = ''; }
        if (!submitted.failed && reference === sentReference) reference = '';
        if (!submitted.failed) attachments = attachments.filter(f => !sentFiles.some(item => item.handle === f.handle));
        active = !submitted.ended && !pending;
        if (!sessions.some(s => s.thread_id === threadId)) sessions.unshift({ thread_id: threadId, title: text.slice(0, 35) || '附件对话' });
        paintHistory();
      } catch (e) {
        if (gen !== generation || turn !== epoch) return;
        active = false; error = errorText(e); uncertain = Boolean(threadId) && !['MODEL_UNAVAILABLE', 'ASSISTANT_ATTACHMENT_EXPIRED', 'ASSISTANT_TURN_ACTIVE', 'ASSISTANT_MODEL_NEEDS_IMAGE'].includes(e.code);
        if (!uncertain) messages = messages.filter(m => !m.id.startsWith('optimistic-'));
      } finally { if (gen === generation && turn === epoch) { busy = false; paint(); } }
    }
    function paintModels() {
      const node = $('[data-chat-models]'); if (!node) return;
      const chosen = modelFor(selected), quick = models.filter(m => m.id !== selected).slice(0, 4);
      node.innerHTML = `<div class="ai-model-current"><span class="ai-model-eyebrow">当前 AI</span><button class="ai-current-choice" data-chat-action="models" aria-haspopup="dialog" aria-expanded="${pickerOpen}"><span class="ai-model-icon">${icon(chosen)}</span><strong>${esc(selected ? chosen.name : '选择模型')}</strong><span class="ai-chevron">⌄</span></button></div><div class="ai-quick-models">${quick.map(m => `<button data-chat-action="model" data-id="${esc(m.id)}" class="ai-model"><span class="ai-model-icon">${icon(m)}</span><span>${esc(m.name)}</span></button>`).join('')}</div><button class="ai-more-models" data-chat-action="models" aria-expanded="${pickerOpen}">更多模型 <span>⌄</span></button>`;
      const picker = $('[data-chat-model-picker]'); picker.hidden = !pickerOpen;
      const needle = modelQuery.trim().toLowerCase();
      $('[data-chat-model-options]').innerHTML = models.filter(m => `${m.name} ${m.provider}`.toLowerCase().includes(needle)).map(m => `<button data-chat-action="model" data-id="${esc(m.id)}" class="ai-model-option" aria-pressed="${m.id === selected}"><span class="ai-model-icon">${icon(m)}</span><span><strong>${esc(m.name)}</strong><small>${esc(m.provider)}</small></span>${m.id === selected ? '<span class="ai-selected-tick">✓</span>' : ''}</button>`).join('') || '<p class="ai-empty-label">没有找到可用模型</p>';
      $('[data-chat-next-model]').textContent = active && selected !== runModel ? `下一条消息使用 ${chosen.name}，当前回答继续完成。` : '同一段对话，随时换一个 AI 接着工作。';
    }
    function messageMarkup(message) {
      if (message.role === 'tool') return `<details class="ai-tool"><summary><span class="ai-tool-dot ${message.status}"></span>${esc(message.name || '工具')}<span>${message.status === 'running' ? '正在执行' : message.status === 'error' ? '未完成' : message.status === 'interrupted' ? '已中断' : message.status === 'called' ? '已调用' : '已完成'}</span></summary><pre>${esc(message.text || '正在处理…')}</pre></details>`;
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
        area.innerHTML = `<div class="ai-welcome"><div class="ai-welcome-brand"><img src="./assets/centaurai-mark.png" alt=""/><span>半人马AI · 万象</span></div><h1>万象<span>·</span>助理</h1><p>写一段文字，理清一个问题，推进手头的工作。<br/>选择合适的 AI，从这里开始。</p><div class="ai-starters">${[['写作', '把想法变成清晰的表达', '请帮我起草一段文字。用途是：\n希望表达的重点是：'], ['总结', '从材料中提炼重点', '请帮我总结以下材料，提炼重点与待办：\n\n'], ['分析', '梳理问题，比较选择', '请帮我分析这个问题，比较可行选项和各自的取舍：\n\n'], ['计划', '把目标拆成下一步行动', '请帮我把这个目标拆成可执行的计划：\n\n']].map(([title, description, prompt], i) => `<button data-chat-action="starter" data-prompt="${esc(prompt)}"><span class="ai-starter-number">0${i + 1}</span><strong>${title}</strong><span>${description}</span><b aria-hidden="true">↗</b></button>`).join('')}</div>${!connected ? '<button class="ai-connect" data-chat-action="boxes">连接万象盒子</button>' : ''}</div>`;
      } else {
        area.innerHTML = `<div class="ai-transcript">${hasMore ? '<button class="ai-load-older" data-chat-action="older">查看更早的消息</button>' : ''}${messages.map(messageMarkup).join('')}${active && messages.at(-1)?.role !== 'assistant' ? `<div class="ai-working"><span></span>万象·助理正在处理…</div>` : ''}</div>`;
      }
      if (follow) area.scrollTop = area.scrollHeight;
    }
    function paintHistory() {
      if (!$('[data-chat-history]')) return;
      $('[data-chat-history]').hidden = !historyOpen; $('.ai-dialogue').classList.toggle('history-collapsed', !historyOpen);
      for (const button of root.querySelectorAll('[data-chat-action="history"]')) button.setAttribute('aria-expanded', String(historyOpen));
      const filtered = list => list.filter(s => (s.title || '新对话').toLowerCase().includes(query.toLowerCase()));
      const group = (list, old) => list.length ? `<p class="ai-history-caption">${old ? '旧版对话' : '助理对话'}</p>${filtered(list).map(s => `<button class="ai-history-item" data-chat-action="${old ? 'legacy' : 'open'}" data-id="${esc(old ? s.session_id : s.thread_id)}" ${old ? legacyId === s.session_id ? 'aria-current="page"' : '' : threadId === s.thread_id ? 'aria-current="page"' : ''}><span>${esc(s.title || '新对话')}</span>${old ? '<small>旧版</small>' : ''}</button>`).join('')}` : '';
      $('[data-chat-history-list]').innerHTML = group(sessions, false) + group(legacySessions, true) || '<p class="ai-history-empty">从第一句开始，<br/>聊过的内容会留在这里。</p>';
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
      const line = error || notice || (loading ? '正在连接万象·助理…' : !connected ? '连接万象盒子后开始工作。' : !models.length && loaded ? '后台暂无可用的对话模型。配置后可恢复连接。' : '');
      const node = $('[data-chat-notice]'); node.hidden = !line;
      node.innerHTML = `<span>${esc(line)}</span>${connected && (error || uncertain || !models.length && loaded) ? '<button data-chat-action="reconnect">恢复连接</button>' : ''}`;
      const input = $('[data-chat-input]'); input.disabled = !connected || !scope || Boolean(legacy);
      const send = $('[data-chat-send]'); send.disabled = !scope || busy || uploading || opening || active || uncertain || Boolean(pending) || Boolean(legacy) || !models.some(m => m.id === selected) || !draft.trim() && !attachments.length && !reference.trim();
      send.textContent = busy ? '发送中' : '发送 ↑';
      $('[data-chat-stop]').hidden = !active || Boolean(legacy); $('[data-chat-stop]').disabled = busy;
      $('[data-chat-attach]').disabled = !scope || busy || uploading || Boolean(legacy) || attachments.length >= 8;
      $('[data-chat-attach]').textContent = uploading ? '正在添加…' : '＋ 添加附件';
      $('[data-chat-composer]').hidden = Boolean(legacy);
      $('[data-chat-attachments]').innerHTML = attachments.map(file => `<span class="ai-attachment">▤ ${esc(file.name)}<button type="button" data-chat-action="remove-file" data-id="${esc(file.handle)}" aria-label="移除 ${esc(file.name)}">×</button></span>`).join('');
      $('[data-chat-reference]').hidden = !reference;
      if ($('[data-chat-reference-text]').value !== reference) $('[data-chat-reference-text]').value = reference;
      $('[data-chat-reference-count]').textContent = `${reference.length} / 32000 字符，可编辑删减`;
      for (const button of root.querySelectorAll('[data-chat-action="new"]')) button.disabled = busy || uploading;
      for (const button of root.querySelectorAll('[data-chat-action="model"]')) button.disabled = !scope || opening;
    }
    function paint() { if (!root) return; paintModels(); paintMessages(); paintHistory(); paintPending(); paintStatus(); }
    function setup(element) {
      root = element;
      root.innerHTML = `<section class="ai-dialogue history-collapsed"><aside class="ai-history" data-chat-history hidden><div class="ai-sidebar-heading"><div class="ai-sidebar-brand"><img src="./assets/centaurai-mark.png" alt=""/><strong>万象·助理</strong></div><button data-chat-action="history" aria-label="收起历史对话">‹</button></div><button class="ai-sidebar-new" data-chat-action="new">＋ 新对话</button><label class="ai-history-search"><span class="sr-only">搜索对话</span><input type="search" data-chat-search placeholder="搜索对话"/></label><div data-chat-history-list></div></aside><div class="ai-chat-workspace"><header class="ai-dialogue-heading"><div><button data-chat-action="history" class="ai-history-toggle" aria-label="展开或收起历史对话">☰ <span>历史</span></button><span class="ai-heading-divider"></span><strong>万象·助理</strong><span class="ai-private-label">通用专家 · 私人会话</span></div><button class="ai-sidebar-new ai-collapsed-new" data-chat-action="new">＋ 新对话</button></header><div class="ai-model-section"><div class="ai-model-strip" data-chat-models></div><div class="ai-model-picker" data-chat-model-picker hidden role="dialog" aria-label="选择 AI 模型"><div><strong>选择 AI 模型</strong><button data-chat-action="close-models" aria-label="关闭模型选择">×</button></div><input type="search" data-chat-model-search placeholder="搜索模型或提供商" aria-label="搜索模型或提供商"/><div data-chat-model-options></div></div><p class="ai-model-hint" data-chat-next-model></p></div><div class="ai-chat-notice" data-chat-notice role="status" hidden></div><div class="ai-messages" data-chat-messages role="log" aria-label="助理对话记录"></div><div class="ai-bottom-dock"><div class="ai-artifacts" data-chat-artifacts></div><div class="ai-pending" data-chat-pending></div><form class="ai-composer" data-chat-composer><details class="ai-reference" data-chat-reference hidden open><summary>旧版对话参考 <span data-chat-reference-count></span><button type="button" data-chat-action="remove-reference">移除</button></summary><textarea data-chat-reference-text rows="4" aria-label="编辑旧版对话参考"></textarea></details><div class="ai-attachments" data-chat-attachments></div><textarea data-chat-input rows="2" maxlength="32000" placeholder="把问题、材料或想法交给我…" aria-label="给万象·助理发消息"></textarea><div class="ai-composer-bottom"><button type="button" data-chat-action="upload" data-chat-attach>＋ 添加附件</button><span>Enter 发送 · Shift + Enter 换行</span><button type="button" class="ai-stop" data-chat-action="stop" data-chat-stop hidden>■ 停止生成</button><button type="submit" class="ai-send" data-chat-send>发送 ↑</button></div></form></div></div><dialog class="ai-artifact-dialog" data-chat-artifact-dialog><div class="ai-artifact-title"><strong data-artifact-name></strong><button data-chat-action="close-artifact" aria-label="关闭产物预览">×</button></div><div data-artifact-content></div><div class="ai-artifact-footer"><span data-artifact-note></span><button data-chat-action="save-artifact">保存文件</button></div></dialog></section>`;
      $('[data-chat-input]').value = draft;
      $('[data-chat-input]').addEventListener('input', event => { draft = event.target.value; event.target.style.height = 'auto'; event.target.style.height = `${Math.min(160, event.target.scrollHeight)}px`; paintStatus(); });
      $('[data-chat-input]').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } });
      $('[data-chat-composer]').addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); void send(); });
      $('[data-chat-reference-text]').addEventListener('input', event => { reference = event.target.value; paintStatus(); });
      $('[data-chat-search]').addEventListener('input', event => { query = event.target.value; paintHistory(); });
      $('[data-chat-model-search]').addEventListener('input', event => { modelQuery = event.target.value; paintModels(); });
      root.addEventListener('keydown', event => { if (event.key === 'Escape') { pickerOpen = false; historyOpen = false; paintModels(); paintHistory(); } });
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
      let artifactPath = null;
      async function previewArtifact(filePath, save = false) {
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
      root.addEventListener('change', event => { if (event.target.dataset.legacyAnswer) legacyAnswer = event.target.dataset.legacyAnswer; });
      root.addEventListener('click', async event => {
        const button = event.target.closest('[data-chat-action]'); if (!button || button.disabled) return;
        const action = button.dataset.chatAction, id = button.dataset.id, gen = generation, turn = epoch;
        try {
          if (action === 'history') { historyOpen = !historyOpen; paintHistory(); }
          if (action === 'models') { pickerOpen = !pickerOpen; paintModels(); if (pickerOpen) $('[data-chat-model-search]').focus(); }
          if (action === 'close-models') { pickerOpen = false; paintModels(); }
          if (action === 'model' && models.some(m => m.id === id)) {
            const previous = selected; selected = id; pickerOpen = false; paintModels(); paintStatus();
            try { await call('model', { threadId: legacy ? null : threadId, model: id }); }
            catch (e) { if (gen === generation && turn === epoch && selected === id) { selected = previous; error = errorText(e); paintModels(); paintStatus(); } }
          }
          if (action === 'new') newChat();
          if (action === 'reconnect') { error = ''; await load(); }
          if (action === 'boxes') onBoxes();
          if (action === 'open') { if (legacy) { legacy = null; legacyId = null; } await openThread(id); }
          if (action === 'legacy' && !busy && !uploading) {
            epoch++; const expected = epoch; stopWatch(); opening = true; paintStatus();
            const result = await call('legacy-open', { sessionId: id });
            if (gen !== generation || expected !== epoch) return;
            legacy = result.session; legacyId = id; legacyAnswer = legacy.groups?.at(-1)?.answers[0]?.id || null; opening = false; paint();
          }
          if (action === 'bring-legacy' && legacy) {
            const value = legacyReference(legacy, legacyAnswer); newChat(); reference = value;
            if (value.length > 32000) error = '参考内容超过 32000 字符，请在下方删减后再发送。';
            paintStatus(); $('[data-chat-reference-text]').focus();
          }
          if (action === 'starter' && !busy && !legacy) { draft = draft ? `${draft}\n\n${button.dataset.prompt}` : button.dataset.prompt; $('[data-chat-input]').value = draft; paintStatus(); $('[data-chat-input]').focus(); }
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
          if (value.event.type === 'turn_status' && busy && submitted) return;
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
