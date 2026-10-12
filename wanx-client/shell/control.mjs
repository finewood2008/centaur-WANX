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
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    return applications.install({ sourceDir: text(input?.sourceDir, 4096, "invalid_application_source") });
  });
  register("applications-launch", (input) => {
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    const state = client.snapshot();
    requireConnectedBox(state);
    return applications.launch(text(input?.applicationId, 64, "invalid_application_id"), input?.version);
  });
  register("applications-stop", (input) => {
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    return applications.stop(text(input?.applicationId, 64, "invalid_application_id"));
  });
}
