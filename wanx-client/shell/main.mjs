import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  safeStorage,
} from "electron";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { createClient } from "../client.mjs";
import { createNetwork } from "../network/index.mjs";
import { createSidecar } from "../network/sidecar.mjs";
import { createDashboardWindows } from "./dashboard.mjs";
import { registerControlActions } from "./control.mjs";
import { claimSingleInstance } from "./instance.mjs";
import { createAccount } from "../account/index.mjs";
import { createSecureAccountStore } from "../account/store.mjs";
import { createPlatformClient } from "../platform.mjs";

const controlURL = new URL("../fleet/index.html", import.meta.url).href;
let control;
let client;
let dashboards;
let unsubscribe;
let quitting = false;

// Opt-in timings contain fixed step names only, never requests or credentials.
async function timed(step, operation) {
  if (process.env.WANX_CONNECTION_TIMINGS !== "1") return operation();
  const started = performance.now();
  console.info("[wanx-timing]", step, "started");
  let outcome = "failed";
  try {
    const result = await operation();
    outcome = "completed";
    return result;
  } finally {
    console.info(
      "[wanx-timing]",
      step,
      outcome,
      Math.round(performance.now() - started),
      "ms",
    );
  }
}

function reportError(error) {
  console.error("[wanx-client]", error.message);
}

// Do not await readiness at ESM top level: Electron waits for the entry module
// to finish evaluating before emitting ready.
if (claimSingleInstance(app, () => control))
  app
    .whenReady()
    .then(async () => {
      const binaryName = `wanx-netbird-${process.platform}-${process.arch}${
        process.platform === "win32" ? ".exe" : ""
      }`;
      const userData = app.getPath("userData");
      const binaryPath = app.isPackaged
        ? path.join(process.resourcesPath, "network", binaryName)
        : fileURLToPath(
            new URL(`../native/bin/${binaryName}`, import.meta.url),
          );
      const account = createAccount({
        ...(process.env.WANX_CONSUMER_URL
          ? { baseURL: process.env.WANX_CONSUMER_URL }
          : {}),
        store: createSecureAccountStore({
          filePath: path.join(userData, "account.enc"),
          safeStorage,
        }),
        deviceModel: os.hostname(),
      });
      const preferenceFile = path.join(userData, "p2p-preference.json");
      const requestAccount = account.request;
      account.request = (input) => {
        const step = {
          "/app-api/network/boxes": "boxes.read",
          "/app-api/network/boxes/prepare": "boxes.prepare",
          "/app-api/network/restore": "network.restore",
          "/app-api/network/enrollments": "network.enroll",
          "/app-api/network/devices": "network.devices",
        }[input.path];
        return step
          ? timed(step, () => requestAccount(input))
          : requestAccount(input);
      };
      let preferenceWrites = Promise.resolve();
      client = createPlatformClient({
        account,
        async readPreference() {
          try {
            return (
              JSON.parse(await readFile(preferenceFile, "utf8")).enabled !==
              false
            );
          } catch (error) {
            if (error.code === "ENOENT") return true;
            throw error;
          }
        },
        writePreference(enabled) {
          preferenceWrites = preferenceWrites
            .catch(() => {})
            .then(async () => {
              await mkdir(userData, { recursive: true, mode: 0o700 });
              await writeFile(
                `${preferenceFile}.tmp`,
                JSON.stringify({ enabled }),
                { mode: 0o600 },
              );
              await rename(`${preferenceFile}.tmp`, preferenceFile);
            });
          return preferenceWrites;
        },
        createTransport(identity) {
          const scope = createHash("sha256")
            .update(JSON.stringify(identity || "direct"))
            .digest("hex");
          const network = createNetwork({
            binaryPath,
            createSidecar(options) {
              const sidecar = createSidecar(options);
              return {
                ...sidecar,
                request(method, ...args) {
                  return method === "start"
                    ? timed("engine.start", () =>
                        sidecar.request(method, ...args),
                      )
                    : sidecar.request(method, ...args);
                },
              };
            },
            configDir: path.join(userData, "network", scope),
            deviceName: `wanx-${os.hostname()}`,
          });
          return { network, client: createClient({ network }) };
        },
      });
      dashboards = createDashboardWindows({
        BrowserWindow,
        session,
        disconnect: () => client.disconnect(),
        onError: reportError,
        openExternal: (url) => shell.openExternal(url),
        async requestMedia(window, mediaTypes) {
          const devices = mediaTypes.includes("video")
            ? "摄像头或麦克风"
            : "麦克风";
          const { response } = await dialog.showMessageBox(window, {
            type: "question",
            title: "万象设备权限",
            message: `允许当前万象页面使用${devices}吗？`,
            buttons: ["不允许", "允许"],
            defaultId: 0,
            cancelId: 0,
          });
          return response === 1;
        },
      });
      control = new BrowserWindow({
        width: 720,
        height: 820,
        minWidth: 540,
        minHeight: 660,
        title: "万象 · 连接",
        webPreferences: {
          preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
      control.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      control.webContents.on("will-navigate", (event) =>
        event.preventDefault(),
      );
      control.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );

      registerControlActions({
        ipcMain,
        control,
        controlURL,
        client,
        openExternal: (url) => shell.openExternal(url),
      });
      unsubscribe = client.subscribe((state) => {
        dashboards.sync(state);
        if (!control.isDestroyed())
          control.webContents.send("wanx-client:state", state);
      });

      app.on("before-quit", (event) => {
        if (quitting) return;
        event.preventDefault();
        quitting = true;
        unsubscribe();
        Promise.allSettled([dashboards.close(), client.close()]).then(() =>
          app.quit(),
        );
      });
      control.on("closed", () => app.quit());
      app.on("window-all-closed", () => app.quit());
      await control.loadURL(controlURL);
      void timed("client.initialize", () => client.initialize()).catch(
        reportError,
      );
    })
    .catch((error) => {
      reportError(error);
      app.quit();
    });
