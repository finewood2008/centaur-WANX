const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "wanxClient",
  Object.freeze({
    getState: () => ipcRenderer.invoke("wanx-client:get-state"),
    setNetworkEnabled: (enabled) =>
      ipcRenderer.invoke("wanx-client:set-network-enabled", enabled),
    loginPassword: ({ phone, password }) =>
      ipcRenderer.invoke("wanx-client:login-password", { phone, password }),
    loginSMS: ({ phone, code }) =>
      ipcRenderer.invoke("wanx-client:login-sms", { phone, code }),
    sendSMS: ({ phone }) =>
      ipcRenderer.invoke("wanx-client:send-sms", { phone }),
    logout: () => ipcRenderer.invoke("wanx-client:logout"),
    refreshDevices: () => ipcRenderer.invoke("wanx-client:refresh-devices"),
    connectBox: (deviceId) =>
      ipcRenderer.invoke("wanx-client:connect-box", deviceId),
    connect: (endpoint) => ipcRenderer.invoke("wanx-client:connect", endpoint),
    disconnect: () => ipcRenderer.invoke("wanx-client:disconnect"),
    subscribe: (listener) => {
      const receive = (_event, state) => listener(state);
      ipcRenderer.on("wanx-client:state", receive);
      return () => ipcRenderer.removeListener("wanx-client:state", receive);
    },
  }),
);
