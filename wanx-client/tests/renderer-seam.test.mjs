import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { registerControlActions } from "../shell/control.mjs";

const source = await readFile(new URL("../local-ui/renderer/renderer.js", import.meta.url), "utf8");
const preload = await readFile(new URL("../local-ui/remote-preload.cjs", import.meta.url), "utf8");
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
async function harness(initial = state(), installed = [application]) {
  let rawState = initial;
  let records = [...installed];
  const events = new Map(), handlers = new Map(), listeners = new Map();
  const calls = [], launches = [], dashboards = [];
  const app = { innerHTML: "", addEventListener: (name, fn) => events.set(name, fn) };
  const controlURL = "file:///client/local-ui/renderer/index.html";
  const frame = { url: controlURL }, contents = { mainFrame: frame };
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
    applications: {
      listInstalled: async () => records,
      install: async () => { records = [application]; return application; },
      launch: async (id, version) => { launches.push([id, version]); return { state: "running" }; },
    },
  });
  const window = {};
  vm.runInNewContext(preload, { require: () => ({
    contextBridge: { exposeInMainWorld: (name, api) => { window[name] = api; } },
    ipcRenderer: {
      invoke: async (name, input) => {
        calls.push([name, input]);
        if (name.startsWith("wanx:setup:")) return { ok: true, value: { state: "idle" } };
        return handlers.get(name)({ sender: contents, senderFrame: frame }, input);
      },
      on: (name, listener) => listeners.set(name, listener), removeListener() {}, send() {},
    },
  }) });
  vm.runInNewContext(source, {
    window,
    document: { querySelector: (selector) => selector === "#app" ? app : null },
    FormData: class { constructor(form) { return Object.entries(form.values || {}); } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return {
    app, calls, launches, dashboards,
    navigate(page) { listeners.get("wanx-client:navigate")({}, page); },
    update(next, publish = true) {
      rawState = next;
      if (publish) listeners.get("wanx-client:state")({}, { ...rawState, applications: records });
    },
    click(action, data = {}) {
      return events.get("click")({ target: { closest: () => ({ dataset: { action, ...data } }) } });
    },
    input(value) { events.get("input")({ target: { id: "application-source", value } }); },
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
  assert.deepEqual(h.launches, [[application.applicationId, application.version]]);
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

test("installation works before connecting and applies the IPC response without a state broadcast", async () => {
  const h = await harness(state(), []);
  assert.match(h.app.innerHTML, /安装你的第一个应用/);
  h.input('/apps/zhijun & "draft"');
  h.update(state());
  assert.match(h.app.innerHTML, /value="\/apps\/zhijun &amp; &quot;draft&quot;"/);
  await h.submit("install", { sourceDir: " /apps/zhijun " });
  assert.match(h.app.innerHTML, /class="application-card"/);
  assert.match(h.app.innerHTML, /知君/);
  assert.equal(h.launches.length, 0);
  assert.equal(h.calls.find(([name]) => name === "wanx-client:applications-install")[1].sourceDir, "/apps/zhijun");
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
