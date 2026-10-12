import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  powerMonitor,
} from "electron";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { createClient } from "../client.mjs";
import { createNetwork } from "../network/index.mjs";
import { createSidecar } from "../network/sidecar.mjs";
import { registerControlActions } from "./control.mjs";
import { claimSingleInstance } from "./instance.mjs";
import { createAccount, DEFAULT_CONSUMER_URL } from "../account/index.mjs";
import { createSetupRuntime } from "./setup.mjs";
import { createSecureAccountStore } from "../account/store.mjs";
import { createPlatformClient } from "../platform.mjs";
import { createApplicationManager } from "../applications/manager.mjs";
import { createApplicationMarket } from "../applications/market.mjs";
import { runManagedApplication } from "../applications/runtime.mjs";
import { createMarketSessionGuard } from "./market-session.mjs";
import { monitorNetworkChanges } from "./network-monitor.mjs";
import { createTimingRecorder } from "./timings.mjs";
import { createDashboardGateway } from "../octop/gateway.mjs";
import { createStaticAssetCache } from "../octop/static-cache.mjs";

const controlURL = new URL("../local-ui/renderer/index.html", import.meta.url).href;
let control;
let client;
let unsubscribe;
let setupRuntime;
let applications;
let marketSession;
let quitting = false;
let stopNetworkMonitor;
let timings;

// Local timings contain fixed step names only; console output remains opt-in.
async function timed(step, operation) {
  return timings ? timings.run(step, operation) : operation();
}

function reportError(error) {
  console.error("[wanx-client]", error.message);
}

async function marketTrustedKeys() {
  const trust = JSON.parse(await readFile(new URL("../applications/market-trust.json", import.meta.url), "utf8"));
  return trust.keys;
}

// Do not await readiness at ESM top level: Electron waits for the entry module
// to finish evaluating before emitting ready.
if (process.argv.includes("--wanx-managed-app")) {
  // Managed application children use their own userData and never claim the
  // WANX singleton or initialize another network/account controller.
  marketTrustedKeys()
    .then((trustedKeys) => runManagedApplication({
      applicationRoot: path.join(app.getPath("userData"), "applications"),
      trustedKeys,
      app,
    }))
    .catch((error) => { reportError(error); app.exit(1); });
} else if (claimSingleInstance(app, () => control))
  app
    .whenReady()
    .then(async () => {
      const binaryName = `wanx-netbird-${process.platform}-${process.arch}${
        process.platform === "win32" ? ".exe" : ""
      }`;
      const userData = app.getPath("userData");
      timings = createTimingRecorder({
        filePath: path.join(userData, "logs", "connection-timings.jsonl"),
        consoleOutput: process.env.WANX_CONNECTION_TIMINGS === "1",
      });
      const staticCache = createStaticAssetCache({
        directory: path.join(userData, "static-assets"),
      });
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
        const step =
          {
            "/app-api/network/boxes": "boxes.read",
            "/app-api/network/boxes/prepare": "boxes.prepare",
            "/app-api/network/restore": "network.restore",
            "/app-api/network/enrollments": "network.enroll",
            "/app-api/network/devices": "network.devices",
          }[input.path] ||
          (/^\/app-api\/network\/enrollments\/[\w-]+$/.test(input.path)
            ? "network.confirm"
            : /\/wanx\/sso-grants$/.test(input.path)
            ? "box.grant"
            : null);
        return step
          ? timed(step, () => requestAccount(input))
          : requestAccount(input);
      };
      let preferenceWrites = Promise.resolve();
      client = createPlatformClient({
        account,
        measure: timed,
        resumeStore: createSecureAccountStore({
          filePath: path.join(userData, "network-resume.enc"),
          safeStorage,
        }),
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
          return {
            network,
            client: createClient({
              network,
              createGateway: (options) =>
                createDashboardGateway({
                  ...options,
                  staticCache,
                  cacheScope: identity
                    ? { accountId: identity.accountId, boxId: options.deviceId }
                    : undefined,
                }),
            }),
          };
        },
      });
      const trustedKeys = await marketTrustedKeys();
      applications = await createApplicationManager({
        applicationRoot: path.join(userData, "applications"),
        applicationId: "wanx-host",
        context: () => client.applicationContext(),
        request: (input) => client.applicationRequest(input),
        stream: (input) => client.applicationStream(input),
        createConnection: () => client.applicationConnection(),
        trustedKeys,
        launcherArgs: [
          ...(app.isPackaged ? [] : [app.getAppPath()]),
          "--wanx-managed-app",
          `--user-data-dir=${userData}`,
          ...(app.commandLine.hasSwitch("use-mock-keychain") ? ["--use-mock-keychain"] : []),
        ],
      });
      marketSession = createMarketSessionGuard(account);
      const market = createApplicationMarket({
        request: (input) => account.request(input),
        applications,
        wanxVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        trustedKeys,
        captureSession: () => marketSession.captureSession(),
      });
      control = new BrowserWindow({
        width: 1180,
        height: 760,
        minWidth: 900,
        minHeight: 620,
        title: "万象",
        webPreferences: {
          preload: fileURLToPath(
            new URL("../local-ui/remote-preload.cjs", import.meta.url),
          ),
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
        applications,
        market,
        allowDevelopmentInstall: !app.isPackaged && process.env.WANX_ALLOW_DEVELOPMENT_INSTALL === "1",
      });
      unsubscribe = client.subscribe(async () => {
        if (!control.isDestroyed()) {
          const applicationsState = applications ? await applications.listInstalled() : [];
          if (!control.isDestroyed()) control.webContents.send("wanx-client:state", { ...client.snapshot(), applications: applicationsState });
        }
      });

      app.on("before-quit", (event) => {
        if (quitting) return;
        event.preventDefault();
        quitting = true;
        unsubscribe();
        marketSession?.close();
        stopNetworkMonitor?.();
        Promise.resolve(setupRuntime?.dispose())
          .catch(() => {})
          .then(() => Promise.allSettled([applications?.close(), client.close()]))
          .then(() => timings.flush())
          .finally(() => app.quit());
      });
      control.on("closed", () => app.quit());
      app.on("window-all-closed", () => app.quit());
      await control.loadURL(controlURL);
      setupRuntime = await createSetupRuntime({
        control, controlURL, ipcMain, account, client, safeStorage, userData,
        consumerBaseUrl: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        onError: reportError,
      }).catch((error) => {
        reportError(error);
        control.webContents.send("wanx:setup:state", {
          state: "terminalError", errorCode: "SETUP_START_FAILED",
        });
        return null;
      });
      stopNetworkMonitor = monitorNetworkChanges({
        powerMonitor,
        onChange: () => client.networkChanged(),
        onError: reportError,
      });
      void timed("client.initialize", () => client.initialize()).catch(
        reportError,
      );
    })
    .catch((error) => {
      reportError(error);
      app.quit();
    });
