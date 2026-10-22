const app = document.querySelector("#app");
let currentState;
let page = "applications";
let selectedApplicationId = null;
let posterPreview = null;
let profileMenuOpen = false;
const storeCarousel = window.createStoreCarousel();
const featuredApplicationIds = ['centaurai.wanx.zhijun', 'centaurai.wanx.centaurloop', 'centaurai.wanx.dialogue', 'centaurai.wanx.ai-browser'];
const creditsView = window.createWalletView({ request: async (action, input) => {
  const response = await window.wanxClient.action(action, input);
  if (response.state && JSON.stringify([response.state.account?.phase, response.state.account?.accountId, response.state.account?.clientId]) !== JSON.stringify([currentState?.account?.phase, currentState?.account?.accountId, currentState?.account?.clientId])) { acceptRemoteState(response.state); throw new Error("ACCOUNT_SESSION_CHANGED"); }
  if (!response.ok) throw Object.assign(new Error(response.code), { code: response.code, request_id: response.request_id, details: response.details, retryable: response.retryable });
  return response.value;
}, changed: () => { if (currentState) render(currentState); },
  onTiming: value => { void window.wanxClient.recordPaymentTiming?.(value); } });
const supportView = window.createSupportView({ request: async (action, input) => {
  const response = await window.wanxClient.action(action, input);
  if (response.state && JSON.stringify([response.state.account?.phase, response.state.account?.accountId, response.state.account?.clientId]) !== JSON.stringify([currentState?.account?.phase, currentState?.account?.accountId, currentState?.account?.clientId])) throw new Error("SUPPORT_SESSION_CHANGED");
  if (!response.ok) throw new Error(response.code);
  return response.value;
}, changed: () => { if (currentState) render(currentState); } });
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
let consoleClaimAttempt = null;
let consoleClaimNotice = null;
let consoleClaimFlow = null;
let consoleClaimReceipt = null;
function resetConsoleClaim() {
  app.querySelector?.('[data-form="console-claim"]')?.reset();
  consoleClaimAttempt = null;
  consoleClaimNotice = null;
  consoleClaimFlow = null;
  consoleClaimReceipt = null;
}
let transferNotice = null;
let transferResendAt = 0;
let transferResendTimer;
let authMode = "login";
let authUsername = "";
let resendAt = 0;
let resendTimer;
let codeSent = false;
let passwordEditing = false;
let resetResendAt = 0;
let changeResendAt = 0;
let passwordResendTimer;
let notice = null;
let connectionFailure = null;
const localOperations = new Map();
let pendingSelection = null;
let revealedPendingOpenId = null;
const expandedDetails = new Set();
let busy = false;
let busyRequest = null;
function busyFor(action) { return busyRequest?.action === action; }
function activityLabel(label) { return `<span class="activity-spinner" aria-hidden="true"></span>${escapeHTML(label)}`; }
let boxUpdatePollTimer;
let boxUpdatePollKey = null;
let boxUpdatePollError = null;
let boxUpdatePollRequest = null;
let renderedMarkup = null;
let activeInteraction = false;
let interactionTimer;
let setupState = { state: "idle" };
let setupReady = false;
let bluetoothState = window.wanxBluetooth?.snapshot() || { status: "unsupported" };
let setupRequest = null;
let setupSelection = null;
let setupTargetDeviceId = null;
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
let discoveryMetadata = new Map();
let discoveryMetadataGeneration = 0;
let discoveryMetadataRequest = null;
function discoveryDeviceId(candidate) {
  const value = candidate.displayIdentity?.deviceId;
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,36}$/.test(value) ? value : "";
}
function resetDiscoveryMetadata() {
  ++discoveryMetadataGeneration;
  discoveryMetadata = new Map();
  discoveryMetadataRequest = null;
}
function discoveryMetadataActive() {
  return page === "provisioning" && currentState?.route !== "auth" && marketAccount !== null &&
    (discoveryView.selecting || discoveryView.retained);
}
function updateDiscoveryMetadata() {
  if (!discoveryMetadataActive()) { resetDiscoveryMetadata(); return; }
  const ids = new Set(discoveryView.candidates.map(discoveryDeviceId).filter(id => /^centauros-(?:[0-9a-f]{24}|[0-9a-f]{32})$/.test(id)));
  for (const id of discoveryMetadata.keys()) if (!ids.has(id)) discoveryMetadata.delete(id);
  for (const id of ids) if (!discoveryMetadata.has(id)) discoveryMetadata.set(id, { requested: false, value: null });
  // Coalesce identity notifications, then query each ID once per scan. Rendering
  // and account/network broadcasts never initiate discovery lookups.
  void Promise.resolve().then(loadDiscoveryMetadata);
}
async function loadDiscoveryMetadata() {
  if (!discoveryMetadataActive() || discoveryMetadataRequest) return;
  const entries = [...discoveryMetadata].filter(([, entry]) => !entry.requested).slice(0, 16);
  if (!entries.length) return;
  for (const [, entry] of entries) entry.requested = true;
  const request = { generation: discoveryMetadataGeneration, account: marketAccount, entries };
  discoveryMetadataRequest = request;
  try {
    const response = await window.wanxClient.action("devices.discovery", { deviceIds: entries.map(([id]) => id) });
    if (request.generation !== discoveryMetadataGeneration || request.account !== marketAccount || !discoveryMetadataActive()) return;
    const rows = response.ok && Array.isArray(response.value?.devices) ? response.value.devices : [];
    for (const [id, entry] of entries) {
      // Removing or replacing a GATT identity revokes its old asynchronous result.
      if (discoveryMetadata.get(id) !== entry) continue;
      const matches = rows.filter(row => row?.deviceId === id);
      const value = matches.length === 1 ? matches[0] : null;
      entry.value = {
        deviceName: typeof value?.deviceName === "string" ? value.deviceName : null,
        claimStatus: ["claimed", "unclaimed"].includes(value?.claimStatus) ? value.claimStatus : "unknown",
      };
    }
    // This read-only result cannot replace newer account state from broadcasts.
    render(currentState);
  } catch {
    // Older platforms and temporary failures keep the local name and unknown state.
  } finally {
    if (discoveryMetadataRequest === request) {
      discoveryMetadataRequest = null;
      void loadDiscoveryMetadata();
    }
  }
}
const selection = createDiscoverySelection({
  discovery: window.wanxDiscovery,
  transport: window.wanxDeviceSetupTransport,
  onChange(view) {
    discoveryView = view;
    updateDiscoveryMetadata();
    if (page === "provisioning") render(currentState);
  },
  onNotice(issue) {
    const messages = {
      unavailable: "当前运行时尚未接入本地配网能力",
      expired: "扫描结果已过期，请重新扫描盒子。",
      reselect_failed: "未能连接所选盒子，请靠近盒子并重新扫描后重试。",
      selection_cancel_failed: "蓝牙扫描未能正常结束，请关闭并重新打开万象后再扫描。",
      empty: "未发现可用盒子，请确认盒子通电、靠近电脑，并检查电脑蓝牙后重新扫描。",
    };
    notice = issue ? messages[issue.kind] || issue.message : null;
  },
  onSelected(candidate) {
    const selected = setupSelection;
    setupSelection = null;
    if (selected?.mode === "wifi" && !deviceIsOwner(selected.deviceId)) {
      notice = "当前账号不是此盒子的主人，请刷新盒子列表后重试。";
      render(currentState);
      return;
    }
    void run("provisioning.start", { candidate, mode: selected?.mode || "claim", expectedDeviceId: selected?.expectedDeviceId,
      ...(selected?.mode === "console" ? { claimCode: consoleClaimAttempt?.claimCode } : {}) });
  },
});
window.addEventListener?.("pagehide", () => { resetWifiPicker(); resetDiscoveryMetadata(); selection.dispose(); supportView.close(); }, { once: true });
window.addEventListener?.("pagehide", () => { clearTimeout(resendTimer); clearTimeout(transferResendTimer); clearTimeout(passwordResendTimer); }, { once: true });
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
  if (currentState.recovery?.deviceId === device.deviceId && currentState.recovery.status === "failed") return "连接已中断，自动重连 3 次未成功，请手动重连";
  if (selected && currentState.recovery?.status === "retrying") return `正在自动重连（${currentState.recovery.attempt}/3）`;
  if (selected && currentState.connectionPhase === "recovering") return "正在恢复连接";
  if (selected && ["connecting", "resolving"].includes(currentState.connectionPhase)) return "正在连接";
  if (currentState.activeDeviceId === device.deviceId) return "当前连接";
  const accessLabel = {
    service_unavailable: "账号服务待更新", access_denied: "未获访问权限",
    authorization_unavailable: "盒子授权组件待更新", authorization_pending: "正在同步访问权限",
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

function authorizationHint() {
  return "请保持电脑和盒子联网，授权同步完成后会自动更新；长时间未完成可点击刷新。";
}

function deviceCard(device) {
  const selected = currentState.activeDeviceId === device.deviceId;
  const connecting = (busyRequest?.action === "devices.connect" && busyRequest.deviceId === device.deviceId) ||
    ((currentState.selectedDeviceId || currentState.activeDeviceId) === device.deviceId &&
      ["connecting", "resolving", "recovering"].includes(currentState.connectionPhase));
  const disconnecting = busyFor("devices.disconnect") && busyRequest.deviceId === device.deviceId;
  const available = deviceCanConnect(device);
  const needsSetup = ["discovered", "unclaimed", "uninitialized"].includes(device.accessState);
  const action = disconnecting
    ? `<button class="button small activity-button" aria-busy="true" disabled>${activityLabel("正在断开…")}</button>`
    : currentState.selectedDeviceId === device.deviceId && currentState.recovery?.status === "retrying"
    ? `<button class="button small" data-action="disconnect" ${busy ? "disabled" : ""}>停止重连</button>`
    : connecting
    ? `<button class="button small activity-button" aria-busy="true" disabled><span class="activity-spinner" aria-hidden="true"></span>正在连接…</button>`
    : selected
    ? `<button class="button small" data-action="disconnect" ${busy ? "disabled" : ""}>断开</button>`
    : available && (device.local || currentState.networkReady)
      ? `<button class="button small" data-action="connect" data-device-id="${escapeHTML(device.deviceId)}" ${busy ? "disabled" : ""}>${currentState.activeDeviceId ? "切换并连接" : "连接"}</button>`
      : available
        ? `<button class="button small" disabled>${networkStatus().label}</button>`
        : needsSetup ? `<button class="button small" data-action="provisioning" ${busy ? "disabled" : ""}>配置盒子</button>`
          : `<span class="muted">${escapeHTML(statusLabel(device))}</span>`;
  return `<article class="device-card ${selected ? "selected" : ""}">
    <img class="device-icon" src="./assets/centaurai-mark.png" alt="" />
    <div class="device-main"><h3>${escapeHTML(device.name || device.displayName || "万象盒子")}</h3><p class="device-meta"><span class="status-dot ${selected ? "ready" : ""}"></span>${device.local ? "本机服务 · " : ""}${escapeHTML(statusLabel(device))}</p>${device.accessState === "authorization_pending" ? `<p class="device-meta">${authorizationHint()}</p>` : ""}${connectionFailure?.deviceId === device.deviceId ? `<p class="inline-error" role="alert">${escapeHTML(connectionFailure.message)}</p>` : ""}</div>
    <div class="device-action">${action}${device.deviceRole === "owner" || device.role === "owner" ? `${!device.local ? `<button class="text-button" data-action="configure-network" data-device-id="${escapeHTML(device.deviceId)}" ${busy ? "disabled" : ""}>配置网络</button>` : ""}<button class="text-button" data-action="support-open" data-device-id="${escapeHTML(device.deviceId)}" ${busy ? "disabled" : ""}>远程协助</button><button class="text-button" data-action="transfer-open" data-device-id="${escapeHTML(device.deviceId)}" ${busy ? "disabled" : ""}>转移所有权</button>` : ""}</div></article>`;
}

function networkStatus() {
  if (currentState.activeDeviceId && currentState.connection?.mode === "local") return { label: "本机已连接", detail: "正在使用这台电脑上的万象服务。" };
  if (currentState.network?.enabled === false) return { label: "网络尚未就绪", detail: "请检查本机网络后点击“刷新设备”重试。" };
  if (currentState.networkReady) return { label: "网络已连接", detail: "可以连接盒子并使用应用。" };
  if (currentState.platform?.reason === "NETWORK_REVOCATION_PENDING")
    return { label: "网络会话清理中", detail: "服务器正在清理旧连接，完成后将自动重连；传输会保留进度等待恢复。" };
  if (currentState.platform?.reason === "NETWORK_LEASE_EXPIRED")
    return { label: "网络授权已到期", detail: "请重试连接，重新获取授权后继续传输。" };
  if (currentState.platform?.phase === "unavailable" || ["unavailable", "failed", "error"].includes(currentState.network?.phase))
    return { label: "网络暂不可用", detail: "请检查本机网络后重试连接。" };
  return { label: "网络连接中", detail: "正在准备与盒子的连接。" };
}

function activeDeviceName() {
  return currentState.devices?.find((device) => device.deviceId === currentState.activeDeviceId)?.name || currentState.connection?.name || "万象盒子";
}

function profileAvatar(large = false) {
  const profile = currentState.account?.profile || {};
  const avatar = typeof profile.avatarDataUrl === "string" && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(profile.avatarDataUrl) && profile.avatarDataUrl.length <= 512000 ? profile.avatarDataUrl : null;
  return `<span class="user-avatar ${large ? "large" : ""}">${avatar ? `<img src="${avatar}" alt="用户头像" />` : `<span aria-hidden="true">${escapeHTML(Array.from(profile.displayName || "万")[0])}</span>`}</span>`;
}
function shellHeader(title) {
  const activePage = page === "provisioning" ? "boxes" : page === "application-detail" ? "applications" : page;
  const name = currentState.account?.profile?.displayName || "万象用户";
  return `<header class="topbar">
    <button class="brand brand-button" data-action="desktop-about" aria-label="关于万象"><img class="brand-mark" src="./assets/centaurai-mark.png" alt="半人马" /><span class="brand-copy"><strong>半人马AI-万象</strong><small>CentaurAI-WanX</small></span></button>
    <h1 class="sr-only">${title}</h1>
    <nav class="main-nav" aria-label="管理导航">${[["applications", "应用"], ["space", "空间"], ["boxes", "盒子"], ["credits", "积分"]].map(([destination, label]) => `<button class="nav-item ${activePage === destination ? "active" : ""}" data-action="show-${destination}" ${activePage === destination ? 'aria-current="page"' : ""} ${page === "provisioning" ? "disabled" : ""}>${label}${destination === "credits" ? `<small class="nav-credit-balance">${creditsView.label()}</small>` : ""}</button>`).join("")}</nav>
    <div class="account-menu"><button class="avatar-trigger" data-action="profile-menu" aria-label="个人资料与设置" aria-expanded="${profileMenuOpen}" aria-controls="profile-menu" ${page === "provisioning" ? "disabled" : ""}>${profileAvatar()}<span aria-hidden="true">⌄</span></button>
    ${profileMenuOpen ? `<div class="profile-menu" id="profile-menu"><div class="profile-menu-identity"><strong>${escapeHTML(name)}</strong><small>${escapeHTML(currentState.account?.maskedPhone || "万象账号")}</small></div><button data-action="show-profile">个人资料<span>›</span></button><button data-action="show-settings">设置<span>›</span></button><div class="profile-menu-divider"></div><button data-action="logout" class="${busyFor("auth.logout") ? "activity-button" : ""}" aria-busy="${busyFor("auth.logout")}" ${busy ? "disabled" : ""}>${busyFor("auth.logout") ? activityLabel("正在退出…") : "退出登录"}</button></div>` : ""}</div></header>`;
}
function profileView() {
  const account = currentState.account || {}, profile = account.profile || {};
  const avatarPending = busyFor("profile.avatar") || busyFor("profile.avatar-remove");
  return `<div class="app-layout">${shellHeader("个人资料")}<div class="page-content profile-page">
    <div class="page-heading"><h2>个人资料</h2><p class="muted">用你熟悉的样子，在万象相见。</p></div>
    ${notice ? `<div class="notice ${codeSent ? "success" : "error"}" role="status">${escapeHTML(notice)}</div>` : ""}
    <section class="profile-card"><div class="profile-avatar-row"><button class="profile-avatar-button" data-action="profile-avatar" aria-label="上传头像" ${busy ? "disabled" : ""}>${profileAvatar(true)}<span>更换头像</span></button><div><h3>你的头像</h3><p class="muted">支持 JPG、PNG，最大 5 MB。图片将居中裁为方形。</p><div class="settings-actions"><button class="button small ${busyFor("profile.avatar") ? "activity-button" : ""}" data-action="profile-avatar" aria-busy="${busyFor("profile.avatar")}" ${busy ? "disabled" : ""}>${busyFor("profile.avatar") ? activityLabel("正在更新…") : "上传头像"}</button>${profile.avatarDataUrl ? `<button class="text-button ${busyFor("profile.avatar-remove") ? "activity-button" : ""}" data-action="profile-avatar-remove" aria-busy="${busyFor("profile.avatar-remove")}" ${busy ? "disabled" : ""}>${busyFor("profile.avatar-remove") ? activityLabel("正在恢复…") : "恢复默认"}</button>` : ""}</div></div></div>${avatarPending ? `<p class="muted activity-status" role="status">${activityLabel("正在更新头像…")}</p>` : ""}
    <form data-form="profile"><label for="profile-name">昵称</label><input id="profile-name" name="displayName" value="${escapeHTML(profile.displayName || "万象用户")}" maxlength="80" required autocomplete="nickname" /><p class="muted">最多 40 个字符，昵称不会改变登录账号。</p><button class="button primary ${busyFor("profile.save") ? "activity-button" : ""}" type="submit" aria-busy="${busyFor("profile.save")}" ${busy ? "disabled" : ""}>${busyFor("profile.save") ? activityLabel("正在保存…") : "保存资料"}</button></form></section>
    <section class="profile-card profile-account"><h3>万象账号</h3><dl><dt>绑定手机号</dt><dd>${escapeHTML(account.maskedPhone || "暂未提供")}</dd><dt>资料保存</dt><dd>当前电脑</dd></dl><p class="muted">头像和昵称仅保存在这台电脑，按万象账号分别保存。</p></section>
    </div></div>`;
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
    const sending = busyFor("auth.send-code");
    button.classList.toggle("activity-button", sending);
    button.setAttribute("aria-busy", String(sending));
    button.innerHTML = sending ? activityLabel("正在发送…") : remaining ? `${remaining} 秒后重新获取` : "获取验证码";
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

function authSubmitLabel() {
  return authMode === "register" ? "创建账号并进入" : authMode === "reset" ? "重置密码" : "登录并进入";
}

function passwordFields(prefix, action, until) {
  const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  const sending = busyFor({ "send-registration-code": "auth.send-code", "send-reset-code": "auth.send-reset-code", "send-change-code": "auth.send-change-code" }[action]);
  return `<label for="${prefix}-confirm-password">确认密码</label><input id="${prefix}-confirm-password" name="confirmPassword" type="password" required autocomplete="new-password" placeholder="再次输入密码" /><label for="${prefix}-code">短信验证码</label><div class="code-field"><input id="${prefix}-code" name="code" required pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code" placeholder="输入 6 位验证码" /><button class="button small ${sending ? "activity-button" : ""}" type="button" data-action="${action}" aria-busy="${sending}" ${busy || remaining ? "disabled" : ""}>${sending ? activityLabel("正在发送…") : remaining ? `${remaining} 秒后重新获取` : "获取验证码"}</button></div>`;
}

function updatePasswordCodeButtons() {
  clearTimeout(passwordResendTimer);
  let waiting = false;
  for (const [action, until] of [["send-reset-code", resetResendAt], ["send-change-code", changeResendAt]]) {
    const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    const button = document.querySelector(`[data-action="${action}"]`);
    if (button) {
      button.disabled = busy || remaining > 0;
      const sending = busyFor(action === "send-reset-code" ? "auth.send-reset-code" : "auth.send-change-code");
      button.classList.toggle("activity-button", sending);
      button.setAttribute("aria-busy", String(sending));
      button.innerHTML = sending ? activityLabel("正在发送…") : remaining ? `${remaining} 秒后重新获取` : "获取验证码";
      waiting ||= remaining > 0;
    }
  }
  if (waiting) passwordResendTimer = setTimeout(updatePasswordCodeButtons, 1000);
}

function authView() {
  const register = authMode === "register";
  const reset = authMode === "reset";
  const newPassword = register || reset;
  return `<div class="auth-layout"><section class="auth-card">
    <button class="auth-brand brand-button" data-action="desktop-about" aria-label="关于万象"><img class="brand-mark" src="./assets/centaurai-mark.png" alt="半人马" /><span class="brand-copy"><strong>半人马AI-万象</strong><small>CentaurAI-WanX</small></span></button>
    <h1>${reset ? "找回密码" : register ? "注册万象平台" : "登录万象平台"}</h1><p class="muted">连接你的盒子，发现和使用 AI 应用。</p>
        ${reset ? `<p class="muted">通过账号绑定的手机号验证身份，重置后请用新密码登录。</p>` : `<div class="tabs"><button class="tab ${!register ? "active" : ""}" data-action="auth-login" ${busy ? "disabled" : ""}>登录</button><button class="tab ${register ? "active" : ""}" data-action="auth-register" ${busy ? "disabled" : ""}>注册</button></div>`}
        <form id="auth-form" data-form="auth" data-mode="${authMode}" novalidate>
          <label for="account-name">手机号</label>
          <input id="account-name" name="username" value="${escapeHTML(authUsername)}" required pattern="1[0-9]{10}" autocomplete="username" placeholder="13800138000" />
          <label for="account-password">${reset ? "新密码" : "密码"}</label>
          <input id="account-password" name="password" type="password" required autocomplete="${newPassword ? "new-password" : "current-password"}" placeholder="${newPassword ? "设置 8–72 字节的新密码" : "输入密码"}" />
          ${newPassword ? passwordFields("account", reset ? "send-reset-code" : "send-registration-code", reset ? resetResendAt : resendAt) : ""}
          ${!newPassword ? `<label class="remember-login"><input type="checkbox" name="remember" checked ${busy ? "disabled" : ""} />记住账号密码</label>` : ""}
          <div data-auth-notice class="notice ${codeSent ? "success" : "error"}" role="status" ${notice ? "" : "hidden"}>${escapeHTML(notice)}</div>
          <button class="button primary wide" type="submit" ${busy ? "disabled" : ""}>${busy ? authBusyLabel() : authSubmitLabel()}</button>
        </form>
        <button class="text-button auth-help" data-action="${reset ? "auth-login" : "auth-reset"}" ${busy ? "disabled" : ""}>${reset ? "返回登录" : "忘记密码？"}</button>
    </section></div>`;
}

function updateBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateGuidance(code) {
  const messages = {
    PLAN_STALE: "盒子状态已变化，请重新检查并生成更新计划。",
    UPDATE_IN_PROGRESS: "已有更新正在进行，请刷新该任务的进度。",
    UNSUPPORTED_PLATFORM: "此平台尚未通过更新验证，请继续使用当前版本并联系维护人员。",
    CONTRACT_UNSUPPORTED: "当前程序暂不支持此更新，请先安装受支持的万象版本。",
    UPDATE_SIGNATURE_VERIFICATION_FAILED: "无法核验安装包的系统签名，请联系维护人员。",
    DEPENDENCY_CONFLICT: "当前应用与目标版本不兼容，请保留现有版本并等待兼容更新。",
    INSUFFICIENT_SPACE: "可用空间不足，请释放空间后重新检查。",
    UPDATE_PERMISSION_REQUIRED: "你没有此盒子的更新权限，请联系盒主更新。",
    RELEASE_WITHDRAWN: "此版本已停止提供，请重新检查更新。",
    RECOVERY_REQUIRED: "更新需要维护人员处理，请保留当前状态并提供下方任务编号。",
    INVENTORY_UNKNOWN: "尚未取得可核验的盒端运行版本，请联系运维人员检查版本报告与部署回执。",
    INVENTORY_STALE: "盒子的版本报告已过期，请等待盒子联网后重新检查。",
    RELEASE_UNAVAILABLE: "暂时没有适用更新，请保留当前版本并稍后检查。",
    UPDATER_UNSUPPORTED: "盒端管理组件版本过旧，请联系盒主完成受控引导升级。",
    UPDATER_NOT_READY: "盒端升级服务尚未就绪，请联系盒主完成管理组件引导和验证。",
    ALREADY_CURRENT: "盒子已运行目标版本，无需再次更新。",
    UPDATE_UNAVAILABLE: "暂时无法检查更新，请稍后重试。",
    UPDATE_REQUEST_FAILED: "暂时无法连接更新服务，请检查网络后重试。",
    UPDATE_DEVELOPMENT_BUILD: "这是开发构建，请使用正式发行包接收客户端更新。",
    UPDATE_NOT_CONFIGURED: "当前未配置正式更新，请联系发行维护人员获取受支持的安装包。",
    UPDATE_SIGNER_NOT_CONFIGURED: "当前未配置安装包签名校验，请联系发行维护人员。",
    UPDATE_LOCAL_NEWER: "当前版本高于渠道版本，继续保留现有安装。",
    UPDATE_SAME_VERSION_BUILD: "渠道构建与当前构建不同，请联系发行维护人员确认；不会按同版本自动替换。",
    UPDATE_RECOVERY_REQUIRED: "上次客户端更新未完成，请重新检查更新；若无法启动新版本，请联系维护人员。",
    UPDATE_CANDIDATE_CHANGED: "可用更新已变化，请重新检查后确认。",
    UPDATE_UNTRUSTED_KEY: "发行签名不受信任，已保留当前版本，请联系发行维护人员。",
    SIGNATURE_INVALID: "发行签名校验未通过，已保留当前版本，请联系发行维护人员。",
    UPDATE_ARTIFACT_MISMATCH: "下载内容与发行不一致，已保留当前版本，请重新检查更新。",
    APPLICATIONS_RUNNING: "请保存工作并关闭正在运行的应用，再重启更新。",
  };
  return messages[String(code || "").toUpperCase()] || "请重新检查更新；若仍失败，请联系维护人员并提供错误代码。";
}

function updateIssueView(update) {
  const blockers = Array.isArray(update?.blockers) ? update.blockers : [];
  const issues = blockers.length ? blockers : update?.reason ? [update.reason] : [];
  return issues.length ? `<div class="update-issues" role="status">${issues.map(issue => {
    const code = typeof issue === "string" ? issue : issue.code || issue.reason;
    return `<p>${escapeHTML(typeof issue === "object" && issue.message ? issue.message : updateGuidance(code))}${code ? ` <span class="muted">（${escapeHTML(code)}）</span>` : ""}</p>`;
  }).join("")}</div>` : "";
}

function clientUpdateView() {
  const update = currentState.upgrades?.client || {};
  const current = update.current || {};
  const candidate = update.candidate;
  const phase = update.phase || "unavailable";
  const labels = {
    development: "开发构建，请安装正式发行包以接收更新。", unavailable: "当前尚未接入正式更新。",
    idle: "尚未检查更新", checking: "正在检查更新…", available: "有可用更新", up_to_date: "最近检查未发现适用更新",
    blocked: "此更新暂不可用", downloading: "正在下载更新…", downloaded: "更新已下载，可选择现在重启安装",
    installing: "正在准备重启安装…", failed: "更新未完成，当前版本仍保留", succeeded: "已完成客户端更新",
  };
  const checking = phase === "checking" || busyFor("updates.client.check");
  const downloading = phase === "downloading" || busyFor("updates.client.download");
  const pending = checking || downloading || phase === "installing";
  const disabled = busy || pending ? "disabled" : "";
  const progress = update.progress;
  const transferred = Number(progress?.transferred);
  const total = Number(progress?.total);
  const hasProgress = progress && Number.isFinite(transferred) && transferred >= 0;
  const hasTotal = hasProgress && Number.isFinite(total) && total > 0;
  return `<article class="update-card"><div class="update-heading"><div><h3>万象客户端 <span class="update-version">${current.productVersion ? `v${escapeHTML(current.productVersion)}` : "版本待核验"}</span></h3><p class="muted ${pending ? "activity-status" : ""}" role="status">${pending ? '<span class="activity-spinner" aria-hidden="true"></span>' : ""}${escapeHTML(checking ? labels.checking : downloading ? labels.downloading : labels[phase] || "更新状态待确认")}</p></div><div class="settings-actions">${!["development", "unavailable", "downloaded", "installing"].includes(phase) ? `<button class="button small ${checking ? "activity-button" : ""}" data-action="updates-client-check" aria-busy="${checking}" ${disabled}>${checking ? activityLabel("检查中…") : "检查更新"}</button>` : ""}${phase === "available" && candidate ? `<button class="button primary small ${downloading ? "activity-button" : ""}" data-action="updates-client-download" aria-busy="${downloading}" ${disabled}>${downloading ? activityLabel("正在下载…") : "下载更新"}</button>` : ""}${phase === "downloaded" && candidate ? `<button class="button primary small" data-action="updates-client-install" ${disabled}>重启并更新</button>` : ""}</div></div>
    ${candidate ? `<p class="update-candidate">可用版本 v${escapeHTML(candidate.productVersion || "待核验")}${candidate.size != null ? ` · ${escapeHTML(updateBytes(candidate.size))}` : ""}${candidate.requiresRestart ? " · 需要重启万象" : ""}</p>${candidate.releaseNotes ? `<p class="update-notes">${escapeHTML(candidate.releaseNotes)}</p>` : ""}` : ""}
    ${hasProgress ? `<div class="update-progress" role="status"><progress aria-label="客户端下载进度" ${hasTotal ? `max="${total}" value="${Math.min(transferred, total)}"` : ""}></progress><span>${escapeHTML(updateBytes(transferred))}${hasTotal ? ` / ${escapeHTML(updateBytes(total))}` : " · 总大小待确认"}</span></div>` : ""}
    ${updateIssueView(update)}
    <details class="application-details" data-detail-id="updates-client" ${expandedDetails.has("updates-client") ? "open" : ""}><summary>版本详情</summary><dl class="update-facts"><dt>构建标识</dt><dd>${escapeHTML(current.buildId || "未知")}</dd><dt>渠道 / 类型</dt><dd>${escapeHTML(current.channel || "未知")} / ${escapeHTML(current.distributionClass || "未知")}</dd><dt>平台</dt><dd>${escapeHTML(current.platform || "未知")} / ${escapeHTML(current.arch || "未知")}</dd><dt>最近检查</dt><dd>${escapeHTML(update.checkedAt || "尚未检查")}</dd></dl></details>
  </article>`;
}

function versionUpdatesView() {
  return `<section class="updates-section" aria-labelledby="updates-heading"><h3 id="updates-heading">版本与更新</h3>${clientUpdateView()}${boxUpdateView()}</section>`;
}

function boxUpdateView() {
  const deviceId = currentState.activeDeviceId;
  if (!deviceId) return `<article class="update-card"><h3>当前盒子</h3><p class="muted">尚未选择盒子。连接后可检查运行版本与更新。</p></article>`;
  const update = currentState.upgrades?.box?.deviceId === deviceId ? currentState.upgrades.box : {};
  const inventory = update.inventory;
  const candidate = update.candidate;
  const release = candidate?.release?.payload;
  const components = Object.entries(inventory?.components || {});
  const verified = components.length > 0 && components.every(([, value]) => value.evidenceStatus === "verified" && value.health === "healthy" && value.installedVersion === value.runningVersion);
  const actual = inventory?.suiteVersion && verified ? `v${inventory.suiteVersion}` : components.some(([, value]) => value.evidenceStatus === "drifted" || value.installedVersion && value.runningVersion && value.installedVersion !== value.runningVersion) ? "部分更新 / 自定义组合" : "版本待核验";
  const operation = update.operation;
  const state = operation?.state;
  const labels = { queued: "等待盒子领取任务", prechecking: "正在检查更新条件", downloading: "正在下载", staged: "制品已准备好", waiting_window: "等待更新时机", applying: "正在安装，服务可能暂时中断", verifying: "正在核验运行版本", succeeded: "已核验更新成功", rolling_back: "正在恢复先前程序", rolled_back: "已恢复先前程序，本次更新未成功", failed: "本次更新未完成", needs_attention: "需要维护人员处理", cancelled: "更新已取消" };
  const checking = update.phase === "checking" || busyFor("updates.box.check");
  const planning = update.phase === "planning" || busyFor("updates.box.plan");
  const pending = checking || planning;
  const active = operation && !["succeeded", "rolled_back", "failed", "needs_attention", "cancelled"].includes(state);
  const disabled = busy || pending ? "disabled" : "";
  const actions = operation?.allowedActions || [];
  const status = operation ? labels[state] || "任务结果待确认" : checking ? "正在检查更新…" : planning ? "正在准备更新…" : candidate?.status === "current" && verified ? "最近检查未发现适用更新" : update.phase === "blocked" || candidate?.status === "blocked" ? "暂不可更新" : release ? `有可用版本 v${release.version}` : inventory ? "已取得版本报告" : "尚未取得运行版本";
  return `<article class="update-card"><div class="update-heading"><div><h3>${escapeHTML(activeDeviceName())} <span class="update-version">${escapeHTML(actual)}</span></h3><p class="muted ${pending ? "activity-status" : ""}" role="status">${pending ? '<span class="activity-spinner" aria-hidden="true"></span>' : ""}${escapeHTML(status)}</p></div><div class="settings-actions"><button class="button small ${checking ? "activity-button" : ""}" data-action="updates-box-check" aria-busy="${checking}" ${disabled}>${checking ? activityLabel("检查中…") : "检查更新"}</button>${update.canUpgrade === true && release && candidate.status === "available" && !active && state !== "needs_attention" && (state !== "rolled_back" || actions.includes("replan")) ? `<button class="button primary small ${planning ? "activity-button" : ""}" data-action="updates-box-plan" aria-busy="${planning}" ${disabled}>${planning ? activityLabel("正在准备…") : ["failed", "rolled_back"].includes(state) ? "重新预检" : "准备更新"}</button>` : ""}</div></div>
    ${inventory?.observedAt ? `<p class="muted">版本报告时间：${escapeHTML(inventory.observedAt)}${Date.now() - Date.parse(inventory.observedAt) > 15 * 60 * 1000 ? " · 报告已过期，当前状态待核验" : ""}</p>` : ""}
    ${release && candidate.status === "available" ? `<p class="update-candidate">可用版本 v${escapeHTML(release.version)} · 更新期间盒端应用可能暂时不可用</p>` : ""}
    ${release && candidate.status === "available" && update.canUpgrade !== true ? '<p class="muted">盒端更新需由盒主或受权维护人员执行，请联系盒主更新。</p>' : ""}
    ${release?.releaseNotes ? `<p class="update-notes">${escapeHTML(release.releaseNotes)}</p>` : ""}
    ${updateIssueView(update)}${candidate?.reasonCode && !update.reason ? updateIssueView({ reason: candidate.reasonCode }) : ""}
    ${boxUpdatePollError ? `<p class="inline-error update-candidate">${escapeHTML(boxUpdatePollError)}</p>` : ""}
    ${operation ? `<div class="update-operation" role="status"><p>${escapeHTML(labels[state] || state || "结果待确认")}${operation.step ? ` · ${escapeHTML(operation.step)}` : ""}</p><p class="muted">服务${operation.serviceAvailable === true ? "可用" : operation.serviceAvailable === false ? "暂不可用" : "可用性待确认"} · 任务 ${escapeHTML(operation.operationId)}</p>${operation.errorCode ? `<p class="inline-error">${escapeHTML(updateGuidance(operation.errorCode))} <span class="muted">（${escapeHTML(operation.errorCode)}）</span></p>` : ""}${state === "needs_attention" && !operation.errorCode ? '<p class="inline-error">请联系维护人员并提供任务编号，保留当前状态。</p>' : ""}<div class="market-actions"><button class="text-button" data-action="updates-box-status" ${disabled}>刷新任务状态</button>${update.canUpgrade === true && actions.includes("cancel") ? `<button class="text-button" data-action="updates-box-cancel" ${disabled}>取消更新</button>` : ""}${update.canUpgrade === true && actions.includes("resume") ? `<button class="button small" data-action="updates-box-resume" ${disabled}>继续此任务</button>` : ""}</div></div>` : ""}
    <details class="application-details" data-detail-id="updates-box" ${expandedDetails.has("updates-box") ? "open" : ""}><summary>版本详情</summary><dl class="update-facts"><dt>设备</dt><dd>${escapeHTML(deviceId)}</dd><dt>套件报告</dt><dd>${escapeHTML(inventory?.suiteVersion || "未知")}</dd><dt>管理组件</dt><dd>${escapeHTML(inventory?.updaterVersion || "未知")} · ${inventory?.otaReady === true ? "支持检查升级条件" : inventory ? "已运行，自动更新条件待核验" : "未取得版本报告，需完成管理组件引导"}</dd><dt>最近检查</dt><dd>${escapeHTML(update.checkedAt || "尚未检查")}</dd></dl>${components.length ? `<table class="update-components"><thead><tr><th>组件</th><th>安装 / 运行</th><th>状态</th></tr></thead><tbody>${components.map(([name, value]) => `<tr><td>${escapeHTML(name)}</td><td>${escapeHTML(value.installedVersion || "未知")} / ${escapeHTML(value.runningVersion || "未知")}</td><td>${escapeHTML(value.evidenceStatus || "unknown")} / ${escapeHTML(value.health || "unknown")}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">旧盒或离线盒子尚未提供可核验的组件报告。</p>'}</details>
  </article>`;
}

function boxUpdateConfirmation(action) {
  const update = currentState.upgrades?.box;
  const deviceId = currentState.activeDeviceId;
  if (!update || update.deviceId !== deviceId || update.canUpgrade !== true) return;
  const plan = update.plan;
  if (action === "execute" && (!plan?.planId || !Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= Date.now())) return;
  if (action === "resume" && !update.operation?.allowedActions?.includes("resume")) return;
  const version = plan?.release?.payload?.version || update.candidate?.release?.payload?.version;
  marketConfirmation = {
    title: action === "resume" ? "继续盒子更新" : "确认更新盒子",
    detail: `${activeDeviceName()}${version ? `将更新至 v${version}` : "将按已确认的版本继续更新"}。更新期间盒子上的应用可能暂时不可用，不迁移或还原业务数据。${action === "resume" ? "将继续同一任务及固定版本。" : "确认后即使关闭万象，盒子仍会继续执行任务。"}`,
    verb: action === "resume" ? "继续更新" : "更新盒子", action: `updates.box.${action}`,
    input: action === "resume" ? { deviceId, operationId: update.operation.operationId, confirmed: true } : { deviceId, planId: plan.planId, confirmed: true },
    updateDeviceId: deviceId, updatePlanId: action === "execute" ? plan.planId : null,
    updateResumeOperationId: action === "resume" ? update.operation.operationId : null,
  };
  render(currentState);
}

function scheduleBoxUpdatePolling() {
  const update = currentState?.upgrades?.box;
  const operation = update?.operation;
  const active = page === "settings" && currentState?.route !== "auth" && currentState?.activeDeviceId === update?.deviceId && operation?.operationId && !["succeeded", "rolled_back", "failed", "needs_attention", "cancelled"].includes(operation.state);
  const key = active ? JSON.stringify([marketAccount, update.deviceId, operation.operationId]) : null;
  if (key !== boxUpdatePollKey) { clearTimeout(boxUpdatePollTimer); boxUpdatePollTimer = null; boxUpdatePollKey = key; boxUpdatePollError = null; }
  if (!key || boxUpdatePollTimer || boxUpdatePollRequest || boxUpdatePollError) return;
  boxUpdatePollTimer = setTimeout(async () => {
    boxUpdatePollTimer = null;
    if (key !== boxUpdatePollKey) return;
    if (busy) { scheduleBoxUpdatePolling(); return; }
    const request = { key };
    boxUpdatePollRequest = request;
    try {
      const response = await window.wanxClient.action("updates.box.status", { deviceId: update.deviceId, operationId: operation.operationId });
      if (key !== boxUpdatePollKey) return;
      if (!response.ok && response.code === "UPDATE_IN_PROGRESS") return;
      if (!response.ok) throw new Error(response.code);
      if (response.state) acceptRemoteState(response.state);
    } catch {
      if (key === boxUpdatePollKey) { boxUpdatePollError = "任务状态暂时无法读取，自动刷新已暂停。请点击“刷新任务状态”重试。"; render(currentState); }
    } finally {
      if (boxUpdatePollRequest === request) boxUpdatePollRequest = null;
      scheduleBoxUpdatePolling();
    }
  }, 5000);
}

function settingsView() {
  const startup = currentState.desktopStartup || { supported: false, enabled: false };
  return `<div class="app-layout" ${marketConfirmation ? "inert" : ""}>${shellHeader("设置")}<div class="page-content">
    <div class="page-heading"><h2>设置</h2><p class="muted">让万象在需要时，安静地为你准备好。</p></div>
    ${notice && !passwordEditing ? `<div class="notice ${codeSent ? "success" : "error"}" role="status">${escapeHTML(notice)}</div>` : ""}
    ${versionUpdatesView()}
    <section class="settings-panel"><div><h3>账号</h3><p class="muted">已登录万象平台。退出账号会断开盒子，万象仍在后台运行。</p></div><div class="settings-actions"><button class="button small" data-action="password-open" ${busy ? "disabled" : ""}>修改密码</button><button class="button small ${busyFor("auth.logout") ? "activity-button" : ""}" data-action="logout" aria-busy="${busyFor("auth.logout")}" ${busy ? "disabled" : ""}>${busyFor("auth.logout") ? activityLabel("正在退出…") : "退出当前账号"}</button></div></section>
    ${passwordEditing ? `<section class="password-panel"><h3>修改密码</h3><p class="muted">验证码将发送至当前账号${currentState.account?.maskedPhone ? `（${escapeHTML(currentState.account.maskedPhone)}）` : "绑定的手机号"}。修改后所有设备上的旧登录将失效，请重新登录。</p><form data-form="password-change" novalidate><label for="change-password">新密码</label><input id="change-password" name="password" type="password" required autocomplete="new-password" placeholder="设置 8–72 字节的新密码" />${passwordFields("change", "send-change-code", changeResendAt)}<div data-password-notice class="notice ${codeSent ? "success" : "error"}" role="status" ${notice ? "" : "hidden"}>${escapeHTML(notice)}</div><div class="settings-actions"><button type="button" class="button" data-action="password-cancel" ${busy ? "disabled" : ""}>取消</button><button type="submit" class="button primary" ${busy ? "disabled" : ""}>${busy ? busyRequest?.action === "auth.change-password" ? "正在修改…" : "处理中…" : "确认修改"}</button></div></form></section>` : ""}
    <section class="settings-panel"><div><h3>登录电脑时启动</h3><p class="muted ${busyFor("desktop.startup.set") ? "activity-status" : ""}" role="status">${busyFor("desktop.startup.set") ? activityLabel("正在保存设置…") : escapeHTML(startup.reason || (startup.supported ? startup.status === "requires-approval" ? "请在系统设置中允许登录项。" : "在菜单栏静默启动，随时打开应用。" : "安装正式应用后可设置开机启动。"))}</p></div><button class="switch" role="switch" aria-checked="${Boolean(startup.enabled)}" aria-label="登录电脑时启动" aria-busy="${busyFor("desktop.startup.set")}" data-action="startup-toggle" ${busy || !startup.supported ? "disabled" : ""}><span></span></button></section>
    <section class="settings-panel"><div><h3>关于万象</h3><p class="muted">半人马AI-万象 · CentaurAI-WanX</p></div><button class="button small" data-action="desktop-about">关于</button></section>
    <div class="settings-foot"><p class="muted">关闭窗口后继续后台运行。完全退出请在万象菜单中选择“退出万象”。</p></div>
  </div></div>${confirmationView()}`;
}

function resourceSize(value) {
  if (value == null) return "—";
  let amount = value, unit = 0;
  while (amount >= 1024 && unit < 4) { amount /= 1024; unit++; }
  return `${amount.toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}
function boxesView() {
  const devices = currentState.devices || [], ready = currentState.canLaunchApplications;
  const refreshing = busyRequest?.action === "devices.refresh";
  const metrics = window.wanxSpace?.overview?.();
  const storage = ready ? metrics?.wanxStorage : null;
  const publicIP = ready ? metrics?.network?.publicIp : null;
  const network = networkStatus();
  const status = currentState.recovery?.status === "failed" ? "自动重连未成功，请手动重连" : currentState.recovery?.status === "retrying" ? `正在自动重连（${currentState.recovery.attempt}/3）` : ready ? "连接正常" : currentState.connectionPhase === "recovering" ? "正在恢复连接" : currentState.connectionPhase === "connecting" ? "正在连接" : "尚未连接";
  return `<div class="app-layout" ${marketConfirmation ? "inert" : ""}>${shellHeader("盒子")}<div class="page-content space-page-content box-page-content">
    <div class="page-heading"><div><h2>盒子</h2><p class="muted">连接设备，查看状态，维护盒子上的服务。</p></div><div class="settings-actions"><button class="button small ${refreshing ? "activity-button" : ""}" data-action="refresh" aria-busy="${refreshing}" ${busy ? "disabled" : ""}>${refreshing ? '<span class="activity-spinner" aria-hidden="true"></span>正在刷新…' : "刷新设备"}</button><button class="button primary small" data-action="provisioning" ${busy ? "disabled" : ""}>＋ 添加盒子</button></div></div>
    ${pendingOpenView()}${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}
    <section class="box-overview" aria-label="当前盒子"><div class="box-overview-heading"><div class="box-identity"><img src="./assets/centaurai-mark.png" alt=""/><div><span class="box-eyebrow">当前使用的盒子</span><h3 class="current-device">${currentState.activeDeviceId ? escapeHTML(activeDeviceName()) : "尚未连接盒子"}</h3><p>${ready ? currentState.connection?.mode === "local" ? "本机万象 · 文件与服务运行在这台电脑上" : "万象网络 · 已建立盒子连接" : network.detail}</p><div class="box-addresses" aria-label="盒子 IP" title="由当前盒子查询的公网出口地址"><span>盒子 IP</span>${publicIP ? `<code>${escapeHTML(publicIP)}</code>` : `<span>${ready ? "暂未获取盒子 IP" : "连接后显示"}</span>`}</div></div></div><span class="box-status ${ready ? "ready" : ""}"><i class="status-dot ${ready ? "ready" : ""}"></i>${status}</span></div>
    <div class="box-resource-grid"><div><span>可用存储</span><strong>${resourceSize(metrics?.volume?.free)}</strong><small>总容量 ${resourceSize(metrics?.volume?.total)}</small></div><div><span>万象占用</span><strong>${storage && !storage.complete ? "≥ " : ""}${resourceSize(storage?.bytes)}</strong><small title="万象数据、应用与运行组件，含日志、缓存、历史版本和回收站；重叠文件仅计一次。按文件大小汇总，每 30 秒更新。">${storage ? storage.complete ? "数据、应用与运行组件" : "部分目录暂时无法读取" : ready ? "等待盒子返回完整统计" : "连接后显示实际状态"}</small></div><div><span>CPU 使用率</span><strong>${metrics?.cpu ? `${metrics.cpu.percent.toFixed(1)}%` : "—"}</strong><small>盒子当前负载</small></div><div><span>内存使用</span><strong>${metrics?.memory ? `${metrics.memory.percent.toFixed(1)}%` : "—"}</strong><small>${metrics?.memory ? `${resourceSize(metrics.memory.used)} / ${resourceSize(metrics.memory.total)}` : "连接后显示实际状态"}</small></div></div></section>
    ${maintenanceToolsView()}
    <section class="content-section" aria-label="设备管理"><div class="box-section-heading"><div><h3>已关联的盒子 <span class="count">${devices.length}</span></h3><p class="muted ${refreshing ? "activity-status" : ""}" role="status">${refreshing ? '<span class="activity-spinner" aria-hidden="true"></span>正在读取最新设备状态…' : "连接或切换盒子后，文件空间和应用将使用所选盒子。"}</p></div></div>${devices.length ? `<div class="box-device-grid">${devices.map(deviceCard).join("")}</div>` : `<div class="empty-state"><h3>还没有盒子</h3><p>发现附近的盒子，完成配网和账号绑定。</p><button class="button small" data-action="provisioning">添加盒子</button></div>`}</section>
    ${ownershipView()}
    ${supportView.render()}
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

function maintenanceToolsView() {
  const ready = currentState.canOpenDashboard;
  const tools = [
    ["terminal", "终端", "执行命令、查看日志与检查服务。", '<span aria-hidden="true">&gt;_</span>'],
    ["desktop", "远程桌面", "查看并操作盒子的桌面。", '<svg aria-hidden="true" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="26" height="18" rx="3"/><path d="M16 22v6M10 28h12"/></svg>'],
  ];
  return `<section class="content-section box-operations" aria-label="盒子运维工具"><div class="box-section-heading"><div><h3>运维工具</h3><p class="muted">${ready ? `操作当前盒子：${escapeHTML(activeDeviceName())}` : "请先连接一台盒子"}</p></div><span class="box-operations-note">独立窗口打开</span></div><div class="box-operations-grid">${tools.map(([tool, title, description, icon]) => { const opening = busyFor("maintenance.open") && busyRequest.tool === tool; return `<article class="box-operation"><div class="maintenance-icon box-operation-${tool}">${icon}</div><div class="box-operation-copy"><h4>${title}</h4><p>${description}</p></div><button class="button small ${tool === "terminal" ? "primary" : ""} ${opening ? "activity-button" : ""}" aria-busy="${opening}" data-action="maintenance-open" data-tool="${tool}" ${!ready || busy ? "disabled" : ""}>${opening ? activityLabel("正在打开…") : `打开${title}<span aria-hidden="true"> ↗</span>`}</button></article>`; }).join("")}</div><p class="box-operations-footnote">终端与远程桌面使用当前盒子连接；切换或断开后，相关窗口会自动关闭。</p></section>`;
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
  return { installing: "正在安装…", updating: "正在更新…", uninstalling: "正在卸载…", rolling_back: "正在恢复版本…", rollback: "正在恢复版本…", selecting: "正在选择版本…", "rolling-back": "正在恢复版本…", opening: "正在打开…", connecting: "正在连接盒子…", running: "已打开" }[operation.phase] || "";
}

function showOpenedStatus(applicationId) {
  const operation = { phase: "running" };
  localOperations.set(applicationId, operation);
  setTimeout(() => {
    if (localOperations.get(applicationId) === operation) {
      localOperations.delete(applicationId);
      render(currentState);
    }
  }, 4000);
}

function pendingOpenView() {
  const pending = currentState.ui?.pendingOpen;
  if (!pending) { pendingSelection = null; return ""; }
  const devices = (currentState.devices || []).filter(deviceCanConnect);
  if (pendingSelection?.id !== pending.id) pendingSelection = { id: pending.id, deviceId: pending.deviceId || currentState.ui?.lastDeviceId || devices[0]?.deviceId };
  if (!devices.some((device) => device.deviceId === pendingSelection.deviceId)) pendingSelection.deviceId = devices[0]?.deviceId;
  const application = storeApplication(pending.applicationId);
  const processing = ["connecting", "opening"].includes(pending.phase);
  const selectedReady = currentState.networkReady || devices.some(device => device.local && device.deviceId === pendingSelection.deviceId);
  const authorizing = !devices.length && currentState.devices?.some(device => device.accessState === "authorization_pending");
  return `<section class="pending-open" aria-label="连接盒子并打开应用" role="status"><div><h3>${processing ? pending.phase === "connecting" ? "正在连接盒子…" : "正在打开应用…" : "连接盒子并打开应用"}</h3><p class="muted">${escapeHTML(application?.name || "此应用")}需要一台盒子提供服务。</p></div>
    ${pending.error ? `<p class="inline-error">${escapeHTML(operationErrorMessage(pending.error))}</p>` : ""}
    ${authorizing ? `<p class="muted">正在同步盒子访问权限。${authorizationHint()}</p>` : ""}
    <div class="pending-open-actions">${devices.length ? `<select aria-label="用于打开应用的盒子" data-input="pending-device" ${processing ? "disabled" : ""}>${devices.map((device) => `<option value="${escapeHTML(device.deviceId)}" ${pendingSelection.deviceId === device.deviceId ? "selected" : ""}>${escapeHTML(device.name || device.displayName || "万象盒子")}</option>`).join("")}</select><button class="button primary small ${processing ? "activity-button" : ""}" data-action="pending-confirm" aria-busy="${processing}" ${processing || !selectedReady ? "disabled" : ""}>${processing ? activityLabel("处理中…") : "连接并打开"}</button>` : '<button class="button small" data-action="show-boxes">发现或管理盒子</button>'}<button class="text-button" data-action="pending-cancel">取消</button></div>
    ${!selectedReady ? `<p class="muted">${networkStatus().label}。<button class="text-button" data-action="show-settings">检查网络</button></p>` : ""}</section>`;
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
    MARKET_GRAY_ACCESS_DENIED: "此版本正在灰度测试，当前账号未获测试资格。请使用正式版本，或联系管理员加入测试。",
    MARKET_RELEASE_ACCESS_REQUIRED: "请更新万象并登录有测试资格的账号，再打开此应用。",
    MARKET_RELEASE_ACCESS_SIGNED_PACKAGE_REQUIRED: "此测试版本需要通过「应用」页提供的签名安装包安装。",
    MARKET_RELEASE_ACCESS_INVALID: "暂时无法确认此版本的使用资格，请保持联网后重试。",
    MARKET_RELEASE_ACCESS_EXPIRED: "此版本的使用许可已到期，请保持联网后重新打开应用。",
    MARKET_INCOMPATIBLE: "此版本不兼容当前系统或万象版本，请先更新万象。",
    MARKET_ALREADY: "当前已安装此版本，请刷新应用列表。",
    MARKET_DOWNGRADE: "本机版本较新，不会自动降级。",
    MARKET_BUSY: "此应用正在处理中，请稍后再试。",
    MARKET_NOT_CONFIGURED: "应用市场尚未配置完成，请联系管理员。",
    CLIENT_VERSION_INCOMPATIBLE: "请先在设置中更新万象，再安装或打开此应用。",
    BACKEND_CONTRACT_INCOMPATIBLE: "此应用需要更新盒端服务，请联系盒主更新后再试。",
    APPLICATION_RESOURCES_PENDING: "应用已安装。连接盒子后打开，万象会检查盒端准备状态。",
    APPLICATION_RESOURCES_NOT_READY: "盒端尚未完成应用准备，请保持盒子联网后重试。",
    APPLICATION_RESOURCE_ARTIFACT_REQUIRED: "请在「应用」中安装已发布版本，再准备盒端资源。",
    APPLICATION_PREPARATION_INVALID: "盒端准备结果无法核验，请更新盒端后重试。",
    APPLICATION_PREPARATION_UNAVAILABLE: "盒端应用准备服务暂不可用，请检查盒端服务后重试。",
    RESOURCE_SERVICE_NOT_CONFIGURED: "盒端应用准备服务尚未启用，请联系盒主或管理员检查盒端配置。",
    RESOURCE_EXPERT_START_FAILED: "应用所需专家未能启动，请联系盒主或管理员检查模型配置和专家运行状态后重试。",
    APP_ENTITLEMENT_REQUIRED: "此账号尚未获得应用使用权限，请联系管理员启用并授权。",
    RESOURCE_PRODUCT_PROFILE_UNSUPPORTED: "此应用暂不支持自动准备专家，请联系应用提供方更新应用。",
    RESOURCE_PREPARATION_BUSY: "盒子正在准备应用所需资源，请稍后重试。",
    RESOURCE_NOT_PREPARED: "应用所需资源尚未准备好，请保持盒子联网后重新打开应用。",
    RESOURCE_UPSTREAM_PERMISSION_DENIED: "当前账号无权准备此应用的专家，请联系盒主或管理员。",
    RESOURCE_USER_MODIFIED: "现有专家或技能包已被修改，万象已保留这些内容，请联系维护人员确认后再更新。",
    RESOURCE_MIGRATION_REQUIRED: "此应用需要升级盒端专家，请先完成专家数据迁移。现有专家和历史数据已保留。",
    RESOURCE_INSTANCE_OWNERSHIP_CHANGED: "此应用的专家归属已变化，请联系盒主确认访问权限。",
    EXPERT_VERSION_UNKNOWN: "无法确认现有助手是否适用。现有内容已保留，请联系维护人员检查。",
    EXPERT_NOT_READY: "此应用需要的助手尚未准备好，请联系盒主完成准备。",
    EXPERT_NOT_PREPARED: "此应用需要的助手尚未准备好，请联系盒主完成准备。",
    APP_AUTHORIZATION_UNVERIFIED: "应用使用权限尚未确认，请重新登录后重试，或联系盒主。",
    APPLICATION_DATA_COMPATIBILITY_UNKNOWN: "暂时无法确认此版本能否使用现有应用数据。请保留当前版本并联系应用提供方。",
    APPLICATION_DATA_SCHEMA_INCOMPATIBLE: "此版本无法读取现有应用数据。请保留当前数据并联系应用提供方恢复兼容版本。",
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
      backend_contract: "此应用需要更新盒端服务，请联系盒主更新后再试。",
      backend_evidence_stale: "盒子状态还未确认，请连接盒子并刷新后再试。",
      expert_not_ready: "此应用需要的助手尚未准备好，请联系盒主完成准备。",
      expert_version_unknown: "无法确认现有助手是否适用。现有内容已保留，请联系维护人员检查。",
      client_version: "请先在设置中更新万象，再安装此应用。",
      authorization_unverified: "应用使用权限尚未确认，请重新登录后重试，或联系盒主。",
      compatible_history_requires_recovery: "此盒子需要受支持的历史应用版本。请保留现有数据并联系应用提供方完成兼容恢复。",
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
  const bundled = window.wanxAppCatalog?.[item.applicationId];
  if (bundled) return `<img class="application-icon generated-app-icon" src="./${bundled.icon}" alt="" decoding="async" />`;
  // Other apps retain the catalog-provided HTTPS or host-provided local icon.
  const icon = item.iconURL || item.iconUrl;
  return typeof icon === "string" && /^(https:\/\/|file:\/\/)/.test(icon)
    ? `<img class="application-icon" src="${escapeHTML(icon)}" alt="" />`
    : `<div class="application-icon" aria-hidden="true">${escapeHTML(Array.from(item.name || "应")[0])}</div>`;
}

function applicationTone(item) {
  const id = item.applicationId || "";
  return id.includes("zhijun") ? "conversation" : id.includes("superadvisor") ? "council" : id.includes("dialogue") ? "perspectives" : id.includes("loop") ? "automation" : "creation";
}
function stagedInstallation(item) {
  return item.installationState === "pending" ? item : item.pendingInstallation;
}
function applicationPreparationStatus(item) {
  const staged = stagedInstallation(item);
  if (staged) {
    const description = item.installationState === "pending"
      ? "应用包已下载，等待完成盒端准备。"
      : `v${staged.version} 尚未启用，当前版本可继续使用。`;
    return `${description}${staged.resourcePreparation?.code ? marketErrorMessage({ code: staged.resourcePreparation.code }) : "连接盒子后重试。"}`;
  }
  return item.resourcePreparation?.status === "pending" ? "打开时将检查盒端专家和技能包。" : "";
}
function applicationActions(item, installed) {
  const candidate = marketCandidates.get(item.applicationId);
  const id = escapeHTML(item.applicationId);
  const operation = operationFor(item.applicationId);
  const status = operationMessage(operation);
  const disabled = operationBusy(item.applicationId) ? "disabled" : "";
  const active = installed && item.installationState !== "pending";
  const staged = stagedInstallation(item);
  const installing = ["installing", "updating"].includes(operation?.phase);
  const selecting = operation?.phase === "selecting";
  const opening = ["opening", "connecting"].includes(operation?.phase);
  return item.selectionRequired
    ? `<p class="muted">历史版本无法自动比较，请选择当前版本。</p><div class="version-choices">${item.versions.map(({ version }) => { const pending = selecting && operation.version === version; return `<button class="button small ${pending ? "activity-button" : ""}" data-action="applications-select-current" data-application-id="${id}" data-version="${escapeHTML(version)}" aria-busy="${pending}" ${disabled}>${pending ? activityLabel("正在选择…") : `使用 ${escapeHTML(version)}`}</button>`; }).join("")}</div>`
    : `<div class="application-actions">${candidate?.status === "available" ? `<button class="button ${active ? "" : "primary"} small ${installing ? "activity-button" : ""}" data-action="market-install" data-application-id="${id}" aria-busy="${installing}" ${disabled}>${installing ? activityLabel(status || "正在安装…") : staged ? active ? "重试更新" : "继续安装" : active ? "更新" : "安装"}</button>` : ""}${active ? `<button class="button primary small ${opening ? "activity-button" : ""}" data-action="applications-launch" data-application-id="${id}" aria-busy="${opening}" ${disabled}>${opening ? activityLabel(status || "正在打开…") : operationBusy(item.applicationId) ? status || "处理中…" : operation?.phase === "running" ? "已打开" : "打开"}</button>` : ""}</div>`;
}
function applicationManagement(item, installed) {
  const candidate = marketCandidates.get(item.applicationId);
  const availability = item.editorialOnly && !candidate ? "暂未提供可安装版本" : candidateLabel(candidate);
  const id = escapeHTML(item.applicationId);
  const previous = typeof item.previous === "string" ? item.previous : item.previous?.version;
  const disabled = operationBusy(item.applicationId) ? "disabled" : "";
  const active = installed && item.installationState !== "pending";
  const operation = operationFor(item.applicationId);
  const restoring = ["rolling_back", "rollback", "rolling-back"].includes(operation?.phase);
  const uninstalling = operation?.phase === "uninstalling";
  return `<div class="store-detail-body"><p class="store-full-description">${escapeHTML(item.description || "在你的盒子上使用 AI 服务。")}</p>${installed && item.version ? `<p class="muted">${active ? "当前版本" : "待安装版本"} v${escapeHTML(item.version)}</p>` : ""}<p class="market-status">${escapeHTML(availability)}</p>${candidateDetails(candidate)}${installed && !item.selectionRequired ? `<div class="market-actions">${active && previous ? `<button class="text-button ${restoring ? "activity-button" : ""}" data-action="market-rollback" data-application-id="${id}" aria-busy="${restoring}" ${disabled}>${restoring ? activityLabel("正在恢复…") : "恢复上一版本"}</button>` : ""}<button class="text-button danger-text ${uninstalling ? "activity-button" : ""}" data-action="market-uninstall" data-application-id="${id}" aria-busy="${uninstalling}" ${disabled}>${uninstalling ? activityLabel("正在卸载…") : "卸载"}</button></div>` : ""}${!candidate?.artifact && !candidate?.release?.notes && !installed ? '<p class="muted">暂无更多版本信息。</p>' : ""}</div>`;
}
function applicationCard(item, installed = true) {
  item = withMarketName(item);
  const candidate = marketCandidates.get(item.applicationId);
  const id = escapeHTML(item.applicationId);
  const operation = operationFor(item.applicationId);
  const status = operationMessage(operation);
  const preparation = applicationPreparationStatus(item);
  const actions = applicationActions(item, installed);
  return `<article class="application-card" data-application="${id}" data-tone="${applicationTone(item)}"><button class="store-icon-link" data-action="store-details" data-application-id="${id}" aria-label="了解${escapeHTML(item.name)}">${applicationIcon(item)}</button><div class="application-main">
    <div class="application-title"><h3><button class="store-title-link" data-action="store-details" data-application-id="${id}">${escapeHTML(item.name)}</button></h3></div>
    <p class="application-description">${escapeHTML(item.description || "在你的盒子上使用 AI 服务。")}</p>
    ${status || preparation ? `<p class="market-status ${operation?.error ? "inline-error" : ""}" role="status">${escapeHTML(status || preparation)}</p>` : ""}
    ${!installed && candidate?.status !== "available" ? `<p class="market-status" role="status">${escapeHTML(candidate ? candidateLabel(candidate) : marketLoading ? "正在检查可安装版本…" : "暂未提供可安装版本")}</p>` : ""}
    </div>${actions}
    <button class="store-detail-link" data-action="store-details" data-application-id="${id}">了解应用 <span aria-hidden="true">›</span></button>
    <details class="application-details" data-detail-id="${id}" ${expandedDetails.has(item.applicationId) ? "open" : ""}><summary>版本与管理${candidate?.status === "available" && installed ? '<span class="store-update-dot">可更新</span>' : ""}</summary>${applicationManagement(item, installed)}</details></article>`;
}
function discoverableApplications() {
  // Only the account's remote catalog determines which apps are discoverable.
  return [...new Map(marketItems.map(item => [item.applicationId, item])).values()];
}
function withMarketName(item) {
  const name = marketItems.find(entry => entry.applicationId === item.applicationId)?.name;
  // Admin owns display names; installed versions and signed manifests stay intact.
  return typeof name === "string" && name.trim() ? { ...item, name } : item;
}
function storeApplication(id) {
  const item = currentState.applications?.find(item => item.applicationId === id)
    || discoverableApplications().find(item => item.applicationId === id);
  if (item) return withMarketName(item);
  // Featured posters may open a bundled introduction without adding a market listing.
  const metadata = window.wanxAppCatalog?.[id];
  return metadata ? { applicationId: id, name: metadata.name,
    description: metadata.tagline || metadata.introduction, editorialOnly: true } : null;
}
function storeFeatures() {
  const slides = featuredApplicationIds.map(id => {
    const metadata = window.wanxAppCatalog?.[id];
    return { id, metadata: metadata && withMarketName({ ...metadata, applicationId: id }) };
  }).filter(item => item.metadata?.posters?.length);
  if (!slides.length) return "";
  // Keep markup stable: the carousel paints its own state without replacing focused controls.
  return `<section class="store-carousel" aria-label="应用精选" aria-roledescription="轮播" data-active="0">
    <div class="carousel-heading"><h3>为你精选</h3><div class="carousel-buttons"><button data-action="carousel-previous" aria-label="上一页推荐">‹</button><button data-action="carousel-toggle" aria-label="暂停轮播" aria-pressed="false">Ⅱ</button><button data-action="carousel-next" aria-label="下一页推荐">›</button></div></div>
    <div class="carousel-viewport"><div class="carousel-track">${slides.map(({ id, metadata }, index) => `<article class="carousel-slide" data-name="${escapeHTML(metadata.name)}" aria-roledescription="幻灯片" aria-label="${index + 1} / ${slides.length} · ${escapeHTML(metadata.name)}"><button class="carousel-poster" data-action="store-details" data-application-id="${id}" aria-label="了解${escapeHTML(metadata.name)}"><img class="carousel-artwork" src="./assets/posters/${metadata.posters[0][0]}" alt="${escapeHTML(metadata.name)}：${escapeHTML(metadata.tagline)}" decoding="async" draggable="false" /><span class="carousel-app-info">${applicationIcon({ applicationId: id, name: metadata.name })}<span class="carousel-copy"><strong>${escapeHTML(metadata.name)}</strong><span>${escapeHTML(metadata.tagline)}</span></span><span class="carousel-detail-label" aria-hidden="true">查看</span></span></button></article>`).join("")}</div></div>
    <div class="carousel-controls"><span class="carousel-caption">1 / ${Math.ceil(slides.length / 2)}</span><div class="carousel-dots" aria-label="选择推荐应用">${slides.filter((_, index) => index % 2 === 0).map(({ metadata }, index) => `<button class="carousel-dot" data-action="carousel-select" data-carousel-index="${index}" aria-label="第 ${index + 1} 页推荐：${escapeHTML(metadata.name)}与${escapeHTML(slides[index * 2 + 1]?.metadata.name || "")}" aria-current="${index === 0}"><span></span></button>`).join("")}</div></div></section>`;
}

function applicationDetailView() {
  const installedItem = currentState.applications?.find(item => item.applicationId === selectedApplicationId);
  const item = storeApplication(selectedApplicationId);
  const metadata = window.wanxAppCatalog?.[selectedApplicationId];
  const media = metadata?.posters || [];
  const candidate = marketCandidates.get(selectedApplicationId);
  const operation = operationFor(selectedApplicationId);
  const status = operationMessage(operation);
  const preparation = item && applicationPreparationStatus(item);
  const modal = posterPreview !== null && media[posterPreview];
  return `<div class="app-layout store-layout" ${marketConfirmation || modal ? "inert" : ""}>${shellHeader("应用介绍")}<div class="page-content app-detail-page">
    <button class="store-back" data-action="store-back"><span aria-hidden="true">‹</span> 应用</button>
    ${item ? `<section class="app-detail-hero" data-application-detail="${escapeHTML(item.applicationId)}" data-tone="${applicationTone(item)}">${applicationIcon(item)}<div class="app-detail-identity"><p class="app-detail-category">${escapeHTML(metadata?.category || "万象应用")}</p><h2 class="app-detail-title" tabindex="-1">${escapeHTML(item.name)}</h2><p class="app-detail-tagline">${escapeHTML(metadata?.tagline || item.description || "在你的盒子上使用 AI 服务。")}</p>${applicationActions(item, Boolean(installedItem))}${item.editorialOnly ? '<p class="muted app-editorial-notice">产品介绍 · 暂未提供可安装版本</p>' : ""}</div></section>
    ${pendingOpenView()}${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}${status || preparation ? `<p class="market-status ${operation?.error ? "inline-error" : ""}" role="status">${escapeHTML(status || preparation)}</p>` : ""}
    <dl class="app-detail-facts"><div><dt>分类</dt><dd>${escapeHTML(metadata?.category || "万象应用")}</dd></div><div><dt>${installedItem?.installationState === "pending" ? "待安装版本" : installedItem ? "当前版本" : "商店版本"}</dt><dd>${escapeHTML(installedItem?.version || candidate?.release?.version || item.version || "待获取")}</dd></div><div><dt>使用方式</dt><dd>连接万象盒子</dd></div><div><dt>安装状态</dt><dd>${installedItem ? installedItem.selectionRequired ? "待选择当前版本" : installedItem.installationState === "pending" ? "待完成盒端准备" : "已安装在此电脑" : "尚未安装"}</dd></div></dl>
    ${media.length ? `<section class="app-detail-section"><div class="section-heading"><h3>产品介绍</h3><span class="app-preview-hint">点击图片，放大查看</span></div><div class="app-poster-gallery ${media.length === 1 ? "single" : ""}" role="region" aria-label="${escapeHTML(item.name)}产品海报" tabindex="0">${media.map(([file, caption, context], index) => `<figure><button class="app-poster" data-action="poster-open" data-poster-index="${index}" aria-label="放大：${escapeHTML(caption)}"><img src="./assets/posters/${file}" alt="${escapeHTML(caption)}" decoding="async" /></button><figcaption><strong>${escapeHTML(caption)}</strong><span>${escapeHTML(context)}</span></figcaption></figure>`).join("")}</div></section>` : ""}
    <section class="app-detail-section app-detail-about"><p class="app-detail-category">为你的日常而设计</p><h3>关于${escapeHTML(item.name)}</h3><p>${escapeHTML(metadata?.introduction || item.description || "在你的盒子上使用 AI 服务。")}</p>${metadata ? `<div class="app-feature-grid">${metadata.features.map(([title, description], index) => `<article><span class="app-feature-number">0${index + 1}</span><h4>${escapeHTML(title)}</h4><p>${escapeHTML(description)}</p></article>`).join("")}</div>` : ""}</section>
    <section class="app-detail-section app-version-section"><h3>版本与管理</h3>${applicationManagement(item, Boolean(installedItem))}</section>
    <p class="app-detail-note">通过万象打开应用，使用已连接盒子提供的服务。云端能力的用量可在「积分」查看。</p>` : '<div class="empty-state"><h2>此应用当前不可用</h2><p>返回应用刷新后重试。</p></div>'}
  </div></div>${modal ? `<section class="poster-modal" role="dialog" aria-modal="true" aria-label="${escapeHTML(modal[1])}"><div class="poster-modal-card"><button class="button poster-close" data-action="poster-close" aria-label="关闭海报">关闭 <span aria-hidden="true">×</span></button><img src="./assets/posters/${modal[0]}" alt="${escapeHTML(modal[1])}" /><p>${escapeHTML(modal[1])}<small>${escapeHTML(modal[2])}</small></p></div></section>` : ""}${confirmationView()}`;
}

function confirmationView() {
  if (!marketConfirmation) return "";
  return `<section class="market-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="market-confirm-title" aria-describedby="market-confirm-detail"><div class="market-confirm-card"><h2 id="market-confirm-title">${escapeHTML(marketConfirmation.title)}</h2><p id="market-confirm-detail">${escapeHTML(marketConfirmation.detail)}</p><div class="market-actions"><button class="button" data-action="market-cancel">取消</button><button class="button primary" data-action="market-confirm">确认${escapeHTML(marketConfirmation.verb)}</button></div></div></section>`;
}

function applicationsView() {
  const applications = currentState.applications || [];
  const installed = new Set(applications.map((item) => item.applicationId));
  const pendingInstallations = applications.some((item) => item.installationState === "pending");
  const available = discoverableApplications().filter((item) => !installed.has(item.applicationId));
  const delivery = currentState.defaultApplications;
  const preparingDefaults = delivery?.status === "preparing";
  const defaultsPending = delivery?.status === "pending";
  return `<div class="app-layout store-layout" ${marketConfirmation ? "inert" : ""}>${shellHeader("应用")}<div class="page-content store-page">
    <div class="store-heading"><div><p class="store-eyebrow">为你的日常，打开更多可能</p><h2>应用</h2></div><div class="store-toolbar"><div class="connection-line"><span class="status-dot ${currentState.canLaunchApplications ? "ready" : ""}"></span><span>${currentState.canLaunchApplications ? `已连接 ${escapeHTML(activeDeviceName())}` : networkStatus().label}</span></div><button class="store-refresh ${marketLoading ? "activity-button" : ""}" data-action="market-refresh" aria-busy="${marketLoading}" ${marketLoading ? "disabled" : ""}>${marketLoading ? activityLabel("正在检查…") : "检查更新"}</button></div></div>
    ${pendingOpenView()}${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}
    ${preparingDefaults || defaultsPending ? `<div class="notice" role="status">${preparingDefaults ? "正在准备随盒应用，已安装的应用可以继续使用。" : "部分随盒应用尚未准备完成，联网后会自动重试。你也可以在下方应用介绍中查看安装条件。"}</div>` : ""}
    ${storeFeatures()}
    <section class="content-section store-installed" aria-label="我的应用"><div class="section-heading"><div><h3>我的应用 <span class="count">${applications.length}</span></h3><p>熟悉的工具，随时为你准备好。</p></div><span class="store-section-note">${pendingInstallations ? "部分应用待完成安装" : applications.length ? "已安装在此电脑" : "你的应用从这里开始"}</span></div>${applications.length ? `<div class="application-list">${applications.map((item) => applicationCard(item)).join("")}</div>` : '<div class="empty-state"><h3>安装你的第一个应用</h3><p>从下方选择应用，安装后即可在菜单栏打开。</p></div>'}</section>
    <section class="content-section market-section" aria-labelledby="market-heading" aria-busy="${marketLoading}"><div class="section-heading"><div><h3 id="market-heading">发现应用</h3><p>让 AI 融入你喜欢的事。</p></div></div>
    ${marketError ? `<div class="notice error" role="status">${escapeHTML(marketError)} <button class="text-button ${marketLoading ? "activity-button" : ""}" data-action="market-refresh" ${marketLoading ? "disabled" : ""}>${marketLoading ? activityLabel("正在刷新…") : "刷新重试"}</button></div>` : ""}
    ${available.length ? `<div class="application-list">${available.map((item) => applicationCard(item, false)).join("")}</div>` : `<p class="market-empty" role="status">${marketLoading ? "正在加载应用…" : marketError ? "稍后刷新即可重试。" : marketItems.length ? "商店中的应用均已安装。" : "暂无已上架应用。"}</p>`}</section>
    <div class="store-footnote"><span>Windows 与 macOS 通用</span><span aria-hidden="true">·</span><span>下载无需连接盒子，部分应用需连接盒子完成安装</span></div>
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

function deviceIsOwner(deviceId) {
  const device = currentState.devices?.find(item => item.deviceId === deviceId);
  return Boolean(device && (device.deviceRole || device.role) === "owner");
}

function discoveryCard(candidate) {
  const hint = candidate.displayIdentity;
  const deviceId = discoveryDeviceId(candidate);
  // Public Device Info is a display hint only. Account names are joined by the
  // complete device ID; selection always keeps the original opaque handle.
  const known = deviceId && currentState.devices?.find((device) => device.deviceId === deviceId);
  // A registry can itself fall back to the ID. Neither that value nor the
  // protocol's fixed product label is a user-visible box name.
  const boxName = (value) => {
    const name = typeof value === "string" ? value.trim() : "";
    return name && name !== deviceId && !/^CentaurAI\s+Box$/i.test(name) &&
      !/^CentaurOS-(?:Setup-[0-9a-f]*|[0-9a-f]{6}|[0-9a-f]{24})?$/i.test(name) &&
      !/^centauros-box-[0-9a-f]+$/i.test(name) ? name : "";
  };
  const knownName = boxName(known?.name) || boxName(known?.displayName);
  const metadata = deviceId && discoveryMetadata.get(deviceId)?.value;
  const registryName = boxName(metadata?.deviceName);
  const specificName = deviceId && boxName(hint?.displayName);
  const advertisedName = candidate.advertisedName || "";
  const scanning = discoveryView.selecting && !discoveryView.retained;
  const reading = !deviceId && scanning && candidate.nameSource === "advertisement";
  const resolvedName = knownName || registryName || specificName;
  const knownClaimed = ["owner", "member"].includes(known?.deviceRole) || ["owner", "member"].includes(known?.role);
  const owner = deviceIsOwner(deviceId);
  const wrongTarget = setupTargetDeviceId && deviceId && deviceId !== setupTargetDeviceId;
  const claimStatus = knownClaimed ? "claimed" : metadata?.claimStatus || "unknown";
  const claimLabel = { claimed: "已认领", unclaimed: "未认领", unknown: "认领状态待确认" }[claimStatus];
  const title = resolvedName || (reading ? "正在读取盒子名称…" : "未获取到盒子名称");
  const detail = !deviceId && scanning && !reading
    ? [advertisedName, "选择后核对设备身份"].filter(Boolean).join(" · ")
    : [advertisedName, !deviceId ? reading ? "正在读取盒子名称…" : "未读取到名称" : "", "蓝牙配网"].filter(Boolean).join(" · ");
  const identityDetail = deviceId && !resolvedName
    ? `<span>设备编号：${escapeHTML(deviceId)}（用于核对，不是名称）</span>` : "";
  return `<button class="device-card discovery-card" data-action="${owner || setupTargetDeviceId ? "select-candidate-wifi" : "select-candidate"}" data-candidate-id="${escapeHTML(candidate.candidateId)}" ${wrongTarget || bluetoothState.status !== "available" || discoveryView.selecting && discoveryView.retained ? "disabled" : ""}><strong>${escapeHTML(title)}</strong><span class="claim-badge claim-${claimStatus}">${claimLabel}</span>${identityDetail}<span>${escapeHTML(detail)}</span>${wrongTarget ? "<span>不是当前要配置的盒子</span>" : setupTargetDeviceId && !deviceId ? "<span>选择后核对是否为目标盒子</span>" : owner ? "<span>修改 Wi-Fi</span>" : ""}</button>`;
}

function bluetoothNotice() {
  const status = bluetoothState.status;
  if (status === "available") return "";
  const message = {
    checking: "正在检查电脑蓝牙状态…",
    unavailable: "电脑蓝牙尚不可用。请先开启蓝牙；若电脑没有蓝牙适配器，请连接适配器后重试。",
    "permission-denied": "万象尚未获得蓝牙访问权限。请在系统设置中允许万象访问蓝牙，再重新检查。",
    unsupported: "当前运行环境不支持蓝牙发现。请使用支持蓝牙的万象桌面客户端。",
    error: "暂时无法读取电脑蓝牙状态，请确认蓝牙已开启后重新检查。",
  }[status];
  return `<div class="notice bluetooth-notice" role="status"><p>${escapeHTML(message)}</p>${!["checking", "unsupported"].includes(status) ? `<div class="wizard-actions"><button class="button small" data-action="bluetooth-settings">${status === "permission-denied" ? "打开蓝牙权限设置" : "打开蓝牙设置"}</button><button class="text-button" data-action="bluetooth-refresh">重新检查</button></div>` : ""}</div>`;
}

function consoleClaimView() {
  const offline = consoleClaimFlow === "entry-wifi";
  const receipt = consoleClaimReceipt;
  const ready = receipt?.authorizationState === "ready";
  const blocked = receipt?.authorizationState === "blocked";
  return `<div class="app-layout">${shellHeader("添加盒子")}<div class="page-content">
    <div class="page-heading"><div><h2>使用认领码添加盒子</h2><p class="muted">${receipt ? "账号绑定已确认，盒子接收授权后即可连接。" : "已有认领码的盒子也可以先配网，再确认绑定。"}</p></div></div>
    <section class="wizard-card">
    ${receipt ? `<div role="status"><h3>${ready ? "盒子已就绪" : blocked ? "绑定已确认，授权暂不可用" : "绑定已确认，等待盒子授权"}</h3><p>设备 ID：${escapeHTML(receipt.deviceId)}</p><p>${ready ? "盒子已确认授权，可以返回盒子列表连接。" : blocked ? "请检查当前账号的设备权限，刷新状态后重试。" : "请保持盒子联网，等待盒子接收并确认授权后刷新状态。"}</p></div>
      <div class="wizard-actions"><button class="button" data-action="back-devices">返回盒子</button>${!ready ? `<button class="button primary" data-action="console-claim-refresh" ${busy ? "disabled" : ""}>${busyFor("devices.claim-status") ? "正在刷新…" : "刷新授权状态"}</button>` : '<button class="button primary" data-action="refresh">完成</button>'}</div>` : `
      <div class="wizard-actions"><button class="button ${!offline ? "primary" : ""}" data-action="console-claim-online" aria-pressed="${!offline}" ${busy ? "disabled" : ""}>盒子已联网</button><button class="button ${offline ? "primary" : ""}" data-action="console-claim-offline" aria-pressed="${offline}" ${busy ? "disabled" : ""}>需要先配网</button></div>
      <p>${offline ? "输入认领码以验证配网权限，然后发现并确认盒子、连接 Wi-Fi。配网成功后，还需点击“确认绑定到当前账号”。" : "输入盒子控制台或机身标签上的认领码，确认后绑定到当前账号。"}</p>
      <form data-form="console-claim"><label for="console-claim-code">盒子认领码</label><input id="console-claim-code" name="claimCode" required maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="输入 10 或 20 位认领码" /><button class="button primary" type="submit" ${busy ? "disabled" : ""}>${busyFor("devices.claim") ? "正在确认绑定…" : offline ? "下一步：发现盒子" : "确认绑定到当前账号"}</button></form>
      <div class="wizard-actions"><button class="button" data-action="back-devices">返回盒子</button><button class="text-button" data-action="console-claim-without-code" ${busy ? "disabled" : ""}>没有认领码，使用蓝牙认领</button></div>`}
      ${consoleClaimNotice ? `<p role="status">${escapeHTML(consoleClaimNotice)}</p>` : ""}${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}
    </section></div></div>`;
}

function provisioningView() {
  if (consoleClaimReceipt || ["entry-online", "entry-wifi"].includes(consoleClaimFlow)) return consoleClaimView();
  const codeWifi = consoleClaimFlow === "wifi" || setupState.mode === "console";
  const wifiOnly = Boolean(setupTargetDeviceId) || setupState.mode === "wifi" || setupRequest?.mode === "wifi";
  const targetDevice = currentState.devices?.find(device => device.deviceId === setupTargetDeviceId);
  const targetLabel = targetDevice?.name || targetDevice?.displayName || setupTargetDeviceId;
  const starting = setupRequest?.action === "provisioning.start";
  const cancelling = setupRequest?.action === "provisioning.cancel";
  const refreshing = setupRequest?.action === "provisioning.refresh";
  const cancelButton = `<button class="button danger" data-action="cancel-provisioning" aria-busy="${cancelling}" ${cancelling ? "disabled" : ""}>${cancelling ? "正在取消…" : "取消"}</button>`;
  // waitingCloud describes polling, not an ownership commit. The device may
  // still owe its proof even though the account proof has been submitted.
  const initializing = setupState.claimState === "deviceAckPending";
  const cloudStage = initializing ? "initialize" : "claim";
  const cloudCopy = {
    waitingAppProof: "正在等待账号认领证明，认领尚未完成。",
    waitingDeviceProof: "正在等待盒子提交认领证明，认领尚未完成。请保持盒子联网后刷新。",
    ownershipCommitted: "账号绑定已确认，正在准备盒端授权。",
    projectionPending: "账号绑定已确认，正在同步访问权限。",
    deviceAckPending: "账号绑定已确认，正在等待盒子接收并确认授权。",
  }[setupState.claimState] || "认领尚未确认完成，请刷新认领状态。";
  const stagesByState = {
    idle: "discover", previewReady: "identity", awaitingWifi: "network",
    awaitingOwnershipConfirmation: "claim", awaitingCodeClaim: "claim", submittingAppProof: "claim",
    verifyingLocalDevice: "identity", establishingSecureChannel: "identity", provisioningWifi: "network", waitingCloud: cloudStage, attentionRequired: cloudStage,
  };
  const failed = ["terminalError", "restartRequired"].includes(setupState.state);
  const provisioning = {
    phase: starting || cancelling ? "running" : failed ? "failed" : setupState.state === "completed" ? "ready" :
      ["verifyingLocalDevice", "establishingSecureChannel", "submittingAppProof", "provisioningWifi", "waitingCloud"].includes(setupState.state) ? "running" : "idle",
    stage: starting ? "identity" : stagesByState[setupState.state],
    error: { message: setupErrorMessage(setupState.errorCode) },
  };
  const running = provisioning.phase === "running";
  const preview = setupState.preview || setupState.compatiblePreview;
  const ownershipBlock = !wifiOnly && ({ owned_self: "DEVICE_ALREADY_OWNED", owned_other: "DEVICE_OWNED_BY_OTHER",
    legacy_bound: "LEGACY_BINDING_REVIEW_REQUIRED", history_review: "CLAIM_HISTORY_REVIEW_REQUIRED",
    reset_pending: "DEVICE_RESET_PENDING" })[setupState.ownershipState];
  const previewBlocked = setupState.claimStatusError || ownershipBlock || (preview?.cloud_enrollment_status === "not_enrolled" ? "DEVICE_NOT_ENROLLED" :
    !wifiOnly && preview?.pairing_mode_remaining_seconds === 0 ? "PAIRING_MODE_CLOSED" : null);
  const setupPhase = setupState.state || "idle";
  const stages = Object.entries(stageLabels).filter(([key]) => !wifiOnly || !["claim", "initialize"].includes(key));
  const setupCopy = starting ? (setupState.connectionAttempt === 2 ? "蓝牙连接暂未成功，正在自动重连…" : "正在通过蓝牙读取盒子身份，请稍候。") : cancelling ? "正在停止本次配网，请稍候。" : {
    idle: wifiOnly ? "让目标盒子保持通电并靠近电脑，扫描后确认设备身份，再选择 Wi-Fi。电脑需联网以验证主人权限，盒子可以处于离线状态。" : "让盒子保持通电，点击扫描并选择附近的盒子。已认领的盒子也可从盒子卡片的“配置网络”入口修改 Wi-Fi。",
    attentionRequired: cloudCopy,
    previewReady: previewBlocked ? setupErrorMessage(previewBlocked) : "请核对设备 ID、型号和身份指纹，然后确认。",
    verifyingLocalDevice: codeWifi ? "正在验证设备身份和认领码配网权限…" : wifiOnly ? "正在验证设备身份和主人权限…" : "正在验证设备身份…",
    establishingSecureChannel: "正在建立加密连接…",
    awaitingWifi: setupState.sessionRenewed ? "安全会话已自动更新，请重新选择网络并确认。上次提交不会自动重复。" : wifiOnly ? "主人权限已验证，请选择新的 Wi-Fi。认领关系和盒子数据将保留。" : "设备身份已验证，请选择盒子要连接的 Wi-Fi。",
    awaitingOwnershipConfirmation: "设备已准备联网，请确认绑定到当前账号。",
    awaitingCodeClaim: "盒子已连接 Wi-Fi。请确认使用认领码，将此盒子绑定到当前账号。",
    submittingAppProof: "正在提交账号绑定证明…",
    provisioningWifi: "正在通过加密通道配置 Wi‑Fi…",
    waitingCloud: cloudCopy,
    completed: wifiOnly ? "Wi-Fi 配置成功，认领关系和盒子数据已保留。" : "设备已完成联网和账号绑定。",
    cancelled: "本次配网已取消。",
  }[setupPhase] || "让盒子保持通电并靠近电脑，然后开始扫描。";
  const previewBlock = preview ? `<dl class="setup-preview"><dt>设备名称</dt><dd>${escapeHTML(preview.display_name)}</dd><dt>设备 ID</dt><dd>${escapeHTML(preview.device_id)}</dd><dt>型号</dt><dd>${escapeHTML(preview.model)}</dd><dt>身份公钥指纹</dt><dd>${escapeHTML(preview.identity_public_key_sha256)}</dd></dl>` : "";
  const { candidates, selecting, retained } = discoveryView;
  const discoveryBlock = selecting || retained ? `<div class="discovery-list"><p>${retained ? "扫描已结束，本轮结果保留 2 分钟。请选择要配置的盒子：" : "选择要配置的盒子："}</p>${candidates.length ? candidates.map(candidate => discoveryCard(candidate)).join("") : "<p>正在等待附近的盒子，请让盒子保持通电并靠近电脑。</p>"}</div>` : "";
  const controls = setupPhase === "previewReady"
    ? `<button class="button primary" data-action="provisioning-confirm" ${busy || previewBlocked ? "disabled" : ""}>${previewBlocked ? (wifiOnly ? "暂不能配置网络" : "暂不能认领") : "确认设备身份"}</button>`
    : setupPhase === "awaitingWifi"
      ? `<form class="setup-wifi" data-form="wifi"><div class="wifi-picker" data-wifi-list><label>盒子附近的 Wi-Fi<select data-input="wifi-network" required>${wifiOptions()}</select></label><button class="button small" type="button" data-action="wifi-refresh">刷新列表</button></div><p class="hint wifi-status" data-wifi-status role="status" aria-live="polite"></p><button class="text-button wifi-mode" type="button" data-action="wifi-manual">隐藏网络 / 手动添加</button><label hidden>Wi‑Fi 名称<input name="ssid" required maxlength="32" autocomplete="off" /></label><label hidden>安全类型<select name="security"><option value="wpa_personal">WPA/WPA2 个人网络</option><option value="open">开放网络</option></select></label><label class="check" hidden><input name="hidden" type="checkbox" />隐藏网络</label><label class="wifi-password">密码<span class="password-field"><input name="password" type="password" maxlength="128" autocomplete="off" /><button type="button" class="password-toggle" data-action="wifi-password-toggle" aria-label="显示密码" aria-pressed="false" title="显示密码"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/><path data-password-slash d="M4 4l16 16" hidden /></svg></button></span></label><button class="button primary" type="submit" ${busy ? "disabled" : ""}>${wifiOnly || codeWifi ? "连接 Wi-Fi" : "继续绑定账号"}</button></form>`
      : codeWifi && setupPhase === "awaitingCodeClaim"
        ? `<button class="button primary" data-action="console-claim-confirm" ${busy ? "disabled" : ""}>${busyFor("provisioning.code-claim") ? "正在确认绑定…" : "确认绑定到当前账号"}</button>`
      : !wifiOnly && setupPhase === "awaitingOwnershipConfirmation"
        ? `<button class="button primary" data-action="provisioning-owner" ${busy ? "disabled" : ""}>确认绑定到当前账号</button>`
        : "";
  return `
    <div class="app-layout">
      ${shellHeader(wifiOnly ? "配置网络" : "添加盒子")}<div class="page-content">
      <div class="page-heading"><div><h2>${wifiOnly ? "配置网络" : codeWifi ? "使用认领码：先配置网络" : "添加盒子"}</h2><p class="muted">${wifiOnly ? "通过蓝牙修改 Wi-Fi，保留认领关系和全部业务数据。" : "新盒子可配网并认领；已认领的盒子可由主人修改 Wi-Fi。"}</p>${setupTargetDeviceId ? `<p>正在配置：<strong>${escapeHTML(targetLabel)}</strong></p><p class="muted">设备编号：${escapeHTML(setupTargetDeviceId)}</p>` : ""}</div></div>
      <section class="wizard-card"><div class="wizard-steps">${stages.map(([key, label], index) => { const active = provisioning.stage === key; const done = provisioning.phase === "ready" || stages.findIndex(([name]) => name === provisioning.stage) > index; return `<div class="wizard-step ${active ? "active" : ""} ${done ? "done" : ""}"><span>${done ? "✓" : index + 1}</span><label>${label}</label></div>`; }).join("")}</div>
        <div class="wizard-copy"><p class="eyebrow">${running ? "正在处理" : provisioning.phase === "failed" ? "接入未完成" : "设备配置"}</p><h3>${starting ? "正在读取设备身份…" : cancelling ? "正在取消配网…" : running ? escapeHTML(stageLabels[provisioning.stage] || "处理中") : setupPhase === "idle" ? "发现附近的万象盒子" : "配置设备"}</h3><p>${provisioning.phase === "failed" ? escapeHTML(provisioning.error?.message || "本次接入失败") : escapeHTML(setupCopy)}</p>${!wifiOnly && !codeWifi && ["idle", "cancelled"].includes(setupPhase) ? `<div class="wizard-actions"><button class="button" data-action="console-claim-online" ${busy ? "disabled" : ""}>已有认领码，盒子已联网</button><button class="button" data-action="console-claim-offline" ${busy ? "disabled" : ""}>已有认领码，需要先配网</button></div><p class="muted">没有认领码？继续扫描，通过蓝牙验证身份后配网和绑定。</p>` : ""}${bluetoothNotice()}${discoveryBlock}${previewBlock}${controls}</div>
        <div class="wizard-actions">${running ? `<button class="button" disabled>返回盒子</button>${cancelButton}` : `<button class="button" data-action="back-devices">返回盒子</button>${["idle", "cancelled"].includes(setupPhase) || provisioning.phase === "failed" ? `<button class="button primary scan-button" data-action="start-provisioning" aria-busy="${selecting}" ${busy || !setupReady || bluetoothState.status !== "available" || selecting ? "disabled" : ""}>${selecting ? '<span class="scan-spinner" aria-hidden="true"></span><span>正在扫描…</span>' : provisioning.phase === "failed" || retained ? "重新扫描" : "开始扫描盒子"}</button>` : setupPhase === "completed" ? '<button class="button primary" data-action="refresh">完成</button>' : cancelButton}</div>`}
        ${setupPhase === "attentionRequired" ? `<button class="button" data-action="provisioning-refresh" aria-busy="${refreshing}" ${busy ? "disabled" : ""}>${refreshing ? "正在刷新…" : initializing ? "刷新授权状态" : "刷新认领状态"}</button>` : ""}
        ${codeWifi && failed ? `<button class="text-button" data-action="console-claim-edit" ${busy ? "disabled" : ""}>重新输入认领码</button>` : ""}
        ${notice ? `<div class="notice error">${escapeHTML(notice)}</div>` : ""}
        ${!setupReady ? '<p class="hint">正在准备蓝牙配网服务…</p>' : ""}
      </section></div>
    </div>`;
}

function authBusyLabel() {
  return {
    "auth.login": "正在登录…",
    "auth.register": "正在创建账号…",
    "auth.reset-password": "正在重置密码…",
  }[busyRequest?.action] || "处理中…";
}

// State broadcasts must not detach the pressed control before Chromium emits click.
function releaseInteraction() {
  clearTimeout(interactionTimer);
  activeInteraction = false;
}
function finishInteraction() {
  clearTimeout(interactionTimer);
  interactionTimer = setTimeout(() => { releaseInteraction(); if (currentState) render(currentState); }, 0);
}
app.addEventListener("pointerdown", event => {
  if (!event.target.closest?.('button, input, select, textarea, summary, a')) return;
  clearTimeout(interactionTimer);
  activeInteraction = true;
});
window.addEventListener?.("pointerup", finishInteraction);
window.addEventListener?.("pointercancel", finishInteraction);
window.addEventListener?.("keyup", finishInteraction);
window.addEventListener?.("blur", finishInteraction);

async function fillRememberedLogin(form) {
  if (!form?.elements) return;
  form.dataset.rememberLoad = "pending";
  const edited = () => { form.dataset.edited = "true"; };
  form.addEventListener("input", edited, { once: true });
  form.addEventListener("change", edited, { once: true });
  try {
    const saved = await window.wanxClient.getRememberedLogin();
    if (app.querySelector('[data-form="auth"]') !== form) return;
    if (busy) { delete form.dataset.rememberLoad; return; }
    form.dataset.rememberLoad = "done";
    if (form.dataset.edited) return;
    form.elements.remember.checked = saved.remember;
    if (saved.phone && saved.password) {
      form.elements.username.value = saved.phone;
      form.elements.password.value = saved.password;
      authUsername = saved.phone;
    }
  } catch (error) {
    form.dataset.rememberLoad = "done";
    if (app.querySelector('[data-form="auth"]') !== form) return;
    notice = operationErrorMessage(error);
    render(currentState);
  }
}

// Keep the credits dialog, focused input and decoded QR image mounted while
// polling changes text or attributes elsewhere on the page.
function updateCreditsDOM(current, incoming) {
  const previous = Array.from(current.childNodes);
  const next = Array.from(incoming.childNodes);
  for (let index = 0; index < Math.max(previous.length, next.length); index++) {
    const oldNode = previous[index], newNode = next[index];
    if (!newNode) { oldNode.remove(); continue; }
    if (!oldNode) { current.appendChild(newNode.cloneNode(true)); continue; }
    if (oldNode.nodeType !== newNode.nodeType || oldNode.nodeName !== newNode.nodeName) {
      oldNode.replaceWith(newNode.cloneNode(true)); continue;
    }
    if (oldNode.nodeType !== 1) {
      if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
      continue;
    }
    for (const attribute of Array.from(oldNode.attributes)) {
      if (!newNode.hasAttribute(attribute.name)) oldNode.removeAttribute(attribute.name);
    }
    for (const attribute of newNode.attributes) {
      if (oldNode.getAttribute(attribute.name) !== attribute.value) oldNode.setAttribute(attribute.name, attribute.value);
    }
    if (oldNode.tagName === 'INPUT' && oldNode.value !== newNode.value) oldNode.value = newNode.value;
    updateCreditsDOM(oldNode, newNode);
  }
}

function render(state) {
  const auth = state.route === "auth" || state.phase === "signed_out" || state.phase === "authenticating";
  const previousAuth = app.querySelector?.('[data-form="auth"]');
  if (auth && previousAuth?.elements) authUsername = previousAuth.elements.username.value.trim();
  currentState = state;
  window.wanxSpace?.activate(!auth && ["space", "boxes"].includes(page), page === "space");
  supportView.sync(auth || state.account?.phase !== "authenticated" ? null : JSON.stringify([state.account?.accountId, state.account?.clientId]), state.devices || []);
  supportView.visible(!auth && page === "boxes");
  scheduleBoxUpdatePolling();
  if (activeInteraction || window.wanxSpace?.isSelecting?.() || window.wanxSpace?.isDragging?.()) return;
  if (!auth && page === "space" && window.wanxSpace?.retainEditor?.()) return;
  const markup = auth ? authView() : page === "provisioning" ? provisioningView()
    : page === "space" ? `<div class="app-layout space-app-layout">${shellHeader("空间")}<div class="page-content space-page-content space-files-page">${window.wanxSpace?.view() || ""}</div></div>`
    : page === "application-detail" ? applicationDetailView() : page === "profile" ? profileView() : page === "credits" ? `<div class="app-layout"><div ${creditsView.isOpen() ? "inert" : ""}>${shellHeader("积分")}</div>${creditsView.render()}</div>` : page === "boxes" ? boxesView() : page === "settings" ? settingsView() : applicationsView();
  if (markup === renderedMarkup) { syncFormState(); storeCarousel.mount(app.querySelector?.(".store-carousel"), !auth && page === "applications" && !marketConfirmation && !profileMenuOpen); return; }
  renderedMarkup = markup;
  // Reuse the actual Wi-Fi form when setup updates. This preserves typed secrets,
  // selection and focus; network polling does not rebuild active setup forms.
  const wifiForm = page === "provisioning" && setupState.state === "awaitingWifi" ? app.querySelector?.('[data-form="wifi"]') : null;
  const authForm = auth && previousAuth?.dataset.mode === authMode ? previousAuth : null;
  const transferForm = !auth && page === "boxes" && transferDeviceId && currentState.devices?.some(item => item.deviceId === transferDeviceId && (item.deviceRole === "owner" || item.role === "owner")) ? app.querySelector?.(`[data-form="transfer"][data-device-id="${transferDeviceId}"]`) : null;
  // Keep the active scan indicator spinning across discovery and account updates.
  const scanButton = !auth && page === "provisioning" && discoveryView.selecting
    ? app.querySelector?.('[data-action="start-provisioning"][aria-busy="true"]') : null;
  const scanAnimations = new Map(scanButton?.querySelector('.scan-spinner').getAnimations().map(animation => [animation.animationName, animation.currentTime]));
  const passwordForm = !auth && page === "settings" && passwordEditing ? app.querySelector?.('[data-form="password-change"]') : null;
  const profileForm = !auth && page === "profile" ? app.querySelector?.('[data-form="profile"]') : null;
  const claimForm = !auth && page === "provisioning" && !consoleClaimReceipt && ["entry-online", "entry-wifi"].includes(consoleClaimFlow) ? app.querySelector?.('[data-form="console-claim"]') : null;
  const retainedForm = wifiForm || authForm || transferForm || passwordForm || profileForm || claimForm;
  const focused = retainedForm?.contains(document.activeElement) ? document.activeElement : null;
  const walletDialog = app.querySelector?.('.wallet-purchase-dialog');
  // Detached dialog nodes lose their scroll offsets when innerHTML is replaced.
  const walletScroll = walletDialog ? { top: walletDialog.scrollTop, left: walletDialog.scrollLeft } : null;
  const walletFocus = walletDialog?.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
  const walletInput = walletDialog && document.activeElement?.id === 'wallet-custom-amount' ? document.activeElement : null;
  const walletSelection = walletInput ? [walletInput.selectionStart, walletInput.selectionEnd] : null;
  const scroller = document.scrollingElement;
  const scroll = (retainedForm || walletDialog) && scroller ? { top: scroller.scrollTop, left: scroller.scrollLeft } : null;
  const spaceList = page === "space" ? app.querySelector?.(".space-file-list") : null;
  const spacePosition = spaceList ? { key: spaceList.dataset.location, top: spaceList.scrollTop } : null;
  const spaceFocus = spaceList?.contains?.(document.activeElement) ? document.activeElement.closest?.("[data-entry-id]")?.dataset.entryId || "" : null;
  const spaceSearch = page === "space" && document.activeElement?.id === "space-search" ? document.activeElement : null;
  const searchSelection = spaceSearch ? [spaceSearch.selectionStart, spaceSearch.selectionEnd] : null;
  if (!auth && page === 'credits' && app.querySelector?.('.credits-page')) {
    const template = document.createElement('template');
    template.innerHTML = markup;
    updateCreditsDOM(app, template.content);
  } else app.innerHTML = markup;
  if (spacePosition) {
    const replacement = app.querySelector?.(".space-file-list");
    if (replacement?.dataset.location === spacePosition.key) {
      // Keep row nodes during selection/progress refreshes so a double-click
      // still targets the same file and the browser retains its scroll position.
      const oldRows = Array.from(spaceList.querySelectorAll?.(".space-file-row") || []);
      const nextRows = Array.from(replacement.querySelectorAll?.(".space-file-row") || []);
      if (oldRows.length && oldRows.length === nextRows.length && oldRows.every((row, index) => row.dataset.entryId === nextRows[index].dataset.entryId && row.innerHTML === nextRows[index].innerHTML)) {
        for (let index = 0; index < oldRows.length; index++) {
          const row = oldRows[index], next = nextRows[index];
          row.className = next.className;
          row.setAttribute("aria-selected", next.getAttribute("aria-selected"));
          row.tabIndex = next.tabIndex;
        }
        spaceList.setAttribute("aria-busy", replacement.getAttribute("aria-busy"));
        replacement.replaceWith(spaceList);
        spaceList.scrollTop = spacePosition.top;
      } else replacement.scrollTop = spacePosition.top;
    }
  }
  if (spaceSearch) {
    const replacement = app.querySelector?.("#space-search");
    replacement?.focus({ preventScroll: true });
    if (searchSelection[0] != null) replacement?.setSelectionRange?.(...searchSelection);
  }
  if (spaceFocus !== null) {
    const list = app.querySelector?.(".space-file-list");
    (list?.querySelector?.(`[data-entry-id="${spaceFocus}"]`) || list)?.focus?.({ preventScroll: true });
  }
  storeCarousel.mount(app.querySelector?.(".store-carousel"), !auth && page === "applications" && !marketConfirmation && !profileMenuOpen);
  if (scanButton) {
    app.querySelector?.('[data-action="start-provisioning"][aria-busy="true"]')?.replaceWith(scanButton);
    for (const animation of scanButton.querySelector('.scan-spinner').getAnimations()) {
      animation.currentTime = scanAnimations.get(animation.animationName) ?? 0;
    }
  }
  if (retainedForm) {
    const formName = wifiForm ? "wifi" : transferForm ? "transfer" : passwordForm ? "password-change" : profileForm ? "profile" : claimForm ? "console-claim" : "auth";
    app.querySelector?.(`[data-form="${formName}"]`)?.replaceWith(retainedForm);
    const submit = retainedForm.querySelector('button[type="submit"]');
    if (submit) {
      submit.disabled = busy;
      const pending = authForm ? busy && ["auth.login", "auth.register", "auth.reset-password"].includes(busyRequest?.action)
        : passwordForm ? busyFor("auth.change-password") : profileForm ? busyFor("profile.save") : false;
      submit.classList.toggle("activity-button", pending);
      submit.setAttribute("aria-busy", String(pending));
      if (authForm) submit.innerHTML = pending ? activityLabel(authBusyLabel()) : busy ? authBusyLabel() : authSubmitLabel();
      if (passwordForm) submit.innerHTML = pending ? activityLabel("正在修改…") : busy ? "处理中…" : "确认修改";
      if (claimForm) submit.textContent = busyFor("devices.claim") ? "正在确认绑定…" : consoleClaimFlow === "entry-wifi" ? "下一步：发现盒子" : "确认绑定到当前账号";
      if (profileForm) submit.innerHTML = pending ? activityLabel("正在保存…") : "保存资料";
    }
    focused?.focus({ preventScroll: true });
  }
  const nextWalletDialog = app.querySelector?.('.wallet-purchase-dialog');
  if (nextWalletDialog) {
    const buttons = Array.from(nextWalletDialog.querySelectorAll('button:not(:disabled)'));
    const previous = walletInput ? nextWalletDialog.querySelector('#wallet-custom-amount:not(:disabled)')
      : buttons.find(button => button.dataset.action === walletFocus?.action && button.dataset.amount === walletFocus?.amount && button.dataset.channel === walletFocus?.channel);
    if (!nextWalletDialog.contains(document.activeElement) || document.activeElement.disabled) {
      (previous || buttons.find(button => button.getAttribute('aria-pressed') === 'true') || buttons.find(button => button.dataset.action === 'credits-buy') || nextWalletDialog).focus({ preventScroll: true });
    }
    if (walletSelection && previous) previous.setSelectionRange(...walletSelection);
    if (walletScroll) {
      nextWalletDialog.scrollTop = walletScroll.top;
      nextWalletDialog.scrollLeft = walletScroll.left;
    }
  } else if (walletDialog && page === 'credits' && !auth) {
    app.querySelector?.('[data-action="credits-open"]')?.focus({ preventScroll: true });
  }
  syncFormState();
  // Reattaching a focused form must not pull the user back after they scroll away.
  if (scroll) {
    scroller.scrollTop = scroll.top;
    scroller.scrollLeft = scroll.left;
  }
  if (marketConfirmation) app.querySelector?.('[data-action="market-cancel"]')?.focus();
  if (page === "space") window.wanxSpace?.mounted?.();
  const pendingPanel = app.querySelector?.(".pending-open");
  const pendingId = pendingPanel ? currentState.ui?.pendingOpen?.id : null;
  // Reveal each new request once; background updates must not pull the user
  // back after they choose a box or scroll elsewhere.
  if (pendingId && pendingId !== revealedPendingOpenId) {
    pendingPanel.style.scrollMarginTop = `${(app.querySelector?.(".topbar")?.offsetHeight || 0) + 16}px`;
    pendingPanel.scrollIntoView?.({ block: "start", behavior: "instant" });
  }
  revealedPendingOpenId = pendingId;
}

function syncFormState() {
  if (authMode === "login") {
    const form = app.querySelector?.('[data-form="auth"]');
    if (form?.elements?.remember) form.elements.remember.disabled = busy;
    if (!busy && !form?.dataset.rememberLoad) void fillRememberedLogin(form);
  }
  updateResendButton();
  updatePasswordCodeButtons();
  const authNotice = app.querySelector?.('[data-form="auth"]')?.querySelector('[data-auth-notice]');
  if (authNotice) {
    authNotice.textContent = notice || "";
    authNotice.hidden = !notice;
    authNotice.className = `notice ${codeSent ? "success" : "error"}`;
  }
  const passwordNotice = app.querySelector?.('[data-form="password-change"]')?.querySelector('[data-password-notice]');
  if (passwordNotice) {
    passwordNotice.textContent = notice || "";
    passwordNotice.hidden = !notice;
    passwordNotice.className = `notice ${codeSent ? "success" : "error"}`;
  }
  const passwordCancel = document.querySelector('[data-action="password-cancel"]');
  if (passwordCancel) passwordCancel.disabled = busy;
  updateTransferCodeButton();
  if (page === "provisioning" && setupState.state === "awaitingWifi") {
    updateWifiPicker();
    if (!busy && !wifiPicker.scanned) void scanWifi();
  }
}

function setupErrorMessage(error) {
  const code = typeof error === "string" ? error : String(error?.code || error?.message || "");
  const messages = {
    DEVICE_NOT_ENROLLED: "盒子尚未完成平台注册，请联系设备管理员完成初始化。",
    CLAIM_STATUS_CHECKING: "正在核对盒子归属…",
    CLAIM_STATUS_UNAVAILABLE: "暂时无法核对盒子归属，请检查网络后重新选择盒子；如仍失败，请管理员检查账号服务版本。",
    OWNER_ALREADY_CHANGED: "盒子归属已变化，请刷新设备列表并核对当前拥有者。",
    IDEMPOTENCY_CONFLICT: "认领码已用于其他认领请求，请刷新设备列表核对结果。",
    CONSOLE_CLAIM_NOT_FOUND: "认领码无效，请核对盒子控制台显示的认领码。",
    CONSOLE_CLAIM_EXPIRED: "认领码已过期，请从盒子控制台获取新的认领码。",
    CONSOLE_CLAIM_INACTIVE: "认领码已失效，请从盒子控制台重新发起。",
    CONSOLE_CLAIM_DISABLED: "平台暂未启用认领码功能，请联系管理员。",
    CONSOLE_CLAIM_RATE_LIMITED: "认领尝试过于频繁，请稍后重试。",
    CONSOLE_CLAIM_CONFLICT: "认领状态已变化，请刷新设备列表后重试。",
    DEVICE_ALREADY_OWNED: "这台盒子已属于当前账号，无需再次认领。返回盒子列表即可连接或修改 Wi-Fi。",
    DEVICE_OWNED_BY_OTHER: "这台盒子已属于其他账号，需要原主人完成转移后才能认领。",
    LEGACY_BINDING_REVIEW_REQUIRED: "这台盒子保留旧版账号绑定，请联系管理员迁移归属，或完成重置后重新交付。",
    CLAIM_HISTORY_REVIEW_REQUIRED: "这台盒子有尚待核对的交付历史，请联系管理员处理后再认领。",
    DEVICE_RESET_PENDING: "盒子正在完成重置，请等待管理员确认交付就绪后再试。",
    PAIRING_MODE_CLOSED: "盒子正在准备配网，请稍后重新选择；如持续未就绪，请管理员更新并检查盒端状态。",
    PROTOCOL_CHANGED: "盒子与客户端的配网协议未能匹配，请更新盒端和客户端后重试（PROTOCOL_CHANGED）。",
    DEVICE_IDENTITY_MISMATCH: "盒子身份校验未通过，接入已停止。请核对目标盒子。",
    LOCAL_TRANSPORT_DISCONNECTED: "蓝牙连接已断开，请靠近盒子并重新扫描。",
    LOCAL_CONNECT_TIMEOUT: "蓝牙连接盒子超时。请靠近盒子，检查电脑蓝牙后重试。",
    GATT_FRAGMENT_INCOMPLETE: "未完整收到盒子的蓝牙响应，请靠近盒子后重试。",
    PAIRING_EXPIRED: "本次安全会话已到期，请重新选择盒子开始新会话。未认领盒子会持续可用。",
    HELLO_CONTEXT_EXPIRED: "本次身份验证已到期，请重新选择盒子重试。",
    OWNER_AUTHORIZATION_SYNC_PENDING: "盒子正在同步归属状态，请稍后重新选择。",
    OWNER_REQUIRED: "只有盒子的主人可以修改 Wi-Fi，请刷新盒子列表后重试。",
    OWNER_WIFI_UNSUPPORTED: "盒端程序尚不支持修改 Wi-Fi，请更新盒端程序后重试。",
    CONTRACT_MISMATCH: "账号服务的配网响应不兼容，请联系管理员核对服务版本（CONTRACT_MISMATCH）。",
    LOCAL_SELECTION_LEASE_INVALID: "扫描结果已失效，请重新扫描并选择盒子。",
    AUTH_SESSION_CHANGED: "登录状态已变化，请重新开始配网。",
  };
  const key = Object.keys(messages).find((key) => code.includes(key));
  const diagnostic = /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? `（${code}）` : "";
  return messages[key] || `盒子接入未完成，请重试；如仍失败，请联系管理员。${diagnostic}`;
}

function connectionErrorMessage(error) {
  const code = String(error?.code || error?.message || "")
    .replace(/^Error invoking remote method 'wanx-client:connect-box': (?:Error: )?/, "");
  const messages = {
    health_unavailable: "连接盒子失败：盒端服务暂不可达，请检查盒子网络和服务后重试。",
    health_timeout: "连接盒子超时：盒端服务未及时响应，请稍后重试。",
    health_invalid: "连接盒子失败：盒端服务健康检查未通过，请联系管理员检查服务版本与状态。",
    netbird_peer_disconnected: "连接盒子失败：盒子当前离线，请确认盒子联网后重试。",
    netbird_peer_unknown: "连接盒子失败：网络尚未发现此盒子，请刷新设备后重试。",
  };
  return Object.hasOwn(messages, code) ? `${messages[code]}（${code}）`
    : operationErrorMessage(new Error(code), "连接盒子失败，请刷新设备后重试；如仍失败，请联系管理员检查盒子网络与服务。");
}

function operationErrorMessage(error, fallback) {
  const message = typeof error === "string" ? error : String(error?.code || error?.message || "");
  const boxSessionMessages = {
    BOX_PLATFORM_AUTH_FAILED: "盒子登录验证失败，请重新连接；如仍失败，请联系管理员检查盒端登录服务。",
    BOX_PLATFORM_SESSION_EXPIRED: "盒子登录已过期，请重新连接盒子。",
    BOX_PLATFORM_TIMEOUT: "连接盒子超时，请检查盒子网络后重试。",
    BOX_PLATFORM_BUSY: "盒子正在处理其他连接，请稍后重试。",
    BOX_PLATFORM_CAPACITY: "盒子暂时无法建立更多连接，请稍后重试。",
    BOX_ZHIJUN_INITIALIZATION_FAILED: "盒子的知君服务准备失败，暂时无法完成连接，请联系管理员修复盒端服务。",
    BOX_ZHIJUN_EXPERT_CONFLICT: "盒子的知君配置存在冲突，暂时无法完成连接，请联系管理员检查。",
  };
  for (const code of ["BOX_PLATFORM_STATE_INVALID", "BOX_PLATFORM_CONFIG_INVALID", "BOX_UPSTREAM_CREDENTIALS_INVALID", "BOX_UPSTREAM_AUTH_FAILED", "BOX_UPSTREAM_ADMIN_REQUIRED", "BOX_UPSTREAM_CAPTCHA_REQUIRED", "BOX_UPSTREAM_OIDC_CONFLICT", "BOX_UPSTREAM_OIDC_INVALID", "BOX_UPSTREAM_OIDC_FAILED", "BOX_UPSTREAM_IDENTITY_INVALID", "BOX_UPSTREAM_IDENTITY_MISMATCH", "BOX_UPSTREAM_ROLE_SYNC_FAILED"])
    boxSessionMessages[code] = "盒端登录服务配置异常，暂时无法完成连接，请联系管理员检查。";
  for (const code of ["BOX_PLATFORM_UPSTREAM_INVALID", "BOX_PLATFORM_UPSTREAM_UNAVAILABLE", "BOX_PLATFORM_RESPONSE_INVALID", "PLATFORM_RESPONSE_TOO_LARGE", "BOX_UPSTREAM_UNAVAILABLE", "BOX_UPSTREAM_NOT_READY", "BOX_UPSTREAM_PROTOCOL_INVALID", "BOX_UPSTREAM_RESPONSE_TOO_LARGE"])
    boxSessionMessages[code] = "盒端服务暂不可用，请稍后重新连接；如仍失败，请联系管理员。";
  if (Object.hasOwn(boxSessionMessages, message)) return `${boxSessionMessages[message]}（${message}）`;
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
      AUTH_RATE_LIMITED: "登录失败次数过多，已被暂时限制。请稍后重试，并确认使用最新密码。",
      PASSWORD_RESET_RATE_LIMITED: "密码重置尝试过于频繁，请稍后再试。",
      PASSWORD_ALREADY_SET: "该手机号已注册，请使用密码登录。",
      PASSWORD_WEAK: "密码需为 8–72 字节，且不能包含换行符。",
      PASSWORD_INVALID: "手机号或密码不正确，请重新输入。",
      PASSWORD_NOT_SET: "该账号尚未设置密码，请先完成注册。",
      ACCOUNT_INVALID_INPUT: "请检查手机号、密码和验证码格式。",
      ACCOUNT_LOGIN_REQUIRED: "请先登录万象。",
      PROFILE_INVALID_NAME: "昵称需为 1–40 个字符，不能包含控制字符。",
      PROFILE_AVATAR_TOO_LARGE: "头像文件不能超过 5 MB。",
      PROFILE_INVALID_AVATAR: "无法读取这张图片，请选择有效的 JPG 或 PNG 图片。",
      PROFILE_INVALID_INPUT: "资料格式无效，请重试。",
      PROFILE_UNAVAILABLE: "资料功能尚未就绪，请重启万象。",
      ACCOUNT_SESSION_CHANGED: "登录状态已变化，请重新打开应用。",
      APPLICATION_OPEN_CANCELLED: "已取消打开应用。",
      APPLICATION_OPEN_BUSY: "正在打开另一个应用，请稍后再试。",
      APPLICATION_OPEN_NOT_PENDING: "本次打开已取消，请重新打开应用。",
      APPLICATION_OPERATION_FAILED: "操作未完成，请重试。",
      NETWORK_DEVICE_ACCESS_DENIED: "当前账号无权访问此盒子，请刷新盒子列表。",
      LOCAL_BOX_AUTH_FAILED: "本机万象登录失败，请检查本机盒子的登录配置。",
      LOCAL_BOX_AUTH_TIMEOUT: "本机万象暂未响应，请确认服务已启动后重试。",
      LOCAL_BOX_INVALID_REGISTRATION: "本机盒子的连接配置无效，请重新登记。",
      NETWORK_NOT_READY: "网络尚未连接，请在设置中检查网络状态。",
      BOX_CONNECTION_REQUIRED: "请先在盒子空间中连接一台盒子。",
      NETWORK_CHANGED: "盒子连接已变化，请重新连接后打开应用。",
      BOX_IDENTITY_UNAVAILABLE: "暂时无法访问盒端服务，请重新连接盒子。",
      BOX_IDENTITY_INVALID: "盒端服务返回了无效身份，请重新连接盒子。",
      BOX_CONNECTION_CHANGED: "盒子连接已变化，请核对当前盒子后重新打开运维工具。",
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
  return messages[code] || fallback || marketErrorMessage(error);
}

async function run(action, input = {}) {
  const isSetupOperation = action.startsWith("provisioning.");
  if (isSetupOperation && setupRequest && (action !== "provisioning.cancel" || setupRequest.action === action)) return null;
  const request = isSetupOperation ? { action, mode: input.mode } : null;
  if (request) setupRequest = request;
  if (["provisioning.start", "provisioning.cancel", "auth.logout"].includes(action)) resetWifiPicker();
  notice = null;
  if (action === "devices.connect") connectionFailure = null;
  codeSent = false;
  const actionAccount = marketAccount;
  const applicationId = input.applicationId;
  const isAppOperation = Boolean(applicationId) && (action.startsWith("market.") || action.startsWith("applications."));
  if (isAppOperation && operationBusy(applicationId)) return null;
  const holdBusy = !isAppOperation && !["applications.confirm-open", "applications.cancel-open", "desktop.about"].includes(action);
  if (isAppOperation) localOperations.set(applicationId, { phase: { "market.install": "installing", "market.uninstall": "uninstalling", "market.rollback": "rolling_back", "applications.select-current": "selecting" }[action] || "opening", version: input.version });
  const operation = { action, deviceId: input.deviceId || (action === "devices.disconnect" ? currentState.activeDeviceId : undefined), tool: input.tool };
  if (holdBusy) { busy = true; busyRequest = operation; }
  render(currentState);
  let failure;
  try {
    const setupActions = {
      "provisioning.start": () => window.wanxSetup.begin(input.mode === "console" ? { ...input.candidate, mode: "console", claimCode: input.claimCode } : input.mode === "wifi" ? { ...input.candidate, mode: "wifi", ...(input.expectedDeviceId ? { expectedDeviceId: input.expectedDeviceId } : {}) } : input.candidate),
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
    const response = action === "provisioning.code-claim"
      ? { ok: true, value: await window.wanxSetup.redeemClaimCode(input) }
      : await window.wanxClient.action(action, input);
    if (holdBusy && busyRequest !== operation) return null;
    if (response.state) acceptRemoteState(response.state);
    if (!response.ok) throw new Error(response.code);
    return response;
  } catch (error) {
    if (request && setupRequest !== request || holdBusy && busyRequest !== operation) return null;
    if (action === "auth.send-code" && error.message.includes("SMS_RATE_LIMITED")) {
      resendAt = Date.now() + 60000;
      updateResendButton();
    }
    if (["auth.send-reset-code", "auth.send-change-code"].includes(action) && error.message.includes("SMS_RATE_LIMITED")) {
      if (action === "auth.send-reset-code") resetResendAt = Date.now() + 60000;
      else changeResendAt = Date.now() + 60000;
    }
    failure = action === "devices.connect" ? connectionErrorMessage(error) : action.startsWith("provisioning.") || action === "devices.claim" ? setupErrorMessage(error) : action.startsWith("updates.") ? updateGuidance(error.message) : operationErrorMessage(error);
    if (action === "devices.connect" && actionAccount === marketAccount) connectionFailure = { deviceId: input.deviceId, message: failure };
    if (!isAppOperation && actionAccount === marketAccount) notice = failure;
    return null;
  } finally {
    if (isAppOperation && actionAccount === marketAccount) {
      if (failure) localOperations.set(applicationId, { phase: "failed", error: failure });
      else if (action === "applications.request-open" && !currentState.ui?.pendingOpen) showOpenedStatus(applicationId);
      else localOperations.delete(applicationId);
    }
    if (holdBusy && busyRequest === operation) { busy = false; busyRequest = null; }
    if (request && setupRequest === request) setupRequest = null;
    render(currentState);
  }
}

app.addEventListener("click", async (event) => {
  activeInteraction = false;
  finishInteraction();
  const target = event.target.closest("[data-action]");
  if (!target) { if (profileMenuOpen) { profileMenuOpen = false; render(currentState); } return; }
  if (target.disabled) return;
  const action = target.dataset.action;
  if (action === "profile-menu" && page !== "provisioning") { profileMenuOpen = !profileMenuOpen; render(currentState); if (profileMenuOpen) app.querySelector?.('[data-action="show-profile"]')?.focus(); return; }
  if (profileMenuOpen && action !== "logout") profileMenuOpen = false;
  if (action === "profile-avatar" || action === "profile-avatar-remove") {
    if (busy || page !== "profile") return;
    await run(action === "profile-avatar" ? "profile.avatar" : "profile.avatar-remove"); return;
  }
  if (marketConfirmation && !["market-cancel", "market-confirm"].includes(action)) return;
  if (action.startsWith("carousel-")) {
    if (page !== "applications") return;
    if (action === "carousel-next") storeCarousel.select(storeCarousel.index + 1);
    else if (action === "carousel-previous") storeCarousel.select(storeCarousel.index - 1);
    else if (action === "carousel-select") storeCarousel.select(Number(target.dataset.carouselIndex));
    else if (action === "carousel-toggle") storeCarousel.toggle();
    return;
  }
  if (action === "store-details") {
    const id = target.dataset.applicationId;
    if (page !== "applications" || !storeApplication(id)) return;
    selectedApplicationId = id;
    posterPreview = null;
    page = "application-detail";
    render(currentState);
    document.querySelector(".app-detail-title")?.focus?.({ preventScroll: true });
    document.scrollingElement?.scrollTo?.(0, 0);
    return;
  }
  if (action === "store-back") { selectedApplicationId = null; posterPreview = null; page = "applications"; render(currentState); document.scrollingElement?.scrollTo?.(0, 0); return; }
  if (action === "poster-open") {
    const media = window.wanxAppCatalog?.[selectedApplicationId]?.posters;
    const index = Number(target.dataset.posterIndex);
    if (page !== "application-detail" || !Number.isInteger(index) || !media?.[index]) return;
    posterPreview = index; render(currentState);
    app.querySelector?.('[data-action="poster-close"]')?.focus?.(); return;
  }
  if (action === "poster-close") { posterPreview = null; render(currentState); app.querySelector?.('[data-action="poster-open"]')?.focus?.(); return; }
  if (action.startsWith("support-")) {
    if (busy || page !== "boxes") return;
    await supportView.action(action, target.dataset);
    if (action === "support-open") app.querySelector?.(".support-panel")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    return;
  }
  if (action === "market-cancel") { marketConfirmation = null; render(currentState); return; }
  if (action === "market-confirm") {
    const confirmation = marketConfirmation;
    if (!confirmation || busy) return;
    marketConfirmation = null;
    if (confirmation.updateReleaseId && (currentState.upgrades?.client?.phase !== "downloaded" || currentState.upgrades?.client?.candidate?.releaseId !== confirmation.updateReleaseId)) { notice = "更新内容已变化，请重新检查并确认。"; render(currentState); return; }
    if (confirmation.updateDeviceId && (currentState.activeDeviceId !== confirmation.updateDeviceId || currentState.upgrades?.box?.deviceId !== confirmation.updateDeviceId || confirmation.updatePlanId && (currentState.upgrades.box.plan?.planId !== confirmation.updatePlanId || Date.parse(currentState.upgrades.box.plan.expiresAt) <= Date.now()))) { notice = "更新计划已变化，请重新检查并确认。"; render(currentState); return; }
    if (confirmation.updateDeviceId && currentState.upgrades?.box?.canUpgrade !== true) { notice = updateGuidance("UPDATE_PERMISSION_REQUIRED"); render(currentState); return; }
    if (confirmation.updateResumeOperationId && (currentState.upgrades?.box?.operation?.operationId !== confirmation.updateResumeOperationId || !currentState.upgrades.box.operation.allowedActions?.includes("resume"))) { notice = "此任务状态已变化，请刷新任务状态。"; render(currentState); return; }
    const generation = marketGeneration;
    const result = await run(confirmation.action, confirmation.input || { applicationId: confirmation.applicationId });
    if (result && generation === marketGeneration && confirmation.action === "ownership.accept") {
      transferNotice = result.value?.refreshRequired ? "所有权已接受，盒子列表暂未刷新，请点击刷新。" : "已接受所有权，请等待盒子授权同步后连接。";
      await refreshTransfers({ force: true });
    }
    if (result && confirmation.action.startsWith("market.")) await refreshMarket();
    return;
  }
  if (busy && ["auth-login", "auth-register", "auth-reset", "send-registration-code", "send-reset-code", "send-change-code", "password-open", "password-cancel"].includes(action)) return;
  if (action === "auth-login") { authMode = "login"; notice = null; codeSent = false; render(currentState); return; }
  if (action === "auth-register") { authMode = "register"; notice = null; codeSent = false; render(currentState); return; }
  if (action === "auth-reset") { authMode = "reset"; notice = null; codeSent = false; render(currentState); return; }
  if (action === "password-open" || action === "password-cancel") {
    passwordEditing = action === "password-open";
    notice = null; codeSent = false; render(currentState); return;
  }
  if (action === "send-reset-code" || action === "send-change-code") {
    const change = action === "send-change-code";
    if (change ? !passwordEditing || currentState.route === "auth" : authMode !== "reset") return;
    if (Date.now() < (change ? changeResendAt : resetResendAt)) return;
    if (!change) {
      authUsername = document.querySelector("#account-name")?.value.trim() || "";
      if (!/^1\d{10}$/.test(authUsername)) { notice = "请输入有效的 11 位手机号"; codeSent = false; render(currentState); return; }
    }
    const response = await run(change ? "auth.send-change-code" : "auth.send-reset-code", change ? {} : { username: authUsername });
    if (response) {
      if (change) changeResendAt = Date.now() + 60000;
      else resetResendAt = Date.now() + 60000;
      codeSent = true; notice = "验证码已发送，5 分钟内有效，请查收短信";
    }
    render(currentState); return;
  }
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
  if (action?.startsWith("credits-")) {
    await creditsView.action(action, target.dataset);
    return;
  }
  if (action === "logout") { await run("auth.logout"); return; }
  if (["show-applications", "show-space", "show-boxes", "show-maintenance", "show-settings", "show-credits", "show-profile"].includes(action)) {
    if (page === "provisioning") return;
    page = action === "show-maintenance" ? "boxes" : action.slice(5);
    selectedApplicationId = null; posterPreview = null;
    if (page === "credits") void creditsView.refresh();
    if (page === "boxes") void refreshTransfers();
    notice = null;
    render(currentState);
    return;
  }
  if (action === "pending-cancel") { const pending = currentState.ui?.pendingOpen; if (pending) await run("applications.cancel-open", { intentId: pending.id }); return; }
  if (action === "pending-confirm") { const pending = currentState.ui?.pendingOpen; if (pending && pendingSelection?.deviceId && (currentState.networkReady || currentState.devices?.some(device => device.local && device.deviceId === pendingSelection.deviceId)) && !["connecting", "opening"].includes(pending.phase)) { const opened = await run("applications.confirm-open", { intentId: pending.id, deviceId: pendingSelection.deviceId }); if (opened) { showOpenedStatus(pending.applicationId); render(currentState); } } return; }
  if (action === "desktop-about") { await run("desktop.about"); return; }
  if (busy && action !== "cancel-provisioning") return;
  if (action === "updates-client-check") { await run("updates.client.check"); return; }
  if (action === "updates-client-download") { if (currentState.upgrades?.client?.phase === "available") await run("updates.client.download"); return; }
  if (action === "updates-client-install") {
    const update = currentState.upgrades?.client;
    if (update?.phase !== "downloaded" || !update.candidate?.releaseId) return;
    marketConfirmation = { title: "重启并更新万象", detail: `将安装万象 v${update.candidate.productVersion}。万象需要退出并重启，请先保存工作并关闭正在使用的应用。`, verb: "重启并更新", action: "updates.client.install", input: { confirmed: true }, updateReleaseId: update.candidate.releaseId };
    render(currentState); return;
  }
  if (action === "updates-box-check") { boxUpdatePollError = null; if (currentState.activeDeviceId) await run("updates.box.check", { deviceId: currentState.activeDeviceId }); return; }
  if (action.startsWith("updates-box-")) {
    const update = currentState.upgrades?.box;
    const deviceId = currentState.activeDeviceId;
    if (!update || update.deviceId !== deviceId) return;
    if (action !== "updates-box-status" && update.canUpgrade !== true) return;
    if (action === "updates-box-plan") {
      const releaseId = update.candidate?.release?.payload?.releaseId;
      if (update.candidate?.status !== "available" || !releaseId) return;
      const result = await run("updates.box.plan", { deviceId, releaseId });
      if (result && currentState.activeDeviceId === deviceId) boxUpdateConfirmation("execute");
    } else if (action === "updates-box-resume") boxUpdateConfirmation("resume");
    else if (action === "updates-box-status" && update.operation?.operationId) { boxUpdatePollError = null; await run("updates.box.status", { deviceId, operationId: update.operation.operationId }); }
    else if (action === "updates-box-cancel" && update.operation?.allowedActions?.includes("cancel")) await run("updates.box.cancel", { deviceId, operationId: update.operation.operationId });
    return;
  }
  if (action === "startup-toggle") { if (currentState.desktopStartup?.supported) await run("desktop.startup.set", { enabled: !currentState.desktopStartup.enabled }); return; }
  if (action === "desktop-quit") { await run("desktop.quit"); return; }
  if (action === "maintenance-open") {
    if (currentState.canOpenDashboard && ["terminal", "desktop"].includes(target.dataset.tool)) await run("maintenance.open", { tool: target.dataset.tool, deviceId: currentState.activeDeviceId });
    return;
  }
  if (action === "market-refresh") { if (!marketLoading) await refreshMarket(); return; }
  if (["market-install", "market-uninstall", "market-rollback"].includes(action)) {
    const applicationId = target.dataset.applicationId;
    const installed = (currentState.applications || []).find((item) => item.applicationId === applicationId);
    const item = storeApplication(applicationId);
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
  if (action === "bluetooth-refresh") { await window.wanxBluetooth?.refresh(); return; }
  if (action === "bluetooth-settings") {
    try { await window.wanxDiscovery.openBluetoothSettings(bluetoothState.status === "permission-denied" ? "privacy" : "bluetooth"); }
    catch { notice = "无法自动打开系统设置，请手动打开电脑的蓝牙设置并开启蓝牙、允许万象访问。"; render(currentState); }
    return;
  }
  if (["provisioning", "configure-network"].includes(action)) {
    const deviceId = action === "configure-network" ? target.dataset.deviceId : null;
    if (action === "configure-network" && (!deviceIsOwner(deviceId) || currentState.devices?.find(device => device.deviceId === deviceId)?.local)) return;
    resetWifiPicker();
    setupSelection = null;
    selection.reset();
    setupTargetDeviceId = deviceId;
    resetConsoleClaim();
    setupState = { state: "idle" };
    notice = null;
    page = "provisioning";
    void window.wanxBluetooth?.refresh();
    const operation = { action: "provisioning.reset" };
    busy = true; busyRequest = operation;
    render(currentState);
    try { const snapshot = await window.wanxSetup.reset(); if (busyRequest === operation) setupState = snapshot; }
    catch (error) { if (busyRequest === operation) notice = error.message; }
    finally { if (busyRequest === operation) { busy = false; busyRequest = null; render(currentState); } }
    return;
  }
  if (action === "wifi-refresh") { await scanWifi(); return; }
  if (action === "wifi-password-toggle") {
    const password = app.querySelector?.('[data-form="wifi"]')?.querySelector('[name="password"]');
    if (!password || password.disabled) return;
    const visible = password.type === "password";
    const cursor = [password.selectionStart, password.selectionEnd];
    password.type = visible ? "text" : "password";
    const label = visible ? "隐藏密码" : "显示密码";
    target.setAttribute("aria-pressed", String(visible));
    target.setAttribute("aria-label", label);
    target.setAttribute("title", label);
    const slash = target.querySelector?.('[data-password-slash]');
    if (slash) slash.toggleAttribute("hidden", !visible);
    password.focus({ preventScroll: true });
    if (cursor[0] !== null) password.setSelectionRange(...cursor);
    return;
  }
  if (["console-claim-online", "console-claim-offline", "console-claim-without-code"].includes(action)) {
    if (busy || page !== "provisioning" || setupTargetDeviceId) return;
    selection.reset(); notice = null; consoleClaimNotice = null;
    if (action === "console-claim-without-code") { resetConsoleClaim(); setupState = { state: "idle" }; }
    else consoleClaimFlow = action === "console-claim-offline" ? "entry-wifi" : "entry-online";
    render(currentState); return;
  }
  if (action === "console-claim-confirm") {
    if (busy || setupState.state !== "awaitingCodeClaim" || consoleClaimFlow !== "wifi" || !consoleClaimAttempt) return;
    await submitConsoleClaim(true); return;
  }
  if (action === "console-claim-edit") {
    if (busy || consoleClaimFlow !== "wifi" || !["terminalError", "restartRequired"].includes(setupState.state)) return;
    const result = await run("provisioning.cancel");
    if (!result) return;
    resetConsoleClaim(); consoleClaimFlow = "entry-wifi"; setupState = { state: "idle" };
    render(currentState); return;
  }
  if (action === "console-claim-refresh") {
    const receipt = consoleClaimReceipt;
    if (!receipt || busy) return;
    const result = await run("devices.claim-status", { deviceId: receipt.deviceId });
    if (consoleClaimReceipt === receipt && result?.value?.deviceId === receipt.deviceId) {
      consoleClaimReceipt = { ...receipt, authorizationState: result.value.authorizationState };
      render(currentState);
    }
    return;
  }
  if (action === "wifi-manual") {
    if (setupState.state !== "awaitingWifi") return;
    wifiPicker.manual = !wifiPicker.manual;
    if (!wifiPicker.manual && wifiPicker.selected) selectWifi(wifiKey(wifiPicker.selected));
    updateWifiPicker(); return;
  }
  if (action === "start-provisioning") {
    if (busy || !setupReady || bluetoothState.status !== "available" || discoveryView.selecting) return;
    setupSelection = null;
    resetWifiPicker(); resetDiscoveryMetadata(); selection.start(); return;
  }
  if (["select-candidate", "select-candidate-wifi"].includes(action)) {
    if (bluetoothState.status !== "available") return;
    const candidate = discoveryView.candidates.find(item => item.candidateId === target.dataset.candidateId);
    if (!candidate) return;
    const deviceId = discoveryDeviceId(candidate);
    const owner = deviceIsOwner(deviceId);
    if (setupTargetDeviceId) {
      if (!deviceIsOwner(setupTargetDeviceId) || deviceId && deviceId !== setupTargetDeviceId) return;
      setupSelection = { mode: "wifi", deviceId: setupTargetDeviceId, expectedDeviceId: setupTargetDeviceId };
    } else {
      if (action === "select-candidate-wifi" && !owner) return;
      if (consoleClaimFlow === "wifi" && owner) { notice = "此盒子已认领，请从盒子卡片的“配置网络”入口修改 Wi-Fi。"; render(currentState); return; }
      setupSelection = { mode: consoleClaimFlow === "wifi" ? "console" : owner ? "wifi" : "claim", deviceId };
    }
    selection.choose(candidate.candidateId);
    return;
  }
  if (action === "provisioning-confirm") { await run("provisioning.confirm"); return; }
  if (action === "provisioning-refresh") { await run("provisioning.refresh"); return; }
  if (action === "provisioning-owner") { await run("provisioning.owner"); return; }
  if (action === "cancel-provisioning") { selection.reset(); await run("provisioning.cancel"); if (consoleClaimFlow === "wifi") { resetConsoleClaim(); setupState = { state: "idle" }; render(currentState); } return; }
  if (action === "connect") {
    const device = currentState.devices?.find((item) => item.deviceId === target.dataset.deviceId);
    if (!device || (!device.local && !currentState.networkReady) || !deviceCanConnect(device)) return;
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
  if (action === "back-devices") {
    const claimed = Boolean(consoleClaimReceipt);
    void window.wanxSetup.reset().catch(() => {});
    resetConsoleClaim(); resetWifiPicker(); page = "boxes"; selection.reset(); setupTargetDeviceId = null; notice = null; render(currentState);
    if (claimed) await run("devices.refresh");
    return;
  }
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
app.addEventListener("input", event => {
  if (event.target.id === "wallet-custom-amount") void creditsView.action("credits-custom-change", { amount: event.target.value, value: event.target.value });
});
app.addEventListener("change", async (event) => {
  if (event.target.name === "remember" && !event.target.checked && !busy) {
    await run("auth.forget-login");
    return;
  }
  if (event.target.dataset.input === "wifi-network") selectWifi(event.target.value);
  if (event.target.name === "security") updateWifiPicker();
  if (event.target.dataset.input === "pending-device" && pendingSelection) { pendingSelection.deviceId = event.target.value; render(currentState); }
});
app.addEventListener("toggle", (event) => {
  const id = event.target.dataset?.detailId;
  if (id) { if (event.target.open) expandedDetails.add(id); else expandedDetails.delete(id); }
}, true);

app.addEventListener("keydown", (event) => {
  const walletDialog = app.querySelector?.('.wallet-purchase-dialog');
  if (walletDialog && event.key === 'Escape') { event.preventDefault(); releaseInteraction(); void creditsView.action('credits-dismiss'); return; }
  if (walletDialog && event.key === 'Tab') {
    const buttons = Array.from(walletDialog.querySelectorAll('button:not(:disabled), input:not(:disabled)'));
    if (buttons.length) {
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = index < 0 ? (event.shiftKey ? buttons.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
    return;
  }
  if (event.key === " " && event.target?.closest?.("button")) { clearTimeout(interactionTimer); activeInteraction = true; }
  if (posterPreview !== null && event.key === "Escape") { event.preventDefault(); posterPreview = null; render(currentState); app.querySelector?.('[data-action="poster-open"]')?.focus?.(); return; }
  if (posterPreview !== null && event.key === "Tab") { event.preventDefault(); app.querySelector?.('[data-action="poster-close"]')?.focus?.(); return; }
  if (profileMenuOpen && event.key === "Escape") { profileMenuOpen = false; render(currentState); app.querySelector?.('[data-action="profile-menu"]')?.focus(); return; }
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

function validateNewPassword(data) {
  if (!data.password) return "请输入新密码";
  const length = new TextEncoder().encode(data.password || "").length;
  if (length < 8 || length > 72 || /[\r\n\0]/.test(data.password)) return "密码需为 8–72 字节，且不能包含换行符。";
  if (!data.confirmPassword) return "请再次输入新密码";
  if (data.password !== data.confirmPassword) return "两次输入的密码不一致";
  if (!/^\d{6}$/.test(data.code || "")) return "请输入 6 位短信验证码";
  return null;
}

async function submitConsoleClaim(scanned) {
  const attempt = consoleClaimAttempt;
  const generation = marketGeneration;
  const result = await run(scanned ? "provisioning.code-claim" : "devices.claim", attempt);
  if (!result || generation !== marketGeneration || consoleClaimAttempt !== attempt) return;
  const receipt = result.value;
  if (!receipt?.deviceId || receipt.ownership !== "claimed") {
    notice = "暂未获得绑定确认，请重试。";
    render(currentState); return;
  }
  app.querySelector?.('[data-form="console-claim"]')?.reset();
  consoleClaimAttempt = null;
  consoleClaimReceipt = { deviceId: receipt.deviceId, authorizationState: receipt.authorizationState || "deviceAckPending" };
  consoleClaimFlow = "receipt";
  render(currentState);
}

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  if (event.target.dataset.form === "profile") {
    const data = Object.fromEntries(new FormData(event.target));
    const result = await run("profile.save", { displayName: String(data.displayName || "").trim() });
    if (result) { notice = "资料已保存在这台电脑。"; codeSent = true; render(currentState); }
    return;
  }
  if (event.target.dataset.form === "console-claim") {
    if (!["entry-online", "entry-wifi"].includes(consoleClaimFlow)) return;
    consoleClaimNotice = null;
    const data = Object.fromEntries(new FormData(event.target));
    const claimCode = String(data.claimCode || "").trim().toUpperCase();
    if (!/^(?:[A-Z2-7]{10}|[A-Z2-7]{20})$/.test(claimCode)) {
      consoleClaimNotice = "请输入 10 或 20 位有效认领码。"; render(currentState); return;
    }
    if (consoleClaimAttempt?.claimCode !== claimCode)
      consoleClaimAttempt = { claimCode, clientAttemptId: crypto.randomUUID() };
    if (consoleClaimFlow === "entry-wifi") {
      app.querySelector?.('[data-form="console-claim"]')?.reset();
      consoleClaimFlow = "wifi";
      setupState = { state: "idle" };
      notice = null;
      render(currentState);
    } else await submitConsoleClaim(false);
    return;
  }
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
  if (event.target.dataset.form === "password-change") {
    const data = Object.fromEntries(new FormData(event.target));
    codeSent = false;
    notice = validateNewPassword(data);
    if (notice) { render(currentState); return; }
    await run("auth.change-password", { password: data.password, code: data.code });
    return;
  }
  if (event.target.dataset.form !== "auth") return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  authUsername = String(data.username || "").trim();
  codeSent = false;
  if (!/^1\d{10}$/.test(authUsername)) notice = "请输入有效的 11 位手机号";
  else if (authMode === "login" && !data.password) notice = "请输入密码";
  else if (authMode !== "login" && validateNewPassword(data)) notice = validateNewPassword(data);
  else {
    const reset = authMode === "reset";
    const result = await run(reset ? "auth.reset-password" : authMode === "register" ? "auth.register" : "auth.login", { username: authUsername, password: data.password, ...(authMode !== "login" ? { code: data.code } : { remember: data.remember === "on" }) });
    if (reset && result) { authMode = "login"; codeSent = true; notice = "密码重置成功，请使用新密码登录。"; render(currentState); }
    return;
  }
  render(currentState);
});

function acceptRemoteState(state) {
  window.wanxSpace?.hostState(state);
  const creditsIdentity = state.route === "auth" ? null : JSON.stringify([state.account?.accountId, state.account?.clientId]);
  const creditsChanged = creditsView.reset(creditsIdentity);
  const account = state.route === "auth" ? null : state.account?.accountId || "authenticated";
  const accountChanged = account !== marketAccount || state.account?.clientId !== currentState?.account?.clientId;
  if (accountChanged || state.activeDeviceId === connectionFailure?.deviceId) connectionFailure = null;
  if (marketConfirmation?.updateReleaseId && (state.upgrades?.client?.phase !== "downloaded" || state.upgrades?.client?.candidate?.releaseId !== marketConfirmation.updateReleaseId)) marketConfirmation = null;
  if (marketConfirmation?.updateDeviceId && (accountChanged || state.activeDeviceId !== marketConfirmation.updateDeviceId || state.upgrades?.box?.deviceId !== marketConfirmation.updateDeviceId || marketConfirmation.updatePlanId && state.upgrades.box.plan?.planId !== marketConfirmation.updatePlanId)) marketConfirmation = null;
  if (marketConfirmation?.updateDeviceId && state.upgrades?.box?.canUpgrade !== true) marketConfirmation = null;
  if (marketConfirmation?.updateResumeOperationId && (state.upgrades?.box?.operation?.operationId !== marketConfirmation.updateResumeOperationId || !state.upgrades.box.operation.allowedActions?.includes("resume"))) marketConfirmation = null;
  if (accountChanged) {
    selectedApplicationId = null;
    posterPreview = null;
    profileMenuOpen = false;
    storeCarousel.select(0);
    notice = null;
    resetDiscoveryMetadata();
    setupSelection = null;
    const passwordChanged = state.account?.reason === "password_reset" && busyRequest?.action === "auth.change-password";
    releaseInteraction(); busy = false; busyRequest = null;
    passwordEditing = false; changeResendAt = 0;
    clearTimeout(resendTimer); resendAt = 0; codeSent = false;
    if (passwordChanged) {
      authMode = "login"; codeSent = true;
      notice = "密码修改成功，请使用新密码重新登录。";
    }
  }
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
    resetConsoleClaim();
    ownershipTransfers = []; transferDeviceId = null; transferNotice = null; transferResendAt = 0;
    selection.reset();
    marketItems = [];
    marketCandidates = new Map();
    marketConfirmation = null;
    localOperations.clear();
    pendingSelection = null;
    expandedDetails.clear();
    selectedApplicationId = null; posterPreview = null;
    marketError = null;
    marketLoading = false;
    marketAccount = account;
    marketGeneration++;
    setupState = { state: "idle" };
    setupTargetDeviceId = null;
  }
  render(state);
  if (creditsChanged && creditsIdentity) void creditsView.refresh();
  if (state.route !== "auth" && accountChanged) {
    void refreshMarket();
  }
}
window.wanxBluetooth?.subscribe(state => {
  bluetoothState = state;
  if (state.status === "unavailable" && discoveryView.selecting) selection.reset();
  if (page === "provisioning" && currentState) render(currentState);
});
window.wanxClient.onLocalState(acceptRemoteState);
window.wanxClient.onNavigate?.((destination) => {
  if (!currentState || currentState.route === "auth" || page === "provisioning") return;
  if (!["applications", "space", "boxes", "settings", "credits", "profile"].includes(destination)) return;
  profileMenuOpen = false;
  page = destination;
  if (page === "credits") void creditsView.refresh();
  if (page === "boxes") void refreshTransfers();
  notice = null;
  render(currentState);
});
window.wanxSetup?.subscribe((snapshot) => {
  if ((snapshot.pairingSessionId && wifiPicker.sessionId && snapshot.pairingSessionId !== wifiPicker.sessionId) ||
      (snapshot.sessionRenewed && !setupState.sessionRenewed)) resetWifiPicker();
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
window.wanxSpace?.bind({ render: () => { if (currentState && ["space", "boxes"].includes(page)) render(currentState); } });
window.wanxClient.getLocalState().then(acceptRemoteState);
