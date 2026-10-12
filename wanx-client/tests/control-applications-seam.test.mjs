import test from "node:test";
import assert from "node:assert/strict";
import { registerControlActions } from "../shell/control.mjs";

const connected = {
  account: { phase: "authenticated" },
  platform: { phase: "ready" },
  network: { enabled: true, phase: "ready" },
  phase: "ready",
  connection: { mode: "netbird", deviceId: "box-102" },
};

function control(state) {
  const handlers = new Map(), launched = [], installed = [];
  const frame = { url: "file:///wanx/index.html" }, webContents = { mainFrame: frame };
  registerControlActions({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    control: { webContents, isDestroyed: () => false }, controlURL: frame.url,
    client: { snapshot: () => state },
    applications: {
      launch: (...args) => launched.push(args),
      install: (input) => installed.push(input),
    },
  });
  return {
    launched, installed,
    invoke: (name, input) => handlers.get(`wanx-client:${name}`)({ sender: webContents, senderFrame: frame }, input),
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
  test(`launch IPC rejects ${label} without calling the application manager`, () => {
    const h = control({ ...connected, ...override });
    assert.throws(() => h.invoke("applications-launch", { applicationId: "centaurai.wanx.zhijun" }), { message: code });
    assert.deepEqual(h.launched, []);
  });
}

test("launch IPC forwards the selected application version only with a ready box", () => {
  const h = control(connected);
  h.invoke("applications-launch", { applicationId: "centaurai.wanx.zhijun", version: "0.4.3", boxId: "injected" });
  assert.deepEqual(h.launched, [["centaurai.wanx.zhijun", "0.4.3"]]);
});

test("local installation remains available without a connected box", () => {
  const h = control({ ...connected, phase: "disconnected", connection: null });
  h.invoke("applications-install", { sourceDir: "/application-package" });
  assert.deepEqual(h.installed, [{ sourceDir: "/application-package" }]);
  assert.deepEqual(h.launched, []);
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
