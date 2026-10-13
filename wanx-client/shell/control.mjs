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
  client,
  applications,
  dashboards,
  selectApplicationArchive,
  market,
  allowDevelopmentInstall = false,
}) {
  const register = (name, action) => {
    ipcMain.handle(`wanx-client:${name}`, (event, argument) => {
      if (!isControlSender(event, control, controlURL))
        throw new Error("此页面无权操作万象连接。");
      return action(argument);
    });
  };
  register("get-state", async () => {
    const installed = applications ? await applications.listInstalled() : [];
    return { ...client.snapshot(), applications: installed };
  });
  register("set-network-enabled", (enabled) => {
    if (typeof enabled !== "boolean") throw new Error("invalid_network_mode");
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
  register("logout", () => client.logout());
  register("refresh-devices", () => client.refreshDevices());
  register("connect-box", (deviceId) =>
    client.connectBox(text(deviceId, 128, "invalid_device")),
  );
  register("connect", (input) => {
    if (input?.mode !== "direct") throw new Error("invalid_network_mode");
    return client.connect({
      mode: "direct",
      deviceId: text(input.deviceId, 128, "invalid_connection"),
      name: text(input.name, 128, "invalid_connection"),
      url: text(input.url, 2048, "invalid_endpoint"),
    });
  });
  register("disconnect", () => client.disconnect());
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
    return applications.selectCurrent(text(input?.applicationId, 64, "invalid_application_id"), text(input?.version, 64, "INVALID_APPLICATION_VERSION"));
  });
  register("applications-stop", (input) => {
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    return applications.stop(text(input?.applicationId, 64, "invalid_application_id"));
  });
  for (const method of ["list", "candidate", "install", "uninstall", "rollback"]) {
    register(`market-${method}`, (input) => {
      if (!market) throw new Error("MARKET_UNAVAILABLE");
      if (client.snapshot().account?.phase !== "authenticated")
        throw new Error("ACCOUNT_LOGIN_REQUIRED");
      return method === "list"
        ? market.list()
        : market[method](text(input?.applicationId, 64, "invalid_application_id"));
    });
  }
}
