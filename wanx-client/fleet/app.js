const ui = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((el) => [el.id, el]),
);
const api = window.wanxClient;
let state, lastReason, smsTimer;
let revision = 0,
  smsDeadline = 0;
const pending = new Map();
const reasons = {
  ACCOUNT_INVALID_URL: "万象账号服务地址配置有误，请联系管理员。",
  ACCOUNT_INVALID_STORED_SESSION: "保存的登录信息已失效，请重新登录。",
  ACCOUNT_INVALID_PATH: "当前客户端与账号服务不兼容，请更新客户端。",
  ACCOUNT_REDIRECT_REJECTED: "账号服务地址发生跳转，请联系管理员检查配置。",
  ACCOUNT_INVALID_RESPONSE: "账号服务返回异常，请稍后重试。",
  ACCOUNT_REQUEST_FAILED: "账号服务暂时未能完成请求，请稍后重试。",
  ACCOUNT_NETWORK_ERROR: "无法连接万象账号服务，请检查互联网连接。",
  ACCOUNT_LOGIN_REQUIRED: "请先登录万象账号。",
  ACCOUNT_SESSION_EXPIRED: "登录已过期，请重新登录万象。",
  ACCOUNT_ACCESS_DENIED: "当前账号没有执行此操作的权限。",
  ACCOUNT_INVALID_INPUT: "请检查手机号、密码或六位短信验证码。",
  ACCOUNT_ALREADY_SIGNED_IN: "当前已登录，请先退出后再切换账号。",
  ACCOUNT_CANCELLED: "登录操作已取消。",
  SECURE_STORAGE_UNAVAILABLE: "系统安全存储不可用，请解锁系统钥匙串后重试。",
  SECURE_STORAGE_READ_FAILED:
    "无法读取安全保存的登录信息，请检查系统安全存储。",
  SECURE_STORAGE_WRITE_FAILED:
    "无法安全保存登录信息，请检查系统安全存储及磁盘空间。",
  PASSWORD_INVALID: "手机号或密码不正确，请重试。",
  SMS_CODE_INVALID: "短信验证码无效或已过期，请重新获取。",
  SMS_RATE_LIMITED: "验证码发送频繁，请稍后重试。",
  SMS_DAILY_LIMIT: "今日验证码发送次数已达上限，请稍后再试。",
  AUTH_RATE_LIMITED: "登录尝试过于频繁，请稍后重试。",
  AUTH_REVOKED: "账号授权已撤销，请重新登录。",
  AUTH_SESSION_REVOKED: "当前登录已失效，请重新登录。",
  NETWORK_UNAVAILABLE: "P2P 网络暂时不可用，请稍后重试。",
  NETWORK_SERVICE_NOT_DEPLOYED:
    "自动入网服务尚未部署，请联系管理员完成服务更新。",
  NETWORK_CANCELLED: "P2P 网络连接已取消。",
  NETWORK_INVALID_RESPONSE: "P2P 网络服务返回异常，请稍后重试。",
  NETWORK_LEASE_EXPIRED: "网络访问授权已过期，请重新开启 P2P 网络。",
  NETWORK_ENGINE_UNAVAILABLE: "内置网络暂时不可用，请关闭 P2P 后重新开启。",
  NETWORK_ENROLLMENT_TIMEOUT: "自动入网超时，请检查网络后重新开启 P2P。",
  NETWORK_NOT_READY: "P2P 网络尚未就绪，请等待自动连接。",
  NETWORK_DEVICE_ACCESS_DENIED: "你没有访问该盒子的权限，请刷新盒子列表。",
  NETWORK_ACCESS_DENIED: "当前账号未获网络访问权限，请联系管理员。",
  NETWORK_DISABLED: "P2P 网络服务尚未启用，请联系管理员。",
  NETWORK_CONFIGURATION_INVALID: "P2P 网络服务配置有误，请联系管理员。",
  NETWORK_ENROLLMENT_CANCELLED: "自动入网已取消。",
  NETWORK_ENROLLMENT_FAILED: "自动入网失败，请重新开启 P2P 网络。",
  NETWORK_ENROLLMENT_PENDING: "正在完成自动入网，请稍候。",
  NETWORK_ENROLLMENT_REQUIRED: "需要重新入网，请关闭 P2P 后重新开启。",
  NETWORK_MANAGEMENT_UNAVAILABLE: "P2P 网络服务暂时不可用，请稍后重试。",
  NETWORK_MANAGEMENT_RESPONSE_INVALID: "P2P 网络服务返回异常，请联系管理员。",
  NETWORK_PEER_MISSING: "当前客户端的网络身份已失效，请重新开启 P2P。",
  NETWORK_PEER_IDENTITY_AMBIGUOUS: "网络设备身份存在冲突，请联系管理员。",
  NETWORK_DEVICE_IDENTITY_INVALID: "盒子的网络身份关联异常，请联系管理员。",
  NETWORK_POLICY_NOT_CONFIRMED: "盒子访问权限尚未生效，请稍后刷新重试。",
  NETWORK_AUTHORIZATION_SYNC_UNAVAILABLE:
    "盒子的授权同步组件需要更新，请联系管理员。",
  NETWORK_PROJECTION_FAILED: "无法同步盒子访问权限，请稍后重试。",
  NETWORK_RECONCILE_FAILED: "网络权限同步失败，请稍后重试。",
  NETWORK_RESOURCE_CONFLICT: "网络注册状态存在冲突，请稍后重试。",
  NETWORK_REVOCATION_PENDING: "正在清理上次网络连接，请稍后刷新重试。",
  NETWORK_SESSION_INVALID: "网络登录信息已失效，请重新登录万象。",
  NETWORK_SESSION_REVOKED: "网络访问授权已撤销，请重新登录万象。",
  NETWORK_UNSAFE_EXISTING_POLICY:
    "现有网络权限不满足账号隔离要求，请联系管理员。",
  NETWORK_USE_AUTHORIZED_DEVICE: "请从“我的盒子”选择要打开的盒子。",
  NETWORK_INVALID_SWITCH: "P2P 网络开关参数无效，请重试。",
  NETWORK_INVALID_REQUEST: "网络注册请求无效，请更新客户端后重试。",
  PLATFORM_IDENTITY_REQUIRED: "盒子缺少身份信息，请刷新盒子列表。",
  PLATFORM_GRANT_INVALID: "盒子访问授权无效，请刷新盒子列表后重试。",
  PLATFORM_RESPONSE_TOO_LARGE: "盒子认证服务返回异常，请更新盒子服务后重试。",
  BOX_PLATFORM_AUTH_FAILED: "盒子未接受本次登录，请刷新盒子列表后重试。",
  BOX_PLATFORM_RESPONSE_INVALID: "盒子认证服务返回异常，请检查盒子服务版本。",
  BOX_PLATFORM_TIMEOUT: "登录盒子超时，请确认盒子在线后重试。",
  SSO_DISABLED: "盒子免登录服务尚未启用，请联系管理员。",
  SSO_DEVICE_UNAVAILABLE: "盒子当前不可用，请确认盒子在线。",
  SSO_DEVICE_ACCESS_DENIED: "你没有访问该盒子的权限，请刷新盒子列表。",
  SSO_APPLICATION_ACCESS_DENIED: "你没有访问该盒子万象服务的权限。",
  SSO_MEMBERSHIP_DENIED: "你的盒子访问授权已失效，请刷新盒子列表。",
  SSO_MEMBERSHIP_NOT_FOUND: "未找到你的盒子访问授权，请刷新盒子列表。",
  SSO_MEMBERSHIP_REVOKED: "你的盒子访问授权已撤销。",
  SSO_DEVICE_REVOKED: "该盒子访问授权已撤销，请刷新盒子列表。",
  SSO_ACCOUNT_REVOKED: "账号授权已撤销，请重新登录万象。",
  SSO_CLIENT_REVOKED: "当前客户端已被撤销授权，请重新登录万象。",
  SSO_CLIENT_LOGOUT: "当前客户端已退出登录，请重新登录万象。",
  SSO_SESSION_REVOKED: "盒子登录已失效，请重新打开盒子。",
  SSO_AUTHORIZATION_EXPIRED: "盒子登录授权已过期，请重新打开盒子。",
  SSO_STALE_AUTHORIZATION: "盒子访问权限已更新，请刷新列表后重试。",
  SSO_CHALLENGE_INVALID: "盒子登录验证已失效，请重新打开盒子。",
  SSO_CHALLENGE_REPLAYED: "本次盒子登录验证已使用，请重新打开盒子。",
  SSO_TEMPORARILY_UNAVAILABLE: "盒子免登录服务暂时不可用，请稍后重试。",
  SSO_PROJECTION_UNAVAILABLE: "无法同步盒子账号权限，请稍后重试。",
  SSO_SIGNING_KEY_UNAVAILABLE: "盒子免登录服务配置尚未完成，请联系管理员。",
  SSO_LINK_KEY_UNAVAILABLE: "盒子身份关联配置尚未完成，请联系管理员。",
  SSO_ACCOUNT_NOT_FOUND: "万象账号不存在，请重新登录。",
  SSO_ACCOUNT_STATE_INVALID: "万象账号状态异常，请联系管理员。",
  SSO_INVALID_REQUEST: "盒子登录请求无效，请更新客户端后重试。",
  invalid_phone: "请输入有效的手机号。",
  invalid_credentials: "手机号或密码不正确，请重试。",
  invalid_sms_code: "短信验证码无效，请重新输入。",
  sms_rate_limited: "验证码发送频繁，请稍后重试。",
  account_unavailable: "暂时无法连接账号服务，请稍后重试。",
  account_required: "请先登录万象账号。",
  session_expired: "登录已过期，请重新登录万象。",
  platform_unavailable: "暂时无法连接万象平台，请检查网络后重试。",
  platform_not_configured: "万象账号服务尚未配置，请联系管理员。",
  network_disabled: "请先开启 P2P 网络。",
  network_unavailable: "P2P 网络尚未就绪，请等待自动连接后重试。",
  auth_required: "正在准备账号的 P2P 网络连接，请稍候。",
  auth_failed: "自动连接网络失败，请关闭 P2P 后重新开启。",
  management_unavailable: "暂时无法连接网络服务，请检查互联网连接后重试。",
  engine_missing: "内置网络组件缺失，请重新安装完整版万象客户端。",
  engine_start_failed: "内置网络启动失败，请关闭后重新开启。",
  engine_exited: "内置网络已停止，请关闭后重新开启。",
  device_not_found: "该盒子已不可用，请刷新盒子列表。",
  device_access_denied: "你已没有访问该盒子的权限，请刷新盒子列表。",
  invalid_device: "该盒子不可用，请刷新盒子列表。",
  netbird_peer_unknown: "当前网络无法访问该盒子，请刷新列表或稍后重试。",
  netbird_peer_disconnected: "该盒子尚未连接 P2P 网络。",
  direct_https_required: "远端直接连接需要使用 HTTPS。",
  invalid_endpoint: "服务地址无效，请检查地址与端口。",
  invalid_connection: "请填写设备标识、显示名称和服务地址。",
  health_unavailable: "无法访问万象服务，请确认盒子已启动并获授权。",
  health_timeout: "连接万象服务超时，请检查网络。",
  health_invalid: "该地址未返回有效的万象服务状态。",
  connection_failed: "连接失败，请检查服务地址与网络。",
  box_login_failed: "暂时无法登录该盒子，请刷新列表后重试。",
};
function showError(error) {
  const code = error
    ? String(error.message || error).replace(
        /^Error invoking remote method '[^']+': Error: /,
        "",
      )
    : "";
  // Never display arbitrary upstream response bodies or credentials.
  ui.error.textContent = code
    ? reasons[code] || "操作暂时未完成，请稍后重试。"
    : "";
  ui.error.hidden = !code;
}
function canOpenBox(device) {
  return (
    device?.canOpen === true &&
    state.account?.phase === "authenticated" &&
    state.network.enabled &&
    state.network.phase === "ready" &&
    state.platform?.phase === "ready" &&
    state.phase === "disconnected" &&
    !pending.has("connection") &&
    !pending.has("logout")
  );
}
function render(next) {
  state = next;
  const account = state.account || { phase: "signed_out" };
  const signedIn = account.phase === "authenticated";
  const authenticating =
    account.phase === "authenticating" || pending.has("login");
  const network = state.network;
  const reason =
    state.reason ||
    account.reason ||
    state.directory?.reason ||
    state.platform?.reason ||
    (network.phase === "unavailable" ? network.reason : null) ||
    null;
  if (reason !== lastReason) {
    lastReason = reason;
    showError(reason);
  }
  ui["login-form"].hidden = signedIn;
  ui["account-state"].textContent = signedIn
    ? "已登录万象"
    : authenticating
    ? "正在登录万象…"
    : "尚未登录";
  ui.logout.hidden = !signedIn && !authenticating;
  ui.logout.disabled = pending.has("logout");
  ui["login-method"].disabled = authenticating;
  ui.phone.disabled = authenticating;
  const sms = ui["login-method"].value === "sms";
  ui["password-section"].hidden = sms;
  ui["sms-section"].hidden = !sms;
  ui.password.required = !sms;
  ui["sms-code"].required = sms;
  ui.password.disabled = authenticating || sms;
  ui["sms-code"].disabled = authenticating || !sms;
  ui.login.disabled = authenticating || pending.has("logout");
  ui.login.textContent = authenticating ? "正在登录…" : "登录万象";
  renderSMS();
  if (signedIn) {
    ui.password.value = "";
    ui["sms-code"].value = "";
  }
  ui["network-enabled"].checked = network.enabled;
  ui["network-enabled"].disabled = false;
  ui["network-state"].textContent = !network.enabled
    ? "P2P 已关闭"
    : !signedIn
    ? "登录万象后自动连接 P2P 网络"
    : network.phase === "ready" && state.platform?.phase === "ready"
    ? "P2P 网络已连接"
    : network.phase === "unavailable" || state.platform?.phase === "unavailable"
    ? reasons[state.platform?.reason] ||
      reasons[network.reason] ||
      "P2P 网络暂时不可用"
    : "正在自动连接 P2P 网络…";
  const connecting = state.phase === "connecting" || pending.has("connection");
  const ready = state.phase === "ready";
  ui["refresh-devices"].disabled = !signedIn || pending.has("refresh");
  const devices = signedIn ? state.devices || [] : [];
  ui["devices-empty"].hidden = devices.length > 0;
  ui["devices-empty"].textContent = !signedIn
    ? "登录后查看已绑定或获授权的盒子。"
    : state.directory?.phase === "unavailable"
    ? reasons[state.directory.reason] || "暂时无法获取盒子列表，请稍后刷新。"
    : state.directory?.phase !== "ready"
    ? "正在加载已关联的盒子…"
    : "暂无已绑定或获授权的盒子。";
  ui.devices.replaceChildren(
    ...devices.map((device) => {
      const row = document.createElement("li");
      row.className = "device-row";
      const label = document.createElement("span");
      label.textContent = device.displayName || device.deviceId;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent =
        ready && state.connection?.deviceId === device.deviceId
          ? "已打开"
          : device.accessState === "service_unavailable"
          ? "账号服务待更新"
          : device.accessState === "access_denied"
          ? "未获访问权限"
          : device.accessState === "authorization_unavailable"
          ? "盒子授权组件待更新"
          : device.accessState === "authorization_pending"
          ? "访问权限待就绪"
          : device.accessState === "network_unconfigured"
          ? "盒子尚未接入网络"
          : device.accessState === "identity_unavailable"
          ? "盒子身份待就绪"
          : !network.enabled
          ? "开启 P2P 后打开"
          : canOpenBox(device)
          ? "打开盒子"
          : network.phase === "ready" && state.platform?.phase === "ready"
          ? "正在同步访问权限"
          : "等待网络连接";
      button.disabled = !canOpenBox(device);
      button.addEventListener("click", () => {
        if (
          !canOpenBox(
            (state.devices || []).find(
              (item) => item.deviceId === device.deviceId,
            ),
          )
        )
          return;
        void run(() => api.connectBox(device.deviceId), "connection");
      });
      row.append(label, button);
      return row;
    }),
  );
  ui.connect.disabled = connecting || ready;
  for (const el of [ui["device-id"], ui.name, ui.url])
    el.disabled = connecting || ready;
  ui["connection-state"].textContent = ready
    ? `已连接 ${
        state.connection?.name || state.connection?.deviceId || "万象"
      } · ${state.connection?.mode === "direct" ? "直接连接" : "P2P 网络"}`
    : connecting
    ? "正在打开万象…"
    : "尚未连接";
  ui.disconnect.hidden = state.phase === "disconnected" && !connecting;
  ui.disconnect.disabled = false;
}
function renderSMS() {
  const remaining = Math.max(0, Math.ceil((smsDeadline - Date.now()) / 1000));
  ui["send-sms"].disabled =
    remaining > 0 ||
    pending.has("sms") ||
    pending.has("login") ||
    state?.account?.phase === "authenticating";
  ui["send-sms"].textContent = pending.has("sms")
    ? "正在发送…"
    : remaining
    ? `${remaining} 秒后重发`
    : "获取验证码";
}
async function run(action, kind) {
  const generation = Symbol();
  pending.set(kind, generation);
  const startRevision = revision;
  showError(null);
  render(state);
  try {
    const next = await action();
    if (
      pending.get(kind) === generation &&
      revision === startRevision &&
      next?.network
    )
      render(next);
  } catch (error) {
    if (pending.get(kind) === generation) showError(error);
  } finally {
    if (pending.get(kind) === generation) {
      pending.delete(kind);
      render(state);
    }
  }
}
ui["login-method"].addEventListener("change", () => {
  ui.password.value = "";
  ui["sms-code"].value = "";
  showError(null);
  render(state);
});
ui["login-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  if (
    !state ||
    pending.has("login") ||
    pending.has("logout") ||
    state.account?.phase === "authenticating"
  )
    return;
  const phone = ui.phone.value.trim(),
    password = ui.password.value,
    code = ui["sms-code"].value.trim();
  ui.password.value = "";
  ui["sms-code"].value = "";
  void run(
    () =>
      ui["login-method"].value === "sms"
        ? api.loginSMS({ phone, code })
        : api.loginPassword({ phone, password }),
    "login",
  );
});
ui["send-sms"].addEventListener("click", () => {
  if (!state || ui["send-sms"].disabled) return;
  const phone = ui.phone.value.trim();
  void run(async () => {
    const result = await api.sendSMS({ phone });
    smsDeadline = Date.now() + 60_000;
    ui["sms-state"].textContent = `验证码已发送${
      result?.expiresIn
        ? `，请在 ${Math.max(1, Math.ceil(result.expiresIn / 60))} 分钟内使用`
        : ""
    }。`;
    clearInterval(smsTimer);
    smsTimer = setInterval(() => {
      renderSMS();
      if (Date.now() >= smsDeadline) clearInterval(smsTimer);
    }, 1000);
  }, "sms");
});
ui.logout.addEventListener("click", () => {
  pending.delete("login");
  revision++;
  ui.password.value = "";
  ui["sms-code"].value = "";
  void run(() => api.logout(), "logout");
});
ui["network-enabled"].addEventListener("change", () => {
  const enabled = ui["network-enabled"].checked;
  void run(() => api.setNetworkEnabled(enabled), "network");
});
ui["refresh-devices"].addEventListener("click", () => {
  if (!ui["refresh-devices"].disabled)
    void run(() => api.refreshDevices(), "refresh");
});
ui["connect-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state || pending.has("connection") || state.phase !== "disconnected")
    return;
  const endpoint = {
    mode: "direct",
    deviceId: ui["device-id"].value.trim(),
    name: ui.name.value.trim(),
    url: ui.url.value.trim(),
  };
  void run(() => api.connect(endpoint), "connection");
});
ui.disconnect.addEventListener(
  "click",
  () => void run(() => api.disconnect(), "connection"),
);
for (const el of document.querySelectorAll("input, select, button"))
  el.disabled = true;
if (api) {
  api.subscribe((next) => {
    revision++;
    render(next);
  });
  const initialRevision = revision;
  api
    .getState()
    .then((next) => {
      if (revision === initialRevision) render(next);
    })
    .catch(showError);
} else {
  ui.error.textContent =
    "请通过万象客户端打开连接页；Web 联调请运行 npm run dev:web。";
  ui.error.hidden = false;
}
