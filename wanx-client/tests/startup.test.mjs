import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStartupSettings } from "../shell/startup.mjs";

function harness({ isPackaged = true, platform = "darwin", settings = {}, preferenceFile, installed = false, executable, argv } = {}) {
  const writes = [];
  let current = { openAtLogin: false, status: "not-registered", wasOpenedAtLogin: false, ...settings };
  let reads = 0;
  let afterWrite;
  const app = {
    isPackaged,
    isInApplicationsFolder: () => installed,
    ...(executable ? { getPath: key => key === "exe" ? executable : path.dirname(preferenceFile) } : {}),
    getLoginItemSettings(options) { app.readOptions = options; reads++; return { ...current }; },
    setLoginItemSettings(value) {
      writes.push(value);
      current = afterWrite || { ...current, openAtLogin: value.openAtLogin, status: value.openAtLogin ? "enabled" : "not-registered" };
    },
  };
  const startup = createStartupSettings({ app, platform, preferenceFile, argv });
  return {
    app, startup, writes, get reads() { return reads; },
    update(value) { current = { ...current, ...value }; },
    afterWrite(value) { afterWrite = { ...current, ...value }; },
  };
}

test("raw development runtimes and unsupported platforms never register a login item", () => {
  for (const options of [{ isPackaged: false }, { platform: "win32", isPackaged: false }, { platform: "linux" }]) {
    const h = harness(options);
    assert.equal(h.startup.get().supported, false);
    assert.equal(h.startup.set(true).enabled, false);
    assert.match(h.startup.get().reason, /万象|此版本/);
    assert.equal(h.startup.wasOpenedAtLogin(), false);
    assert.equal(h.reads, 0);
    assert.deepEqual(h.writes, []);
  }
});

test("packaged Mac startup defaults to reading the system and writes only on an explicit setting change", () => {
  const h = harness();
  assert.equal(h.reads, 0);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.startup.get(), { supported: true, enabled: false, status: "not-registered", reason: null });
  assert.deepEqual(h.writes, []);
  assert.equal(h.startup.set(true).enabled, true);
  assert.deepEqual(h.writes, [{ openAtLogin: true }]);
  assert.equal(h.reads, 2, "the result must be reread after changing the OS setting");
  assert.equal(h.startup.set(false).enabled, false);
  assert.deepEqual(h.writes, [{ openAtLogin: true }, { openAtLogin: false }]);
});

test("requires-approval is returned as pending rather than claiming startup is enabled", () => {
  const h = harness();
  h.afterWrite({ openAtLogin: true, status: "requires-approval" });
  const state = h.startup.set(true);
  assert.equal(state.supported, true);
  assert.equal(state.enabled, false);
  assert.equal(state.status, "requires-approval");
  assert.match(state.reason, /系统设置.*允许/);
  h.update({ openAtLogin: true, status: "enabled" });
  assert.equal(h.startup.get().enabled, true, "external System Settings changes must be reflected");
  assert.equal(h.writes.length, 1);
});

test("login launch detection reads wasOpenedAtLogin and never relies on deprecated openAsHidden", () => {
  const h = harness({ settings: { openAtLogin: true, status: "enabled", wasOpenedAtLogin: true, wasOpenedAsHidden: false } });
  assert.equal(h.startup.wasOpenedAtLogin(), true);
  h.update({ wasOpenedAtLogin: false, wasOpenedAsHidden: true });
  assert.equal(h.startup.wasOpenedAtLogin(), false);
  assert.deepEqual(h.writes, []);
});

test("older Mac status omission follows openAtLogin and invalid inputs never write", () => {
  const h = harness({ settings: { status: undefined, openAtLogin: true } });
  assert.equal(h.startup.get().enabled, true);
  assert.throws(() => h.startup.set("false"), /布尔值/);
  assert.deepEqual(h.writes, []);
  h.update({ status: "not-found" });
  assert.equal(h.startup.get().enabled, false);
  assert.match(h.startup.get().reason, /未找到/);
});

function preferences(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wanx-startup-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "startup.json");
}
test("first launch enables login once and preserves an explicit opt-out across restarts", t => {
  const preferenceFile = preferences(t);
  const first = harness({ preferenceFile });
  assert.equal(first.startup.initializeDefault().enabled, true);
  assert.deepEqual(first.writes, [{ openAtLogin: true }]);
  first.startup.initializeDefault();
  assert.equal(first.writes.length, 1);
  first.startup.set(false);
  const restarted = harness({ preferenceFile });
  assert.equal(restarted.startup.initializeDefault().enabled, false);
  assert.deepEqual(restarted.writes, []);
  assert.equal(JSON.parse(readFileSync(preferenceFile)).enabled, false);
});
test("existing enabled or pending system registration is not rewritten", t => {
  for (const status of ["enabled", "requires-approval"]) {
    const h = harness({ preferenceFile: preferences(t), settings: { openAtLogin: true, status } });
    assert.equal(h.startup.initializeDefault().status, status);
    assert.deepEqual(h.writes, []);
  }
});
test("a later System Settings opt-out is not overridden by startup defaults", t => {
  const preferenceFile = preferences(t);
  harness({ preferenceFile }).startup.initializeDefault();
  const restarted = harness({ preferenceFile, settings: { openAtLogin: false, status: "not-registered" } });
  assert.equal(restarted.startup.initializeDefault().enabled, false);
  assert.deepEqual(restarted.writes, []);
});
test("installed branded Mac source bundle supports login settings while raw Electron does not", t => {
  const preferenceFile = preferences(t);
  const branded = harness({ isPackaged: false, installed: true, preferenceFile,
    executable: "/Users/test/Applications/半人马AI-万象.app/Contents/MacOS/Electron" });
  assert.equal(branded.startup.initializeDefault().enabled, true);
  const electron = harness({ isPackaged: false, installed: true, preferenceFile,
    executable: "/Applications/Electron.app/Contents/MacOS/Electron" });
  assert.equal(electron.startup.initializeDefault().supported, false);
  assert.deepEqual(electron.writes, []);
});
test("first registration requiring system approval remains pending and is not retried every launch", t => {
  const preferenceFile = preferences(t);
  const h = harness({ preferenceFile });
  h.afterWrite({ openAtLogin: true, status: "requires-approval" });
  assert.equal(h.startup.initializeDefault().enabled, false);
  assert.equal(h.startup.get().status, "requires-approval");
  h.startup.initializeDefault();
  assert.equal(h.writes.length, 1);
});

test("an installed bundle with a missing system registration is registered on first launch", t => {
  const h = harness({ preferenceFile: preferences(t), settings: { status: "not-found" } });
  assert.equal(h.startup.initializeDefault().enabled, true);
  assert.deepEqual(h.writes, [{ openAtLogin: true }]);
});

test("packaged Windows registers the installed executable with a silent login flag by default", t => {
  const preferenceFile = preferences(t);
  const executable = "C:\\Program Files\\WanX\\WanX.exe";
  const h = harness({ platform: "win32", preferenceFile, executable, argv: [executable] });
  assert.equal(h.startup.initializeDefault().enabled, true);
  const options = { path: executable, args: ["--wanx-login-startup"] };
  assert.deepEqual(h.app.readOptions, options);
  assert.deepEqual(h.writes, [{ openAtLogin: true, ...options, enabled: true, name: "半人马AI-万象" }]);
  assert.equal(h.startup.wasOpenedAtLogin(), false);
  h.startup.set(false);
  const restarted = harness({ platform: "win32", preferenceFile, executable, argv: [executable] });
  assert.equal(restarted.startup.initializeDefault().enabled, false);
  assert.deepEqual(restarted.writes, []);
  const login = harness({ platform: "win32", preferenceFile, executable, argv: [executable, "--wanx-login-startup"] });
  assert.equal(login.startup.wasOpenedAtLogin(), true);
});
test("Windows Task Manager disabled state is respected rather than re-enabled on every launch", t => {
  const h = harness({ platform: "win32", preferenceFile: preferences(t), executable: "C:/WanX/WanX.exe",
    settings: { openAtLogin: true, executableWillLaunchAtLogin: false, status: undefined } });
  assert.equal(h.startup.initializeDefault().status, "disabled");
  assert.equal(h.startup.get().enabled, false);
  assert.deepEqual(h.writes, []);
});
