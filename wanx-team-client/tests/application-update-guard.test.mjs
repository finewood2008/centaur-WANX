import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplicationManager } from "../applications/manager.mjs";
import { createApplicationLauncher } from "../applications/launcher.mjs";

const required = () => { throw Object.assign(new Error("CLIENT_UPDATE_REQUIRED"), { code: "CLIENT_UPDATE_REQUIRED" }); };
const record = { applicationId: "test.app", version: "1.0.0", installPath: path.resolve("installed/app"), entrypoint: "main.cjs" };

test("manager rejects direct launches before looking up or preparing an application", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-update-manager-"));
  const manager = await createApplicationManager({ applicationRoot: directory, assertClientUsable: required });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(manager.launch("test.app"), { code: "CLIENT_UPDATE_REQUIRED" });
  if (manager.studio) {
    assert.throws(() => manager.studio.open({}), { code: "CLIENT_UPDATE_REQUIRED" });
    assert.throws(() => manager.studio.launchStart({}), { code: "CLIENT_UPDATE_REQUIRED" });
    assert.throws(() => manager.studio.previewOpen({}), { code: "CLIENT_UPDATE_REQUIRED" });
    assert.deepEqual(await manager.studio.previewClose({ handle: "expired" }), { closed: true });
  }
  assert.equal(manager.activate("test.app"), false);
  assert.equal((await manager.stop("test.app")).state, "stopped");
});

test("a requirement discovered during record resolution blocks process and session creation", async () => {
  let force = false, resolveRecord, sessions = 0, spawned = 0;
  const launcher = createApplicationLauncher({
    assertClientUsable() { if (force) required(); },
    resolveRecord: () => new Promise(resolve => { resolveRecord = resolve; }),
    host: { createSession() { sessions++; throw new Error("must not create session"); } },
    spawn() { spawned++; throw new Error("must not spawn"); },
  });
  const rejected = assert.rejects(launcher.launch(record), { code: "CLIENT_UPDATE_REQUIRED" });
  await setImmediate(); force = true; resolveRecord(record);
  await rejected;
  assert.equal(sessions, 0); assert.equal(spawned, 0); await launcher.close();
});

test("a requirement discovered during session preparation closes that session without launching", async () => {
  let force = false, resolveSession, closed = 0, spawned = 0;
  const launcher = createApplicationLauncher({
    assertClientUsable() { if (force) required(); },
    host: { createSession: () => new Promise(resolve => { resolveSession = resolve; }) },
    spawn() { spawned++; throw new Error("must not spawn"); },
  });
  const rejected = assert.rejects(launcher.launch(record), { code: "CLIENT_UPDATE_REQUIRED" });
  await setImmediate(); force = true;
  resolveSession({ launchId: "one", environment: {}, close() { closed++; } });
  await rejected;
  assert.equal(spawned, 0); assert.equal(closed, 1); await launcher.close();
});

test("a requirement discovered while preparing desktop identity blocks session creation", async () => {
  let force = false, resolveExecutable, sessions = 0, spawned = 0;
  const launcher = createApplicationLauncher({
    assertClientUsable() { if (force) required(); },
    resolveExecutable: () => new Promise(resolve => { resolveExecutable = resolve; }),
    host: { createSession() { sessions++; throw new Error("must not create session"); } },
    spawn() { spawned++; throw new Error("must not spawn"); },
  });
  const rejected = assert.rejects(launcher.launch(record), { code: "CLIENT_UPDATE_REQUIRED" });
  await setImmediate(); force = true; resolveExecutable("application-runtime");
  await rejected;
  assert.equal(sessions, 0); assert.equal(spawned, 0); await launcher.close();
});

test("running applications can still be activated and closed after an update becomes required", async () => {
  let force = false, child, closed = 0;
  const launcher = createApplicationLauncher({
    assertClientUsable() { if (force) required(); },
    host: { createSession: async () => ({ launchId: "one", environment: {}, close() { closed++; } }) },
    spawn() { child = new EventEmitter(); child.send = () => {}; child.kill = () => child.emit("exit", 0); return child; },
  });
  const started = launcher.launch(record); await setImmediate();
  child.emit("message", { type: "wanx:application-ready", launchId: "one" });
  await started; force = true;
  assert.equal(launcher.activate(record.applicationId), true);
  assert.equal((await launcher.stop(record.applicationId)).state, "stopped");
  assert.equal(closed, 1); await launcher.close();
});
