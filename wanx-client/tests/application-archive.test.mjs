import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplicationInstaller } from "../applications/installer.mjs";
import { writeApplicationZip } from "./support/application-zip.mjs";

const manifest = { applicationId: "test.zip", name: "ZIP 应用", version: "1.0.0", protocolVersion: 1, runtime: "electron", entrypoint: "shell/main.cjs" };
const files = (value = manifest, prefix = "") => [
  { name: `${prefix}application.manifest.json`, body: JSON.stringify(value) },
  { name: `${prefix}${value.entrypoint}`, body: "application-entry", mode: 0o100755 },
  { name: `${prefix}renderer/index.html`, body: "<h1>应用</h1>" },
];

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-zip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, "application.zip"), installRoot = path.join(root, "applications");
  return { root, archivePath, installRoot, installer: createApplicationInstaller({ rootDir: installRoot }) };
}

for (const prefix of ["", "download/"]) {
  test(`ZIP installs a complete shared application with ${prefix ? "one wrapper directory" : "a root manifest"}`, async t => {
    const f = await fixture(t);
    await writeApplicationZip(f.archivePath, [...files(manifest, prefix), { name: "__MACOSX/._metadata", body: "metadata" }]);
    const record = await f.installer.install({ archivePath: f.archivePath });
    assert.equal(record.launchMode, "shared");
    assert.equal(await readFile(path.join(record.installPath, "renderer/index.html"), "utf8"), "<h1>应用</h1>");
    assert.deepEqual(await f.installer.list(), [record]);
    await assert.rejects(f.installer.install({ archivePath: f.archivePath }), { code: "APPLICATION_VERSION_ALREADY_INSTALLED" });
    assert.deepEqual(await readdir(f.installRoot), [manifest.applicationId]);
    assert.deepEqual(await readdir(path.dirname(record.installPath)), [manifest.version]);
    assert.deepEqual(await f.installer.list(), [record]);
  });
}

test("ZIP installs a bundled executable and enforces its platform and architecture", async t => {
  const f = await fixture(t);
  const bundled = { ...manifest, launchMode: "bundled", platform: process.platform, arch: process.arch, entrypoint: "MyApp/app.exe" };
  await writeApplicationZip(f.archivePath, files(bundled));
  const record = await f.installer.install({ archivePath: f.archivePath });
  assert.equal(record.launchMode, "bundled");
  if (process.platform !== "win32") assert.ok((await stat(path.join(record.installPath, bundled.entrypoint))).mode & 0o111);
  for (const override of [
    { platform: process.platform === "win32" ? "darwin" : "win32" },
    { arch: process.arch === "arm64" ? "x64" : "arm64" },
  ]) {
    await writeApplicationZip(f.archivePath, files({ ...bundled, version: "2.0.0", ...override }));
    await assert.rejects(f.installer.install({ archivePath: f.archivePath }), { code: "APPLICATION_PLATFORM_UNSUPPORTED" });
    assert.deepEqual(await f.installer.list(), [record]);
  }
});

test("ZIP preserves internal framework symlinks after staging cleanup", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await writeApplicationZip(f.archivePath, [
    ...files(),
    { name: "Framework/Versions/A/library", body: "framework" },
    { name: "Framework/Versions/Current", body: "A", mode: 0o120777 },
    { name: "Framework/library", body: "Versions/Current/library", mode: 0o120777 },
  ]);
  const record = await f.installer.install({ archivePath: f.archivePath });
  assert.equal(await readlink(path.join(record.installPath, "Framework/Versions/Current")), "A");
  assert.equal(await readFile(path.join(record.installPath, "Framework/library"), "utf8"), "framework");
});

for (const [label, extra] of [
  ["duplicate paths", [{ name: "renderer/index.html", body: "replacement" }]],
  ["case aliases", [{ name: "Renderer/INDEX.html", body: "replacement" }]],
  ["install record injection", [{ name: ".wanx-install.json", body: "{}" }]],
  ["external symlink", [{ name: "escape", body: "../outside", mode: 0o120777 }]],
  ["write through a symlink", [{ name: "link", body: "renderer", mode: 0o120777 }, { name: "link/payload", body: "write" }]],
]) {
  test(`invalid ZIP rejects ${label} without leaving an installation or staging files`, async t => {
    const f = await fixture(t);
    await writeApplicationZip(f.archivePath, [...files(), ...extra]);
    await assert.rejects(f.installer.install({ archivePath: f.archivePath }), { code: "APPLICATION_ARCHIVE_INVALID" });
    assert.deepEqual(await f.installer.list(), []);
    assert.deepEqual(await readdir(f.installRoot), []);
  });
}

test("ZIP rejects traversal and corrupted file contents", async t => {
  const f = await fixture(t);
  await writeApplicationZip(f.archivePath, [{ name: "xx/escape", body: "payload" }]);
  let bytes = await readFile(f.archivePath);
  for (let index = bytes.indexOf("xx/escape"); index !== -1; index = bytes.indexOf("xx/escape")) bytes.write("../escape", index);
  await writeFile(f.archivePath, bytes);
  await assert.rejects(f.installer.install({ archivePath: f.archivePath }), { code: "APPLICATION_ARCHIVE_INVALID" });
  await assert.rejects(stat(path.join(f.installRoot, "escape")), { code: "ENOENT" });
  await writeApplicationZip(f.archivePath, files());
  bytes = await readFile(f.archivePath);
  bytes[bytes.indexOf("application-entry")] ^= 1;
  await writeFile(f.archivePath, bytes);
  await assert.rejects(f.installer.install({ archivePath: f.archivePath }), { code: "APPLICATION_ARCHIVE_INVALID" });
  assert.deepEqual(await readdir(f.installRoot), []);
});

test("oversized ZIP is rejected before extraction", async t => {
  const f = await fixture(t);
  const file = await open(f.archivePath, "w");
  try { await file.truncate(2 * 1024 ** 3 + 1); } finally { await file.close(); }
  await assert.rejects(f.installer.install({ archivePath: f.archivePath }), { code: "APPLICATION_ARCHIVE_TOO_LARGE" });
  assert.deepEqual(await readdir(f.installRoot), []);
});

test("missing manifest or entry never publishes a partial installation", async t => {
  const f = await fixture(t);
  await writeApplicationZip(f.archivePath, [{ name: "main.cjs", body: "" }]);
  await assert.rejects(f.installer.install({ archivePath: f.archivePath }), { code: "APPLICATION_MANIFEST_READ_FAILED" });
  await writeApplicationZip(f.archivePath, files().filter(file => file.name !== manifest.entrypoint));
  await assert.rejects(f.installer.install({ archivePath: f.archivePath }), { code: "APPLICATION_ENTRYPOINT_NOT_FOUND" });
  assert.deepEqual(await f.installer.list(), []);
  assert.deepEqual(await readdir(f.installRoot), []);
});
