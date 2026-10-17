const { contextBridge, ipcRenderer } = require("electron");
// The quick panel can read only the available point total; no account, installer, filesystem, or Bluetooth bridge.
const actions = new Set([
  "applications-request-open", "applications-confirm-open", "applications-cancel-open",
  "desktop-open", "desktop-hide", "desktop-resize", "desktop-about",
]);
contextBridge.exposeInMainWorld("wanxPanel", {
  getState: () => ipcRenderer.invoke("wanx-client:get-state"),
  getBalance: () => ipcRenderer.invoke("wanx-client:panel-balance"),
  action(name, input) {
    if (!actions.has(name)) return Promise.reject(new Error("PANEL_ACTION_NOT_ALLOWED"));
    return ipcRenderer.invoke(`wanx-client:${name}`, input);
  },
  onState(listener) {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("wanx-client:state", handler);
    return () => ipcRenderer.removeListener("wanx-client:state", handler);
  },
});
