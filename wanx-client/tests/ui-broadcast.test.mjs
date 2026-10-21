import test from "node:test";
import assert from "node:assert/strict";
import { createUIBroadcast } from "../shell/ui-broadcast.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function windowFixture() {
  const sent = [];
  return {
    sent, destroyed: false, isDestroyed() { return this.destroyed; },
    webContents: {
      destroyed: false, isDestroyed() { return this.destroyed; },
      send(channel, value) { sent.push([channel, structuredClone(value)]); },
    },
  };
}
function harness() {
  const panel = windowFixture(), management = windowFixture(), reads = [], errors = [];
  let state = { phase: "ready", connection: { deviceId: "box-a" } };
  let ui = { lastDeviceId: "box-a", pendingOpen: null, applicationOperations: {} };
  let startup = { supported: true, enabled: false };
  let windows = [panel, management];
  let immediateReads;
  const broadcaster = createUIBroadcast({
    client: { snapshot: () => structuredClone(state) },
    applications: { listInstalled() {
      if (immediateReads !== undefined) return Promise.resolve(structuredClone(immediateReads));
      const read = deferred(); reads.push(read); return read.promise;
    } },
    uiState: { snapshot: () => structuredClone(ui) }, startup: { get: () => structuredClone(startup) },
    windows: () => windows, onError: error => errors.push(error),
  });
  return { broadcaster, panel, management, reads, errors,
    useImmediateReads(value) { immediateReads = value; },
    update(input) {
      if (input.state) state = input.state;
      if (input.ui) ui = input.ui;
      if (input.startup) startup = input.startup;
      if (input.windows) windows = input.windows;
    },
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test("connection, UI, and startup changes publish before the asynchronous app read", async () => {
  const h = harness();
  h.broadcaster.publish();
  h.update({ state: { phase: "recovering", connection: { deviceId: "box-a" } },
    ui: { applicationOperations: { "example.app": { phase: "installing" } } },
    startup: { supported: true, enabled: true } });
  h.broadcaster.publish();
  assert.deepEqual(h.panel.sent, h.management.sent);
  const value = h.panel.sent.at(-1)[1];
  assert.equal(value.phase, "recovering");
  assert.equal(value.ui.applicationOperations["example.app"].phase, "installing");
  assert.equal(value.desktopStartup.enabled, true);
  assert.deepEqual(value.applications, []);
  await tick();
  assert.equal(h.reads.length, 1, "overlapping state requests share an app read");
  h.reads[0].resolve([{ applicationId: "example.app" }]);
  await tick();
  assert.equal(h.panel.sent.at(-1)[1].applications[0].applicationId, "example.app");
  h.broadcaster.dispose();
});

test("cached apps remain available while a later scan is queued, with one trailing scan for changes", async () => {
  const h = harness();
  assert.deepEqual(h.broadcaster.getState().applications, []);
  await tick();
  h.reads[0].resolve([{ applicationId: "example.app", version: "1.0.0" }]);
  await tick();
  for (let i = 0; i < 20; i++) {
    assert.equal(h.broadcaster.getState().applications[0].version, "1.0.0");
    h.broadcaster.publish();
  }
  await tick();
  assert.equal(h.reads.length, 2);
  h.reads[1].resolve([{ applicationId: "example.app", version: "2.0.0" }]);
  await tick();
  assert.equal(h.reads.length, 3);
  h.reads[2].resolve([{ applicationId: "example.app", version: "3.0.0" }]);
  await tick();
  assert.equal(h.reads.length, 3, "reading the app result does not schedule another scan");
  assert.equal(h.panel.sent.at(-1)[1].applications[0].version, "3.0.0");
  h.broadcaster.dispose();
});

for (const change of ["logout", "account", "box"]) {
  test(`a ${change} immediately drops cached apps and ignores late previous-scope reads`, async () => {
    const h = harness();
    const original = { phase: "ready", account: { phase: "authenticated", accountId: "owner-a", clientId: "client-a" },
      connection: { deviceId: "box-a", mode: "netbird" } };
    h.update({ state: original });
    h.broadcaster.publish(); await tick();
    h.reads[0].resolve([{ applicationId: "example.old", version: "1.0.0" }]); await tick();
    h.broadcaster.publish(); await tick();
    h.update({ state: change === "logout"
      ? { phase: "disconnected", account: { phase: "signed_out" }, connection: null }
      : { ...original, ...(change === "account"
        ? { account: { phase: "authenticated", accountId: "owner-b", clientId: "client-b" } }
        : { connection: { deviceId: "box-b", mode: "netbird" } }) } });
    h.broadcaster.publish();
    assert.deepEqual(h.panel.sent.at(-1)[1].applications, []);
    await tick();
    assert.equal(h.reads.length, 3);
    h.reads[2].resolve([{ applicationId: "example.new" }]); await tick();
    h.reads[1].resolve([{ applicationId: "example.old", version: "2.0.0" }]); await tick();
    assert.equal(h.panel.sent.at(-1)[1].applications[0].applicationId, "example.new");
    assert.deepEqual(h.panel.sent, h.management.sent);
    h.broadcaster.dispose();
  });
}

test("destroyed windows and destroyed web contents receive no broadcast", async () => {
  const h = harness();
  h.panel.destroyed = true;
  h.management.webContents.destroyed = true;
  h.broadcaster.publish(); await tick();
  h.reads[0].resolve([]); await tick();
  assert.deepEqual(h.panel.sent, []);
  assert.deepEqual(h.management.sent, []);
  assert.deepEqual(h.errors, []);
});

test("background delivery uses the live window registry", async () => {
  const h = harness(), replacement = windowFixture();
  h.broadcaster.publish(); await tick();
  h.update({ windows: [null, replacement] });
  h.reads[0].resolve([]); await tick();
  assert.equal(replacement.sent.length, 1);
  assert.equal(h.panel.sent.length, 1);
  assert.equal(h.management.sent.length, 1);
});

test("disposing during an in-flight read suppresses late delivery", async () => {
  const h = harness();
  h.broadcaster.publish(); await tick();
  const count = h.panel.sent.length;
  h.broadcaster.dispose();
  h.reads[0].resolve([]); await tick();
  assert.equal(h.panel.sent.length, count);
  assert.equal(h.management.sent.length, count);
});

test("failed app reads preserve current account state and report the error", async () => {
  const h = harness(), error = new Error("installed records unavailable");
  h.broadcaster.publish(); await tick();
  h.reads[0].reject(error); await tick();
  assert.deepEqual(h.errors, [error]);
  assert.equal(h.panel.sent.length, 1);
  assert.equal(h.panel.sent[0][1].phase, "ready");
  assert.deepEqual(h.panel.sent, h.management.sent);
});
