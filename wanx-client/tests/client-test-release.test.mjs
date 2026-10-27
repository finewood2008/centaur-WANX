import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, chmod, stat, symlink, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareMacUpdatePermissions } from "../tools/package-client-permissions.mjs";
import { signClientRelease } from "../tools/sign-client-release.mjs";
import { clientTrustFingerprints } from "../tools/package-client-trust.mjs";
import { TEST_APP_ID, TEST_PACKAGE_NAME, TEST_PRODUCT_NAME, TEST_EXTENSION, testPackageIdentity } from "../updates/test-build.mjs";
import { testFeedURL, createTestUpdateRuntime } from "../updates/test-runtime.mjs";
import { verifyRelease } from "../updates/contracts.mjs";
import { createStartupSettings } from "../shell/startup.mjs";

test("test packaging identity is explicit and cannot reuse the production identity", () => {
  assert.equal(testPackageIdentity({}), null);
  const pkg = { name: TEST_PACKAGE_NAME, productName: TEST_PRODUCT_NAME,
    wanxBuild: { distributionClass: "test-only", applicationId: TEST_APP_ID, testRunId: "fixture", channel: "test-client-fixture" } };
  assert.equal(testPackageIdentity(pkg).testRunId, "fixture");
  for (const invalid of [{ ...pkg, name: "centuarai-wanx-client" }, { ...pkg, productName: "万象" },
    { ...pkg, wanxBuild: { ...pkg.wanxBuild, channel: "stable" } }, { ...pkg, wanxBuild: { ...pkg.wanxBuild, testRunId: "../bad" } }])
    assert.throws(() => testPackageIdentity(invalid), /UPDATE_TEST_CONFIGURATION_INVALID/);
});

test("test transport cannot accept a non-loopback HTTPS endpoint or affect a formal build", async () => {
  assert.equal(testFeedURL("https://127.0.0.1:54321/").port, "54321");
  for (const url of ["http://127.0.0.1:123/", "https://example.com:123/", "https://127.0.0.1/", "https://user:pass@127.0.0.1:123/", "https://127.0.0.1:123/path", "https://127.0.0.1:123/?x=1"])
    assert.throws(() => testFeedURL(url));
  assert.equal(await createTestUpdateRuntime({ identity: { distributionClass: "formal", packaged: true } }), null);
});

test("test applications never register login startup", () => {
  const app = { isPackaged: true, getPath: () => "/tmp/test", isInApplicationsFolder: () => true,
    getLoginItemSettings() { assert.fail("must not read production startup"); }, setLoginItemSettings() { assert.fail("must not change production startup"); } };
  const startup = createStartupSettings({ app, platform: "darwin", testBuild: true });
  assert.equal(startup.initializeDefault().supported, false);
  assert.equal(startup.set(true).supported, false);
});

test("test release requires explicit mode, isolated metadata and test trust; formal clients reject it", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-test-release-")); t.after(() => rm(root, { recursive: true, force: true }));
  const artifactPath = path.join(root, "test.zip"), bytes = Buffer.from("isolated-test-fixture"); await writeFile(artifactPath, bytes);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = path.join(root, "key.pem"), reportPath = path.join(root, "report.json"), outputPath = path.join(root, "release.json");
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const keys = { test: publicKey.export({ type: "spki", format: "pem" }) };
  const build = { distributionClass: "test-only", applicationId: TEST_APP_ID, testRunId: "fixture", channel: "test-client-fixture",
    sourceSnapshot: "a".repeat(64), sourceDirty: true, sourceCommit: null, securityEpoch: 0, buildId: "test-fixture-2" };
  const report = { edition: "personal", appId: TEST_APP_ID, name: TEST_PRODUCT_NAME, version: "0.1.5-test.2", platform: "macos", arch: "arm64",
    distributionClass: "test-only", signed: true, notarized: false, build, updateTrust: clientTrustFingerprints({ schemaVersion: 1, keys }),
    updateArtifact: { path: artifactPath, kind: "mac-zip", notarized: false, sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), sha512: createHash("sha512").update(bytes).digest("base64") } };
  await writeFile(reportPath, JSON.stringify(report));
  const input = { reportPath, outputPath, privateKeyPath, artifactURL: "https://127.0.0.1:12345/client-update.zip", keyId: "test",
    releaseId: "test-fixture-release", metadataSequence: 1, supportedOsVersions: [os.release()], compatibleApplications: [],
    now: Date.now(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
  await assert.rejects(signClientRelease(input), /正式/);
  for (const channel of ["stable", "test-client-other"])
    await assert.rejects(signClientRelease({ ...input, testOnly: true, channel }), /专用测试渠道/);
  await signClientRelease({ ...input, testOnly: true });
  const envelope = JSON.parse(await readFile(outputPath));
  assert.equal(envelope.payload.sourceCommits, undefined);
  assert.equal(envelope.payload.sourceSnapshot, build.sourceSnapshot);
  assert.deepEqual(envelope.payload.requiredExtensions, [TEST_EXTENSION]);
  assert.throws(() => verifyRelease(envelope, { keys, product: "wanx-client", now: input.now }), /CONTRACT_UNSUPPORTED/);
  const testIdentity = { ...build, packaged: true };
  assert.equal(verifyRelease(envelope, { keys, product: "wanx-client", now: input.now, testIdentity }).release.version, report.version);
  assert.throws(() => verifyRelease(envelope, { keys, product: "wanx-client", now: input.now,
    testIdentity: { ...testIdentity, testRunId: "other", channel: "test-client-other" } }), /CONTRACT_UNSUPPORTED/);
});


test("test CA is pinned only inside Electron updater session, never the browser or global trust", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-test-ca-")); t.after(() => rm(root, { recursive: true, force: true }));
  const ca = await readFile(new URL("./fixtures/updates/test-loopback-cert.pem", import.meta.url), "utf8");
  const build = { distributionClass: "test-only", applicationId: TEST_APP_ID, testRunId: "fixture", channel: "test-client-fixture",
    testFeedURL: "https://127.0.0.1:12345/", testCAFingerprint: new X509Certificate(ca).fingerprint256 };
  await writeFile(path.join(root, "wanx-test-ca.pem"), ca);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ wanxBuild: build }));
  let verifier;
  const runtime = await createTestUpdateRuntime({ identity: { ...build, packaged: true }, resourcesPath: root,
    app: { getAppPath: () => root }, session: { fromPartition(name, options) {
      assert.equal(name, "electron-updater"); assert.deepEqual(options, { cache: false });
      return { setCertificateVerifyProc(fn) { verifier = fn; } };
    } } });
  assert.ok(runtime);
  for (const [hostname, data, expected] of [["127.0.0.1", ca, 0], ["example.com", ca, -3], ["127.0.0.1", "malformed", -3]])
    verifier({ hostname, certificate: { data } }, result => assert.equal(result, expected));
});


test("macOS staging repairs read-only licenses before signing without following external symlinks", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-bundle-permissions-")); t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, "test.app"), license = path.join(bundle, "LICENSE"), binary = path.join(bundle, "executable"), outside = path.join(root, "outside");
  await mkdir(bundle); await writeFile(license, "license"); await writeFile(binary, "binary"); await writeFile(outside, "outside");
  await chmod(license, 0o444); await chmod(binary, 0o555); await chmod(outside, 0o444);
  await symlink(outside, path.join(bundle, "external-link"));
  await assert.rejects(prepareMacUpdatePermissions(bundle, { checkOnly: true }), /CLIENT_BUNDLE_NOT_UPDATABLE/);
  assert.equal(await prepareMacUpdatePermissions(bundle), 2);
  assert.equal((await stat(license)).mode & 0o777, 0o644);
  assert.equal((await stat(binary)).mode & 0o777, 0o755);
  assert.equal((await stat(outside)).mode & 0o777, 0o444);
  assert.equal(await prepareMacUpdatePermissions(bundle, { checkOnly: true }), 0);
  assert.equal(await readFile(license, "utf8"), "license");
});
