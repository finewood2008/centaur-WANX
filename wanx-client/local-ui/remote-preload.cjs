const { contextBridge, ipcRenderer } = require("electron");

function errorCode(error) {
  return String(error?.code || error?.message || "CLIENT_REQUEST_FAILED");
}

function projectState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const account = source.account || { phase: "signed_out" };
  const authenticated = account.phase === "authenticated";
  const connection = source.connection || null;
  const connected = source.phase === "ready" && connection?.mode === "netbird";
  const networkReady =
    source.platform?.phase === "ready" && source.network?.phase === "ready";
  const devices = Array.isArray(source.devices)
    ? source.devices.map((device) => ({
        ...device,
        name: device.displayName || device.deviceId,
        lifecycle: device.accessState === "ready" ? "ready" : "discovered",
        initialized: device.accessState === "ready",
        platformOnline: source.platform?.phase === "ready",
      }))
    : [];

  return {
    ...source,
    route: !authenticated ? "auth" : connected ? "connected" : "devices",
    phase: !authenticated
      ? account.phase === "authenticating"
        ? "authenticating"
        : "signed_out"
      : connected
        ? "connected"
        : "idle",
    account: {
      ...account,
      displayName: account.accountId || "万象用户",
    },
    devices,
    networkReady,
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
  "auth.login": (input) =>
    ipcRenderer.invoke("wanx-client:login-password", {
      phone: input?.username,
      password: input?.password,
    }),
  "auth.send-code": (input) =>
    ipcRenderer.invoke("wanx-client:send-sms", { phone: input?.username }),
  "auth.logout": () => ipcRenderer.invoke("wanx-client:logout"),
  "devices.refresh": () => ipcRenderer.invoke("wanx-client:refresh-devices"),
  "devices.connect": (input) =>
    ipcRenderer.invoke("wanx-client:connect-box", input?.deviceId),
  "devices.disconnect": () => ipcRenderer.invoke("wanx-client:disconnect"),
  "applications.list": () => ipcRenderer.invoke("wanx-client:applications-list"),
  "applications.install": (input) => ipcRenderer.invoke("wanx-client:applications-install", input),
  "applications.launch": (input) => ipcRenderer.invoke("wanx-client:applications-launch", input),
  "applications.stop": (input) => ipcRenderer.invoke("wanx-client:applications-stop", input),
};

async function action(name, input = {}) {
  if (name === "auth.register") {
    return { ok: false, code: "ACCOUNT_REGISTRATION_UNAVAILABLE", state: await getLocalState() };
  }
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
  subscribe: (listener) => {
    const handler = (_event, request) => listener(request);
    ipcRenderer.on("wanx:setup:transport", handler);
    return () => ipcRenderer.removeListener("wanx:setup:transport", handler);
  },
  reply: (result) => ipcRenderer.send("wanx:setup:transport-result", result),
  status: (connectionId, frame) => ipcRenderer.send("wanx:setup:transport-status", { connectionId, frame }),
});

contextBridge.exposeInMainWorld("wanxDiscovery", {
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
