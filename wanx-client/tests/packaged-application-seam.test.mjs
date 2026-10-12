import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createApplicationManager } from "../applications/manager.mjs";

// Real executable boundary: Node/fake spawn cannot catch packaged Electron
// ignoring --app and re-entering the Host. This seam uses a temporary profile.
const executable = process.env.WANX_PACKAGED_EXECUTABLE;
test("packaged Host launches the installed manifest entry, not another Host", { skip: !executable, timeout: 15000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wanx packaged seam ")));
  const source = path.join(root, "source"), profile = path.join(root, "profile");
  await mkdir(source);
  const marker = path.join(root, "loaded.json");
  await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "unused-package-main", main: "wrong.cjs" }));
  await writeFile(path.join(source, "wrong.cjs"), "throw Error('must use manifest entry');");
  await writeFile(path.join(source, "entry.cjs"), `
    const {app,BrowserWindow}=require('electron');
    require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({name:app.getName(),data:app.getPath('userData')}));
    app.whenReady().then(()=>{const window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,sandbox:true}});window.loadURL('data:text/html,<h1>Installed application</h1>');});
  `);
  const manifest = { applicationId: "test.packaged", name: "打包测试", version: "1.0.0", protocolVersion: 1, runtime: "electron", entrypoint: "entry.cjs", capabilities: [] };
  await writeFile(path.join(source, "application.manifest.json"), JSON.stringify(manifest));
  const children = [];
  const manager = await createApplicationManager({
    applicationRoot: path.join(profile, "applications"), applicationId: "test-host",
    electronPath: executable,
    runtimeArgs: [...(process.env.WANX_SOURCE_ROOT ? [process.env.WANX_SOURCE_ROOT] : []), `--user-data-dir=${profile}`],
    context: () => ({ boxId: "fixture-102", connection: "ready" }),
    spawn: (...args) => { const child = spawn(...args); children.push(child); return child; },
  });
  t.after(async () => {
    const exited = children.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise(resolve => child.once("exit", resolve)));
    await manager.close(); await Promise.all(exited);
    await rm(root, { recursive: true, force: true });
  });
  await manager.install({ sourceDir: source });
  assert.equal((await manager.launch(manifest.applicationId)).state, "running");
  const loaded = JSON.parse(await readFile(marker, "utf8"));
  assert.equal(loaded.name, manifest.name);
  assert.notEqual(loaded.data, profile);
  await manager.stop(manifest.applicationId);
  await writeFile(path.join(source, "entry.cjs"), "throw Error('fixture fails before creating a window');");
  await writeFile(path.join(source, "application.manifest.json"), JSON.stringify({ ...manifest, version: "1.0.1" }));
  await manager.install({ sourceDir: source });
  await assert.rejects(manager.launch(manifest.applicationId, "1.0.1"), { code: "APPLICATION_START_FAILED" });
});
