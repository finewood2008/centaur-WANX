import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkHealth,
  HEALTH_KINDS,
  isLoopbackHostname,
  normalizeBaseURL,
  openDashboard,
  createClientController,
} from "./index.mjs";
import { createRealAdapters } from "./shell/real-adapters.mjs";

const require = createRequire(import.meta.url);
const { createConsumerClient } = require("./shell/consumer-client.cjs");
const { createSecureStore } = require("./shell/secure-store.cjs");
const { createClaimResumeStore } = require("./shell/claim-resume-store.cjs");
const { createProvisioningHost } = require("./shell/provisioning-host.cjs");
const { configSummary, createObservability } = require("./shell/observability.cjs");

const root = fileURLToPath(new URL(".", import.meta.url));
let mainWindow;
let dashboardWindow;
let dashboardOrigin;
let clientController;
let consumer;
let setupHost;
let disposeDiscovery;
let quitting = false;
let shutdownPromise;
const observability = createObservability({
  onEvent: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("wanx-client:observability", event);
  },
});
let state = {
  phase: "idle",
  baseURL: null,
  health: null,
  verified: false,
  message: null,
  config: null,
  initialization: { phase: "idle", stage: null, completedStages: [], error: null },
};

function snapshot() {
  return structuredClone(state);
}

function clientSnapshot() {
  return {
    ...(clientController?.snapshot() ?? {
      route: "auth",
      phase: "signed_out",
      account: null,
      devices: [],
      availableDevices: [],
      selectedDeviceId: null,
      activeDeviceId: null,
      provisioning: { phase: "idle", stage: null, error: null },
      error: null,
      mode: "integrated",
    }),
    diagnostics: snapshot(),
  };
}

function publish(patch) {
  state = { ...state, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("wanx-client:state", clientSnapshot());
  }
  return snapshot();
}

function publishClientState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("wanx-client:state", clientSnapshot());
  }
  return clientSnapshot();
}

function requestFromMainWindow(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    const error = new Error("UNTRUSTED_RENDERER");
    error.code = "UNTRUSTED_RENDERER";
    throw error;
  }
  return mainWindow;
}

function ipcResult(value) {
  return { ok: true, value, state: clientSnapshot() };
}

function ipcError(error) {
  return {
    ok: false,
    code: error?.code || error?.message || "CLIENT_REQUEST_FAILED",
    state: clientSnapshot(),
  };
}

function provisioningInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Object.assign(new Error("INVALID_REQUEST"), { code: "INVALID_REQUEST" });
  const allowed = ["deviceId", "ssid", "security", "password", "hidden", "claimCode", "candidate"];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw Object.assign(new Error("INVALID_REQUEST"), { code: "INVALID_REQUEST" });
  if (input.deviceId !== undefined && (typeof input.deviceId !== "string" || input.deviceId.length > 128))
    throw Object.assign(new Error("INVALID_REQUEST"), { code: "INVALID_REQUEST" });
  if (input.ssid !== undefined && (typeof input.ssid !== "string" || new TextEncoder().encode(input.ssid).length > 32))
    throw Object.assign(new Error("INVALID_REQUEST"), { code: "INVALID_REQUEST" });
  if (input.password !== undefined && (typeof input.password !== "string" || input.password.length > 128))
    throw Object.assign(new Error("INVALID_REQUEST"), { code: "INVALID_REQUEST" });
  if (input.security !== undefined && !["open", "wpa_personal"].includes(input.security))
    throw Object.assign(new Error("INVALID_REQUEST"), { code: "INVALID_REQUEST" });
  if (input.hidden !== undefined && typeof input.hidden !== "boolean")
    throw Object.assign(new Error("INVALID_REQUEST"), { code: "INVALID_REQUEST" });
  if (input.claimCode !== undefined && (typeof input.claimCode !== "string" || !/^(?:[A-Z2-7]{10}|[A-Z2-7]{20})$/u.test(input.claimCode)))
    throw Object.assign(new Error("INVALID_REQUEST"), { code: "INVALID_REQUEST" });
  if (input.candidate !== undefined) {
    const candidate = input.candidate;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || Object.keys(candidate).length !== 8 ||
        candidate.transport !== "ble-gatt" || typeof candidate.candidateId !== "string" ||
        typeof candidate.transportHandle !== "string" || typeof candidate.selectionLeaseId !== "string" ||
        typeof candidate.advertisedName !== "string" || candidate.advertisedName.length > 64 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(candidate.advertisedName) ||
        (candidate.rssi !== null && (typeof candidate.rssi !== "number" || !Number.isFinite(candidate.rssi) || candidate.rssi > 0)) ||
        typeof candidate.firstSeenMonotonicMs !== "number" || !Number.isFinite(candidate.firstSeenMonotonicMs) || candidate.firstSeenMonotonicMs < 0 ||
        typeof candidate.lastSeenMonotonicMs !== "number" || !Number.isFinite(candidate.lastSeenMonotonicMs) ||
        candidate.lastSeenMonotonicMs < candidate.firstSeenMonotonicMs)
      throw Object.assign(new Error("INVALID_REQUEST"), { code: "INVALID_REQUEST" });
  }
  return structuredClone(input);
}

function createDashboardWindow(url) {
  const origin = new URL(url).origin;
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    if (dashboardOrigin === origin) {
      return dashboardWindow.loadURL(url).then(
        () => {
          dashboardWindow.focus();
          return dashboardWindow;
        },
        (error) => {
          if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.destroy();
          dashboardWindow = undefined;
          dashboardOrigin = undefined;
          throw error;
        },
      );
    }
    dashboardWindow.destroy();
    dashboardWindow = undefined;
    dashboardOrigin = undefined;
  }
  dashboardWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: "万象盒端 Dashboard",
    backgroundColor: "#f7f4ee",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  dashboardOrigin = origin;
  const isAllowedNavigation = (target) => {
    try {
      return new URL(target).origin === origin;
    } catch {
      return false;
    }
  };
  dashboardWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const guardNavigation = (event, target) => {
    if (!isAllowedNavigation(target)) event.preventDefault();
  };
  dashboardWindow.webContents.on("will-navigate", guardNavigation);
  dashboardWindow.webContents.on("will-redirect", guardNavigation);
  dashboardWindow.on("closed", () => {
    dashboardWindow = undefined;
    dashboardOrigin = undefined;
  });
  return dashboardWindow.loadURL(url).then(
    () => dashboardWindow,
    (error) => {
      if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.destroy();
      dashboardWindow = undefined;
      dashboardOrigin = undefined;
      throw error;
    },
  );
}

function registerIpc() {
  ipcMain.handle("wanx-client:state", (event) => {
    requestFromMainWindow(event);
    return ipcResult(null);
  });

  const actions = {
    "auth.login": (input) => clientController.login(input),
    "auth.register": (input) => clientController.register(input),
    "auth.send-code": (input) => adapters.account.sendRegistrationCode(input),
    "auth.logout": () => clientController.logout(),
    "devices.refresh": () => clientController.refreshDevices(),
    "devices.select": (input) => clientController.selectDevice(input.deviceId),
    "devices.connect": (input) => clientController.connectDevice(input?.deviceId),
    "devices.disconnect": () => clientController.disconnect(),
    "provisioning.start": (input) => clientController.startProvisioning(provisioningInput(input)),
    "provisioning.confirm": () => adapters.provisioning.confirmPhysical(),
    "provisioning.wifi": (input) => adapters.provisioning.wifi(provisioningInput(input)),
    "provisioning.owner": () => adapters.provisioning.confirmOwnership(),
    "provisioning.cancel": () => clientController.cancelProvisioning(),
  };

  ipcMain.handle("wanx-client:action", async (event, { action, input = {} } = {}) => {
    requestFromMainWindow(event);
    const handler = actions[action];
    if (!handler) return ipcError(Object.assign(new Error("UNKNOWN_CLIENT_ACTION"), { code: "UNKNOWN_CLIENT_ACTION" }));
    try {
      return ipcResult(await handler(input));
    } catch (error) {
      return ipcError(error);
    }
  });

  ipcMain.handle("wanx-client:health", async (event, input = {}) => {
    requestFromMainWindow(event);
    try {
      const baseURL = normalizeBaseURL(input.baseURL);
      publish({ phase: "checking", baseURL, health: null, verified: false, message: null });
      const result = await checkHealth(baseURL, { timeoutMs: 8_000 });
      const verified = result.kind === HEALTH_KINDS.READY && isLoopbackHostname(new URL(baseURL).hostname);
      publish({
        phase: result.kind === HEALTH_KINDS.READY ? "ready" : "unreachable",
        baseURL,
        health: result,
        verified,
        message: verified
          ? "本机诊断地址已就绪"
          : result.kind === HEALTH_KINDS.READY
            ? "服务已就绪；远程盒子仍需平台设备身份验证"
            : null,
      });
      publishClientState();
      return ipcResult(result);
    } catch (error) {
      publish({ phase: "error", health: null, verified: false, message: error.message });
      return ipcError(error);
    }
  });

  ipcMain.handle("wanx-client:dashboard", async (event) => {
    requestFromMainWindow(event);
    try {
      if (!state.baseURL || !state.verified) {
        const error = new Error("IDENTITY_VERIFICATION_REQUIRED");
        error.code = "IDENTITY_VERIFICATION_REQUIRED";
        throw error;
      }
      const result = openDashboard({
        target: { baseURL: state.baseURL, verified: state.verified },
        window: { open: (url) => createDashboardWindow(url) },
      });
      await result.handle;
      return ipcResult({ url: result.url });
    } catch (error) {
      return ipcError(error);
    }
  });
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: "万象电脑端",
    backgroundColor: "#f7f4ee",
    webPreferences: {
      preload: join(root, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const localRenderer = pathToFileURL(join(root, "renderer/index.html")).href;
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== localRenderer) event.preventDefault();
  });
  await mainWindow.loadFile(join(root, "renderer", "index.html"));
  mainWindow.on("close", (event) => {
    if (process.platform === "darwin" && !quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

let adapters;

async function initializeRuntime() {
  const configuredAdminApiBaseUrl = process.env.WANX_ADMIN_API_BASE_URL;
  const configuredConsumerBaseUrl = process.env.WANX_CONSUMER_API_BASE_URL;
  const consumerBaseUrl = configuredAdminApiBaseUrl || configuredConsumerBaseUrl || "https://boss.nexusaos.qitus.cn/prod-api";
  const config = configSummary({
    consumerBaseUrl,
    source: configuredAdminApiBaseUrl
      ? "env:WANX_ADMIN_API_BASE_URL"
      : configuredConsumerBaseUrl
        ? "env:WANX_CONSUMER_API_BASE_URL"
        : "default",
  });
  publish({ config, initialization: { phase: "starting", stage: "config", completedStages: [], error: null } });
  observability.emit("info", "wanx.client.config.selected", config);
  const completedStages = [];
  const stage = async (name, action) => {
    publish({ initialization: { phase: "starting", stage: name, completedStages: [...completedStages], error: null } });
    const span = observability.start(name);
    try {
      const result = await action();
      completedStages.push(name);
      span.end();
      publish({ initialization: { phase: "starting", stage: name, completedStages: [...completedStages], error: null } });
      return result;
    } catch (error) {
      span.fail(error);
      publish({ initialization: { phase: "failed", stage: name, completedStages: [...completedStages], error: {
        code: error?.code || error?.name || "UNKNOWN",
        message: error?.message || String(error),
      } } });
      throw error;
    }
  };
  const store = createSecureStore({
    directory: join(app.getPath("userData"), "consumer"),
    safeStorage,
    consumerBaseUrl,
  });
  consumer = await stage("consumer", () => createConsumerClient({
    config: { consumerBaseUrl, source: config.source },
    store,
    observability,
  }));
  await stage("main-window", () => createMainWindow());
  const documentUrl = pathToFileURL(join(root, "renderer", "index.html")).href;
  setupHost = await stage("provisioning-host", () => createProvisioningHost({
    webContents: mainWindow.webContents,
    ipcMain,
    documentUrl,
    consumer,
    resumeStore: createClaimResumeStore({
      directory: join(app.getPath("userData"), "consumer"),
      safeStorage,
      consumerBaseUrl,
    }),
    ...require("./shell/provisioning-trust.json"),
  }));
  mainWindow.webContents.send("wanx:setup:ready");
  const { installElectronBluetoothPicker } = await import("@nexusaos/device-discovery-electron/main");
  disposeDiscovery = await stage("bluetooth-discovery", () => installElectronBluetoothPicker({
    scanTimeoutMs: 12000,
    webContents: mainWindow.webContents,
    documentUrl,
    clock: { monotonicMs: () => performance.now() },
    ipcMain,
  }));
  adapters = await stage("adapters", () => createRealAdapters({
    consumer,
    setup: setupHost,
    platform: process.platform,
    onSetupState: (snapshot) => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send("wanx:setup:state", snapshot);
    },
  }));
  clientController = await stage("controller", () => createClientController({
    ...adapters,
    emit: publishClientState,
  }));
  publish({ initialization: { phase: "ready", stage: null, completedStages, error: null } });
  observability.emit("info", "wanx.client.init.ready", { completedStages });
  publishClientState();
}

async function reportStartupError(error) {
  observability.emit("error", "wanx.client.start.failed", {
    errorCode: error?.code || error?.name || "UNKNOWN",
    errorMessage: error?.message || String(error),
  });
  if (app.isReady()) dialog.showErrorBox("万象电脑端启动失败", error?.message || "未知错误");
  app.exit(1);
}

app.whenReady().then(async () => {
  registerIpc();
  await initializeRuntime();
  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow().catch(reportStartupError);
    }
  });
}).catch(reportStartupError);

async function shutdownRuntime() {
  await Promise.resolve(adapters?.provisioning?.dispose?.()).catch(() => {});
  await Promise.resolve(setupHost?.dispose?.()).catch(() => {});
  try {
    disposeDiscovery?.();
  } catch {}
  await Promise.resolve(consumer?.dispose?.()).catch(() => {});
  adapters = undefined;
  setupHost = undefined;
  disposeDiscovery = undefined;
  consumer = undefined;
  clientController = undefined;
}

app.on("before-quit", (event) => {
  if (quitting || shutdownPromise) return;
  quitting = true;
  event.preventDefault();
  shutdownPromise = shutdownRuntime().finally(() => {
    shutdownPromise = undefined;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
