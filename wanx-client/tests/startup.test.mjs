import test from "node:test";
import assert from "node:assert/strict";
import { createStartupSettings } from "../shell/startup.mjs";

function harness({ isPackaged = true, platform = "darwin", settings = {} } = {}) {
  const writes = [];
  let current = { openAtLogin: false, status: "not-registered", wasOpenedAtLogin: false, ...settings };
  let reads = 0;
  let afterWrite;
  const app = {
    isPackaged,
    getLoginItemSettings() { reads++; return { ...current }; },
    setLoginItemSettings(value) {
      writes.push(value);
      current = afterWrite || { ...current, openAtLogin: value.openAtLogin, status: value.openAtLogin ? "enabled" : "not-registered" };
    },
  };
  const startup = createStartupSettings({ app, platform });
  return {
    startup, writes, get reads() { return reads; },
    update(value) { current = { ...current, ...value }; },
    afterWrite(value) { afterWrite = { ...current, ...value }; },
  };
}

test("development and non-Mac builds never read or register the executable as a login item", () => {
  for (const options of [{ isPackaged: false }, { platform: "win32" }]) {
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
