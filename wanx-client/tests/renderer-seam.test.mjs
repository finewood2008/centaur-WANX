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
        const form = { dataset: { mode: value.match(/data-mode="([^"]+)"/)?.[1] }, values: {}, contains: () => false,
          querySelector: () => submit,
          replaceWith: (retained) => forms.set(name, retained),
        };
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
    loginPassword: async () => { if (options.loginFailure) throw new Error(options.loginFailure); rawState = state("enrolling", "checking"); notify(); },
    logout: async () => { rawState = { account: { phase: "signed_out" } }; notify(); },
    connectBox: async (deviceId) => { rawState = state("ready", "ready", deviceId); notify(); },
    disconnect: async () => { rawState = state(); notify(); },
    refreshDevices: async () => {},
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
    applications, uiState, getState: snapshot, publishState: publish,
  });
  const window = {};
  vm.runInNewContext(preload, { require: () => ({
    contextBridge: { exposeInMainWorld: (name, api) => { window[name] = api; } },
    ipcRenderer: {
      invoke: async (name, input) => {
        calls.push([name, input]);
        if (name.startsWith("wanx:setup:")) return { ok: true, value: { state: name === "wanx:setup:begin" ? "previewReady" : "idle" } };
        return handlers.get(name)({ sender: contents, senderFrame: frame }, input);
      },
      on: (name, listener) => listeners.set(name, listener), removeListener() {},
      send(name, payload) { calls.push([name, payload]); ipcMain.emit(name, ipcEvent, payload); },
    },
  }) });
  let advertisementListener;
  let chooser, nearby = [{ deviceId: "provider-1", deviceName: "Test box" }];
  if (discoveryTest) {
    const clock = { monotonicMs: () => Date.now() };
    discoveryTest.after(installElectronBluetoothPicker({ webContents: contents, ipcMain, documentUrl: controlURL, clock, scanTimeoutMs: 12000, advertisementNames: { subscribe: (listener) => { advertisementListener = listener; return () => { advertisementListener = undefined; }; } } }));
    const bluetooth = {
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
    setTimeout, clearTimeout,
    document: { querySelector: (selector) => selector === "#app" ? app : null },
    FormData: class { constructor(form) { return Object.entries(form.values || {}); } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  if (discoveryTest) {
    listeners.get("wanx:setup:ready")();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
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

test("management keeps box settings nested and preserves the trusted console gateway", async () => {
  const h = await harness();
  const header = h.app.innerHTML.match(/<header[\s\S]*?<\/header>/)[0];
  assert.match(header, /<nav/);
  for (const page of ["applications", "settings"]) assert.ok(header.includes(`data-action="show-${page}"`));
  assert.ok(!header.includes('data-action="show-boxes"'));
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
  assert.ok(h.calls.some(([name]) => name === "nexusaos:discovery:reselect"));
  assert.equal(h.calls.filter(([name]) => name === "wanx:setup:begin").length, 1);
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

test("an empty scan gives an actionable retry message", async (t) => {
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

for (const [reason, label] of [
  ["application_unlisted", "此应用尚未上架或已下架"],
  ["no_published_target", "暂无适用于此电脑平台的安装包"],
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
  assert.match(h.app.innerHTML, /访问权限待就绪/);
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

test("registry and public identifier fallbacks stay labelled as identifiers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const deviceId = "centauros-727f68e96c972c5bcf0553d6";
  const h = await harness({ ...state(), devices: [{ ...devices[0], deviceId, displayName: deviceId }] }, [application], t);
  await h.click("provisioning");
  await h.click("start-provisioning");
  await new Promise((resolve) => setImmediate(resolve));
  for (const displayName of [deviceId, "CentaurOS-Setup-0553D6", "CentaurOS-", "CentaurAI Box"]) {
    h.advertisement({ deviceId: "provider-1", advertisedName: "CentaurOS-Setup-0553D6", displayIdentity: { deviceId, displayName } });
    assert.match(h.app.innerHTML, /<strong>未获取到盒子名称<\/strong>/);
    assert.doesNotMatch(h.app.innerHTML, /<strong>centauros-|<strong>CentaurOS-|<strong>CentaurAI Box/);
    assert.match(h.app.innerHTML, /设备编号：centauros-727f68e96c972c5bcf0553d6/);
  }
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
  assert.match(h.app.innerHTML, /盒子尚未开启配网模式/);
  assert.match(h.app.innerHTML, /data-action="provisioning-confirm" disabled/);
  h.setup({ state: "previewReady", preview: { ...preview, cloud_enrollment_status: "ready", pairing_mode_remaining_seconds: 300 } });
  assert.doesNotMatch(h.app.innerHTML, /data-action="provisioning-confirm" disabled/);
  h.window.wanxSetup.confirmPhysical = async () => { throw new Error("PROTOCOL_CHANGED"); };
  await h.click("provisioning-confirm");
  h.setup({ state: "terminalError", preview, errorCode: "PROTOCOL_CHANGED" });
  assert.match(h.app.innerHTML, /配网协议未能匹配/);
  assert.doesNotMatch(h.app.innerHTML, /应用市场操作失败|应用市场操作，请/);
});

test("settings owns box management and distinguishes account logout from application quit", async () => {
  const h = await harness(state("ready", "ready", "box-102"));
  assert.doesNotMatch(h.app.innerHTML, /data-action="show-boxes"/);
  await h.click("show-settings");
  assert.match(h.app.innerHTML, /管理与切换盒子/);
  assert.match(h.app.innerHTML, /CentuarAI-AMD-102 · 已连接/);
  assert.match(h.app.innerHTML, /退出当前账号/);
  assert.match(h.app.innerHTML, /退出账号会断开盒子，万象仍在后台运行/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="desktop-quit"/);
  const nav = h.app.innerHTML.match(/<nav[^>]*>(.*?)<\/nav>/)[1];
  assert.doesNotMatch(nav, /show-boxes/);
  await h.click("show-boxes");
  assert.match(h.app.innerHTML, /返回设置/);
  assert.match(h.app.innerHTML, /data-action="show-settings" aria-current="page"/);
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
    h.advertisement({ deviceId: "provider-1", advertisedName: "CentaurOS-Setup-0102", displayIdentity: { deviceId: "box-102", displayName: "CentaurAI Box" } });
    const candidateId = h.app.innerHTML.match(/data-candidate-id="([^"]+)"/)[1];
    assert.match(h.app.innerHTML, /<strong>未获取到盒子名称<\/strong>/);
    if (retained) {
      t.mock.timers.tick(12000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(h.app.innerHTML, /扫描已结束/);
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
