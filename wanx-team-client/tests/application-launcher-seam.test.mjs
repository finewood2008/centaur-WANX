import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createApplicationLauncher } from "../applications/launcher.mjs";

const record = { applicationId: "test.app", version: "1.0.0", installPath: path.resolve("installed/app"), entrypoint: "main.cjs" };
function harness() {
  const child = new EventEmitter();
  child.exitCode = null;
  const messages = [];
  child.send = message => messages.push(message);
  child.kill = () => { child.exitCode = 1; child.emit("exit", 1); };
  let closed = 0, invocation;
  const launcher = createApplicationLauncher({
    electronPath: "wanx-runtime", runtimeArgs: ["wanx-source"],
    host: { async createSession() { return { launchId: "launch-1", environment: {}, async close() { closed++; } }; } },
    spawn(file, args, options) { invocation = { file, args, options }; return child; },
  });
  return { launcher, child, messages, get closed() { return closed; }, get invocation() { return invocation; } };
}

test("launch dispatches to the installed app and only reports running after its window loads", async () => {
  const h = harness();
  let settled = false;
  const launched = h.launcher.launch(record).then(value => { settled = true; return value; });
  await setImmediate();
  assert.equal(settled, false, "spawning a process does not prove the app started");
  assert.deepEqual(h.invocation.args, ["wanx-source", `--wanx-application=${record.installPath}`]);
  assert.equal(h.invocation.options.stdio.at(-1), "ipc");
  h.child.emit("message", { type: "wanx:application-ready", launchId: "unrelated" });
  await setImmediate();
  assert.equal(settled, false);
  h.child.emit("message", { type: "wanx:application-ready", launchId: "launch-1" });
  assert.equal((await launched).state, "running");
  assert.equal(h.launcher.activate(record.applicationId), true);
  await h.launcher.launch(record);
  assert.deepEqual(h.messages, Array(2).fill({ type: "wanx:application-activate", launchId: "launch-1" }));
  await h.launcher.stop(record.applicationId);
  assert.equal(h.launcher.activate(record.applicationId), false);
  assert.equal(h.closed, 1);
});

test("an immediate child exit rejects launch and revokes the session instead of claiming running", async () => {
  const h = harness();
  const rejected = assert.rejects(h.launcher.launch(record), { code: "APPLICATION_START_FAILED" });
  await setImmediate();
  h.child.kill();
  await rejected;
  assert.equal((await h.launcher.stop(record.applicationId)).state, "stopped");
  assert.equal(h.closed, 1);
});

test("a child load failure is surfaced without leaking child diagnostics or credentials", async () => {
  const h = harness();
  const rejected = assert.rejects(h.launcher.launch(record), { code: "APPLICATION_START_FAILED", message: "APPLICATION_START_FAILED" });
  await setImmediate();
  h.child.emit("message", { type: "wanx:application-failed", launchId: "launch-1", detail: "private diagnostic" });
  await rejected;
  assert.equal(h.closed, 1);
});

test("bundled launch uses the installed executable, isolates its data, and still waits for readiness", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wanx-bundled-launch-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installPath = path.join(root, "applications", record.applicationId, record.version);
  await mkdir(installPath, { recursive: true });
  await writeFile(path.join(installPath, "app.exe"), "fixture", { mode: 0o755 });
  const bundled = { ...record, installPath, entrypoint: "app.exe", launchMode: "bundled", platform: process.platform, arch: process.arch };
  const h = harness();
  const launched = h.launcher.launch(bundled);
  while (!h.invocation) await setImmediate();
  assert.equal(h.invocation.file, path.join(installPath, "app.exe"));
  assert.deepEqual(h.invocation.args, []);
  assert.ok(h.invocation.options.env.WANX_HOST_USER_DATA_DIR.endsWith(path.join(".runtime", "test.app")));
  h.child.emit("message", { type: "wanx:application-ready", launchId: "launch-1" });
  assert.equal((await launched).state, "running");
  await h.launcher.stop(record.applicationId);
  await assert.rejects(h.launcher.launch({ ...bundled, platform: process.platform === "win32" ? "darwin" : "win32" }), { code: "APPLICATION_PLATFORM_UNSUPPORTED" });
});
