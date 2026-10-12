import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplicationInstaller } from "../applications/installer.mjs";
import { launchInstalledApplication } from "../shell/installed-application.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wanx-entry-seam-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "entry.cjs"), "");
  const applicationRoot = path.join(root, "applications");
  const record = await createApplicationInstaller({ rootDir: applicationRoot }).install({ sourceDir: source, manifest: {
    applicationId: "test.installed", name: "测试应用", version: "1.0.0", protocolVersion: 1,
    runtime: "electron", entrypoint: "entry.cjs", capabilities: [],
  } });
  const app = new EventEmitter(), paths = {}, messages = [], loaded = [];
  app.setName = name => { app.name = name; };
  app.setPath = (key, value) => { paths[key] = value; };
  app.focus = () => { app.focused = true; };
  const environment = { WANX_HOST_LAUNCH_ID: "launch", WANX_HOST_TOKEN: "fixture-token", WANX_HOST_CLIENT_APPLICATION_ID: record.applicationId };
  const options = { app, applicationRoot, installPath: record.installPath, environment, send: message => messages.push(message), receive: listener => app.on("host-message", listener), load: async entry => loaded.push(entry) };
  return { options, app, paths, messages, loaded, record, root };
}

test("installed-app bootstrap loads the manifest entry in an isolated profile and waits for window content", async t => {
  const h = await fixture(t);
  await launchInstalledApplication(h.options);
  assert.deepEqual(h.loaded, [path.join(h.record.installPath, "entry.cjs")]);
  assert.equal(h.app.name, "测试应用");
  assert.equal(h.paths.userData, h.paths.sessionData);
  assert.notEqual(h.paths.userData, path.dirname(h.options.applicationRoot));
  assert.deepEqual(h.messages, []);
  const webContents = new EventEmitter();
  const window = Object.assign(new EventEmitter(), {
    webContents, minimized: true, shown: false, isDestroyed: () => false,
    isMinimized: () => window.minimized, restore: () => { window.minimized = false; },
    show: () => { window.shown = true; }, focus() {},
  });
  h.app.emit("browser-window-created", {}, window);
  webContents.emit("did-fail-load", {}, -3, "aborted", "", true);
  assert.deepEqual(h.messages, []);
  webContents.emit("did-finish-load");
  h.app.emit("before-quit");
  assert.deepEqual(h.messages, [{ type: "wanx:application-ready", launchId: "launch" }]);
  h.app.emit("host-message", { type: "wanx:application-activate", launchId: "wrong" });
  assert.equal(window.shown, false);
  h.app.emit("host-message", { type: "wanx:application-activate", launchId: "launch" });
  assert.equal(window.shown, true);
  assert.equal(window.minimized, false);
  assert.equal(h.app.focused, true);
});

test("bootstrap rejects a mismatched grant or a directory outside installed applications before loading code", async t => {
  const h = await fixture(t);
  await assert.rejects(launchInstalledApplication({ ...h.options, environment: { ...h.options.environment, WANX_HOST_CLIENT_APPLICATION_ID: "another.app" } }), { code: "APPLICATION_RECORD_INVALID" });
  await assert.rejects(launchInstalledApplication({ ...h.options, installPath: h.root }), { code: "APPLICATION_RECORD_INVALID" });
  assert.deepEqual(h.loaded, []);
});

test("a failed main-frame load reports failure instead of readiness", async t => {
  const h = await fixture(t);
  await launchInstalledApplication(h.options);
  const webContents = new EventEmitter();
  h.app.emit("browser-window-created", {}, Object.assign(new EventEmitter(), { webContents }));
  webContents.emit("did-fail-load", {}, -105, "private diagnostic", "private URL", true);
  webContents.emit("did-finish-load");
  assert.deepEqual(h.messages, [{ type: "wanx:application-failed", launchId: "launch" }]);
});
