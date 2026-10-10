/** This entry imports no Node APIs and exposes only the fixed SDK IPC channel. */
export function exposeCentaurAIWanxPreload(config: {
  contextBridge: { exposeInMainWorld(name: string, value: unknown): void };
  ipcRenderer: { invoke(channel: string, value: unknown): Promise<unknown> };
}): void {
  config.contextBridge.exposeInMainWorld("centauraiWanx", Object.freeze({
    call: (method: string, params?: unknown) => config.ipcRenderer.invoke("centaurai-wanx:v1", { method, params }),
  }));
}
