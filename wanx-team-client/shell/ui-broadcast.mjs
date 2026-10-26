// Account and connection state must reach the UI without waiting for disk reads
// or an app installation. Installed apps refresh in the background and publish
// separately; reads from a previous account/connection can never replace them.
export function createUIBroadcast({ client, applications, uiState, startup, updates, defaultApplications, notifications, studioRevision=()=>0, windows, onError = () => {} }) {
  let closed = false, scope, installed = [], reading = null, refreshAgain = false;
  function snapshot() {
    const state = client.snapshot();
    const nextScope = JSON.stringify([state.account?.phase, state.account?.accountId, state.account?.clientId,
      state.connection?.deviceId, state.connection?.mode, state.dataIdentity]);
    if (nextScope !== scope) {
      scope = nextScope;
      installed = [];
      reading = null;
      refreshAgain = false;
    }
    return { ...state, studioChanged:studioRevision(), applications: structuredClone(installed), ui: uiState.snapshot(), desktopStartup: startup.get(),
      ...(notifications ? { notifications: notifications.snapshot() } : {}),
      ...(defaultApplications ? { defaultApplications: defaultApplications.snapshot() } : {}),
      ...(updates ? { upgrades: { client: updates.client.snapshot(), box: updates.box.snapshot() } } : {}) };
  }
  function deliver(state) {
    if (closed) return;
    for (const window of windows()) {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send("wanx-client:state", state);
    }
  }
  function refresh() {
    if (closed) return;
    if (reading) { refreshAgain = true; return; }
    const currentScope = scope;
    const work = Promise.resolve().then(() => applications.listInstalled());
    reading = work;
    void work.then(value => {
      snapshot(); // Invalidate a stale read even if no state event was emitted.
      if (closed || currentScope !== scope || reading !== work) return;
      installed = structuredClone(value);
      deliver(snapshot());
    }).catch(onError).finally(() => {
      if (reading !== work) return;
      reading = null;
      if (refreshAgain) { refreshAgain = false; refresh(); }
    });
  }
  function getState() {
    const state = snapshot();
    refresh();
    return state;
  }
  function publish() {
    if (closed) return;
    deliver(getState());
  }
  return { getState, publish, dispose() { closed = true; reading = null; } };
}
