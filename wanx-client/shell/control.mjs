import { isControlSender } from "./security.mjs";

function text(value, max, code) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(code);
  return value.trim();
}
function phone(input) {
  const value = text(input?.phone, 32, "invalid_phone");
  if (!/^1\d{10}$/.test(value)) throw new Error("invalid_phone");
  return value;
}

function requireConnectedBox(state) {
  if (state.account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
  if (state.network?.enabled === false || state.platform?.phase !== "ready" || state.network?.phase !== "ready")
    throw new Error("NETWORK_NOT_READY");
  if (state.phase !== "ready" || state.connection?.mode !== "netbird" || !state.connection.deviceId)
    throw new Error("BOX_CONNECTION_REQUIRED");
}

export function openConnectedDashboard(client, dashboards) {
  const state = client.snapshot();
  requireConnectedBox(state);
  if (!state.connection.gatewayURL) throw new Error("BOX_CONNECTION_REQUIRED");
  return dashboards.open(state);
}

// Remote dashboards have no account bridge. Check the exact control main frame
// for every action, including reads, and never accept network credentials here.
export function registerControlActions({
  ipcMain,
  control,
  controlURL,
  panel,
  panelURL,
  client,
  applications,
  dashboards,
  selectApplicationArchive,
  market,
  uiState,
  desktop,
  getState,
  publishState = () => {},
  getDesktopStartup,
  setDesktopStartup,
  showAbout,
  quit,
  allowDevelopmentInstall = false,
}) {
  const panelActions = new Set([
    "get-state", "applications-list", "applications-request-open", "applications-confirm-open",
    "applications-cancel-open",
    "desktop-open", "desktop-hide", "desktop-resize", "desktop-about",
  ]);
  const reads = new Set(["get-state", "applications-list", "market-list", "market-candidate", "desktop-startup-get", "desktop-resize"]);
  const register = (name, action) => {
    ipcMain.handle(`wanx-client:${name}`, (event, argument) => {
      const management = isControlSender(event, control, controlURL);
      if (!management && !(panelActions.has(name) && isControlSender(event, panel, panelURL)))
        throw new Error("此页面无权操作万象连接。");
      // Keep validation synchronous; mutations also refresh both trusted windows.
      const result = action(argument);
      if (reads.has(name)) return result;
      return Promise.resolve(result).finally(() => publishState());
    });
  };
  register("get-state", async () => {
    if (getState) return getState();
    const installed = applications ? await applications.listInstalled() : [];
    return { ...client.snapshot(), applications: installed };
  });
  register("set-network-enabled", (enabled) => {
    if (typeof enabled !== "boolean") throw new Error("invalid_network_mode");
    if (!enabled) uiState?.invalidateOpen();
    return client.setNetworkEnabled(enabled);
  });
  register("login-password", (input) => {
    const number = phone(input);
    if (
      typeof input.password !== "string" ||
      !input.password ||
      Buffer.byteLength(input.password, "utf8") > 72
    )
      throw new Error("invalid_credentials");
    return client.loginPassword({ phone: number, password: input.password });
  });
  register("login-sms", (input) => {
    const number = phone(input);
    const code = text(input?.code, 12, "invalid_sms_code");
    if (!/^\d{6}$/.test(code)) throw new Error("invalid_sms_code");
    return client.loginSMS({ phone: number, code });
  });
  register("send-sms", (input) => client.sendSMS({ phone: phone(input) }));
  register("send-registration-code", (input) => client.sendSMS({ phone: phone(input), scene: "consumer_register" }));
  register("register", (input) => {
    const number = phone(input);
    if (typeof input.password !== "string" || Buffer.byteLength(input.password, "utf8") < 8 ||
      Buffer.byteLength(input.password, "utf8") > 72 || /[\r\n\0]/.test(input.password))
      throw new Error("invalid_credentials");
    const code = text(input.code, 12, "invalid_sms_code");
    if (!/^\d{6}$/.test(code)) throw new Error("invalid_sms_code");
    return client.register({ phone: number, password: input.password, code });
  });
  register("send-reset-code", (input) => client.sendResetCode({ phone: phone(input) }));
  register("send-change-code", () => client.sendChangeCode());
  for (const [action, method] of [["reset-password", "resetPassword"], ["change-password", "changePassword"]]) {
    register(action, (input) => {
      const number = action === "reset-password" ? phone(input) : undefined;
      if (typeof input?.password !== "string" || Buffer.byteLength(input.password, "utf8") < 8 ||
          Buffer.byteLength(input.password, "utf8") > 72 || /[\r\n\0]/.test(input.password))
        throw new Error("invalid_credentials");
      const code = text(input?.code, 6, "invalid_sms_code");
      if (!/^\d{6}$/.test(code)) throw new Error("invalid_sms_code");
      return client[method]({ ...(number ? { phone: number } : {}), code, password: input.password });
    });
  }
  register("logout", () => { uiState?.invalidateOpen(); return client.logout(); });
  register("refresh-devices", () => client.refreshDevices());
  register("ownership-list", () => client.listOwnershipTransfers());
  register("ownership-send-code", () => client.sendTransferCode());
  register("ownership-create", (input) => {
    if (input?.retainData !== true) throw new Error("ACCOUNT_INVALID_INPUT");
    const verificationCode = text(input?.verificationCode, 6, "invalid_sms_code");
    if (!/^\d{6}$/.test(verificationCode)) throw new Error("invalid_sms_code");
    uiState?.invalidateOpen();
    return client.createOwnershipTransfer({ deviceId: text(input?.deviceId, 128, "invalid_device"),
      targetPhone: phone({ phone: input?.targetPhone }), verificationCode, retainData: true });
  });
  register("ownership-accept", (input) => {
    if (input?.retainData !== true) throw new Error("ACCOUNT_INVALID_INPUT");
    uiState?.invalidateOpen();
    return client.acceptOwnershipTransfer({ transferId: text(input?.transferId, 128, "ACCOUNT_INVALID_INPUT"), retainData: true });
  });

  register("connect-box", (deviceId) => {
    const id = text(deviceId, 128, "invalid_device");
    uiState?.invalidateOpen();
    return client.connectBox(id);
  });
  register("connect", (input) => {
    if (input?.mode !== "direct") throw new Error("invalid_network_mode");
    uiState?.invalidateOpen();
    return client.connect({
      mode: "direct",
      deviceId: text(input.deviceId, 128, "invalid_connection"),
      name: text(input.name, 128, "invalid_connection"),
      url: text(input.url, 2048, "invalid_endpoint"),
    });
  });
  register("disconnect", () => { uiState?.invalidateOpen(); return client.disconnect(); });
  register("dashboard-open", () => openConnectedDashboard(client, dashboards));
  register("applications-list", () => applications?.listInstalled() || []);
  register("applications-install", (input) => {
    if (!allowDevelopmentInstall) throw new Error("MARKET_SIGNED_PACKAGE_REQUIRED");
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    if (input?.sourceDir !== undefined && input?.archivePath !== undefined) throw new Error("APPLICATION_SOURCE_REQUIRED");
    if (input?.sourceDir !== undefined)
      return applications.install({ sourceDir: text(input.sourceDir, 4096, "invalid_application_source") });
    if (input?.archivePath !== undefined)
      return applications.install({ archivePath: text(input.archivePath, 4096, "invalid_application_source") });
    if (!selectApplicationArchive) throw new Error("APPLICATION_ARCHIVE_PICKER_UNAVAILABLE");
    return selectApplicationArchive().then(archivePath => archivePath
      ? applications.install({ archivePath }) : { canceled: true });
  });
  register("applications-launch", (input) => {
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    const state = client.snapshot();
    requireConnectedBox(state);
    return applications.launch(text(input?.applicationId, 64, "invalid_application_id"));
  });
  register("applications-select-current", (input) => {
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    const id = text(input?.applicationId, 64, "invalid_application_id");
    const version = text(input?.version, 64, "INVALID_APPLICATION_VERSION");
    const operation = () => applications.selectCurrent(id, version);
    return uiState ? uiState.runApplicationOperation(id, "selecting", operation) : operation();
  });
  register("applications-stop", (input) => {
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    return applications.stop(text(input?.applicationId, 64, "invalid_application_id"));
  });
  register("applications-request-open", (input) => {
    if (!uiState) throw new Error("APPLICATIONS_UNAVAILABLE");
    return uiState.requestOpen(text(input?.applicationId, 64, "invalid_application_id"));
  });
  register("applications-confirm-open", (input) => {
    if (!uiState) throw new Error("APPLICATIONS_UNAVAILABLE");
    return uiState.confirmOpen({ intentId: text(input?.intentId, 128, "invalid_intent"), deviceId: text(input?.deviceId, 128, "invalid_device") });
  });
  register("applications-cancel-open", (input) => {
    if (!uiState) throw new Error("APPLICATIONS_UNAVAILABLE");
    return uiState.cancelOpen({ intentId: text(input?.intentId, 128, "invalid_intent") });
  });
  register("desktop-open", (input) => {
    if (!["applications", "boxes", "settings"].includes(input?.page)) throw new Error("invalid_page");
    desktop?.showManagement(input.page);
  });
  register("desktop-hide", () => desktop?.hidePanel());
  register("desktop-resize", (input) => {
    if (!Number.isFinite(input?.height)) throw new Error("invalid_panel_height");
    desktop?.resizePanel(Math.max(240, Math.min(560, Math.ceil(input.height))));
  });
  register("desktop-startup-get", () => getDesktopStartup?.());
  register("desktop-startup-set", (input) => {
    if (typeof input?.enabled !== "boolean") throw new Error("invalid_startup_setting");
    return setDesktopStartup?.(input.enabled);
  });
  register("desktop-about", () => showAbout?.());
  register("desktop-quit", () => quit?.());
  for (const method of ["list", "candidate", "install", "uninstall", "rollback"]) {
    register(`market-${method}`, (input) => {
      if (!market) throw new Error("MARKET_UNAVAILABLE");
      if (client.snapshot().account?.phase !== "authenticated")
        throw new Error("ACCOUNT_LOGIN_REQUIRED");
      if (method === "list") return market.list();
      const id = text(input?.applicationId, 64, "invalid_application_id");
      const operation = () => market[method](id);
      if (method === "candidate" || !uiState) return operation();
      return uiState.runApplicationOperation(id, { install: "installing", uninstall: "uninstalling", rollback: "rolling-back" }[method], operation);
    });
  }
}
