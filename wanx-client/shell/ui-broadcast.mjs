// Sample connection/UI state after the asynchronous installed-app read. A newer
// publish supersedes any in-flight read, so an old result cannot repaint either window.
export function createUIBroadcast({ client, applications, uiState, startup, windows, onError = () => {} }) {
  let revision = 0, closed = false;
  async function getState() {
    let installed, current;
    do {
      current = revision;
      installed = await applications.listInstalled();
    } while (!closed && current !== revision);
    return { ...client.snapshot(), applications: installed, ui: uiState.snapshot(), desktopStartup: startup.get() };
  }
  async function publish() {
    const current = ++revision;
    try {
      const state = await getState();
      if (closed || current !== revision) return;
      for (const window of windows()) {
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
          window.webContents.send("wanx-client:state", state);
      }
    } catch (error) { onError(error); }
  }
  return { getState, publish, dispose() { closed = true; revision++; } };
}
