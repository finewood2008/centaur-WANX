import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { packageApplication } from "../tools/package-application.mjs";
import { createApplicationManager } from "../applications/manager.mjs";

function message(child, type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off("message", receive); child.off("exit", exited); };
    const receive = value => { if (value?.type === type) { cleanup(); resolve(value); } };
    const exited = () => { cleanup(); reject(new Error(`Child exited before ${type}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, 10000);
    child.on("message", receive); child.once("exit", exited);
  });
}

test("real Electron universal signed package reports readiness, reactivates, upgrades and exits", {
  skip: process.platform !== "darwin" || !process.env.WANX_ELECTRON_APP, timeout: 60000,
}, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wanx-market-electron-")));
  let manager;
  t.after(async () => { await manager?.close(); await rm(root, { recursive: true, force: true }); });
  const sourceDir = path.join(root, "source"), profile = path.join(root, "profile"), applicationRoot = path.join(profile, "applications");
  await mkdir(sourceDir);
  const keys = generateKeyPairSync("ed25519"), keyFile = path.join(root, "private.pem");
  const trustedKeys = { test: keys.publicKey.export({ type: "spki", format: "pem" }) };
  await writeFile(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await writeFile(path.join(sourceDir, "main.cjs"), `
    const { app, BrowserWindow } = require('electron');
    let window;
    app.whenReady().then(async () => {
      window = new BrowserWindow({ show: true, width: 400, height: 260, webPreferences: { sandbox: true } });
      await window.loadURL('data:text/html,<h1>Signed application</h1>');
    });
    process.on('message', message => {
      if (message.type === 'inspect') process.send({ type: 'inspected', visible: window.isVisible(), userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().length });
      if (message.type === 'hide') { window.hide(); process.send({ type: 'hidden' }); }
    });
  `);
  const applicationId = "test.signed-window", runner = path.join(root, "runner.mjs");
  await writeFile(runner, `
    import { app } from 'electron';
    import { runManagedApplication } from ${JSON.stringify(new URL("../applications/runtime.mjs", import.meta.url).href)};
    runManagedApplication({ app, applicationRoot: ${JSON.stringify(applicationRoot)}, trustedKeys: ${JSON.stringify(trustedKeys)} }).catch(error => { console.error(error); app.exit(1); });
  `);
  const children = [];
  manager = await createApplicationManager({ applicationRoot, applicationId: "test-host", trustedKeys,
    context: () => ({}), electronPath: path.join(process.env.WANX_ELECTRON_APP, "Contents/MacOS/Electron"),
    launcherArgs: [runner, `--user-data-dir=${profile}`],
    spawn(executable, args, options) { const child = spawn(executable, args, options); children.push(child); return child; },
  });
  async function install(version) {
    await writeFile(path.join(sourceDir, "wanx-app.json"), JSON.stringify({ applicationId, name: "Signed window", version, protocolVersion: 1, runtime: "electron", entrypoint: "main.cjs" }));
    const result = await packageApplication({ sourceDir, outputDir: path.join(root, "packages"), keyFile, keyId: "test" });
    assert.equal(result.descriptor.os, "universal");
    assert.equal(result.descriptor.arch, "universal");
    return manager.installVerifiedPackage({ archivePath: result.archivePath, envelope: JSON.parse(await readFile(result.envelopePath, "utf8")) });
  }
  async function inspect(child) { const result = message(child, "inspected"); child.send({ type: "inspect" }); return result; }
  await install("1.0.0");
  const first = await manager.launch(applicationId);
  const before = await inspect(children[0]);
  assert.equal(before.visible, true); assert.equal(before.windows, 1);
  const hidden = message(children[0], "hidden"); children[0].send({ type: "hide" }); await hidden;
  assert.equal((await manager.launch(applicationId)).launchId, first.launchId);
  assert.equal((await inspect(children[0])).visible, true);
  await install("1.1.0");
  assert.equal(children[0].exitCode, null); assert.equal(children[0].signalCode, null);
  await manager.launch(applicationId);
  assert.equal(children.length, 2);
  assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
  assert.equal((await inspect(children[1])).userData, before.userData);
  await manager.stop(applicationId);
  assert.ok(children[1].exitCode !== null || children[1].signalCode !== null);
});
