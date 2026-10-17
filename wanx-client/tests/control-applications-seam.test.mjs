import test from "node:test";
import assert from "node:assert/strict";
import { registerControlActions, openConnectedDashboard } from "../shell/control.mjs";

const connected = {
  account: { phase: "authenticated" },
  platform: { phase: "ready" },
  network: { enabled: true, phase: "ready" },
  phase: "ready",
  connection: { mode: "netbird", deviceId: "box-102", gatewayURL: "http://127.0.0.1:41000/__wanx_session/test" },
};

function control(state, selectApplicationArchive) {
  const handlers = new Map(), launched = [], installed = [], dashboards = [];
  const frame = { url: "file:///wanx/index.html" }, webContents = { mainFrame: frame };
  registerControlActions({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    control: { webContents, isDestroyed: () => false }, controlURL: frame.url,
    client: { snapshot: () => state },
    dashboards: { open: (snapshot) => dashboards.push(snapshot.connection) },
    selectApplicationArchive,
    allowDevelopmentInstall: Boolean(selectApplicationArchive),
    applications: {
      launch: (...args) => launched.push(args),
      install: (input) => installed.push(input),
    },
  });
  return {
    launched, installed, dashboards,
    invoke: (name, input, event = { sender: webContents, senderFrame: frame }) => handlers.get(`wanx-client:${name}`)(event, input),
  };
}

for (const [label, override, code] of [
  ["signed out", { account: { phase: "signed_out" } }, "ACCOUNT_LOGIN_REQUIRED"],
  ["network disabled", { network: { enabled: false, phase: "ready" } }, "NETWORK_NOT_READY"],
  ["platform enrolling", { platform: { phase: "enrolling" } }, "NETWORK_NOT_READY"],
  ["network checking", { network: { enabled: true, phase: "checking" } }, "NETWORK_NOT_READY"],
  ["network failed", { network: { enabled: true, phase: "unavailable" } }, "NETWORK_NOT_READY"],
  ["box absent", { connection: null }, "BOX_CONNECTION_REQUIRED"],
  ["box connecting", { phase: "connecting" }, "BOX_CONNECTION_REQUIRED"],
  ["box disconnected", { phase: "disconnected" }, "BOX_CONNECTION_REQUIRED"],
  ["direct development connection", { connection: { mode: "direct", deviceId: "local" } }, "BOX_CONNECTION_REQUIRED"],
  ["box identity absent", { connection: { mode: "netbird" } }, "BOX_CONNECTION_REQUIRED"],
]) {
  test(`application and Dashboard IPC reject ${label} before opening`, () => {
    const h = control({ ...connected, ...override });
    assert.throws(() => h.invoke("applications-launch", { applicationId: "centaurai.wanx.zhijun" }), { message: code });
    assert.deepEqual(h.launched, []);
    assert.throws(() => h.invoke("dashboard-open"), { message: "DASHBOARD_TERMINAL_ONLY" });
    assert.throws(() => h.invoke("maintenance-open", { tool: "terminal", deviceId: "box-102" }), { message: code });
    assert.deepEqual(h.dashboards, []);
  });
}

test("console is unavailable to management IPC while its terminal owner uses only the current gateway", () => {
  const h = control(connected);
  assert.throws(() => h.invoke("dashboard-open", { url: "https://untrusted.example/" }), /DASHBOARD_TERMINAL_ONLY/);
  assert.throws(() => h.invoke("dashboard-open", {}, { sender: {}, senderFrame: {} }), /此页面无权操作万象连接/);
  const opened = [];
  openConnectedDashboard({ snapshot: () => connected }, { open: state => opened.push(state.connection) });
  assert.deepEqual(opened, [connected.connection]);
  assert.throws(() => openConnectedDashboard({ snapshot: () => ({ ...connected, connection: { mode: "netbird", deviceId: "box-102" } }) }, { open() {} }), /BOX_CONNECTION_REQUIRED/);
});

test("launch IPC uses the current application and ignores stale renderer versions", () => {
  const h = control(connected);
  h.invoke("applications-launch", { applicationId: "centaurai.wanx.zhijun", version: "0.4.3", boxId: "injected" });
  assert.deepEqual(h.launched, [["centaurai.wanx.zhijun"]]);
});

test("explicit development installation remains available without a connected box", () => {
  const h = control({ ...connected, phase: "disconnected", connection: null }, true);
  h.invoke("applications-install", { sourceDir: "/application-package" });
  assert.deepEqual(h.installed, [{ sourceDir: "/application-package" }]);
  assert.deepEqual(h.launched, []);
});

test("ZIP selection installs the chosen file, cancellation does nothing, and untrusted pages cannot open the picker", async () => {
  let chosen = "download.zip", selections = 0;
  const h = control({ ...connected, connection: null }, async () => { selections++; return chosen; });
  await h.invoke("applications-install");
  assert.deepEqual(h.installed, [{ archivePath: chosen }]);
  chosen = null;
  assert.deepEqual(await h.invoke("applications-install"), { canceled: true });
  assert.equal(h.installed.length, 1);
  assert.throws(() => h.invoke("applications-install", {}, { sender: {}, senderFrame: {} }), /此页面无权操作万象连接/);
  assert.equal(selections, 2);
  assert.throws(() => h.invoke("applications-install", { sourceDir: "source", archivePath: "app.zip" }), /APPLICATION_SOURCE_REQUIRED/);
});

test("state reads sample the connection after the asynchronous application list finishes", async () => {
  const handlers = new Map();
  const frame = { url: "file:///wanx/index.html" }, webContents = { mainFrame: frame };
  let state = connected;
  let finishListing;
  registerControlActions({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    control: { webContents, isDestroyed: () => false }, controlURL: frame.url,
    client: { snapshot: () => state },
    applications: { listInstalled: () => new Promise((resolve) => { finishListing = resolve; }) },
  });
  const pending = handlers.get("wanx-client:get-state")({ sender: webContents, senderFrame: frame });
  state = { ...connected, phase: "disconnected", connection: null };
  finishListing([]);
  assert.equal((await pending).connection, null);
});


test("authenticated local box opens Dashboard and apps without cloud network", () => {
  const state = { ...connected, platform: { phase: "unavailable" }, network: { enabled: false, phase: "disabled" },
    connection: { ...connected.connection, mode: "local", deviceId: "local-0123456789abcdef01234567" } };
  const h = control(state);
  assert.throws(() => h.invoke("dashboard-open"), /DASHBOARD_TERMINAL_ONLY/);
  openConnectedDashboard({ snapshot: () => state }, { open: snapshot => h.dashboards.push(snapshot.connection) });
  h.invoke("applications-launch", { applicationId: "centaurai.wanx.zhijun" });
  assert.equal(h.dashboards.length, 1); assert.equal(h.launched.length, 1);
  assert.throws(() => control({ ...state, phase: "disconnected" }).invoke("dashboard-open"));
});

test("maintenance IPC rejects stale targets, arbitrary URLs and unsupported tools", () => {
  const h = control(connected);
  assert.throws(() => h.invoke("maintenance-open", { tool: "terminal", deviceId: "box-103" }), /BOX_CONNECTION_CHANGED/);
  for (const tool of ["dashboard", "/workbench/terminal", "https://untrusted.example/", "constructor", "__proto__"]) {
    assert.throws(() => h.invoke("maintenance-open", { tool, deviceId: "box-102" }), /INVALID_MAINTENANCE_TOOL/);
  }
  assert.deepEqual(h.dashboards, []);
});
