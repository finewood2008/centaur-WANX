const { contextBridge, ipcRenderer, webUtils } = require("electron");
// Narrow quick-panel actions only; disk paths are extracted here from dropped Files.
const actions = new Set([
  "applications-request-open", "applications-confirm-open", "applications-cancel-open",
  "desktop-open", "desktop-hide", "desktop-resize", "desktop-about",
]);
contextBridge.exposeInMainWorld("wanxPanel", {
  getState: () => ipcRenderer.invoke("wanx-client:get-state"),
  getSpace: () => ipcRenderer.invoke("wanx-client:panel-space-snapshot"),
  refreshSpace: () => ipcRenderer.invoke("wanx-client:panel-space-refresh"),
  async uploadDroppedFiles(files, scope) {
    try {
      if (!Array.isArray(files) || !files.length) throw new Error("SPACE_INVALID_DROP");
      const paths = files.map(file => webUtils.getPathForFile(file));
      if (paths.some(path => !path)) throw new Error("SPACE_INVALID_DROP");
      await ipcRenderer.invoke("wanx-client:panel-space-upload", { paths, scope });
      return { ok: true };
    } catch (error) {
      const code = String(error?.message || "").match(/\b(?:SPACE_[A-Z_]+|BOX_CONNECTION_REQUIRED|ACCOUNT_LOGIN_REQUIRED|NETWORK_NOT_READY|SECURE_STORAGE_[A-Z_]+)\b/)?.[0] || "SPACE_REQUEST_FAILED";
      return { ok: false, code };
    }
  },
  transfer: (action, id, scope) => ipcRenderer.invoke("wanx-client:panel-space-transfer", { action, id, scope }),
  onSpace(listener) {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("wanx-client:panel-space-state", handler);
    return () => ipcRenderer.removeListener("wanx-client:panel-space-state", handler);
  },
  getApplicationNames: () => ipcRenderer.invoke("wanx-client:panel-application-names"),
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
