(() => {
  const api = window.wanxPanel, surface = document.getElementById("panel");
  const root = document.getElementById("panel-content") || surface;
  const overlay = document.getElementById("panel-drop");
  let space = { tasks: [] }, spaceRevision = 0, spaceRequest = null;
  let dragDepth = 0, dragScope = null, dragInvalid = false, interacting = false, pendingRender = false;
  let state = {}, notice = "", selected = "", intentId = "";
  let accountIdentity = "", sessionGeneration = 0;
  let applicationNames = new Map(), namesRequest = null;
  let balance = null, balancePhase = "idle", balanceRequest = null;
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const errorText = error => {
    if (error?.code === "SPACE_UPLOAD_LIMIT" && typeof error.message === "string") return error.message;
    const code = String(error?.message || error || "");
    const errors = {
      SPACE_CONTEXT_CHANGED: "盒子或账号已变化，请重新拖入文件。",
      SPACE_UPGRADE_REQUIRED: "当前盒子尚不支持文件空间，请升级盒端服务。",
      SPACE_DROP_FILES_ONLY: "暂不支持文件夹，请拖入本地文件。",
      SPACE_INVALID_NAME: "文件名包含不支持的字符、首尾空格或过长，请先在本机重命名；本批文件未上传。",
      SPACE_INVALID_DROP: "无法读取拖入的文件，请从访达重新拖入。",
      SPACE_DISK_FULL: "盒子存储空间不足，请清理后重试。",
      SPACE_RETRY_EXHAUSTED: "自动重试未成功，进度已保留，连接稳定后点击继续。",
      SPACE_UPLOAD_OFFSET_INVALID: "盒子返回的上传进度无效，请在空间中查看。",
      SPACE_CONNECTION_TIMEOUT: "上传连接超时，请稍后继续。",
      SPACE_LOCAL_FILE_CHANGED: "本地文件已变化，请重新上传。",
      SPACE_UNAVAILABLE: "文件空间暂不可用。",
      SPACE_REQUEST_FAILED: "上传未完成，请稍后重试。",
      SECURE_STORAGE_READ_FAILED: "无法读取上传记录，请在文件空间查看。",
      SECURE_STORAGE_WRITE_FAILED: "无法保存上传记录，请在文件空间查看。",
    BOX_APPLICATION_PLATFORM_SESSION_REQUIRED: "请登录万象并选择已关联的盒子后打开此应用。",
    BOX_APPLICATION_RUNTIME_UPDATE_REQUIRED: "盒子需要更新万象服务后才能打开此应用，请联系管理员。",
    BOX_APPLICATION_ACCESS_DENIED: "此账号尚未获得应用使用权限，请联系管理员启用并授权。",
    BOX_APPLICATION_SCOPE_FORBIDDEN: "此应用的连接权限不匹配，请更新万象后重试。",
    BOX_APPLICATION_SESSION_INVALID: "无法建立应用会话，请更新万象和盒端服务后重试。",
      ACCOUNT_LOGIN_REQUIRED: "请先登录万象", ACCOUNT_SESSION_CHANGED: "账号已变化，请重新打开应用",
      APPLICATION_OPEN_CANCELLED: "已取消打开", NETWORK_CHANGED: "盒子连接已变化，请重试",
      NETWORK_DEVICE_ACCESS_DENIED: "没有此盒子的访问权限", APPLICATION_OPEN_BUSY: "另一个应用正在打开，请稍候",
      NETWORK_NOT_READY: "网络尚未就绪，请稍后重试", BOX_CONNECTION_REQUIRED: "请先连接盒子",
      APPLICATION_START_FAILED: "应用未能就绪，请重试", APPLICATION_START_TIMEOUT: "应用启动超时，请重试",
      MARKET_OPERATION_BUSY: "此应用正在处理，请稍候", BOX_ACCESS_DENIED: "没有此盒子的访问权限",
    };
    return Object.entries(errors).find(([key]) => code.includes(key))?.[1] || "操作未完成，请重试或在管理窗口查看";
  };
  const phaseText = { opening: "正在打开…", installing: "正在安装…", uninstalling: "正在卸载…", "rolling-back": "正在回退…", selecting: "正在切换版本…" };
  const signedIn = () => state.account?.phase === "authenticated";
  const ready = () => signedIn() && state.phase === "ready" && state.connection?.deviceId && (state.connection.mode === "local" || (state.network?.enabled !== false && state.network?.phase === "ready" && state.platform?.phase === "ready"));
  const devices = () => state.devices || [];
  const available = () => devices().filter(device => device.canOpen);
  function boxStatus() {
    if (!signedIn()) return "登录后连接盒子";
    if (ready()) return state.connection.mode === "local" ? "本机已连接" : "已连接";
    if (state.network?.enabled === false) return "网络已关闭";
    if (state.phase === "recovering") return "正在恢复连接…";
    if (state.phase === "connecting") return "正在连接…";
    return "尚未连接";
  }
  function displayApplication(app) {
    const name = applicationNames.get(app.applicationId);
    return typeof name === "string" && name.trim() ? { ...app, name } : app;
  }
  function refreshApplicationNames() {
    if (!signedIn() || namesRequest) return;
    const generation = sessionGeneration;
    const request = Promise.resolve().then(() => api.getApplicationNames()).then(items => {
      if (generation !== sessionGeneration) return;
      applicationNames = new Map(items.map(item => [item.applicationId, item.name]));
      render();
    }).catch(() => {
      // Keep the last directory on transient failures; initial reads use installed names.
    }).finally(() => {
      if (namesRequest === request) namesRequest = null;
    });
    namesRequest = request;
    return request;
  }
  function renderIntent() {
    const pending = state.ui?.pendingOpen;
    if (!pending) { intentId = ""; return ""; }
    if (pending.id !== intentId) { intentId = pending.id; selected = pending.deviceId || state.ui?.lastDeviceId || available()[0]?.deviceId || ""; }
    const app = (state.applications || []).find(app => app.applicationId === pending.applicationId);
    const name = app ? displayApplication(app).name || "应用" : "应用";
    const processing = ["connecting", "opening"].includes(pending.phase);
    return `<section class="intent"><strong>${processing ? (pending.phase === "connecting" ? "正在连接盒子…" : "正在打开应用…") : "连接盒子并打开应用"}</strong><p>${escape(name)}${processing ? "将在就绪后打开" : "需要连接一个盒子"}</p>${pending.error ? `<p class="error">${errorText(pending.error)}</p>` : ""}${!processing && available().length ? `<select id="target-box" aria-label="选择盒子">${available().map(d => `<option value="${escape(d.deviceId)}" ${d.deviceId === selected ? "selected" : ""}>${escape(d.displayName || d.name || "万象盒子")}</option>`).join("")}</select>` : ""}<div class="actions"><button data-action="cancel">取消</button>${!processing ? (available().length ? '<button class="primary" data-action="confirm">连接并打开</button>' : '<button class="primary" data-page="boxes">发现或配置盒子</button>') : ""}</div></section>`;
  }
  function renderBalance() {
    const points = balance == null ? "—" : balance.toLocaleString("zh-CN");
    const label = !signedIn() ? "登录后查看" : balancePhase === "loading" ? "正在读取…" : balancePhase === "error" ? "暂不可用" : "查看消耗明细";
    return `<button class="balance-card" data-page="${signedIn() ? "credits" : "applications"}" aria-label="${signedIn() ? "积分，" + (balance == null ? label : points + "点，查看消耗明细") : "登录查看积分"}" ${balancePhase === "loading" ? 'aria-busy="true"' : ""}><span class="card-label">可用积分<span class="points-mark" aria-hidden="true">积</span></span><span class="points-value">${points}<small>点</small></span><span class="card-caption">${label}<span aria-hidden="true">↗</span></span></button>`;
  }
  const sameSpace = () => space.scope && space.accountId === state.account?.accountId && space.boxId === state.connection?.deviceId;
  function dropProblem() {
    if (dragInvalid) return "盒子或账号已变化，请重新拖入";
    if (!signedIn()) return "请先登录万象";
    if (!ready()) return "请先连接盒子";
    if (!sameSpace()) return "正在准备文件空间，请稍后重试";
    if (space.phase === "unsupported") return "当前盒子需要升级空间服务";
    if (space.storageError) return "上传记录不可用，请在文件空间查看";
    return "";
  }
  const percent = task => task.phase === "complete" ? 100 : task.size ? Math.min(100, Math.floor(task.offset / task.size * 100)) : 0;
  function renderTransfers() {
    if (!space.scope || !signedIn() || space.accountId !== state.account?.accountId || (state.connection?.deviceId && space.boxId !== state.connection.deviceId)) return "";
    const tasks = (space.tasks || []).filter(task => task.phase !== "canceled");
    const active = tasks.filter(task => task.phase !== "complete");
    const visible = active.slice(-3);
    if (!visible.length) return "";
    const phases = { waiting: "等待连接恢复", retrying: "正在自动重试", queued: "等待上传", checking: "正在校验", running: "正在上传", paused: "已暂停", complete: "上传完成" };
    return `<section class="panel-transfers" aria-label="空间上传"><div class="transfer-heading"><strong>文件上传</strong><span>${active.length} 项待完成</span></div>${visible.map(task => `<div class="panel-transfer"><div class="transfer-label"><span title="${escape(task.name)}">${escape(task.name)}</span><small>${phases[task.phase] || "等待处理"} · ${percent(task)}%</small></div><div class="transfer-controls"><progress aria-label="${escape(task.name)}上传进度" max="100" ${task.phase === "checking" ? "" : `value="${percent(task)}"`}></progress>${["queued", "checking", "running", "waiting", "retrying", "paused"].includes(task.phase) ? `<button data-transfer="${escape(task.id)}" data-command="${task.phase === "paused" ? "resume" : "pause"}">${task.phase === "paused" ? "继续" : "暂停"}</button>` : ""}</div>${task.error && task.phase === "paused" ? `<p class="error">${escape(errorText(task.error))}</p>` : ""}</div>`).join("")}</section>`;
  }
  function renderSpace() {
    const problem = dropProblem();
    const location = state.connection?.name || "尚未连接盒子";
    const status = !signedIn() ? "未登录" : !ready() ? "未连接" : !sameSpace() ? "准备中" : space.phase === "unsupported" ? "需升级" : space.storageError ? "暂不可用" : "已就绪";
    return `<footer class="space-footer" aria-label="空间"><button class="space-entry" data-page="space" aria-label="打开文件空间"><span class="space-volume-icon" aria-hidden="true"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 14h18M7 17h.01M11 17h.01"/></svg></span><span class="space-copy"><span class="space-title">空间</span><span class="space-location" title="${escape(location)} · 全部文件">${escape(location)} · 全部文件</span></span><span class="space-availability"><span class="dot ${problem ? "" : "ready"}" aria-hidden="true"></span>${status}</span><span class="space-arrow" aria-hidden="true">↗</span></button><div class="space-drop-hint ${problem ? "unavailable" : ""}"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M7 18H5a4 4 0 0 1-.5-8A7 7 0 0 1 18 8a5 5 0 0 1 1 10h-2M12 21V11m-4 4 4-4 4 4"/></svg><span>${problem ? escape(problem) : "拖入文件，保存到空间"}</span></div>${renderTransfers()}</footer>`;
  }
  function paintOverlay() {
    if (!overlay) return;
    overlay.hidden = !dragDepth;
    surface.classList.toggle("is-dragging", Boolean(dragDepth));
    if (!dragDepth) return;
    const problem = dropProblem();
    overlay.classList.toggle("unavailable", Boolean(problem));
    overlay.innerHTML = `<div class="drop-card"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M7 18H5a4 4 0 0 1-.5-8A7 7 0 0 1 18 8a5 5 0 0 1 1 10h-2M12 21V11m-4 4 4-4 4 4"/></svg><strong>${problem || "松开上传到文件空间"}</strong><span>${escape(state.connection?.name || "当前盒子")} · 全部文件根目录</span><small>${problem ? "连接就绪后重新拖入文件" : "最多 20 个文件 · 单文件最大 200 MB · 暂不支持文件夹"}</small></div>`;
  }
  function clearDrag() {
    dragDepth = 0; dragScope = null; dragInvalid = false; paintOverlay();
    if (pendingRender) render();
  }
  function acceptSpace(value) {
    spaceRevision++;
    if (dragDepth && value.scope !== dragScope) dragInvalid = true;
    space = value; paintOverlay(); render();
  }
  async function refreshSpace() {
    if (!api.getSpace || spaceRequest) return;
    const generation = sessionGeneration, revision = spaceRevision;
    const request = api.getSpace().then(value => {
      if (generation === sessionGeneration && revision === spaceRevision) acceptSpace(value);
      if (generation === sessionGeneration && ready()) return api.refreshSpace?.();
    }).then(value => {
      if (value && generation === sessionGeneration) acceptSpace(value);
    }).catch(() => {}).finally(() => {
      if (spaceRequest === request) spaceRequest = null;
    });
    spaceRequest = request;
    return request;
  }
  function render() {
    if (dragDepth || interacting) { pendingRender = true; return; }
    pendingRender = false;
    const connection = state.connection || {};
    const apps = (state.applications || []).map(displayApplication);
    root.innerHTML = `<header><div class="brand"><img src="../renderer/assets/centaurai-mark.png" alt="半人马"><span class="brand-copy"><strong>半人马AI-万象</strong><small>CentaurAI-WanX</small></span></div><button class="box-button" data-page="boxes" aria-label="打开盒子"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m12 3 9 5v8l-9 5-9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5"/></svg><span>盒子</span></button></header>
      <section class="summary" aria-label="万象概览"><div class="box-status" aria-label="当前盒子"><span class="card-label">当前盒子<span class="dot ${ready() ? "ready" : ""}" aria-hidden="true"></span></span><strong class="box-name" title="${escape(connection.name || "我的盒子")}">${escape(connection.name || "我的盒子")}</strong><span class="card-caption">${boxStatus()}</span></div>${renderBalance()}</section>
      <section class="my-apps" aria-label="我的应用"><div class="apps-heading"><h2>我的应用</h2><div class="apps-heading-actions">${signedIn() && apps.length ? `<span>${apps.length} 个应用</span>` : ""}<button class="apps-link" data-page="applications" aria-label="打开应用">应用<span aria-hidden="true">↗</span></button></div></div><div class="apps">${!signedIn() ? '<div class="empty">登录后，连接盒子并使用你的应用。<br><button class="primary" data-page="applications">登录万象</button></div>' : apps.length ? apps.map(app => { const op = state.ui?.applicationOperations?.[app.applicationId]; return `<div class="app-row">${window.wanxAppCatalog?.[app.applicationId] ? `<img class="app-icon generated-app-icon" src="../renderer/${window.wanxAppCatalog[app.applicationId].icon}" alt="" />` : `<span class="app-icon" aria-hidden="true">${escape(Array.from(app.name || "应用")[0])}</span>`}<div class="app-body"><div class="app-name">${escape(app.name || app.applicationId)}</div>${op ? `<div class="app-message ${op.phase === "failed" ? "error" : ""}">${op.phase === "failed" ? errorText(op.error) : phaseText[op.phase] || "正在处理…"}</div>` : ""}</div><button class="open" data-app="${escape(app.applicationId)}" aria-label="${op?.phase === "failed" ? "重试打开" : "打开"}${escape(app.name || "应用")}" ${op && op.phase !== "failed" ? "disabled" : ""}>${op?.phase === "failed" ? "重试" : "打开"}</button></div>`; }).join("") : '<p class="empty">还没有应用，去商店挑选一个吧。</p>'}</div></section>
      ${renderIntent()}${notice ? `<p class="notice error" role="status">${escape(notice)}</p>` : ""}${renderSpace()}`;
    resize();
  }
  function refreshBalance() {
    if (!signedIn() || balanceRequest) return;
    const generation = sessionGeneration;
    balancePhase = "loading";
    render();
    const request = Promise.resolve().then(() => api.getBalance()).then(value => {
      if (generation !== sessionGeneration) return;
      if (!Number.isSafeInteger(value?.available) || value.available < 0) throw new Error("invalid_balance");
      balance = value.available; balancePhase = "ready";
    }).catch(() => {
      if (generation !== sessionGeneration) return;
      balance = null; balancePhase = "error";
    }).finally(() => {
      if (generation !== sessionGeneration || balanceRequest !== request) return;
      balanceRequest = null; render();
    });
    balanceRequest = request;
    return request;
  }
  async function act(name, input) {
    const generation = sessionGeneration;
    notice = "";
    try { await api.action(name, input); }
    catch (error) { if (generation === sessionGeneration) notice = errorText(error); }
    if (generation === sessionGeneration) render();
  }
  root.addEventListener("change", event => { if (event.target.id === "target-box") selected = event.target.value; });
  root.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    const { page, app, action, transfer, command } = button.dataset;
    if (transfer) {
      const generation = sessionGeneration;
      void api.transfer(command, transfer, space.scope).catch(error => {
        if (generation === sessionGeneration) { notice = errorText(error); render(); }
      });
      return;
    }
    if (page) { void act("desktop-open", { page }); return; }
    if (app) {
      if ((state.applications || []).find(item => item.applicationId === app)?.selectionRequired) void act("desktop-open", { page: "applications" });
      else void act("applications-request-open", { applicationId: app });
      return;
    }
    if (action === "cancel") void act("applications-cancel-open", { intentId: state.ui.pendingOpen.id });
    if (action === "confirm") {
      const deviceId = root.querySelector("#target-box")?.value;
      if (deviceId) void act("applications-confirm-open", { intentId: state.ui.pendingOpen.id, deviceId });
    }
  });
  const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes("Files");
  surface.addEventListener("dragenter", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (!dragDepth) { dragScope = space.scope; dragInvalid = false; }
    dragDepth++;
    if (dragDepth === 1) paintOverlay();
  });
  surface.addEventListener("dragover", event => {
    if (!hasFiles(event)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = dropProblem() ? "none" : "copy";
  });
  surface.addEventListener("dragleave", event => {
    if (!dragDepth) return;
    if (--dragDepth <= 0) clearDrag();
  });
  surface.addEventListener("drop", async event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const problem = dropProblem(), scope = dragScope, generation = sessionGeneration;
    const files = Array.from(event.dataTransfer.files || []);
    const directory = Array.from(event.dataTransfer.items || []).some(item => item.webkitGetAsEntry?.()?.isDirectory);
    clearDrag();
    if (problem || directory || !scope) {
      notice = directory ? "暂不支持文件夹，请拖入本地文件。" : problem || "请重新拖入文件。";
      render(); return;
    }
    const result = await api.uploadDroppedFiles(files, scope);
    if (generation !== sessionGeneration || scope !== space.scope) return;
    notice = result.ok ? "" : errorText(result.code === "SPACE_UPLOAD_LIMIT" ? result : result.code);
    render();
  });
  document.addEventListener("dragend", clearDrag);
  root.addEventListener("pointerdown", () => { interacting = true; });
  document.addEventListener("pointerup", () => {
    interacting = false;
    setTimeout(() => { if (pendingRender) render(); }, 0);
  });
  document.addEventListener("pointercancel", () => { interacting = false; if (pendingRender) render(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); clearDrag(); void act("desktop-hide"); } });
  let lastHeight = 0;
  function resize() {
    requestAnimationFrame(() => {
      if (dragDepth) return;
      const height = Math.max(240, Math.min(560, surface.scrollHeight));
      if (height !== lastHeight) { lastHeight = height; void api.action("desktop-resize", { height }).catch(() => {}); }
    });
  }
  function acceptState(value) {
    const account = value.account || {};
    const identity = JSON.stringify([account.phase || "signed_out", account.accountId || null, account.clientId || null, value.connection?.deviceId || null, value.connection?.gatewayURL || null]);
    const changed = identity !== accountIdentity;
    if (changed) {
      accountIdentity = identity;
      sessionGeneration++;
      applicationNames = new Map(); namesRequest = null;
      selected = ""; intentId = ""; notice = "";
      balance = null; balancePhase = "idle"; balanceRequest = null;
      if (dragDepth) dragInvalid = true;
      space = { tasks: [] }; spaceRevision++; spaceRequest = null;
      balance = null; balancePhase = "idle"; balanceRequest = null;
    }
    state = value;
    paintOverlay(); render();
    if (changed) void refreshSpace();
    if (changed && signedIn()) { void refreshBalance(); void refreshApplicationNames(); }
  }
  window.addEventListener?.("focus", () => { void refreshSpace(); void refreshBalance(); void refreshApplicationNames(); });
  window.addEventListener?.("blur", () => { interacting = false; if (pendingRender && !dragDepth) render(); });
  window.addEventListener?.("pagehide", clearDrag);
  api.onSpace?.(acceptSpace);
  api.onState(acceptState);
  const initialGeneration = sessionGeneration;
  api.getState().then(value => { if (initialGeneration === sessionGeneration) acceptState(value); })
    .catch(error => { if (initialGeneration === sessionGeneration) { notice = errorText(error); render(); } });
  render();
})();
