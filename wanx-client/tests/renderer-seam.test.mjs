import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { installElectronBluetoothPicker } from "@nexusaos/device-discovery-electron/main";
import { registerControlActions } from "../shell/control.mjs";

const source = await readFile(new URL("../local-ui/renderer/renderer.js", import.meta.url), "utf8");
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
  const app = { innerHTML: "", addEventListener: (name, fn) => events.set(name, fn) };
  const controlURL = "file:///client/local-ui/renderer/index.html";
  const frame = { url: controlURL }, contents = Object.assign(new EventEmitter(), { mainFrame: frame });
  const ipcMain = new EventEmitter();
  const ipcEvent = { sender: contents, senderFrame: frame };
  contents.send = (name, payload) => listeners.get(name)?.({}, payload);
  const client = {
    snapshot: () => structuredClone(rawState),
    loginPassword: async () => { rawState = state("enrolling", "checking"); },
    logout: async () => { rawState = { account: { phase: "signed_out" } }; },
    connectBox: async (deviceId) => { rawState = state("ready", "ready", deviceId); },
    disconnect: async () => { rawState = state(); },
    refreshDevices: async () => {},
    setNetworkEnabled: async (enabled) => {
      rawState = { ...state(enabled ? "enrolling" : "idle", enabled ? "checking" : "disabled"), network: { enabled, phase: enabled ? "checking" : "disabled" } };
    },
  };
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
      install: async () => { const result = options.install ? await options.install() : application; records = [result]; return result; },
      uninstall: async () => { records = []; },
      rollback: async () => { records = [{ ...application, version: "0.4.2" }]; },
    },
    applications: {
      listInstalled: async () => records,
      selectCurrent: async (id, version) => {
        calls.push(["selected-current", id, version]);
        records = [{ ...application, version }];
      },
      launch: async (id, version) => { launches.push([id, version]); if (launchError) throw new Error(launchError); return { state: "running" }; },
    },
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
  let chooser, nearby = [{ deviceId: "provider-1", deviceName: "Test box" }];
  if (discoveryTest) {
    const clock = { monotonicMs: () => Date.now() };
    discoveryTest.after(installElectronBluetoothPicker({ webContents: contents, ipcMain, documentUrl: controlURL, clock, scanTimeoutMs: 12000 }));
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
    app, calls, launches, dashboards,
    nearby(value) { nearby = value; },
    failLaunch(code) { launchError = code; },
    navigate(page) { listeners.get("wanx-client:navigate")({}, page); },
    window,
    update(next, publish = true) {
      rawState = next;
      if (publish) listeners.get("wanx-client:state")({}, { ...rawState, applications: records });
    },
    click(action, data = {}) {
      return events.get("click")({ target: { closest: () => ({ dataset: { action, ...data } }) } });
    },
    keydown(key) { return events.get("keydown")({ key, preventDefault() {} }); },
    submit(form, values) { return events.get("submit")({ preventDefault() {}, target: { dataset: { form }, values } }); },
  };
}

test("login lands on the application cards even while the network is preparing", async () => {
  const h = await harness({ account: { phase: "signed_out" } });
  assert.match(h.app.innerHTML, /登录万象平台/);
  await h.submit("auth", { username: "13800000000", password: "example-password" });
  assert.match(h.app.innerHTML, /class="application-card"/);
  assert.match(h.app.innerHTML, /我的应用/);
  assert.match(h.app.innerHTML, /disabled>网络连接中<\/button>/);
  assert.doesNotMatch(h.app.innerHTML, /Octop Dashboard|data-action="applications-launch"/);
});

for (const [code, message] of [["APPLICATION_START_FAILED", "应用启动失败"], ["APPLICATION_START_TIMEOUT", "应用启动超时"]]) {
  test(`application home surfaces ${code} and allows retry without disconnecting the box`, async () => {
    const h = await harness(state("ready", "ready", "box-102"));
    h.failLaunch(code);
    await h.click("applications-launch", { applicationId: application.applicationId, version: application.version });
    assert.ok(h.app.innerHTML.includes(message));
    assert.doesNotMatch(h.app.innerHTML, new RegExp(code));
    assert.match(h.app.innerHTML, /已连接 CentuarAI-AMD-102/);
    assert.match(h.app.innerHTML, /data-action="applications-launch"[^>]*>打开应用/);
    assert.doesNotMatch(h.app.innerHTML, /data-action="applications-launch"[^>]*disabled/);
  });
}

test("home guides an unconnected user to settings and enables launch after connecting a box", async () => {
  const h = await harness();
  assert.match(h.app.innerHTML, /打开应用前，请先连接盒子/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="applications-launch"/);
  await h.click("show-settings");
  assert.match(h.app.innerHTML, /设备管理/);
  await h.click("connect", { deviceId: "box-102" });
  assert.match(h.app.innerHTML, /当前连接/);
  assert.match(h.app.innerHTML, /切换并连接/);
  await h.click("show-applications");
  assert.match(h.app.innerHTML, /已连接 CentuarAI-AMD-102/);
  assert.match(h.app.innerHTML, /data-action="applications-launch"/);
  await h.click("applications-launch", { applicationId: application.applicationId, version: application.version });
  assert.deepEqual(h.launches, [[application.applicationId, undefined]]);
});

test("settings is a header button and Dashboard opens the connected box from home or settings", async () => {
  const h = await harness();
  const header = h.app.innerHTML.match(/<header[\s\S]*?<\/header>/)[0];
  assert.match(header, /<button[^>]*data-action="show-settings"[^>]*>[\s\S]*?设置/);
  assert.doesNotMatch(header, /<nav/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="dashboard-open"/);
  await h.click("show-settings");
  await h.click("connect", { deviceId: "box-102" });
  assert.match(h.app.innerHTML, /data-action="dashboard-open"[^>]*>打开 Dashboard/);
  await h.click("dashboard-open", { url: "https://untrusted.example/" });
  await h.click("show-applications");
  assert.match(h.app.innerHTML, /data-action="dashboard-open"[^>]*>打开 Dashboard/);
  await h.click("dashboard-open");
  assert.deepEqual(h.dashboards.map((connection) => connection.deviceId), ["box-102", "box-102"]);
  assert.ok(h.dashboards.every((connection) => connection.gatewayURL === state("ready", "ready", "box-102").connection.gatewayURL));
  assert.equal(h.launches.length, 0);
  await h.click("show-settings");
  await h.click("disconnect");
  assert.doesNotMatch(h.app.innerHTML, /data-action="dashboard-open"/);
});

test("Dashboard entry follows gateway readiness and rejects a stale button after disconnect", async () => {
  const h = await harness(state("ready", "ready", "box-102"));
  h.update(state(), false);
  await h.click("dashboard-open");
  assert.deepEqual(h.dashboards, []);
  assert.match(h.app.innerHTML, /请先在设置中连接一台盒子/);
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

test("settings stays selected across network polling and blocks connection until ready", async () => {
  const h = await harness(state("enrolling", "checking"));
  await h.click("show-settings");
  assert.match(h.app.innerHTML, /disabled>网络连接中<\/button>/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="connect"/);
  await h.click("connect", { deviceId: "box-102" });
  assert.equal(h.calls.filter(([name]) => name === "wanx-client:connect-box").length, 0);
  h.update(state());
  assert.match(h.app.innerHTML, /设备管理/);
  assert.match(h.app.innerHTML, /data-action="connect"/);
  assert.doesNotMatch(h.app.innerHTML, /class="application-card"/);
});

test("settings can switch boxes, disconnect, and toggle the network without losing navigation", async () => {
  const h = await harness(state("ready", "ready", "box-102"));
  await h.click("show-settings");
  await h.click("connect", { deviceId: "box-103" });
  assert.match(h.app.innerHTML, /class="current-device">CentuarAI-AMD-103/);
  await h.click("disconnect");
  assert.match(h.app.innerHTML, /尚未连接盒子/);
  await h.click("network-toggle");
  assert.match(h.app.innerHTML, /aria-checked="false"/);
  assert.match(h.app.innerHTML, /disabled>网络已关闭<\/button>/);
  await h.click("network-toggle");
  assert.match(h.app.innerHTML, /aria-checked="true"/);
  assert.match(h.app.innerHTML, /disabled>网络连接中<\/button>/);
  assert.deepEqual(h.calls.filter(([name]) => name === "wanx-client:set-network-enabled").map(([, value]) => value), [false, true]);
});

test("network failure and recovery update both application and settings actions", async () => {
  const h = await harness(state("ready", "ready", "box-102"));
  h.update(state("unavailable", "unavailable", "box-102"));
  assert.match(h.app.innerHTML, /disabled>网络暂不可用<\/button>/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="applications-launch"/);
  await h.click("show-settings");
  assert.match(h.app.innerHTML, /重试连接/);
  await h.click("refresh");
  assert.ok(h.calls.some(([name]) => name === "wanx-client:refresh-devices"));
  h.update(state());
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

test("market update displays the target version and retains box launch gating", async () => {
  const h = await harness(state("enrolling", "checking"), [application], { candidate: async () => ({ status: "available", release: { version: "0.5.0" } }) });
  assert.match(h.app.innerHTML, /可更新至 v0.5.0/);
  await h.click("market-install", { applicationId: application.applicationId });
  assert.match(h.app.innerHTML, /将 v0.4.3 更新至 v0.5.0/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="applications-launch"/);
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

test("a stale open button cannot bypass the main-process box check", async () => {
  const h = await harness(state("ready", "ready", "box-102"));
  h.update(state(), false);
  await h.click("applications-launch", { applicationId: application.applicationId, version: application.version });
  assert.equal(h.launches.length, 0);
  assert.match(h.app.innerHTML, /请先在设置中连接一台盒子/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="applications-launch"/);
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

test("device setup retains its wizard across polling and returns to settings", async () => {
  const h = await harness();
  await h.click("show-settings");
  await h.click("provisioning");
  assert.match(h.app.innerHTML, /发现并初始化盒子/);
  h.update(state("enrolling", "checking"));
  assert.match(h.app.innerHTML, /发现并初始化盒子/);
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

for (const leave of ["back-devices", "logout"]) {
  test(`${leave} revokes scan results and a late chooser cannot start setup`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = await harness(state(), [application], t);
    await h.click("provisioning");
    await h.click("start-provisioning");
    await new Promise((resolve) => setImmediate(resolve));
    if (leave === "logout") h.update({ account: { phase: "signed_out" } });
    else await h.click(leave);
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
  h.navigate("settings");
  assert.match(h.app.innerHTML, /设备管理/);
  h.navigate("https://untrusted.example/");
  assert.match(h.app.innerHTML, /设备管理/);
  h.navigate("applications");
  assert.match(h.app.innerHTML, /class="application-card"/);
  await h.click("show-settings");
  await h.click("provisioning");
  h.navigate("applications");
  assert.match(h.app.innerHTML, /发现并初始化盒子/);
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
  assert.match(h.app.innerHTML, /刷新与检查更新/);
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
