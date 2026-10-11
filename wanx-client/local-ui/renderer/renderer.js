const app = document.querySelector("#app");
let currentState;
let authMode = "login";
let authUsername = "";
let notice = null;
let busy = false;
let provisioningTargetId = null;
let setupState = { state: "idle" };
let selectedCandidate;
let setupReady = false;
let discoveryCandidates = [];
let discoverySessionId = null;
let selectionPromise;
const stageLabels = {
  discover: "发现盒子",
  identity: "读取设备身份",
  network: "配置网络",
  claim: "认领设备",
  initialize: "初始化盒端",
};

const lifecycleLabels = {
  discovered: "待配置",
  provisioning: "配网中",
  initializing: "初始化中",
  ready: "可用",
  failed: "需要重试",
};

const escapeHTML = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function statusLabel(device) {
  if (device.cloudPresence === "online" || device.platformOnline) return "在线";
  if (device.cloudPresence === "offline") return "离线";
  if (device.cloudPresence === "unknown") return "状态未知";
  if (device.localReachability === "reachable") return "当前网络可达";
  if (device.localReachability === "unreachable") return "当前网络不可达";
  return "等待连接";
}

function deviceCard(device, available) {
  const selected = currentState.selectedDeviceId === device.deviceId;
  const action = available
    ? `<button class="button primary small" data-action="connect" data-device-id="${escapeHTML(device.deviceId)}">${selected ? "连接当前盒子" : "连接"}</button>`
    : `<button class="button small" data-action="provisioning" data-device-id="${escapeHTML(device.deviceId)}">开始初始化</button>`;
  return `
    <article class="device-card ${selected ? "selected" : ""}">
      <div class="device-icon">W</div>
      <div class="device-main">
        <div class="device-title-row">
          <h3>${escapeHTML(device.name)}</h3>
          <span class="status-tag ${available ? "ready" : "pending"}">${escapeHTML(lifecycleLabels[device.lifecycle] || "待处理")}</span>
        </div>
        <p class="device-id">${escapeHTML(device.deviceId)}</p>
        <div class="device-meta"><span>${escapeHTML(statusLabel(device))}</span><span>${device.initialized ? "已完成初始化" : "尚未初始化"}</span></div>
      </div>
      <div class="device-action">${action}</div>
    </article>`;
}

function shellHeader(title, eyebrow = "设备中心") {
  const account = currentState.account?.displayName || currentState.account?.id || "万象用户";
  return `
    <header class="topbar">
      <div class="brand-mark">W</div>
      <div><p class="eyebrow">WANX CLIENT</p><h1>${title}</h1></div>
      <div class="topbar-spacer"></div>
      <span class="mode-tag">已连接平台</span>
      <span class="account-chip">${escapeHTML(account)}</span>
      <button class="text-button" data-action="logout">退出</button>
    </header>
    <div class="section-label">${eyebrow}</div>`;
}

function authView() {
  const register = authMode === "register";
  return `
    <div class="auth-layout">
      <section class="auth-intro">
        <div class="brand-mark large">W</div>
        <p class="eyebrow">WANX PLATFORM</p>
        <h1>先登录万象平台，<br />再管理你的盒子</h1>
        <p class="lede">平台账号负责设备归属和授权。登录后，你可以发现新盒子、完成配网初始化，并在多个可用盒子之间切换。</p>
        <div class="flow-preview"><span>平台账号</span><i>→</i><span>设备中心</span><i>→</i><span>盒端服务</span></div>
      </section>
      <section class="auth-card">
        <div class="card-kicker">${register ? "创建平台账号" : "欢迎回来"}</div>
        <h2>${register ? "注册万象平台" : "登录万象平台"}</h2>
        <p class="muted">使用万象平台账号进入设备中心。</p>
        <div class="tabs"><button class="tab ${!register ? "active" : ""}" data-action="auth-login">登录</button><button class="tab ${register ? "active" : ""}" data-action="auth-register">注册</button></div>
        <form id="auth-form" data-form="auth">
          <label for="account-name">手机号</label>
          <input id="account-name" name="username" value="${escapeHTML(authUsername)}" required pattern="1[0-9]{10}" autocomplete="username" placeholder="13800138000" />
          <label for="account-password">密码</label>
          <input id="account-password" name="password" type="password" required minlength="8" autocomplete="${register ? "new-password" : "current-password"}" placeholder="输入密码" />
          ${register ? '<label for="account-code">短信验证码</label><div class="code-field"><input id="account-code" name="code" required pattern="[0-9]{6}" placeholder="输入 6 位验证码" /><button class="button small" type="button" data-action="send-registration-code">获取验证码</button></div>' : ""}
          <button class="button primary wide" type="submit" ${busy ? "disabled" : ""}>${busy ? "处理中…" : register ? "创建账号并进入" : "登录并进入设备中心"}</button>
        </form>
        ${notice ? `<div class="notice error">${escapeHTML(notice)}</div>` : ""}
      </section>
    </div>`;
}

function devicesView() {
  const available = currentState.availableDevices || [];
  const pending = (currentState.devices || []).filter((device) => !available.some((item) => item.deviceId === device.deviceId));
  return `
    <div class="app-layout">
      ${shellHeader("选择你的万象盒子")}
      <section class="page-hero">
        <div><p class="eyebrow">YOUR DEVICES</p><h2>从设备中心进入盒端服务</h2><p class="lede">只有完成认领、配网和初始化的盒子会出现在可用列表中。</p></div>
        <button class="button primary" data-action="provisioning">＋ 发现新盒子</button>
      </section>
      ${notice ? `<div class="notice error">${escapeHTML(notice)}</div>` : ""}
      <section class="content-section"><div class="section-heading"><div><p class="eyebrow">READY DEVICES</p><h2 class="small-heading">可用盒子 <span class="count">${available.length}</span></h2></div><button class="text-button" data-action="refresh">刷新列表</button></div>
        ${available.length ? `<div class="device-list">${available.map((device) => deviceCard(device, true)).join("")}</div>` : '<div class="empty-state"><div class="empty-icon">＋</div><h3>还没有可用盒子</h3><p>点击“发现新盒子”，开始完成设备接入。</p><button class="button primary" data-action="provisioning">开始发现</button></div>'}
      </section>
      ${pending.length ? `<section class="content-section pending-section"><div class="section-heading"><div><p class="eyebrow">SETUP REQUIRED</p><h2 class="small-heading">待处理设备 <span class="count">${pending.length}</span></h2></div></div><div class="device-list">${pending.map((device) => deviceCard(device, false)).join("")}</div></section>` : ""}
      <details class="diagnostics"><summary>开发诊断入口</summary><div class="diagnostic-row"><input id="base-url" value="${escapeHTML(currentState.diagnostics?.baseURL || "http://localhost:8088")}" spellcheck="false" /><button class="button small" data-action="health">检查盒端服务</button></div><p>${escapeHTML(currentState.diagnostics?.message || "仅用于本机开发诊断，不替代设备发现与初始化。")}</p></details>
    </div>`;
}

function provisioningView() {
  const stagesByState = {
    idle: "discover", previewReady: "identity", awaitingWifi: "network",
    awaitingOwnershipConfirmation: "claim", submittingAppProof: "claim",
    provisioningWifi: "network", waitingCloud: "initialize", attentionRequired: "initialize",
  };
  const failed = ["terminalError", "restartRequired"].includes(setupState.state);
  const provisioning = {
    phase: failed ? "failed" : setupState.state === "completed" ? "ready" :
      ["submittingAppProof", "provisioningWifi", "waitingCloud"].includes(setupState.state) ? "running" : "idle",
    stage: stagesByState[setupState.state],
    error: { message: setupState.errorCode || "本次接入失败" },
  };
  const running = provisioning.phase === "running";
  const preview = setupState.preview || setupState.compatiblePreview;
  const setupPhase = setupState.state || "idle";
  const stages = Object.entries(stageLabels);
  const setupCopy = {
    idle: "请让盒子进入蓝牙配网模式，然后点击扫描并选择附近的盒子。",
    attentionRequired: "盒子授权尚未完成，请检查盒子联网状态后刷新。",
    previewReady: "请核对设备 ID、型号和身份指纹，然后确认。",
    awaitingWifi: "设备身份已验证，请输入设备要连接的 Wi‑Fi。",
    awaitingOwnershipConfirmation: "设备已准备联网，请确认绑定到当前账号。",
    submittingAppProof: "正在提交账号绑定证明…",
    provisioningWifi: "正在通过加密通道配置 Wi‑Fi…",
    waitingCloud: "正在等待设备联网并完成平台授权…",
    completed: "设备已完成联网和账号绑定。",
    cancelled: "本次配网已取消。",
  }[setupPhase] || "请让设备进入配置模式后开始扫描。";
  const previewBlock = preview ? `<dl class="setup-preview"><dt>设备名称</dt><dd>${escapeHTML(preview.display_name)}</dd><dt>设备 ID</dt><dd>${escapeHTML(preview.device_id)}</dd><dt>型号</dt><dd>${escapeHTML(preview.model)}</dd><dt>身份公钥指纹</dt><dd>${escapeHTML(preview.identity_public_key_sha256)}</dd></dl>` : "";
  const discoveryBlock = selectionPromise ? `<div class="discovery-list"><p>选择要配置的盒子：</p>${discoveryCandidates.length ? discoveryCandidates.map((candidate) => `<button class="device-card discovery-card" data-action="select-candidate" data-candidate-id="${escapeHTML(candidate.candidateId)}"><strong>${escapeHTML(candidate.advertisedName || "CentaurOS 盒子")}</strong><span>BLE 配网设备</span></button>`).join("") : "<p>正在等待附近的盒子，请确认盒子已进入配置模式。</p>"}</div>` : "";
  const controls = setupPhase === "previewReady"
    ? `<button class="button primary" data-action="provisioning-confirm" ${busy ? "disabled" : ""}>确认设备身份</button>`
    : setupPhase === "awaitingWifi"
      ? `<form class="setup-wifi" data-form="wifi"><label>Wi‑Fi 名称<input name="ssid" required maxlength="32" autocomplete="off" /></label><label>安全类型<select name="security"><option value="wpa_personal">WPA/WPA2 个人网络</option><option value="open">开放网络</option></select></label><label>密码<input name="password" type="password" maxlength="128" autocomplete="off" /></label><label class="check"><input name="hidden" type="checkbox" />隐藏网络</label><button class="button primary" type="submit" ${busy ? "disabled" : ""}>继续绑定账号</button></form>`
      : setupPhase === "awaitingOwnershipConfirmation"
        ? `<button class="button primary" data-action="provisioning-owner" ${busy ? "disabled" : ""}>确认绑定到当前账号</button>`
        : "";
  return `
    <div class="app-layout">
      ${shellHeader("发现并初始化盒子", "设备接入")}
      <section class="wizard-hero"><div><p class="eyebrow">NEW DEVICE SETUP</p><h2>把一台新盒子加入你的平台</h2><p class="lede">按照发现、身份确认、配网、认领和初始化顺序完成接入。未完成的设备不会进入可用列表。</p></div><div class="wizard-orb">${running ? "…" : "W"}</div></section>
      <section class="wizard-card"><div class="wizard-steps">${stages.map(([key, label], index) => { const active = provisioning.stage === key; const done = provisioning.phase === "ready" || stages.findIndex(([name]) => name === provisioning.stage) > index; return `<div class="wizard-step ${active ? "active" : ""} ${done ? "done" : ""}"><span>${done ? "✓" : index + 1}</span><label>${label}</label></div>`; }).join("")}</div>
        <div class="wizard-copy"><p class="eyebrow">${running ? "正在处理" : provisioning.phase === "failed" ? "接入未完成" : "设备配置"}</p><h3>${running ? escapeHTML(stageLabels[provisioning.stage] || "处理中") : setupPhase === "idle" ? "发现附近的万象盒子" : "配置设备"}</h3><p>${provisioning.phase === "failed" ? escapeHTML(provisioning.error?.message || "本次接入失败") : escapeHTML(setupCopy)}</p>${discoveryBlock}${previewBlock}${controls}</div>
        <div class="wizard-actions">${running ? '<button class="button" disabled>返回设备中心</button><button class="button danger" data-action="cancel-provisioning">取消</button>' : `<button class="button" data-action="back-devices">返回设备中心</button>${["idle", "cancelled"].includes(setupPhase) || provisioning.phase === "failed" ? `<button class="button primary" data-action="start-provisioning" ${busy || !setupReady ? "disabled" : ""}>${provisioning.phase === "failed" ? "重新扫描" : "开始扫描盒子"}</button>` : setupPhase === "completed" ? '<button class="button primary" data-action="refresh">进入设备中心</button>' : '<button class="button danger" data-action="cancel-provisioning">取消</button>'}</div>`}
        ${setupPhase === "attentionRequired" ? '<button class="button" data-action="provisioning-refresh">刷新授权状态</button>' : ""}
        ${notice ? `<div class="notice error">${escapeHTML(notice)}</div>` : ""}
        ${!setupReady ? '<p class="hint">正在准备蓝牙配网服务…</p>' : ""}
      </section>
    </div>`;
}

function connectedView() {
  const device = (currentState.devices || []).find((item) => item.deviceId === currentState.activeDeviceId);
  return `
    <div class="app-layout">
      ${shellHeader("盒端服务", "当前连接")}
      <section class="connected-hero"><div class="connected-mark">W</div><div><p class="eyebrow">CONNECTED BOX</p><h2>${escapeHTML(device?.name || "当前盒子")}</h2><p class="lede">设备已经通过平台授权并进入当前工作上下文。</p></div><span class="status-tag ready">已连接</span></section>
      ${notice ? `<div class="notice error">${escapeHTML(notice)}</div>` : ""}
      <section class="service-grid"><article class="service-card featured"><p class="eyebrow">NATIVE SERVICE</p><h3>Octop Dashboard</h3><p>打开当前盒端提供的原生 Dashboard，页面和业务请求由盒端服务处理。</p><button class="button primary" disabled>打开 Dashboard（接口接入后启用）</button></article><article class="service-card"><p class="eyebrow">DEVICE CONTEXT</p><h3>设备状态</h3><dl><dt>设备 ID</dt><dd>${escapeHTML(device?.deviceId)}</dd><dt>初始化</dt><dd>已完成</dd><dt>平台状态</dt><dd>${escapeHTML(statusLabel(device || {}))}</dd></dl></article></section>
      <div class="connected-actions"><button class="button" data-action="back-devices">切换盒子</button><button class="text-button" data-action="disconnect">断开当前盒子</button></div>
    </div>`;
}

function render(state) {
  currentState = state;
  if (state.route === "auth" || state.phase === "signed_out" || state.phase === "authenticating") app.innerHTML = authView();
  else if (state.route === "provisioning") app.innerHTML = provisioningView();
  else if (state.route === "connected") app.innerHTML = connectedView();
  else app.innerHTML = devicesView();
}

async function run(action, input = {}) {
  notice = null;
  const holdBusy = !action.startsWith("provisioning.start");
  if (holdBusy) busy = true;
  render(currentState);
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
      setupState = await setupActions[action]();
      return { ok: true };
    }
    const response = await window.wanxClient.action(action, input);
    if (!response.ok) throw new Error(response.code);
    return response;
  } catch (error) {
    notice = error.message;
    render(currentState);
    return null;
  } finally {
    if (holdBusy) busy = false;
    render(currentState);
  }
}

function startBluetoothSelection() {
  if (selectionPromise) return;
  if (!window.wanxDeviceSetupTransport) {
    notice = "当前运行时尚未接入本地配网能力";
    render(currentState);
    return;
  }
  notice = null;
  discoveryCandidates = [];
  discoverySessionId = null;
  selectionPromise = window.wanxDeviceSetupTransport.requestDeviceFromUserGesture();
  render(currentState);
  const attempt = selectionPromise;
  selectionPromise.then(
    (candidate) => {
      if (selectionPromise !== attempt) return;
      selectedCandidate = candidate;
      selectionPromise = undefined;
      discoveryCandidates = [];
      discoverySessionId = null;
      render(currentState);
      void run("provisioning.start", { candidate });
    },
    (error) => {
      if (selectionPromise !== attempt) return;
      selectionPromise = undefined;
      discoveryCandidates = [];
      discoverySessionId = null;
      notice = error.message;
      render(currentState);
    },
  );
}

app.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  if (action === "auth-login") { authMode = "login"; notice = null; render(currentState); return; }
  if (action === "auth-register") { authMode = "register"; notice = null; render(currentState); return; }
  if (action === "send-registration-code") {
    const input = document.querySelector("#account-name");
    authUsername = input?.value.trim() || "";
    if (!authUsername) { notice = "请先填写手机号"; render(currentState); return; }
    const response = await run("auth.send-code", { username: authUsername });
    if (response) notice = "验证码已发送，请查收短信";
    render(currentState);
    return;
  }
  if (action === "logout") { provisioningTargetId = null; await run("auth.logout"); return; }
  if (action === "refresh") { currentState = { ...currentState, route: "devices" }; await run("devices.refresh"); return; }
  if (action === "provisioning") {
    currentState = { ...currentState, route: "provisioning" };
    busy = true;
    render(currentState);
    try { setupState = await window.wanxSetup.reset(); }
    catch (error) { notice = error.message; }
    finally { busy = false; render(currentState); }
    return;
  }
  if (action === "start-provisioning") { startBluetoothSelection(); return; }
  if (action === "select-candidate") {
    if (discoverySessionId) window.wanxDiscovery?.select(discoverySessionId, target.dataset.candidateId);
    return;
  }
  if (action === "provisioning-confirm") { await run("provisioning.confirm"); return; }
  if (action === "provisioning-refresh") { await run("provisioning.refresh"); return; }
  if (action === "provisioning-owner") { await run("provisioning.owner"); return; }
  if (action === "cancel-provisioning") { provisioningTargetId = null; selectionPromise = undefined; window.wanxDeviceSetupTransport?.cancelSelection(); if (discoverySessionId) window.wanxDiscovery?.cancel(discoverySessionId); await run("provisioning.cancel"); return; }
  if (action === "connect") { await run("devices.connect", { deviceId: target.dataset.deviceId }); return; }
  if (action === "disconnect") { await run("devices.disconnect"); return; }
  if (action === "back-devices") { provisioningTargetId = null; currentState = { ...currentState, route: "devices" }; render(currentState); return; }
  if (action === "health") {
    const input = document.querySelector("#base-url");
    const response = await window.wanxClient.checkHealth(input?.value.trim() || "");
    if (!response.ok) notice = response.code;
    render(response.state);
  }
});

app.addEventListener("submit", async (event) => {
  if (event.target.dataset.form === "wifi") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
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
  await run(authMode === "register" ? "auth.register" : "auth.login", data);
});

function acceptRemoteState(state) {
  // Network polling must not replace the wizard or discard the selected BLE device.
  if (currentState?.route === "provisioning" && state.route !== "auth") {
    currentState = { ...state, route: "provisioning" };
    return;
  }
  if (state.route === "auth") {
    window.wanxDeviceSetupTransport?.cancelSelection();
    selectionPromise = undefined;
    setupState = { state: "idle" };
  }
  render(state);
}
window.wanxClient.onLocalState(acceptRemoteState);
window.wanxSetup?.subscribe((snapshot) => {
  setupState = snapshot;
  if (currentState?.route === "provisioning") render(currentState);
});
window.wanxDiscovery?.subscribe((payload) => {
  if (!payload || typeof payload.sessionId !== "string") return;
  discoverySessionId = payload.sessionId;
  discoveryCandidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  if (currentState?.route === "provisioning") render(currentState);
}, () => {});
window.wanxSetup?.state().then((snapshot) => {
  setupState = snapshot;
  if (currentState?.route === "provisioning") render(currentState);
}).catch(() => {});
window.wanxSetup?.onReady?.(() => {
  setupReady = true;
  if (currentState) render(currentState);
  window.wanxSetup.resume?.().catch(() => {}).then(() => window.wanxSetup.state()).then((snapshot) => {
    setupState = snapshot;
    if (currentState?.route === "provisioning") render(currentState);
  }).catch(() => {});
});
window.wanxClient.getLocalState().then(acceptRemoteState);
