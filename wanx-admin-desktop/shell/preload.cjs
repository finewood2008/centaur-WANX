const { contextBridge, ipcRenderer } = require("electron");
const actions = new Set([
  "state",
  "boxes.save",
  "boxes.remove",
  "connect",
  "disconnect",
  "refresh",
  "overview",
  "resource.list",
  "resource.create",
  "resource.update",
  "resource.delete",
  "resource.test",
  "products.list",
  "products.create",
  "products.update",
  "deployment.get",
  "deployment.put",
  "releases.list",
  "releases.create",
  "releases.recommend",
  "access.list",
  "access.put",
  "manifest.import",
  "manifest.export",
  "project.generate",
  "draft.get",
  "draft.put",
  "users.list",
  "users.create",
  "users.update",
  "roles.list",
  "permissions.list",
  "roles.create",
  "audit",
  "desktop.status",
  "desktop.open",
  "desktop.close",
  "desktop.input",
  "desktop.maintain",
  "desktop.geometry",
]);
contextBridge.exposeInMainWorld(
  "wanxAdmin",
  Object.freeze({
    invoke(action, payload = {}, sessionId) {
      if (!actions.has(action))
        return Promise.reject(new Error("未允许的管理操作"));
      return ipcRenderer.invoke("wanx-admin:request", {
        action,
        payload,
        sessionId,
      });
    },
    onState(callback) {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("wanx-admin:state", handler);
      return () => ipcRenderer.removeListener("wanx-admin:state", handler);
    },
    onDesktop(callback) {
      const handler = (_event, frame) => callback(frame);
      ipcRenderer.on("wanx-admin:desktop", handler);
      return () => ipcRenderer.removeListener("wanx-admin:desktop", handler);
    },
  }),
);
