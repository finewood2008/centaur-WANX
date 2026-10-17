const { contextBridge, ipcRenderer } = require("electron");

function errorCode(error) {
  return String(error?.code || error?.message || "CLIENT_REQUEST_FAILED");
}

function projectState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const account = source.account || { phase: "signed_out" };
  const authenticated = account.phase === "authenticated";
  const connection = source.connection || null;
  const networkReady =
    source.network?.enabled !== false &&
    source.platform?.phase === "ready" && source.network?.phase === "ready";
  const connected = authenticated && networkReady && source.phase === "ready" &&
    connection?.mode === "netbird" && Boolean(connection.deviceId);
  const devices = Array.isArray(source.devices)
    ? source.devices.map((device) => ({
        ...device,
        name: device.displayName || device.deviceId,
        lifecycle: device.accessState === "ready" ? "ready" : "unavailable",
        initialized: device.accessState === "ready",
      }))
    : [];

  return {
    ...source,
    connectionPhase: source.phase || "disconnected",
    route: authenticated ? "applications" : "auth",
    phase: !authenticated
      ? account.phase === "authenticating"
        ? "authenticating"
        : "signed_out"
      : connected
        ? "connected"
        : "idle",
    account: {
      ...account,
      displayName: account.profile?.displayName || "万象用户",
    },
    devices,
    networkReady,
    canLaunchApplications: connected,
    canOpenDashboard: connected && Boolean(connection.gatewayURL),
    availableDevices: devices.filter((device) => device.accessState === "ready"),
    selectedDeviceId: connection?.deviceId || null,
    activeDeviceId: connected ? connection.deviceId : null,
    provisioning: { phase: "idle", stage: null, error: null },
    diagnostics: {
      phase: source.platform?.phase || "idle",
      message: source.platform?.reason || null,
    },
  };
}

async function rawState() {
  return ipcRenderer.invoke("wanx-client:get-state");
}

const actions = {
  "profile.save": input => ipcRenderer.invoke("wanx-client:profile-save", { displayName: input?.displayName }),
  "profile.avatar": () => ipcRenderer.invoke("wanx-client:profile-avatar"),
  "profile.avatar-remove": () => ipcRenderer.invoke("wanx-client:profile-avatar-remove"),
  "credits.tasks": () => ipcRenderer.invoke("wanx-client:credits-tasks"),
  "credits.balance": () => ipcRenderer.invoke("wanx-client:credits-balance"),
  "credits.transactions": input => ipcRenderer.invoke("wanx-client:credits-transactions", { after: input?.after }),
  "credits.reservation": input => ipcRenderer.invoke("wanx-client:credits-reservation", { id: input?.id }),
  "auth.login": (input) =>
    ipcRenderer.invoke("wanx-client:login-password", {
      phone: input?.username,
      password: input?.password,
    }),
  "auth.send-code": (input) =>
    ipcRenderer.invoke("wanx-client:send-registration-code", { phone: input?.username }),
  "auth.register": (input) =>
    ipcRenderer.invoke("wanx-client:register", { phone: input?.username, password: input?.password, code: input?.code }),
  "auth.send-reset-code": (input) =>
    ipcRenderer.invoke("wanx-client:send-reset-code", { phone: input?.username }),
  "auth.reset-password": (input) =>
    ipcRenderer.invoke("wanx-client:reset-password", { phone: input?.username, code: input?.code, password: input?.password }),
  "auth.send-change-code": () => ipcRenderer.invoke("wanx-client:send-change-code"),
  "auth.change-password": (input) =>
    ipcRenderer.invoke("wanx-client:change-password", { code: input?.code, password: input?.password }),
  "auth.logout": () => ipcRenderer.invoke("wanx-client:logout"),
  "devices.refresh": () => ipcRenderer.invoke("wanx-client:refresh-devices"),
  "devices.discovery": (input) => ipcRenderer.invoke("wanx-client:discovery-devices", { deviceIds: input?.deviceIds }),
  "ownership.list": () => ipcRenderer.invoke("wanx-client:ownership-list"),
  "support.current": input => ipcRenderer.invoke("wanx-client:support-current", { deviceId: input?.deviceId }),
  "support.decide": input => ipcRenderer.invoke("wanx-client:support-decide", {
    deviceId: input?.deviceId, ownershipEpoch: input?.ownershipEpoch, requestId: input?.requestId,
    requestDigest: input?.requestDigest, decision: input?.decision, confirmed: input?.confirmed,
  }),
  "support.revoke": input => ipcRenderer.invoke("wanx-client:support-revoke", {
    deviceId: input?.deviceId, ownershipEpoch: input?.ownershipEpoch, requestId: input?.requestId,
    requestDigest: input?.requestDigest, supportSessionId: input?.supportSessionId, confirmed: input?.confirmed,
  }),
  "ownership.send-code": () => ipcRenderer.invoke("wanx-client:ownership-send-code"),
  "ownership.create": (input) => ipcRenderer.invoke("wanx-client:ownership-create", input),
  "ownership.accept": (input) => ipcRenderer.invoke("wanx-client:ownership-accept", input),

  "devices.connect": (input) =>
    ipcRenderer.invoke("wanx-client:connect-box", input?.deviceId),
  "devices.disconnect": () => ipcRenderer.invoke("wanx-client:disconnect"),
  "dashboard.open": () => ipcRenderer.invoke("wanx-client:dashboard-open"),
  "network.set-enabled": (input) =>
    ipcRenderer.invoke("wanx-client:set-network-enabled", input?.enabled),
  "applications.list": () => ipcRenderer.invoke("wanx-client:applications-list"),
  "market.list": () => ipcRenderer.invoke("wanx-client:market-list"),
  "market.candidate": (input) => ipcRenderer.invoke("wanx-client:market-candidate", { applicationId: input?.applicationId }),
  "market.install": (input) => ipcRenderer.invoke("wanx-client:market-install", { applicationId: input?.applicationId }),
  "market.uninstall": (input) => ipcRenderer.invoke("wanx-client:market-uninstall", { applicationId: input?.applicationId }),
  "market.rollback": (input) => ipcRenderer.invoke("wanx-client:market-rollback", { applicationId: input?.applicationId }),
  "applications.launch": (input) => ipcRenderer.invoke("wanx-client:applications-launch", input),
  "applications.request-open": (input) => ipcRenderer.invoke("wanx-client:applications-request-open", input),
  "applications.confirm-open": (input) => ipcRenderer.invoke("wanx-client:applications-confirm-open", input),
  "applications.cancel-open": (input) => ipcRenderer.invoke("wanx-client:applications-cancel-open", input),
  "desktop.startup.get": () => ipcRenderer.invoke("wanx-client:desktop-startup-get"),
  "desktop.startup.set": (input) => ipcRenderer.invoke("wanx-client:desktop-startup-set", input),
  "desktop.about": () => ipcRenderer.invoke("wanx-client:desktop-about"),
  "desktop.quit": () => ipcRenderer.invoke("wanx-client:desktop-quit"),
  "applications.select-current": (input) => ipcRenderer.invoke("wanx-client:applications-select-current", input),
  "applications.stop": (input) => ipcRenderer.invoke("wanx-client:applications-stop", input),
  ...Object.fromEntries([
    ...["check", "download", "install"].map(method => ["client", method]),
    ...["check", "plan", "execute", "status", "cancel", "resume"].map(method => ["box", method]),
  ].map(([product, method]) => [`updates.${product}.${method}`, input => ipcRenderer.invoke(`wanx-client:updates-${product}-${method}`, input)])),
};

async function action(name, input = {}) {
  const handler = actions[name];
  if (!handler)
    return { ok: false, code: "UNKNOWN_CLIENT_ACTION", state: await getLocalState() };
  try {
    const value = await handler(input);
    return { ok: true, value, state: await getLocalState() };
  } catch (error) {
    return { ok: false, code: errorCode(error), state: await getLocalState() };
  }
}

async function getLocalState() {
  return projectState(await rawState());
}

contextBridge.exposeInMainWorld(
  "wanxClient",
  Object.freeze({
    getLocalState,
    action,
    checkHealth: async () => ({
      ok: false,
      code: "DIAGNOSTIC_UNAVAILABLE",
      state: await getLocalState(),
    }),
    onLocalState(listener) {
      const receive = (_event, state) => listener(projectState(state));
      ipcRenderer.on("wanx-client:state", receive);
      return () => ipcRenderer.removeListener("wanx-client:state", receive);
    },
    onNavigate(listener) {
      const receive = (_event, page) => {
        if (page === "applications" || page === "boxes" || page === "settings" || page === "credits" || page === "profile") listener(page);
      };
      ipcRenderer.on("wanx-client:navigate", receive);
      return () => ipcRenderer.removeListener("wanx-client:navigate", receive);
    },
  }),
);

const setupCall = async (method, input) => {
  const result = await ipcRenderer.invoke(`wanx:setup:${method}`, input);
  if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
  return result.value;
};
let setupReady = false;
ipcRenderer.on("wanx:setup:ready", () => { setupReady = true; });

contextBridge.exposeInMainWorld("wanxSetup", {
  state: () => setupReady ? setupCall("state") : Promise.reject(Object.assign(new Error("SETUP_NOT_READY"), { code: "SETUP_NOT_READY" })),
  begin: (candidate) => setupCall("begin", candidate),
  resume: (input = {}) => setupCall("resume", input),
  confirmPhysical: () => setupCall("confirmPhysical"),
  scanWifi: () => setupCall("scanWifi"),
  wifi: (input) => setupCall("wifi", input),
  confirmOwnership: () => setupCall("confirmOwnership"),
  refresh: () => setupCall("refresh"),
  cancel: () => setupCall("cancel"),
  reset: () => setupCall("reset"),
  subscribe: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("wanx:setup:state", handler);
    return () => ipcRenderer.removeListener("wanx:setup:state", handler);
  },
  onReady: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("wanx:setup:ready", handler);
    return () => ipcRenderer.removeListener("wanx:setup:ready", handler);
  },
});

contextBridge.exposeInMainWorld("wanxSetupTransport", {
  scanTimeoutMs: process.platform === "win32" ? 60000 : 12000,
  subscribe: (listener) => {
    const handler = (_event, request) => listener(request);
    ipcRenderer.on("wanx:setup:transport", handler);
    return () => ipcRenderer.removeListener("wanx:setup:transport", handler);
  },
  reply: (result) => ipcRenderer.send("wanx:setup:transport-result", result),
  status: (connectionId, frame) => ipcRenderer.send("wanx:setup:transport-status", { connectionId, frame }),
});

contextBridge.exposeInMainWorld("wanxDiscovery", {
  bluetoothState: () => ipcRenderer.invoke("wanx:discovery:bluetooth-state"),
  openBluetoothSettings: async (section = "bluetooth") => {
    const result = await ipcRenderer.invoke("wanx:discovery:open-bluetooth-settings", section);
    if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
  },
  subscribe: (onCandidates, onSettled) => {
    const candidates = (_event, payload) => onCandidates(payload);
    const settled = (_event, payload) => onSettled(payload);
    ipcRenderer.on("nexusaos:discovery:candidates", candidates);
    ipcRenderer.on("nexusaos:discovery:settled", settled);
    return () => {
      ipcRenderer.removeListener("nexusaos:discovery:candidates", candidates);
      ipcRenderer.removeListener("nexusaos:discovery:settled", settled);
    };
  },
  cancel: (sessionId) => ipcRenderer.send("nexusaos:discovery:cancel", { sessionId }),
  select: (sessionId, candidateId) => ipcRenderer.send("nexusaos:discovery:select", { sessionId, candidateId }),
  reselect: (sessionId, candidateId) => ipcRenderer.send("nexusaos:discovery:reselect", { sessionId, candidateId }),
  forget: (sessionId) => ipcRenderer.send("nexusaos:discovery:forget", { sessionId }),
});
