import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { registerControlActions } from "../shell/control.mjs";
import { createUIState } from "../shell/ui-state.mjs";

const denied = /此页面无权操作万象连接/;
const ready = {
  account: { phase: "authenticated", accountId: "alice", clientId: "client-a" },
  phase: "ready", network: { phase: "ready", enabled: true }, platform: { phase: "ready" },
  connection: { mode: "netbird", deviceId: "box-a", gatewayURL: "http://127.0.0.1:41000/current" },
  devices: [{ deviceId: "box-a", accessState: "ready" }],
};
function windowFixture(url) {
  return {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: { mainFrame: { url } },
  };
}
function harness(overrides = {}) {
  const handlers = new Map(), calls = [];
  const controlURL = "file:///wanx/management.html", panelURL = "file:///wanx/panel.html";
  const control = windowFixture(controlURL), panel = windowFixture(panelURL);
  const record = name => (...args) => { calls.push([name, ...args]); return "ok"; };
  const client = {
    snapshot: () => structuredClone(ready), subscribe: () => () => {},
    loginPassword: record("loginPassword"), loginSMS: record("loginSMS"), sendSMS: record("sendSMS"),
    logout: record("logout"), connectBox: record("connectBox"), disconnect: record("disconnect"),
    refreshDevices: record("refreshDevices"), connect: record("connect"), setNetworkEnabled: record("setNetworkEnabled"),
  };
  const applications = {
    listInstalled: () => [{ applicationId: "example.app" }],
    install: record("install"), selectCurrent: record("selectCurrent"), launch: record("launch"), stop: record("stop"),
  };
  registerControlActions({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, control, controlURL, panel, panelURL,
    client, applications, allowDevelopmentInstall: true,
    market: Object.fromEntries(["list", "candidate", "install", "uninstall", "rollback"].map(name => [name, record(`market.${name}`)])),
    dashboards: { open: record("dashboard") },
    uiState: {
      requestOpen: record("requestOpen"), confirmOpen: record("confirmOpen"), cancelOpen: record("cancelOpen"),
      invalidateOpen: record("invalidateOpen"), runApplicationOperation: (_id, _phase, operation) => operation(),
    },
    desktop: { showManagement: record("showManagement"), hidePanel: record("hidePanel"), resizePanel: record("resizePanel") },
    showAbout: record("showAbout"),
    ...overrides,
  });
  const event = which => ({ sender: which.webContents, senderFrame: which.webContents.mainFrame });
  return { handlers, calls, control, panel, client, applications, event,
    invoke(name, input, which = control) { return handlers.get(`wanx-client:${name}`)(event(which), input); },
  };
}

for (const surface of ["control", "panel"]) {
  test(`${surface}: every control IPC rejects subframes, foreign contents, forged URLs, and closed windows`, () => {
    const h = harness(), window = h[surface], trusted = h.event(window);
    const foreign = windowFixture(window.webContents.mainFrame.url);
    for (const handler of h.handlers.values()) {
      assert.throws(() => handler({ ...trusted, senderFrame: { url: trusted.senderFrame.url } }, {}), denied);
      assert.throws(() => handler({ ...trusted, sender: foreign.webContents }, {}), denied);
      assert.throws(() => handler(h.event(foreign), {}), denied);
      const original = window.webContents.mainFrame.url;
      for (const url of ["https://untrusted.example/", `${original}?trusted=1`, `${original}#spoof`]) {
        window.webContents.mainFrame.url = url;
        assert.throws(() => handler(h.event(window), {}), denied);
      }
      window.webContents.mainFrame.url = original;
      window.destroyed = true;
      assert.throws(() => handler(h.event(window), {}), denied);
      window.destroyed = false;
    }
    assert.deepEqual(h.calls, []);
  });
}

test("panel cannot invoke account, market mutation, version selection, or management-only operations", () => {
  const h = harness();
  for (const name of [
    "login-password", "login-sms", "send-sms", "logout", "set-network-enabled", "connect", "dashboard-open", "maintenance-open",
    "applications-install", "applications-launch", "applications-select-current", "applications-stop",
    "market-list", "market-candidate", "market-install", "market-uninstall", "market-rollback",
    "desktop-startup-get", "desktop-startup-set", "desktop-quit",
    "connect-box", "disconnect", "refresh-devices", "credits-balance", "credits-transactions", "credits-reservation",
  ]) {
    assert.throws(() => h.invoke(name, {
      phone: "13800138000", password: "secret", code: "123456", applicationId: "example.app",
      version: "1.2.3", mode: "direct", deviceId: "box-a", url: "https://box.example", enabled: true,
    }, h.panel), denied, name);
  }
  assert.deepEqual(h.calls, []);
  assert.equal([...h.handlers.keys()].some(name => name.startsWith("wanx:setup:")), false,
    "setup IPC is registered separately against only the management window");
});

test("management retains account, market, and version selection operations", async () => {
  const h = harness();
  await h.invoke("login-password", { phone: "13800138000", password: "secret" });
  await h.invoke("market-install", { applicationId: "example.app", url: "https://injected.example" });
  await h.invoke("applications-select-current", { applicationId: "example.app", version: "1.2.3", sourceDir: "injected" });
  await h.invoke("logout");
  assert.deepEqual(h.calls, [
    ["loginPassword", { phone: "13800138000", password: "secret" }, { waitForDevices: false }],
    ["market.install", "example.app"], ["selectCurrent", "example.app", "1.2.3"], ["invalidateOpen"], ["logout"],
  ]);
});

test("both trusted windows can open the native about panel without changing accounts or boxes", async () => {
  const h = harness();
  await h.invoke("desktop-about", undefined, h.panel);
  await h.invoke("desktop-about", undefined, h.control);
  assert.deepEqual(h.calls, [["showAbout"], ["showAbout"]]);
});

for (const surface of ["control", "panel"]) {
  test(`${surface}: narrow open IPC forwards only validated identifiers`, async () => {
    const h = harness(), window = h[surface];
    const injected = { url: "https://injected.example", token: "untrusted", version: "9.9.9", sourceDir: "outside", command: "arbitrary" };
    await h.invoke("applications-request-open", { applicationId: " example.app ", ...injected }, window);
    await h.invoke("applications-confirm-open", { intentId: " intent-1 ", deviceId: " box-a ", ...injected }, window);
    await h.invoke("applications-cancel-open", { intentId: " intent-1 ", ...injected }, window);
    assert.deepEqual(h.calls, [
      ["requestOpen", "example.app"], ["confirmOpen", { intentId: "intent-1", deviceId: "box-a" }],
      ["cancelOpen", { intentId: "intent-1" }],
    ]);
  });

  test(`${surface}: malformed open inputs are rejected before reaching the coordinator`, () => {
    const h = harness(), window = h[surface];
    for (const invalid of [undefined, null, "", "  ", 12, {}, [], "a".repeat(65)]) {
      assert.throws(() => h.invoke("applications-request-open", { applicationId: invalid }, window), /invalid_application_id/);
    }
    for (const invalid of [undefined, null, "", "  ", 12, {}, [], "a".repeat(129)]) {
      assert.throws(() => h.invoke("applications-confirm-open", { intentId: invalid, deviceId: "box-a" }, window), /invalid_intent/);
      assert.throws(() => h.invoke("applications-confirm-open", { intentId: "intent", deviceId: invalid }, window), /invalid_device/);
      assert.throws(() => h.invoke("applications-cancel-open", { intentId: invalid }, window), /invalid_intent/);
    }
    assert.deepEqual(h.calls, []);
  });
}

test("both trusted windows still pass identifier syntax and current-directory checks in the real coordinator", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-panel-security-"));
  const first = harness();
  const uiState = await createUIState({
    client: { ...first.client, snapshot: () => ({ ...ready, phase: "disconnected", connection: null }) },
    account: { snapshot: () => ready.account, getIdentity: () => ready.account, subscribe: () => () => {} },
    applications: first.applications,
    preferenceFile: path.join(directory, "preferences.json"), serviceURL: "https://accounts.example",
  });
  t.after(async () => { await uiState.dispose(); await rm(directory, { recursive: true, force: true }); });
  const h = harness({ uiState });
  for (const surface of ["control", "panel"]) {
    const window = h[surface];
    await assert.rejects(h.invoke("applications-request-open", { applicationId: "../application" }, window), { code: "INVALID_APPLICATION_ID" });
    const intent = await h.invoke("applications-request-open", { applicationId: "example.app" }, window);
    await assert.rejects(h.invoke("applications-confirm-open", { intentId: intent.id, deviceId: "../box" }, window), { code: "INVALID_DEVICE_ID" });
    await assert.rejects(h.invoke("applications-confirm-open", { intentId: intent.id, deviceId: "box-foreign" }, window), { code: "NETWORK_DEVICE_ACCESS_DENIED" });
    await h.invoke("applications-cancel-open", { intentId: intent.id }, window);
  }
  assert.deepEqual(first.calls, [], "invalid requests cannot reach the actual connection or launcher");
});


test("profile writes and file selection are management-only and reject forged fields", async () => {
  const writes = [];
  const h = harness({ accountProfile: { save: input => writes.push(input), chooseAvatar: () => writes.push("choose"), removeAvatar: () => writes.push("remove") } });
  for (const action of ["profile-save", "profile-avatar", "profile-avatar-remove"]) {
    assert.throws(() => h.invoke(action, { displayName: "test" }, h.panel), denied);
  }
  assert.throws(() => h.invoke("profile-save", { displayName: "test", avatarDataUrl: "evil" }), /PROFILE_INVALID_INPUT/);
  assert.deepEqual(writes, []);
  await h.invoke("profile-save", { displayName: "test" });
  assert.deepEqual(writes, [{ displayName: "test" }]);
  const signedOut = harness({ client: { snapshot: () => ({ account: { phase: "signed_out" } }) } });
  assert.throws(() => signedOut.invoke("profile-avatar"), /ACCOUNT_LOGIN_REQUIRED/);
});


test("quick panel balance read exposes only available points and does not publish or mutate state", async () => {
  let reads = 0, publishes = 0;
  const h = harness({ credits: { balance: async () => { reads++; return { available: 1234, held: 3, paid_available: 1200, gift_available: 34, internal: "private" }; } }, publishState: () => publishes++ });
  assert.deepEqual(await h.invoke("panel-balance", undefined, h.panel), { available: 1234 });
  assert.equal(reads, 1); assert.equal(publishes, 0);
  assert.deepEqual(h.calls, []);
  const signedOut = harness({ client: { snapshot: () => ({ account: { phase: "signed_out" } }) } });
  await assert.rejects(signedOut.invoke("panel-balance", undefined, signedOut.panel), /ACCOUNT_LOGIN_REQUIRED/);
});

test("panel preload exposes a fixed balance reader, retaining the generic-action restrictions", async () => {
  const { readFile } = await import("node:fs/promises");
  const vm = await import("node:vm");
  let api; const calls = [];
  vm.runInNewContext(await readFile(new URL("../local-ui/panel-preload.cjs", import.meta.url), "utf8"), { require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => api = value },
    ipcRenderer: { invoke: name => { calls.push(name); return Promise.resolve({ available: 55 }); } },
  }) });
  assert.deepEqual(await api.getBalance({ accountId: "forged" }), { available: 55 });
  assert.deepEqual(calls, ["wanx-client:panel-balance"]);
  await assert.rejects(api.action("credits-balance"), /PANEL_ACTION_NOT_ALLOWED/);
  await assert.rejects(api.action("profile-save"), /PANEL_ACTION_NOT_ALLOWED/);
});

test("panel space upload fixes the root, rejects stale contexts, and exposes only upload progress", async () => {
  let scope = "scope-a";
  const calls = [];
  const personalSpace = {
    snapshot: () => ({ phase: "ready", scope, accountId: "alice", boxId: "box-a", overview: { private: true }, tasks: [
      { id: "a".repeat(32), direction: "upload", name: "file.txt", size: 10, offset: 4, phase: "running", localPath: "/private/source", digest: "secret" },
      { id: "b".repeat(32), direction: "download", name: "private-download.txt", localPath: "/private/destination" },
    ] }),
    refresh: async () => personalSpace.snapshot(),
    uploads: async (...args) => { calls.push(["uploads", ...args]); },
    transfer: async (...args) => { calls.push(["transfer", ...args]); },
  };
  const h = harness({ personalSpace });
  const value = h.invoke("panel-space-snapshot", {}, h.panel);
  assert.equal(value.tasks.length, 1);
  assert.doesNotMatch(JSON.stringify(value), /localPath|private|digest|overview/);
  await h.invoke("panel-space-upload", { scope, paths: ["/private/one.txt", "/private/two.txt"], parent: "injected-folder" }, h.panel);
  assert.deepEqual(calls.pop(), ["uploads", "", ["/private/one.txt", "/private/two.txt"], "scope-a"]);
  await h.invoke("panel-space-transfer", { scope, id: "a".repeat(32), action: "pause" }, h.panel);
  assert.deepEqual(calls.pop(), ["transfer", "pause", "a".repeat(32)]);
  for (const action of ["cancel", "purge", "download"]) assert.throws(() => h.invoke("panel-space-transfer", { scope, id: "a".repeat(32), action }, h.panel), /PANEL_ACTION_NOT_ALLOWED/);
  assert.throws(() => h.invoke("panel-space-transfer", { scope, id: "b".repeat(32), action: "pause" }, h.panel), /SPACE_NOT_FOUND/);
  await assert.rejects(h.invoke("panel-space-upload", { scope: "old", paths: ["/private/one.txt"] }, h.panel), /SPACE_CONTEXT_CHANGED/);
  personalSpace.refresh = async () => { scope = "scope-b"; return personalSpace.snapshot(); };
  await assert.rejects(h.invoke("panel-space-upload", { scope: "scope-a", paths: ["/private/one.txt"] }, h.panel), /SPACE_CONTEXT_CHANGED/);
  for (const name of ["space-upload-dropped", "space-snapshot", "space-uploads", "space-transfer", "space-download", "space-downloads", "space-purge"])
    assert.throws(() => h.invoke(name, {}, h.panel), denied);
  for (const name of ["panel-space-snapshot", "panel-space-refresh", "panel-space-upload", "panel-space-transfer"]) {
    const bad = { webContents: { mainFrame: { url: "https://untrusted.example" } } };
    assert.throws(() => h.invoke(name, {}, bad), denied);
    const frame = { sender: h.panel.webContents, senderFrame: { url: "file:///wanx/panel.html" } };
    assert.throws(() => h.handlers.get(`wanx-client:${name}`)(frame, {}), denied);
  }
});

test("profile writes and file selection are management-only and reject forged fields", async () => {
  const writes = [];
  const h = harness({ accountProfile: { save: input => writes.push(input), chooseAvatar: () => writes.push("choose"), removeAvatar: () => writes.push("remove") } });
  for (const action of ["profile-save", "profile-avatar", "profile-avatar-remove"]) {
    assert.throws(() => h.invoke(action, { displayName: "test" }, h.panel), denied);
  }
  assert.throws(() => h.invoke("profile-save", { displayName: "test", avatarDataUrl: "evil" }), /PROFILE_INVALID_INPUT/);
  assert.deepEqual(writes, []);
  await h.invoke("profile-save", { displayName: "test" });
  assert.deepEqual(writes, [{ displayName: "test" }]);
  const signedOut = harness({ client: { snapshot: () => ({ account: { phase: "signed_out" } }) } });
  assert.throws(() => signedOut.invoke("profile-avatar"), /ACCOUNT_LOGIN_REQUIRED/);
});


test("quick panel balance read exposes only available points and does not publish or mutate state", async () => {
  let reads = 0, publishes = 0;
  const h = harness({ credits: { balance: async () => { reads++; return { available: 1234, held: 3, paid_available: 1200, gift_available: 34, internal: "private" }; } }, publishState: () => publishes++ });
  assert.deepEqual(await h.invoke("panel-balance", undefined, h.panel), { available: 1234 });
  assert.equal(reads, 1); assert.equal(publishes, 0);
  assert.deepEqual(h.calls, []);
  const signedOut = harness({ client: { snapshot: () => ({ account: { phase: "signed_out" } }) } });
  await assert.rejects(signedOut.invoke("panel-balance", undefined, signedOut.panel), /ACCOUNT_LOGIN_REQUIRED/);
});

test("panel preload exposes a fixed balance reader, retaining the generic-action restrictions", async () => {
  const { readFile } = await import("node:fs/promises");
  const vm = await import("node:vm");
  let api; const calls = [];
  vm.runInNewContext(await readFile(new URL("../local-ui/panel-preload.cjs", import.meta.url), "utf8"), { require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => api = value },
    ipcRenderer: { invoke: name => { calls.push(name); return Promise.resolve({ available: 55 }); } },
  }) });
  assert.deepEqual(await api.getBalance({ accountId: "forged" }), { available: 55 });
  assert.deepEqual(calls, ["wanx-client:panel-balance"]);
  await assert.rejects(api.action("credits-balance"), /PANEL_ACTION_NOT_ALLOWED/);
  await assert.rejects(api.action("profile-save"), /PANEL_ACTION_NOT_ALLOWED/);
});

test("link management is limited to the trusted main window", async () => {
  const actions = [];
  const h = harness({ spaceLinks: { manage: async (...args) => { actions.push(args); return {}; } } });
  for (const name of ["create", "list", "revoke", "audit", "config"]) {
    assert.throws(() => h.invoke("space-links-"+name, {}, h.panel), denied);
    await h.invoke("space-links-"+name, {});
  }
  assert.equal(actions.length, 5);
});
