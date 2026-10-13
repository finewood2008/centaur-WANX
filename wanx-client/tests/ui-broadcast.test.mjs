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

test("a later publish supersedes older asynchronous application-list reads in both windows", async () => {
  const h = harness();
  const older = h.broadcaster.publish();
  h.update({ state: { phase: "disconnected", connection: null }, ui: { lastDeviceId: "box-b" } });
  const newer = h.broadcaster.publish();
  const latest = [{ applicationId: "example.new", version: "2.0.0" }];
  h.reads[1].resolve(latest);
  await newer;
  h.useImmediateReads(latest);
  h.reads[0].resolve([{ applicationId: "example.old", version: "1.0.0" }]);
  await older;
  assert.equal(h.panel.sent.length, 1);
  assert.deepEqual(h.panel.sent, h.management.sent);
  const [channel, value] = h.panel.sent[0];
  assert.equal(channel, "wanx-client:state");
  assert.equal(value.connection, null);
  assert.equal(value.ui.lastDeviceId, "box-b");
  assert.equal(value.applications[0].applicationId, "example.new");
  assert.deepEqual(h.errors, []);
});

test("connection, UI, and startup state are sampled after the asynchronous app read", async () => {
  const h = harness();
  const publishing = h.broadcaster.publish();
  h.update({
    state: { phase: "recovering", connection: { deviceId: "box-a" } },
    ui: { applicationOperations: { "example.app": { phase: "installing" } } },
    startup: { supported: true, enabled: true },
  });
  h.reads[0].resolve([]);
  await publishing;
  assert.deepEqual(h.panel.sent, h.management.sent);
  const value = h.panel.sent[0][1];
  assert.equal(value.phase, "recovering");
  assert.equal(value.ui.applicationOperations["example.app"].phase, "installing");
  assert.equal(value.desktopStartup.enabled, true);
});

test("destroyed windows and destroyed web contents receive no broadcast", async () => {
  const h = harness();
  const publishing = h.broadcaster.publish();
  h.panel.destroyed = true;
  h.management.webContents.destroyed = true;
  h.reads[0].resolve([]);
  await publishing;
  assert.deepEqual(h.panel.sent, []);
  assert.deepEqual(h.management.sent, []);
  assert.deepEqual(h.errors, []);
});

test("the live window registry is read when publishing completes", async () => {
  const h = harness(), replacement = windowFixture();
  const publishing = h.broadcaster.publish();
  h.update({ windows: [null, replacement] });
  h.reads[0].resolve([]);
  await publishing;
  assert.equal(replacement.sent.length, 1);
  assert.deepEqual(h.panel.sent, []);
  assert.deepEqual(h.management.sent, []);
});

test("disposing during an in-flight read suppresses delivery", async () => {
  const h = harness();
  const publishing = h.broadcaster.publish();
  h.broadcaster.dispose();
  h.reads[0].resolve([]);
  await publishing;
  assert.deepEqual(h.panel.sent, []);
  assert.deepEqual(h.management.sent, []);
});

test("failed reads report an error without sending a partial state", async () => {
  const h = harness(), error = new Error("installed records unavailable");
  const publishing = h.broadcaster.publish();
  h.reads[0].reject(error);
  await publishing;
  assert.deepEqual(h.errors, [error]);
  assert.deepEqual(h.panel.sent, []);
  assert.deepEqual(h.management.sent, []);
});

test("an older direct get-state read cannot replace apps already delivered by a newer broadcast", async () => {
  const h = harness();
  const direct = h.broadcaster.getState();
  const publishing = h.broadcaster.publish();
  const latest = [{ applicationId: "example.app", version: "2.0.0" }];
  h.reads[1].resolve(latest);
  await publishing;
  h.useImmediateReads(latest);
  h.reads[0].resolve([{ applicationId: "example.app", version: "1.0.0" }]);
  const value = await direct;
  assert.deepEqual(value.applications, h.panel.sent[0][1].applications);
});
