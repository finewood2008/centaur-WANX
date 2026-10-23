import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { readSourceClientManifest, assertSourceClientManifestUnchanged, readPackagedClientManifest } from "../tools/client-package-manifest.mjs";

const require = createRequire(import.meta.url);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-client-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const text = await readFile(new URL("../package.json", import.meta.url), "utf8");
  await writeFile(path.join(root, "package.json"), text);
  return { root, text, pkg: JSON.parse(text) };
}

test("source manifest retains the production entry, build configuration and updater", async t => {
  const { root, text } = await fixture(t);
  const snapshot = await readSourceClientManifest(root);
  assert.equal(snapshot.pkg.name, "centuarai-wanx-client");
  assert.equal(snapshot.pkg.main, "shell/entry.mjs");
  assert.equal(snapshot.pkg.build.productName, "万象个人版");
  assert.equal(snapshot.pkg.dependencies["electron-updater"], "6.8.9");
  assert.ok(snapshot.pkg.build.files.includes("updates/**"));
  await assertSourceClientManifestUnchanged(snapshot);
  assert.equal(await readFile(path.join(root, "package.json"), "utf8"), text);
});

test("source validation rejects both isolated test and stripped production package manifests without rewriting them", async t => {
  const { root, pkg } = await fixture(t);
  const stripped = { ...pkg };
  for (const key of ["scripts", "devDependencies", "build"]) delete stripped[key];
  for (const invalid of [
    { ...stripped, name: "centuarai-wanx-client-ota-test", main: "updates/test-entry.mjs", version: "0.1.5-test.3" },
    stripped,
    { ...pkg, wanxBuild: { distributionClass: "test-only" } },
  ]) {
    const text = JSON.stringify(invalid);
    await writeFile(path.join(root, "package.json"), text);
    await assert.rejects(readSourceClientManifest(root), /CLIENT_SOURCE_MANIFEST_INVALID/);
    assert.equal(await readFile(path.join(root, "package.json"), "utf8"), text);
  }
});

test("build manifest check reports concurrent changes and never restores over another edit", async t => {
  const { root } = await fixture(t);
  const snapshot = await readSourceClientManifest(root);
  const changed = `${snapshot.text}\n`;
  await writeFile(path.join(root, "package.json"), changed);
  await assert.rejects(assertSourceClientManifestUnchanged(snapshot), /CLIENT_SOURCE_MANIFEST_CHANGED/);
  assert.equal(await readFile(path.join(root, "package.json"), "utf8"), changed);
});

test("real ASAR manifest inspection only prints metadata and preserves cwd package.json", async t => {
  const { root, text } = await fixture(t);
  const app = path.join(root, "fixture-app"), archive = path.join(root, "fixture.asar");
  await mkdir(app);
  const packed = { name: "centuarai-wanx-client-ota-test", version: "0.1.5-test.3", main: "updates/test-entry.mjs" };
  await writeFile(path.join(app, "package.json"), JSON.stringify(packed));
  await require("@electron/asar").createPackage(app, archive);
  const before = await readdir(root);
  assert.deepEqual(readPackagedClientManifest(archive), packed);
  const stdout = execFileSync(process.execPath, [fileURLToPath(new URL("../tools/client-package-manifest.mjs", import.meta.url)), archive],
    { cwd: root, encoding: "utf8" });
  assert.deepEqual(JSON.parse(stdout), packed);
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(path.join(root, "package.json"), "utf8"), text);
});
