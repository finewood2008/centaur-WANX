import {createLocalEncryption} from "../account/local-encryption.mjs";
import {createTeamDataService} from "./team-data-service.mjs";
let teamDataService;
import { createNotificationCenter } from "./notification-center.mjs";
import {createTeamConnection} from "./team-connection.mjs";
import {createTeamService,registerTeamIPC,guardTeamIPC} from "./team-service.mjs";
import {isControlSender} from "./security.mjs";
import {panelNoteState} from './panel-note.mjs';
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
  safeStorage as osSafeStorage,
  clipboard,
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
import { readFile, writeFile, lstat } from "node:fs/promises";
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
import { createAIDialogue } from "./ai-dialogue.mjs";
import { createStartupSettings } from "./startup.mjs";
import { createSpaceLinkBridge } from "./space-links.mjs";
import {createSuperClipboard} from "./super-clipboard.mjs";
import {createSystemClipboard} from "./system-clipboard.mjs";
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
let notifications;
let broadcast;let studioChanged=0;
let aiDialogue, panelDialogue;
let client;
let unsubscribe;
let setupRuntime;
let applications;
let personalSpace;
let superClipboard;
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
if (process.platform === "win32") app.setAppUserModelId(testBuild ? TEST_APP_ID : "ai.centuarai.wanx.studio.team.local");
if (process.argv.includes("--wanx-managed-app")) {
  marketTrustedKeys().then(trustedKeys => runManagedApplication({
    applicationRoot: process.env.WANX_HOST_APPLICATION_ROOT || path.join(app.getPath("userData"), "applications"), trustedKeys, app,
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
      const safeStorage = process.platform === "darwin" ? createLocalEncryption({directory:userData}) : osSafeStorage;
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
        measure: timed,
        onGrantTiming: details => timings.grantResponse(details),
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
      // Desktop networking follows login; ignore the retired manual-off preference.
      client = createPlatformClient({
        account,
        localBoxes: createLocalBoxes(),
        creditsServiceURL,
        measure: timed,
        resumeStore: createSecureAccountStore({
          filePath: path.join(userData, "network-resume.enc"),
          safeStorage,
        }),
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
              measure: timed,
              onRecovery: value => timings.recovery(value),
              createGateway: (options) =>
                createDashboardGateway({
                  ...options,
                  staticCache: options.businessService ? undefined : staticCache,
                  cacheScope: identity && !options.businessService
                    ? { accountId: identity.accountId, boxId: options.deviceId }
                    : undefined,
                }),
            }),
          };
        },
      });
      client=createTeamConnection({base:client,createTransport:()=>createClient(),store:createSecureAccountStore({filePath:path.join(userData,"team-server.enc"),safeStorage})});
      const trustedKeys = await marketTrustedKeys();
      const releaseAccess = createApplicationReleaseAccess({ account });
      const authorizeRelease = (descriptor, options) => releaseAccess.authorize(descriptor, options);
      const { getCompatibilityContext, prepareApplication } = createApplicationBackend({ client, account, clientVersion: app.getVersion() });
      applications = await createApplicationManager({
        applicationRoot: path.join(userData, "applications"),
        runtimeArgs: [...(process.defaultApp ? [app.getAppPath()] : []), `--user-data-dir=${userData}`],
        applicationId: "wanx-host",
        context: () => client.applicationContext(),
        request: (input) => client.applicationRequest(input),
        stream: (input) => client.applicationStream(input),
        createConnection: (applicationId, options) => applicationId === "centaurai.wanx.semantica" && options?.launchContext?.kind === "team-data" ? teamDataService.connection(options.launchContext) : client.applicationConnection(applicationId),
        trustedKeys,
        getCompatibilityContext,
        prepareApplication,
        authorizeRelease,
        onStudioInstalled:()=>{studioChanged++;return broadcast?.publish()},
        chooseStudioExport:async name=>{const r=await dialog.showSaveDialog(control,{title:"导出当前采用版本",defaultPath:name,filters:[{name:"万象应用安装包",extensions:["zip"]}]});return r.canceled?null:r.filePath},
        returnToStudioClient:async destination=>{control.webContents.send("wanx-client:navigate",destination==="projects"?"studio-projects":destination);control.show();control.focus()},
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
      const updateListeners = [clientUpdates.subscribe(() => { notifications?.update(clientUpdates.snapshot()); void broadcast?.publish(); }),
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
      notifications = await createNotificationCenter({
        client, serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        store: createSecureAccountStore({ filePath: path.join(userData, "notification-center.enc"), safeStorage }),
        onChanged: () => { void broadcast?.publish(); },
      });
      uiState = await createUIState({
        client, account, applications,
        preferenceFile: path.join(userData, "ui-preferences.json"),
        serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        onChanged: () => { void broadcast?.publish(); },
        onOperation: event => notifications.operation(event),
        onOpened: ({ applicationId }) => {
          desktop?.hidePanel();
          applications.activate(applicationId);
        },
      });
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const windowWidth = Math.round(area.width * 0.92);
      const windowHeight = Math.round(area.height * 0.92);
      control = new BrowserWindow({
        x: area.x + Math.round((area.width - windowWidth) / 2),
        y: area.y + Math.round((area.height - windowHeight) / 2),
        width: windowWidth,
        height: windowHeight,
        minWidth: Math.min(760, windowWidth),
        minHeight: Math.min(560, windowHeight),
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
      const teamService=createTeamService({client,applications,assets:path.join(app.getAppPath(),"applications/studio-runtime")});
      const teamTrusted=event=>isControlSender(event,control,controlURL);
      registerTeamIPC({ipcMain,isTrusted:teamTrusted,team:teamService});
      teamDataService=createTeamDataService({client,applications,getMcpDetails:()=>spaceLinks.mcpDetails("starlink"),writeClipboard:text=>clipboard.writeText(text),starlinkPackageDir:path.join(app.getAppPath(),"applications/starlink"),selectFiles:async()=>{const r=await dialog.showOpenDialog(control,{title:"导入团队知识材料",properties:["openFile","multiSelections"],filters:[{name:"知识材料",extensions:["txt","md","markdown","pdf","docx","pptx","xlsx","xls","xlsm","png","jpg","jpeg","webp","wav","mp3","m4a","flac"]}]});return r.canceled?[]:r.filePaths}});
      ipcMain.handle("wanx-client:mcp",async(event,{action,input={}}={})=>{
        if(!teamTrusted(event))return {ok:false,code:"TEAM_ORIGIN_DENIED"};
        try{
          const details=await spaceLinks.mcpDetails();
          if(action==="details")return {ok:true,value:details};
          if(action!=="copy")throw Error("MCP_ACTION_DENIED");
          let text=input.kind==="url"?details.url:input.kind==="config"?JSON.stringify(details.configuration,null,2):null;

          if(!text)throw Error("MCP_ACTION_DENIED");clipboard.writeText(text);return {ok:true,value:{copied:true}};
        }catch(error){return {ok:false,code:error.code||"MCP_UNAVAILABLE"}}
      });
      ipcMain.handle("wanx-client:data",async(event,{action,input}={})=>{if(!teamTrusted(event))return {ok:false,code:"TEAM_ORIGIN_DENIED"};try{return {ok:true,value:await teamDataService.action(action,input)}}catch(error){return {ok:false,code:error.code||"TEAM_DATA_REQUEST_FAILED"}}});
      broadcast = createUIBroadcast({
        client, applications, uiState, startup, updates, defaultApplications, notifications, studioRevision:()=>studioChanged, windows: () => [control, panel], onError: reportError,
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
        driveCatalog: () => { if(!spaceLinks)throw Object.assign(new Error("BOX_CONNECTION_REQUIRED"),{code:"BOX_CONNECTION_REQUIRED"});return spaceLinks.manage("mcp-drives"); },
        onEvent: event => timings.transfer(event),
        client, serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        store: createSecureAccountStore({ filePath: path.join(userData, "space-transfers.enc"), safeStorage }),
        chooseUploads: async ({ folders = false } = {}) => {
          const result = await dialog.showOpenDialog(control, { title: "上传到盒子空间", message: "支持文件和文件夹，自动分批上传并保留目录结构；单文件最大 200 MB，问题文件单独提示。", properties: [folders ? "openDirectory" : "openFile", "multiSelections"] });
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
      const clipboardDirectory = path.join(userData, "super-clipboard");
      try {
      superClipboard = await createSuperClipboard({
        client, personalSpace, serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        store: createSecureAccountStore({filePath:path.join(userData,"super-clipboard.enc"),safeStorage}),
        directory: clipboardDirectory, deviceName: os.hostname(),
        systemClipboard: createSystemClipboard({clipboard,nativeImage,app,directory:path.join(clipboardDirectory,"native")}),
        chooseFiles: async (input={}) => { const result=await dialog.showOpenDialog(input.panel&&panel&&!panel.isDestroyed()?panel:control,{title:"插入图片到便签",message:"每次最多20张图片，单张最大20 MB",filters:[{name:"图片",extensions:["png","jpg","jpeg","gif","webp"]}],properties:["openFile","multiSelections"]});return result.canceled?[]:result.filePaths; },
        chooseDownload: async name => {const result=await dialog.showSaveDialog(control,{title:"下载便签内容",defaultPath:name});return result.canceled?null:result.filePath;},
        onChanged: state => {if(!control.isDestroyed())control.webContents.send("wanx-client:clipboard-state",state);if(panel&&!panel.isDestroyed())panel.webContents.send("wanx-client:panel-note-state",panelNoteState(state));},
      });
      } catch (error) {
        const code = error.code || "CLIPBOARD_CACHE_DAMAGED";
        superClipboard = {snapshot:()=>({scope:null,items:[],tasks:[],error:code}),operation:async method=>{if(method==="snapshot")return {scope:null,items:[],tasks:[],error:code};throw Object.assign(new Error(code),{code});},close:async()=>{}};
      }
      try {
        spaceLinks = await createSpaceLinkBridge({
          client, serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
          store: createSecureAccountStore({ filePath: path.join(userData, "space-links.enc"), safeStorage }),
          agentHubOptions: {team: true},
          copyText: text => clipboard.writeText(text),
          chooseStorageDirectory: async () => {
            const result = await dialog.showOpenDialog(control, {
              title: "选择空间存储文件夹", buttonLabel: "选择此文件夹",
              properties: ["openDirectory", "createDirectory"],
            });
            return result.canceled ? null : result.filePaths[0];
          },
          onChanged: () => {
            if (control && !control.isDestroyed()) control.webContents.send("wanx-client:space-content-changed");
          },
        });
      } catch (error) {
        const code = error.code || "SPACE_LINK_START_FAILED";
        spaceLinks = { manage: async () => { throw new Error(code); }, close: async () => {} };
      }
      const assistantUploads = new Map();
      aiDialogue = createAIDialogue({ client, sharedUploads: assistantUploads,
        selectFiles: async () => {
          const result = await dialog.showOpenDialog(control, { title: "添加助理附件", properties: ["openFile", "multiSelections"] });
          return result.canceled ? [] : result.filePaths;
        },
        saveFile: async name => {
          const result = await dialog.showSaveDialog(control, { title: "保存助理产物", defaultPath: name });
          return result.canceled ? null : result.filePath;
        },
        preferenceStore: createSecureAccountStore({ filePath: path.join(userData, "ai-dialogue-models.enc"), safeStorage }), onEvent: event => {
        if (!control.isDestroyed()) control.webContents.send("wanx-client:ai-dialogue", event);
      } });
      panelDialogue = createAIDialogue({ client, sharedUploads: assistantUploads,
        selectFiles: async () => {
          const result = await dialog.showOpenDialog(panel || control, { title: "添加助理附件", properties: ["openFile", "multiSelections"] });
          return result.canceled ? [] : result.filePaths;
        },
        saveFile: async name => {
          const result = await dialog.showSaveDialog(panel || control, { title: "保存助理产物", defaultPath: name });
          return result.canceled ? null : result.filePath;
        },
        preferenceStore: createSecureAccountStore({ filePath: path.join(userData, "ai-dialogue-models.enc"), safeStorage }), onEvent: event => {
        if (panel && !panel.isDestroyed()) panel.webContents.send("wanx-client:panel-ai-dialogue", event);
      } });
      registerControlActions({
        aiDialogue, panelDialogue,
        timings,
        spaceLinks,
        personalSpace,
        superClipboard,
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
        ipcMain:guardTeamIPC({ipcMain,client,team:teamService,isTrusted:teamTrusted}),
        control,
        controlURL,
        panel,
        panelURL,
        uiState,
        notifications,
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
          aiDialogue?.close();
          panelDialogue?.close();
          await deliveryScheduler.close();
          await defaultApplications.close();
          marketSession?.close();
          releaseAccess.close();
          await superClipboard?.close();
          await Promise.all([market.close(), personalSpace?.close(), spaceLinks?.close(), applications?.close()]);
        },
        async closeHost() {
          await notifications?.close();
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
        onDiagnostic: event => timings.provisioning(event),
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
      if (!startup.wasOpenedAtLogin()) desktop.showManagement("applications");
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
