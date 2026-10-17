import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createElectronUpdateAdapter } from "../updates/electron.mjs";
import { createClientUpdates } from "../updates/client-service.mjs";
import { canonicalJSON, digestPayload } from "../updates/contracts.mjs";
import { packageClient } from "../tools/package-client.mjs";
import { packageWindowsClient } from "../tools/package-client-windows.mjs";
import { clientBuildSource } from "../tools/package-client-source.mjs";

const require = createRequire(import.meta.url);
const { NsisUpdater } = require("electron-updater/out/NsisUpdater.js");
const bytes = Buffer.from("review fixture, intentionally not an executable");
const artifact = { component: "wanx-client", kind: "nsis", url: "https://example.test/wanx.exe",
  sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
  sha512: createHash("sha512").update(bytes).digest("base64") };
const release = { version: "2.0.0", platform: { os: "win32", arch: "x64" },
  createdAt: "2026-10-14T00:00:00Z", artifacts: [artifact] };

async function realNsisAdapter(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-review-nsis-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let instance;
  class NsisWithTestApp extends NsisUpdater {
    constructor() {
      super(undefined, { version: "1.0.0", name: "review-fixture", isPackaged: true,
        userDataPath: directory, baseCachePath: directory, whenReady: async () => {},
        onQuit() {}, quit() { throw new Error("real install must never run"); } });
      instance = this;
      // Only network I/O is replaced. Version checking, provider factory,
      // download orchestration, cache, and Authenticode verifier are real.
      this.httpExecutor = { download: async (_url, destination, options) => {
        assert.equal(options.sha512, artifact.sha512);
        await writeFile(destination, bytes);
      } };
    }
  }
  const adapter = await createElectronUpdateAdapter({ platform: "win32",
    configurationPath: path.join(directory, "electron.yml"), installationDirectory: directory,
    windowsPublisherNames: ["Expected Publisher"], load: async () => ({ NsisUpdater: NsisWithTestApp }) });
  t.after(() => adapter.close());
  return { adapter, instance };
}

test("review: real NsisUpdater accepts the signed custom provider and current result API", async t => {
  const { adapter, instance } = await realNsisAdapter(t);
  let checks = 0;
  t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    assert.match(command, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    assert.ok(args.includes("-File")); assert.ok(!args.includes("-Command"));
    assert.deepEqual(JSON.parse(args[args.indexOf("-PublisherNamesJson") + 1]), ["Expected Publisher"]);
    assert.equal(options.timeout, 30_000);
    checks++;
    callback(null, "WINDOWS_SIGNATURE_VERIFIED\r\n", "");
  });
  const downloaded = await adapter.download(release, {}, { onProgress() {} });
  assert.deepEqual(await readFile(downloaded.file), bytes);
  assert.equal(checks, 2, "both the NSIS download hook and final artifact check must use the strict verifier");
  await adapter.verify(downloaded.file, release);
  assert.equal(checks, 3, "the installation preflight must repeat independent system verification");
  assert.equal(instance.autoInstallOnAppQuit, false);
});

test("review: unavailable PowerShell must reject Windows update verification", async t => {
  const { adapter } = await realNsisAdapter(t);
  t.mock.method(childProcess, "execFile", (_command, _args, _options, callback) => {
    callback(Object.assign(new Error("PowerShell blocked by system policy"), { code: "EACCES" }), "", "");
  });
  t.mock.method(childProcess, "execFileSync", () => { throw new Error("PowerShell blocked by system policy"); });
  await assert.rejects(adapter.download(release, {}, { onProgress() {} }), { code: "UPDATE_SIGNATURE_VERIFICATION_FAILED" });
});

test("review: cached NSIS bytes and install preflight still require a positive system signature result", async t => {
  const { adapter } = await realNsisAdapter(t);
  let verified = true;
  t.mock.method(childProcess, "execFile", (_command, _args, _options, callback) => {
    callback(null, verified ? "WINDOWS_SIGNATURE_VERIFIED" : "", "");
  });
  const downloaded = await adapter.download(release, {}, { onProgress() {} });
  verified = false;
  await assert.rejects(adapter.download(release, {}, { onProgress() {} }), { code: "UPDATE_SIGNATURE_VERIFICATION_FAILED" });
  await assert.rejects(adapter.verify(downloaded.file, release), { code: "UPDATE_SIGNATURE_VERIFICATION_FAILED" });
});

const now = Date.parse("2026-10-14T12:00:00Z");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keys = { review: publicKey.export({ type: "spki", format: "pem" }) };
const current = { productVersion: "1.0.0", buildId: "build-1", packaged: true,
  distributionClass: "formal", channel: "stable", platform: "win32", arch: "x64",
  osVersion: "10.0.22631", hostProtocol: 1, securityEpoch: 1, installationScope: "per-user" };
function envelope(version, metadataSequence) {
  const payload = { ...release, version, schemaVersion: 1, purpose: "wanx.release.v1", product: "wanx-client",
    releaseId: `client-${version}`, buildId: `build-${version}`, channel: "stable", securityEpoch: 1,
    metadataSequence, platform: { ...release.platform, osVersion: current.osVersion },
    supportedOsVersions: [current.osVersion], backendContract: 1, hostProtocol: 1,
    dataPolicy: "backward-compatible", requiredExtensions: [], compatibleApplications: [],
    components: { "wanx-client": { version, sha256: artifact.sha256 } }, expiresAt: "2026-11-14T00:00:00Z" };
  return { payload, signature: { algorithm: "ed25519", keyId: "review",
    signatureBase64: sign(null, Buffer.from(canonicalJSON(payload)), privateKey).toString("base64") } };
}

test("review: channel promotion must not silently invalidate an already downloaded fixed target", async () => {
  let offered = envelope("2.0.0", 1), installed = false;
  const fixed = offered;
  let persisted = { schemaVersion: 1, sequences: {}, operation: null };
  const requests = [];
  const service = await createClientUpdates({ current, keys, now: () => now, installationId: "installation-1",
    store: { load: async () => structuredClone(persisted), save: async value => { persisted = structuredClone(value); } },
    applications: { listInstalled: async () => [], beginMaintenance: () => () => {} },
    request: async input => {
      requests.push(input);
      const result = input.body.releaseId === fixed.payload.releaseId ? fixed : offered;
      return { status: "available", release: result, releaseDigest: digestPayload(result.payload) };
    },
    createAdapter: async () => ({ download: async () => ({ file: "fixture.exe" }), verify: async () => {},
      install() { installed = true; }, close() {} }), requestInstall: async finalize => finalize() });
  await service.check(); await service.download();
  offered = envelope("3.0.0", 2); // 2.0.0 remains supported and was not withdrawn.
  await service.install({ confirmed: true });
  assert.equal(installed, true);
  assert.ok(requests.some(input => input.body?.releaseId === "client-2.0.0"), "must query the fixed release before installing it");
});

test("review: formal Windows packaging rejects dirty source before any signing or build work", async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  t.mock.method(childProcess, "execFileSync", (_command, args) => {
    if (args[0] === "rev-parse") return "a".repeat(40);
    if (args[0] === "status") return "?? shell/untracked-code.mjs\n";
    throw new Error("Unexpected source command");
  });
  await assert.rejects(packageWindowsClient({ version: "2.0.0", out: "unused-review-output", trustFile: "unused-review-trust" }), /CLIENT_SOURCE_TREE_DIRTY/);
});

test("review: clean source proof rejects modified and untracked files while local builds remain identifiable", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-review-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = args => childProcess.execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  await writeFile(path.join(directory, "client.mjs"), "committed client\n");
  git(["add", "client.mjs"]);
  git(["-c", "user.name=Review Fixture", "-c", "user.email=review@example.invalid", "commit", "-qm", "fixture"]);
  const clean = clientBuildSource(directory);
  assert.equal(clean.sourceCommit, git(["rev-parse", "HEAD"]));
  assert.equal(clean.sourceDirty, false);
  await writeFile(path.join(directory, "client.mjs"), "modified client\n");
  assert.throws(() => clientBuildSource(directory), /CLIENT_SOURCE_TREE_DIRTY/);
  assert.deepEqual(clientBuildSource(directory, { formal: false }), { sourceCommit: null, sourceDirty: true });
  await writeFile(path.join(directory, "client.mjs"), "committed client\n");
  await writeFile(path.join(directory, "extra.mjs"), "untracked code\n");
  assert.throws(() => clientBuildSource(directory), /CLIENT_SOURCE_TREE_DIRTY/);
});

test("review: formal macOS packaging must reject a dirty source tree before issuing a formal report", { skip: process.platform !== "darwin" }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-review-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const out = path.join(directory, "release");
  const trustFile = path.join(directory, "trust.json");
  await writeFile(trustFile, JSON.stringify({ schemaVersion: 1, keys }));
  const sourceQueries = [];
  let packed;
  t.mock.method(require("@electron/asar"), "extractFile", () => Buffer.from(JSON.stringify(packed)));
  t.mock.method(childProcess, "execFileSync", (command, args) => {
    if (command === "git") {
      sourceQueries.push(args);
      if (args[0] === "rev-parse") return "a".repeat(40);
      if (args[0] === "status") return " M wanx-client/client.mjs\n";
      throw new Error("SOURCE_TREE_DIRTY");
    }
    if (command === "lipo") return "arm64";
    if (command === "/usr/libexec/PlistBuddy") {
      const field = args[1].split(":").at(-1);
      return { CFBundleIdentifier: pkg.build.appId, CFBundleShortVersionString: "2.0.0",
        CFBundleName: pkg.build.productName, CFBundleExecutable: "WANX" }[field];
    }
    if (command === "xcrun") return "status: Accepted";
    throw new Error(`Unexpected command ${command}`);
  });
  t.mock.method(childProcess, "spawnSync", (command, args) => {
    if (command.endsWith("electron-builder")) {
      const config = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"));
      packed = config.extraMetadata;
      const contents = path.join(out, "mac-arm64", `${pkg.build.productName}.app`, "Contents");
      fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
      fs.mkdirSync(path.join(contents, "Resources/network"), { recursive: true });
      fs.writeFileSync(path.join(contents, "MacOS/WANX"), "fixture");
      for (const name of ["wanx-netbird-darwin-arm64", "wanx-discovery-darwin-arm64"])
        fs.writeFileSync(path.join(contents, "Resources/network", name), "fixture");
      fs.writeFileSync(path.join(out, "fixture.dmg"), "fixture");
      fs.writeFileSync(path.join(out, "fixture.zip"), "fixture");
    }
    return { status: 0, stdout: "", stderr: command === "codesign" ? "Authority=Developer ID Application: Test Fixture" : "" };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(packageClient({ version: "2.0.0", arch: "arm64", out,
    notaryProfile: "review-fixture-not-real", trustFile }), /DIRTY|dirty|源码|工作区/);
  assert.ok(sourceQueries.some(args => args[0] !== "rev-parse"));
});

test("review: normal account restore must preserve interrupted-update recovery guidance", async () => {
  const persisted = { schemaVersion: 1, sequences: {}, operation: {
    phase: "installing", version: "2.0.0", buildId: "build-2", installationId: "installation-1", releaseId: "client-2.0.0",
  } };
  const service = await createClientUpdates({ current, keys, now: () => now, installationId: "installation-1",
    store: { load: async () => persisted, save: async () => {} },
    applications: {}, request() { throw new Error("not called"); }, createAdapter() { throw new Error("not called"); } });
  assert.equal((await service.ready()).reason, "UPDATE_RECOVERY_REQUIRED");
  // shell/main calls ready() before client.initialize(); account.restore()
  // then publishes authenticated with a newly restored identity, which calls invalidate().
  service.invalidate();
  assert.equal(service.snapshot().reason, "UPDATE_RECOVERY_REQUIRED");
});

test("review: a previously successful result cannot mark a later launch of an old copy as upgraded", async () => {
  const persisted = { schemaVersion: 1, sequences: {}, operation: {
    phase: "succeeded", version: "2.0.0", buildId: "build-2", installationId: "installation-1", releaseId: "client-2.0.0",
  } };
  const service = await createClientUpdates({ current, keys, now: () => now, installationId: "other-old-copy",
    store: { load: async () => persisted, save: async () => {} }, applications: {} });
  await service.ready(); service.invalidate();
  assert.equal(service.snapshot().reason, "UPDATE_RECOVERY_REQUIRED");
  assert.equal(service.snapshot().lastResult.phase, "interrupted");
  assert.notEqual(service.snapshot().phase, "succeeded");
});
