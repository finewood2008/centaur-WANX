import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { packageApplication, signNativePackage } from "../tools/package-application.mjs";
import { verifyEnvelope } from "../applications/descriptor.mjs";
import { extractApplicationArchive, verifyPackageHash } from "../applications/verified-archive.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-pack-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceDir = path.join(directory, "source"), outputDir = path.join(directory, "output"), keyFile = path.join(directory, "signing.pem");
  await mkdir(sourceDir);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const manifest = { applicationId: "example.zhijun", name: "知君", version: "1.2.3", protocolVersion: 1, runtime: "electron", entrypoint: "main.mjs", capabilities: ["identity.read"] };
  await writeFile(path.join(sourceDir, "wanx-app.json"), JSON.stringify(manifest));
  await writeFile(path.join(sourceDir, "main.mjs"), "console.log('ready');");
  return { directory, sourceDir, outputDir, keyFile, keyId: "test-key", os: "macos", arch: "arm64", publicKey: publicKey.export({ type: "spki", format: "pem" }) };
}

test("release tool creates an independently verifiable package, signature and exact manifest", async (t) => {
  const f = await fixture(t);
  const result = await packageApplication(f);
  const envelope = JSON.parse(await readFile(result.envelopePath, "utf8"));
  const descriptor = verifyEnvelope(envelope, { "test-key": f.publicKey });
  assert.equal(descriptor.applicationId, "example.zhijun");
  assert.equal(descriptor.version, "1.2.3");
  assert.equal(descriptor.arch, "arm64");
  await verifyPackageHash(result.archivePath, descriptor);
  await extractApplicationArchive(result.archivePath, path.join(f.directory, "unpacked"), descriptor);
  assert.equal(await readFile(path.join(f.directory, "unpacked/main.mjs"), "utf8"), "console.log('ready');");
  await assert.rejects(packageApplication(f), { code: "EEXIST" });
  await verifyPackageHash(result.archivePath, descriptor);
});

test("release tool refuses symlinks and a signing key inside the package", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await symlink(f.keyFile, path.join(f.sourceDir, "private.pem"));
  await assert.rejects(packageApplication(f), /符号链接/);
  await assert.rejects(packageApplication({ ...f, keyFile: path.join(f.sourceDir, "private.pem") }), /之外/);
});

test("native package sidecar binds exact OS, architecture and file bytes", async (t) => {
  const f = await fixture(t), inputFile = path.join(f.directory, "WANX.dmg");
  await writeFile(inputFile, "test installer bytes");
  const result = await signNativePackage({ ...f, inputFile, applicationId: "wanx.host", version: "1.0.0" });
  const descriptor = verifyEnvelope(JSON.parse(await readFile(result.envelopePath, "utf8")), { "test-key": f.publicKey });
  assert.equal(descriptor.packageType, "dmg");
  await verifyPackageHash(inputFile, descriptor);
  await assert.rejects(signNativePackage({ ...f, inputFile, applicationId: "wanx.host", version: "1.0.0", os: "windows" }), /macOS/);
});
