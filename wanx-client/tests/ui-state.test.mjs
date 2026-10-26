import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createUIState } from "../shell/ui-state.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const failure = (code) => Object.assign(new Error(code), { code });
const device = (deviceId) => ({ deviceId, displayName: deviceId, accessState: "ready", canOpen: true });

async function harness(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-ui-state-"));
  const preferenceFile = options.preferenceFile || path.join(directory, "ui-preferences.json");
  let accountState = { phase: "authenticated", accountId: "alice", clientId: "client-a" };
  let clientState = {
    phase: "disconnected", connection: null,
    network: { phase: "ready", enabled: true }, platform: { phase: "ready" },
    devices: [device("box-a")], ...options.state,
  };
  const accountListeners = new Set(), clientListeners = new Set();
  const calls = [], changes = [], opened = [];
  let connect = async (id) => { publishClient({ phase: "ready", connection: { deviceId: id, mode: "netbird" } }); };
  let launch = async (id) => ({ applicationId: id, launchId: "launch", state: "running" });
  let stop = async () => {};
  function publishClient(patch) {
    clientState = { ...clientState, ...patch };
    for (const listener of clientListeners) listener(client.snapshot());
  }
  const account = {
    snapshot: () => structuredClone(accountState),
    getIdentity: () => accountState.phase === "authenticated"
      ? { accountId: accountState.accountId, clientId: accountState.clientId } : null,
    subscribe(listener) { accountListeners.add(listener); return () => accountListeners.delete(listener); },
  };
  const client = {
    snapshot: () => structuredClone({ ...clientState, account: accountState }),
    subscribe(listener) { clientListeners.add(listener); return () => clientListeners.delete(listener); },
    async connectBox(id) { calls.push(["connect", id]); return connect(id); },
    async disconnect() { calls.push(["disconnect"]); publishClient({ phase: "disconnected", connection: null }); },
  };
  const applications = {
    async launch(id) { calls.push(["launch", id]); return launch(id); },
    async stop(id) { calls.push(["stop", id]); return stop(id); },
  };
  const ui = await createUIState({
    client, account, applications, preferenceFile,
    assertClientUsable: options.assertClientUsable,
    serviceURL: options.serviceURL || "https://accounts.example/prod-api",
    onChanged: (state) => changes.push(state), onOpened: (value) => opened.push(value),
  });
  t.after(async () => {
    await ui.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    ui, calls, changes, opened, client, account, applications, preferenceFile,
    publishClient,
    publishAccount(patch) {
      accountState = { ...accountState, ...patch };
      for (const listener of accountListeners) listener(account.snapshot());
    },
    setConnect(fn) { connect = fn; }, setLaunch(fn) { launch = fn; }, setStop(fn) { stop = fn; },
    listenerCounts: () => [accountListeners.size, clientListeners.size],
  };
}

test("opening without a connection requires confirmation and waits for application readiness", async t => {
  const h = await harness(t), started = deferred(), launchEntered = deferred();
  h.setLaunch(() => { launchEntered.resolve(); return started.promise; });
  const confirmation = await h.ui.requestOpen("example.app");
  assert.equal(confirmation.phase, "confirm");
  assert.equal(confirmation.deviceId, "box-a");
  assert.deepEqual(h.calls, [], "a suggestion must not connect automatically");
  const opening = h.ui.confirmOpen({ intentId: confirmation.id, deviceId: "box-a" });
  await launchEntered.promise;
  assert.equal(h.ui.snapshot().pendingOpen.phase, "opening");
  assert.equal(h.ui.snapshot().applicationOperations["example.app"].phase, "opening");
  assert.deepEqual(h.opened, []);
  started.resolve({ applicationId: "example.app", state: "running", launchId: "ready" });
  assert.equal((await opening).state, "running");
  assert.deepEqual(h.calls, [["connect", "box-a"], ["launch", "example.app"]]);
  assert.equal(h.ui.snapshot().pendingOpen, null);
  assert.deepEqual(h.ui.snapshot().applicationOperations, {});
  assert.equal(h.opened.length, 1);
});

test("an already connected application opens directly without reconnecting", async t => {
  const h = await harness(t, { state: { phase: "ready", connection: { mode: "netbird", deviceId: "box-a" } } });
  const result = await h.ui.requestOpen("example.app");
  assert.equal(result.state, "running");
  assert.deepEqual(h.calls, [["launch", "example.app"]]);
  assert.equal(h.ui.snapshot().lastDeviceId, "box-a");
  assert.equal(h.opened.length, 1);
});

test("last successful box is persisted per account and service, without credentials", async t => {
  const h = await harness(t, { state: { devices: [device("box-a"), device("box-b")] } });
  assert.equal((await h.ui.requestOpen("example.app")).deviceId, null);
  h.publishClient({ phase: "ready", connection: { mode: "netbird", deviceId: "box-a" } });
  await h.ui.rememberConnection();
  h.publishClient({ phase: "disconnected", connection: null });
  assert.equal((await h.ui.requestOpen("example.app")).deviceId, "box-a");
  h.publishAccount({ accountId: "bob", clientId: "client-b" });
  assert.equal(h.ui.snapshot().lastDeviceId, null);
  h.publishClient({ phase: "ready", connection: { mode: "netbird", deviceId: "box-b" } });
  await h.ui.rememberConnection();
  h.publishClient({ phase: "disconnected", connection: null });
  h.publishAccount({ accountId: "alice", clientId: "client-a" });
  assert.equal(h.ui.snapshot().lastDeviceId, "box-a");
  const saved = JSON.parse(await readFile(h.preferenceFile, "utf8"));
  assert.deepEqual(Object.values(saved.lastDevices).sort(), ["box-a", "box-b"]);
  assert.deepEqual(Object.keys(saved).sort(), ["lastDevices", "version"]);
  assert.doesNotMatch(JSON.stringify(saved), /client-a|client-b|token|password|privateKey/);
  await h.ui.dispose();
  const reloaded = await harness(t, { preferenceFile: h.preferenceFile });
  assert.equal(reloaded.ui.snapshot().lastDeviceId, "box-a");
  assert.deepEqual(reloaded.calls, []);
  const otherService = await harness(t, { preferenceFile: h.preferenceFile, serviceURL: "https://staging.example/prod-api" });
  assert.equal(otherService.ui.snapshot().lastDeviceId, null);
});

test("cancelled connections that resolve normally cannot launch the old intent", async t => {
  const h = await harness(t), connecting = deferred();
  h.setConnect(() => connecting.promise);
  const intent = await h.ui.requestOpen("example.app");
  const opening = h.ui.confirmOpen({ intentId: intent.id, deviceId: "box-a" });
  const rejected = assert.rejects(opening, { code: "APPLICATION_OPEN_CANCELLED" });
  await h.ui.cancelOpen({ intentId: intent.id });
  connecting.resolve(h.client.snapshot());
  await rejected;
  assert.deepEqual(h.calls, [["connect", "box-a"], ["disconnect"]]);
  assert.equal(h.ui.snapshot().pendingOpen, null);
  assert.deepEqual(h.opened, []);
});

test("manual box switching invalidates synchronously without disconnecting the newer box", async t => {
  const h = await harness(t), connecting = deferred();
  h.setConnect(() => connecting.promise);
  const intent = await h.ui.requestOpen("example.app");
  const opening = h.ui.confirmOpen({ intentId: intent.id, deviceId: "box-a" });
  const rejected = assert.rejects(opening, { code: "APPLICATION_OPEN_CANCELLED" });
  h.ui.invalidateOpen();
  h.publishClient({ phase: "ready", connection: { mode: "netbird", deviceId: "box-b" } });
  await h.ui.cancelOpen({ intentId: intent.id });
  connecting.resolve(h.client.snapshot());
  await rejected;
  assert.deepEqual(h.calls, [["connect", "box-a"]]);
  assert.equal(h.client.snapshot().connection.deviceId, "box-b");
  assert.deepEqual(h.opened, []);
});

test("a connection resolving to a different box does not launch and remains retryable", async t => {
  const h = await harness(t);
  h.setConnect(async () => h.publishClient({ phase: "ready", connection: { mode: "netbird", deviceId: "box-b" } }));
  const intent = await h.ui.requestOpen("example.app");
  await assert.rejects(h.ui.confirmOpen({ intentId: intent.id, deviceId: "box-a" }), { code: "NETWORK_CHANGED" });
  assert.equal(h.ui.snapshot().pendingOpen.phase, "failed");
  assert.equal(h.ui.snapshot().pendingOpen.error, "NETWORK_CHANGED");
  assert.deepEqual(h.calls, [["connect", "box-a"]]);
});

test("logout and login with identical IDs still revoke an in-flight open", async t => {
  const h = await harness(t), connecting = deferred();
  h.setConnect(() => connecting.promise);
  const intent = await h.ui.requestOpen("example.app");
  const opening = h.ui.confirmOpen({ intentId: intent.id, deviceId: "box-a" });
  const rejected = assert.rejects(opening, { code: "ACCOUNT_SESSION_CHANGED" });
  h.publishAccount({ phase: "signed_out" });
  assert.equal(h.ui.snapshot().lastDeviceId, null);
  h.publishAccount({ phase: "authenticated" });
  h.publishClient({ phase: "ready", connection: { mode: "netbird", deviceId: "box-a" } });
  connecting.resolve(h.client.snapshot());
  await rejected;
  assert.equal(h.ui.snapshot().pendingOpen, null);
  assert.deepEqual(h.calls, [["connect", "box-a"]]);
});

test("dismissal clears an unconfirmed choice but leaves confirmed work running", async t => {
  const h = await harness(t), connecting = deferred();
  const first = await h.ui.requestOpen("example.app");
  h.ui.dismissPanel();
  assert.equal(h.ui.snapshot().pendingOpen, null);
  await assert.rejects(h.ui.confirmOpen({ intentId: first.id, deviceId: "box-a" }), { code: "APPLICATION_OPEN_NOT_PENDING" });
  h.setConnect(() => connecting.promise);
  const second = await h.ui.requestOpen("example.app");
  const opening = h.ui.confirmOpen({ intentId: second.id, deviceId: "box-a" });
  h.ui.dismissPanel();
  assert.equal(h.ui.snapshot().pendingOpen.phase, "connecting");
  await assert.rejects(h.ui.requestOpen("example.other"), { code: "APPLICATION_OPEN_BUSY" });
  await assert.rejects(h.ui.confirmOpen({ intentId: second.id, deviceId: "box-a" }), { code: "APPLICATION_OPEN_BUSY" });
  h.publishClient({ phase: "ready", connection: { mode: "netbird", deviceId: "box-a" } });
  connecting.resolve(h.client.snapshot());
  await opening;
  assert.equal(h.opened.length, 1);
});

test("stale confirmation and cancellation cannot replace a later unconfirmed selection", async t => {
  const h = await harness(t);
  const first = await h.ui.requestOpen("example.first");
  const second = await h.ui.requestOpen("example.second");
  await assert.rejects(h.ui.confirmOpen({ intentId: first.id, deviceId: "box-a" }), { code: "APPLICATION_OPEN_NOT_PENDING" });
  await h.ui.cancelOpen({ intentId: first.id });
  assert.equal(h.ui.snapshot().pendingOpen.id, second.id);
  assert.deepEqual(h.calls, []);
});

test("per-application work blocks only that application and clears busy on completion", async t => {
  const h = await harness(t, { state: { phase: "ready", connection: { mode: "netbird", deviceId: "box-a" } } });
  const installing = deferred();
  const operation = h.ui.runApplicationOperation("example.installing", "installing", () => installing.promise);
  await assert.rejects(h.ui.runApplicationOperation("example.installing", "uninstalling", () => assert.fail("must not run")), { code: "MARKET_OPERATION_BUSY" });
  await assert.rejects(h.ui.requestOpen("example.installing"), { code: "MARKET_OPERATION_BUSY" });
  await h.ui.requestOpen("example.other");
  assert.equal(h.ui.snapshot().applicationOperations["example.installing"].phase, "installing");
  installing.resolve({ installed: true });
  assert.deepEqual(await operation, { installed: true });
  assert.deepEqual(h.ui.snapshot().applicationOperations, {});
  assert.ok(h.changes.some(change => change.applicationOperations["example.installing"]?.phase === "installing"));
});

test("failed work keeps only a safe error code and can be retried", async t => {
  const h = await harness(t);
  await assert.rejects(h.ui.runApplicationOperation("example.app", "installing", async () => { throw new Error("private download URL and credentials"); }));
  assert.deepEqual(h.ui.snapshot().applicationOperations["example.app"], { phase: "failed", error: "APPLICATION_OPERATION_FAILED" });
  await h.ui.runApplicationOperation("example.app", "installing", async () => "ok");
  assert.deepEqual(h.ui.snapshot().applicationOperations, {});
  assert.doesNotMatch(JSON.stringify(h.changes), /credentials/);
});

test("account change discards stale operation status without clearing a newer operation", async t => {
  const h = await harness(t), oldWork = deferred(), newWork = deferred();
  const previous = h.ui.runApplicationOperation("example.app", "installing", () => oldWork.promise);
  const rejected = assert.rejects(previous, { code: "ACCOUNT_CANCELLED" });
  h.publishAccount({ accountId: "bob", clientId: "client-b" });
  const current = h.ui.runApplicationOperation("example.app", "updating", () => newWork.promise);
  oldWork.reject(failure("ACCOUNT_CANCELLED"));
  await rejected;
  assert.equal(h.ui.snapshot().applicationOperations["example.app"].phase, "updating");
  newWork.resolve("ok");
  await current;
  assert.deepEqual(h.ui.snapshot().applicationOperations, {});
});

test("invalidating a pending application readiness result suppresses onOpened", async t => {
  const h = await harness(t, { state: { phase: "ready", connection: { mode: "netbird", deviceId: "box-a" } } });
  const ready = deferred();
  h.setLaunch(() => ready.promise);
  const opening = h.ui.requestOpen("example.app");
  const rejected = assert.rejects(opening, { code: "APPLICATION_OPEN_CANCELLED" });
  h.ui.invalidateOpen();
  ready.resolve({ applicationId: "example.app", state: "running" });
  await rejected;
  assert.deepEqual(h.opened, []);
  assert.equal(h.ui.snapshot().pendingOpen, null);
  assert.deepEqual(h.calls, [["launch", "example.app"]]);
});

test("cancel during opening stops the pending application without disconnecting the box", async t => {
  const h = await harness(t, { state: { phase: "ready", connection: { mode: "netbird", deviceId: "box-a" } } });
  const ready = deferred();
  h.setLaunch(() => ready.promise);
  h.setStop(async () => ready.reject(failure("APPLICATION_START_CANCELED")));
  const opening = h.ui.requestOpen("example.app");
  const rejected = assert.rejects(opening, { code: "APPLICATION_START_CANCELED" });
  await h.ui.cancelOpen({ intentId: h.ui.snapshot().pendingOpen.id });
  await rejected;
  assert.deepEqual(h.calls, [["launch", "example.app"], ["stop", "example.app"]]);
  assert.equal(h.client.snapshot().connection.deviceId, "box-a");
  assert.deepEqual(h.opened, []);
});

test("launch failures stay visible, and a non-ready result cannot count as opened", async t => {
  const h = await harness(t, { state: { phase: "ready", connection: { mode: "netbird", deviceId: "box-a" } } });
  h.setLaunch(async () => { throw failure("APPLICATION_START_TIMEOUT"); });
  await assert.rejects(h.ui.requestOpen("example.app"), { code: "APPLICATION_START_TIMEOUT" });
  assert.equal(h.ui.snapshot().pendingOpen.error, "APPLICATION_START_TIMEOUT");
  assert.equal(h.ui.snapshot().applicationOperations["example.app"].error, "APPLICATION_START_TIMEOUT");
  h.setLaunch(async () => ({ state: "starting" }));
  await assert.rejects(h.ui.requestOpen("example.app"), { code: "APPLICATION_START_FAILED" });
  assert.deepEqual(h.opened, []);
});

test("retrying a launch failure on its existing box does not reconnect or interrupt other apps", async t => {
  const h = await harness(t, { state: { phase: "ready", connection: { mode: "netbird", deviceId: "box-a" } } });
  h.setLaunch(async () => { throw failure("APPLICATION_START_TIMEOUT"); });
  await assert.rejects(h.ui.requestOpen("example.app"), { code: "APPLICATION_START_TIMEOUT" });
  const intent = h.ui.snapshot().pendingOpen;
  h.setLaunch(async id => {
    assert.equal(h.ui.snapshot().pendingOpen.phase, "opening");
    assert.equal(h.ui.snapshot().pendingOpen.error, undefined);
    return { applicationId: id, state: "running" };
  });
  await h.ui.confirmOpen({ intentId: intent.id, deviceId: "box-a" });
  assert.deepEqual(h.calls, [["launch", "example.app"], ["launch", "example.app"]]);
  assert.equal(h.opened.length, 1);
});

test("repeated connection events do not publish or write a preference loop", async t => {
  const h = await harness(t);
  h.publishClient({ phase: "ready", connection: { mode: "netbird", deviceId: "box-a" } });
  await h.ui.rememberConnection();
  const count = h.changes.length;
  for (let index = 0; index < 5; index++) h.publishClient({});
  await h.ui.rememberConnection();
  assert.equal(h.changes.length, count);
  assert.deepEqual(h.listenerCounts(), [1, 1]);
  await h.ui.dispose();
  assert.deepEqual(h.listenerCounts(), [0, 0]);
  await assert.rejects(h.ui.requestOpen("example.app"), { code: "UI_STATE_CLOSED" });
});

test("signed-out requests and unlisted targets never connect", async t => {
  const h = await harness(t);
  const intent = await h.ui.requestOpen("example.app");
  await assert.rejects(h.ui.confirmOpen({ intentId: intent.id, deviceId: "not-in-directory" }), { code: "NETWORK_DEVICE_ACCESS_DENIED" });
  h.publishAccount({ phase: "signed_out" });
  await assert.rejects(h.ui.requestOpen("example.app"), { code: "ACCOUNT_LOGIN_REQUIRED" });
  assert.deepEqual(h.calls, []);
});

test("malformed preference data falls back to an empty history", async t => {
  const h = await harness(t);
  await h.ui.dispose();
  await writeFile(h.preferenceFile, "{invalid");
  const next = await harness(t, { preferenceFile: h.preferenceFile });
  assert.equal(next.ui.snapshot().lastDeviceId, null);
});


test("registered local connection opens applications without cloud readiness", async t => {
  const h = await harness(t, { state: { phase: "ready", connection: { mode: "local", deviceId: "box-a" },
    network: { enabled: false, phase: "disabled" }, platform: { phase: "unavailable" } } });
  assert.equal((await h.ui.requestOpen("example.app")).state, "running");
  assert.deepEqual(h.calls, [["launch", "example.app"]]);
});

test("existing healthy box opens apps during management recovery without starting a new connection", async t => {
  const h = await harness(t, { state: { phase: "ready", connection: { mode: "netbird", deviceId: "box-a" }, network: { enabled: true, phase: "recovering" } } });
  assert.equal((await h.ui.requestOpen("example.app")).state, "running");
  assert.deepEqual(h.calls, [["launch", "example.app"]]);
  for (const patch of [{ phase: "recovering" }, { network: { enabled: true, phase: "unavailable" } }, { network: { enabled: false, phase: "recovering" } }, { platform: { phase: "unavailable" } }]) {
    const blocked = await harness(t, { state: { phase: "ready", connection: { mode: "netbird", deviceId: "box-a" }, network: { enabled: true, phase: "recovering" }, ...patch } });
    assert.equal((await blocked.ui.requestOpen("example.app")).phase, "confirm");
    assert.deepEqual(blocked.calls, []);
  }
});

const localIdentity = generation => ({ phase: 'unlocked', profileId: 'profile-a', clientId: 'local-client', generation,
  selected: { boxId: 'box-a', boxKeyThumbprint: 'box-pin-a', principalId: 'principal-a', bindingId: 'binding-a', ownershipEpoch: 1,
    authorizationVersion: 1, sessionId: `session-${generation}` } });

test('local data identity opens applications without cloud login and is not persisted in legacy preferences', async t => {
  const h = await harness(t, { state: { phase: 'ready', dataIdentity: localIdentity(1),
    connection: { mode: 'lan', deviceId: 'box-a', authorization: 'local-trust-v1' }, network: { enabled: false } } });
  h.publishAccount({ phase: 'signed_out' });
  assert.equal((await h.ui.requestOpen('example.app')).state, 'running');
  await h.ui.rememberConnection();
  await assert.rejects(readFile(h.preferenceFile), { code: 'ENOENT' });
});

test('local lock and immediate unlock invalidate an in-flight application launch', async t => {
  const h = await harness(t, { state: { phase: 'ready', dataIdentity: localIdentity(1),
    connection: { mode: 'lan', deviceId: 'box-a', authorization: 'local-trust-v1' } } });
  const ready = deferred(); h.setLaunch(() => ready.promise);
  const pending = h.ui.requestOpen('example.app');
  const rejected = assert.rejects(pending, { code: 'ACCOUNT_SESSION_CHANGED' });
  h.publishClient({ dataIdentity: { ...localIdentity(2), phase: 'locked', selected: null } });
  assert.equal(h.ui.snapshot().pendingOpen, null);
  assert.equal(h.ui.snapshot().lastDeviceId, null);
  await assert.rejects(h.ui.requestOpen('example.app'), { code: 'LOCAL_TRUST_LOCKED' });
  h.publishClient({ dataIdentity: localIdentity(3) });
  ready.resolve({ state: 'running' }); await rejected;
  assert.deepEqual(h.opened, []);
});


test("required client updates block new intents and pending confirmations without preventing cancellation", async t => {
  let required = false;
  const h = await harness(t, { assertClientUsable() { if (required) throw failure("CLIENT_UPDATE_REQUIRED"); } });
  const intent = await h.ui.requestOpen("example.app");
  required = true;
  await assert.rejects(h.ui.confirmOpen({ intentId: intent.id, deviceId: "box-a" }), { code: "CLIENT_UPDATE_REQUIRED" });
  assert.deepEqual(h.calls, []);
  await h.ui.cancelOpen({ intentId: intent.id });
  assert.equal(h.ui.snapshot().pendingOpen, null);
  await assert.rejects(h.ui.requestOpen("example.app"), { code: "CLIENT_UPDATE_REQUIRED" });
  required = false;
  assert.equal((await h.ui.requestOpen("example.app")).phase, "confirm");
});

test("an update discovered while connecting prevents the deferred application launch", async t => {
  let required = false;
  const h = await harness(t, { assertClientUsable() { if (required) throw failure("CLIENT_UPDATE_REQUIRED"); } });
  const connected = deferred();
  h.setConnect(async () => { await connected.promise; h.publishClient({ phase: "ready", connection: { deviceId: "box-a", mode: "netbird" } }); });
  const intent = await h.ui.requestOpen("example.app");
  const rejected = assert.rejects(h.ui.confirmOpen({ intentId: intent.id, deviceId: "box-a" }), { code: "CLIENT_UPDATE_REQUIRED" });
  required = true; connected.resolve(); await rejected;
  assert.deepEqual(h.calls, [["connect", "box-a"]]);
  assert.equal(h.ui.snapshot().pendingOpen.error, "CLIENT_UPDATE_REQUIRED");
});
