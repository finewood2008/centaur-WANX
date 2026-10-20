import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createAccount } from "../account/index.mjs";
import { registerControlActions } from "../shell/control.mjs";
import { createUIBroadcast } from "../shell/ui-broadcast.mjs";

const preload = await readFile(new URL("../local-ui/remote-preload.cjs", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// Exercise both waits: mutation IPC publishes state, then preload reads state
// again before releasing the renderer's login/refresh spinner.
test("cloud login and device refresh reach the renderer while installed-app enumeration is blocked", async t => {
  const apps = gate(), requests = [], handlers = new Map(), exposed = {}, received = [];
  const account = createAccount({
    store: { load: async () => null, save: async () => {}, clear: async () => {} },
    fetch: async (url, options) => {
      requests.push(new URL(url).pathname);
      const { clientId } = JSON.parse(options.body);
      return new Response(JSON.stringify({ code: 200, data: {
        accountId: "owner", clientId, accessToken: "access", refreshToken: "refresh", expiresIn: 3600,
      } }));
    },
  });
  let directory = [];
  const client = {
    snapshot: () => ({ account: account.snapshot(), devices: directory, phase: "disconnected" }),
    loginPassword: (input, options) => {
      assert.equal(options.waitForDevices, false);
      return account.loginPassword(input);
    },
    refreshDevices: async () => { directory = [{ deviceId: "box-1", accessState: "unavailable" }]; return client.snapshot(); },
  };
  let appReads = 0;
  const controlURL = "file:///client/local-ui/renderer/index.html", frame = { url: controlURL };
  const contents = { mainFrame: frame, isDestroyed: () => false,
    send: (_channel, state) => received.push(state) };
  const control = { webContents: contents, isDestroyed: () => false };
  const broadcast = createUIBroadcast({ client,
    applications: { listInstalled: async () => { appReads++; return apps.promise; } },
    uiState: { snapshot: () => ({}) }, startup: { get: () => ({}) }, windows: () => [control],
  });
  registerControlActions({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    control, controlURL, client, getState: broadcast.getState, publishState: broadcast.publish });
  vm.runInNewContext(preload, { process: { platform: "win32" }, require: () => ({
    contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
    ipcRenderer: { on() {}, invoke: (name, input) => handlers.get(name)({ sender: contents, senderFrame: frame }, input) },
  }) });
  t.after(async () => { broadcast.dispose(); apps.resolve([]); await account.close(); });
  let loggedIn;
  const login = exposed.wanxClient.action("auth.login", { username: "13800138000", password: "password" })
    .then(value => { loggedIn = value; });
  await tick();
  assert.equal(account.snapshot().phase, "authenticated", "cloud authentication and durable save have finished");
  assert.equal(loggedIn?.ok, true, "renderer login must not wait for application enumeration");
  await login;
  assert.equal(loggedIn.state.account.phase, "authenticated");
  assert.deepEqual(requests, ["/prod-api/app-api/auth/password/login"]);
  let refreshed;
  const refresh = exposed.wanxClient.action("devices.refresh").then(value => { refreshed = value; });
  await tick();
  assert.equal(refreshed?.ok, true, "renderer refresh must not wait for application enumeration");
  await refresh;
  assert.equal(refreshed.state.devices[0].deviceId, "box-1");
  assert.equal(appReads, 1, "concurrent UI state reads share one background enumeration");
  apps.resolve([{ applicationId: "example.app" }]);
  await tick();
  assert.equal(received.at(-1).applications[0].applicationId, "example.app");
});
