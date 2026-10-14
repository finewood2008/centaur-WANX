const app = document.querySelector("#app");
let currentState;
let page = "applications";
let marketItems = [];
let marketCandidates = new Map();
let marketLoading = false;
let marketError = null;
let marketGeneration = 0;
let marketAccount = null;
let marketConfirmation = null;
let ownershipTransfers = [];
let ownershipRevision = 0;
let transferRequest = null;
let transferDeviceId = null;
let transferNotice = null;
let transferResendAt = 0;
let transferResendTimer;
let authMode = "login";
let authUsername = "";
let resendAt = 0;
let resendTimer;
let codeSent = false;
let notice = null;
const localOperations = new Map();
let pendingSelection = null;
const expandedDetails = new Set();
let busy = false;
let setupState = { state: "idle" };
let setupReady = false;
let setupRequest = null;
let wifiPicker = newWifiPicker();
function newWifiPicker() { return { scanned: false, pending: null, networks: [], selected: null, manual: false, error: null, sessionId: null }; }
function resetWifiPicker() {
  const form = app.querySelector?.('[data-form="wifi"]');
  form?.reset?.();
  const password = form?.querySelector('[name="password"]');
  if (password) password.value = "";
  wifiPicker = newWifiPicker();
}
function wifiKey(network) { return JSON.stringify([network.ssid, network.security]); }
function wifiOptions() {
  const networks = [...wifiPicker.networks];
  if (wifiPicker.selected && !networks.some(item => wifiKey(item) === wifiKey(wifiPicker.selected))) networks.unshift(wifiPicker.selected);
  return '<option value="">请选择 Wi-Fi</option>' + networks.map(network => `<option value="${escapeHTML(wifiKey(network))}" ${network.security === "unsupported" ? "disabled" : ""}>${escapeHTML(network.ssid)} · 信号 ${network.signal}% · ${network.security === "open" ? "开放网络" : network.security === "unsupported" ? "暂不支持此安全类型" : "需要密码"}</option>`).join("");
}
function updateWifiPicker() {
  const form = app.querySelector?.('[data-form="wifi"]');
  if (!form) return;
  const picker = form.querySelector('[data-input="wifi-network"]');
  if (picker) { picker.innerHTML = wifiOptions(); picker.value = wifiPicker.selected ? wifiKey(wifiPicker.selected) : ""; picker.required = !wifiPicker.manual; }
  const status = form.querySelector('[data-wifi-status]');
  if (status) status.textContent = wifiPicker.pending ? "正在扫描盒子附近的 Wi-Fi…" : wifiPicker.error || (wifiPicker.scanned && !wifiPicker.networks.length ? "未发现 Wi-Fi，请刷新重试，或手动添加隐藏网络。" : "列表来自盒子附近的 Wi-Fi，按信号强度排列。暂不支持的安全类型不可选择。");
  const refresh = form.querySelector('[data-action="wifi-refresh"]');
  if (refresh) { refresh.disabled = Boolean(wifiPicker.pending); refresh.textContent = wifiPicker.pending ? "扫描中…" : "刷新列表"; }
  for (const name of ["ssid", "security", "hidden"]) {
    const field = form.querySelector(`[name="${name}"]`);
    if (field) { const label = field.closest?.("label"); if (label) label.hidden = !wifiPicker.manual; }
  }
  const list = form.querySelector('[data-wifi-list]');
  if (list) list.hidden = wifiPicker.manual;
  const mode = form.querySelector('[data-action="wifi-manual"]');
  if (mode) mode.textContent = wifiPicker.manual ? "返回 Wi-Fi 列表" : "隐藏网络 / 手动添加";
  const security = form.querySelector('[name="security"]');
  const password = form.querySelector('[name="password"]');
  if (password && security) {
    password.disabled = security.value === "open";
    password.required = security.value !== "open";
    const label = password.closest?.("label"); if (label) label.hidden = security.value === "open";
  }
}
async function scanWifi() {
  if (page !== "provisioning" || setupState.state !== "awaitingWifi") return;
  const picker = wifiPicker;
  if (picker.pending) return picker.pending;
  picker.scanned = true;
  picker.error = null;
  picker.pending = Promise.resolve().then(() => {
    if (wifiPicker !== picker || page !== "provisioning" || setupState.state !== "awaitingWifi") return [];
    return window.wanxSetup.scanWifi();
  }).then(networks => {
    if (wifiPicker !== picker || page !== "provisioning" || setupState.state !== "awaitingWifi") return;
    picker.networks = [...networks].sort((a, b) => b.signal - a.signal || a.ssid.localeCompare(b.ssid));
  }).catch(() => {
    if (wifiPicker === picker) picker.error = "无法扫描盒子附近的 Wi-Fi，请刷新重试，或手动添加网络。";
  }).finally(() => {
    if (wifiPicker !== picker) return;
    picker.pending = null;
    if (page === "provisioning" && setupState.state === "awaitingWifi") updateWifiPicker();
  });
  updateWifiPicker();
  return picker.pending;
}
let discoveryView = { selecting: false, retained: false, candidates: [] };
const selection = createDiscoverySelection({
  discovery: window.wanxDiscovery,
  transport: window.wanxDeviceSetupTransport,
  onChange(view) {
    discoveryView = view;
    if (page === "provisioning") render(currentState);
  },
  onNotice(issue) {
    const messages = {
      unavailable: "当前运行时尚未接入本地配网能力",
      expired: "扫描结果已过期，请重新扫描盒子。",
      reselect_failed: "未能连接所选盒子，请确认盒子仍处于配网模式后重试。",
      empty: "未发现可用盒子，请确认盒子已进入配网模式后重新扫描。",
    };
    notice = issue ? messages[issue.kind] || issue.message : null;
  },
  onSelected(candidate) { void run("provisioning.start", { candidate }); },
});
window.addEventListener?.("pagehide", () => { resetWifiPicker(); selection.dispose(); }, { once: true });
window.addEventListener?.("pagehide", () => { clearTimeout(resendTimer); clearTimeout(transferResendTimer); }, { once: true });
const stageLabels = {
  discover: "发现盒子",
  identity: "读取设备身份",
  network: "配置网络",
  claim: "认领设备",
  initialize: "初始化盒端",
};

const escapeHTML = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function statusLabel(device) {
  const selected = (currentState.selectedDeviceId || currentState.activeDeviceId) === device.deviceId;
  if (selected && currentState.connectionPhase === "recovering") return "正在恢复连接";
  if (selected && ["connecting", "resolving"].includes(currentState.connectionPhase)) return "正在连接";
  if (currentState.activeDeviceId === device.deviceId) return "当前连接";
  const accessLabel = {
    service_unavailable: "账号服务待更新", access_denied: "未获访问权限",
    authorization_unavailable: "盒子授权组件待更新", authorization_pending: "访问权限待就绪",
    network_unconfigured: "盒子尚未接入网络", identity_unavailable: "盒子身份待就绪",
  }[device.accessState];
  if (accessLabel) return accessLabel;
  if (["denied", "forbidden", "unauthorized", "revoked", "ownership_conflict"].includes(device.accessState)) return "需要访问权限";
  if (device.accessState === "unreachable" || device.localReachability === "unreachable") return "当前不可达";
  if (["initializing", "provisioning"].includes(device.accessState)) return "正在准备设备";
  if (device.accessState === "offline" || device.cloudPresence === "offline") return "设备离线";
  if (device.accessState === "ready" && device.networkReady === false) return "当前不可达";
  if (device.canOpen === false) return "暂不可连接";
  if (device.canOpen === true || device.accessState === "ready") return "可连接";
  if (device.accessState === "discovered" || device.lifecycle === "discovered") return "待配置";
  return "暂不可连接";
}

function deviceCanConnect(device) {
  return device.canOpen !== false && device.networkReady !== false && (device.canOpen === true || device.accessState === "ready");
}

function deviceCard(device) {
  const selected = currentState.activeDeviceId === device.deviceId;
  const available = deviceCanConnect(device);
  const needsSetup = ["discovered", "unclaimed", "uninitialized"].includes(device.accessState);
  const action = selected
    ? `<button class="button small" data-action="disconnect" ${busy ? "disabled" : ""}>断开</button>`
    : available && currentState.networkReady
      ? `<button class="button small" data-action="connect" data-device-id="${escapeHTML(device.deviceId)}" ${busy ? "disabled" : ""}>${currentState.activeDeviceId ? "切换并连接" : "连接"}</button>`
      : available
        ? `<button class="button small" disabled>${networkStatus().label}</button>`
        : needsSetup ? `<button class="button small" data-action="provisioning" ${busy ? "disabled" : ""}>配置盒子</button>`
          : `<span class="muted">${escapeHTML(statusLabel(device))}</span>`;
  return `<article class="device-card ${selected ? "selected" : ""}">
    <img class="device-icon" src="./assets/centaurai-mark.png" alt="" />
    <div class="device-main"><h3>${escapeHTML(device.name || device.displayName || "万象盒子")}</h3><p class="device-meta"><span class="status-dot ${selected ? "ready" : ""}"></span>${escapeHTML(statusLabel(device))}</p></div>
    <div class="device-action">${action}${device.deviceRole === "owner" || device.role === "owner" ? `<button class="text-button" data-action="transfer-open" data-device-id="${escapeHTML(device.deviceId)}" ${busy ? "disabled" : ""}>转移所有权</button>` : ""}</div></article>`;
}

function networkStatus() {
  if (currentState.network?.enabled === false) return { label: "网络已关闭", detail: "开启网络后即可连接盒子。" };
  if (currentState.networkReady) return { label: "网络已连接", detail: "可以连接盒子并使用应用。" };
  if (currentState.platform?.phase === "unavailable" || ["unavailable", "failed", "error"].includes(currentState.network?.phase))
    return { label: "网络暂不可用", detail: "请检查本机网络后重试连接。" };
  return { label: "网络连接中", detail: "正在准备与盒子的连接。" };
}

function activeDeviceName() {
  return currentState.devices?.find((device) => device.deviceId === currentState.activeDeviceId)?.name || currentState.connection?.name || "万象盒子";
}

function shellHeader(title) {
  const activePage = ["boxes", "provisioning"].includes(page) ? "settings" : page;
  return `<header class="topbar">
    <button class="brand brand-button" data-action="desktop-about" aria-label="关于万象"><img class="brand-mark" src="./assets/centaurai-mark.png" alt="半人马" /><span class="brand-copy"><strong>半人马AI-万象</strong><small>CentaurAI-WanX</small></span></button>
    <h1 class="sr-only">${title}</h1>
    <nav class="main-nav" aria-label="管理导航">${[["applications", "应用商店"], ["settings", "设置"]].map(([destination, label]) => `<button class="nav-item ${activePage === destination ? "active" : ""}" data-action="show-${destination}" ${activePage === destination ? 'aria-current="page"' : ""} ${page === "provisioning" ? "disabled" : ""}>${label}</button>`).join("")}</nav>
    <span class="topbar-caption">AI 应用底座</span></header>`;
}

function resendSeconds() {
  return Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
}

function updateResendButton() {
  clearTimeout(resendTimer);
  const remaining = resendSeconds();
  const button = document.querySelector('[data-action="send-registration-code"]');
  if (button) {
    button.disabled = busy || remaining > 0;
    button.textContent = remaining ? `${remaining} 秒后重新获取` : "获取验证码";
  }
  if (remaining) resendTimer = setTimeout(updateResendButton, 1000);
}

function updateTransferCodeButton() {
  clearTimeout(transferResendTimer);
  const remaining = Math.max(0, Math.ceil((transferResendAt - Date.now()) / 1000));
  const button = document.querySelector('[data-action="transfer-code"]');
  if (button) {
    button.disabled = busy || remaining > 0;
    button.textContent = remaining ? `${remaining} 秒后重新发送` : "发送验证码";
  }
  if (remaining) transferResendTimer = setTimeout(updateTransferCodeButton, 1000);
}

function authView() {
  const register = authMode === "register";
  return `<div class="auth-layout"><section class="auth-card">
    <button class="auth-brand brand-button" data-action="desktop-about" aria-label="关于万象"><img class="brand-mark" src="./assets/centaurai-mark.png" alt="半人马" /><span class="brand-copy"><strong>半人马AI-万象</strong><small>CentaurAI-WanX</small></span></button>
    <h1>${register ? "注册万象平台" : "登录万象平台"}</h1><p class="muted">连接你的盒子，发现和使用 AI 应用。</p>
        <div class="tabs"><button class="tab ${!register ? "active" : ""}" data-action="auth-login" ${busy ? "disabled" : ""}>登录</button><button class="tab ${register ? "active" : ""}" data-action="auth-register" ${busy ? "disabled" : ""}>注册</button></div>
        <form id="auth-form" data-form="auth" data-mode="${authMode}">
          <label for="account-name">手机号</label>
          <input id="account-name" name="username" value="${escapeHTML(authUsername)}" required pattern="1[0-9]{10}" autocomplete="username" placeholder="13800138000" />
          <label for="account-password">密码</label>
          <input id="account-password" name="password" type="password" required autocomplete="${register ? "new-password" : "current-password"}" placeholder="${register ? "设置登录密码" : "输入密码"}" />
          ${register ? `<label for="account-confirm-password">确认密码</label><input id="account-confirm-password" name="confirmPassword" type="password" required autocomplete="new-password" placeholder="再次输入密码" /><label for="account-code">短信验证码</label><div class="code-field"><input id="account-code" name="code" required pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code" placeholder="输入 6 位验证码" /><button class="button small" type="button" data-action="send-registration-code" ${busy || resendSeconds() ? "disabled" : ""}>${resendSeconds() ? `${resendSeconds()} 秒后重新获取` : "获取验证码"}</button></div>` : ""}
          <button class="button primary wide" type="submit" ${busy ? "disabled" : ""}>${busy ? "处理中…" : register ? "创建账号并进入" : "登录并进入"}</button>
        </form>
        ${notice ? `<div class="notice ${codeSent ? "success" : "error"}" role="status">${escapeHTML(notice)}</div>` : ""}
    </section></div>`;
}

function settingsView() {
  const network = networkStatus();
  const enabled = currentState.network?.enabled !== false;
  const startup = currentState.desktopStartup || { supported: false, enabled: false };
  return `<div class="app-layout" ${marketConfirmation ? "inert" : ""}>${shellHeader("设置")}<div class="page-content">
    <div class="page-heading"><h2>设置</h2><p class="muted">让万象在需要时，安静地为你准备好。</p></div>
    ${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}
    <section class="settings-panel"><div><h3>盒子</h3><p class="muted">${currentState.activeDeviceId ? `${escapeHTML(activeDeviceName())} · 已连接` : "尚未连接盒子"}</p></div><button class="button small" data-action="show-boxes">管理与切换盒子</button></section>
    <section class="settings-panel"><div><h3>账号</h3><p class="muted">已登录万象平台。退出账号会断开盒子，万象仍在后台运行。</p></div><button class="button small" data-action="logout" ${busy ? "disabled" : ""}>退出当前账号</button></section>
    <section class="settings-panel"><div><h3>万象网络</h3><p class="muted">${network.label} · ${network.detail}</p></div><div class="settings-actions">${enabled && network.label === "网络暂不可用" ? `<button class="text-button" data-action="refresh" ${busy ? "disabled" : ""}>重试连接</button>` : ""}<button class="switch" role="switch" aria-checked="${enabled}" aria-label="万象网络" data-action="network-toggle" ${busy ? "disabled" : ""}><span></span></button></div></section>
    <section class="settings-panel"><div><h3>登录电脑时启动</h3><p class="muted">${escapeHTML(startup.reason || (startup.supported ? startup.status === "requires-approval" ? "请在系统设置中允许登录项。" : "在菜单栏静默启动，随时打开应用。" : "安装正式应用后可设置开机启动。"))}</p></div><button class="switch" role="switch" aria-checked="${Boolean(startup.enabled)}" aria-label="登录电脑时启动" data-action="startup-toggle" ${busy || !startup.supported ? "disabled" : ""}><span></span></button></section>
    <section class="settings-panel"><div><h3>关于万象</h3><p class="muted">半人马AI-万象 · CentaurAI-WanX</p></div><button class="button small" data-action="desktop-about">关于</button></section>
    <div class="settings-foot"><p class="muted">关闭窗口后继续后台运行。完全退出请在万象菜单中选择“退出万象”。</p></div>
  </div></div>${confirmationView()}`;
}

function boxesView() {
  const devices = currentState.devices || [];
  return `<div class="app-layout" ${marketConfirmation ? "inert" : ""}>${shellHeader("盒子")}<div class="page-content">
    <button class="text-button" data-action="show-settings">‹ 返回设置</button><div class="page-heading"><div><h2>我的盒子</h2><p class="muted">连接一台盒子，为应用提供服务。</p></div><div class="settings-actions"><button class="text-button" data-action="refresh" ${busy ? "disabled" : ""}>刷新</button><button class="button primary small" data-action="provisioning" ${busy ? "disabled" : ""}>＋ 发现新盒子</button></div></div>
    ${pendingOpenView()}${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}
    <section class="connection-banner ${currentState.canLaunchApplications ? "ready" : ""}"><div><span class="connection-caption">当前盒子</span><strong class="current-device">${currentState.activeDeviceId ? escapeHTML(activeDeviceName()) : ["connecting", "recovering"].includes(currentState.connectionPhase) ? currentState.connectionPhase === "recovering" ? "正在恢复连接…" : "正在连接…" : "尚未连接盒子"}</strong><p>${currentState.canLaunchApplications ? "切换或断开连接后，需要重新打开应用。" : networkStatus().detail}</p></div>${dashboardButton()}</section>
    <section class="content-section" aria-label="设备管理"><div class="section-heading"><h3>设备管理 <span class="count">${devices.length}</span></h3></div>${devices.length ? `<div class="device-list">${devices.map(deviceCard).join("")}</div>` : `<div class="empty-state"><h3>还没有盒子</h3><p>发现附近的盒子，完成配网和账号绑定。</p><button class="button small" data-action="provisioning">发现新盒子</button></div>`}</section>
    ${ownershipView()}
  </div></div>${confirmationView()}`;
}

function ownershipView() {
  const device = currentState.devices?.find(item => item.deviceId === transferDeviceId && (item.deviceRole === "owner" || item.role === "owner"));
  const pending = ownershipTransfers.filter(item => item.state === "pending_target" && Date.parse(item.expiresAt) > Date.now());
  return `<section class="content-section ownership-section" aria-label="所有权转移"><div class="section-heading"><h3>所有权转移</h3><button class="text-button" data-action="transfer-refresh" aria-busy="${Boolean(transferRequest)}" ${busy || transferRequest ? "disabled" : ""}>${transferRequest ? "正在刷新…" : "刷新转移记录"}</button></div>
    <p class="muted">将盒子交给另一个万象账号。此操作保留盒内数据；需要清空交付时，请由管理员执行盒子清除。</p>
    ${transferNotice ? `<p role="status">${escapeHTML(transferNotice)}</p>` : ""}
    ${device ? `<form data-form="transfer" data-device-id="${escapeHTML(device.deviceId)}" class="auth-card transfer-form"><h3>转移 ${escapeHTML(device.name || device.displayName || device.deviceId)}</h3>
      <label for="transfer-phone">客户万象账号手机号</label><input id="transfer-phone" name="targetPhone" type="tel" pattern="1[0-9]{10}" maxlength="11" required autocomplete="off" />
      <label for="transfer-code">你的账号短信验证码</label><div class="code-field"><input id="transfer-code" name="verificationCode" pattern="[0-9]{6}" maxlength="6" inputmode="numeric" required autocomplete="one-time-code" /><button type="button" class="button small" data-action="transfer-code" ${busy || Date.now() < transferResendAt ? "disabled" : ""}>发送验证码</button></div>
      <p class="muted">客户接受后，你和原授权用户将失去此盒子的访问权限。请确认盒内保留的数据可交给客户。</p>
      <label class="transfer-consent"><input type="checkbox" name="retainData" required /> 我同意保留盒内数据并转移所有权</label>
      <div class="market-actions"><button type="button" class="button" data-action="transfer-cancel" ${busy ? "disabled" : ""}>取消</button><button type="submit" class="button primary" ${busy ? "disabled" : ""}>发送转移邀请</button></div></form>` : ""}
    ${pending.map(item => `<article class="device-card"><div class="device-main"><h3>${escapeHTML(currentState.devices?.find(device => device.deviceId === item.deviceId)?.name || item.deviceId)}</h3><p class="muted">${item.direction === "incoming" ? "待你接受" : "等待客户接受"} · ${item.retainData ? "保留盒内数据" : "此转移不支持，请联系原所有者"} · ${escapeHTML(new Date(item.expiresAt).toLocaleString())} 前有效</p></div>${item.direction === "incoming" && item.retainData ? `<button class="button small" data-action="transfer-accept" data-transfer-id="${escapeHTML(item.transferId)}" ${busy ? "disabled" : ""}>接受转移</button>` : ""}</article>`).join("")}
    ${!pending.length ? '<p class="muted">暂无待处理的转移邀请。</p>' : ""}</section>`;
}

async function refreshTransfers({ force = false } = {}) {
  if (transferRequest && !force) return transferRequest.promise;
  const generation = marketGeneration;
  const revision = ++ownershipRevision;
  const request = {};
  transferRequest = request;
  const loadError = "转移记录暂时无法加载，请刷新重试。";
  if (transferNotice === loadError) transferNotice = null;
  render(currentState);
  request.promise = (async () => {
    try {
      const response = await window.wanxClient.action("ownership.list");
      if (generation !== marketGeneration || revision !== ownershipRevision) return;
      if (!response.ok) throw new Error(response.code);
      ownershipTransfers = response.value || [];
    } catch (error) {
      if (generation !== marketGeneration || revision !== ownershipRevision) return;
      transferNotice = loadError;
    } finally {
      if (transferRequest === request) { transferRequest = null; render(currentState); }
    }
  })();
  return request.promise;
}

function dashboardButton() {
  return currentState.canOpenDashboard ? `<button class="button small" data-action="dashboard-open" ${busy ? "disabled" : ""}>打开盒子控制台</button>` : "";
}

function operationFor(id) {
  const local = localOperations.get(id);
  const shared = currentState.ui?.applicationOperations?.[id];
  return local?.phase === "failed" ? shared || local : local || shared;
}

function operationBusy(id) {
  const operation = operationFor(id);
  return operation && !["idle", "failed", "completed", "ready", "running", "cancelled"].includes(operation.phase);
}

function operationMessage(operation) {
  if (!operation) return "";
  if (operation.error) return /[\u3400-\u9fff]/.test(String(operation.error)) ? String(operation.error) : operationErrorMessage(operation.error);
  return { installing: "正在安装…", updating: "正在更新…", uninstalling: "正在卸载…", rolling_back: "正在恢复版本…", rollback: "正在恢复版本…", selecting: "正在选择版本…", "rolling-back": "正在恢复版本…", opening: "正在打开…", connecting: "正在连接盒子…" }[operation.phase] || "";
}

function pendingOpenView() {
  const pending = currentState.ui?.pendingOpen;
  if (!pending) { pendingSelection = null; return ""; }
  const devices = (currentState.devices || []).filter(deviceCanConnect);
  if (pendingSelection?.id !== pending.id) pendingSelection = { id: pending.id, deviceId: pending.deviceId || currentState.ui?.lastDeviceId || devices[0]?.deviceId };
  if (!devices.some((device) => device.deviceId === pendingSelection.deviceId)) pendingSelection.deviceId = devices[0]?.deviceId;
  const application = currentState.applications?.find((item) => item.applicationId === pending.applicationId);
  const processing = ["connecting", "opening"].includes(pending.phase);
  return `<section class="pending-open" aria-label="连接盒子并打开应用" role="status"><div><h3>${processing ? pending.phase === "connecting" ? "正在连接盒子…" : "正在打开应用…" : "连接盒子并打开应用"}</h3><p class="muted">${escapeHTML(application?.name || "此应用")}需要一台盒子提供服务。</p></div>
    ${pending.error ? `<p class="inline-error">${escapeHTML(operationErrorMessage(pending.error))}</p>` : ""}
    <div class="pending-open-actions">${devices.length ? `<select aria-label="用于打开应用的盒子" data-input="pending-device" ${processing ? "disabled" : ""}>${devices.map((device) => `<option value="${escapeHTML(device.deviceId)}" ${pendingSelection.deviceId === device.deviceId ? "selected" : ""}>${escapeHTML(device.name || device.displayName || "万象盒子")}</option>`).join("")}</select><button class="button primary small" data-action="pending-confirm" ${processing || !currentState.networkReady ? "disabled" : ""}>${processing ? "处理中…" : "连接并打开"}</button>` : '<button class="button small" data-action="show-boxes">发现或管理盒子</button>'}<button class="text-button" data-action="pending-cancel">取消</button></div>
    ${!currentState.networkReady ? `<p class="muted">${networkStatus().label}。<button class="text-button" data-action="show-settings">检查网络</button></p>` : ""}</section>`;
}

function marketErrorMessage(error) {
  const message = String(error?.code || error?.message || error || "");
  const messages = {
    BOX_APPLICATION_PLATFORM_SESSION_REQUIRED: "请登录万象并选择已关联的盒子后打开此应用。",
    BOX_APPLICATION_RUNTIME_UPDATE_REQUIRED: "盒子需要更新万象服务后才能打开此应用，请联系管理员。",
    BOX_APPLICATION_ACCESS_DENIED: "此账号尚未获得应用使用权限，请联系管理员启用并授权。",
    BOX_APPLICATION_SCOPE_FORBIDDEN: "此应用的连接权限不匹配，请更新万象后重试。",
    BOX_APPLICATION_SESSION_INVALID: "无法建立应用会话，请更新万象和盒端服务后重试。",
    ACCOUNT_LOGIN_REQUIRED: "登录已失效，请重新登录万象。",
    ACCOUNT_CANCELLED: "登录状态已变化，请重新登录后重试。",
    ACCOUNT_CHANGED: "登录账号已变化，请刷新应用市场后重试。",
    MARKET_CANDIDATE_CHANGED: "可用版本已变化，请刷新后重新确认安装。",
    MARKET_SESSION_CHANGED: "登录状态已变化，请重新登录后重试。",
    MARKET_UNTRUSTED_KEY: "尚未配置可信的应用发行方，请联系管理员。",
    MARKET_INVALID_SIGNATURE: "应用发行签名验证失败，请联系管理员。",
    MARKET_INVALID_DESCRIPTOR: "应用发行信息无效，请联系管理员。",
    MARKET_PACKAGE_INVALID: "安装包格式有误，请联系管理员。",
    MARKET_PACKAGE_HASH_MISMATCH: "安装包校验失败，请刷新后重新下载。",
    MARKET_PACKAGE_TOO_LARGE: "安装包超出允许大小，请联系管理员。",
    MARKET_UPDATE_NOT_AVAILABLE: "没有可安装的新版本，请刷新应用列表。",
    MARKET_OPERATION_BUSY: "此应用正在处理中，请稍后再试。",
    MARKET_ROLLBACK_UNAVAILABLE: "没有可恢复的上一个版本。",
    MARKET_UNTRUSTED_SIGNING_KEY: "服务器不信任此发行签名，请联系管理员检查发布公钥。",
    MARKET_TRUST_NOT_CONFIGURED: "服务器尚未配置发行公钥，请联系管理员。",
    MARKET_INTEGRITY_ERROR: "服务器发行记录校验失败，请联系管理员检查安装包。",
    MARKET_DATABASE_UNAVAILABLE: "应用市场服务暂不可用，请稍后刷新；如仍失败，请联系管理员。",
    MARKET_SERVICE_NOT_DEPLOYED: "应用市场接口尚未部署，请联系管理员更新平台服务。",
    MARKET_STORAGE_NOT_CONFIGURED: "安装包存储尚未配置完成，请联系管理员。",
    MARKET_STORAGE_UNAVAILABLE: "安装包存储暂不可用，请稍后刷新重试。",
    MARKET_STORAGE_REQUIRES_HTTPS: "安装包存储地址配置有误，请联系管理员配置 HTTPS。",
    MARKET_ARTIFACT_NOT_FOUND: "安装包已变化，请刷新应用市场后重试。",
    MARKET_DOWNLOAD_UNAVAILABLE: "安装包已下架、撤销或替换，请刷新应用市场。",
    MARKET_INVALID_VERSION: "版本信息有误，请更新万象；如仍失败，请联系管理员。",
    MARKET_APPLICATION_INVALID: "应用标识有误，请刷新应用市场；如仍失败，请联系管理员。",
    APPLICATION_RETIRED: "此应用已退役，无法继续从市场安装或更新。",
    MARKET_TRUST: "尚未配置可信的应用发行方，请联系管理员。",
    MARKET_SIGNATURE: "应用发行签名验证失败，请联系管理员。",
    MARKET_HASH: "安装包校验失败，请刷新后重新下载。",
    MARKET_SIZE: "安装包大小与发行信息不一致，请重新下载。",
    MARKET_DOWNLOAD: "安装包下载失败，请检查网络后重试。",
    MARKET_UNAVAILABLE: "此应用暂时无法安装，请刷新应用市场。",
    MARKET_INCOMPATIBLE: "此版本不兼容当前系统或万象版本，请先更新万象。",
    MARKET_ALREADY: "当前已安装此版本，请刷新应用列表。",
    MARKET_DOWNGRADE: "本机版本较新，不会自动降级。",
    MARKET_BUSY: "此应用正在处理中，请稍后再试。",
    MARKET_NOT_CONFIGURED: "应用市场尚未配置完成，请联系管理员。",
    APPLICATION_BUSY: "请先关闭应用，再进行此操作。",
    APPLICATION_RUNNING: "请先关闭应用，再进行此操作。",
    APPLICATION_ROLLBACK: "没有可恢复的上一个版本。",
  };
  return Object.entries(messages).find(([code]) => message.includes(code))?.[1]
    || "暂时无法完成应用市场操作，请刷新后重试；如仍失败，请联系管理员。";
}

function candidateLabel(candidate) {
  if (!candidate) return marketLoading ? "正在检查版本…" : "尚未检查版本";
  if (["incompatible", "unavailable"].includes(candidate.status)) {
    const reason = {
      application_unlisted: "此应用尚未上架或已下架，请刷新应用市场。",
      no_published_target: "暂无可安装的应用包，请联系管理员发布通用应用包或适用版本。",
      release_unavailable: "此发行版本暂不可用，请刷新应用市场后重试。",
      wanx_version: "请先升级万象，再安装此应用版本。",
      host_protocol: "此应用与当前万象运行协议不兼容，请联系管理员确认兼容版本。",
      version_selection_required: "请先选择历史应用的当前版本，再检查更新。",
    reinstall_required: "此版本需管理员协助重新安装。",
    }[candidate.reason];
    if (reason) return reason;
  }
  return {
    available: `可${candidate.installed ? "更新至" : "安装"} v${candidate.release?.version || ""}`,
    up_to_date: "已是最新版本",
    local_newer: "本机版本较新",
    incompatible: candidate.reason === "reinstall_required" ? "此版本需管理员协助重新安装" : "暂不兼容当前系统或万象版本",
    unavailable: "暂无适用版本",
    error: marketErrorMessage(candidate.error),
  }[candidate.status] || "暂无适用版本";
}

function candidateDetails(candidate) {
  const artifact = candidate?.artifact;
  const platforms = { "universal:universal": "通用应用包", "macos:arm64": "macOS · Apple 芯片", "macos:x64": "macOS · Intel", "windows:arm64": "Windows · ARM64", "windows:x64": "Windows · x64" };
  const metadata = [];
  if (artifact) {
    const platform = platforms[`${artifact.os}:${artifact.arch}`];
    if (platform) metadata.push(platform);
    if (Number.isFinite(artifact.size) && artifact.size > 0) {
      metadata.push(artifact.size >= 1024 * 1024 ? `${(artifact.size / (1024 * 1024)).toFixed(1)} MB`
        : artifact.size >= 1024 ? `${(artifact.size / 1024).toFixed(1)} KB` : `${artifact.size} B`);
    }
  }
  const notes = typeof candidate?.release?.notes === "string" ? candidate.release.notes.trim() : "";
  return `${metadata.length ? `<p class="market-metadata">${escapeHTML(metadata.join(" · "))}</p>` : ""}
    ${notes ? `<details class="market-notes"><summary>v${escapeHTML(candidate.release.version)} 更新说明</summary><p>${escapeHTML(notes)}</p></details>` : ""}`;
}

function applicationIcon(item) {
  // Only use a catalog-provided HTTPS image or a local image supplied by the host.
  const icon = item.iconURL || item.iconUrl;
  return typeof icon === "string" && /^(https:\/\/|file:\/\/)/.test(icon)
    ? `<img class="application-icon" src="${escapeHTML(icon)}" alt="" />`
    : `<div class="application-icon" aria-hidden="true">${escapeHTML(Array.from(item.name || "应")[0])}</div>`;
}

function applicationCard(item, installed = true) {
  const candidate = marketCandidates.get(item.applicationId);
  const id = escapeHTML(item.applicationId);
  const operation = operationFor(item.applicationId);
  const disabled = operationBusy(item.applicationId) ? "disabled" : "";
  const previous = typeof item.previous === "string" ? item.previous : item.previous?.version;
  const status = operationMessage(operation);
  const actions = item.selectionRequired
    ? `<p class="muted">历史版本无法自动比较，请选择当前版本。</p><div class="version-choices">${item.versions.map(({ version }) => `<button class="button small" data-action="applications-select-current" data-application-id="${id}" data-version="${escapeHTML(version)}" ${disabled}>使用 ${escapeHTML(version)}</button>`).join("")}</div>`
    : `<div class="application-actions">${candidate?.status === "available" ? `<button class="button ${installed ? "" : "primary"} small" data-action="market-install" data-application-id="${id}" ${disabled}>${installed ? "更新" : "安装"}</button>` : ""}${installed ? `<button class="button primary small" data-action="applications-launch" data-application-id="${id}" ${disabled}>${operationBusy(item.applicationId) ? status || "处理中…" : "打开"}</button>` : ""}</div>`;
  return `<article class="application-card" data-application="${id}">${applicationIcon(item)}<div class="application-main">
    <div class="application-title"><h3>${escapeHTML(item.name)}</h3>${installed && item.version ? `<span class="muted">v${escapeHTML(item.version)}</span>` : ""}</div>
    <p class="application-description">${escapeHTML(item.description || "在你的盒子上使用 AI 服务。")}</p>
    <p class="market-status ${operation?.error ? "inline-error" : ""}" role="status">${escapeHTML(status || candidateLabel(candidate))}</p>
    <details class="application-details" data-detail-id="${id}" ${expandedDetails.has(item.applicationId) ? "open" : ""}><summary>应用详情</summary>${candidateDetails(candidate)}${installed && !item.selectionRequired ? `<div class="market-actions">${previous ? `<button class="text-button" data-action="market-rollback" data-application-id="${id}" ${disabled}>恢复上一版本</button>` : ""}<button class="text-button danger-text" data-action="market-uninstall" data-application-id="${id}" ${disabled}>卸载</button></div>` : ""}${!candidate?.artifact && !candidate?.release?.notes && !installed ? '<p class="muted">暂无更多版本信息。</p>' : ""}</details>
    </div>${actions}</article>`;
}

function confirmationView() {
  if (!marketConfirmation) return "";
  return `<section class="market-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="market-confirm-title" aria-describedby="market-confirm-detail"><div class="market-confirm-card"><h2 id="market-confirm-title">${escapeHTML(marketConfirmation.title)}</h2><p id="market-confirm-detail">${escapeHTML(marketConfirmation.detail)}</p><div class="market-actions"><button class="button" data-action="market-cancel">取消</button><button class="button primary" data-action="market-confirm">确认${escapeHTML(marketConfirmation.verb)}</button></div></div></section>`;
}

function applicationsView() {
  const applications = currentState.applications || [];
  const installed = new Set(applications.map((item) => item.applicationId));
  const available = marketItems.filter((item) => !installed.has(item.applicationId));
  return `<div class="app-layout" ${marketConfirmation ? "inert" : ""}>${shellHeader("应用商店")}<div class="page-content">
    <div class="page-heading"><div><h2>应用商店</h2><p class="muted">通用应用包支持 Windows 和 macOS。安装与更新无需连接盒子。</p></div><button class="text-button" data-action="market-refresh" ${marketLoading ? "disabled" : ""}>${marketLoading ? "正在检查…" : "检查更新"}</button></div>
    <div class="connection-line"><span class="status-dot ${currentState.canLaunchApplications ? "ready" : ""}"></span><span>${currentState.canLaunchApplications ? `已连接 ${escapeHTML(activeDeviceName())}` : networkStatus().label}</span></div>
    ${pendingOpenView()}${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}
    <section class="content-section" aria-label="我的应用"><div class="section-heading"><h3>我的应用 <span class="count">${applications.length}</span></h3></div>${applications.length ? `<div class="application-list">${applications.map((item) => applicationCard(item)).join("")}</div>` : '<div class="empty-state"><h3>安装你的第一个应用</h3><p>从下方选择应用，安装后即可在菜单栏打开。</p></div>'}</section>
    <section class="content-section market-section" aria-labelledby="market-heading" aria-busy="${marketLoading}"><div class="section-heading"><h3 id="market-heading">发现应用</h3></div>
    ${marketError ? `<div class="notice error" role="status">${escapeHTML(marketError)} <button class="text-button" data-action="market-refresh">刷新重试</button></div>` : ""}
    ${available.length ? `<div class="application-list">${available.map((item) => applicationCard(item, false)).join("")}</div>` : `<p class="market-empty" role="status">${marketLoading ? "正在加载应用商店…" : marketError ? "稍后刷新即可重试。" : marketItems.length ? "商店中的应用均已安装。" : "暂无已上架应用。"}</p>`}</section>
  </div></div>${confirmationView()}`;

}

async function refreshMarket() {
  if (currentState?.route === "auth") return;
  const generation = ++marketGeneration;
  marketLoading = true;
  marketError = null;
  marketCandidates = new Map();
  render(currentState);
  try {
    const response = await window.wanxClient.action("market.list");
    if (generation !== marketGeneration) return;
    if (response.state) acceptRemoteState(response.state);
    if (generation !== marketGeneration) return;
    if (!response.ok) throw new Error(response.code);
    marketItems = Array.isArray(response.value?.items) ? response.value.items : [];
    const installed = new Set((currentState.applications || []).map((item) => item.applicationId));
    const ids = new Set([...marketItems.map((item) => item.applicationId), ...installed]);
    await Promise.all([...ids].map(async (applicationId) => {
      const result = await window.wanxClient.action("market.candidate", { applicationId });
      if (generation !== marketGeneration) return;
      if (result.state) acceptRemoteState(result.state);
      if (generation !== marketGeneration) return;
      marketCandidates.set(applicationId, result.ok ? { ...result.value, installed: installed.has(applicationId) } : { status: "error", error: { code: result.code } });
    }));
  } catch (error) {
    if (generation === marketGeneration) marketError = marketErrorMessage(error);
  } finally {
    if (generation === marketGeneration) { marketLoading = false; render(currentState); }
  }
}

function discoveryCard(candidate) {
  const hint = candidate.displayIdentity;
  const deviceId = typeof hint?.deviceId === "string" && /^[A-Za-z0-9._-]{1,36}$/.test(hint.deviceId) ? hint.deviceId : "";
  // Public Device Info is a display hint only. Account names are joined by the
  // complete device ID; selection always keeps the original opaque handle.
  const known = deviceId && currentState.devices?.find((device) => device.deviceId === deviceId);
  // A registry can itself fall back to the ID. Neither that value nor the
  // protocol's fixed product label is a user-visible box name.
  const boxName = (value) => {
    const name = typeof value === "string" ? value.trim() : "";
    return name && name !== deviceId && !/^CentaurAI\s+Box$/i.test(name) &&
      !/^CentaurOS-(?:Setup-[0-9a-f]*|[0-9a-f]{24})?$/i.test(name) ? name : "";
  };
  const knownName = boxName(known?.name) || boxName(known?.displayName);
  const specificName = deviceId && boxName(hint?.displayName);
  const advertisedName = candidate.advertisedName || "";
  const scanning = discoveryView.selecting && !discoveryView.retained;
  const reading = !deviceId && scanning && candidate.nameSource === "advertisement";
  const resolvedName = knownName || specificName;
  const title = resolvedName || (reading ? "正在读取盒子名称…" : "未获取到盒子名称");
  const detail = !deviceId && scanning && !reading
    ? [advertisedName, "选择后核对设备身份"].filter(Boolean).join(" · ")
    : [advertisedName, !deviceId ? reading ? "正在读取盒子名称…" : "未读取到名称" : "", "蓝牙配网"].filter(Boolean).join(" · ");
  const identityDetail = deviceId && !resolvedName
    ? `<span>设备编号：${escapeHTML(deviceId)}（用于核对，不是名称）</span>` : "";
  return `<button class="device-card discovery-card" data-action="select-candidate" data-candidate-id="${escapeHTML(candidate.candidateId)}" ${discoveryView.selecting && discoveryView.retained ? "disabled" : ""}><strong>${escapeHTML(title)}</strong>${identityDetail}<span>${escapeHTML(detail)}</span></button>`;
}

function provisioningView() {
  const starting = setupRequest?.action === "provisioning.start";
  const cancelling = setupRequest?.action === "provisioning.cancel";
  const refreshing = setupRequest?.action === "provisioning.refresh";
  const cancelButton = `<button class="button danger" data-action="cancel-provisioning" aria-busy="${cancelling}" ${cancelling ? "disabled" : ""}>${cancelling ? "正在取消…" : "取消"}</button>`;
  const stagesByState = {
    idle: "discover", previewReady: "identity", awaitingWifi: "network",
    awaitingOwnershipConfirmation: "claim", submittingAppProof: "claim",
    provisioningWifi: "network", waitingCloud: "initialize", attentionRequired: "initialize",
  };
  const failed = ["terminalError", "restartRequired"].includes(setupState.state);
  const provisioning = {
    phase: starting || cancelling ? "running" : failed ? "failed" : setupState.state === "completed" ? "ready" :
      ["submittingAppProof", "provisioningWifi", "waitingCloud"].includes(setupState.state) ? "running" : "idle",
    stage: starting ? "identity" : stagesByState[setupState.state],
    error: { message: setupErrorMessage(setupState.errorCode) },
  };
  const running = provisioning.phase === "running";
  const preview = setupState.preview || setupState.compatiblePreview;
  const previewBlocked = preview?.cloud_enrollment_status === "not_enrolled" ? "DEVICE_NOT_ENROLLED" :
    preview?.pairing_mode_remaining_seconds === 0 ? "PAIRING_MODE_CLOSED" : null;
  const setupPhase = setupState.state || "idle";
  const stages = Object.entries(stageLabels);
  const setupCopy = starting ? "正在通过蓝牙读取盒子身份，请稍候。" : cancelling ? "正在停止本次配网，请稍候。" : {
    idle: "请让盒子进入蓝牙配网模式，然后点击扫描并选择附近的盒子。",
    attentionRequired: "盒子授权尚未完成，请检查盒子联网状态后刷新。",
    previewReady: previewBlocked ? setupErrorMessage(previewBlocked) : "请核对设备 ID、型号和身份指纹，然后确认。",
    awaitingWifi: "设备身份已验证，请选择盒子要连接的 Wi-Fi。",
    awaitingOwnershipConfirmation: "设备已准备联网，请确认绑定到当前账号。",
    submittingAppProof: "正在提交账号绑定证明…",
    provisioningWifi: "正在通过加密通道配置 Wi‑Fi…",
    waitingCloud: "正在等待设备联网并完成平台授权…",
    completed: "设备已完成联网和账号绑定。",
    cancelled: "本次配网已取消。",
  }[setupPhase] || "请让设备进入配置模式后开始扫描。";
  const previewBlock = preview ? `<dl class="setup-preview"><dt>设备名称</dt><dd>${escapeHTML(preview.display_name)}</dd><dt>设备 ID</dt><dd>${escapeHTML(preview.device_id)}</dd><dt>型号</dt><dd>${escapeHTML(preview.model)}</dd><dt>身份公钥指纹</dt><dd>${escapeHTML(preview.identity_public_key_sha256)}</dd></dl>` : "";
  const { candidates, selecting, retained } = discoveryView;
  const discoveryBlock = selecting || retained ? `<div class="discovery-list"><p>${retained ? "扫描已结束，结果保留 2 分钟。请选择要配置的盒子：" : "选择要配置的盒子："}</p>${candidates.length ? candidates.map(discoveryCard).join("") : "<p>正在等待附近的盒子，请确认盒子已进入配置模式。</p>"}</div>` : "";
  const controls = setupPhase === "previewReady"
    ? `<button class="button primary" data-action="provisioning-confirm" ${busy || previewBlocked ? "disabled" : ""}>${previewBlocked ? "盒子尚未准备好配网" : "确认设备身份"}</button>`
    : setupPhase === "awaitingWifi"
      ? `<form class="setup-wifi" data-form="wifi"><div class="wifi-picker" data-wifi-list><label>盒子附近的 Wi-Fi<select data-input="wifi-network" required>${wifiOptions()}</select></label><button class="button small" type="button" data-action="wifi-refresh">刷新列表</button></div><p class="hint wifi-status" data-wifi-status role="status" aria-live="polite"></p><button class="text-button wifi-mode" type="button" data-action="wifi-manual">隐藏网络 / 手动添加</button><label hidden>Wi‑Fi 名称<input name="ssid" required maxlength="32" autocomplete="off" /></label><label hidden>安全类型<select name="security"><option value="wpa_personal">WPA/WPA2 个人网络</option><option value="open">开放网络</option></select></label><label>密码<input name="password" type="password" maxlength="128" autocomplete="off" /></label><label class="check" hidden><input name="hidden" type="checkbox" />隐藏网络</label><button class="button primary" type="submit" ${busy ? "disabled" : ""}>继续绑定账号</button></form>`
      : setupPhase === "awaitingOwnershipConfirmation"
        ? `<button class="button primary" data-action="provisioning-owner" ${busy ? "disabled" : ""}>确认绑定到当前账号</button>`
        : "";
  return `
    <div class="app-layout">
      ${shellHeader("发现并配置盒子")}<div class="page-content">
      <div class="page-heading"><div><h2>发现新盒子</h2><p class="muted">核对身份，连接网络，然后绑定到你的账号。</p></div></div>
      <section class="wizard-card"><div class="wizard-steps">${stages.map(([key, label], index) => { const active = provisioning.stage === key; const done = provisioning.phase === "ready" || stages.findIndex(([name]) => name === provisioning.stage) > index; return `<div class="wizard-step ${active ? "active" : ""} ${done ? "done" : ""}"><span>${done ? "✓" : index + 1}</span><label>${label}</label></div>`; }).join("")}</div>
        <div class="wizard-copy"><p class="eyebrow">${running ? "正在处理" : provisioning.phase === "failed" ? "接入未完成" : "设备配置"}</p><h3>${starting ? "正在读取设备身份…" : cancelling ? "正在取消配网…" : running ? escapeHTML(stageLabels[provisioning.stage] || "处理中") : setupPhase === "idle" ? "发现附近的万象盒子" : "配置设备"}</h3><p>${provisioning.phase === "failed" ? escapeHTML(provisioning.error?.message || "本次接入失败") : escapeHTML(setupCopy)}</p>${discoveryBlock}${previewBlock}${controls}</div>
        <div class="wizard-actions">${running ? `<button class="button" disabled>返回盒子</button>${cancelButton}` : `<button class="button" data-action="back-devices">返回盒子</button>${["idle", "cancelled"].includes(setupPhase) || provisioning.phase === "failed" ? `<button class="button primary scan-button" data-action="start-provisioning" aria-busy="${selecting}" ${busy || !setupReady || selecting ? "disabled" : ""}>${selecting ? '<span class="scan-spinner" aria-hidden="true"></span><span>正在扫描…</span>' : provisioning.phase === "failed" || retained ? "重新扫描" : "开始扫描盒子"}</button>` : setupPhase === "completed" ? '<button class="button primary" data-action="refresh">完成</button>' : cancelButton}</div>`}
        ${setupPhase === "attentionRequired" ? `<button class="button" data-action="provisioning-refresh" aria-busy="${refreshing}" ${busy ? "disabled" : ""}>${refreshing ? "正在刷新…" : "刷新授权状态"}</button>` : ""}
        ${notice ? `<div class="notice error">${escapeHTML(notice)}</div>` : ""}
        ${!setupReady ? '<p class="hint">正在准备蓝牙配网服务…</p>' : ""}
      </section></div>
    </div>`;
}

function render(state) {
  const auth = state.route === "auth" || state.phase === "signed_out" || state.phase === "authenticating";
  const previousAuth = app.querySelector?.('[data-form="auth"]');
  if (auth && previousAuth?.elements) authUsername = previousAuth.elements.username.value.trim();
  currentState = state;
  // Reuse the actual Wi-Fi form when setup updates. This preserves typed secrets,
  // selection and focus; network polling does not rebuild active setup forms.
  const wifiForm = page === "provisioning" && setupState.state === "awaitingWifi" ? app.querySelector?.('[data-form="wifi"]') : null;
  const authForm = auth && previousAuth?.dataset.mode === authMode ? previousAuth : null;
  const transferForm = !auth && page === "boxes" && transferDeviceId && currentState.devices?.some(item => item.deviceId === transferDeviceId && (item.deviceRole === "owner" || item.role === "owner")) ? app.querySelector?.(`[data-form="transfer"][data-device-id="${transferDeviceId}"]`) : null;
  // Keep the active scan indicator spinning across discovery and account updates.
  const scanButton = !auth && page === "provisioning" && discoveryView.selecting
    ? app.querySelector?.('[data-action="start-provisioning"][aria-busy="true"]') : null;
  const scanAnimations = new Map(scanButton?.querySelector('.scan-spinner').getAnimations().map(animation => [animation.animationName, animation.currentTime]));
  const retainedForm = wifiForm || authForm || transferForm;
  const focused = retainedForm?.contains(document.activeElement) ? document.activeElement : null;
  if (state.route === "auth" || state.phase === "signed_out" || state.phase === "authenticating") app.innerHTML = authView();
  else if (page === "provisioning") app.innerHTML = provisioningView();
  else if (page === "boxes") app.innerHTML = boxesView();
  else if (page === "settings") app.innerHTML = settingsView();
  else app.innerHTML = applicationsView();
  if (scanButton) {
    app.querySelector?.('[data-action="start-provisioning"][aria-busy="true"]')?.replaceWith(scanButton);
    for (const animation of scanButton.querySelector('.scan-spinner').getAnimations()) {
      animation.currentTime = scanAnimations.get(animation.animationName) ?? 0;
    }
  }
  if (retainedForm) {
    const formName = wifiForm ? "wifi" : transferForm ? "transfer" : "auth";
    app.querySelector?.(`[data-form="${formName}"]`)?.replaceWith(retainedForm);
    const submit = retainedForm.querySelector('button[type="submit"]');
    if (submit) {
      submit.disabled = busy;
      if (authForm) submit.textContent = busy ? "处理中…" : authMode === "register" ? "创建账号并进入" : "登录并进入";
    }
    focused?.focus();
  }
  updateResendButton();
  updateTransferCodeButton();
  if (page === "provisioning" && setupState.state === "awaitingWifi") {
    updateWifiPicker();
    if (!busy && !wifiPicker.scanned) void scanWifi();
  }
  if (marketConfirmation) app.querySelector?.('[data-action="market-cancel"]')?.focus();
}

function setupErrorMessage(error) {
  const code = typeof error === "string" ? error : String(error?.code || error?.message || "");
  const messages = {
    DEVICE_NOT_ENROLLED: "盒子尚未完成平台注册，暂不能配网或绑定。请先由设备管理员完成注册，再让盒子进入配网模式并重新扫描。",
    PAIRING_MODE_CLOSED: "盒子尚未开启配网模式，或配网时间已结束。首次使用请联系设备提供方完成配网初始化；已初始化的盒子请重新开启配网窗口后再扫描。",
    PROTOCOL_CHANGED: "盒子与客户端的配网协议未能匹配，接入已停止（PROTOCOL_CHANGED）。",
    DEVICE_IDENTITY_MISMATCH: "盒子身份校验未通过，接入已停止。请核对目标盒子。",
    LOCAL_TRANSPORT_DISCONNECTED: "蓝牙连接已断开，请靠近盒子并重新扫描。",
    LOCAL_CONNECT_TIMEOUT: "连接盒子超时，请确认盒子处于配网模式后重试。",
    GATT_FRAGMENT_INCOMPLETE: "未完整收到盒子的蓝牙响应，请靠近盒子后重试。",
    PAIRING_EXPIRED: "本次配网已过期，请让盒子重新进入配网模式。",
    CONTRACT_MISMATCH: "账号服务的配网响应不兼容，请联系管理员核对服务版本（CONTRACT_MISMATCH）。",
    LOCAL_SELECTION_LEASE_INVALID: "扫描结果已失效，请重新扫描并选择盒子。",
    AUTH_SESSION_CHANGED: "登录状态已变化，请重新开始配网。",
  };
  const key = Object.keys(messages).find((key) => code.includes(key));
  const diagnostic = /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? `（${code}）` : "";
  return messages[key] || `盒子接入未完成，请重试；如仍失败，请联系管理员。${diagnostic}`;
}

function operationErrorMessage(error) {
  const message = typeof error === "string" ? error : String(error?.code || error?.message || "");
  const messages = {
      OWNERSHIP_RETAIN_DATA_REQUIRED: "此功能仅转移所有权并保留数据；清空交付请使用盒子清除。",
      OWNERSHIP_TRANSFER_PENDING: "此盒子已有待处理的转移邀请，请等待客户接受或邀请过期。",
      OWNERSHIP_TRANSFER_NOT_FOUND: "未找到属于你的转移邀请，请刷新记录。",
      OWNERSHIP_TRANSFER_EXPIRED: "转移邀请已过期，请原所有者重新发起。",
      OWNERSHIP_ACCOUNT_INACTIVE: "当前账号不可接受所有权，请检查账号状态。",
      OWNERSHIP_CLIENT_INACTIVE: "当前客户端登录已失效，请重新登录万象后再接受转移。",
      OWNERSHIP_OWNER_CHANGED: "盒子所有者已变化，请刷新盒子列表。",
      OWNERSHIP_DEVICE_UPDATE_REQUIRED: "盒子交付组件需要更新，请联系管理员更新后再转移。",
      OWNERSHIP_NETWORK_REVOKE_FAILED: "旧访问权限暂未撤销，转移尚未完成，请稍后重试。",
      OWNERSHIP_DEVICE_UNAVAILABLE: "盒子当前无法进行所有权转移，请稍后刷新重试。",
      OWNERSHIP_OWNER_REQUIRED: "只有当前盒子所有者可以发起转移，请刷新盒子列表。",
      OWNERSHIP_TARGET_SELF: "客户手机号不能是你当前登录的手机号。",
      OWNERSHIP_TRANSFER_UNAVAILABLE: "转移邀请已失效或不适用于当前账号，请刷新转移记录。",
      ACCOUNT_CANCELLED: "登录状态已变化，请重新操作。",
      invalid_sms_code: "请输入 6 位短信验证码。",
      invalid_phone: "请输入有效的手机号。",
      invalid_credentials: "手机号或密码不正确，请重试。",
      account_unavailable: "暂时无法连接账号服务，请稍后重试。",
      session_expired: "登录已过期，请重新登录万象。",
      ACCOUNT_NETWORK_ERROR: "暂时无法连接账号服务，请检查网络后重试。",
      ACCOUNT_REQUEST_FAILED: "账号服务暂时不可用，请稍后重试。",
      ACCOUNT_SESSION_EXPIRED: "登录已过期，请重新登录万象。",
      ACCOUNT_ACCESS_DENIED: "当前账号无权执行此操作。",
      SMS_CODE_INVALID: "验证码错误或已过期，请重新获取。",
      SMS_RATE_LIMITED: "验证码发送过于频繁，请稍后重试。",
      SMS_DAILY_LIMIT: "该手机号今日验证码发送次数已达上限，请明日再试。",
      PASSWORD_ALREADY_SET: "该手机号已注册，请使用密码登录。",
      PASSWORD_WEAK: "密码需为 8–72 字节，且不能包含换行符。",
      PASSWORD_INVALID: "手机号或密码不正确，请重新输入。",
      PASSWORD_NOT_SET: "该账号尚未设置密码，请先完成注册。",
      ACCOUNT_INVALID_INPUT: "请检查手机号、密码和验证码格式。",
      ACCOUNT_LOGIN_REQUIRED: "请先登录万象。",
      ACCOUNT_SESSION_CHANGED: "登录状态已变化，请重新打开应用。",
      APPLICATION_OPEN_CANCELLED: "已取消打开应用。",
      APPLICATION_OPEN_BUSY: "正在打开另一个应用，请稍后再试。",
      APPLICATION_OPEN_NOT_PENDING: "本次打开已取消，请重新打开应用。",
      APPLICATION_OPERATION_FAILED: "操作未完成，请重试。",
      NETWORK_DEVICE_ACCESS_DENIED: "当前账号无权访问此盒子，请刷新盒子列表。",
      NETWORK_NOT_READY: "网络尚未连接，请在设置中检查网络状态。",
      BOX_CONNECTION_REQUIRED: "请先连接一台盒子，再打开应用或盒子控制台。",
      NETWORK_CHANGED: "盒子连接已变化，请重新连接后打开应用。",
      BOX_IDENTITY_UNAVAILABLE: "暂时无法访问盒端服务，请重新连接盒子。",
      BOX_IDENTITY_INVALID: "盒端服务返回了无效身份，请重新连接盒子。",
      DASHBOARD_OPEN_FAILED: "盒子控制台打开失败，请检查盒子连接后重试。",
      APPLICATION_START_CANCELED: "应用启动已取消。",
      APPLICATION_STOP_FAILED: "应用尚未完全退出，请关闭应用后重试。",
      APPLICATIONS_CLOSED: "万象正在退出，无法启动或安装应用。",
      INVALID_APPLICATION_VERSION: "安装包需使用规范版本号，例如 1.2.3。",
      APPLICATION_VERSION_DOWNGRADE: "此安装包版本低于当前版本，请选择更新的安装包。",
      APPLICATION_VERSION_SELECTION_REQUIRED: "请先在应用卡片中选择当前版本，再安装或打开应用。",
      APPLICATION_VERSION_SELECTION_INVALID: "版本选择已变化，请刷新应用列表后重试。",
      APPLICATION_CURRENT_INVALID: "当前版本记录无法读取，请检查应用安装目录。",
      APPLICATION_START_FAILED: "应用启动失败，请重新打开；若仍失败，请检查应用安装是否完整。",
      APPLICATION_START_TIMEOUT: "应用启动超时，请稍后重新打开。",
      APPLICATION_ARCHIVE_INVALID: "安装包损坏或格式不受支持，请重新下载应用 ZIP 安装包。",
      APPLICATION_ARCHIVE_TOO_LARGE: "安装包过大，请联系应用提供方。",
      APPLICATION_MANIFEST_READ_FAILED: "安装包缺少有效的应用描述文件，请联系应用提供方。",
      APPLICATION_PLATFORM_REQUIRED: "独立应用安装包需要声明适用的系统和架构。",
      APPLICATION_PLATFORM_UNSUPPORTED: "此安装包不适用于当前电脑，请下载对应系统和架构的版本。",
      APPLICATION_VERSION_ALREADY_INSTALLED: "此版本已经安装，可在应用列表中打开。",
      APPLICATION_ENTRYPOINT_NOT_FOUND: "安装包缺少启动文件，请重新下载完整安装包。",
      INVALID_APPLICATION_ENTRYPOINT: "安装包中的启动文件无效，请联系应用提供方。",
      APPLICATION_ENTRYPOINT_NOT_EXECUTABLE: "启动文件缺少执行权限，请联系应用提供方重新打包。",
      APPLICATION_INSTALL_FAILED: "应用安装失败，请检查磁盘空间和目录权限后重试。",
    };
  const code = Object.keys(messages).find(value => message.includes(value));
  return messages[code] || marketErrorMessage(error);
}

async function run(action, input = {}) {
  const isSetupOperation = action.startsWith("provisioning.");
  if (isSetupOperation && setupRequest && (action !== "provisioning.cancel" || setupRequest.action === action)) return null;
  const request = isSetupOperation ? { action } : null;
  if (request) setupRequest = request;
  if (["provisioning.start", "provisioning.cancel", "auth.logout"].includes(action)) resetWifiPicker();
  notice = null;
  codeSent = false;
  const actionAccount = marketAccount;
  const applicationId = input.applicationId;
  const isAppOperation = Boolean(applicationId) && (action.startsWith("market.") || action.startsWith("applications."));
  if (isAppOperation && operationBusy(applicationId)) return null;
  const holdBusy = !isAppOperation && !["applications.confirm-open", "applications.cancel-open", "desktop.about"].includes(action);
  if (isAppOperation) localOperations.set(applicationId, { phase: { "market.install": "installing", "market.uninstall": "uninstalling", "market.rollback": "rolling_back", "applications.select-current": "selecting" }[action] || "opening" });
  if (holdBusy) busy = true;
  render(currentState);
  let failure;
  try {
    const setupActions = {
      "provisioning.start": () => window.wanxSetup.begin(input.candidate),
      "provisioning.confirm": () => window.wanxSetup.confirmPhysical(),
      "provisioning.wifi": () => window.wanxSetup.wifi(input),
      "provisioning.owner": () => window.wanxSetup.confirmOwnership(),
      "provisioning.refresh": () => window.wanxSetup.refresh(),
      "provisioning.cancel": () => window.wanxSetup.cancel(),
    };
    if (setupActions[action]) {
      const snapshot = await setupActions[action]();
      if (setupRequest !== request) return null;
      setupState = snapshot;
      return { ok: true };
    }
    const response = await window.wanxClient.action(action, input);
    if (response.state) acceptRemoteState(response.state);
    if (!response.ok) throw new Error(response.code);
    return response;
  } catch (error) {
    if (request && setupRequest !== request) return null;
    if (action === "auth.send-code" && error.message.includes("SMS_RATE_LIMITED")) {
      resendAt = Date.now() + 60000;
      updateResendButton();
    }
    failure = action.startsWith("provisioning.") ? setupErrorMessage(error) : operationErrorMessage(error);
    if (!isAppOperation && actionAccount === marketAccount) notice = failure;
    return null;
  } finally {
    if (isAppOperation && actionAccount === marketAccount) {
      if (failure) localOperations.set(applicationId, { phase: "failed", error: failure });
      else localOperations.delete(applicationId);
    }
    if (holdBusy && (!request || setupRequest === request)) busy = false;
    if (request && setupRequest === request) setupRequest = null;
    render(currentState);
  }
}

app.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  if (marketConfirmation && !["market-cancel", "market-confirm"].includes(action)) return;
  if (action === "market-cancel") { marketConfirmation = null; render(currentState); return; }
  if (action === "market-confirm") {
    const confirmation = marketConfirmation;
    if (!confirmation || busy) return;
    marketConfirmation = null;
    const generation = marketGeneration;
    const result = await run(confirmation.action, confirmation.input || { applicationId: confirmation.applicationId });
    if (result && generation === marketGeneration && confirmation.action === "ownership.accept") {
      transferNotice = result.value?.refreshRequired ? "所有权已接受，盒子列表暂未刷新，请点击刷新。" : "已接受所有权，请等待盒子授权同步后连接。";
      await refreshTransfers({ force: true });
    }
    if (result && confirmation.action.startsWith("market.")) await refreshMarket();
    return;
  }
  if (busy && ["auth-login", "auth-register", "send-registration-code"].includes(action)) return;
  if (action === "auth-login") { authMode = "login"; notice = null; codeSent = false; render(currentState); return; }
  if (action === "auth-register") { authMode = "register"; notice = null; codeSent = false; render(currentState); return; }
  if (action === "send-registration-code") {
    if (authMode !== "register" || resendSeconds()) return;
    const input = document.querySelector("#account-name");
    authUsername = input?.value.trim() || "";
    codeSent = false;
    if (!/^1\d{10}$/.test(authUsername)) { notice = "请输入有效的 11 位手机号"; render(currentState); return; }
    const response = await run("auth.send-code", { username: authUsername });
    if (response) {
      resendAt = Date.now() + 60000;
      codeSent = true;
      notice = "验证码已发送，5 分钟内有效，请查收短信";
      updateResendButton();
    }
    render(currentState);
    return;
  }
  if (busy && action.startsWith("transfer-")) return;
  if (action === "transfer-open") {
    transferDeviceId = target.dataset.deviceId;
    transferNotice = null;
    render(currentState);
    const form = app.querySelector('[data-form="transfer"]');
    form?.scrollIntoView({ block: "center", behavior: "instant" });
    form?.querySelector('[name="targetPhone"]')?.focus({ preventScroll: true });
    return;
  }
  if (action === "transfer-cancel") { transferDeviceId = null; render(currentState); return; }
  if (action === "transfer-refresh") { await refreshTransfers(); return; }
  if (action === "transfer-code") {
    if (Date.now() < transferResendAt) return;
    const generation = marketGeneration;
    const response = await run("ownership.send-code");
    if (response && generation === marketGeneration) { transferResendAt = Date.now() + 60000; transferNotice = "验证码已发送到你当前登录账号的手机号，60 秒后可再次发送。"; render(currentState); }
    return;
  }
  if (action === "transfer-accept") {
    const transfer = ownershipTransfers.find(item => item.transferId === target.dataset.transferId);
    if (!transfer || !transfer.retainData || transfer.direction !== "incoming") return;
    marketConfirmation = { title: "接受盒子所有权", detail: `确认接收盒子 ${transfer.deviceId} 及其保留的数据？接受后你将成为新所有者，原所有者将失去访问权限。`, verb: "接受", action: "ownership.accept", input: { transferId: transfer.transferId, retainData: true } };
    render(currentState); return;
  }
  if (action === "logout") { await run("auth.logout"); return; }
  if (["show-applications", "show-boxes", "show-settings"].includes(action)) {
    if (page === "provisioning") return;
    page = action.slice(5);
    if (page === "boxes") void refreshTransfers();
    notice = null;
    render(currentState);
    return;
  }
  if (action === "pending-cancel") { const pending = currentState.ui?.pendingOpen; if (pending) await run("applications.cancel-open", { intentId: pending.id }); return; }
  if (action === "pending-confirm") { const pending = currentState.ui?.pendingOpen; if (pending && pendingSelection?.deviceId && currentState.networkReady && !["connecting", "opening"].includes(pending.phase)) await run("applications.confirm-open", { intentId: pending.id, deviceId: pendingSelection.deviceId }); return; }
  if (action === "desktop-about") { await run("desktop.about"); return; }
  if (busy && action !== "cancel-provisioning") return;
  if (action === "startup-toggle") { if (currentState.desktopStartup?.supported) await run("desktop.startup.set", { enabled: !currentState.desktopStartup.enabled }); return; }
  if (action === "desktop-quit") { await run("desktop.quit"); return; }
  if (action === "dashboard-open") {
    if (currentState.canOpenDashboard) await run("dashboard.open");
    return;
  }
  if (action === "market-refresh") { await refreshMarket(); return; }
  if (["market-install", "market-uninstall", "market-rollback"].includes(action)) {
    const applicationId = target.dataset.applicationId;
    const installed = (currentState.applications || []).find((item) => item.applicationId === applicationId);
    const item = installed || marketItems.find((item) => item.applicationId === applicationId);
    if (!item || operationBusy(applicationId)) return;
    const candidate = marketCandidates.get(applicationId);
    if (action === "market-install" && candidate?.status !== "available") return;
    if (action !== "market-install" && !installed) return;
    const previous = typeof installed?.previous === "string" ? installed.previous : installed?.previous?.version;
    if (action === "market-rollback" && !previous) return;
    const verb = action === "market-uninstall" ? "卸载" : action === "market-rollback" ? "恢复" : installed ? "更新" : "安装";
    marketConfirmation = {
      applicationId, action: action.replace("market-", "market."), verb,
      title: `${verb}${item.name || "应用"}`,
      detail: action === "market-uninstall" ? "将移除此电脑上的应用程序，保留应用业务数据。"
        : action === "market-rollback" ? `将程序恢复到 v${previous}，不会还原业务数据。请先关闭正在运行的应用。`
        : `${installed ? `将 v${installed.version} 更新至` : "将安装"} v${candidate.release?.version}。${installed ? "请先关闭正在运行的应用。" : "安装完成后，连接盒子即可打开应用。"}`,
    };
    render(currentState);
    return;
  }
  if (action === "refresh") { if (page === "provisioning") page = "boxes"; await run("devices.refresh"); if (page === "boxes") await refreshTransfers({ force: true }); return; }
  if (action === "network-toggle") { await run("network.set-enabled", { enabled: currentState.network?.enabled === false }); return; }
  if (action === "provisioning") {
    resetWifiPicker();
    selection.reset();
    page = "provisioning";
    busy = true;
    render(currentState);
    try { setupState = await window.wanxSetup.reset(); }
    catch (error) { notice = error.message; }
    finally { busy = false; render(currentState); }
    return;
  }
  if (action === "wifi-refresh") { await scanWifi(); return; }
  if (action === "wifi-manual") {
    if (setupState.state !== "awaitingWifi") return;
    wifiPicker.manual = !wifiPicker.manual;
    if (!wifiPicker.manual && wifiPicker.selected) selectWifi(wifiKey(wifiPicker.selected));
    updateWifiPicker(); return;
  }
  if (action === "start-provisioning") {
    if (busy || !setupReady || discoveryView.selecting) return;
    resetWifiPicker(); selection.start(); return;
  }
  if (action === "select-candidate") { selection.choose(target.dataset.candidateId); return; }
  if (action === "provisioning-confirm") { await run("provisioning.confirm"); return; }
  if (action === "provisioning-refresh") { await run("provisioning.refresh"); return; }
  if (action === "provisioning-owner") { await run("provisioning.owner"); return; }
  if (action === "cancel-provisioning") { selection.reset(); await run("provisioning.cancel"); return; }
  if (action === "connect") {
    const device = currentState.devices?.find((item) => item.deviceId === target.dataset.deviceId);
    if (!currentState.networkReady || !device || !deviceCanConnect(device)) return;
    if (currentState.activeDeviceId && currentState.activeDeviceId !== device.deviceId) {
      marketConfirmation = { action: "devices.connect", input: { deviceId: device.deviceId }, title: `切换到 ${device.name || device.displayName || "此盒子"}`, detail: "当前应用与原盒子的连接将失效。切换后，请重新打开应用。", verb: "切换" };
      render(currentState);
    } else await run("devices.connect", { deviceId: device.deviceId });
    return;
  }
  if (action === "disconnect") {
    marketConfirmation = { action: "devices.disconnect", input: {}, title: "断开当前盒子", detail: "当前应用与盒子的连接将失效。重新连接后，请再次打开应用。", verb: "断开" };
    render(currentState); return;
  }
  if (action === "back-devices") { resetWifiPicker(); page = "boxes"; selection.reset(); notice = null; render(currentState); return; }
  if (action === "applications-select-current") {
    await run("applications.select-current", { applicationId: target.dataset.applicationId, version: target.dataset.version });
    return;
  }
  if (action === "applications-launch") {
    await run("applications.request-open", { applicationId: target.dataset.applicationId });
    return;
  }
});

function selectWifi(key) {
  const network = wifiPicker.networks.find(item => wifiKey(item) === key) || (wifiPicker.selected && wifiKey(wifiPicker.selected) === key ? wifiPicker.selected : null);
  if (network?.security === "unsupported") return;
  const form = app.querySelector?.('[data-form="wifi"]');
  if (!form) return;
  if (!wifiPicker.selected || wifiKey(wifiPicker.selected) !== key) { const password = form.querySelector('[name="password"]'); if (password) password.value = ""; }
  wifiPicker.selected = network;
  if (!network) { const ssid = form.querySelector('[name="ssid"]'); if (ssid) ssid.value = ""; updateWifiPicker(); return; }
  const ssid = form.querySelector('[name="ssid"]'); if (ssid) ssid.value = network.ssid;
  const security = form.querySelector('[name="security"]'); if (security) security.value = network.security;
  const hidden = form.querySelector('[name="hidden"]'); if (hidden) hidden.checked = false;
  updateWifiPicker();
}
app.addEventListener("change", (event) => {
  if (event.target.dataset.input === "wifi-network") selectWifi(event.target.value);
  if (event.target.name === "security") updateWifiPicker();
  if (event.target.dataset.input === "pending-device" && pendingSelection) pendingSelection.deviceId = event.target.value;
});
app.addEventListener("toggle", (event) => {
  const id = event.target.dataset?.detailId;
  if (id) { if (event.target.open) expandedDetails.add(id); else expandedDetails.delete(id); }
}, true);

app.addEventListener("keydown", (event) => {
  if (!marketConfirmation) return;
  if (event.key === "Escape") { marketConfirmation = null; render(currentState); }
  if (event.key === "Tab") {
    const buttons = app.querySelectorAll?.('.market-confirm-card button');
    if (buttons?.length) {
      event.preventDefault();
      const first = buttons[0], last = buttons[buttons.length - 1];
      (document.activeElement === first ? last : first).focus();
    }
  }
});

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  if (event.target.dataset.form === "transfer") {
    event.preventDefault();
    const generation = marketGeneration;
    const data = Object.fromEntries(new FormData(event.target));
    const result = await run("ownership.create", { deviceId: transferDeviceId, targetPhone: String(data.targetPhone || "").trim(), verificationCode: String(data.verificationCode || "").trim(), retainData: data.retainData === "on" });
    if (result && generation === marketGeneration) {
      transferDeviceId = null;
      transferNotice = result.value?.refreshRequired ? "邀请已发送，列表暂未刷新；请客户登录万象接受。" : "邀请已发送，24 小时内请客户登录万象，在“我的盒子”中接受转移。";
      await refreshTransfers({ force: true });
    }
    return;
  }
  if (event.target.dataset.form === "wifi") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    if (!wifiPicker.manual && !wifiPicker.selected) return;
    await run("provisioning.wifi", {
      ssid: data.ssid,
      security: data.security,
      hidden: data.hidden === "on",
      ...(data.security === "open" ? {} : { password: data.password }),
    });
    return;
  }
  if (event.target.dataset.form !== "auth") return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  authUsername = String(data.username || "").trim();
  codeSent = false;
  if (!/^1\d{10}$/.test(authUsername)) notice = "请输入有效的 11 位手机号";
  else if (authMode === "register" && (
    new TextEncoder().encode(data.password || "").length < 8 ||
    new TextEncoder().encode(data.password || "").length > 72 || /[\r\n\0]/.test(data.password)
  )) notice = "密码需为 8–72 字节，且不能包含换行符。";
  else if (authMode === "register" && data.password !== data.confirmPassword) notice = "两次输入的密码不一致";
  else if (authMode === "register" && !/^\d{6}$/.test(data.code || "")) notice = "请输入 6 位短信验证码";
  else {
    await run(authMode === "register" ? "auth.register" : "auth.login", { username: authUsername, password: data.password, ...(authMode === "register" ? { code: data.code } : {}) });
    return;
  }
  render(currentState);
});

function acceptRemoteState(state) {
  if (state.route !== "auth") {
    clearTimeout(resendTimer);
    resendAt = 0;
    codeSent = false;
  }
  const account = state.route === "auth" ? null : state.account?.accountId || "authenticated";
  const accountChanged = account !== marketAccount;
  // Page selection belongs to the UI; network polling only updates its data.
  // Do not discard in-progress Wi-Fi input or the selected BLE device.
  if (page === "provisioning" && state.route !== "auth" && !accountChanged) {
    currentState = state;
    // The account directory can arrive after Bluetooth discovery. Refresh names
    // while choosing a box, but leave the active setup flow and its inputs alone.
    if (setupState.state === "idle" && (discoveryView.selecting || discoveryView.retained)) render(state);
    return;
  }
  if (state.route === "auth" || accountChanged) {
    resetWifiPicker();
    page = "applications";
    transferRequest = null;
    ++ownershipRevision;
    if (setupRequest) { setupRequest = null; busy = false; }
    ownershipTransfers = []; transferDeviceId = null; transferNotice = null; transferResendAt = 0;
    selection.reset();
    marketItems = [];
    marketCandidates = new Map();
    marketConfirmation = null;
    localOperations.clear();
    pendingSelection = null;
    expandedDetails.clear();
    marketError = null;
    marketLoading = false;
    marketAccount = account;
    marketGeneration++;
    setupState = { state: "idle" };
  }
  render(state);
  if (state.route !== "auth" && accountChanged) {
    void refreshMarket();
  }
}
window.wanxClient.onLocalState(acceptRemoteState);
window.wanxClient.onNavigate?.((destination) => {
  if (!currentState || currentState.route === "auth" || page === "provisioning") return;
  if (!["applications", "boxes", "settings"].includes(destination)) return;
  page = destination;
  if (page === "boxes") void refreshTransfers();
  notice = null;
  render(currentState);
});
window.wanxSetup?.subscribe((snapshot) => {
  if (snapshot.pairingSessionId && wifiPicker.sessionId && snapshot.pairingSessionId !== wifiPicker.sessionId) resetWifiPicker();
  if (snapshot.pairingSessionId) wifiPicker.sessionId = snapshot.pairingSessionId;
  if (["cancelled", "completed", "terminalError", "restartRequired", "idle"].includes(snapshot.state)) resetWifiPicker();
  setupState = snapshot;
  if (page === "provisioning") render(currentState);
});
window.wanxSetup?.state().then((snapshot) => {
  setupState = snapshot;
  if (page === "provisioning") render(currentState);
}).catch(() => {});
window.wanxSetup?.onReady?.(() => {
  setupReady = true;
  if (currentState) render(currentState);
  window.wanxSetup.resume?.().catch(() => {}).then(() => window.wanxSetup.state()).then((snapshot) => {
    setupState = snapshot;
    if (page === "provisioning") render(currentState);
  }).catch(() => {});
});
window.wanxClient.getLocalState().then(acceptRemoteState);
