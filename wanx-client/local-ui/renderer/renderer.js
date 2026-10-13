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
let authMode = "login";
let authUsername = "";
let resendAt = 0;
let resendTimer;
let codeSent = false;
let notice = null;
let busy = false;
let provisioningTargetId = null;
let setupState = { state: "idle" };
let setupReady = false;
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
window.addEventListener?.("pagehide", () => selection.dispose(), { once: true });
window.addEventListener?.("pagehide", () => clearTimeout(resendTimer), { once: true });
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

function marketErrorMessage(error) {
  const message = String(error?.code || error?.message || error || "");
  const messages = {
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
      no_published_target: "暂无适用于此电脑平台的安装包，请联系管理员发布对应版本。",
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
  const platforms = { "macos:arm64": "macOS · Apple 芯片", "macos:x64": "macOS · Intel", "windows:arm64": "Windows · ARM64", "windows:x64": "Windows · x64" };
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

function marketActions(item, installed) {
  const candidate = marketCandidates.get(item.applicationId);
  const id = escapeHTML(item.applicationId);
  const previous = typeof item.previous === "string" ? item.previous : item.previous?.version;
  return `<div class="market-actions">
    ${candidate?.status === "available" ? `<button class="button ${installed ? "" : "primary"} small" data-action="market-install" data-application-id="${id}" ${busy || marketLoading ? "disabled" : ""}>${installed ? "更新应用" : "安装应用"}</button>` : ""}
    ${installed && previous ? `<button class="text-button" data-action="market-rollback" data-application-id="${id}" ${busy ? "disabled" : ""}>恢复上一版本</button>` : ""}
    ${installed ? `<button class="text-button danger-text" data-action="market-uninstall" data-application-id="${id}" ${busy ? "disabled" : ""}>卸载</button>` : ""}
  </div>`;
}

function applicationCard(item) {
  if (item.selectionRequired) {
    return `<article class="application-card"><h3>${escapeHTML(item.name)}</h3><p>历史版本无法自动比较，请选择当前版本。选择后仍需点击打开应用。</p><div class="application-card-footer version-choices">${item.versions.map(({ version }) => `<button class="button small" data-action="applications-select-current" data-application-id="${escapeHTML(item.applicationId)}" data-version="${escapeHTML(version)}" ${busy ? "disabled" : ""}>使用 ${escapeHTML(version)}</button>`).join("")}</div></article>`;
  }
  const candidate = marketCandidates.get(item.applicationId);
  const ready = currentState.canLaunchApplications;
  const label = ready ? "打开应用" : currentState.networkReady ? "连接盒子" : networkStatus().label;
  return `<article class="application-card">
    <div class="application-card-top"><div class="application-icon" aria-hidden="true">${escapeHTML(Array.from(item.name || "应")[0])}</div><span class="status-tag ready">已安装</span></div>
    <h3>${escapeHTML(item.name)}</h3><p class="application-description">${escapeHTML(item.description || "连接万象盒子，使用应用服务。")}</p>
    <div class="application-card-footer"><span class="muted">v${escapeHTML(item.version)}</span><button class="button primary small" data-action="${ready ? "applications-launch" : "show-settings"}" data-application-id="${escapeHTML(item.applicationId)}" ${busy || !currentState.networkReady ? "disabled" : ""}>${label}</button></div>
    <p class="market-status">${escapeHTML(candidateLabel(candidate))}</p>${candidateDetails(candidate)}${marketActions(item, true)}
  </article>`;
}

function marketCard(item) {
  const candidate = marketCandidates.get(item.applicationId);
  return `<article class="application-card market-card">
    <div class="application-card-top"><div class="application-icon" aria-hidden="true">${escapeHTML(Array.from(item.name || "应")[0])}</div><span class="status-tag">应用市场</span></div>
    <h3>${escapeHTML(item.name)}</h3><p class="application-description">${escapeHTML(item.description || "连接万象盒子，使用应用服务。")}</p>
    <p class="market-status">${escapeHTML(candidateLabel(candidate))}</p>${candidateDetails(candidate)}${marketActions(item, false)}
  </article>`;
}

function confirmationView() {
  if (!marketConfirmation) return "";
  return `<section class="market-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="market-confirm-title" aria-describedby="market-confirm-detail">
    <div class="market-confirm-card"><h2 id="market-confirm-title">${escapeHTML(marketConfirmation.title)}</h2><p id="market-confirm-detail">${escapeHTML(marketConfirmation.detail)}</p>
    <div class="market-actions"><button class="button" data-action="market-cancel">取消</button><button class="button primary" data-action="market-confirm">确认${escapeHTML(marketConfirmation.verb)}</button></div></div>
  </section>`;
}

function applicationsView() {
  const applications = currentState.applications || [];
  const installed = new Set(applications.map((item) => item.applicationId));
  const available = marketItems.filter((item) => !installed.has(item.applicationId));
  const connected = currentState.canLaunchApplications;
  return `<div class="app-layout" ${marketConfirmation ? "inert" : ""}>
    ${shellHeader("万象")}
    <section class="page-hero compact-hero"><div><p class="eyebrow">YOUR APPLICATIONS</p><h2>我的应用</h2><p class="lede">从应用市场安装应用，连接盒子后即可开始使用。</p></div></section>
    <section class="connection-banner ${connected ? "ready" : ""}" aria-label="应用连接状态"><div class="connection-summary"><span class="connection-indicator" aria-hidden="true"></span><div><span class="connection-caption">当前盒子</span><strong>${connected ? `已连接 ${escapeHTML(activeDeviceName())}` : currentState.networkReady ? "打开应用前，请先连接盒子" : networkStatus().label}</strong><p>${connected ? "应用将使用当前盒子中的服务。" : currentState.networkReady ? "在设置中选择一台设备，连接后返回这里打开应用。" : networkStatus().detail}</p></div></div><div class="connection-actions">${dashboardButton()}<button class="${connected ? "text-button" : "button small"}" data-action="show-settings">${connected ? "切换盒子" : currentState.networkReady ? "连接盒子" : "网络设置"}</button></div></section>
    ${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}
    <section class="content-section applications-section" aria-label="已安装应用"><div class="section-heading"><h2 class="small-heading">已安装应用</h2><span class="count">${applications.length} 个应用</span></div>${applications.length ? `<div class="application-grid">${applications.map(applicationCard).join("")}</div>` : '<div class="empty-state"><div class="empty-icon">＋</div><h3>安装你的第一个应用</h3><p>浏览下方应用市场，无需连接盒子即可安装。</p></div>'}</section>
    <section class="content-section market-section" aria-labelledby="market-heading" aria-busy="${marketLoading}"><div class="section-heading"><div><p class="eyebrow">APPLICATION MARKET</p><h2 id="market-heading" class="small-heading">应用市场</h2></div><button class="button small" data-action="market-refresh" ${marketLoading || busy ? "disabled" : ""}>${marketLoading ? "正在检查…" : "刷新与检查更新"}</button></div>
    <p class="muted">显示适用于当前电脑的应用版本。安装和更新无需连接盒子。</p>
    ${marketError ? `<div class="notice error" role="status">${escapeHTML(marketError)}</div>` : ""}
    ${available.length ? `<div class="application-grid">${available.map(marketCard).join("")}</div>` : `<p class="market-empty" role="status">${marketLoading ? "正在加载应用市场…" : marketError ? "加载未完成，可稍后刷新重试。" : marketItems.length ? "市场中的应用均已安装。" : "暂无已上架应用。"}</p>`}
    </section>
  </div>${confirmationView()}`;
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
  const { candidates, selecting, retained } = discoveryView;
  const discoveryBlock = selecting || retained ? `<div class="discovery-list"><p>${retained ? "扫描已结束，结果保留 2 分钟。请选择要配置的盒子：" : "选择要配置的盒子："}</p>${candidates.length ? candidates.map((candidate) => `<button class="device-card discovery-card" data-action="select-candidate" data-candidate-id="${escapeHTML(candidate.candidateId)}" ${selecting && retained ? "disabled" : ""}><strong>${escapeHTML(candidate.advertisedName || "CentaurOS 盒子")}</strong><span>BLE 配网设备</span></button>`).join("") : "<p>正在等待附近的盒子，请确认盒子已进入配置模式。</p>"}</div>` : "";
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
  const form = document.querySelector('#auth-form');
  const auth = state.route === "auth" || state.phase === "signed_out" || state.phase === "authenticating";
  // Keep in-progress credentials and focus through IPC replies and background polling.
  // Restore input properties, never interpolate passwords into HTML.
  const draft = auth && form?.dataset.mode === authMode ? Object.fromEntries(new FormData(form)) : null;
  const focused = draft && form.contains(document.activeElement) ? document.activeElement : null;
  const cursor = focused ? [focused.selectionStart, focused.selectionEnd] : null;
  if (auth && form) authUsername = form.elements.username.value.trim();
  currentState = state;
  if (auth) app.innerHTML = authView();
  else if (page === "provisioning") app.innerHTML = provisioningView();
  else if (page === "settings") app.innerHTML = settingsView();
  else app.innerHTML = applicationsView();
  if (draft) {
    const next = document.querySelector('#auth-form');
    for (const [name, value] of Object.entries(draft)) if (next?.elements[name]) next.elements[name].value = value;
    const input = focused && next?.elements[focused.name];
    input?.focus();
    if (input?.setSelectionRange && cursor[0] !== null) input.setSelectionRange(...cursor);
  }
  if (marketConfirmation) app.querySelector?.('[data-action="market-cancel"]')?.focus();
}

async function run(action, input = {}) {
  notice = null;
  codeSent = false;
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
      SMS_CODE_INVALID: "验证码错误或已过期，请重新获取。",
      SMS_RATE_LIMITED: "验证码发送过于频繁，请稍后重试。",
      SMS_DAILY_LIMIT: "该手机号今日验证码发送次数已达上限，请明日再试。",
      PASSWORD_ALREADY_SET: "该手机号已注册，请使用密码登录。",
      PASSWORD_WEAK: "密码需为 8–72 字节，且不能包含换行符。",
      PASSWORD_INVALID: "手机号或密码不正确，请重新输入。",
      PASSWORD_NOT_SET: "该账号尚未设置密码，请先完成注册。",
      ACCOUNT_NETWORK_ERROR: "无法连接账号服务，请检查网络后重试。",
      ACCOUNT_REQUEST_FAILED: "账号请求失败，请稍后重试。",
      ACCOUNT_INVALID_INPUT: "请检查手机号、密码和验证码格式。",
      ACCOUNT_LOGIN_REQUIRED: "请先登录万象。",
      NETWORK_NOT_READY: "网络尚未连接，请在设置中检查网络状态。",
      BOX_CONNECTION_REQUIRED: "请先在设置中连接一台盒子，再打开应用或 Dashboard。",
      NETWORK_CHANGED: "盒子连接已变化，请重新连接后打开应用。",
      BOX_IDENTITY_UNAVAILABLE: "暂时无法访问盒端服务，请重新连接盒子。",
      BOX_IDENTITY_INVALID: "盒端服务返回了无效身份，请重新连接盒子。",
      DASHBOARD_OPEN_FAILED: "Dashboard 打开失败，请检查盒子连接后重试。",
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
    const code = Object.keys(messages).find(value => error.message.includes(value));
    if (action === "auth.send-code" && code === "SMS_RATE_LIMITED") {
      resendAt = Date.now() + 60000;
      updateResendButton();
    }
    notice = messages[code] || marketErrorMessage(error);
    render(currentState);
    return null;
  } finally {
    if (holdBusy) busy = false;
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
    const result = await run(confirmation.action, { applicationId: confirmation.applicationId });
    if (result) await refreshMarket();
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
  if (action === "market-refresh") { await refreshMarket(); return; }
  if (["market-install", "market-uninstall", "market-rollback"].includes(action)) {
    const applicationId = target.dataset.applicationId;
    const installed = (currentState.applications || []).find((item) => item.applicationId === applicationId);
    const item = installed || marketItems.find((item) => item.applicationId === applicationId);
    if (!item) return;
    const candidate = marketCandidates.get(applicationId);
    if (action === "market-install" && (marketLoading || candidate?.status !== "available")) return;
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
  if (action === "refresh") { page = "settings"; await run("devices.refresh"); return; }
  if (action === "network-toggle") { await run("network.set-enabled", { enabled: currentState.network?.enabled === false }); return; }
  if (action === "provisioning") {
    selection.reset();
    page = "provisioning";
    busy = true;
    render(currentState);
    try { setupState = await window.wanxSetup.reset(); }
    catch (error) { notice = error.message; }
    finally { busy = false; render(currentState); }
    return;
  }
  if (action === "start-provisioning") { selection.start(); return; }
  if (action === "select-candidate") { selection.choose(target.dataset.candidateId); return; }
  if (action === "provisioning-confirm") { await run("provisioning.confirm"); return; }
  if (action === "provisioning-refresh") { await run("provisioning.refresh"); return; }
  if (action === "provisioning-owner") { await run("provisioning.owner"); return; }
  if (action === "cancel-provisioning") { provisioningTargetId = null; selection.reset(); await run("provisioning.cancel"); return; }
  if (action === "connect") { if (currentState.networkReady) await run("devices.connect", { deviceId: target.dataset.deviceId }); return; }
  if (action === "disconnect") { await run("devices.disconnect"); return; }
  if (action === "back-devices") { provisioningTargetId = null; selection.reset(); page = "settings"; notice = null; render(currentState); return; }
  if (action === "applications-select-current") {
    await run("applications.select-current", { applicationId: target.dataset.applicationId, version: target.dataset.version });
    return;
  }
  if (action === "applications-launch") {
    if (!currentState.canLaunchApplications) {
      page = "settings";
      notice = "请先连接一台盒子，再打开应用。";
      render(currentState);
      return;
    }
    await run("applications.launch", { applicationId: target.dataset.applicationId });
    return;
  }
});

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
    return;
  }
  if (state.route === "auth" || accountChanged) {
    page = "applications";
    selection.reset();
    marketItems = [];
    marketCandidates = new Map();
    marketConfirmation = null;
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
  page = destination;
  notice = null;
  render(currentState);
});
window.wanxSetup?.subscribe((snapshot) => {
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
