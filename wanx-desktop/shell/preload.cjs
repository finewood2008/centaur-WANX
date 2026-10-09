const { contextBridge, ipcRenderer } = require("electron");
let current = null;
const listeners = new Set();
ipcRenderer.on("wanx-desktop:state", (_event, value) => {
  current = value;
  for (const listener of listeners) listener(value);
});
contextBridge.exposeInMainWorld("wanxDesktop", {
  async action(action, input = {}) {
    const reply = await ipcRenderer.invoke("wanx-desktop:action", {
      action,
      input,
    });
    if (!reply.ok) throw new Error(reply.code);
    if (reply.state) current = reply.state;
    return reply.value;
  },
  sessionToken: () => current?.sessionId || "",
  currentBoxId: () => current?.box?.id || "",
  subscribe(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
});
