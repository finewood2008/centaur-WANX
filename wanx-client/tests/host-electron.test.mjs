import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../host-sdk/electron.cjs", import.meta.url), "utf8");

function fixture(env = {}) {
  const app = new EventEmitter(), process = new EventEmitter(), module = { exports: {} };
  const paths = {}, messages = [];
  app.setPath = (key, value) => { paths[key] = value; };
  app.focus = () => {};
  process.env = env;
  process.send = message => messages.push(JSON.parse(JSON.stringify(message)));
  vm.runInNewContext(source, { process, module, require: () => ({ app }) });
  return { app, process, paths, messages, attach: module.exports.attachElectronHost };
}

const environment = { WANX_HOST_LAUNCH_ID: "launch", WANX_HOST_TOKEN: "test-token", WANX_HOST_CLIENT_APPLICATION_ID: "test.app", WANX_HOST_USER_DATA_DIR: "isolated-profile" };

test("bundled Electron helper leaves standalone startup alone and rejects incomplete Host sessions", () => {
  const standalone = fixture();
  assert.equal(standalone.attach(), false);
  assert.deepEqual(standalone.paths, {});
  assert.throws(() => fixture({ WANX_HOST_TOKEN: "partial" }).attach(), { code: "HOST_SESSION_MISSING" });
});

test("bundled Electron helper isolates its profile, reports actual window readiness and handles activation", () => {
  const f = fixture(environment);
  assert.equal(f.attach(), true);
  assert.deepEqual(f.paths, { userData: "isolated-profile", sessionData: "isolated-profile" });
  const webContents = new EventEmitter();
  let shown = 0, restored = 0;
  const window = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false, isMinimized: () => true,
    restore: () => restored++, show: () => shown++, focus() {} });
  f.app.emit("browser-window-created", {}, window);
  assert.deepEqual(f.messages, []);
  webContents.emit("did-fail-load", {}, -3, "aborted", "", true);
  assert.deepEqual(f.messages, []);
  webContents.emit("did-finish-load");
  f.app.emit("before-quit");
  assert.deepEqual(f.messages, [{ type: "wanx:application-ready", launchId: "launch" }]);
  f.process.emit("message", { type: "wanx:application-activate", launchId: "wrong" });
  assert.equal(shown, 0);
  f.process.emit("message", { type: "wanx:application-activate", launchId: "launch" });
  assert.equal(shown, 1);
  assert.equal(restored, 1);
});

test("bundled Electron helper reports a failed main frame without exposing diagnostics", () => {
  const f = fixture(environment);
  f.attach();
  const webContents = new EventEmitter();
  f.app.emit("browser-window-created", {}, Object.assign(new EventEmitter(), { webContents }));
  webContents.emit("did-fail-load", {}, -105, "private detail", "private URL", true);
  webContents.emit("did-finish-load");
  assert.deepEqual(f.messages, [{ type: "wanx:application-failed", launchId: "launch" }]);
});
