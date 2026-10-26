// Mini assistant uses the same renderer and a dedicated, trusted main-process service.
(() => {
  const api = window.wanxPanel;
  window.wanxAssistantAssetBase = '../renderer/assets';
  let state = {}, opened = false;
  const home = document.getElementById('panel-content');
  const shell = document.createElement('section');
  shell.id = 'panel-assistant'; shell.hidden = true; shell.setAttribute('aria-label', '迷你助理');
  shell.innerHTML = '<header class="mini-assistant-header"><button type="button" data-mini-back aria-label="返回我的应用">‹</button><strong>万象·对话</strong><nav><button type="button" data-mini-new aria-label="新对话" title="新对话">＋</button><button type="button" data-mini-expand aria-label="在主窗口打开对话" title="打开完整版">↗</button></nav></header><button type="button" class="mini-assistant-context" data-mini-expand hidden></button><div id="assistant-mini-host"></div><p class="mini-assistant-error" role="status"></p>';
  document.getElementById('panel').append(shell);
  const view = window.createAIDialogueView({
    compact: true,
    onSummary({sources}) {
      const badge=shell.querySelector('.mini-assistant-context');badge.hidden=!sources.length;
      badge.textContent='已接入 '+sources.join('、')+' · 在完整版管理 ↗';
    },
    request: (action, input) => window.wanxPanelAssistant.request(action, input),
    onBoxes: () => api.action('desktop-open', {page: 'boxes'}),
  });
  function show(value) {
    opened = value; shell.hidden = !value; home.hidden = value;
    document.body.classList.toggle('assistant-view', value);
    view.hostState(state);
    if (value) { view.mount(document.getElementById('assistant-mini-host')); view.restoreRecent(); view.visible(true); }
    else view.visible(false);
    void api.action('desktop-resize', {height: 560});
  }
  document.addEventListener('click', async event => {
    if (event.target.closest('[data-assistant-open]')) show(true);
    if (event.target.closest('[data-mini-back]')) show(false);
    if (event.target.closest('[data-mini-new]')) void view.newConversation();
    if (event.target.closest('[data-mini-expand]')) {
      try { await window.wanxPanelAssistant.expand(view.snapshot()); }
      catch { shell.querySelector('.mini-assistant-error').textContent = '主窗口暂未打开，草稿已保留。'; }
    }
  });
  document.addEventListener('keydown', event => {
    if (opened && event.key === 'Escape' && !shell.querySelector('dialog[open]')) {
      event.preventDefault(); event.stopPropagation(); show(false);
    }
  }, true);
  for (const name of ['dragenter', 'dragover', 'drop']) document.addEventListener(name, event => {
    if (opened) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  api.onState(value => {state = value; view.hostState(value);});
  api.getState().then(value => {state = value; view.hostState(value);});
  window.addEventListener('focus', () => {
    if (opened) void api.getState().then(value => {state = value; view.hostState(value);view.restoreRecent();});
  });
  window.wanxPanelAssistant.onEvent(value => view.event(value));
})();
