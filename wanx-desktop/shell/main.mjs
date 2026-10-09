import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronSecureStore } from "centaurai-wanx";
import { createDesktopSession } from "./session.mjs";
import { startGateway } from "./gateway.mjs";
import { createDraftStore } from "./drafts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.WANX_DESKTOP_USER_DATA)
  app.setPath("userData", resolve(process.env.WANX_DESKTOP_USER_DATA));
let window,
  service,
  gateway,
  heartbeat,
  closing = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      let deployment;
      try {
        deployment = JSON.parse(
          await readFile(resolve(root, "deployment.json"), "utf8"),
        );
      } catch (error) {
        if (error.code !== "ENOENT")
          throw new Error("INVALID_DEPLOYMENT_CONFIG");
      }
      service = createDesktopSession({
        deployment,
        draftStore: createDraftStore(
          resolve(app.getPath("userData"), "product-drafts.json"),
        ),
        secureStore: createElectronSecureStore({
          safeStorage,
          directory: app.getPath("userData"),
        }),
        emit: (state) => {
          if (window && !window.isDestroyed())
            window.webContents.send("wanx-desktop:state", state);
        },
      });
      gateway = await startGateway({
        service,
        directory: resolve(root, "dist-ui"),
      });
      window = new BrowserWindow({
        width: 1360,
        height: 900,
        minWidth: 1000,
        minHeight: 680,
        title: "万象电脑端",
        backgroundColor: "#FAF7F2",
        webPreferences: {
          preload: resolve(root, "shell/preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("https://")) void shell.openExternal(url);
        return { action: "deny" };
      });
      window.webContents.on("will-navigate", (event, url) => {
        if (new URL(url).origin !== gateway.origin) event.preventDefault();
      });
      window.webContents.session.setPermissionRequestHandler(
        (contents, permission, callback, details) => callback(
          contents === window.webContents &&
          permission === "media" &&
          details.isMainFrame &&
          new URL(details.requestingUrl).origin === gateway.origin &&
          details.mediaTypes?.length > 0 &&
          details.mediaTypes.every((type) => type === "audio") &&
          service.snapshot().phase === "ready",
        ),
      );
      ipcMain.handle(
        "wanx-desktop:action",
        async (event, { action, input } = {}) => {
          if (
            event.sender !== window?.webContents ||
            event.senderFrame !== window.webContents.mainFrame ||
            new URL(event.senderFrame.url).origin !== gateway.origin
          )
            return { ok: false, code: "UNTRUSTED_FRAME" };
          try {
            const value = await service.action(action, input);
            return { ok: true, value, state: service.snapshot() };
          } catch (error) {
            const code = error.code || error.message;
            return {
              ok: false,
              code: /^[A-Z_]+$/.test(code) ? code : "CLIENT_REQUEST_FAILED",
              state: service.snapshot(),
            };
          }
        },
      );
      await window.loadURL(gateway.origin + "/boxes");
      heartbeat = setInterval(() => {
        void service.refresh();
      }, 10000);
      window.show();
    })
    .catch(() => {
      console.error("WANX_CLIENT_START_FAILED");
      app.quit();
    });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (closing || !service) return;
    event.preventDefault();
    closing = true;
    clearInterval(heartbeat);
    void Promise.allSettled([service.close(), gateway?.close()]).finally(() =>
      app.quit(),
    );
  });
}
