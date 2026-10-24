import { randomUUID } from "node:crypto";
import { dashboardRoutes } from "../octop/dashboard-routes.mjs";
import { externalHTTPURL, isDashboardURL, sameOrigin } from "./security.mjs";

// The box Dashboard has no preload or privileged IPC, and never shares storage
// with either the connection window or a previously connected box.
export function createDashboardWindows(options) {
  const surfaces = new Map();
  const controller = {
    open(state, destination = "dashboard") {
      if (!Object.hasOwn(dashboardRoutes, destination)) throw new Error("INVALID_MAINTENANCE_TOOL");
      if (!surfaces.has(destination)) surfaces.set(destination, createDashboardSurface({ ...options, openDashboard: state => controller.open(state, "dashboard") }, dashboardRoutes[destination]));
      return surfaces.get(destination).open(state);
    },
    sync(state) { for (const surface of surfaces.values()) surface.sync(state); },
    async close() { await Promise.all([...surfaces.values()].map(surface => surface.close())); },
  };
  return controller;
}

function createDashboardSurface({
  BrowserWindow,
  session,
  onError,
  requestMedia,
  openExternal,
  openDashboard,
}, route) {
  let current = null;
  let latestState = null;
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
    latestState = state;
    const connection =
      ["ready", "recovering"].includes(state.phase) &&
      (!state.account || state.account.phase === "authenticated") &&
      state.network?.enabled !== false
        ? state.connection
        : null;
    if (current?.gatewayURL === connection?.gatewayURL) return;
    const old = current;
    current = null;
    dispose(old);
  }

  async function open(state) {
    sync(state);
    const connection = state.connection;
    if (state.phase !== "ready" || !connection?.gatewayURL)
      throw new Error("BOX_CONNECTION_REQUIRED");
    if (current) {
      if (current.window.isMinimized()) current.window.restore();
      current.window.show();
      current.window.focus();
      return current.loading;
    }

    const isolatedSession = session.fromPartition(
      `wanx-client-${randomUUID()}`,
    );
    const window = new BrowserWindow({
      width: 1320,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      title: route.endsWith("/terminal") ? `${connection.name || "万象盒子"} · 终端` : route.endsWith("/desktop") ? `${connection.name || "万象盒子"} · 远程桌面` : connection.name || "万象",
      webPreferences: {
        session: isolatedSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    if (process.platform === "win32") {
      window.setMenu?.(null);
      window.setMenuBarVisibility?.(false);
    }
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
    function allowedToolURL(candidate) {
      if (!isDashboardURL(candidate, entry.gatewayURL)) return false;
      if (route === "/") return true;
      const url = new URL(candidate);
      return url.protocol === "blob:" || url.pathname === route || url.pathname.startsWith("/__wanx_session/") || url.pathname.startsWith("/__wanx_tools/assets/");
    }
    function openLink(url) {
      if (route !== "/" && sameOrigin(url, entry.gatewayURL)) return;
      const safeURL = externalHTTPURL(url);
      if (safeURL && openExternal)
        Promise.resolve(openExternal(safeURL)).catch(onError);
    }
    function protect(target) {
      target.webContents.setWindowOpenHandler(({ url }) => {
        // Only the terminal's fixed Dashboard link opens a separate managed
        // window. Keep the terminal alive and bootstrap fresh box credentials.
        if (target === window && route === dashboardRoutes.terminal &&
            url === new URL("/", entry.gatewayURL).href) {
          if (current === entry && latestState?.phase === "ready")
            Promise.resolve(openDashboard(latestState)).catch(onError);
          return { action: "deny" };
        }
        if (!allowedToolURL(url)) {
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
        if (process.platform === "win32") {
          child.setMenu?.(null);
          child.setMenuBarVisibility?.(false);
        }
        entry.children.add(child);
        child.on("closed", () => entry.children.delete(child));
        protect(child);
      });
      target.webContents.on("will-navigate", (event, url) => {
        if (allowedToolURL(url)) return;
        event.preventDefault();
        openLink(url);
      });
      target.webContents.on("will-redirect", (event, url) => {
        if (!allowedToolURL(url)) event.preventDefault();
      });
      target.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
    }
    if (route !== "/") window.webContents.on("page-title-updated", event => event.preventDefault());
    protect(window);
    window.on("closed", () => {
      if (current !== entry) return;
      current = null;
      dispose(entry);
    });
    const launchURL = new URL(connection.gatewayURL);
    if (route !== "/") {
      // Bootstrap must set the existing session marker before entering a tool.
      if (launchURL.pathname.startsWith("/__wanx_session/")) launchURL.hash = route;
      else launchURL.pathname = route;
    }
    entry.loading = window.loadURL(route === "/" ? connection.gatewayURL : launchURL.href).catch(() => {
      if (current !== entry) return;
      current = null;
      dispose(entry);
      throw new Error("DASHBOARD_OPEN_FAILED");
    });
    return entry.loading;
  }

  return {
    open,
    sync,
    async close() {
      const old = current;
      current = null;
      dispose(old);
      await Promise.all([...cleanup]);
    },
  };
}
