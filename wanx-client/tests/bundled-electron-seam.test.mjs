import test from "node:test";
import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants, createWriteStream } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yazl from "yazl";
import { createApplicationManager } from "../applications/manager.mjs";

const electronApp = process.env.WANX_ELECTRON_APP;
const packagedHost = process.env.WANX_PACKAGED_EXECUTABLE;

function messageFrom(child, type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off("message", receive); child.off("exit", exited); };
    const receive = message => { if (message?.type === type) { cleanup(); resolve(message); } };
    const exited = () => { cleanup(); reject(new Error(`Child exited before ${type}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, 10_000);
    child.on("message", receive);
    child.once("exit", exited);
  });
}

async function zipDirectory(source, archivePath) {
  const zip = new yazl.ZipFile();
  const writing = pipeline(zip.outputStream, createWriteStream(archivePath));
  async function add(directory, prefix = "") {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name), entry = prefix + name, info = await lstat(file);
      if (info.isSymbolicLink()) zip.addBuffer(Buffer.from(await readlink(file)), entry, { mode: info.mode });
      else if (info.isDirectory()) await add(file, `${entry}/`);
      else zip.addFile(file, entry, { mode: info.mode });
    }
  }
  await add(source); zip.end(); await writing;
}

// Uses real visible Electron windows and isolated profiles. Set an evidence
// directory to retain screenshots and result JSON; otherwise everything is temporary.
test("real Electron installs, opens and reactivates all four installation combinations", {
  skip: process.platform !== "darwin" || !electronApp, timeout: 180_000,
}, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wanx-electron-install-")));
  let manager;
  const children = [];
  t.after(async () => {
    const exits = children.filter(c => c.exitCode === null && c.signalCode === null).map(c => new Promise(resolve => c.once("exit", resolve)));
    await manager?.close(); await Promise.all(exits);
    await rm(root, { recursive: true, force: true });
  });
  const evidence = process.env.WANX_ELECTRON_EVIDENCE_DIR || path.join(root, "evidence");
  await mkdir(evidence, { recursive: true });
  const clientRoot = fileURLToPath(new URL("../", import.meta.url));
  const sharedSource = path.join(root, "shared"), bundledSource = path.join(root, "bundled"), profile = path.join(root, "profile");
  const base = { name: "应用安装验证", version: "1.0.0", protocolVersion: 1, runtime: "electron" };
  const shared = { ...base, applicationId: "test.shared", entrypoint: "main.cjs" };
  await mkdir(path.join(sharedSource, "node_modules/@centaurai"), { recursive: true });
  await cp(path.join(clientRoot, "host-sdk"), path.join(sharedSource, "node_modules/@centaurai/wanx-host-sdk"), { recursive: true });
  await cp(path.join(clientRoot, "node_modules/ws"), path.join(sharedSource, "node_modules/ws"), { recursive: true });
  await cp(new URL("./support/electron-application.cjs", import.meta.url), path.join(sharedSource, "main.cjs"));
  await writeFile(path.join(sharedSource, "package.json"), JSON.stringify({ name: "wanx-install-fixture", version: "1.0.0", main: "main.cjs" }));
  await writeFile(path.join(sharedSource, "application.manifest.json"), JSON.stringify(shared));
  const sharedZip = path.join(root, "shared.zip");
  await zipDirectory(sharedSource, sharedZip);

  const bundle = path.join(bundledSource, "Test.app");
  await mkdir(bundledSource);
  await cp(electronApp, bundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  await rename(path.join(bundle, "Contents/MacOS/Electron"), path.join(bundle, "Contents/MacOS/WanxTest"));
  await promisify(execFile)("plutil", ["-replace", "CFBundleExecutable", "-string", "WanxTest", path.join(bundle, "Contents/Info.plist")]);
  const resources = path.join(bundle, "Contents/Resources");
  await rm(path.join(resources, "default_app.asar"), { force: true });
  await cp(sharedSource, path.join(resources, "app"), { recursive: true });
  await promisify(execFile)("codesign", ["--force", "--deep", "--sign", "-", bundle]);
  const bundled = { ...base, applicationId: "test.bundled", launchMode: "bundled", platform: "darwin", arch: process.arch, entrypoint: "Test.app/Contents/MacOS/WanxTest" };
  await writeFile(path.join(bundledSource, "application.manifest.json"), JSON.stringify(bundled));
  const bundledZip = path.join(root, "bundled.zip");
  await zipDirectory(bundledSource, bundledZip);

  let live = true, activeCase, opened;
  const listeners = new Set(), calls = [], results = [];
  manager = await createApplicationManager({
    applicationRoot: path.join(profile, "applications"), applicationId: "test-host",
    electronPath: packagedHost || path.join(electronApp, "Contents/MacOS/Electron"),
    runtimeArgs: [...(packagedHost ? [] : [clientRoot]), `--user-data-dir=${profile}`],
    createConnection: async () => ({
      context() { if (!live) throw Error("NETWORK_CHANGED"); return { boxId: "fixture", user: { id: 1 }, connection: "ready" }; },
      request(input) { calls.push({ case: activeCase.name, path: input.path }); return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"ok":true}') }; },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    }),
    spawn(file, args, options) {
      const child = spawn(file, args, { ...options, env: { ...options.env,
        WANX_TEST_MODE: activeCase.mode, WANX_TEST_CASE: activeCase.name, WANX_TEST_EVIDENCE_DIR: evidence,
      } });
      children.push(child); opened = messageFrom(child, "test:opened");
      // The launch promise may reject before this test-only ready event arrives.
      opened.catch(() => {});
      return child;
    },
  });

  for (const [mode, source, archive, manifest] of [
    ["shared", sharedSource, sharedZip, shared], ["bundled", bundledSource, bundledZip, bundled],
  ]) {
    for (const format of ["zip", "directory"]) {
      await t.test(`${mode} / ${format}: install → visible application → reactivate → revoke → stop`, async () => {
        activeCase = { mode, name: `${mode}-${format}` }; live = true;
        // Each route installs a fresh version, so neither can pass by reusing a previous install.
        const version = format === "zip" ? "1.0.0" : "1.0.1";
        if (format === "directory") await writeFile(path.join(source, "application.manifest.json"), JSON.stringify({ ...manifest, version }));
        const installed = await manager.install(format === "zip" ? { archivePath: archive } : { sourceDir: source });
        assert.equal(installed.version, version);
        assert.ok((await manager.listInstalled()).some(record => record.applicationId === manifest.applicationId && record.version === version));
        const before = children.length;
        const launch = await manager.launch(manifest.applicationId, version);
        assert.equal(launch.state, "running");
        await opened;
        const child = children.at(-1);
        const inspected = messageFrom(child, "test:inspected"); child.send({ type: "test:inspect" });
        const view = await inspected;
        assert.equal(view.visible, true);
        assert.equal(view.windowCount, 1);
        assert.equal(view.heading, "应用已安装并打开");
        assert.equal(view.title, "万象应用安装验证");
        assert.equal(view.context.boxId, "fixture");
        assert.deepEqual(view.result, { ok: true });
        if (mode === "bundled") assert.equal(view.packaged, true);
        assert.equal(view.userData, path.join(profile, "applications/.runtime", manifest.applicationId));
        assert.ok((await stat(view.screenshot)).size > 1000);
        const hidden = messageFrom(child, "test:hidden"); child.send({ type: "test:hide" });
        assert.equal((await hidden).visible, false);
        assert.equal((await manager.launch(manifest.applicationId, version)).launchId, launch.launchId);
        // macOS can make an existing window visible without another `show`
        // event. Inspect the resulting window, as the signed-package seam does.
        const reactivated = messageFrom(child, "test:inspected"); child.send({ type: "test:inspect" });
        const reactivatedView = await reactivated;
        assert.equal(reactivatedView.visible, true);
        assert.equal(reactivatedView.windowCount, 1);
        assert.equal(children.length, before + 1);
        const revoked = messageFrom(child, "test:invalidated");
        live = false; for (const listener of listeners) listener(); await revoked;
        const revokedView = messageFrom(child, "test:inspected"); child.send({ type: "test:inspect" });
        assert.equal((await revokedView).revokedRequest, "HOST_SESSION_EXPIRED");
        const exited = new Promise(resolve => child.once("exit", resolve));
        await manager.stop(manifest.applicationId); await exited;
        results.push({ case: activeCase.name, version, installed: true, launched: true, visible: true,
          pageLoaded: true, gateway: true, reactivated: true, revoked: true, stopped: true, screenshot: view.screenshot });
      });
    }
  }
  assert.deepEqual(calls.map(call => call.case), ["shared-zip", "shared-directory", "bundled-zip", "bundled-directory"]);
  assert.ok(calls.every(call => call.path === "/api/test"));
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ host: packagedHost ? "packaged" : "source", platform: process.platform, arch: process.arch, results }, null, 2));
});
