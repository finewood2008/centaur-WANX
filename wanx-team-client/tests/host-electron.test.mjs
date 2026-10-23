import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../host-sdk/electron.cjs", import.meta.url), "utf8");

function fixture(env = {}, platform = "darwin") {
  const app = new EventEmitter(), process = new EventEmitter(), module = { exports: {} };
  const paths = {}, messages = [];
  app.setPath = (key, value) => { paths[key] = value; };
  app.focus = () => {};
  process.env = env;
  process.platform = platform;
  process.send = message => messages.push(JSON.parse(JSON.stringify(message)));
  vm.runInNewContext(source, { process, module, require: () => ({ app }) });
  return { app, process, paths, messages, attach: module.exports.attachElectronHost };
}

const environment = { WANX_HOST_LAUNCH_ID: "launch", WANX_HOST_TOKEN: "test-token", WANX_HOST_CLIENT_APPLICATION_ID: "test.app", WANX_HOST_USER_DATA_DIR: "isolated-profile" };

for (const platform of ["win32", "darwin"]) {
  test(`bundled Electron helper changes window menus only for Windows Host sessions (${platform})`, () => {
    for (const hosted of [false, true]) {
      const f = fixture(hosted ? environment : {}, platform);
      assert.equal(f.attach(), hosted);
      assert.equal(f.app.listenerCount("browser-window-created"), hosted ? 1 : 0);
      const menuCalls = [];
      for (let index = 0; index < 2; index++) {
        const webContents = new EventEmitter();
        const window = Object.assign(new EventEmitter(), { webContents,
          setMenu: value => menuCalls.push([index, "menu", value]),
          setMenuBarVisibility: value => menuCalls.push([index, "visible", value]),
        });
        f.app.emit("browser-window-created", {}, window);
        assert.deepEqual(menuCalls, hosted && platform === "win32"
          ? Array.from({ length: index + 1 }, (_, n) => [[n, "menu", null], [n, "visible", false]]).flat()
          : []);
        webContents.emit("did-finish-load");
        window.emit("closed");
      }
      f.process.emit("message", { type: "wanx:application-activate", launchId: "launch" });
      f.app.emit("before-quit");
      assert.deepEqual(f.messages, hosted ? [{ type: "wanx:application-ready", launchId: "launch" }] : []);
    }
  });
}

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
