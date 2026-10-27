import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, truncate } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { validateConfiguration } from "app-builder-lib/out/util/config/config.js";
import { signClientRelease } from "../tools/sign-client-release.mjs";
import { verifyRelease } from "../updates/contracts.mjs";
import { readClientIdentity } from "../updates/identity.mjs";
import { windowsReleaseConfiguration, validateWindowsTrust } from "../tools/package-client-windows.mjs";
import { packageClient } from "../tools/package-client.mjs";
import { clientTrustFingerprints, validateClientTrust } from "../tools/package-client-trust.mjs";
import { createClientBlockMap, MAX_CLIENT_BLOCKMAP_SIZE_BYTES } from "../tools/client-blockmap.mjs";

const require = createRequire(import.meta.url);

test("release tool signs exact verified bytes, refuses internal reports, tampering and overwriting", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-sign-release-")); t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("test archive"), file = path.join(root, "app.zip"), reportPath = path.join(root, "report.json"), outputPath = path.join(root, "release.json");
  await writeFile(file, bytes);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"), privateKeyPath = path.join(root, "test-only.pem");
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const report = { version: "2.0.0", appId: "ai.centuarai.wanx.client", platform: "macos", signed: true, notarized: true, distributionClass: "formal", arch: "arm64",
    updateTrust: clientTrustFingerprints({ schemaVersion: 1, keys: { "test-only": publicKey.export({ type: "spki", format: "pem" }) } }),
    build: { distributionClass: "formal", buildId: "build-2", channel: "stable", securityEpoch: 2,
      sourceCommit: "a".repeat(40), sourceDirty: false },
    updateArtifact: { path: file, kind: "mac-zip", notarized: true, sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), sha512: createHash("sha512").update(bytes).digest("base64") } };
  await writeFile(reportPath, JSON.stringify(report));
  const input = { reportPath, outputPath, privateKeyPath, artifactURL: "https://release.example.test/app.zip", keyId: "test-only",
    releaseId: "client-2.0.0", metadataSequence: 2, supportedOsVersions: ["25.0.0"], compatibleApplications: [],
    now: Date.parse("2026-10-14T00:00:00Z"), expiresAt: "2026-11-14T00:00:00Z" };
  await signClientRelease(input);
  const envelope = JSON.parse(await readFile(outputPath));
  assert.equal(envelope.payload.channel, "stable");
  assert.equal(envelope.payload.forceUpdate, undefined, "existing signing defaults must remain optional");
  assert.equal(envelope.payload.artifacts[0].blockMap, undefined, "older full-download reports remain supported");
  await assert.rejects(signClientRelease({ ...input, forceUpdate: "true" }), /布尔值/);
  const testOutput = path.join(root, "test-channel-release.json"), supportPath = path.join(root, "support.json");
  await writeFile(supportPath, JSON.stringify({ supportedOsVersions: input.supportedOsVersions, compatibleApplications: [] }));
  execFileSync(process.execPath, [fileURLToPath(new URL("../tools/sign-client-release.mjs", import.meta.url)),
    "--report", reportPath, "--url", input.artifactURL, "--key-id", input.keyId, "--private-key", privateKeyPath,
    "--release-id", "client-2.0.0-test", "--sequence", "1", "--support", supportPath,
    "--expires-at", "2099-01-01T00:00:00Z", "--out", testOutput, "--channel", "test-client-acceptance", "--force-update"]);
  const testEnvelope = JSON.parse(await readFile(testOutput));
  assert.equal(verifyRelease(testEnvelope, { keys: { "test-only": publicKey.export({ type: "spki", format: "pem" }) },
    product: "wanx-client" }).release.channel, "test-client-acceptance");
  assert.equal(testEnvelope.payload.forceUpdate, true);
  assert.deepEqual(testEnvelope.payload.artifacts, envelope.payload.artifacts);
  assert.equal(testEnvelope.payload.buildId, envelope.payload.buildId);
  assert.deepEqual(JSON.parse(await readFile(reportPath)), report, "signing for another channel must not edit the build report");
  for (const channel of ["", "stable ", "../stable", "a".repeat(33), 1])
    await assert.rejects(signClientRelease({ ...input, channel, outputPath: path.join(root, "invalid-channel.json") }), /渠道无效/);
  assert.deepEqual(envelope.payload.sourceCommits, { "wanx-client": { "centuarai-wanx": "a".repeat(40) } });
  assert.equal(verifyRelease(envelope, { keys: { "test-only": publicKey.export({ type: "spki", format: "pem" }) }, product: "wanx-client", now: input.now }).release.buildId, "build-2");
  await assert.rejects(signClientRelease(input), { code: "EEXIST" });
  for (const updateTrust of [undefined, {}, { "test-only": "f".repeat(64) }]) {
    await writeFile(reportPath, JSON.stringify({ ...report, updateTrust }));
    await assert.rejects(signClientRelease({ ...input, outputPath: path.join(root, "untrusted.json") }), /更新信任根/);
  }
  await writeFile(reportPath, JSON.stringify({ ...report, updateArtifact: { ...report.updateArtifact, notarized: false } }));
  await assert.rejects(signClientRelease({ ...input, outputPath: path.join(root, "unnotarized-zip.json") }), /正式 macOS/);
  const windowsReport = { ...report, platform: "windows", notarized: undefined, authenticodeVerified: true, publisherName: "Example Publisher",
    build: { ...report.build, installationScope: "per-user" }, updateArtifact: { ...report.updateArtifact, kind: "nsis" } };
  await writeFile(reportPath, JSON.stringify(windowsReport));
  const windowsOutput = path.join(root, "windows-release.json");
  await signClientRelease({ ...input, artifactURL: "https://release.example.test/setup.exe", outputPath: windowsOutput });
  const windowsEnvelope = JSON.parse(await readFile(windowsOutput));
  assert.equal(verifyRelease(windowsEnvelope, { keys: { "test-only": publicKey.export({ type: "spki", format: "pem" }) }, product: "wanx-client", now: input.now }).release.platform.os, "win32");
  for (const invalid of [
    { ...windowsReport, authenticodeVerified: false },
    { ...windowsReport, publisherName: undefined },
    { ...windowsReport, build: { ...windowsReport.build, installationScope: "per-machine" } },
    { ...windowsReport, build: { ...windowsReport.build, sourceDirty: true } },
    { ...windowsReport, build: { ...windowsReport.build, sourceCommit: undefined } },
    { ...windowsReport, updateArtifact: { ...windowsReport.updateArtifact, kind: "portable" } },
  ]) {
    await writeFile(reportPath, JSON.stringify(invalid));
    await assert.rejects(signClientRelease({ ...input, outputPath: path.join(root, "invalid-windows.json") }), /正式 macOS 或 Windows/);
  }
  await writeFile(reportPath, JSON.stringify({ ...report, distributionClass: "local-verification-only" }));
  await assert.rejects(signClientRelease({ ...input, outputPath: path.join(root, "internal.json") }), /正式 macOS/);
  await writeFile(reportPath, JSON.stringify(report)); await writeFile(file, "modified archive");
  await assert.rejects(signClientRelease({ ...input, outputPath: path.join(root, "modified.json") }), /不一致/);
});

test("release signing binds the exact final blockmap bytes and refuses missing, changed or invalid maps", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-blockmap-release-")); t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("final signed archive"), file = path.join(root, "app.zip");
  const reportPath = path.join(root, "report.json"), outputPath = path.join(root, "release.json");
  await writeFile(file, bytes);
  const blockMap = await createClientBlockMap(file), mapBytes = await readFile(blockMap.path);
  assert.deepEqual(await readFile(file), bytes, "creating a sidecar must not change signed artifact bytes");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"), privateKeyPath = path.join(root, "test-only.pem");
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const report = { version: "2.0.0", appId: "ai.centuarai.wanx.client", platform: "macos", signed: true, notarized: true, distributionClass: "formal", arch: "arm64",
    updateTrust: clientTrustFingerprints({ schemaVersion: 1, keys: { fixture: publicPem } }),
    build: { distributionClass: "formal", buildId: "build-2", channel: "stable", securityEpoch: 0,
      sourceCommit: "a".repeat(40), sourceDirty: false },
    updateArtifact: { path: file, kind: "mac-zip", notarized: true, sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), sha512: createHash("sha512").update(bytes).digest("base64"), blockMap } };
  await writeFile(reportPath, JSON.stringify(report));
  const input = { reportPath, outputPath, privateKeyPath, artifactURL: "https://release.example.test/app.zip",
    blockMapURL: "https://release.example.test/app.zip.blockmap", keyId: "fixture", releaseId: "client-2.0.0",
    metadataSequence: 2, supportedOsVersions: ["25.0.0"], compatibleApplications: [],
    now: Date.parse("2026-10-14T00:00:00Z"), expiresAt: "2099-01-01T00:00:00Z" };
  await assert.rejects(signClientRelease({ ...input, blockMapURL: undefined }), /--blockmap-url/);
  for (const blockMapURL of ["http://release.example.test/app.zip.blockmap", "https://release.example.test/app.zip",
    "https://user:password@release.example.test/app.zip.blockmap", "https://release.example.test/app.zip.blockmap#fragment"])
    await assert.rejects(signClientRelease({ ...input, blockMapURL }), /blockmap|UPDATE_INVALID_ARTIFACT/);
  const supportPath = path.join(root, "support.json");
  await writeFile(supportPath, JSON.stringify({ supportedOsVersions: input.supportedOsVersions, compatibleApplications: [] }));
  execFileSync(process.execPath, [fileURLToPath(new URL("../tools/sign-client-release.mjs", import.meta.url)),
    "--report", reportPath, "--url", input.artifactURL, "--blockmap-url", input.blockMapURL,
    "--key-id", input.keyId, "--private-key", privateKeyPath, "--release-id", input.releaseId,
    "--sequence", "2", "--support", supportPath, "--expires-at", input.expiresAt, "--out", outputPath, "--force-update"]);
  const envelope = JSON.parse(await readFile(outputPath));
  const release = verifyRelease(envelope, { keys: { fixture: publicPem }, product: "wanx-client" }).release;
  assert.equal(release.forceUpdate, true);
  assert.deepEqual(release.artifacts[0].blockMap, { url: input.blockMapURL, sizeBytes: mapBytes.length,
    sha256: createHash("sha256").update(mapBytes).digest("hex") });
  assert.equal(release.artifacts[0].blockMap.path, undefined, "local paths are not published");
  const invalidInput = { ...input, outputPath: path.join(root, "invalid.json") };
  await writeFile(blockMap.path, Buffer.from(mapBytes).reverse());
  await assert.rejects(signClientRelease(invalidInput), /blockmap.*不一致/);
  await rm(blockMap.path);
  await assert.rejects(signClientRelease(invalidInput), { code: "ENOENT" });
  await writeFile(blockMap.path, mapBytes);
  await truncate(blockMap.path, MAX_CLIENT_BLOCKMAP_SIZE_BYTES + 1);
  await assert.rejects(signClientRelease(invalidInput), /16 MiB/);
  for (const invalid of [null, { ...JSON.parse(gunzipSync(mapBytes)), version: "1" },
    { version: "2", files: [{ name: "file", offset: 0, checksums: ["A".repeat(24)], sizes: [bytes.length + 1] }] }]) {
    const invalidBytes = gzipSync(JSON.stringify(invalid));
    await writeFile(blockMap.path, invalidBytes);
    await writeFile(reportPath, JSON.stringify({ ...report, updateArtifact: { ...report.updateArtifact,
      blockMap: { ...blockMap, sizeBytes: invalidBytes.length, sha256: createHash("sha256").update(invalidBytes).digest("hex") } } }));
    await assert.rejects(signClientRelease(invalidInput), /blockmap.*v2/);
  }
  const legacyArtifact = { ...report.updateArtifact }; delete legacyArtifact.blockMap;
  await writeFile(reportPath, JSON.stringify({ ...report, updateArtifact: legacyArtifact }));
  await assert.rejects(signClientRelease(invalidInput), /报告不包含/);
});

test("formal Windows build pins certificate, publisher, current-user NSIS scope and forbids unsigned fallback", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const input = { pkg, version: "2.0.0", arch: "x64", out: "output", trustFile: "production-trust.json",
    publisherName: "Example Publisher", certificateSha1: "a".repeat(40), build: { buildId: "test-build", channel: pkg.wanxEdition === "team" ? "stable-studio" : "stable" } };
  const config = windowsReleaseConfiguration(input);
  await validateConfiguration(config, { isEnabled: false });
  assert.equal(config.forceCodeSigning, true); assert.equal(config.win.forceCodeSigning, true);
  assert.equal(config.afterPack, "tools/package-client-native.mjs");
  assert.equal(config.win.verifyUpdateCodeSignature, true);
  assert.deepEqual(config.win.signtoolOptions.publisherName, ["Example Publisher"]);
  assert.equal(config.nsis.perMachine, false); assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.differentialPackage, true);
  for (const field of ["include", "installerHeader", "installerSidebar", "uninstallerSidebar"])
    assert.ok(config.nsis[field], `formal builds must retain the branded installer ${field}`);
  assert.equal(config.extraMetadata.wanxBuild.distributionClass, "formal");
  assert.equal(config.extraMetadata.wanxBuild.installationScope, "per-user");
  assert.ok(config.files.includes("updates/**"));
  assert.ok(config.extraResources.some(resource => resource.to === "security/verify-signed.ps1"));
  assert.equal(config.win.signtoolOptions.certificatePassword, undefined, "secrets are provided only through the signing environment");
  assert.throws(() => windowsReleaseConfiguration({ ...input, certificateSha1: undefined }), /SIGNING_CONFIGURATION_REQUIRED/);
  assert.throws(() => windowsReleaseConfiguration({ ...input, certificateFile: "also.pfx" }), /SIGNING_CONFIGURATION_REQUIRED/);
});

test("formal Windows trust requires an Ed25519 public-key map and the configured publisher", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" });
  const trust = { schemaVersion: 1, keys: { production: pem }, windowsPublisherNames: ["Example Publisher"] };
  assert.equal(validateWindowsTrust(trust, "Example Publisher"), trust);
  for (const keys of [null, [], [pem], {}, "key", { test: privateKey.export({ type: "pkcs8", format: "pem" }) }])
    assert.throws(() => validateWindowsTrust({ ...trust, keys }, "Example Publisher"), /生产信任文件/);
  assert.throws(() => validateWindowsTrust(null, "Example Publisher"), /生产信任文件/);
  assert.throws(() => validateWindowsTrust(trust, "Other Publisher"), /生产信任文件/);
  for (const invalid of [null, {}, { ...trust, keys: [] }, { ...trust, keys: { production: "malformed PEM" } },
    { ...trust, keys: { "": pem } }, { ...trust, keys: { production: privateKey.export({ type: "pkcs8", format: "pem" }) } }])
    assert.throws(() => validateClientTrust(invalid), /生产信任文件/);
});

test("formal macOS builds require trust before invoking build or notarization tools", { skip: process.platform !== "darwin" }, async t => {
  t.mock.method(childProcess, "execFileSync", (command, args) => {
    assert.equal(command, "git");
    if (args[0] === "rev-parse") return "a".repeat(40);
    if (args[0] === "status") return "";
    throw new Error("unexpected git query");
  });
  await assert.rejects(packageClient({ version: "2.0.0", notaryProfile: "fixture" }), /--trust-file/);
});

for (const arch of ["arm64", "x64"]) test(`formal macOS ${arch} verifies the actual builder layout and notarizes the update ZIP`, { skip: process.platform !== "darwin" }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-formal-package-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const out = path.join(directory, "out"), trustFile = path.join(directory, "trust.json");
  const { publicKey } = generateKeyPairSync("ed25519");
  const trust = { schemaVersion: 1, keys: { fixture: publicKey.export({ type: "spki", format: "pem" }) } };
  await writeFile(trustFile, JSON.stringify(trust));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const app = path.join(out, arch === "x64" ? "mac" : "mac-arm64", `${pkg.build.productName}.app`);
  const calls = []; let packed;
  t.mock.method(require("@electron/asar"), "extractFile", () => Buffer.from(JSON.stringify(packed)));
  t.mock.method(childProcess, "execFileSync", (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") return args[0] === "rev-parse" ? "a".repeat(40) : "";
    if (command === "lipo") return arch === "x64" ? "x86_64" : "arm64";
    if (command === "/usr/libexec/PlistBuddy") return {
      CFBundleIdentifier: pkg.build.appId, CFBundleShortVersionString: "2.0.0", CFBundleName: pkg.build.productName,
      CFBundleExecutable: "WANX",
    }[args[1].split(":").at(-1)];
    if (command === "xcrun") return "status: Accepted";
    throw new Error(`unexpected command: ${command}`);
  });
  t.mock.method(childProcess, "spawnSync", (command, args) => {
    calls.push([command, ...args]);
    if (command.endsWith("electron-builder")) {
      const config = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"));
      assert.equal(config.forceCodeSigning, true);
      assert.equal(config.mac.defaultArch, "x64");
      packed = config.extraMetadata;
      fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
      fs.mkdirSync(path.join(app, "Contents/Resources/network"), { recursive: true });
      fs.writeFileSync(path.join(app, "Contents/MacOS/WANX"), "fixture");
      for (const name of [`wanx-netbird-darwin-${arch}`, `wanx-discovery-darwin-${arch}`])
        fs.writeFileSync(path.join(app, "Contents/Resources/network", name), "fixture", { mode: 0o755 });
      const resource = config.extraResources.find(item => item.to === "wanx-update-trust.json");
      assert.notEqual(resource.from, trustFile, "the packaged trust must be the validated snapshot");
      fs.copyFileSync(resource.from, path.join(app, "Contents/Resources/wanx-update-trust.json"));
      fs.writeFileSync(path.join(out, "fixture.dmg"), "fixture DMG");
      fs.writeFileSync(path.join(out, "fixture.zip"), "before stapling");
      fs.writeFileSync(path.join(out, "fixture.zip.blockmap"), "stale builder blockmap");
    }
    if (command === "ditto") {
      assert.equal(args.at(-2), app);
      assert.ok(calls.some(call => call[0] === "xcrun" && call[1] === "stapler" && call[2] === "validate" && call[3] === app));
      fs.writeFileSync(args.at(-1), "ZIP containing stapled application");
    }
    return { status: 0, stdout: "", stderr: command === "codesign" ? "Authority=Developer ID Application: Fixture" : "" };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const report = await packageClient({ version: "2.0.0", arch, out, trustFile, notaryProfile: "fixture" });
  assert.equal(report.edition, pkg.wanxEdition);
  assert.equal(packed.wanxEdition, pkg.wanxEdition);
  assert.deepEqual(report.updateTrust, clientTrustFingerprints(trust));
  assert.equal(report.nativeBinaries.engine.sha256, createHash("sha256").update("fixture").digest("hex"));
  assert.equal(report.updateArtifact.notarized, true);
  assert.equal(report.updateArtifact.sha256, createHash("sha256").update("ZIP containing stapled application").digest("hex"));
  const blockMap = report.updateArtifact.blockMap, mapBytes = await readFile(blockMap.path);
  assert.equal(blockMap.path, `${report.updateArtifact.path}.blockmap`);
  assert.equal(blockMap.sizeBytes, mapBytes.length);
  assert.equal(blockMap.sha256, createHash("sha256").update(mapBytes).digest("hex"));
  const map = JSON.parse(gunzipSync(mapBytes));
  assert.equal(map.version, "2");
  assert.deepEqual(map.files[0].sizes, [Buffer.byteLength("ZIP containing stapled application")], "map must be rebuilt after stapling");
  assert.ok((await readFile(path.join(out, "SHA256SUMS.txt"), "utf8")).includes(`${blockMap.sha256}  fixture.zip.blockmap\n`));
  const submitted = calls.filter(call => call[0] === "xcrun" && call[1] === "notarytool" && call[2] === "submit").map(call => path.extname(call[3]));
  assert.deepEqual(submitted, [".zip", ".dmg"]);
});

test("Windows Authenticode gate rejects invalid signatures, publisher mismatch and missing timestamps", { skip: process.platform !== "win32" }, () => {
  const script = fileURLToPath(new URL("../shell/verify-signed.ps1", import.meta.url)).replaceAll("'", "''");
  for (const [status, publisher, timestamp, expected] of [
    ["Valid", "Expected Publisher", "$true", null],
    ["NotSigned", "Expected Publisher", "$true", "WINDOWS_SIGNATURE_INVALID"],
    ["Valid", "Wrong Publisher", "$true", "WINDOWS_SIGNATURE_PUBLISHER_MISMATCH"],
    ["Valid", "Expected Publisher", "$null", "WINDOWS_SIGNATURE_TIMESTAMP_REQUIRED"],
  ]) {
    const command = `$ErrorActionPreference = 'Stop'; function Get-AuthenticodeSignature { param($LiteralPath)
      $cert = [pscustomobject]@{ Subject = '${publisher}' }
      $cert | Add-Member -MemberType ScriptMethod -Name GetNameInfo -Value { return $this.Subject }
      return [pscustomobject]@{ Status = '${status}'; SignerCertificate = $cert; TimeStamperCertificate = ${timestamp} }
    }; & '${script}' -Path 'fixture.exe' -PublisherName 'Expected Publisher'`;
    const run = () => execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", stdio: "pipe" });
    if (expected) assert.throws(run, error => String(error.stderr).includes(expected));
    else assert.match(run(), /WINDOWS_SIGNATURE_VERIFIED/);
  }
});

test("source changes produce different build identities without changing the product version", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-build-identity-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["shell", "updates", "applications", "local-ui", "account", "app-host", "network", "octop"]) await mkdir(path.join(root, directory));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.0.0", wanxEdition: "personal" }));
  for (const file of ["client.mjs", "platform.mjs"]) await writeFile(path.join(root, file), "initial");
  const app = { getAppPath: () => root, getVersion: () => "1.0.0", isPackaged: false };
  const before = await readClientIdentity({ app });
  await writeFile(path.join(root, "client.mjs"), "changed source");
  const after = await readClientIdentity({ app });
  assert.equal(before.productVersion, after.productVersion); assert.notEqual(before.buildId, after.buildId);
  assert.equal(after.distributionClass, "development");
  app.isPackaged = true;
  assert.equal((await readClientIdentity({ app })).distributionClass, "unverified");
});
