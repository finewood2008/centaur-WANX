const app = document.querySelector("#app");
let currentState;
let page = "applications";
let applicationSource = "";
let directoryInstallOpen = false;
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
  const selected = currentState.activeDeviceId === device.deviceId;
  const action = selected
    ? `<button class="button small" data-action="disconnect" ${busy ? "disabled" : ""}>断开连接</button>`
    : available && currentState.networkReady
      ? `<button class="button primary small" data-action="connect" data-device-id="${escapeHTML(device.deviceId)}" ${busy || device.canOpen === false ? "disabled" : ""}>${device.canOpen === false ? "设备暂不可用" : currentState.activeDeviceId ? "切换并连接" : "连接"}</button>`
    : available
      ? `<button class="button primary small" disabled>${networkStatus().label}</button>`
    : `<button class="button small" data-action="provisioning" data-device-id="${escapeHTML(device.deviceId)}" ${busy ? "disabled" : ""}>开始初始化</button>`;
  return `
    <article class="device-card ${selected ? "selected" : ""}">
      <img class="device-icon" src="./assets/centaurai-mark.png" alt="" />
      <div class="device-main">
        <div class="device-title-row">
          <h3>${escapeHTML(device.name)}</h3>
          <span class="status-tag ${available ? "ready" : "pending"}">${selected ? "当前连接" : escapeHTML(lifecycleLabels[device.lifecycle] || "待处理")}</span>
        </div>
        <p class="device-id">${escapeHTML(device.deviceId)}</p>
        <div class="device-meta"><span>${escapeHTML(statusLabel(device))}</span><span>${device.initialized ? "已完成初始化" : "尚未初始化"}</span></div>
      </div>
      <div class="device-action">${action}</div>
    </article>`;
}

function networkStatus() {
  if (currentState.network?.enabled === false) return { label: "网络已关闭", detail: "开启网络后，即可连接盒子并使用应用。" };
  if (currentState.networkReady) return { label: "网络已连接", detail: "请选择一台盒子，应用将使用该设备中的服务。" };
  if (currentState.platform?.phase === "unavailable" || ["unavailable", "failed", "error"].includes(currentState.network?.phase))
    return { label: "网络暂不可用", detail: "请检查本机网络后重试连接。" };
  return { label: "网络连接中", detail: "正在准备网络，准备完成后即可连接盒子。" };
}

function activeDeviceName() {
  return currentState.devices?.find((device) => device.deviceId === currentState.activeDeviceId)?.name || currentState.connection?.name || currentState.activeDeviceId;
}

function shellHeader(title, eyebrow = "") {
  const account = currentState.account?.displayName || currentState.account?.id || "万象用户";
  return `
    <header class="topbar">
      <img class="brand-mark" src="../../resources/icon.png" alt="" />
      <div class="brand-names"><strong class="brand-name">半人马AI-万象</strong><span class="brand-english">CentaurAI-WANX</span></div>
      <h1 class="sr-only">${title}</h1>
      <div class="topbar-spacer"></div>
      <div class="topbar-tools">
        <span class="account-chip" title="${escapeHTML(account)}">${escapeHTML(account)}</span>
        <button class="button settings-button ${page === "settings" ? "active" : ""}" data-action="show-settings" ${page === "settings" ? 'aria-current="page"' : ""} ${page === "provisioning" ? "disabled" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></svg>设置</button>
      </div>
    </header>
    ${eyebrow ? `<div class="section-label">${eyebrow}</div>` : ""}`;
}

function authView() {
  const register = authMode === "register";
  return `
    <div class="auth-layout">
      <section class="auth-intro">
        <div class="auth-brand"><img class="brand-mark large" src="../../resources/icon.png" alt="" /><div class="brand-names"><strong class="brand-name">半人马AI-万象</strong><span class="brand-english">CentaurAI-WANX</span></div></div>
        <p class="eyebrow">万象 · 应用工作台</p>
        <h1>你的应用，<br />连接你的万象盒子</h1>
        <p class="lede">登录后管理应用，连接一台盒子，即可使用设备中的服务。</p>
        <div class="flow-preview"><span>登录万象</span><i>→</i><span>连接盒子</span><i>→</i><span>打开应用</span></div>
      </section>
      <section class="auth-card">
        <div class="card-kicker">${register ? "创建平台账号" : "欢迎回来"}</div>
        <h2>${register ? "注册万象平台" : "登录万象平台"}</h2>
        <p class="muted">使用万象平台账号进入应用首页。</p>
        <div class="tabs"><button class="tab ${!register ? "active" : ""}" data-action="auth-login">登录</button><button class="tab ${register ? "active" : ""}" data-action="auth-register">注册</button></div>
        <form id="auth-form" data-form="auth">
          <label for="account-name">手机号</label>
          <input id="account-name" name="username" value="${escapeHTML(authUsername)}" required pattern="1[0-9]{10}" autocomplete="username" placeholder="13800138000" />
          <label for="account-password">密码</label>
          <input id="account-password" name="password" type="password" required minlength="8" autocomplete="${register ? "new-password" : "current-password"}" placeholder="输入密码" />
          ${register ? '<label for="account-code">短信验证码</label><div class="code-field"><input id="account-code" name="code" required pattern="[0-9]{6}" placeholder="输入 6 位验证码" /><button class="button small" type="button" data-action="send-registration-code">获取验证码</button></div>' : ""}
          <button class="button primary wide" type="submit" ${busy ? "disabled" : ""}>${busy ? "处理中…" : register ? "创建账号并进入" : "登录并进入"}</button>
        </form>
        ${notice ? `<div class="notice error">${escapeHTML(notice)}</div>` : ""}
      </section>
    </div>`;
}

function settingsView() {
  const available = currentState.availableDevices || [];
  const pending = (currentState.devices || []).filter((device) => !available.some((item) => item.deviceId === device.deviceId));
  const network = networkStatus();
  const enabled = currentState.network?.enabled !== false;
  return `
    <div class="app-layout">
      ${shellHeader("设置")}
      <section class="page-hero compact-hero">
        <div><p class="eyebrow">SETTINGS</p><h2>设备与网络</h2><p class="lede">在这里管理设备、连接网络，以及切换应用使用的盒子。</p></div>
        <button class="button" data-action="show-applications">返回应用</button>
      </section>
      ${notice ? `<div class="notice error">${escapeHTML(notice)}</div>` : ""}
      <section class="settings-panel network-panel" aria-labelledby="network-heading">
        <div><h2 id="network-heading" class="small-heading">网络</h2><p class="network-label">${network.label}</p><p class="muted">${network.detail}</p></div>
        <div class="settings-actions">${enabled && network.label === "网络暂不可用" ? `<button class="button small" data-action="refresh" ${busy ? "disabled" : ""}>重试连接</button>` : ""}<button class="button" role="switch" aria-checked="${enabled}" aria-label="万象网络" data-action="network-toggle" ${busy ? "disabled" : ""}>${enabled ? "关闭网络" : "开启网络"}</button></div>
      </section>
      <section class="settings-panel"><div class="section-heading"><div><p class="eyebrow">CURRENT DEVICE</p><h2 class="small-heading">当前盒子</h2></div>${currentState.activeDeviceId ? '<span class="status-tag ready">已连接</span>' : '<span class="status-tag pending">未连接</span>'}</div>
        <p class="current-device">${currentState.activeDeviceId ? escapeHTML(activeDeviceName()) : "尚未连接盒子"}</p><p class="muted">${currentState.activeDeviceId ? "应用将连接此设备中的服务。切换或断开盒子后，请重新打开应用。" : "从下方设备列表选择并连接一台盒子，然后返回应用首页。"}</p>
        ${currentState.activeDeviceId ? `<div class="current-device-actions">${dashboardButton()}<button class="text-button" data-action="disconnect" ${busy ? "disabled" : ""}>断开当前盒子</button></div>` : ""}
      </section>
      <section class="content-section"><div class="section-heading"><div><p class="eyebrow">YOUR DEVICES</p><h2 class="small-heading">设备管理 <span class="count">${available.length}</span></h2></div><div class="settings-actions"><button class="text-button" data-action="refresh" ${busy ? "disabled" : ""}>刷新列表</button><button class="button small" data-action="provisioning" ${busy ? "disabled" : ""}>＋ 发现新盒子</button></div></div>
        ${available.length && !currentState.networkReady ? `<div class="notice">${network.label}，${network.detail}</div>` : ""}
        ${available.length ? `<div class="device-list">${available.map((device) => deviceCard(device, true)).join("")}</div>` : '<div class="empty-state"><div class="empty-icon">＋</div><h3>还没有可用盒子</h3><p>点击“发现新盒子”，开始完成设备接入。</p><button class="button primary" data-action="provisioning">开始发现</button></div>'}
      </section>
      ${pending.length ? `<section class="content-section pending-section"><div class="section-heading"><div><p class="eyebrow">SETUP REQUIRED</p><h2 class="small-heading">待处理设备 <span class="count">${pending.length}</span></h2></div></div><div class="device-list">${pending.map((device) => deviceCard(device, false)).join("")}</div></section>` : ""}
      <section class="settings-panel account-panel"><div><h2 class="small-heading">账号</h2><p class="muted">${escapeHTML(currentState.account?.displayName || currentState.account?.accountId || "万象用户")}</p></div><button class="button" data-action="logout" ${busy ? "disabled" : ""}>退出登录</button></section>
    </div>`;
}

function dashboardButton() {
  return currentState.canOpenDashboard
    ? `<button class="button small" data-action="dashboard-open" ${busy ? "disabled" : ""}>打开 Dashboard</button>`
    : "";
}

function applicationCard(item) {
  const ready = currentState.canLaunchApplications;
  const label = ready ? "打开应用" : currentState.networkReady ? "连接盒子" : networkStatus().label;
  return `<article class="application-card">
    <div class="application-card-top"><div class="application-icon" aria-hidden="true">${escapeHTML(Array.from(item.name || "应")[0])}</div><span class="status-tag ready">已安装</span></div>
    <h3>${escapeHTML(item.name)}</h3><p class="application-description">${escapeHTML(item.description || "连接万象盒子，使用应用服务。")}</p>
    <div class="application-card-footer"><span class="muted">v${escapeHTML(item.version)}</span><button class="button primary small" data-action="${ready ? "applications-launch" : "show-settings"}" data-application-id="${escapeHTML(item.applicationId)}" data-version="${escapeHTML(item.version)}" ${busy || !currentState.networkReady ? "disabled" : ""}>${label}</button></div>
  </article>`;
}

function applicationsView() {
  const applications = currentState.applications || [];
  const connected = currentState.canLaunchApplications;
  return `<div class="app-layout">
    ${shellHeader("万象")}
    <section class="page-hero compact-hero"><div><p class="eyebrow">YOUR APPLICATIONS</p><h2>我的应用</h2><p class="lede">你的应用入口，连接盒子后即可开始使用。</p></div></section>
    <section class="connection-banner ${connected ? "ready" : ""}" aria-label="应用连接状态"><div class="connection-summary"><span class="connection-indicator" aria-hidden="true"></span><div><span class="connection-caption">当前盒子</span><strong>${connected ? `已连接 ${escapeHTML(activeDeviceName())}` : currentState.networkReady ? "打开应用前，请先连接盒子" : networkStatus().label}</strong><p>${connected ? "应用将使用当前盒子中的服务。" : currentState.networkReady ? "在设置中选择一台设备，连接后返回这里打开应用。" : networkStatus().detail}</p></div></div><div class="connection-actions">${dashboardButton()}<button class="${connected ? "text-button" : "button small"}" data-action="show-settings">${connected ? "切换盒子" : currentState.networkReady ? "连接盒子" : "网络设置"}</button></div></section>
    ${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}
    <section class="content-section applications-section" aria-label="已安装应用"><div class="section-heading"><h2 class="small-heading">已安装应用</h2><span class="count">${applications.length} 个应用</span></div>${applications.length ? `<div class="application-grid">${applications.map(applicationCard).join("")}</div>` : '<div class="empty-state"><div class="empty-icon">＋</div><h3>安装你的第一个应用</h3><p>选择下载好的应用压缩包安装，连接盒子后即可打开。</p></div>'}</section>
    <section class="install-panel"><h2 class="small-heading">安装应用</h2><p class="muted">选择下载好的 ZIP 安装包，万象会自动解压并安装。</p><button class="button primary" data-action="applications-install" ${busy ? "disabled" : ""}>选择安装包</button><details id="directory-install" ${directoryInstallOpen ? "open" : ""}><summary>开发者：从目录安装</summary><form class="install-form" data-form="install"><label class="sr-only" for="application-source">应用目录</label><input id="application-source" name="sourceDir" value="${escapeHTML(applicationSource)}" placeholder="输入应用目录路径" spellcheck="false" required /><button class="button" type="submit" ${busy ? "disabled" : ""}>安装应用</button></form></details></section>
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
      <section class="wizard-hero"><div><p class="eyebrow">NEW DEVICE SETUP</p><h2>把一台新盒子加入你的平台</h2><p class="lede">按照发现、身份确认、配网、认领和初始化顺序完成接入。未完成的设备不会进入可用列表。</p></div><div class="wizard-orb">${running ? "…" : '<img src="./assets/centaurai-mark.png" alt="半人马AI-万象" />'}</div></section>
      <section class="wizard-card"><div class="wizard-steps">${stages.map(([key, label], index) => { const active = provisioning.stage === key; const done = provisioning.phase === "ready" || stages.findIndex(([name]) => name === provisioning.stage) > index; return `<div class="wizard-step ${active ? "active" : ""} ${done ? "done" : ""}"><span>${done ? "✓" : index + 1}</span><label>${label}</label></div>`; }).join("")}</div>
        <div class="wizard-copy"><p class="eyebrow">${running ? "正在处理" : provisioning.phase === "failed" ? "接入未完成" : "设备配置"}</p><h3>${running ? escapeHTML(stageLabels[provisioning.stage] || "处理中") : setupPhase === "idle" ? "发现附近的万象盒子" : "配置设备"}</h3><p>${provisioning.phase === "failed" ? escapeHTML(provisioning.error?.message || "本次接入失败") : escapeHTML(setupCopy)}</p>${discoveryBlock}${previewBlock}${controls}</div>
        <div class="wizard-actions">${running ? '<button class="button" disabled>返回设置</button><button class="button danger" data-action="cancel-provisioning">取消</button>' : `<button class="button" data-action="back-devices">返回设置</button>${["idle", "cancelled"].includes(setupPhase) || provisioning.phase === "failed" ? `<button class="button primary" data-action="start-provisioning" ${busy || !setupReady ? "disabled" : ""}>${provisioning.phase === "failed" ? "重新扫描" : "开始扫描盒子"}</button>` : setupPhase === "completed" ? '<button class="button primary" data-action="refresh">返回设备管理</button>' : '<button class="button danger" data-action="cancel-provisioning">取消</button>'}</div>`}
        ${setupPhase === "attentionRequired" ? '<button class="button" data-action="provisioning-refresh">刷新授权状态</button>' : ""}
        ${notice ? `<div class="notice error">${escapeHTML(notice)}</div>` : ""}
        ${!setupReady ? '<p class="hint">正在准备蓝牙配网服务…</p>' : ""}
      </section>
    </div>`;
}

function render(state) {
  currentState = state;
  if (state.route === "auth" || state.phase === "signed_out" || state.phase === "authenticating") app.innerHTML = authView();
  else if (page === "provisioning") app.innerHTML = provisioningView();
  else if (page === "settings") app.innerHTML = settingsView();
  else app.innerHTML = applicationsView();
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
    if (response.state) acceptRemoteState(response.state);
    if (!response.ok) throw new Error(response.code);
    return response;
  } catch (error) {
    const messages = {
      ACCOUNT_LOGIN_REQUIRED: "请先登录万象。",
      NETWORK_NOT_READY: "网络尚未连接，请在设置中检查网络状态。",
      BOX_CONNECTION_REQUIRED: "请先在设置中连接一台盒子，再打开应用或 Dashboard。",
      NETWORK_CHANGED: "盒子连接已变化，请重新连接后打开应用。",
      BOX_IDENTITY_UNAVAILABLE: "暂时无法访问盒端服务，请重新连接盒子。",
      BOX_IDENTITY_INVALID: "盒端服务返回了无效身份，请重新连接盒子。",
      DASHBOARD_OPEN_FAILED: "Dashboard 打开失败，请检查盒子连接后重试。",
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
    const code = Object.keys(messages).find(value => error.message.includes(value));
    notice = messages[code] || error.message;
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
  if (action === "show-applications" || action === "show-settings") {
    if (page === "provisioning") return;
    page = action === "show-applications" ? "applications" : "settings";
    notice = null;
    render(currentState);
    return;
  }
  if (busy && action !== "cancel-provisioning") return;
  if (action === "dashboard-open") {
    if (currentState.canOpenDashboard) await run("dashboard.open");
    return;
  }
  if (action === "refresh") { page = "settings"; await run("devices.refresh"); return; }
  if (action === "network-toggle") { await run("network.set-enabled", { enabled: currentState.network?.enabled === false }); return; }
  if (action === "provisioning") {
    page = "provisioning";
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
  if (action === "connect") { if (currentState.networkReady) await run("devices.connect", { deviceId: target.dataset.deviceId }); return; }
  if (action === "disconnect") { await run("devices.disconnect"); return; }
  if (action === "back-devices") { provisioningTargetId = null; page = "settings"; notice = null; render(currentState); return; }
  if (action === "applications-install") { await run("applications.install"); return; }
  if (action === "applications-launch") {
    if (!currentState.canLaunchApplications) {
      page = "settings";
      notice = "请先连接一台盒子，再打开应用。";
      render(currentState);
      return;
    }
    await run("applications.launch", { applicationId: target.dataset.applicationId, version: target.dataset.version });
    return;
  }
});

app.addEventListener("input", (event) => {
  if (event.target.id === "application-source") applicationSource = event.target.value;
});

app.addEventListener("toggle", (event) => {
  if (event.target.id === "directory-install") directoryInstallOpen = event.target.open;
}, true);

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  if (event.target.dataset.form === "install") {
    const data = Object.fromEntries(new FormData(event.target));
    applicationSource = String(data.sourceDir || "").trim();
    await run("applications.install", { sourceDir: applicationSource });
    return;
  }
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
  // Page selection belongs to the UI; network polling only updates its data.
  // Do not discard in-progress Wi-Fi input or the selected BLE device.
  if (page === "provisioning" && state.route !== "auth") {
    currentState = state;
    return;
  }
  if (state.route === "auth") {
    page = "applications";
    applicationSource = "";
    directoryInstallOpen = false;
    window.wanxDeviceSetupTransport?.cancelSelection();
    selectionPromise = undefined;
    setupState = { state: "idle" };
  }
  render(state);
}
window.wanxClient.onLocalState(acceptRemoteState);
window.wanxClient.onNavigate?.((destination) => {
  if (!currentState || currentState.route === "auth" || page === "provisioning") return;
  page = destination;
  notice = null;
  render(currentState);
});
window.wanxSetup?.subscribe((snapshot) => {
  setupState = snapshot;
  if (page === "provisioning") render(currentState);
});
window.wanxDiscovery?.subscribe((payload) => {
  if (!payload || typeof payload.sessionId !== "string") return;
  discoverySessionId = payload.sessionId;
  discoveryCandidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  if (page === "provisioning") render(currentState);
}, () => {});
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
