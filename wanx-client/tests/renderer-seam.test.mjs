import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUIState } from "../shell/ui-state.mjs";
const cleanup = [];
after(async () => { for (const dispose of cleanup) await dispose(); });
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { installElectronBluetoothPicker } from "@nexusaos/device-discovery-electron/main";
import { registerControlActions } from "../shell/control.mjs";
import { BOX_SESSION_ERROR_CODES } from "../octop/platform.mjs";

const indexURL = new URL("../local-ui/renderer/index.html", import.meta.url);
const html = await readFile(indexURL, "utf8");
const rendererScripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(match => match[1]).filter(src => src !== "./device-setup.bundle.js");
const source = (await Promise.all(rendererScripts.map(src => readFile(new URL(src, indexURL), "utf8")))).join("\n");
const preload = await readFile(new URL("../local-ui/remote-preload.cjs", import.meta.url), "utf8");
const transportBundle = await readFile(new URL("../local-ui/renderer/device-setup.bundle.js", import.meta.url), "utf8");
const application = { applicationId: "centaurai.wanx.zhijun", name: "知君", version: "0.4.3", description: "你的私人空间" };
const devices = ["102", "103"].map((id) => ({
  deviceId: `box-${id}`, displayName: `CentuarAI-AMD-${id}`, accessState: "ready", canOpen: true,
}));

function state(platformPhase = "ready", networkPhase = "ready", boxId = null) {
  return {
    account: { phase: "authenticated", accountId: "account-1" },
    phase: boxId ? "ready" : "disconnected",
    platform: { phase: platformPhase },
    network: { enabled: true, phase: networkPhase },
    devices,
    connection: boxId ? { mode: "netbird", deviceId: boxId, gatewayURL: "http://127.0.0.1:41000/__wanx_session/test" } : null,
  };
}

// Execute the real renderer -> preload -> control IPC seam without Electron or a live box.
async function harness(initial = state(), installed = [application], options = {}) {
  const discoveryTest = options.after ? options : undefined;
  let rawState = initial;
  let records = [...installed];
  let launchError;
  const events = new Map(), handlers = new Map(), listeners = new Map();
  const calls = [], launches = [], dashboards = [];
  const accountListeners = new Set(), clientListeners = new Set();
  let uiState;
  const snapshot = () => ({ ...rawState, applications: records, ui: uiState?.snapshot(), desktopStartup: { supported: false, enabled: false } });
  const publish = () => listeners.get("wanx-client:state")?.({}, snapshot());
  const notify = () => { for (const fn of accountListeners) fn(); for (const fn of clientListeners) fn(); };
  let markup = "", renderCount = 0;
  // Model browser form-node replacement so snapshots can exercise preservation
  // without adding a DOM library to the desktop client's runtime dependencies.
  let forms = new Map();
  const app = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value; renderCount++;
      forms = new Map([...value.matchAll(/<form\b[^>]*data-form="([^"]+)"[^>]*>/g)].map(([, name]) => {
        const submit = { disabled: false, textContent: "" };
        const transferPhone = { focus: () => calls.push(["focus-transfer-phone"]) };
        const wifiNodes = new Map();
        const passwordNotice = {};
        const authNotice = {};
        const form = { dataset: { mode: value.match(/data-mode="([^"]+)"/)?.[1] }, values: {}, contains: () => false,
          querySelector: (selector) => name === "auth" && selector === '[data-auth-notice]' ? authNotice : name === "password-change" && selector === '[data-password-notice]' ? passwordNotice : name === "wifi" ? wifiNodes.get(selector) : name === "transfer" && selector === '[name="targetPhone"]' ? transferPhone : submit,
          scrollIntoView: (options) => calls.push(["scroll-form", name, options.block]),
          replaceWith: (retained) => forms.set(name, retained),
        };
        if (name === "wifi") {
          wifiNodes.set('button[type="submit"]', submit);
          for (const fieldName of ["ssid", "password", "security", "hidden"]) {
            const label = { hidden: false };
            wifiNodes.set(`[name="${fieldName}"]`, {
              get value() { return form.values[fieldName] ?? (fieldName === "security" ? "wpa_personal" : ""); },
              set value(value) { form.values[fieldName] = value; },
              set checked(value) { if (value) form.values[fieldName] = "on"; else delete form.values[fieldName]; },
              closest: () => label,
            });
          }
          for (const selector of ['[data-input="wifi-network"]', '[data-wifi-status]', '[data-action="wifi-refresh"]', '[data-wifi-list]', '[data-action="wifi-manual"]']) wifiNodes.set(selector, {});
          form.reset = () => { form.values = {}; };
        }
        return [name, form];
      }));
    },
    querySelector: (selector) => forms.get(selector.match(/data-form="([^"]+)"/)?.[1]),
    addEventListener: (name, fn) => events.set(name, fn),
  };
  const controlURL = "file:///client/local-ui/renderer/index.html";
  const frame = { url: controlURL }, contents = Object.assign(new EventEmitter(), { mainFrame: frame });
  const ipcMain = new EventEmitter();
  const ipcEvent = { sender: contents, senderFrame: frame };
  contents.send = (name, payload) => listeners.get(name)?.({}, payload);
  const client = {
    snapshot: () => structuredClone(rawState),
    subscribe: (fn) => { clientListeners.add(fn); return () => clientListeners.delete(fn); },
    loginPassword: async () => { await options.loginRequest?.(); if (options.loginFailure) throw new Error(options.loginFailure); rawState = state("enrolling", "checking"); notify(); },
    sendResetCode: async () => { await options.passwordCodeRequest?.(); },
    resetPassword: async () => { await options.passwordRequest?.(); return { passwordReset: true }; },
    sendChangeCode: async () => { await options.passwordCodeRequest?.(); },
    changePassword: async () => {
      await options.passwordRequest?.();
      rawState = { account: { phase: "signed_out", reason: "password_reset" } }; notify(); publish();
      return { passwordReset: true };
    },
    logout: async () => { rawState = { account: { phase: "signed_out", logoutPending: true } }; notify(); await options.logoutRequest?.(); },
    connectBox: async (deviceId) => { if (options.connectFailure) throw new Error(options.connectFailure); rawState = state("ready", "ready", deviceId); notify(); },
    disconnect: async () => { rawState = state(); notify(); },
    refreshDevices: async () => {},
    lookupDeviceDiscovery: async (deviceIds) => {
      calls.push(["lookup-device-discovery", [...deviceIds]]);
      return options.lookupDeviceDiscovery ? options.lookupDeviceDiscovery(deviceIds) : {
        devices: deviceIds.map(deviceId => ({ deviceId, deviceName: null, claimStatus: "unknown" })),
      };
    },
    listOwnershipTransfers: async () => options.transfers ? options.transfers() : [],
    sendTransferCode: async () => ({ expiresIn: 300 }),
    createOwnershipTransfer: async input => { calls.push(["ownership-created", input]); return { ...input, state: "pending_target" }; },
    acceptOwnershipTransfer: async input => { calls.push(["ownership-accepted", input]); if (options.acceptFailure) throw new Error(options.acceptFailure); return { ...input, state: "completed" }; },
    setNetworkEnabled: async (enabled) => {
      rawState = { ...state(enabled ? "enrolling" : "idle", enabled ? "checking" : "disabled"), network: { enabled, phase: enabled ? "checking" : "disabled" } };
    },
  };
  const applications = {
      listInstalled: async () => records,
      selectCurrent: async (id, version) => {
        calls.push(["selected-current", id, version]);
        records = [{ ...application, version }];
      },
      launch: async (id, version) => { launches.push([id, version]); if (launchError) throw new Error(launchError); return { state: "running" }; },
    };
  const preferenceDir = await mkdtemp(path.join(os.tmpdir(), "wanx-ui-seam-"));
  uiState = await createUIState({ client, applications,
    account: { snapshot: () => rawState.account, subscribe: (fn) => { accountListeners.add(fn); return () => accountListeners.delete(fn); } },
    serviceURL: "https://example.test", preferenceFile: path.join(preferenceDir, "preferences.json"), onChanged: publish,
  });
  cleanup.push(async () => { await uiState.dispose(); await rm(preferenceDir, { recursive: true, force: true }); });
  registerControlActions({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    control: { webContents: contents, isDestroyed: () => false }, controlURL, client,
    dashboards: { open: async (snapshot) => { dashboards.push(snapshot.connection); } },
    market: {
      list: async () => options.list ? options.list() : { items: [application] },
      candidate: async (id) => options.candidate ? options.candidate(id) : {
        status: records.some((item) => item.applicationId === id) ? "up_to_date" : "available",
        release: { version: application.version },
      },
      install: async () => { const result = options.install ? await options.install() : application; records = [...records.filter((item) => item.applicationId !== result.applicationId), result]; return result; },
      uninstall: async () => { records = []; },
      rollback: async () => { records = [{ ...application, version: "0.4.2" }]; },
    },
    credits: options.credits, accountProfile: options.accountProfile,
    applications, uiState, getState: snapshot, publishState: publish,
  });
  let bluetoothStatus = { status: options.bluetoothStatus || "available" }, bluetoothListener;
  const window = { wanxBluetooth: {
    snapshot: () => bluetoothStatus,
    subscribe(fn) { bluetoothListener = fn; fn(bluetoothStatus); return () => {}; },
    refresh: async () => bluetoothStatus,
  } };
  vm.runInNewContext(preload, { process: { platform: options.platform || "darwin" }, require: () => ({
    contextBridge: { exposeInMainWorld: (name, api) => { window[name] = api; } },
    ipcRenderer: {
      invoke: async (name, input) => {
        calls.push([name, input]);
        if (name === "wanx:discovery:bluetooth-state") return { status: options.bluetoothStatus || "available" };
        if (name === "wanx:discovery:open-bluetooth-settings") return { ok: true };
        if (name.startsWith("wanx:setup:")) return { ok: true, value: await options.setupRequest?.(name) ?? { state: name === "wanx:setup:begin" ? "previewReady" : "idle" } };
        return handlers.get(name)({ sender: contents, senderFrame: frame }, input);
      },
      on: (name, listener) => listeners.set(name, listener), removeListener() {},
      send(name, payload) { calls.push([name, payload]); ipcMain.emit(name, ipcEvent, payload); },
    },
  }) });
  window.wanxSetup = { ...window.wanxSetup, scanWifi: async () => { calls.push(["scan-wifi"]); return options.scanWifi ? options.scanWifi() : []; } };
  let advertisementListener;
  let chooser, nearby = [{ deviceId: "provider-1", deviceName: "Test box" }];
  if (discoveryTest) {
    const clock = { monotonicMs: () => Date.now() };
    discoveryTest.after(installElectronBluetoothPicker({ webContents: contents, ipcMain, documentUrl: controlURL, clock,
      scanTimeoutMs: options.platform === "win32" ? 60000 : 12000,
      advertisementNames: { subscribe: (listener) => { advertisementListener = listener; return () => { advertisementListener = undefined; }; } } }));
    const bluetooth = {
      getAvailability: async () => options.bluetoothStatus !== "unavailable",
      requestDevice: () => new Promise((resolve, reject) => {
        chooser = (id) => id ? resolve({ id, name: "Test box" }) : reject(Object.assign(new Error("User cancelled the requestDevice() chooser."), { name: "NotFoundError" }));
        queueMicrotask(() => contents.emit("select-bluetooth-device", { preventDefault() {} }, nearby, chooser));
      }),
    };
    // Run the shipped transport too, including its independent 12-second deadline.
    vm.runInNewContext(transportBundle, {
      window, navigator: { bluetooth }, crypto: globalThis.crypto,
      performance: { now: clock.monotonicMs }, setTimeout, clearTimeout,
      AbortController, DOMException, TextEncoder, TextDecoder,
    });
    discoveryTest.after(() => window.wanxDeviceSetupTransport.dispose());
  }
  vm.runInNewContext(source, {
    window,
    Date,
    setTimeout, clearTimeout, TextEncoder,
    document: { querySelector: (selector) => selector === "#app" ? app : selector === "#account-name" ? { value: forms.get("auth")?.values.username || "" } : null },
    FormData: class { constructor(form) { return Object.entries(form.values || {}); } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  if (discoveryTest || options.setupRequest) {
    listeners.get("wanx:setup:ready")();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    bluetooth(status) { bluetoothStatus = { status }; bluetoothListener?.(bluetoothStatus); },
    app, calls, launches, dashboards, form: (name) => forms.get(name), get renderCount() { return renderCount; },
    nearby(value) { nearby = value; },
    chooser() { return chooser; },
    advertisement(value) { advertisementListener?.(value); },
    failLaunch(code) { launchError = code; },
    navigate(page) { listeners.get("wanx-client:navigate")({}, page); },
    window,
    update(next, publish = true) {
      rawState = next;
      notify();
      if (publish) listeners.get("wanx-client:state")({}, snapshot());
    },
    click(action, data = {}) {
      return events.get("click")({ target: { closest: () => ({ dataset: { action, ...data } }) } });
    },
    keydown(key) { return events.get("keydown")({ key, preventDefault() {} }); },
    setup(snapshot) { listeners.get("wanx:setup:state")({}, snapshot); },
    changeWifi(value) { return events.get("change")({ target: { dataset: { input: "wifi-network" }, value } }); },
    changeSecurity(value) { const form = forms.get("wifi"); form.values.security = value; return events.get("change")({ target: { dataset: {}, name: "security", value } }); },
    changePendingDevice(value) { return events.get("change")({ target: { dataset: { input: "pending-device" }, value } }); },
    submit(form, values) { return events.get("submit")({ preventDefault() {}, target: { dataset: { form }, values } }); },
  };
}

test("login opens the store while the network prepares, with registration available and no account identifier", async () => {
  const h = await harness({ account: { phase: "signed_out" } });
  assert.match(h.app.innerHTML, /登录万象平台/);
  assert.match(h.app.innerHTML, /data-action="auth-register"/);
  assert.doesNotMatch(h.app.innerHTML, /name="code"/);
  await h.submit("auth", { username: "13800000000", password: "example-password" });
  assert.match(h.app.innerHTML, /我的应用/);
  assert.match(h.app.innerHTML, /网络连接中/);
  assert.match(h.app.innerHTML, /data-action="applications-launch"/);
  assert.doesNotMatch(h.app.innerHTML, /account-1/);
});

for (const [code, message] of [["APPLICATION_START_FAILED", "应用启动失败"], ["APPLICATION_START_TIMEOUT", "应用启动超时"]]) {
  test(`store surfaces ${code} and allows retry without disconnecting the box`, async () => {
    const h = await harness(state("ready", "ready", "box-102"));
    h.failLaunch(code);
    await h.click("applications-launch", { applicationId: application.applicationId });
    assert.ok(h.app.innerHTML.includes(message));
    assert.doesNotMatch(h.app.innerHTML, new RegExp(code));
    assert.match(h.app.innerHTML, /已连接 CentuarAI-AMD-102/);
    assert.match(h.app.innerHTML, /data-action="applications-launch"[^>]*>打开/);
    assert.doesNotMatch(h.app.innerHTML, /data-action="applications-launch"[^>]*disabled/);
  });
}

test("opening an app while disconnected asks which box to use and continues only after confirmation", async () => {
  const h = await harness();
  await h.click("applications-launch", { applicationId: application.applicationId });
  assert.match(h.app.innerHTML, /连接盒子并打开应用/);
  assert.equal(h.launches.length, 0);
  h.changePendingDevice("box-103");
  await h.click("pending-confirm");
  assert.match(h.app.innerHTML, /已连接 CentuarAI-AMD-103/);
  assert.deepEqual(h.launches, [[application.applicationId, undefined]]);
  assert.doesNotMatch(h.app.innerHTML, /data-action="pending-confirm"/);
});

test("pending app launch may be cancelled without connecting a box", async () => {
  const h = await harness();
  await h.click("applications-launch", { applicationId: application.applicationId });
  await h.click("pending-cancel");
  assert.doesNotMatch(h.app.innerHTML, /data-action="pending-confirm"/);
  assert.equal(h.launches.length, 0);
  assert.equal(h.calls.filter(([name]) => name === "wanx-client:connect-box").length, 0);
});

test("management exposes boxes and credits while preserving the trusted console gateway", async () => {
  const h = await harness();
  const header = h.app.innerHTML.match(/<header[\s\S]*?<\/header>/)[0];
  assert.match(header, /<nav/);
  for (const page of ["applications", "boxes", "credits"]) assert.ok(header.includes(`data-action="show-${page}"`));
  assert.ok(!header.includes('data-action="show-settings"'));
  await h.click("show-boxes");
  await h.click("connect", { deviceId: "box-102" });
  assert.match(h.app.innerHTML, /data-action="dashboard-open"[^>]*>打开盒子控制台/);
  await h.click("dashboard-open", { url: "https://untrusted.example/" });
  assert.deepEqual(h.dashboards.map((connection) => connection.deviceId), ["box-102"]);
  assert.equal(h.dashboards[0].gatewayURL, state("ready", "ready", "box-102").connection.gatewayURL);
  assert.equal(h.launches.length, 0);
  await h.click("show-settings");
  assert.match(h.app.innerHTML, /已登录万象平台/);
  assert.match(h.app.innerHTML, /data-action="startup-toggle" disabled/);
  assert.doesNotMatch(h.app.innerHTML, /account-1|data-action="dashboard-open"/);
});

test("box login failures show connection guidance instead of an application market error", async () => {
  for (const code of BOX_SESSION_ERROR_CODES) {
    const h = await harness(state(), [], { connectFailure: code });
    await h.click("show-boxes");
    await h.click("connect", { deviceId: "box-102" });
    assert.match(h.app.innerHTML, new RegExp(`（${code}）`));
    assert.doesNotMatch(h.app.innerHTML, /暂时无法完成应用市场操作/);
    assert.match(h.app.innerHTML, /尚未连接盒子/);
  }
});

test("console follows gateway readiness and rejects a stale button after disconnect", async () => {
  const h = await harness(state("ready", "ready", "box-102"));
  await h.click("show-boxes");
  h.update(state(), false);
  await h.click("dashboard-open");
  assert.deepEqual(h.dashboards, []);
  for (const next of [
    { ...state("ready", "ready", "box-102"), phase: "recovering" },
    state("enrolling", "checking", "box-102"),
    { ...state("ready", "ready", "box-102"), connection: { mode: "netbird", deviceId: "box-102" } },
  ]) {
    h.update(next);
    assert.doesNotMatch(h.app.innerHTML, /data-action="dashboard-open"/);
    await h.click("dashboard-open");
    assert.deepEqual(h.dashboards, []);
  }
});

test("boxes page survives network polling and blocks connection until ready", async () => {
  const h = await harness(state("enrolling", "checking"));
  await h.click("show-boxes");
  assert.match(h.app.innerHTML, /disabled>网络连接中<\/button>/);
  await h.click("connect", { deviceId: "box-102" });
  assert.equal(h.calls.filter(([name]) => name === "wanx-client:connect-box").length, 0);
  h.update(state());
  assert.match(h.app.innerHTML, /设备管理/);
  assert.match(h.app.innerHTML, /data-action="connect"/);
  assert.doesNotMatch(h.app.innerHTML, /class="application-card"/);
});

test("switching or disconnecting a box warns that the original application connection expires", async () => {
  const h = await harness(state("ready", "ready", "box-102"));
  await h.click("show-boxes");
  await h.click("connect", { deviceId: "box-103" });
  assert.match(h.app.innerHTML, /当前应用与原盒子的连接将失效/);
  assert.equal(h.calls.filter(([name]) => name === "wanx-client:connect-box").length, 0);
  await h.click("market-confirm");
  assert.match(h.app.innerHTML, /class="current-device">CentuarAI-AMD-103/);
  await h.click("disconnect");
  assert.match(h.app.innerHTML, /当前应用与盒子的连接将失效/);
  await h.click("market-confirm");
  assert.match(h.app.innerHTML, /尚未连接盒子/);
  await h.click("show-settings");
  await h.click("network-toggle");
  assert.match(h.app.innerHTML, /aria-checked="false" aria-label="万象网络"/);
  await h.click("network-toggle");
  assert.match(h.app.innerHTML, /aria-checked="true" aria-label="万象网络"/);
  assert.deepEqual(h.calls.filter(([name]) => name === "wanx-client:set-network-enabled").map(([, value]) => value), [false, true]);
});

test("network failure is actionable without disabling independent app requests", async () => {
  const h = await harness(state("ready", "ready", "box-102"));
  h.update(state("unavailable", "unavailable", "box-102"));
  assert.match(h.app.innerHTML, /网络暂不可用/);
  assert.match(h.app.innerHTML, /data-action="applications-launch"/);
  await h.click("show-settings");
  assert.match(h.app.innerHTML, /重试连接/);
  await h.click("refresh");
  assert.ok(h.calls.some(([name]) => name === "wanx-client:refresh-devices"));
  h.update(state());
  await h.click("show-boxes");
  assert.match(h.app.innerHTML, /data-action="connect"/);
});

test("market installation requires confirmation and works without a connected box", async () => {
  const h = await harness(state(), []);
  assert.match(h.app.innerHTML, /安装你的第一个应用/);
  assert.match(h.app.innerHTML, /data-action="market-install"/);
  assert.doesNotMatch(h.app.innerHTML, /application-source|sourceDir|应用目录路径/);
  await h.click("market-install", { applicationId: application.applicationId });
  assert.match(h.app.innerHTML, /role="alertdialog"/);
  assert.equal(h.calls.filter(([name]) => name === "wanx-client:market-install").length, 0);
  await h.click("market-confirm");
  assert.match(h.app.innerHTML, /class="application-card"/);
  assert.match(h.app.innerHTML, /已是最新版本/);
  assert.equal(h.launches.length, 0);
  assert.equal(h.calls.find(([name]) => name === "wanx-client:market-install")[1].applicationId, application.applicationId);
});

test("market cancellation, uninstall and rollback require explicit confirmation", async () => {
  const h = await harness(state(), [{ ...application, previous: { version: "0.4.2" } }]);
  assert.match(h.app.innerHTML, /恢复上一版本/);
  await h.click("market-uninstall", { applicationId: application.applicationId });
  assert.match(h.app.innerHTML, /保留应用业务数据/);
  await h.click("market-cancel");
  assert.equal(h.calls.filter(([name]) => name === "wanx-client:market-uninstall").length, 0);
  await h.click("market-rollback", { applicationId: application.applicationId });
  assert.match(h.app.innerHTML, /恢复到 v0.4.2/);
  await h.keydown("Escape");
  assert.doesNotMatch(h.app.innerHTML, /role="alertdialog"/);
  await h.click("market-rollback", { applicationId: application.applicationId });
  await h.click("market-confirm");
  assert.equal(h.calls.filter(([name]) => name === "wanx-client:market-rollback").length, 1);
  await h.click("market-uninstall", { applicationId: application.applicationId });
  await h.click("market-confirm");
  assert.match(h.app.innerHTML, /安装你的第一个应用/);
});

for (const [status, label] of [["local_newer", "本机版本较新"], ["incompatible", "暂不兼容"], ["unavailable", "暂无适用版本"]]) {
  test(`market status ${status} never enables an install action`, async () => {
    const h = await harness(state(), [], { candidate: async () => ({ status }) });
    assert.match(h.app.innerHTML, new RegExp(label));
    assert.doesNotMatch(h.app.innerHTML, /data-action="market-install"/);
    await h.click("market-install", { applicationId: application.applicationId });
    assert.doesNotMatch(h.app.innerHTML, /role="alertdialog"/);
  });
}

test("market update displays the target version while app opening stays available", async () => {
  const h = await harness(state("enrolling", "checking"), [application], { candidate: async () => ({ status: "available", release: { version: "0.5.0" } }) });
  assert.match(h.app.innerHTML, /可更新至 v0.5.0/);
  await h.click("market-install", { applicationId: application.applicationId });
  assert.match(h.app.innerHTML, /将 v0.4.3 更新至 v0.5.0/);
  assert.match(h.app.innerHTML, /data-action="applications-launch"/);
});

test("preload strips untrusted package inputs and hides directory installation", async () => {
  const h = await harness(state(), []);
  await h.window.wanxClient.action("market.install", { applicationId: application.applicationId, url: "https://attacker.example/file", sourceDir: "/tmp/evil", sha256: "evil" });
  const input = h.calls.find(([name]) => name === "wanx-client:market-install")[1];
  assert.deepEqual(Object.keys(input), ["applicationId"]);
  const response = await h.window.wanxClient.action("applications.install", { sourceDir: "/tmp/evil" });
  assert.equal(response.ok, false);
  assert.equal(response.code, "UNKNOWN_CLIENT_ACTION");
});

test("late market responses after logout do not leak the previous account catalog", async () => {
  let resolveList;
  const h = await harness(state(), [], { list: () => new Promise((resolve) => { resolveList = resolve; }) });
  await h.click("logout");
  resolveList({ items: [{ ...application, name: "Private old catalog" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.app.innerHTML, /登录万象平台/);
  assert.doesNotMatch(h.app.innerHTML, /Private old catalog/);
});

test("market installation errors explain incompatible packages and allow retry", async () => {
  let failure = true;
  const h = await harness(state(), [], { install: async () => {
    if (failure) throw new Error("APPLICATION_PLATFORM_UNSUPPORTED");
    return application;
  } });
  await h.click("market-install", { applicationId: application.applicationId });
  await h.click("market-confirm");
  assert.match(h.app.innerHTML, /此安装包不适用于当前电脑/);
  assert.doesNotMatch(h.app.innerHTML, /APPLICATION_PLATFORM_UNSUPPORTED/);
  failure = false;
  await h.click("market-install", { applicationId: application.applicationId });
  await h.click("market-confirm");
  assert.match(h.app.innerHTML, /class="application-card"/);
});

test("a stale open button starts explicit box confirmation rather than bypassing the main-process check", async () => {
  const h = await harness(state("ready", "ready", "box-102"));
  h.update(state(), false);
  await h.click("applications-launch", { applicationId: application.applicationId });
  assert.equal(h.launches.length, 0);
  assert.match(h.app.innerHTML, /连接盒子并打开应用/);
});

test("logout resets settings and the next login returns to the application homepage", async () => {
  const h = await harness();
  await h.click("show-settings");
  await h.click("logout");
  assert.match(h.app.innerHTML, /登录万象平台/);
  await h.submit("auth", { username: "13800000000", password: "example-password" });
  assert.match(h.app.innerHTML, /class="application-card"/);
  assert.doesNotMatch(h.app.innerHTML, /设备管理/);
});

test("device setup retains its wizard across polling and returns to boxes", async () => {
  const h = await harness();
  await h.click("show-settings");
  await h.click("provisioning");
  assert.match(h.app.innerHTML, /发现并配置盒子/);
  h.update(state("enrolling", "checking"));
  assert.match(h.app.innerHTML, /发现并配置盒子/);
  await h.click("back-devices");
  assert.match(h.app.innerHTML, /设备管理/);
  assert.match(h.app.innerHTML, /disabled>网络连接中<\/button>/);
});

test("box scanning disables repeat clicks, then allows a new scan after timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await harness(state(), [application], t);
  await h.click("provisioning");
  await h.click("start-provisioning");
  const scanButton = () => h.app.innerHTML.match(/<button[^>]*data-action="start-provisioning"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.match(scanButton(), /disabled/);
  assert.match(scanButton(), /正在扫描/);
  assert.match(scanButton(), /aria-busy="true"/);
  assert.match(scanButton(), /class="scan-spinner"/);
  await new Promise(resolve => setImmediate(resolve));
  const chooser = h.chooser();
  await h.click("start-provisioning");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.chooser(), chooser, "repeat clicks must not restart Bluetooth discovery");
  h.update(state());
  assert.match(scanButton(), /disabled/);
  t.mock.timers.tick(12000);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(scanButton(), /重新扫描/);
  assert.doesNotMatch(scanButton(), /disabled/);
  await h.click("start-provisioning");
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(h.chooser(), chooser);
  assert.match(scanButton(), /disabled/);
});

test("discovered boxes remain selectable after the scan times out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await harness(state(), [application], t);
  await h.click("provisioning");
  await h.click("start-provisioning");
  await new Promise((resolve) => setImmediate(resolve));
  const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
  assert.match(h.app.innerHTML, /Test box/);
  t.mock.timers.tick(12000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.app.innerHTML, /Test box/, "timeout must not discard discovered boxes");
  await h.click("select-candidate", { candidateId });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.app.innerHTML, /确认设备身份/);
  assert.doesNotMatch(h.app.innerHTML, /scan-spinner|正在扫描…/);
  assert.ok(h.calls.some(([name]) => name === "nexusaos:discovery:reselect"));
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:begin").length, 1);
});

test("Windows discovery keeps the chooser and renderer lease open for late box names", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await harness(state(), [application], { after: t.after.bind(t), platform: "win32" });
  await h.click("provisioning");
  await h.click("start-provisioning");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.app.innerHTML, /class="scan-spinner"/);
  assert.doesNotMatch(h.app.innerHTML, /role="progressbar"/);
  t.mock.timers.tick(20000);
  assert.doesNotMatch(h.app.innerHTML, /扫描已结束/);
  h.advertisement({ deviceId: "provider-1", advertisedName: "CentaurOS-Setup-000FE1",
    displayIdentity: { deviceId: "centauros-727f68e96c972c5bcf000fe1", displayName: "CentaurAI-AMD-102" } });
  assert.match(h.app.innerHTML, /<strong>CentaurAI-AMD-102<\/strong>/);
  assert.match(h.app.innerHTML, /class="scan-spinner"/);
  t.mock.timers.tick(40000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.app.innerHTML, /扫描已结束/);
  assert.match(h.app.innerHTML, /<strong>CentaurAI-AMD-102<\/strong>/);
  const scanButton = h.app.innerHTML.match(/<button[^>]*data-action="start-provisioning"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.match(scanButton, /重新扫描/);
  assert.doesNotMatch(scanButton, /disabled/);
  const oldChooser = h.chooser();
  await h.click("start-provisioning");
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(h.chooser(), oldChooser, "repeat scan must start a fresh Bluetooth chooser");
  assert.match(h.app.innerHTML, /class="scan-spinner"/);
});

test("selection during a live scan still opens device identity", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await harness(state(), [application], t);
  await h.click("provisioning");
  await h.click("start-provisioning");
  await new Promise((resolve) => setImmediate(resolve));
  const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
  await h.click("select-candidate", { candidateId });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.app.innerHTML, /确认设备身份/);
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:begin").length, 1);
});

test("expired results are removed and require a new scan", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await harness(state(), [application], t);
  await h.click("provisioning");
  await h.click("start-provisioning");
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(12000);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(120000);
  assert.doesNotMatch(h.app.innerHTML, /Test box/);
  assert.match(h.app.innerHTML, /扫描结果已过期/);
  assert.ok(h.calls.some(([name]) => name === "nexusaos:discovery:forget"));
});

test("a missing retained target never selects a different box with the same name", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await harness(state(), [application], t);
  await h.click("provisioning");
  await h.click("start-provisioning");
  await new Promise((resolve) => setImmediate(resolve));
  const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
  t.mock.timers.tick(12000);
  await new Promise((resolve) => setImmediate(resolve));
  h.nearby([{ deviceId: "provider-2", deviceName: "Test box" }]);
  await h.click("select-candidate", { candidateId });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(12000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:begin").length, 0);
  assert.match(h.app.innerHTML, /未能连接所选盒子/);
  assert.match(h.app.innerHTML, /Test box/);
  h.nearby([{ deviceId: "provider-1", deviceName: "Test box" }]);
  await h.click("select-candidate", { candidateId });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.app.innerHTML, /确认设备身份/);
});

test("failed reselection keeps the first result expiry in the rendered flow", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await harness(state(), [application], t);
  await h.click("provisioning"); await h.click("start-provisioning");
  await new Promise(resolve => setImmediate(resolve));
  const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
  t.mock.timers.tick(12000);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(60000);
  h.nearby([]);
  await h.click("select-candidate", { candidateId });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(12000);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.app.innerHTML, /未能连接所选盒子/);
  assert.match(h.app.innerHTML, /Test box/);
  t.mock.timers.tick(48000);
  assert.match(h.app.innerHTML, /扫描结果已过期/);
  assert.doesNotMatch(h.app.innerHTML, /Test box/);
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:begin").length, 0);
});

test("result expiry cancels in-progress reselection without starting setup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await harness(state(), [application], t);
  await h.click("provisioning"); await h.click("start-provisioning");
  await new Promise(resolve => setImmediate(resolve));
  const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
  t.mock.timers.tick(12000);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(119999);
  h.nearby([]);
  await h.click("select-candidate", { candidateId });
  await new Promise(resolve => setImmediate(resolve));
  const lateChooser = h.chooser();
  assert.match(h.app.innerHTML, /data-candidate-id="[^"]+" disabled/);
  t.mock.timers.tick(1);
  lateChooser("provider-1");
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.app.innerHTML, /扫描结果已过期/);
  assert.doesNotMatch(h.app.innerHTML, /Test box|未能连接所选盒子/);
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:begin").length, 0);
});

for (const leave of ["back-devices", "logout"]) {
  test(`${leave} revokes scan results and a late chooser cannot start setup`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = await harness(state(), [application], t);
    await h.click("provisioning");
    await h.click("start-provisioning");
    await new Promise((resolve) => setImmediate(resolve));
    const lateChooser = h.chooser();
    if (leave === "logout") h.update({ account: { phase: "signed_out" } });
    else await h.click(leave);
    lateChooser("provider-1");
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(132000);
    assert.doesNotMatch(h.app.innerHTML, /Test box|扫描结果已过期/);
    assert.equal(h.calls.filter(([name]) => name === "wanx:setup:begin").length, 0);
    assert.ok(h.calls.some(([name]) => name === "nexusaos:discovery:forget"));
  });
}

test("an empty scan allows retry after reporting no nearby box", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await harness(state(), [application], t);
  h.nearby([]);
  await h.click("provisioning");
  await h.click("start-provisioning");
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(12000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.app.innerHTML, /未发现可用盒子/);
  assert.doesNotMatch(h.app.innerHTML, /User cancelled/);
  assert.match(actionButton(h, "start-provisioning"), /开始扫描盒子/);
  assert.doesNotMatch(actionButton(h, "start-provisioning"), /disabled/);
  const oldChooser = h.chooser();
  await h.click("start-provisioning");
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(h.chooser(), oldChooser);
  assert.match(actionButton(h, "start-provisioning"), /disabled/);
  await h.click("back-devices");
  await h.click("provisioning");
  assert.match(h.app.innerHTML, /data-action="start-provisioning"/);
});

test("native menu navigation reaches settings and home while preserving login and setup boundaries", async () => {
  const h = await harness({ account: { phase: "signed_out" } });
  h.navigate("settings");
  assert.match(h.app.innerHTML, /登录万象平台/);
  h.update(state());
  h.navigate("boxes");
  assert.match(h.app.innerHTML, /设备管理/);
  h.navigate("https://untrusted.example/");
  assert.match(h.app.innerHTML, /设备管理/);
  h.navigate("applications");
  assert.match(h.app.innerHTML, /class="application-card"/);
  await h.click("show-settings");
  await h.click("provisioning");
  h.navigate("applications");
  assert.match(h.app.innerHTML, /发现并配置盒子/);
});


test("legacy version selection shows one application and persists through trusted IPC", async () => {
  const h = await harness(state(), [{ applicationId: application.applicationId, name: application.name, selectionRequired: true, versions: [{ version: "preview" }, { version: "1.0.0" }] }]);
  assert.equal((h.app.innerHTML.match(/class="application-card"/g) || []).length, 1);
  assert.match(h.app.innerHTML, /历史版本无法自动比较/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="applications-launch"/);
  await h.click("applications-select-current", { applicationId: application.applicationId, version: "1.0.0" });
  assert.ok(h.calls.some(([action, id, version]) => action === "selected-current" && id === application.applicationId && version === "1.0.0"));
  assert.doesNotMatch(h.app.innerHTML, /历史版本无法自动比较/);
  assert.match(h.app.innerHTML, /v1.0.0/);
});


test("market failure leaves installed applications available and presents a Chinese retry message", async () => {
  const h = await harness(state("ready", "ready", "box-102"), [application], { list: async () => { throw new Error("MARKET_NOT_CONFIGURED"); } });
  assert.match(h.app.innerHTML, /应用市场尚未配置完成/);
  assert.match(h.app.innerHTML, /data-action="applications-launch"/);
  assert.match(h.app.innerHTML, /检查更新/);
  assert.doesNotMatch(h.app.innerHTML, /MARKET_NOT_CONFIGURED/);
});

test("catalog text is escaped and unauthenticated users do not request the market", async () => {
  const signedOut = await harness({ account: { phase: "signed_out" } });
  assert.equal(signedOut.calls.filter(([name]) => name.startsWith("wanx-client:market-")).length, 0);
  const h = await harness(state(), [], { list: async () => ({ items: [{ ...application, name: '<script>unsafe</script>', description: '<img src=x onerror="unsafe()">' }] }) });
  assert.match(h.app.innerHTML, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(h.app.innerHTML, /<script>unsafe|<img src=x/);
});

for (const installed of [[], [application]]) {
  test(`candidate package details and escaped release notes appear on ${installed.length ? "installed" : "market"} cards`, async () => {
    const h = await harness(state(), installed, { candidate: async () => ({
      status: "available", release: { version: "0.5.0", notes: '支持新模型\n<script>alert("unsafe")</script>' },
      artifact: { os: "macos", arch: "arm64", size: 2568392 },
    }) });
    assert.match(h.app.innerHTML, /macOS · Apple 芯片 · 2.4 MB/);
    assert.match(h.app.innerHTML, /v0.5.0 更新说明/);
    assert.match(h.app.innerHTML, /支持新模型\n&lt;script&gt;/);
    assert.doesNotMatch(h.app.innerHTML, /<script>alert/);
  });
}

test("missing artifacts and blank release notes do not create empty detail sections", async () => {
  const h = await harness(state(), [], { candidate: async () => ({ status: "unavailable", release: { version: "0.5.0", notes: " \n " }, artifact: null }) });
  assert.doesNotMatch(h.app.innerHTML, /class="market-metadata"|class="market-notes"|undefined|NaN/);
});

test("universal application cards show a shared package and allow installation", async () => {
  const h = await harness(state(), [], { candidate: async () => ({
    status: "available", release: { version: "0.5.0" },
    artifact: { os: "universal", arch: "universal", size: 2568392 },
  }) });
  assert.match(h.app.innerHTML, /通用应用包 · 2.4 MB/);
  assert.match(h.app.innerHTML, /data-action="market-install"/);
});

for (const [reason, label] of [
  ["application_unlisted", "此应用尚未上架或已下架"],
  ["no_published_target", "暂无可安装的应用包.*通用应用包"],
  ["release_unavailable", "此发行版本暂不可用"],
  ["wanx_version", "请先升级万象"],
  ["host_protocol", "当前万象运行协议不兼容"],
  ["reinstall_required", "此版本需管理员协助重新安装"],
]) {
  test(`candidate reason ${reason} explains how to proceed without enabling install`, async () => {
    const h = await harness(state(), [], { candidate: async () => ({ status: reason.endsWith("unlisted") || reason.endsWith("target") || reason.endsWith("unavailable") ? "unavailable" : "incompatible", reason }) });
    assert.match(h.app.innerHTML, new RegExp(label));
    assert.doesNotMatch(h.app.innerHTML, /data-action="market-install"/);
  });
}

for (const [code, label] of [
  ["MARKET_SERVICE_NOT_DEPLOYED", "应用市场接口尚未部署"],
  ["MARKET_UNTRUSTED_SIGNING_KEY", "服务器不信任此发行签名"],
  ["MARKET_STORAGE_UNAVAILABLE", "安装包存储暂不可用"],
  ["APPLICATION_RETIRED", "此应用已退役"],
]) {
  test(`candidate error ${code} survives IPC and presents its recovery message`, async () => {
    let failed = true;
    const h = await harness(state(), [], { candidate: async () => {
      if (failed) throw Object.assign(new Error("request failed"), { code });
      return { status: "available", release: { version: "0.4.3" } };
    } });
    assert.match(h.app.innerHTML, new RegExp(label));
    assert.doesNotMatch(h.app.innerHTML, /data-action="market-install"/);
    failed = false;
    await h.click("market-refresh");
    assert.match(h.app.innerHTML, /data-action="market-install"/);
    assert.doesNotMatch(h.app.innerHTML, new RegExp(label));
  });
}

test("one candidate failure does not hide another app's installable version", async () => {
  const other = { ...application, applicationId: "example.other", name: "另一个应用" };
  const h = await harness(state(), [], {
    list: async () => ({ items: [application, other] }),
    candidate: async (id) => {
      if (id === application.applicationId) throw new Error("MARKET_DATABASE_UNAVAILABLE");
      return { status: "available", release: { version: "1.0.0" } };
    },
  });
  assert.match(h.app.innerHTML, /应用市场服务暂不可用/);
  assert.match(h.app.innerHTML, /data-action="market-install" data-application-id="example.other"/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="market-install" data-application-id="centaurai.wanx.zhijun"/);
});

for (const provisioning of [false, true]) {
  test(`account switching discards stale candidates${provisioning ? " while provisioning" : ""}`, async () => {
    let resolveCandidate;
    let listCalls = 0;
    const h = await harness(state(), [], {
      list: async () => ({ items: [{ ...application, name: ++listCalls === 1 ? "旧账号目录" : "新账号目录" }] }),
      candidate: () => listCalls === 1 ? new Promise((resolve) => { resolveCandidate = resolve; })
        : Promise.resolve({ status: "available", release: { version: "0.5.0", notes: "新账号版本说明" } }),
    });
    if (provisioning) await h.click("provisioning");
    h.update({ ...state(), account: { phase: "authenticated", accountId: "account-2" } });
    await new Promise((resolve) => setImmediate(resolve));
    resolveCandidate({ status: "available", release: { version: "99.0.0", notes: "旧账号版本说明" } });
    await new Promise((resolve) => setImmediate(resolve));
    if (provisioning) await h.click("show-applications");
    assert.match(h.app.innerHTML, /新账号目录/);
    assert.match(h.app.innerHTML, /新账号版本说明/);
    assert.doesNotMatch(h.app.innerHTML, /旧账号|99.0.0/);
    assert.equal(listCalls, 2);
  });
}


test("installing one application keeps another application's open action available", async () => {
  let finishInstall;
  const other = { ...application, applicationId: "example.other", name: "另一个应用" };
  const h = await harness(state("ready", "ready", "box-102"), [other], {
    list: async () => ({ items: [application, other] }),
    install: () => new Promise((resolve) => { finishInstall = resolve; }),
  });
  await h.click("market-install", { applicationId: application.applicationId });
  const installing = h.click("market-confirm");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.app.innerHTML, /正在安装/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="applications-launch" data-application-id="example.other" disabled/);
  await h.click("applications-launch", { applicationId: other.applicationId });
  assert.deepEqual(h.launches, [[other.applicationId, undefined]]);
  finishInstall(application);
  await installing;
  assert.match(h.app.innerHTML, /知君/);
  assert.doesNotMatch(h.app.innerHTML, /正在安装/);
});

test("network polling and external navigation never reconstruct an active Wi-Fi form", async () => {
  const h = await harness();
  await h.click("provisioning");
  h.setup({ state: "awaitingWifi" });
  const count = h.renderCount;
  const form = h.form("wifi");
  form.values = { ssid: "My Wi-Fi", password: "unsent-network-password" };
  assert.match(h.app.innerHTML, /data-form="wifi"/);
  h.update({ ...state("enrolling", "checking"), devices: [{ ...devices[0], displayName: "Renamed box" }] });
  h.navigate("applications");
  assert.equal(h.renderCount, count, "the actual input nodes must stay attached while polling");
  assert.equal(h.form("wifi"), form);
  assert.equal(h.form("wifi").values.password, "unsent-network-password");
  assert.match(h.app.innerHTML, /data-form="wifi"/);
});

test("box permission and transport states stay distinct from provisioning", async () => {
  const h = await harness({ ...state(), devices: [
    { ...devices[0], accessState: "access_denied", canOpen: false },
    { ...devices[1], accessState: "ready", networkReady: false, canOpen: false },
    { deviceId: "box-pending", displayName: "待授权盒子", accessState: "authorization_pending", canOpen: false },
  ] });
  await h.click("show-boxes");
  assert.match(h.app.innerHTML, /未获访问权限/);
  assert.match(h.app.innerHTML, /当前不可达/);
  assert.match(h.app.innerHTML, /正在同步访问权限/);
  assert.match(h.app.innerHTML, /授权同步完成后会自动更新/);
  assert.doesNotMatch(h.app.innerHTML, /开始初始化|配置盒子|data-action="connect"/);
  await h.click("connect", { deviceId: "box-102" });
  assert.equal(h.calls.filter(([name]) => name === "wanx-client:connect-box").length, 0);
  h.update({ ...state("ready", "ready", "box-102"), phase: "recovering" });
  assert.match(h.app.innerHTML, /正在恢复连接/);
  assert.doesNotMatch(h.app.innerHTML, /当前连接/);
});


test("invalid login credentials receive an account-specific recovery message", async () => {
  const h = await harness({ account: { phase: "signed_out" } }, [], { loginFailure: "invalid_credentials" });
  await h.submit("auth", { username: "13800000000", password: "wrong-password" });
  assert.match(h.app.innerHTML, /手机号或密码不正确，请重试/);
  assert.doesNotMatch(h.app.innerHTML, /应用市场操作/);
});


test("ordinary signed-out broadcasts preserve the login form and typed credentials only in its nodes", async () => {
  const h = await harness({ account: { phase: "signed_out" } }, []);
  const form = h.form("auth");
  form.values = { username: "13800000000", password: "unsent-example-password" };
  h.update({ account: { phase: "signed_out" }, network: { enabled: false, phase: "disabled" } });
  assert.equal(h.form("auth"), form);
  assert.deepEqual(h.form("auth").values, { username: "13800000000", password: "unsent-example-password" });
  assert.doesNotMatch(h.app.innerHTML, /unsent-example-password/);
  h.update(state());
  assert.equal(h.form("auth"), undefined);
  await h.click("logout");
  assert.notEqual(h.form("auth"), form, "a later logout must create a fresh login form");
  assert.deepEqual(h.form("auth").values, {});
});

test("Wi-Fi setup state updates reuse the form node without moving secrets into state", async () => {
  const h = await harness();
  await h.click("provisioning");
  h.setup({ state: "awaitingWifi" });
  const form = h.form("wifi");
  form.values = { ssid: "My Wi-Fi", password: "unsent-network-password" };
  h.setup({ state: "awaitingWifi", preview: { display_name: "Box", device_id: "box-102" } });
  assert.equal(h.form("wifi"), form);
  assert.equal(h.form("wifi").values.password, "unsent-network-password");
  assert.doesNotMatch(h.app.innerHTML, /unsent-network-password/);
  h.setup({ state: "awaitingOwnershipConfirmation" });
  assert.equal(h.form("wifi"), undefined);
});


test("discovery names join the complete account device ID while selection keeps the opaque handle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await harness(state(), [application], t);
  h.nearby([{ deviceId: "provider-1", deviceName: "CentaurOS-Setup-0102" }]);
  await h.click("provisioning");
  await h.click("start-provisioning");
  await new Promise((resolve) => setImmediate(resolve));
  const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
  assert.match(h.app.innerHTML, /CentaurOS-Setup-0102 · 选择后核对设备身份/);
  assert.doesNotMatch(h.app.innerHTML, /正在读取盒子名称/);
  h.advertisement({ deviceId: "provider-1", advertisedName: "CentaurOS-Setup-0102", displayIdentity: { deviceId: "box-102", displayName: "Public box name" } });
  assert.match(h.app.innerHTML, /<strong>CentuarAI-AMD-102<\/strong>/);
  assert.match(h.app.innerHTML, /CentaurOS-Setup-0102 · 蓝牙配网/);
  assert.equal(h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1], candidateId);
  assert.doesNotMatch(h.app.innerHTML, /Public box name|身份已验证/);
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:begin").length, 0);
  await h.click("select-candidate", { candidateId });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.find(([name]) => name === "nexusaos:discovery:select")[1].candidateId, candidateId);
  const selected = h.calls.find(([name]) => name === "wanx:setup:begin")[1];
  assert.ok(selected.transportHandle);
  assert.ok(selected.selectionLeaseId);
  assert.equal(selected.displayIdentity, undefined);
  assert.equal(selected.deviceId, undefined);
  assert.equal(selected.nameSource, undefined);
});

test("missing box names are explicit and identifiers never become names or suffix matches", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await harness(state(), [application], t);
  await h.click("provisioning");
  await h.click("start-provisioning");
  await new Promise((resolve) => setImmediate(resolve));
  h.advertisement({ deviceId: "provider-1", advertisedName: "CentaurOS-Setup-0102", displayIdentity: { deviceId: "other-box-102", displayName: "CentaurAI Box" } });
  assert.match(h.app.innerHTML, /<strong>未获取到盒子名称<\/strong>/);
  assert.match(h.app.innerHTML, /设备编号：other-box-102（用于核对，不是名称）/);
  assert.doesNotMatch(h.app.innerHTML, /CentuarAI-AMD-102|<strong>CentaurAI Box/);
  h.advertisement({ deviceId: "provider-1", advertisedName: "CentaurOS-Setup-0102", displayIdentity: { deviceId: "other-box-102", displayName: "Office box" } });
  assert.match(h.app.innerHTML, /<strong>Office box<\/strong>/);
  h.advertisement({ deviceId: "provider-1", advertisedName: "CentaurOS-Setup-0102", displayIdentity: { deviceId: "other-box-102", displayName: "   " } });
  assert.match(h.app.innerHTML, /<strong>未获取到盒子名称<\/strong>/);
});

const discoveryId = index => `centauros-${index.toString(16).padStart(24, "0")}`;
const settleDiscovery = () => new Promise(resolve => setImmediate(resolve));
async function startDiscovery(h) {
  await h.click("provisioning");
  await h.click("start-provisioning");
  await settleDiscovery();
}
function discoveryIdentity(h, deviceId, provider = "provider-1", displayName = "CentaurAI Box") {
  h.advertisement({ deviceId: provider, advertisedName: "CentaurOS-Setup-0102", displayIdentity: { deviceId, displayName } });
}

test("discovery resolves another user's claimed box name without changing its opaque selection", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const id = discoveryId(1);
  const h = await harness({ ...state(), devices: [] }, [application], {
    after: fn => t.after(fn),
    lookupDeviceDiscovery: async ids => ({ devices: ids.map(deviceId => ({ deviceId,
      deviceName: '<客户盒子 "A">', claimStatus: "claimed" })) }),
  });
  await startDiscovery(h);
  const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
  assert.match(h.app.innerHTML, /认领状态待确认/);
  assert.equal(h.calls.filter(([name]) => name === "lookup-device-discovery").length, 0);
  discoveryIdentity(h, id);
  await settleDiscovery();
  assert.match(h.app.innerHTML, /<strong>&lt;客户盒子 &quot;A&quot;&gt;<\/strong>/);
  assert.match(h.app.innerHTML, /claim-claimed">已认领/);
  assert.doesNotMatch(h.app.innerHTML, /<客户盒子|认领状态待确认/);
  assert.equal(h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1], candidateId);
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:begin").length, 0);
  assert.deepEqual(h.calls.find(([name]) => name === "lookup-device-discovery")[1], [id]);
  await h.click("select-candidate", { candidateId });
  await settleDiscovery();
  assert.equal(h.calls.find(([name]) => name === "nexusaos:discovery:select")[1].candidateId, candidateId);
  const selected = h.calls.find(([name]) => name === "wanx:setup:begin")[1];
  assert.ok(selected.transportHandle);
  assert.equal(selected.deviceId, undefined);
  assert.equal(selected.claimStatus, undefined);
});

test("unclaimed inventory names are visible and discovery queries stay batched and event driven", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ids = Array.from({ length: 18 }, (_, index) => discoveryId(index + 1));
  const h = await harness({ ...state(), devices: [] }, [application], {
    after: fn => t.after(fn),
    lookupDeviceDiscovery: async values => ({ devices: values.map(deviceId => ({ deviceId,
      deviceName: `库存盒子 ${ids.indexOf(deviceId) + 1}`, claimStatus: "unclaimed" })) }),
  });
  h.nearby(ids.map((_, index) => ({ deviceId: `provider-${index + 1}`, deviceName: "Test box" })));
  await startDiscovery(h);
  for (const [index, id] of ids.entries()) discoveryIdentity(h, id, `provider-${index + 1}`);
  await settleDiscovery();
  assert.equal((h.app.innerHTML.match(/claim-unclaimed">未认领/g) || []).length, 18);
  assert.match(h.app.innerHTML, /<strong>库存盒子 18<\/strong>/);
  const requests = () => h.calls.filter(([name]) => name === "lookup-device-discovery");
  assert.deepEqual(requests().map(([, values]) => values.length), [16, 2]);
  assert.deepEqual(requests().flatMap(([, values]) => values), ids);
  for (let iteration = 0; iteration < 3; ++iteration) {
    h.update({ ...state(), devices: [] });
    discoveryIdentity(h, ids[0]);
  }
  await settleDiscovery();
  assert.equal(requests().length, 2, "re-renders and unchanged identity notifications must not poll metadata");
});

for (const outcome of ["unknown", "missing", "404"]) test(`discovery ${outcome} retains the local name and never infers unclaimed`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const id = discoveryId(5);
  const h = await harness({ ...state(), devices: [] }, [application], {
    after: fn => t.after(fn),
    lookupDeviceDiscovery: async () => {
      if (outcome === "404") throw Object.assign(new Error("not found"), { status: 404 });
      return { devices: outcome === "missing" ? [] : [{ deviceId: id, deviceName: null, claimStatus: "unknown" }] };
    },
  });
  await startDiscovery(h);
  discoveryIdentity(h, id, "provider-1", "附近的盒子");
  await settleDiscovery();
  assert.match(h.app.innerHTML, /<strong>附近的盒子<\/strong>/);
  assert.match(h.app.innerHTML, /claim-unknown">认领状态待确认/);
  assert.doesNotMatch(h.app.innerHTML, /claim-unclaimed|claim-claimed/);
  h.update({ ...state(), devices: [] });
  await settleDiscovery();
  assert.equal(h.calls.filter(([name]) => name === "lookup-device-discovery").length, 1);
});

test("an explicit account owner or member remains claimed and the owner's existing connection still works", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const id = discoveryId(6);
  const owned = { ...devices[0], deviceId: id, deviceRole: "owner" };
  const h = await harness({ ...state(), devices: [owned] }, [application], {
    after: fn => t.after(fn), lookupDeviceDiscovery: async () => { throw new Error("offline"); },
  });
  await startDiscovery(h);
  discoveryIdentity(h, id);
  await settleDiscovery();
  assert.match(h.app.innerHTML, /claim-claimed">已认领/);
  h.update({ ...state(), devices: [{ ...owned, deviceRole: "member" }] });
  assert.match(h.app.innerHTML, /claim-claimed">已认领/);
  h.update({ ...state(), devices: [owned] });
  await h.click("back-devices");
  await h.click("connect", { deviceId: id });
  assert.equal(h.calls.find(([name]) => name === "wanx-client:connect-box")[1], id);
});

test("each new scan refreshes inventory names and claim state", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const id = discoveryId(7);
  let revision = 0;
  const h = await harness({ ...state(), devices: [] }, [application], {
    after: fn => t.after(fn),
    lookupDeviceDiscovery: async () => ({ devices: [{ deviceId: id,
      deviceName: ++revision === 1 ? "第一次扫描名称" : "新的库存名称",
      claimStatus: revision === 1 ? "unclaimed" : "claimed" }] }),
  });
  await startDiscovery(h);
  discoveryIdentity(h, id);
  await settleDiscovery();
  assert.match(h.app.innerHTML, /第一次扫描名称/);
  assert.match(h.app.innerHTML, /claim-unclaimed">未认领/);
  t.mock.timers.tick(12000);
  await settleDiscovery();
  await h.click("start-provisioning");
  await settleDiscovery();
  discoveryIdentity(h, id);
  await settleDiscovery();
  assert.match(h.app.innerHTML, /新的库存名称/);
  assert.match(h.app.innerHTML, /claim-claimed">已认领/);
  assert.doesNotMatch(h.app.innerHTML, /第一次扫描名称/);
  assert.equal(revision, 2);
});

test("late inventory metadata enriches retained scan results without selecting or extending retention", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const id = "centauros-37859979e324b9e257c586da";
  let completeLookup;
  const h = await harness({ ...state(), devices: [] }, [application], {
    after: fn => t.after(fn),
    lookupDeviceDiscovery: () => new Promise(resolve => { completeLookup = resolve; }),
  });
  await startDiscovery(h);
  discoveryIdentity(h, id);
  await settleDiscovery();
  const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
  assert.match(h.app.innerHTML, /未获取到盒子名称/);
  assert.match(h.app.innerHTML, /认领状态待确认/);
  t.mock.timers.tick(12000);
  await settleDiscovery();
  assert.match(h.app.innerHTML, /扫描已结束，本轮结果保留 2 分钟/);
  t.mock.timers.tick(1000);
  completeLookup({ devices: [{ deviceId: id, deviceName: "CentaurOS-79", claimStatus: "unclaimed" }] });
  await settleDiscovery();
  assert.match(h.app.innerHTML, /<strong>CentaurOS-79<\/strong>/);
  assert.match(h.app.innerHTML, /claim-unclaimed">未认领/);
  assert.doesNotMatch(h.app.innerHTML, /未获取到盒子名称|认领状态待确认/);
  assert.equal(h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1], candidateId);
  assert.equal(h.calls.filter(([name]) => name === "lookup-device-discovery").length, 1);
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:begin" || name === "nexusaos:discovery:select").length, 0);
  t.mock.timers.tick(118999);
  await settleDiscovery();
  assert.match(h.app.innerHTML, /CentaurOS-79/);
  t.mock.timers.tick(1);
  await settleDiscovery();
  assert.doesNotMatch(h.app.innerHTML, /data-candidate-id|CentaurOS-79/);
  assert.match(h.app.innerHTML, /扫描结果已过期/);
});

test("late metadata from a previous account cannot populate the new account's scan", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const id = discoveryId(8);
  let completeOld, requests = 0;
  const h = await harness({ ...state(), devices: [] }, [application], {
    after: fn => t.after(fn),
    lookupDeviceDiscovery: async () => ++requests === 1 ? new Promise(resolve => { completeOld = resolve; }) :
      { devices: [{ deviceId: id, deviceName: "当前账号扫描结果", claimStatus: "unclaimed" }] },
  });
  await startDiscovery(h);
  discoveryIdentity(h, id);
  await settleDiscovery();
  h.update({ account: { phase: "signed_out" } });
  h.update({ ...state(), account: { phase: "authenticated", accountId: "account-2" }, devices: [] });
  await startDiscovery(h);
  discoveryIdentity(h, id);
  await settleDiscovery();
  assert.match(h.app.innerHTML, /当前账号扫描结果/);
  completeOld({ devices: [{ deviceId: id, deviceName: "旧账号迟到名称", claimStatus: "claimed" }] });
  await settleDiscovery();
  assert.match(h.app.innerHTML, /当前账号扫描结果/);
  assert.match(h.app.innerHTML, /claim-unclaimed">未认领/);
  assert.doesNotMatch(h.app.innerHTML, /旧账号迟到名称|claim-claimed/);
});

test("revoked then rediscovered identity cannot reuse an old asynchronous metadata response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const id = discoveryId(9);
  let completeOld, requests = 0;
  const h = await harness({ ...state(), devices: [] }, [application], {
    after: fn => t.after(fn),
    lookupDeviceDiscovery: async () => ++requests === 1 ? new Promise(resolve => { completeOld = resolve; }) :
      { devices: [{ deviceId: id, deviceName: "重新核对的名称", claimStatus: "unknown" }] },
  });
  await startDiscovery(h);
  discoveryIdentity(h, id);
  await settleDiscovery();
  h.advertisement({ deviceId: "provider-1", advertisedName: "CentaurOS-Setup-0102", displayIdentity: null });
  discoveryIdentity(h, id);
  assert.match(h.app.innerHTML, /认领状态待确认/);
  completeOld({ devices: [{ deviceId: id, deviceName: "失效身份的名称", claimStatus: "claimed" }] });
  await settleDiscovery();
  assert.match(h.app.innerHTML, /重新核对的名称/);
  assert.doesNotMatch(h.app.innerHTML, /失效身份的名称|claim-claimed/);
  assert.equal(requests, 2);
});

test("numeric box display names remain visible during discovery and identity preview", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const deviceId = "centauros-e8c61ed41ade3ac92c486856";
  const h = await harness(state(), [application], t);
  await h.click("provisioning");
  await h.click("start-provisioning");
  await new Promise((resolve) => setImmediate(resolve));
  h.advertisement({ deviceId: "provider-1", advertisedName: "CentaurOS-Setup-486856",
    displayIdentity: { deviceId, displayName: "CentaurOS-22" } });
  assert.match(h.app.innerHTML, /<strong>CentaurOS-22<\/strong>/);
  assert.doesNotMatch(h.app.innerHTML, /未获取到盒子名称/);
  h.setup({ state: "previewReady", preview: { device_id: deviceId, display_name: "CentaurOS-22",
    cloud_enrollment_status: "ready", pairing_mode_remaining_seconds: 0 } });
  assert.match(h.app.innerHTML, /<dt>设备名称<\/dt><dd>CentaurOS-22<\/dd>/);
  assert.match(h.app.innerHTML, /盒子尚未准备好首次配网/);
  assert.doesNotMatch(h.app.innerHTML, /PROTOCOL_CHANGED/);
});

test("registry and public identifier fallbacks stay labelled as identifiers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const deviceId = "centauros-727f68e96c972c5bcf0553d6";
  const h = await harness({ ...state(), devices: [{ ...devices[0], deviceId, displayName: deviceId }] }, [application], t);
  await h.click("provisioning");
  await h.click("start-provisioning");
  await new Promise((resolve) => setImmediate(resolve));
  for (const displayName of [deviceId, "centauros-box-0553D6", "CentaurOS-Setup-0553D6", "CentaurOS-", "CentaurAI Box"]) {
    h.advertisement({ deviceId: "provider-1", advertisedName: "CentaurOS-Setup-0553D6", displayIdentity: { deviceId, displayName } });
    assert.match(h.app.innerHTML, /<strong>未获取到盒子名称<\/strong>/);
    assert.doesNotMatch(h.app.innerHTML, /<strong>centauros-|<strong>CentaurOS-|<strong>CentaurAI Box/);
    assert.match(h.app.innerHTML, /设备编号：centauros-727f68e96c972c5bcf0553d6/);
  }
  h.advertisement({ deviceId: "provider-1", advertisedName: "CentaurOS-Setup-0553D6", displayIdentity: { deviceId, displayName: "CentaurOS-99" } });
  assert.match(h.app.innerHTML, /<strong>CentaurOS-99<\/strong>/);
  h.update({ ...state(), devices: [{ ...devices[0], deviceId, displayName: "办公室盒子" }] });
  assert.match(h.app.innerHTML, /<strong>办公室盒子<\/strong>/);
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:begin" || name === "nexusaos:discovery:select").length, 0);
});

test("provisioning explains unregistered and closed-window boxes and does not blame the market", async () => {
  const h = await harness();
  await h.click("provisioning");
  const preview = { display_name: "CentaurAI Box", device_id: "box-102", cloud_enrollment_status: "not_enrolled", pairing_mode_remaining_seconds: 0 };
  h.setup({ state: "previewReady", preview });
  assert.match(h.app.innerHTML, /盒子尚未完成平台注册/);
  assert.match(h.app.innerHTML, /data-action="provisioning-confirm" disabled/);
  h.setup({ state: "previewReady", preview: { ...preview, cloud_enrollment_status: "ready" } });
  assert.match(h.app.innerHTML, /盒子尚未准备好首次配网/);
  assert.match(h.app.innerHTML, /data-action="provisioning-confirm" disabled/);
  h.setup({ state: "previewReady", preview: { ...preview, cloud_enrollment_status: "ready", pairing_mode_remaining_seconds: 300 } });
  assert.doesNotMatch(h.app.innerHTML, /data-action="provisioning-confirm" disabled/);
  h.window.wanxSetup.confirmPhysical = async () => { throw new Error("PROTOCOL_CHANGED"); };
  await h.click("provisioning-confirm");
  h.setup({ state: "terminalError", preview, errorCode: "PROTOCOL_CHANGED" });
  assert.match(h.app.innerHTML, /配网协议未能匹配/);
  assert.doesNotMatch(h.app.innerHTML, /应用市场操作失败|应用市场操作，请/);
});

test("settings retains box management and distinguishes account logout from application quit", async () => {
  const h = await harness(state("ready", "ready", "box-102"));
  assert.match(h.app.innerHTML, /data-action="show-boxes"/);
  await h.click("show-settings");
  assert.match(h.app.innerHTML, /管理与切换盒子/);
  assert.match(h.app.innerHTML, /CentuarAI-AMD-102 · 已连接/);
  assert.match(h.app.innerHTML, /退出当前账号/);
  assert.match(h.app.innerHTML, /退出账号会断开盒子，万象仍在后台运行/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="desktop-quit"/);
  const nav = h.app.innerHTML.match(/<nav[^>]*>(.*?)<\/nav>/)[1];
  assert.match(nav, /show-boxes/);
  await h.click("show-boxes");
  assert.match(h.app.innerHTML, /返回设置/);
  assert.match(h.app.innerHTML, /data-action="show-boxes" aria-current="page"/);
  await h.click("show-settings");
  assert.match(h.app.innerHTML, /管理与切换盒子/);
});

for (const retained of [false, true]) {
  test(`account directory updates refresh ${retained ? "retained" : "scanning"} discovery names without selecting a box`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = await harness({ ...state(), devices: [] }, [application], t);
    await h.click("provisioning");
    await h.click("start-provisioning");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(h.app.innerHTML, /class="scan-spinner"/);
    assert.doesNotMatch(h.app.innerHTML, /role="progressbar"/);
    h.advertisement({ deviceId: "provider-1", advertisedName: "CentaurOS-Setup-0102", displayIdentity: { deviceId: "box-102", displayName: "CentaurAI Box" } });
    assert.match(h.app.innerHTML, /class="scan-spinner"/);
    const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
    assert.match(h.app.innerHTML, /<strong>未获取到盒子名称<\/strong>/);
    if (retained) {
      t.mock.timers.tick(12000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(h.app.innerHTML, /扫描已结束/);
      assert.doesNotMatch(h.app.innerHTML, /class="scan-spinner"/);
    }
    h.update(state());
    assert.match(h.app.innerHTML, /<strong>CentuarAI-AMD-102<\/strong>/);
    h.update({ ...state(), devices: [{ ...devices[0], displayName: "Renamed account box" }] });
    assert.match(h.app.innerHTML, /<strong>Renamed account box<\/strong>/);
    assert.match(h.app.innerHTML, /CentaurOS-Setup-0102 · 蓝牙配网/);
    assert.equal(h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1], candidateId);
    assert.equal(h.calls.filter(([name]) => name === "wanx:setup:begin" || name === "nexusaos:discovery:select").length, 0);
  });
}

test("discovery escapes public names and broadcast hints and stops claiming to read after timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = await harness(state(), [application], t);
  await h.click("provisioning");
  await h.click("start-provisioning");
  await new Promise((resolve) => setImmediate(resolve));
  h.advertisement({ deviceId: "provider-1", advertisedName: '<img src=x onerror="bad()">', displayIdentity: { deviceId: "box-new", displayName: "<script>bad()</script>" } });
  assert.match(h.app.innerHTML, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(h.app.innerHTML, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt; · 蓝牙配网/);
  assert.doesNotMatch(h.app.innerHTML, /<script>bad|<img src=x/);
  h.advertisement({ deviceId: "provider-1", advertisedName: "CentaurOS-Setup-2222", displayIdentity: null });
  assert.match(h.app.innerHTML, /正在读取盒子名称/);
  t.mock.timers.tick(12000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.app.innerHTML, /未读取到名称 · 蓝牙配网/);
  assert.doesNotMatch(h.app.innerHTML, /正在读取盒子名称/);
});


test("box ownership UI is owner-only and explicitly retains data", async () => {
  const initial = state();
  initial.devices = initial.devices.map((item, index) => ({ ...item, deviceRole: index ? "member" : "owner" }));
  const h = await harness(initial);
  await h.click("show-boxes");
  assert.equal((h.app.innerHTML.match(/data-action="transfer-open"/g) || []).length, 1);
  await h.click("transfer-open", { deviceId: "box-102" });
  assert.match(h.app.innerHTML, /客户万象账号手机号/);
  assert.match(h.app.innerHTML, /我同意保留盒内数据并转移所有权/);
  assert.match(h.app.innerHTML, /需要清空交付时/);
  assert.deepEqual(h.calls.filter(item => item[0] === "scroll-form"), [["scroll-form", "transfer", "center"]]);
  assert.equal(h.calls.filter(item => item[0] === "focus-transfer-phone").length, 1);
  h.update(initial);
  assert.equal(h.calls.filter(item => item[0] === "scroll-form").length, 1, "background refresh must not scroll again");
  assert.equal(h.calls.filter(item => item[0] === "focus-transfer-phone").length, 1, "background refresh must not steal focus");
});

test("recipient explicitly confirms incoming ownership without a connected box", async () => {
  const incoming = { transferId: "t-1", deviceId: "customer-box", direction: "incoming", state: "pending_target", retainData: true, expiresAt: "2099-01-01T00:00:00Z" };
  const h = await harness(state(), [], { transfers: async () => [incoming] });
  await h.click("show-boxes");
  await h.click("transfer-refresh");
  assert.match(h.app.innerHTML, /待你接受/);
  await h.click("transfer-accept", { transferId: "t-1" });
  assert.match(h.app.innerHTML, /接受盒子所有权/);
  assert.equal(h.calls.some(item => item[0] === "ownership-accepted"), false);
  await h.click("market-confirm");
  assert.equal(h.calls.filter(item => item[0] === "ownership-accepted").length, 1);
  assert.match(h.app.innerHTML, /已接受所有权/);
});

test("stale incoming invitations cannot reappear after switching account", async () => {
  let release;
  const late = new Promise(resolve => { release = resolve; });
  const h = await harness(state(), [], { transfers: () => late });
  await h.click("show-boxes");
  h.update({ account: { phase: "signed_out" } });
  const other = state(); other.account.accountId = "other-account";
  h.update(other);
  release([{ transferId: "t-old", deviceId: "private-box", direction: "incoming", state: "pending_target", retainData: true, expiresAt: "2099-01-01T00:00:00Z" }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(h.app.innerHTML, /private-box/);
});

test("post-transfer refresh supersedes an in-flight list request", async () => {
  const late = pendingResponse();
  let requests = 0;
  const invitation = { transferId: "t-new", deviceId: "new-customer-box", direction: "outgoing", state: "pending_target", retainData: true, expiresAt: "2099-01-01T00:00:00Z" };
  const initial = state(); initial.devices[0] = { ...initial.devices[0], deviceRole: "owner" };
  const h = await harness(initial, [], { transfers: () => ++requests === 1 ? late.promise : Promise.resolve([invitation]) });
  await h.click("show-boxes");
  await h.click("transfer-open", { deviceId: "box-102" });
  await h.submit("transfer", { targetPhone: "13900139000", verificationCode: "012345", retainData: "on" });
  assert.equal(requests, 2, "a committed mutation must fetch fresh data instead of joining the old request");
  assert.match(h.app.innerHTML, /new-customer-box/);
  late.resolve([]);
  await flushActions();
  assert.match(h.app.innerHTML, /new-customer-box/);
  assert.doesNotMatch(actionButton(h, "transfer-refresh"), /disabled|正在刷新/);
});

test("revoked recipient client explains reauthentication instead of reporting transfer success", async () => {
  const incoming = { transferId: "t-1", deviceId: "customer-box", direction: "incoming", state: "pending_target", retainData: true, expiresAt: "2099-01-01T00:00:00Z" };
  const h = await harness(state(), [], { transfers: async () => [incoming], acceptFailure: "OWNERSHIP_CLIENT_INACTIVE" });
  await h.click("show-boxes");
  await h.click("transfer-refresh");
  await h.click("transfer-accept", { transferId: "t-1" });
  await h.click("market-confirm");
  assert.match(h.app.innerHTML, /当前客户端登录已失效，请重新登录万象后再接受转移/);
  assert.doesNotMatch(h.app.innerHTML, /已接受所有权/);
});


const flushWifi = () => new Promise(resolve => setImmediate(resolve));
const wifiChoice = network => JSON.stringify([network.ssid, network.security]);
const officeWifi = { ssid: "Office", signal: 90, security: "wpa_personal" };

test("Wi-Fi picker automatically scans the box once, sorts by signal and escapes names", async () => {
  const h = await harness(state(), [application], { scanWifi: async () => [
    { ssid: '<unsafe>"', signal: 10, security: "unsupported" }, officeWifi,
    { ssid: "Guest", signal: 50, security: "open" },
  ] });
  await h.click("provisioning");
  h.setup({ state: "awaitingWifi", pairingSessionId: "session-1" });
  await flushWifi();
  const form = h.form("wifi"), picker = form.querySelector('[data-input="wifi-network"]');
  assert.ok(picker.innerHTML.indexOf("Office") < picker.innerHTML.indexOf("Guest"));
  assert.ok(picker.innerHTML.indexOf("Guest") < picker.innerHTML.indexOf("&lt;unsafe&gt;"));
  assert.match(picker.innerHTML, /disabled[^>]*>.*暂不支持此安全类型/);
  assert.match(form.querySelector('[data-wifi-status]').textContent, /来自盒子附近/);
  h.setup({ state: "awaitingWifi", pairingSessionId: "session-1" });
  await flushWifi();
  assert.equal(h.calls.filter(([name]) => name === "scan-wifi").length, 1);
  h.changeWifi(wifiChoice(officeWifi));
  assert.equal(form.values.ssid, "Office");
  assert.equal(form.values.security, "wpa_personal");
  assert.equal(form.querySelector('[name="password"]').required, true);
  form.values.password = "existing-password";
  h.changeWifi(wifiChoice({ ssid: "Guest", security: "open" }));
  assert.equal(form.values.security, "open");
  assert.equal(form.values.password, "");
  assert.equal(form.querySelector('[name="password"]').disabled, true);
  h.changeWifi(wifiChoice({ ssid: '<unsafe>"', security: "unsupported" }));
  assert.equal(form.values.ssid, "Guest", "unsupported networks must not become selected");
  await h.submit("wifi", form.values);
  const [, submitted] = h.calls.find(([name]) => name === "wanx:setup:wifi");
  assert.equal(submitted.ssid, "Guest");
  assert.equal(submitted.security, "open");
  assert.equal(Object.hasOwn(submitted, "password"), false);
});

test("Wi-Fi refresh deduplicates requests and preserves password and selection through empty/error results", async () => {
  let resolveScan, rejectScan, initial = true;
  const h = await harness(state(), [application], { scanWifi: () => initial ? (initial = false, Promise.resolve([officeWifi])) : new Promise((resolve, reject) => { resolveScan = resolve; rejectScan = reject; }) });
  await h.click("provisioning");
  h.setup({ state: "awaitingWifi" });
  await flushWifi();
  const form = h.form("wifi");
  h.changeWifi(wifiChoice(officeWifi)); form.values.password = "typed-secret";
  const refreshing = h.click("wifi-refresh"), duplicate = h.click("wifi-refresh");
  await flushWifi();
  assert.equal(h.calls.filter(([name]) => name === "scan-wifi").length, 2);
  assert.match(form.querySelector('[data-wifi-status]').textContent, /正在扫描/);
  resolveScan([]); await Promise.all([refreshing, duplicate]);
  assert.equal(form.values.password, "typed-secret");
  assert.equal(form.querySelector('[data-input="wifi-network"]').value, wifiChoice(officeWifi));
  assert.match(form.querySelector('[data-wifi-status]').textContent, /未发现/);
  const failing = h.click("wifi-refresh"); await flushWifi(); rejectScan(new Error("radio")); await failing;
  assert.equal(h.form("wifi"), form);
  assert.equal(form.values.password, "typed-secret");
  assert.match(form.querySelector('[data-wifi-status]').textContent, /无法扫描/);
  await h.click("wifi-manual");
  assert.equal(form.querySelector('[data-wifi-list]').hidden, true);
  assert.equal(form.querySelector('[name="ssid"]').closest("label").hidden, false);
  assert.equal(form.values.password, "typed-secret");
  h.changeSecurity("open");
  assert.equal(form.querySelector('[name="password"]').required, false);
});

test("a late Wi-Fi scan cannot overwrite a new pairing session", async () => {
  const completions = [];
  const h = await harness(state(), [application], { scanWifi: () => new Promise(resolve => completions.push(resolve)) });
  await h.click("provisioning"); h.setup({ state: "awaitingWifi", pairingSessionId: "old" }); await flushWifi();
  h.form("wifi").values.password = "old-secret";
  h.setup({ state: "awaitingWifi", pairingSessionId: "new" }); await flushWifi();
  assert.equal(h.form("wifi").values.password, "");
  completions[1]([officeWifi]); await flushWifi();
  completions[0]([{ ssid: "Old secret network", security: "open", signal: 99 }]); await flushWifi();
  const options = h.form("wifi").querySelector('[data-input="wifi-network"]').innerHTML;
  assert.match(options, /Office/); assert.doesNotMatch(options, /Old secret/);
});

for (const action of ["cancel-provisioning", "logout", "back-devices"]) test(`leaving Wi-Fi through ${action} clears secrets and ignores scan completion`, async () => {
  let complete;
  const h = await harness(state(), [application], { scanWifi: () => new Promise(resolve => { complete = resolve; }) });
  await h.click("provisioning"); h.setup({ state: "awaitingWifi", pairingSessionId: "old" }); await flushWifi();
  const form = h.form("wifi"); form.values.password = "old-secret";
  await h.click(action);
  assert.equal(form.values.password, "");
  assert.equal(h.form("wifi"), undefined);
  const renderCount = h.renderCount;
  complete([officeWifi]); await flushWifi();
  assert.equal(h.renderCount, renderCount);
  assert.equal(h.calls.filter(([name]) => name === "scan-wifi").length, 1);
});


function pendingResponse() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flushActions = () => new Promise(resolve => setImmediate(resolve));
const actionButton = (h, action) => h.app.innerHTML.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>[\\s\\S]*?</button>`))?.[0];

for (const fails of [false, true]) test(`identity loading prevents another scan and recovers after ${fails ? "failure" : "success"}`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const begin = pendingResponse();
  const h = await harness(state(), [], { after: t.after.bind(t), setupRequest: name => name === "wanx:setup:begin" ? begin.promise : undefined });
  await h.click("provisioning"); await h.click("start-provisioning"); await flushActions();
  const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
  await h.click("select-candidate", { candidateId }); await flushActions();
  const chooser = h.chooser();
  await h.click("start-provisioning"); await flushActions();
  assert.equal(h.chooser(), chooser, "identity loading must not start another Bluetooth chooser");
  assert.match(h.app.innerHTML, /正在读取设备身份/);
  assert.ok(!actionButton(h, "start-provisioning") || /disabled/.test(actionButton(h, "start-provisioning")));
  if (fails) begin.reject(new Error("LOCAL_CONNECT_TIMEOUT"));
  else begin.resolve({ state: "previewReady" });
  await flushActions();
  assert.doesNotMatch(h.app.innerHTML, /正在读取设备身份/);
  if (fails) {
    assert.match(h.app.innerHTML, /蓝牙连接|连接盒子超时/);
    assert.doesNotMatch(actionButton(h, "start-provisioning"), /disabled/);
    assert.match(actionButton(h, "start-provisioning"), /开始扫描盒子/);
  } else assert.match(h.app.innerHTML, /确认设备身份/);
});

for (const fails of [false, true]) test(`setup cancellation deduplicates clicks and recovers after ${fails ? "failure" : "success"}`, async () => {
  const cancel = pendingResponse();
  const h = await harness(state(), [], { setupRequest: name => name === "wanx:setup:cancel" ? cancel.promise : undefined });
  await h.click("provisioning"); h.setup({ state: "provisioningWifi" });
  const first = h.click("cancel-provisioning");
  const second = h.click("cancel-provisioning");
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:cancel").length, 1);
  assert.match(actionButton(h, "cancel-provisioning"), /disabled/);
  assert.match(actionButton(h, "cancel-provisioning"), /正在取消/);
  if (fails) cancel.reject(new Error("LOCAL_TRANSPORT_DISCONNECTED"));
  else cancel.resolve({ state: "cancelled" });
  await Promise.all([first, second]);
  assert.doesNotMatch(h.app.innerHTML, /正在取消/);
  if (fails) assert.doesNotMatch(actionButton(h, "cancel-provisioning"), /disabled/);
  else assert.doesNotMatch(actionButton(h, "start-provisioning"), /disabled/);
});

for (const cancelFirst of [false, true]) test(`cancelled setup ignores the original result when cancellation finishes ${cancelFirst ? "first" : "last"}`, async () => {
  const confirm = pendingResponse(), cancel = pendingResponse();
  const h = await harness(state(), [], { setupRequest: name => name === "wanx:setup:confirmPhysical" ? confirm.promise : name === "wanx:setup:cancel" ? cancel.promise : undefined });
  await h.click("provisioning"); h.setup({ state: "previewReady" });
  const original = h.click("provisioning-confirm");
  const cancellation = h.click("cancel-provisioning");
  if (cancelFirst) { cancel.resolve({ state: "cancelled" }); await cancellation; }
  confirm.resolve({ state: "awaitingWifi" }); await original;
  if (!cancelFirst) {
    assert.match(actionButton(h, "cancel-provisioning"), /disabled/);
    assert.match(actionButton(h, "cancel-provisioning"), /正在取消/);
    cancel.resolve({ state: "cancelled" }); await cancellation;
  }
  assert.match(h.app.innerHTML, /本次配网已取消/);
  assert.doesNotMatch(h.app.innerHTML, /data-form="wifi"/);
  assert.doesNotMatch(actionButton(h, "start-provisioning"), /disabled/);
});

for (const fails of [false, true]) test(`authorization refresh shows pending feedback and restores retry after ${fails ? "failure" : "success"}`, async () => {
  const refresh = pendingResponse();
  const h = await harness(state(), [], { setupRequest: name => name === "wanx:setup:refresh" ? refresh.promise : undefined });
  await h.click("provisioning"); h.setup({ state: "attentionRequired" });
  const first = h.click("provisioning-refresh");
  const second = h.click("provisioning-refresh");
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:refresh").length, 1);
  assert.match(actionButton(h, "provisioning-refresh"), /disabled/);
  assert.match(actionButton(h, "provisioning-refresh"), /正在刷新/);
  if (fails) refresh.reject(new Error("LOCAL_TRANSPORT_DISCONNECTED"));
  else refresh.resolve({ state: "attentionRequired" });
  await Promise.all([first, second]);
  assert.doesNotMatch(actionButton(h, "provisioning-refresh"), /disabled|正在刷新/);
});

for (const fails of [false, true]) test(`transfer refresh deduplicates pending requests and allows retry after ${fails ? "failure" : "success"}`, async () => {
  const refresh = pendingResponse();
  let requests = 0;
  const h = await harness(state(), [], { transfers: () => ++requests === 2 ? refresh.promise : [] });
  await h.click("show-boxes"); await flushActions();
  const first = h.click("transfer-refresh");
  const second = h.click("transfer-refresh");
  assert.equal(requests, 2, "two clicks should add only one request after the initial load");
  assert.match(actionButton(h, "transfer-refresh"), /disabled/);
  assert.match(actionButton(h, "transfer-refresh"), /正在刷新/);
  if (fails) refresh.reject(new Error("offline")); else refresh.resolve([]);
  await Promise.all([first, second]);
  assert.doesNotMatch(actionButton(h, "transfer-refresh"), /disabled|正在刷新/);
  if (fails) assert.match(h.app.innerHTML, /转移记录暂时无法加载/);
  await h.click("transfer-refresh");
  assert.equal(requests, 3);
  assert.doesNotMatch(h.app.innerHTML, /转移记录暂时无法加载/);
});


test("account changes release transfer loading without letting old completion unlock the new refresh", async () => {
  const old = pendingResponse(), current = pendingResponse();
  let requests = 0;
  const h = await harness(state(), [], { transfers: () => ++requests === 1 ? old.promise : current.promise });
  await h.click("show-boxes");
  h.update({ account: { phase: "signed_out" } });
  const next = state(); next.account.accountId = "account-2";
  h.update(next); await flushActions();
  await h.click("show-boxes");
  assert.equal(requests, 2);
  old.resolve([{ transferId: "old", deviceId: "old-private-box", state: "pending_target", expiresAt: "2099-01-01", retainData: true }]);
  await flushActions();
  assert.match(actionButton(h, "transfer-refresh"), /disabled/);
  assert.doesNotMatch(h.app.innerHTML, /old-private-box/);
  current.resolve([]); await flushActions();
  assert.doesNotMatch(actionButton(h, "transfer-refresh"), /disabled/);
});

test("a cancelled identity request cannot show its late failure or unlock a new setup action", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const begin = pendingResponse(), refresh = pendingResponse();
  const h = await harness(state(), [], { after: t.after.bind(t), setupRequest: name => name === "wanx:setup:begin" ? begin.promise : name === "wanx:setup:refresh" ? refresh.promise : name === "wanx:setup:cancel" ? { state: "cancelled" } : undefined });
  await h.click("provisioning"); await h.click("start-provisioning"); await flushActions();
  const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
  await h.click("select-candidate", { candidateId }); await flushActions();
  await h.click("cancel-provisioning");
  assert.match(h.app.innerHTML, /本次配网已取消/);
  h.setup({ state: "attentionRequired" });
  const refreshing = h.click("provisioning-refresh");
  begin.reject(new Error("LOCAL_CONNECT_TIMEOUT")); await flushActions();
  assert.match(actionButton(h, "provisioning-refresh"), /disabled/);
  assert.doesNotMatch(h.app.innerHTML, /连接盒子超时/);
  refresh.resolve({ state: "attentionRequired" }); await refreshing;
  assert.doesNotMatch(actionButton(h, "provisioning-refresh"), /disabled/);
});

test("an old setup completion cannot change the next account's setup state", async () => {
  const refresh = pendingResponse();
  const h = await harness(state(), [], { setupRequest: name => name === "wanx:setup:refresh" ? refresh.promise : undefined });
  await h.click("provisioning"); h.setup({ state: "attentionRequired" });
  const pending = h.click("provisioning-refresh");
  h.update({ account: { phase: "signed_out" } });
  const next = state(); next.account.accountId = "account-2";
  h.update(next); await flushActions();
  await h.click("provisioning");
  refresh.resolve({ state: "completed" }); await pending;
  assert.match(h.app.innerHTML, /发现附近的万象盒子/);
  assert.doesNotMatch(h.app.innerHTML, /设备已完成联网和账号绑定/);
  assert.doesNotMatch(actionButton(h, "start-provisioning"), /disabled/);
});


test("logout unlocks the login form and its late completion cannot unlock a new login", async () => {
  const logout = pendingResponse(), login = pendingResponse();
  const h = await harness(state(), [], { logoutRequest: () => logout.promise, loginRequest: () => login.promise });
  await h.click("show-settings");
  const loggingOut = h.click("logout");
  await flushActions();
  assert.match(h.app.innerHTML, /登录万象平台/);
  assert.doesNotMatch(h.app.innerHTML, /处理中…/);
  assert.equal(h.form("auth").querySelector('button[type="submit"]').disabled, false);
  const loggingIn = h.submit("auth", { username: "13800000000", password: "example-password" });
  await flushActions();
  assert.match(h.app.innerHTML, /正在完成退出…/);
  logout.resolve(); await loggingOut;
  assert.equal(h.form("auth").querySelector('button[type="submit"]').disabled, true);
  login.resolve(); await loggingIn;
  assert.match(h.app.innerHTML, /我的应用/);
});


for (const [status, message] of [["checking", "正在检查电脑蓝牙状态"], ["unavailable", "请先开启蓝牙"], ["permission-denied", "允许万象访问蓝牙"], ["unsupported", "不支持蓝牙发现"], ["error", "无法读取电脑蓝牙状态"]]) {
  test(`Bluetooth ${status} blocks scanning and offers the appropriate guidance`, async () => {
    const h = await harness(state(), [], { setupRequest: async () => ({ state: "idle" }), bluetoothStatus: status });
    await h.click("provisioning");
    assert.ok(h.app.innerHTML.includes(message));
    assert.match(actionButton(h, "start-provisioning"), /disabled/);
    await h.click("start-provisioning");
    assert.ok(!h.chooser());
    h.bluetooth("available");
    assert.doesNotMatch(actionButton(h, "start-provisioning"), /disabled/);
    assert.doesNotMatch(h.app.innerHTML, /bluetooth-notice/);
  });
}


test("forgot-password validates, uses recovery IPC and returns to a fresh login form", async () => {
  const h = await harness({ account: { phase: "signed_out" } });
  await h.click("auth-reset");
  assert.match(h.app.innerHTML, /找回密码/);
  const values = { username: "13800138000", password: "new-password", confirmPassword: "mismatch", code: "123456" };
  await h.submit("auth", values);
  assert.match(h.app.innerHTML, /两次输入的密码不一致/);
  assert.equal(h.calls.filter(([name]) => name === "wanx-client:reset-password").length, 0);
  h.form("auth").values = values;
  await h.click("send-reset-code");
  await h.click("send-reset-code");
  assert.equal(h.calls.filter(([name]) => name === "wanx-client:send-reset-code").length, 1);
  await h.submit("auth", { ...values, confirmPassword: values.password });
  assert.deepEqual(structuredClone(h.calls.find(([name]) => name === "wanx-client:reset-password")[1]), { phone: values.username, password: values.password, code: values.code });
  assert.match(h.app.innerHTML, /密码重置成功，请使用新密码登录/);
  assert.doesNotMatch(h.app.innerHTML, /name="confirmPassword"|name="code"/);
  assert.equal(h.form("auth").values.password, undefined);
});

test("settings password change keeps failed form and signs out on successful retry", async () => {
  let failed = true;
  const h = await harness({ ...state(), account: { phase: "authenticated", accountId: "account-1", maskedPhone: "138****8000" } }, [], {
    passwordRequest: async () => { if (failed) throw Error("SMS_CODE_INVALID"); },
  });
  await h.click("show-settings");
  await h.click("password-open");
  assert.match(h.app.innerHTML, /138\*\*\*\*8000/);
  assert.doesNotMatch(h.app.innerHTML, /name="username"/);
  await h.click("send-change-code");
  const form = h.form("password-change");
  const values = { password: "changed-password", confirmPassword: "changed-password", code: "123456" };
  form.values = values;
  h.update(state());
  assert.equal(h.form("password-change"), form);
  await h.submit("password-change", values);
  assert.match(h.app.innerHTML, /验证码错误或已过期/);
  assert.equal(h.form("password-change"), form);
  assert.equal(form.querySelector('button[type="submit"]').disabled, false);
  failed = false;
  await h.submit("password-change", values);
  assert.match(h.app.innerHTML, /密码修改成功，请使用新密码重新登录/);
  assert.equal(h.form("password-change"), undefined);
  assert.equal(h.form("auth").querySelector('button[type="submit"]').disabled, false);
  assert.deepEqual(structuredClone(h.calls.find(([name]) => name === "wanx-client:change-password")[1]), { password: values.password, code: values.code });
});

test("pending password change prevents duplicate submission and recovers after network failure", async () => {
  const pending = pendingResponse();
  const h = await harness(state(), [], { passwordRequest: () => pending.promise });
  await h.click("show-settings"); await h.click("password-open");
  const values = { password: "changed-password", confirmPassword: "changed-password", code: "123456" };
  const first = h.submit("password-change", values);
  await h.submit("password-change", values);
  assert.equal(h.form("password-change").querySelector('button[type="submit"]').disabled, true);
  assert.equal(h.calls.filter(([name]) => name === "wanx-client:change-password").length, 1);
  pending.reject(Error("ACCOUNT_NETWORK_ERROR"));
  await first;
  assert.match(h.app.innerHTML, /请检查网络后重试/);
  assert.equal(h.form("password-change").querySelector('button[type="submit"]').disabled, false);
});


test("password change reports missing fields inline without sending a request", async () => {
  const h = await harness();
  await h.click("show-settings"); await h.click("password-open");
  assert.match(h.app.innerHTML, /data-form="password-change" novalidate/);
  for (const [values, expected] of [
    [{}, "请输入新密码"],
    [{ password: "changed-password" }, "请再次输入新密码"],
    [{ password: "changed-password", confirmPassword: "changed-password" }, "请输入 6 位短信验证码"],
    [{ password: "changed-password", confirmPassword: "changed-password", code: "123" }, "请输入 6 位短信验证码"],
  ]) {
    await h.submit("password-change", values);
    const notice = h.form("password-change").querySelector('[data-password-notice]');
    assert.equal(notice.textContent, expected);
    assert.equal(notice.hidden, false);
    assert.equal(h.form("password-change").querySelector('button[type="submit"]').disabled, false);
  }
  assert.equal(h.calls.filter(([name]) => name === "wanx-client:change-password").length, 0);
});


test("an existing box awaiting authorization explains synchronization then enables connection on ready", async () => {
  const pendingBox = { ...devices[0], accessState: "authorization_pending", canOpen: false };
  const h = await harness({ ...state(), devices: [pendingBox] });
  await h.click("applications-launch", { applicationId: application.applicationId });
  await h.click("show-boxes");
  assert.match(h.app.innerHTML, /正在同步盒子访问权限/);
  assert.match(h.app.innerHTML, /正在同步访问权限/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="pending-confirm"|data-action="connect"/);
  h.update({ ...state(), devices: [devices[0]] });
  assert.doesNotMatch(h.app.innerHTML, /正在同步.*访问权限/);
  assert.match(h.app.innerHTML, /data-action="pending-confirm"/);
  assert.match(h.app.innerHTML, /data-action="connect"/);
});


test("login rate limiting shows a specific message and releases the login button", async () => {
  const h = await harness({ account: { phase: "signed_out" } }, [], { loginFailure: "AUTH_RATE_LIMITED" });
  await h.submit("auth", { username: "13800138000", password: "valid-password" });
  assert.match(h.app.innerHTML, /登录失败次数过多，已被暂时限制/);
  assert.doesNotMatch(h.app.innerHTML, /账号服务暂时不可用/);
  assert.equal(h.form("auth").querySelector('button[type="submit"]').disabled, false);
});


test("recovery reports missing and malformed SMS codes next to submit without a request", async () => {
  const h = await harness({ account: { phase: "signed_out" } });
  await h.click("auth-reset");
  assert.match(h.app.innerHTML, /data-mode="reset" novalidate/);
  for (const code of ["", "123", "abcdef"]) {
    await h.submit("auth", { username: "13800138000", password: "valid-password", confirmPassword: "valid-password", code });
    const notice = h.form("auth").querySelector('[data-auth-notice]');
    assert.equal(notice.textContent, "请输入 6 位短信验证码");
    assert.equal(notice.hidden, false);
    assert.equal(h.form("auth").querySelector('button[type="submit"]').disabled, false);
  }
  assert.equal(h.calls.filter(([name]) => name === "wanx-client:reset-password").length, 0);
});

test("empty login password is explained inline without submitting", async () => {
  const h = await harness({ account: { phase: "signed_out" } });
  await h.submit("auth", { username: "13800138000", password: "" });
  assert.equal(h.form("auth").querySelector('[data-auth-notice]').textContent, "请输入密码");
  assert.equal(h.calls.filter(([name]) => name === "wanx-client:login-password").length, 0);
});


test("nearby owner Wi-Fi entry preserves the opaque selection and requests only wifi mode", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const deviceId = discoveryId(79);
  const h = await harness({ ...state(), devices: [{ deviceId, name: "我的盒子", deviceRole: "owner" }] }, [application], t);
  await startDiscovery(h);
  discoveryIdentity(h, deviceId);
  await settleDiscovery();
  assert.match(h.app.innerHTML, /data-action="select-candidate-wifi"/);
  const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
  await h.click("select-candidate-wifi", { candidateId });
  await settleDiscovery();
  assert.equal(h.calls.find(([name]) => name === "nexusaos:discovery:select")[1].candidateId, candidateId);
  const selected = h.calls.find(([name]) => name === "wanx:setup:begin")[1];
  assert.equal(selected.mode, "wifi");
  assert.ok(selected.transportHandle);
  assert.equal(selected.deviceId, undefined);
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:confirmOwnership").length, 0);
});

for (const role of ["member", "unknown", undefined]) test(`nearby ${role} cannot request owner Wi-Fi mode`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const deviceId = discoveryId(79);
  const h = await harness({ ...state(), devices: [{ deviceId, deviceRole: role }] }, [application], t);
  await startDiscovery(h);
  discoveryIdentity(h, deviceId);
  await settleDiscovery();
  assert.doesNotMatch(h.app.innerHTML, /data-action="select-candidate-wifi"/);
  const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
  await h.click("select-candidate-wifi", { candidateId });
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:begin" || name === "nexusaos:discovery:select").length, 0);
});

test("retained owner Wi-Fi selection keeps wifi mode and ignores repeat clicks", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const deviceId = discoveryId(79);
  const h = await harness({ ...state(), devices: [{ deviceId, name: "我的盒子", deviceRole: "owner" }] }, [application], t);
  await startDiscovery(h);
  discoveryIdentity(h, deviceId);
  await settleDiscovery();
  const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
  t.mock.timers.tick(12000);
  await settleDiscovery();
  assert.match(h.app.innerHTML, /扫描已结束/);
  await h.click("select-candidate-wifi", { candidateId });
  await h.click("select-candidate-wifi", { candidateId });
  await settleDiscovery();
  assert.ok(h.calls.some(([name]) => name === "nexusaos:discovery:reselect"));
  const starts = h.calls.filter(([name]) => name === "wanx:setup:begin");
  assert.equal(starts.length, 1);
  assert.equal(starts[0][1].mode, "wifi");
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:confirmOwnership").length, 0);
});

test("owner Wi-Fi flow ignores the initial-claim window and never shows binding controls or success", async () => {
  const h = await harness();
  await h.click("provisioning");
  const mode = "wifi";
  h.setup({ state: "previewReady", mode, preview: { device_id: "box-102", display_name: "我的盒子",
    cloud_enrollment_status: "ready", pairing_mode_remaining_seconds: 0 } });
  assert.match(h.app.innerHTML, /修改 Wi-Fi/);
  assert.doesNotMatch(actionButton(h, "provisioning-confirm"), /disabled/);
  assert.doesNotMatch(h.app.innerHTML, /认领设备|初始化盒端|首次配网/);
  h.setup({ state: "awaitingWifi", mode });
  await flushWifi();
  assert.match(h.app.innerHTML, /连接 Wi-Fi/);
  assert.match(h.app.innerHTML, /认领关系和盒子数据将保留/);
  assert.doesNotMatch(h.app.innerHTML, /继续绑定账号|确认绑定到当前账号/);
  h.setup({ state: "completed", mode });
  assert.match(h.app.innerHTML, /Wi-Fi 配置成功/);
  assert.doesNotMatch(h.app.innerHTML, /设备已完成联网和账号绑定/);
});

test("expired setup sessions offer a new scan without requiring a deployment window", async () => {
  const h = await harness(state(), [application], { setupRequest: async () => ({ state: "idle" }) });
  await h.click("provisioning");
  h.setup({ state: "restartRequired", errorCode: "PAIRING_EXPIRED" });
  assert.match(h.app.innerHTML, /本次配网会话已超时，请重新扫描并重试/);
  assert.doesNotMatch(actionButton(h, "start-provisioning"), /disabled/);
  assert.doesNotMatch(h.app.innerHTML, /联系设备提供方|开启配网窗口/);
});

test("avatar menu owns profile and settings; credits is a primary tab", async () => {
  const initial = state();
  initial.account = { ...initial.account, maskedPhone: "138****8000", profile: { displayName: '<小万>', avatarDataUrl: null } };
  const h = await harness(initial);
  const header = h.app.innerHTML.match(/<header[\s\S]*?<\/header>/)[0];
  assert.match(header, /data-action="show-credits"/);
  assert.doesNotMatch(header, /data-action="show-settings"/);
  await h.click("profile-menu");
  assert.match(h.app.innerHTML, /&lt;小万&gt;/);
  assert.match(h.app.innerHTML, /138\*\*\*\*8000/);
  assert.match(h.app.innerHTML, /data-action="show-settings"/);
  h.keydown("Escape");
  assert.doesNotMatch(h.app.innerHTML, /id="profile-menu"/);
  await h.click("profile-menu"); await h.click("show-profile");
  assert.match(h.app.innerHTML, /data-form="profile"/);
  assert.match(h.app.innerHTML, /仅保存在这台电脑/);
  assert.match(h.app.innerHTML, /data-action="profile-avatar"/);
  const form = h.form("profile"); form.values.displayName = "正在编辑";
  h.update({ ...initial, phase: "connecting" });
  assert.equal(h.form("profile"), form);
  assert.equal(h.form("profile").values.displayName, "正在编辑");
  await h.click("profile-menu");
  h.update({ ...initial, account: { phase: "authenticated", accountId: "different" } });
  assert.doesNotMatch(h.app.innerHTML, /&lt;小万&gt;|138\*\*\*\*8000|正在编辑|id="profile-menu"/);
});

test("profile save and avatar picker use trusted IPC without accepting a renderer path", async () => {
  const updates = [];
  const h = await harness(state(), undefined, { accountProfile: {
    save: input => { updates.push(input); return { displayName: input.displayName }; },
    chooseAvatar: input => { assert.equal(input, undefined); return { canceled: true }; },
    removeAvatar: () => ({ avatarDataUrl: null }),
  } });
  await h.click("show-profile");
  await h.submit("profile", { displayName: "  我的昵称  ", avatarDataUrl: "file:///secret", accountId: "other" });
  assert.deepEqual(JSON.parse(JSON.stringify(updates)), [{ displayName: "我的昵称" }]);
  assert.match(h.app.innerHTML, /资料已保存在这台电脑/);
  await h.click("profile-avatar", { path: "/secret" });
  assert.ok(h.calls.some(([name]) => name === "wanx-client:profile-avatar"));
  const response = await h.window.wanxClient.action("profile.save", { displayName: "用户", avatarDataUrl: "evil" });
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(updates.at(-1))), { displayName: "用户" });
});

test("credits entry opens a read-only account ledger with real IPC data", async () => {
  const h = await harness(state(), [application], { credits: {
    balance: async () => ({ available: 1250, held: 40, paid_available: 1000, gift_available: 250 }),
    transactions: async () => ({ items: [], after: 0, hasMore: false }),
  } });
  assert.match(h.app.innerHTML, /1,250 点/);
  await h.click("show-credits");
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.app.innerHTML, /我的积分/);
  assert.match(h.app.innerHTML, /disabled>充值 · 暂未开放/);
  assert.match(h.app.innerHTML, /还没有积分记录/);
});

for (const phase of ['waitingCloud', 'attentionRequired']) {
  for (const claimState of [undefined, 'waitingAppProof', 'waitingDeviceProof', 'ownershipCommitted', 'projectionPending', 'deviceAckPending']) {
    test(`claim wizard ${phase}/${claimState} marks only confirmed stages complete`, async () => {
      const h = await harness(state());
      await h.click('provisioning');
      h.setup({ state: phase, ...(claimState ? { claimState } : {}) });
      const steps = [...h.app.innerHTML.matchAll(/<div class="wizard-step ([^"]*)"><span>([^<]+)<\/span><label>([^<]+)<\/label>/g)];
      const claim = steps.find(step => step[3] === '认领设备');
      const initialize = steps.find(step => step[3] === '初始化盒端');
      assert.ok(claim && initialize);
      assert.equal(claim[1].includes('done'), claimState === 'deviceAckPending');
      assert.equal(initialize[1].includes('active'), claimState === 'deviceAckPending');
      if (claimState === 'waitingDeviceProof') {
        assert.match(h.app.innerHTML, /等待盒子提交认领证明/);
        assert.doesNotMatch(h.app.innerHTML, /盒子授权尚未完成/);
      }
    });
  }
}
