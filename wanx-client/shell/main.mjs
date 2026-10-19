import { panelSpaceState } from "./panel-space.mjs";
import { readAvatar } from "./avatar.mjs";
import { createCreditsReader } from "../account/credits.mjs";
import { createCreditWallet } from "../account/credit-wallet.mjs";
import { createRemoteSupport } from "../account/support.mjs";
import { createApplicationBackend } from "../applications/backend.mjs";
import { createApplicationReleaseAccess } from "../applications/release-access.mjs";
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
import { mkdirSync, readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, rename, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { createClient } from "../client.mjs";
import { createNetwork } from "../network/index.mjs";
import { createSidecar } from "../network/sidecar.mjs";
import { nativeBinaryPaths } from "./native-binaries.mjs";
import { registerControlActions, openConnectedDashboard } from "./control.mjs";
import { createDashboardWindows } from "./dashboard.mjs";
import { APP_ICON, DESKTOP_NAME, createDesktopIntegration } from "./desktop.mjs";
import { claimSingleInstance } from "./instance.mjs";
import { registerShutdown } from "./shutdown.mjs";
import { createAccount, DEFAULT_CONSUMER_URL } from "../account/index.mjs";
import { createSetupRuntime } from "./setup.mjs";
import { createSecureAccountStore } from "../account/store.mjs";
import { createLocalBoxes } from "../octop/local-boxes.mjs";
import { createPlatformClient } from "../platform.mjs";
import { createApplicationManager } from "../applications/manager.mjs";
import { createApplicationMarket } from "../applications/market.mjs";
import { createDefaultApplicationDelivery } from "../applications/delivery.mjs";
import { createDefaultApplicationScheduler } from "../applications/delivery-scheduler.mjs";
import { runManagedApplication } from "../applications/runtime.mjs";
import { createMarketSessionGuard } from "./market-session.mjs";
import { monitorNetworkChanges } from "./network-monitor.mjs";
import { createTimingRecorder } from "./timings.mjs";
import { createDashboardGateway } from "../octop/gateway.mjs";
import { createStaticAssetCache } from "../octop/static-cache.mjs";
import { createUIState } from "./ui-state.mjs";
import { createUIBroadcast } from "./ui-broadcast.mjs";
import { createStartupSettings } from "./startup.mjs";
import { createSpaceLinkBridge } from "./space-links.mjs";
import { createPersonalSpace } from "./personal-space.mjs";
import { createAdvertisementNames } from "./discovery-names.mjs";
import { protectPrivateDirectory } from "./private-storage.mjs";
import { readClientIdentity, installationIdentity } from "../updates/identity.mjs";
import { createUpdateStore } from "../updates/store.mjs";
import { createClientUpdates } from "../updates/client-service.mjs";
import { createBoxUpdates } from "../updates/box-service.mjs";
import { createElectronUpdateAdapter } from "../updates/electron.mjs";

import { testPackageIdentity, TEST_APP_ID, TEST_PRODUCT_NAME } from "../updates/test-build.mjs";
import { createTestUpdateRuntime } from "../updates/test-runtime.mjs";

const testBuild = app.isPackaged ? testPackageIdentity(JSON.parse(readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"))) : null;
const windowName = testBuild ? TEST_PRODUCT_NAME : DESKTOP_NAME;
const controlURL = new URL("../local-ui/renderer/index.html", import.meta.url).href;
const panelURL = new URL("../local-ui/panel/index.html", import.meta.url).href;
if (!testBuild && process.env.WANX_SMOKE_USER_DATA) {
  const isolated = path.resolve(process.env.WANX_SMOKE_USER_DATA);
  mkdirSync(isolated, { recursive: true });
  app.setPath("userData", isolated);
}
let control;
let panel;
let uiState;
let broadcast;
let client;
let unsubscribe;
let setupRuntime;
let applications;
let personalSpace;
let spaceLinks;
let marketSession;
let dashboards;
let desktop;
let stopNetworkMonitor;
let timings;
let terminalConsoleRequested = process.argv.includes("--wanx-console");
function openTerminalConsole() {
  if (!terminalConsoleRequested || !client || !dashboards || client.snapshot().phase !== "ready") return;
  terminalConsoleRequested = false;
  void Promise.resolve().then(() => openConnectedDashboard(client, dashboards)).catch(reportError);
}
function terminalCommand(argv) {
  if (!Array.isArray(argv) || !argv.includes("--wanx-console")) return false;
  terminalConsoleRequested = true;
  openTerminalConsole();
  return true;
}
let updates;
let shutdown;

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
if (process.platform === "win32") app.setAppUserModelId(testBuild ? TEST_APP_ID : "ai.centuarai.wanx.client");
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
} : control, terminalCommand))
  app
    .whenReady()
    .then(async () => {
      const nativePaths = nativeBinaryPaths({ appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath, packaged: app.isPackaged });
      const userData = app.getPath("userData");
      await protectPrivateDirectory(userData, { packaged: app.isPackaged });
      if (process.argv.includes("--wanx-smoke-safe-storage")) {
        const smokeFile = path.join(userData, "smoke-account.enc");
        const smokeStore = createSecureAccountStore({ filePath: smokeFile, safeStorage });
        const marker = { smoke: "wanx-dpapi-roundtrip" };
        try {
          await smokeStore.save(marker);
          if (JSON.stringify(await smokeStore.load()) !== JSON.stringify(marker))
            throw new Error("WANX_SMOKE_STORAGE_MISMATCH");
          await writeFile(path.join(userData, "smoke-storage-ready.marker"), "ready");
        } finally {
          await smokeStore.clear();
          app.quit();
        }
        return;
      }
      timings = createTimingRecorder({
        filePath: path.join(userData, "logs", "connection-timings.jsonl"),
        consoleOutput: process.env.WANX_CONNECTION_TIMINGS === "1",
      });
      const staticCache = createStaticAssetCache({
        directory: path.join(userData, "static-assets"),
      });
      const binaryPath = nativePaths.engine;
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
      let creditsServiceURL = process.env.WANX_CREDITS_URL || "";
      if (!creditsServiceURL) {
        try {
          const file = path.join(userData, "credits-service.json");
          const info = await lstat(file);
          if (!info.isFile() || info.size > 4096 || (process.platform !== "win32" && (info.uid !== process.getuid() || (info.mode & 0o077))))
            throw new Error("CREDITS_INVALID_CONFIG");
          const config = JSON.parse(await readFile(file, "utf8"));
          if (config.version !== 1 || typeof config.serviceURL !== "string") throw new Error("CREDITS_INVALID_CONFIG");
          creditsServiceURL = config.serviceURL;
        } catch (error) { if (error.code !== "ENOENT") reportError(new Error("CREDITS_INVALID_CONFIG")); }
      }
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
        localBoxes: createLocalBoxes(),
        creditsServiceURL,
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
      const releaseAccess = createApplicationReleaseAccess({ account });
      const authorizeRelease = (descriptor, options) => releaseAccess.authorize(descriptor, options);
      const { getCompatibilityContext, prepareApplication } = createApplicationBackend({ client, account, clientVersion: app.getVersion() });
      applications = await createApplicationManager({
        applicationRoot: path.join(userData, "applications"),
        runtimeArgs: process.defaultApp ? [app.getAppPath()] : [],
        applicationId: "wanx-host",
        context: () => client.applicationContext(),
        request: (input) => client.applicationRequest(input),
        stream: (input) => client.applicationStream(input),
        createConnection: (applicationId) => client.applicationConnection(applicationId),
        trustedKeys,
        getCompatibilityContext,
        prepareApplication,
        authorizeRelease,
        launcherArgs: [
          ...(app.isPackaged ? [] : [app.getAppPath()]),
          "--wanx-managed-app",
          `--user-data-dir=${userData}`,
          ...(app.commandLine.hasSwitch("use-mock-keychain") ? ["--use-mock-keychain"] : []),
        ],
      });
      marketSession = createMarketSessionGuard(account);
      const support = createRemoteSupport({ account });
      const market = createApplicationMarket({
        request: (input) => account.request(input),
        applications,
        wanxVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        trustedKeys,
        captureSession: () => marketSession.captureSession(),
        getCompatibilityContext,
        authorizeRelease,
      });
      const deliveryScope = () => {
        const state = client.snapshot();
        const accountId = account.snapshot().phase === "authenticated" ? account.getIdentity()?.accountId : null;
        return accountId && state.phase === "ready" && state.connection?.deviceId
          ? { accountId, deviceId: state.connection.deviceId } : null;
      };
      const defaultApplications = createDefaultApplicationDelivery({
        market, applications, getScope: deliveryScope,
        captureSession: () => marketSession.captureSession(),
        onChanged: () => { void broadcast?.publish(); },
      });
      const deliveryScheduler = createDefaultApplicationScheduler({ delivery: defaultApplications, getScope: deliveryScope });
      const identity = await readClientIdentity({ app });
      const testRuntime = await createTestUpdateRuntime({ identity, app, session });
      let updateTrust = JSON.parse(await readFile(new URL("../updates/trust.json", import.meta.url), "utf8"));
      if (app.isPackaged) {
        try { updateTrust = JSON.parse(await readFile(path.join(process.resourcesPath, "wanx-update-trust.json"), "utf8")); }
        catch (error) { if (error.code !== "ENOENT") updateTrust = { keys: {}, windowsPublisherNames: [] }; }
      }
      if (updateTrust?.schemaVersion !== 1 || !updateTrust.keys || typeof updateTrust.keys !== "object" || Array.isArray(updateTrust.keys))
        updateTrust = { keys: {}, windowsPublisherNames: [] };
      const clientUpdates = await createClientUpdates({
        current: identity, keys: updateTrust.keys, applications,
        request: testRuntime ? input => testRuntime.request(input) : input => account.request(input),
        captureSession: testRuntime ? testRuntime.captureSession : () => marketSession.captureSession(),
        installationId: await installationIdentity(app),
        store: createUpdateStore(path.join(userData, "updates", "client-state.json")),
        createAdapter: () => createElectronUpdateAdapter({ platform: process.platform,
          configurationPath: path.join(userData, "updates", "electron-config.yml"),
          ...(testRuntime ? { cacheDirectoryName: `wanx-client-updater-test-${identity.testRunId}` } : {}),
          installationDirectory: path.dirname(app.getPath("exe")),
          windowsPublisherNames: updateTrust.windowsPublisherNames }),
        requestInstall: finalize => shutdown.requestInstall(finalize).catch(error => {
          dialog.showErrorBox("客户端更新未完成", "安装未完成。请重新启动万象查看更新诊断，必要时使用正式修复安装包；账号和应用数据会保留。");
          throw error;
        }),
      });
      const boxUpdates = await createBoxUpdates({
        request: input => account.request(input), keys: updateTrust.keys,
        captureSession: () => marketSession.captureSession(),
        store: createUpdateStore(path.join(userData, "updates", "box-state.json")),
        getScope: () => ({ accountId: account.snapshot().phase === "authenticated" ? account.getIdentity()?.accountId : null,
          deviceId: client.snapshot().connection?.deviceId || null }),
      });
      updates = { client: clientUpdates, box: boxUpdates };
      const updateListeners = [clientUpdates.subscribe(() => { void broadcast?.publish(); }),
        boxUpdates.subscribe(() => { desktop?.sync(client.snapshot()); void broadcast?.publish(); })];
      let updateAccount = JSON.stringify(account.getIdentity());
      const unsubscribeUpdateAccount = account.subscribe(state => {
        const next = JSON.stringify(account.getIdentity());
        if (state.phase !== "authenticated" || next !== updateAccount) {
          clientUpdates.invalidate(); boxUpdates.invalidate();
        }
        updateAccount = next;
        deliveryScheduler.sync();
      });
      const startup = createStartupSettings({ app, testBuild: Boolean(testBuild) });
      try { startup.initializeDefault(); } catch (error) { reportError(error); }
      uiState = await createUIState({
        client, account, applications,
        preferenceFile: path.join(userData, "ui-preferences.json"),
        serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        onChanged: () => { void broadcast?.publish(); },
        onOpened: ({ applicationId }) => {
          desktop?.hidePanel();
          applications.activate(applicationId);
        },
      });
      control = new BrowserWindow({
        width: 860,
        height: 640,
        minWidth: 760,
        minHeight: 560,
        show: false,
        acceptFirstMouse: true,
        title: windowName,
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
      if (["darwin", "win32"].includes(process.platform)) {
        panel = new BrowserWindow({
          width: 400, height: 320, show: false, frame: false, acceptFirstMouse: true,
          resizable: false, maximizable: false, minimizable: false,
          fullscreenable: false, skipTaskbar: true, hasShadow: true,
          roundedCorners: true, alwaysOnTop: true, backgroundColor: "#faf8f4",
          title: `${windowName} · 我的应用`, icon: APP_ICON,
          webPreferences: {
            preload: fileURLToPath(new URL("../local-ui/panel-preload.cjs", import.meta.url)),
            nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
          },
        });
        if (process.platform === "darwin") panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      }
      for (const window of [control, panel].filter(Boolean)) {
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", event => event.preventDefault());
        window.webContents.on("will-attach-webview", event => event.preventDefault());
      }
      broadcast = createUIBroadcast({
        client, applications, uiState, startup, updates, defaultApplications, windows: () => [control, panel], onError: reportError,
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
        versionInfo: identity,
        checkUpdates: () => clientUpdates.check(),
        onPanelHidden: () => uiState.dismissPanel(),
        openManagement(page) {
          if (control.isDestroyed()) return;
          if (control.isMinimized()) control.restore();
          control.webContents.send("wanx-client:navigate", page);
          control.show();
          control.focus();
        },
      });
      personalSpace = await createPersonalSpace({
        client, serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        store: createSecureAccountStore({ filePath: path.join(userData, "space-transfers.enc"), safeStorage }),
        chooseUploads: async () => {
          const result = await dialog.showOpenDialog(control, { title: "上传到盒子空间", properties: ["openFile", "multiSelections"] });
          return result.canceled ? [] : result.filePaths;
        },
        chooseDownloadDirectory: async () => {
          const result = await dialog.showOpenDialog(control, { title: "选择批量下载保存位置", properties: ["openDirectory", "createDirectory"] });
          return result.canceled ? null : result.filePaths[0];
        },
        chooseDownload: async name => {
          const result = await dialog.showSaveDialog(control, { title: "保存文件", defaultPath: name });
          return result.canceled ? null : result.filePath;
        },
        onChanged: state => {
          if (!control.isDestroyed()) control.webContents.send("wanx-client:space-state", state);
          if (panel && !panel.isDestroyed()) panel.webContents.send("wanx-client:panel-space-state", panelSpaceState(state));
        },
      });
      try {
        spaceLinks = await createSpaceLinkBridge({
          client, serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
          store: createSecureAccountStore({ filePath: path.join(userData, "space-links.enc"), safeStorage }),
          profileDirectory: path.join(userData, "space-agent-profiles"),
          chooseStorageDirectory: async () => {
            const result = await dialog.showOpenDialog(control, {
              title: "选择空间存储文件夹", buttonLabel: "选择此文件夹",
              properties: ["openDirectory", "createDirectory"],
            });
            return result.canceled ? null : result.filePaths[0];
          },
          mcpConfig: { mcpServers: { "wanx-space": {
            command: process.execPath,
            args: [fileURLToPath(new URL("./space-links-mcp.mjs", import.meta.url))],
            env: { ELECTRON_RUN_AS_NODE: "1" },
          } } },
          onChanged: () => {
            if (control && !control.isDestroyed()) control.webContents.send("wanx-client:space-content-changed");
          },
        });
      } catch (error) {
        const code = error.code || "SPACE_LINK_START_FAILED";
        spaceLinks = { manage: async () => { throw new Error(code); }, close: async () => {} };
      }
      registerControlActions({
        spaceLinks,
        personalSpace,
        confirmSpacePurge: async () => (await dialog.showMessageBox(control, {
          type: "warning", message: "彻底删除这个文件或文件夹？", detail: "删除后无法恢复。文件夹中的内容也会一并删除。",
          buttons: ["取消", "彻底删除"], defaultId: 0, cancelId: 0,
        })).response === 1,

        accountProfile: {
          save: input => account.saveProfile(input),
          removeAvatar: () => account.saveProfile({ avatarDataUrl: null }),
          chooseAvatar: () => account.chooseAvatar(async () => {
            const result = await dialog.showOpenDialog(control, {
              title: "上传头像", buttonLabel: "使用头像",
              filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg"] }], properties: ["openFile"],
            });
            return result.canceled || !result.filePaths.length ? null : readAvatar(result.filePaths[0], nativeImage);
          }),
        },
        creditWallet: createCreditWallet({ request: input => account.request(input) }),
        credits: createCreditsReader({ client, authorityDeviceId: process.env.WANX_CREDITS_DEVICE_ID || "",
          accountRequest: creditsServiceURL ? input => account.creditsRequest({ ...input, serviceURL: creditsServiceURL }) : null }),
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
        updates,
        support,
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
        openTerminalConsole();
        boxUpdates.sync();
        deliveryScheduler.sync();
        void broadcast.publish();
      });

      shutdown = registerShutdown({
        app,
        async closeApplications() {
          uiState.invalidateOpen();
          await deliveryScheduler.close();
          await defaultApplications.close();
          marketSession?.close();
          releaseAccess.close();
          await Promise.all([market.close(), personalSpace?.close(), spaceLinks?.close(), applications?.close()]);
        },
        async closeHost() {
          support.close();
          unsubscribeUpdateAccount();
          for (const remove of updateListeners) remove();
          clientUpdates.close(); boxUpdates.close();
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
      let setupStartFailed = false;
      setupRuntime = await createSetupRuntime({
        control, controlURL, ipcMain, account, client, safeStorage, userData,
        advertisementNames: createAdvertisementNames({
          lookupName: (deviceId) => account.lookupDeviceName(deviceId),
          cacheScope: () => account.getIdentity()?.accountId || null,
          helperPath: nativePaths.discovery,
        }),
        consumerBaseUrl: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        onError: reportError,
      }).catch((error) => {
        reportError(error);
        setupStartFailed = true;
        return null;
      });
      await Promise.all([control.loadURL(controlURL), panel?.loadURL(panelURL)]);
      if (setupStartFailed) control.webContents.send("wanx:setup:state", {
        state: "terminalError", errorCode: "SETUP_START_FAILED",
      });
      await clientUpdates.ready();
      if (process.env.WANX_SMOKE_USER_DATA)
        await writeFile(path.join(userData, "smoke-ui-ready.marker"), "ready");
      stopNetworkMonitor = monitorNetworkChanges({
        powerMonitor,
        onChange: () => client.networkChanged(),
        onError: reportError,
      });
      if (!startup.wasOpenedAtLogin()) desktop.show();
      deliveryScheduler.sync();
      void broadcast.publish();
      const initialization = timed("client.initialize", () => client.initialize()).then(openTerminalConsole);
      if (testRuntime) {
        await initialization;
        await testRuntime.ready(clientUpdates);
      } else void initialization.catch(reportError);
    })
    .catch((error) => {
      reportError(error);
      app.exit(1);
    });
