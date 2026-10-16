(() => {
  const api = window.wanxPanel, root = document.getElementById("panel");
  let state = {}, notice = "", selected = "", intentId = "";
  let accountIdentity = "", sessionGeneration = 0;
  let balance = null, balancePhase = "idle", balanceRequest = null;
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const errorText = error => {
    const code = String(error?.message || error || "");
    const errors = {
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
  function renderIntent() {
    const pending = state.ui?.pendingOpen;
    if (!pending) { intentId = ""; return ""; }
    if (pending.id !== intentId) { intentId = pending.id; selected = pending.deviceId || state.ui?.lastDeviceId || available()[0]?.deviceId || ""; }
    const name = (state.applications || []).find(app => app.applicationId === pending.applicationId)?.name || "应用";
    const processing = ["connecting", "opening"].includes(pending.phase);
    return `<section class="intent"><strong>${processing ? (pending.phase === "connecting" ? "正在连接盒子…" : "正在打开应用…") : "连接盒子并打开应用"}</strong><p>${escape(name)}${processing ? "将在就绪后打开" : "需要连接一个盒子"}</p>${pending.error ? `<p class="error">${errorText(pending.error)}</p>` : ""}${!processing && available().length ? `<select id="target-box" aria-label="选择盒子">${available().map(d => `<option value="${escape(d.deviceId)}" ${d.deviceId === selected ? "selected" : ""}>${escape(d.displayName || d.name || "万象盒子")}</option>`).join("")}</select>` : ""}<div class="actions"><button data-action="cancel">取消</button>${!processing ? (available().length ? '<button class="primary" data-action="confirm">连接并打开</button>' : '<button class="primary" data-page="boxes">发现或配置盒子</button>') : ""}</div></section>`;
  }
  function renderBalance() {
    const points = balance == null ? "—" : balance.toLocaleString("zh-CN");
    const label = !signedIn() ? "登录后查看" : balancePhase === "loading" ? "正在读取…" : balancePhase === "error" ? "暂不可用" : "查看消耗明细";
    return `<button class="balance-card" data-page="${signedIn() ? "credits" : "applications"}" aria-label="${signedIn() ? "积分，" + (balance == null ? label : points + "点，查看消耗明细") : "登录查看积分"}" ${balancePhase === "loading" ? 'aria-busy="true"' : ""}><span class="card-label">可用积分<span class="points-mark" aria-hidden="true">积</span></span><span class="points-value">${points}<small>点</small></span><span class="card-caption">${label}<span aria-hidden="true">↗</span></span></button>`;
  }
  function render() {
    const connection = state.connection || {};
    const apps = state.applications || [];
    root.innerHTML = `<header><div class="brand"><img src="../renderer/assets/centaurai-mark.png" alt="半人马"><span class="brand-copy"><strong>半人马AI-万象</strong><small>CentaurAI-WanX</small></span></div><button class="box-button" data-page="boxes" aria-label="打开盒子"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m12 3 9 5v8l-9 5-9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5"/></svg><span>盒子</span></button></header>
      <section class="summary" aria-label="万象概览"><div class="box-status" aria-label="当前盒子"><span class="card-label">当前盒子<span class="dot ${ready() ? "ready" : ""}" aria-hidden="true"></span></span><strong class="box-name" title="${escape(connection.name || "我的盒子")}">${escape(connection.name || "我的盒子")}</strong><span class="card-caption">${boxStatus()}</span></div>${renderBalance()}</section>
      <div class="apps-heading"><h2>我的应用</h2>${signedIn() && apps.length ? `<span>${apps.length} 个应用</span>` : ""}</div><div class="apps">${!signedIn() ? '<div class="empty">登录后，连接盒子并使用你的应用。<br><button class="primary" data-page="applications">登录万象</button></div>' : apps.length ? apps.map(app => { const op = state.ui?.applicationOperations?.[app.applicationId]; return `<div class="app-row">${window.wanxAppCatalog?.[app.applicationId] ? `<img class="app-icon generated-app-icon" src="../renderer/${window.wanxAppCatalog[app.applicationId].icon}" alt="" />` : `<span class="app-icon" aria-hidden="true">${escape(Array.from(app.name || "应用")[0])}</span>`}<div class="app-body"><div class="app-name">${escape(app.name || app.applicationId)}</div>${op ? `<div class="app-message ${op.phase === "failed" ? "error" : ""}">${op.phase === "failed" ? errorText(op.error) : phaseText[op.phase] || "正在处理…"}</div>` : ""}</div><button class="open" data-app="${escape(app.applicationId)}" aria-label="${op?.phase === "failed" ? "重试打开" : "打开"}${escape(app.name || "应用")}" ${op && op.phase !== "failed" ? "disabled" : ""}>${op?.phase === "failed" ? "重试" : "打开"}</button></div>`; }).join("") : '<p class="empty">还没有应用，去商店挑选一个吧。</p>'}</div>
      ${renderIntent()}${notice ? `<p class="notice error" role="status">${escape(notice)}</p>` : ""}<footer><button data-page="applications"><span>应用</span><span aria-hidden="true">↗</span></button></footer>`;
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
    const { page, app, action } = button.dataset;
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
  document.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); void act("desktop-hide"); } });
  let lastHeight = 0;
  function resize() {
    requestAnimationFrame(() => {
      const height = Math.max(240, Math.min(560, root.scrollHeight));
      if (height !== lastHeight) { lastHeight = height; void api.action("desktop-resize", { height }).catch(() => {}); }
    });
  }
  function acceptState(value) {
    const account = value.account || {};
    const identity = JSON.stringify([account.phase || "signed_out", account.accountId || null, account.clientId || null]);
    const changed = identity !== accountIdentity;
    if (changed) {
      accountIdentity = identity;
      sessionGeneration++;
      selected = ""; intentId = ""; notice = "";
      balance = null; balancePhase = "idle"; balanceRequest = null;
    }
    state = value;
    render();
    if (changed && signedIn()) void refreshBalance();
  }
  window.addEventListener?.("focus", () => { void refreshBalance(); });
  api.onState(acceptState);
  const initialGeneration = sessionGeneration;
  api.getState().then(value => { if (initialGeneration === sessionGeneration) acceptState(value); })
    .catch(error => { if (initialGeneration === sessionGeneration) { notice = errorText(error); render(); } });
  render();
})();
