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
let authUsername = "";
let notice = null;
const localOperations = new Map();
let pendingSelection = null;
const expandedDetails = new Set();
let busy = false;
let setupState = { state: "idle" };
let selectedCandidate;
let setupReady = false;
let discoveryCandidates = [];
let discoverySessionId = null;
let selectionPromise;
let retainedDiscovery;
let discoveryExpiry;
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
    <div class="device-action">${action}</div></article>`;
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

function authView() {
  return `<div class="auth-layout"><section class="auth-card">
    <button class="auth-brand brand-button" data-action="desktop-about" aria-label="关于万象"><img class="brand-mark" src="./assets/centaurai-mark.png" alt="半人马" /><span class="brand-copy"><strong>半人马AI-万象</strong><small>CentaurAI-WanX</small></span></button>
    <h1>登录万象平台</h1><p class="muted">连接你的盒子，发现和使用 AI 应用。</p>
    <form id="auth-form" data-form="auth">
      <label for="account-name">手机号</label><input id="account-name" name="username" value="${escapeHTML(authUsername)}" required pattern="1[0-9]{10}" autocomplete="username" placeholder="输入手机号" />
      <label for="account-password">密码</label><input id="account-password" name="password" type="password" required autocomplete="current-password" placeholder="输入密码" />
      <button class="button primary wide" type="submit" ${busy ? "disabled" : ""}>${busy ? "正在登录…" : "登录"}</button>
    </form>${notice ? `<div class="notice error" role="status">${escapeHTML(notice)}</div>` : ""}
    <p class="auth-footnote">使用已有的万象平台账号登录</p></section></div>`;
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
  </div></div>${confirmationView()}`;
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
    <div class="page-heading"><div><h2>应用商店</h2><p class="muted">发现适合你的 AI 应用。安装与更新无需连接盒子。</p></div><button class="text-button" data-action="market-refresh" ${marketLoading ? "disabled" : ""}>${marketLoading ? "正在检查…" : "检查更新"}</button></div>
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
      !/^CentaurOS-(?:Setup-[0-9a-f]*|[0-9a-f]*)$/i.test(name) ? name : "";
  };
  const knownName = boxName(known?.name) || boxName(known?.displayName);
  const specificName = deviceId && boxName(hint?.displayName);
  const advertisedName = candidate.advertisedName || "";
  const scanning = selectionPromise && !retainedDiscovery;
  const reading = !deviceId && scanning && candidate.nameSource === "advertisement";
  const resolvedName = knownName || specificName;
  const title = resolvedName || (reading ? "正在读取盒子名称…" : "未获取到盒子名称");
  const detail = !deviceId && scanning && !reading
    ? [advertisedName, "选择后核对设备身份"].filter(Boolean).join(" · ")
    : [advertisedName, !deviceId ? reading ? "正在读取盒子名称…" : "未读取到名称" : "", "蓝牙配网"].filter(Boolean).join(" · ");
  const identityDetail = deviceId && !resolvedName
    ? `<span>设备编号：${escapeHTML(deviceId)}（用于核对，不是名称）</span>` : "";
  return `<button class="device-card discovery-card" data-action="select-candidate" data-candidate-id="${escapeHTML(candidate.candidateId)}" ${selectionPromise && retainedDiscovery ? "disabled" : ""}><strong>${escapeHTML(title)}</strong>${identityDetail}<span>${escapeHTML(detail)}</span></button>`;
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
    error: { message: setupErrorMessage(setupState.errorCode) },
  };
  const running = provisioning.phase === "running";
  const preview = setupState.preview || setupState.compatiblePreview;
  const previewBlocked = preview?.cloud_enrollment_status === "not_enrolled" ? "DEVICE_NOT_ENROLLED" :
    preview?.pairing_mode_remaining_seconds === 0 ? "PAIRING_MODE_CLOSED" : null;
  const setupPhase = setupState.state || "idle";
  const stages = Object.entries(stageLabels);
  const setupCopy = {
    idle: "请让盒子进入蓝牙配网模式，然后点击扫描并选择附近的盒子。",
    attentionRequired: "盒子授权尚未完成，请检查盒子联网状态后刷新。",
    previewReady: previewBlocked ? setupErrorMessage(previewBlocked) : "请核对设备 ID、型号和身份指纹，然后确认。",
    awaitingWifi: "设备身份已验证，请输入设备要连接的 Wi‑Fi。",
    awaitingOwnershipConfirmation: "设备已准备联网，请确认绑定到当前账号。",
    submittingAppProof: "正在提交账号绑定证明…",
    provisioningWifi: "正在通过加密通道配置 Wi‑Fi…",
    waitingCloud: "正在等待设备联网并完成平台授权…",
    completed: "设备已完成联网和账号绑定。",
    cancelled: "本次配网已取消。",
  }[setupPhase] || "请让设备进入配置模式后开始扫描。";
  const previewBlock = preview ? `<dl class="setup-preview"><dt>设备名称</dt><dd>${escapeHTML(preview.display_name)}</dd><dt>设备 ID</dt><dd>${escapeHTML(preview.device_id)}</dd><dt>型号</dt><dd>${escapeHTML(preview.model)}</dd><dt>身份公钥指纹</dt><dd>${escapeHTML(preview.identity_public_key_sha256)}</dd></dl>` : "";
  const candidates = retainedDiscovery?.candidates || discoveryCandidates;
  const discoveryBlock = selectionPromise || retainedDiscovery ? `<div class="discovery-list"><p>${retainedDiscovery ? "扫描已结束，结果保留 2 分钟。请选择要配置的盒子：" : "选择要配置的盒子："}</p>${candidates.length ? candidates.map(discoveryCard).join("") : "<p>正在等待附近的盒子，请确认盒子已进入配置模式。</p>"}</div>` : "";
  const controls = setupPhase === "previewReady"
    ? `<button class="button primary" data-action="provisioning-confirm" ${busy || previewBlocked ? "disabled" : ""}>${previewBlocked ? "盒子尚未准备好配网" : "确认设备身份"}</button>`
    : setupPhase === "awaitingWifi"
      ? `<form class="setup-wifi" data-form="wifi"><label>Wi‑Fi 名称<input name="ssid" required maxlength="32" autocomplete="off" /></label><label>安全类型<select name="security"><option value="wpa_personal">WPA/WPA2 个人网络</option><option value="open">开放网络</option></select></label><label>密码<input name="password" type="password" maxlength="128" autocomplete="off" /></label><label class="check"><input name="hidden" type="checkbox" />隐藏网络</label><button class="button primary" type="submit" ${busy ? "disabled" : ""}>继续绑定账号</button></form>`
      : setupPhase === "awaitingOwnershipConfirmation"
        ? `<button class="button primary" data-action="provisioning-owner" ${busy ? "disabled" : ""}>确认绑定到当前账号</button>`
        : "";
  return `
    <div class="app-layout">
      ${shellHeader("发现并配置盒子")}<div class="page-content">
      <div class="page-heading"><div><h2>发现新盒子</h2><p class="muted">核对身份，连接网络，然后绑定到你的账号。</p></div></div>
      <section class="wizard-card"><div class="wizard-steps">${stages.map(([key, label], index) => { const active = provisioning.stage === key; const done = provisioning.phase === "ready" || stages.findIndex(([name]) => name === provisioning.stage) > index; return `<div class="wizard-step ${active ? "active" : ""} ${done ? "done" : ""}"><span>${done ? "✓" : index + 1}</span><label>${label}</label></div>`; }).join("")}</div>
        <div class="wizard-copy"><p class="eyebrow">${running ? "正在处理" : provisioning.phase === "failed" ? "接入未完成" : "设备配置"}</p><h3>${running ? escapeHTML(stageLabels[provisioning.stage] || "处理中") : setupPhase === "idle" ? "发现附近的万象盒子" : "配置设备"}</h3><p>${provisioning.phase === "failed" ? escapeHTML(provisioning.error?.message || "本次接入失败") : escapeHTML(setupCopy)}</p>${discoveryBlock}${previewBlock}${controls}</div>
        <div class="wizard-actions">${running ? '<button class="button" disabled>返回盒子</button><button class="button danger" data-action="cancel-provisioning">取消</button>' : `<button class="button" data-action="back-devices">返回盒子</button>${["idle", "cancelled"].includes(setupPhase) || provisioning.phase === "failed" ? `<button class="button primary" data-action="start-provisioning" ${busy || !setupReady ? "disabled" : ""}>${provisioning.phase === "failed" ? "重新扫描" : "开始扫描盒子"}</button>` : setupPhase === "completed" ? '<button class="button primary" data-action="refresh">完成</button>' : '<button class="button danger" data-action="cancel-provisioning">取消</button>'}</div>`}
        ${setupPhase === "attentionRequired" ? '<button class="button" data-action="provisioning-refresh">刷新授权状态</button>' : ""}
        ${notice ? `<div class="notice error">${escapeHTML(notice)}</div>` : ""}
        ${!setupReady ? '<p class="hint">正在准备蓝牙配网服务…</p>' : ""}
      </section></div>
    </div>`;
}

function render(state) {
  currentState = state;
  // Reuse the actual Wi-Fi form when setup updates. This preserves typed secrets,
  // selection and focus; network polling does not rebuild active setup forms.
  const wifiForm = page === "provisioning" && setupState.state === "awaitingWifi" ? app.querySelector?.('[data-form="wifi"]') : null;
  const authForm = state.route === "auth" ? app.querySelector?.('[data-form="auth"]') : null;
  const retainedForm = wifiForm || authForm;
  const focused = retainedForm?.contains(document.activeElement) ? document.activeElement : null;
  if (state.route === "auth" || state.phase === "signed_out" || state.phase === "authenticating") app.innerHTML = authView();
  else if (page === "provisioning") app.innerHTML = provisioningView();
  else if (page === "boxes") app.innerHTML = boxesView();
  else if (page === "settings") app.innerHTML = settingsView();
  else app.innerHTML = applicationsView();
  if (retainedForm) {
    const formName = wifiForm ? "wifi" : "auth";
    app.querySelector?.(`[data-form="${formName}"]`)?.replaceWith(retainedForm);
    const submit = retainedForm.querySelector('button[type="submit"]');
    if (submit) {
      submit.disabled = busy;
      if (authForm) submit.textContent = busy ? "正在登录…" : "登录";
    }
    focused?.focus();
  }
  if (marketConfirmation) app.querySelector?.('[data-action="market-cancel"]')?.focus();
}

function setupErrorMessage(error) {
  const code = typeof error === "string" ? error : String(error?.code || error?.message || "");
  const messages = {
    DEVICE_NOT_ENROLLED: "盒子尚未完成平台注册，暂不能配网或绑定。请先由设备管理员完成注册，再让盒子进入配网模式并重新扫描。",
    PAIRING_MODE_CLOSED: "盒子尚未开启配网模式，或配网时间已结束。请在盒子上开启配网模式后重新扫描。",
    PROTOCOL_CHANGED: "盒子与客户端的配网协议未能匹配，接入已停止（PROTOCOL_CHANGED）。",
    DEVICE_IDENTITY_MISMATCH: "盒子身份校验未通过，接入已停止。请核对目标盒子。",
    LOCAL_TRANSPORT_DISCONNECTED: "蓝牙连接已断开，请靠近盒子并重新扫描。",
    LOCAL_CONNECT_TIMEOUT: "连接盒子超时，请确认盒子处于配网模式后重试。",
    GATT_FRAGMENT_INCOMPLETE: "未完整收到盒子的蓝牙响应，请靠近盒子后重试。",
    PAIRING_EXPIRED: "本次配网已过期，请让盒子重新进入配网模式。",
    CONTRACT_MISMATCH: "账号服务的配网响应不兼容，请联系管理员核对服务版本。",
    AUTH_SESSION_CHANGED: "登录状态已变化，请重新开始配网。",
  };
  const key = Object.keys(messages).find((key) => code.includes(key));
  return messages[key] || "盒子接入未完成，请重试；如仍失败，请联系管理员。";
}

function operationErrorMessage(error) {
  const message = typeof error === "string" ? error : String(error?.code || error?.message || "");
  const messages = {
      invalid_phone: "请输入有效的手机号。",
      invalid_credentials: "手机号或密码不正确，请重试。",
      account_unavailable: "暂时无法连接账号服务，请稍后重试。",
      session_expired: "登录已过期，请重新登录万象。",
      ACCOUNT_NETWORK_ERROR: "暂时无法连接账号服务，请检查网络后重试。",
      ACCOUNT_REQUEST_FAILED: "账号服务暂时不可用，请稍后重试。",
      ACCOUNT_SESSION_EXPIRED: "登录已过期，请重新登录万象。",
      ACCOUNT_ACCESS_DENIED: "当前账号无权执行此操作。",
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
  notice = null;
  const actionAccount = marketAccount;
  const applicationId = input.applicationId;
  const isAppOperation = Boolean(applicationId) && (action.startsWith("market.") || action.startsWith("applications."));
  if (isAppOperation && operationBusy(applicationId)) return null;
  const holdBusy = !isAppOperation && !["provisioning.start", "applications.confirm-open", "applications.cancel-open", "desktop.about"].includes(action);
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
    if (setupActions[action]) { setupState = await setupActions[action](); return { ok: true }; }
    const response = await window.wanxClient.action(action, input);
    if (response.state) acceptRemoteState(response.state);
    if (!response.ok) throw new Error(response.code);
    return response;
  } catch (error) {
    failure = action.startsWith("provisioning.") ? setupErrorMessage(error) : operationErrorMessage(error);
    if (!isAppOperation && actionAccount === marketAccount) notice = failure;
    return null;
  } finally {
    if (isAppOperation && actionAccount === marketAccount) {
      if (failure) localOperations.set(applicationId, { phase: "failed", error: failure });
      else localOperations.delete(applicationId);
    }
    if (holdBusy) busy = false;
    render(currentState);
  }
}

function forgetRetainedDiscovery() {
  clearTimeout(discoveryExpiry);
  discoveryExpiry = undefined;
  if (retainedDiscovery) window.wanxDiscovery?.forget(retainedDiscovery.sessionId);
  retainedDiscovery = undefined;
}

function stopBluetoothSelection() {
  selectionPromise = undefined;
  window.wanxDeviceSetupTransport?.cancelSelection();
  if (discoverySessionId) window.wanxDiscovery?.forget(discoverySessionId);
  forgetRetainedDiscovery();
  discoveryCandidates = [];
  discoverySessionId = null;
}

function retainDiscovery() {
  if (retainedDiscovery || !discoverySessionId || !discoveryCandidates.length) return;
  retainedDiscovery = { sessionId: discoverySessionId, candidates: [...discoveryCandidates] };
  discoveryExpiry = setTimeout(() => {
    stopBluetoothSelection();
    notice = "扫描结果已过期，请重新扫描盒子。";
    if (page === "provisioning") render(currentState);
  }, 120000);
}

function startBluetoothSelection(candidateId) {
  if (selectionPromise) return;
  if (!window.wanxDeviceSetupTransport) {
    notice = "当前运行时尚未接入本地配网能力";
    render(currentState);
    return;
  }
  const previous = candidateId && retainedDiscovery;
  if (candidateId && !previous?.candidates.some((candidate) => candidate.candidateId === candidateId)) return;
  if (!previous) stopBluetoothSelection();
  notice = null;
  discoveryCandidates = [];
  discoverySessionId = null;
  // Keep requestDevice synchronous within this click and obtain a fresh lease.
  if (previous) window.wanxDiscovery.reselect(previous.sessionId, candidateId);
  selectionPromise = window.wanxDeviceSetupTransport.requestDeviceFromUserGesture();
  render(currentState);
  const attempt = selectionPromise;
  selectionPromise.then(
    (candidate) => {
      if (selectionPromise !== attempt) return;
      selectedCandidate = candidate;
      selectionPromise = undefined;
      forgetRetainedDiscovery();
      discoveryCandidates = [];
      discoverySessionId = null;
      render(currentState);
      void run("provisioning.start", { candidate });
    },
    (error) => {
      if (selectionPromise !== attempt) return;
      retainDiscovery();
      if (discoverySessionId) window.wanxDiscovery?.cancel(discoverySessionId);
      selectionPromise = undefined;
      discoveryCandidates = [];
      discoverySessionId = null;
      notice = previous ? "未能连接所选盒子，请确认盒子仍处于配网模式后重试。" : retainedDiscovery ? null :
        error.name === "NotFoundError" || error.code === "LOCAL_SELECTION_TIMEOUT" ? "未发现可用盒子，请确认盒子已进入配网模式后重新扫描。" : error.message;
      render(currentState);
    },
  );
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
    const result = await run(confirmation.action, confirmation.input || { applicationId: confirmation.applicationId });
    if (result && confirmation.action.startsWith("market.")) await refreshMarket();
    return;
  }
  if (action === "logout") { await run("auth.logout"); return; }
  if (["show-applications", "show-boxes", "show-settings"].includes(action)) {
    if (page === "provisioning") return;
    page = action.slice(5);
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
  if (action === "refresh") { if (page === "provisioning") page = "boxes"; await run("devices.refresh"); return; }
  if (action === "network-toggle") { await run("network.set-enabled", { enabled: currentState.network?.enabled === false }); return; }
  if (action === "provisioning") {
    stopBluetoothSelection();
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
    if (retainedDiscovery && !selectionPromise) startBluetoothSelection(target.dataset.candidateId);
    else if (discoverySessionId && !retainedDiscovery) window.wanxDiscovery?.select(discoverySessionId, target.dataset.candidateId);
    return;
  }
  if (action === "provisioning-confirm") { await run("provisioning.confirm"); return; }
  if (action === "provisioning-refresh") { await run("provisioning.refresh"); return; }
  if (action === "provisioning-owner") { await run("provisioning.owner"); return; }
  if (action === "cancel-provisioning") { stopBluetoothSelection(); await run("provisioning.cancel"); return; }
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
  if (action === "back-devices") { stopBluetoothSelection(); page = "boxes"; notice = null; render(currentState); return; }
  if (action === "applications-select-current") {
    await run("applications.select-current", { applicationId: target.dataset.applicationId, version: target.dataset.version });
    return;
  }
  if (action === "applications-launch") {
    await run("applications.request-open", { applicationId: target.dataset.applicationId });
    return;
  }
});

app.addEventListener("change", (event) => {
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
  await run("auth.login", data);
});

function acceptRemoteState(state) {
  const account = state.route === "auth" ? null : state.account?.accountId || "authenticated";
  const accountChanged = account !== marketAccount;
  // Page selection belongs to the UI; network polling only updates its data.
  // Do not discard in-progress Wi-Fi input or the selected BLE device.
  if (page === "provisioning" && state.route !== "auth" && !accountChanged) {
    currentState = state;
    // The account directory can arrive after Bluetooth discovery. Refresh names
    // while choosing a box, but leave the active setup flow and its inputs alone.
    if (setupState.state === "idle" && (selectionPromise || retainedDiscovery)) render(state);
    return;
  }
  if (state.route === "auth" || accountChanged) {
    page = "applications";
    stopBluetoothSelection();
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
  notice = null;
  render(currentState);
});
window.wanxSetup?.subscribe((snapshot) => {
  setupState = snapshot;
  if (page === "provisioning") render(currentState);
});
window.wanxDiscovery?.subscribe((payload) => {
  if (!selectionPromise || !payload || typeof payload.sessionId !== "string") return;
  discoverySessionId = payload.sessionId;
  discoveryCandidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  if (page === "provisioning") render(currentState);
}, (payload) => {
  if (selectionPromise && payload?.sessionId === discoverySessionId && payload.cancelled) retainDiscovery();
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
