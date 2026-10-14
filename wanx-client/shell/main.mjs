import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  powerMonitor,
  session,
  shell,
  Menu,
  Tray,
  nativeImage,
  dialog,
  screen,
} from "electron";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { createClient } from "../client.mjs";
import { createNetwork } from "../network/index.mjs";
import { createSidecar } from "../network/sidecar.mjs";
import { registerControlActions, openConnectedDashboard } from "./control.mjs";
import { createDashboardWindows } from "./dashboard.mjs";
import { APP_ICON, DESKTOP_NAME, createDesktopIntegration } from "./desktop.mjs";
import { claimSingleInstance } from "./instance.mjs";
import { registerShutdown } from "./shutdown.mjs";
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
import { createUIState } from "./ui-state.mjs";
import { createUIBroadcast } from "./ui-broadcast.mjs";
import { createStartupSettings } from "./startup.mjs";
import { createAdvertisementNames } from "./discovery-names.mjs";

const controlURL = new URL("../local-ui/renderer/index.html", import.meta.url).href;
const panelURL = new URL("../local-ui/panel/index.html", import.meta.url).href;
let control;
let panel;
let uiState;
let broadcast;
let client;
let unsubscribe;
let setupRuntime;
let applications;
let marketSession;
let dashboards;
let desktop;
let stopNetworkMonitor;
let timings;

// Local diagnostics contain fixed steps and allowlisted codes; console output is opt-in.
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
// Keep Electron's existing name/data/keychain identity; branding lives in the
// bundle, About panel and menus. Match the installer identity on Windows.
if (process.platform === "win32") app.setAppUserModelId("ai.centuarai.wanx.client");
if (process.argv.includes("--wanx-managed-app")) {
  marketTrustedKeys().then(trustedKeys => runManagedApplication({
    applicationRoot: path.join(app.getPath("userData"), "applications"), trustedKeys, app,
  })).catch(error => {
    reportError(error);
    process.send?.({ type: "wanx:application-failed", launchId: process.env.WANX_HOST_LAUNCH_ID }, () => {});
    app.exit(1);
  });
} else if (claimSingleInstance(app, () => desktop ? {
  isDestroyed: () => false, isMinimized: () => false,
  show: () => desktop.show(), focus() {},
} : control))
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
                  return ["start", "recover"].includes(method)
                    ? timed(`engine.${method}`, () =>
                        sidecar.request(method, ...args),
                      )
                    : sidecar.request(method, ...args);
                },
              };
            },
            configDir: path.join(userData, "network", scope),
            deviceName: `wanx-${os.hostname()}`,
          });
          if (identity) network.subscribe(state => timings.state("network", state));
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
        runtimeArgs: process.defaultApp ? [app.getAppPath()] : [],
        applicationId: "wanx-host",
        context: () => client.applicationContext(),
        request: (input) => client.applicationRequest(input),
        stream: (input) => client.applicationStream(input),
        createConnection: (applicationId) => client.applicationConnection(applicationId),
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
      const startup = createStartupSettings({ app });
      uiState = await createUIState({
        client, account, applications,
        preferenceFile: path.join(userData, "ui-preferences.json"),
        serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        onChanged: () => { void broadcast?.publish(); },
        onOpened: () => desktop?.hidePanel(),
      });
      control = new BrowserWindow({
        width: 860,
        height: 640,
        minWidth: 760,
        minHeight: 560,
        show: false,
        title: DESKTOP_NAME,
        icon: APP_ICON,
        backgroundColor: "#faf8f4",
        webPreferences: {
          preload: fileURLToPath(
            new URL("../local-ui/remote-preload.cjs", import.meta.url),
          ),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          backgroundThrottling: false,
        },
      });
      if (process.platform === "darwin") {
        panel = new BrowserWindow({
          width: 400, height: 320, show: false, frame: false,
          resizable: false, maximizable: false, minimizable: false,
          fullscreenable: false, skipTaskbar: true, hasShadow: true,
          roundedCorners: true, alwaysOnTop: true, backgroundColor: "#faf8f4",
          title: `${DESKTOP_NAME} · 我的应用`, icon: APP_ICON,
          webPreferences: {
            preload: fileURLToPath(new URL("../local-ui/panel-preload.cjs", import.meta.url)),
            nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
          },
        });
        panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      }
      for (const window of [control, panel].filter(Boolean)) {
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", event => event.preventDefault());
        window.webContents.on("will-attach-webview", event => event.preventDefault());
      }
      broadcast = createUIBroadcast({
        client, applications, uiState, startup, windows: () => [control, panel], onError: reportError,
      });
      let quitPrompt;
      const requestQuit = () => {
        if (quitPrompt) return quitPrompt;
        // Only an explicit user action opens this confirmation. Background state
        // changes never bring either window to the front.
        quitPrompt = dialog.showMessageBox({
          type: "question", title: "退出万象", message: "退出万象？",
          detail: "这会关闭万象所承载的应用，并断开盒子连接。收起窗口可以继续在后台运行。",
          buttons: ["继续运行", "退出万象"], defaultId: 0, cancelId: 0,
        }).then(result => { if (result.response === 1) app.quit(); })
          .finally(() => { quitPrompt = null; });
        return quitPrompt;
      };

      dashboards = createDashboardWindows({
        BrowserWindow,
        session,
        openExternal: (url) => shell.openExternal(url),
        onError: reportError,
      });
      desktop = createDesktopIntegration({
        app, Menu, Tray, nativeImage, control, panel, screen, client, requestQuit,
        onPanelHidden: () => uiState.dismissPanel(),
        openManagement(page) {
          if (control.isDestroyed()) return;
          if (control.isMinimized()) control.restore();
          control.webContents.send("wanx-client:navigate", page);
          control.show();
          control.focus();
        },
        openDashboard: () => openConnectedDashboard(client, dashboards),
        onError: () => {
          desktop.show();
          void dialog.showMessageBox(control, {
            type: "error", title: DESKTOP_NAME,
            message: "暂时无法打开 Dashboard",
            detail: "请在设置中确认网络和盒子已连接，然后重试。",
          });
        },
      });
      registerControlActions({
        ipcMain,
        control,
        controlURL,
        panel,
        panelURL,
        uiState,
        desktop,
        getState: broadcast.getState,
        publishState: broadcast.publish,
        getDesktopStartup: startup.get,
        setDesktopStartup: startup.set,
        showAbout: () => { desktop.hidePanel({ preserveIntent: true }); app.showAboutPanel(); },
        quit: requestQuit,
        client,
        applications,
        dashboards,
        market,
        allowDevelopmentInstall: !app.isPackaged && process.env.WANX_ALLOW_DEVELOPMENT_INSTALL === "1",
        selectApplicationArchive: async () => {
          const result = await dialog.showOpenDialog(control, {
            title: "选择应用安装包",
            buttonLabel: "安装",
            filters: [{ name: "应用压缩包", extensions: ["zip"] }],
            properties: ["openFile"],
          });
          return result.canceled ? null : result.filePaths[0];
        },
      });
      unsubscribe = client.subscribe(() => {
        timings.state("platform", client.snapshot().platform);
        dashboards.sync(client.snapshot());
        desktop.sync(client.snapshot());
        void broadcast.publish();
      });

      registerShutdown({
        app,
        async closeApplications() {
          uiState.invalidateOpen();
          marketSession?.close();
          await Promise.all([market.close(), applications?.close()]);
        },
        async closeHost() {
          desktop.dispose();
          unsubscribe();
          broadcast.dispose();
          await uiState.dispose();
          stopNetworkMonitor?.();
          await Promise.resolve(setupRuntime?.dispose()).catch(() => {});
          await Promise.allSettled([dashboards.close(), client.close()]);
          await timings.flush();
        },
        onError(error) {
          reportError(error);
          dialog.showErrorBox("无法退出万象", "应用尚未完全退出。请关闭应用后再次退出万象。");
        },
      });
      app.on("window-all-closed", () => app.quit());
      await Promise.all([control.loadURL(controlURL), panel?.loadURL(panelURL)]);
      setupRuntime = await createSetupRuntime({
        control, controlURL, ipcMain, account, client, safeStorage, userData,
        advertisementNames: createAdvertisementNames({
          helperPath: app.isPackaged
            ? path.join(process.resourcesPath, "network", `wanx-discovery-${process.platform}-${process.arch}`)
            : fileURLToPath(new URL(`../native/bin/wanx-discovery-${process.platform}-${process.arch}`, import.meta.url)),
        }),
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
      if (!startup.wasOpenedAtLogin()) desktop.show();
      void broadcast.publish();
      void timed("client.initialize", () => client.initialize()).catch(
        reportError,
      );
    })
    .catch((error) => {
      reportError(error);
      app.quit();
    });
