const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wanxClient", {
  getState: async () => (await ipcRenderer.invoke("wanx-client:state")).state,
  action: (action, input = {}) => ipcRenderer.invoke("wanx-client:action", { action, input }),
  checkHealth: (baseURL) => ipcRenderer.invoke("wanx-client:health", { baseURL }),
  openDashboard: () => ipcRenderer.invoke("wanx-client:dashboard"),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("wanx-client:state", handler);
    return () => ipcRenderer.removeListener("wanx-client:state", handler);
  },
});

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
