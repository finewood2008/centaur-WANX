import { randomUUID } from "node:crypto";
import { externalHTTPURL, isDashboardURL, sameOrigin } from "./security.mjs";

// The box Dashboard has no preload or privileged IPC, and never shares storage
// with either the connection window or a previously connected box.
export function createDashboardWindows({
  BrowserWindow,
  session,
  disconnect,
  onError,
  requestMedia,
  openExternal,
}) {
  let current = null;
  const cleanup = new Set();

  function dispose(entry) {
    if (!entry) return;
    for (const child of entry.children)
      if (!child.isDestroyed()) child.destroy();
    if (!entry.window.isDestroyed()) entry.window.destroy();
    const pending = Promise.all([
      entry.session.clearStorageData(),
      entry.session.clearCache(),
    ])
      .catch(onError)
      .finally(() => cleanup.delete(pending));
    cleanup.add(pending);
  }

  function sync(state) {
    if (
      state.phase === "recovering" &&
      current &&
      state.connection?.gatewayURL === current.gatewayURL
    )
      return;
    const connection = state.phase === "ready" ? state.connection : null;
    if (current?.gatewayURL === connection?.gatewayURL) return;
    const old = current;
    current = null;
    dispose(old);
    if (!connection) return;

    const isolatedSession = session.fromPartition(
      `wanx-client-${randomUUID()}`,
    );
    const window = new BrowserWindow({
      width: 1320,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      title: connection.name || "万象",
      webPreferences: {
        session: isolatedSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    const entry = {
      window,
      session: isolatedSession,
      gatewayURL: connection.gatewayURL,
      children: new Set(),
    };
    current = entry;
    isolatedSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        if (
          contents !== window.webContents ||
          !sameOrigin(contents.getURL(), entry.gatewayURL) ||
          !sameOrigin(details.requestingUrl, entry.gatewayURL)
        ) {
          callback(false);
          return;
        }
        if (permission === "clipboard-sanitized-write") callback(true);
        else if (permission === "media" && requestMedia) {
          Promise.resolve(requestMedia(window, details.mediaTypes || []))
            .then((allowed) => callback(Boolean(allowed && current === entry)))
            .catch(() => callback(false));
        } else callback(false);
      },
    );
    function openLink(url) {
      const safeURL = externalHTTPURL(url);
      if (safeURL && openExternal)
        Promise.resolve(openExternal(safeURL)).catch(onError);
    }
    function protect(target) {
      target.webContents.setWindowOpenHandler(({ url }) => {
        if (!isDashboardURL(url, entry.gatewayURL)) {
          openLink(url);
          return { action: "deny" };
        }
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            webPreferences: {
              session: isolatedSession,
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              webSecurity: true,
              allowRunningInsecureContent: false,
            },
          },
        };
      });
      target.webContents.on("did-create-window", (child) => {
        entry.children.add(child);
        child.on("closed", () => entry.children.delete(child));
        protect(child);
      });
      target.webContents.on("will-navigate", (event, url) => {
        if (isDashboardURL(url, entry.gatewayURL)) return;
        event.preventDefault();
        openLink(url);
      });
      target.webContents.on("will-redirect", (event, url) => {
        if (!isDashboardURL(url, entry.gatewayURL)) event.preventDefault();
      });
      target.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
    }
    protect(window);
    window.on("closed", () => {
      if (current !== entry) return;
      current = null;
      dispose(entry);
      Promise.resolve(disconnect()).catch(onError);
    });
    window.loadURL(connection.gatewayURL).catch((error) => {
      if (current !== entry) return;
      onError(error);
      Promise.resolve(disconnect()).catch(onError);
    });
  }

  return {
    sync,
    async close() {
      const old = current;
      current = null;
      dispose(old);
      await Promise.all([...cleanup]);
    },
  };
}
