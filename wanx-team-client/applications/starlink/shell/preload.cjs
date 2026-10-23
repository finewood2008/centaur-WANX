const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "semantica",
  Object.freeze({
    call: async (action, input = {}) => {
      const result = await ipcRenderer.invoke("semantica:action", {
        action,
        input,
      });
      if (!result.ok)
        throw Object.assign(new Error(result.code), { code: result.code, publicMessage: result.message });
      return result.value;
    },
    subscribe: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("semantica:event", listener);
      return () => ipcRenderer.removeListener("semantica:event", listener);
    },
  }),
);
