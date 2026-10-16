import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
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

test("market rebuild replaces an existing package and sidecar only after validation", async (t) => {
  const f = await fixture(t);
  const first = await packageApplication({ ...f, overwrite: true });
  const oldEnvelope = await readFile(first.envelopePath, "utf8");
  await writeFile(path.join(f.sourceDir, "main.mjs"), "console.log('updated');");
  const rebuilt = await packageApplication({ ...f, overwrite: true });
  assert.equal(rebuilt.archivePath, first.archivePath);
  assert.equal(rebuilt.envelopePath, first.envelopePath);
  const newEnvelope = await readFile(rebuilt.envelopePath, "utf8");
  assert.notEqual(newEnvelope, oldEnvelope);
  const descriptor = verifyEnvelope(JSON.parse(newEnvelope), { "test-key": f.publicKey });
  await verifyPackageHash(rebuilt.archivePath, descriptor);
  await extractApplicationArchive(rebuilt.archivePath, path.join(f.directory, "rebuilt"), descriptor);
  assert.equal(await readFile(path.join(f.directory, "rebuilt/main.mjs"), "utf8"), "console.log('updated');");
  await writeFile(path.join(f.sourceDir, "wanx-app.json"), "{}");
  await assert.rejects(packageApplication({ ...f, overwrite: true }));
  assert.equal(await readFile(rebuilt.envelopePath, "utf8"), newEnvelope);
  await verifyPackageHash(rebuilt.archivePath, descriptor);
});

test("release tool refuses symlinks and a signing key inside the package", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await symlink(f.keyFile, path.join(f.sourceDir, "private.pem"));
  await assert.rejects(packageApplication(f), /符号链接/);
  await assert.rejects(packageApplication({ ...f, keyFile: path.join(f.sourceDir, "private.pem") }), /之外/);
});

test("v2 package signs backend and expert requirements with the manifest", async (t) => {
  const f = await fixture(t), manifestPath = path.join(f.sourceDir, "wanx-app.json");
  const compatibility = {
    backendProductId: "zhijun", clientRange: ">=0.1.0 <1.0.0", hostProtocolRange: ">=1.0.0 <2.0.0",
    backendContracts: [{ id: "wanx-bridge.readiness", range: ">=1.0.0 <2.0.0", features: ["read-only"] }],
    requiredExperts: [{ templateId: "zhijun-default", versionRange: ">=1.0.0 <2.0.0", role: "advisor", count: 1, required: true }],
    localDataSchema: { readRange: ">=1.0.0 <2.0.0", writeVersion: "1.0.0" },
  };
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, protocolVersion: 2, compatibility, critical: [] }));
  const result = await packageApplication(f);
  const envelope = JSON.parse(await readFile(result.envelopePath, "utf8"));
  const descriptor = verifyEnvelope(envelope, { "test-key": f.publicKey });
  assert.equal(descriptor.schemaVersion, 2);
  assert.deepEqual(descriptor.compatibility, compatibility);
  assert.deepEqual(descriptor.manifest.compatibility, compatibility);
  await extractApplicationArchive(result.archivePath, path.join(f.directory, "v2-unpacked"), descriptor);
  const tampered = JSON.parse(Buffer.from(envelope.descriptorBase64, "base64"));
  tampered.compatibility.requiredExperts = [];
  assert.throws(() => verifyEnvelope({ ...envelope, descriptorBase64: Buffer.from(JSON.stringify(tampered)).toString("base64") }, { "test-key": f.publicKey }));
});

test("release CLI defaults to a signed universal shared application without platform flags", async (t) => {
  const f = await fixture(t);
  const tool = fileURLToPath(new URL("../tools/package-application.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [tool, "--source", f.sourceDir,
    "--out", f.outputDir, "--key", f.keyFile, "--key-id", f.keyId]);
  const result = JSON.parse(stdout);
  const descriptor = verifyEnvelope(JSON.parse(await readFile(result.signature, "utf8")), { "test-key": f.publicKey });
  assert.equal(descriptor.os, "universal");
  assert.equal(descriptor.arch, "universal");
  assert.equal(descriptor.manifest.launchMode, "shared");
  assert.equal(descriptor.manifest.platform, undefined);
  assert.equal(descriptor.manifest.arch, undefined);
  assert.match(result.package, /-universal-universal\.wanxapp$/);
  await verifyPackageHash(result.package, descriptor);
  await extractApplicationArchive(result.package, path.join(f.directory, "unpacked"), descriptor);
});

test("universal packages reject mixed targets and platform-restricted or bundled manifests", async (t) => {
  const f = await fixture(t);
  for (const [os, arch] of [["universal", "arm64"], ["macos", "universal"], [undefined, "x64"], ["windows", undefined]]) {
    await assert.rejects(packageApplication({ ...f, os, arch }), /必须同时/);
  }
  const manifestPath = path.join(f.sourceDir, "wanx-app.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const restriction of [{ platform: "darwin" }, { arch: "arm64" }, { launchMode: "bundled", platform: "darwin", arch: "arm64" }]) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, ...restriction }));
    await assert.rejects(packageApplication({ ...f, os: undefined, arch: undefined }), /共享万象运行时/);
  }
});

test("native package sidecar binds exact OS, architecture and file bytes", async (t) => {
  const f = await fixture(t), inputFile = path.join(f.directory, "WANX.dmg");
  await writeFile(inputFile, "test installer bytes");
  const result = await signNativePackage({ ...f, inputFile, applicationId: "wanx.host", version: "1.0.0" });
  const descriptor = verifyEnvelope(JSON.parse(await readFile(result.envelopePath, "utf8")), { "test-key": f.publicKey });
  assert.equal(descriptor.packageType, "dmg");
  await verifyPackageHash(inputFile, descriptor);
  await assert.rejects(signNativePackage({ ...f, inputFile, applicationId: "wanx.host", version: "1.0.0", os: "windows" }), /macOS/);
  for (const arch of [undefined, "universal"]) {
    await assert.rejects(signNativePackage({ ...f, inputFile, applicationId: "wanx.host", version: "1.0.0", arch }), /必须指定 --arch/);
  }
  await assert.rejects(signNativePackage({ ...f, inputFile, applicationId: "wanx.host", version: "1.0.0", os: "universal" }), /macOS/);
});
