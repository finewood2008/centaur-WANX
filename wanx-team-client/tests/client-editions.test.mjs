import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { readClientIdentity } from "../updates/identity.mjs";
import { canonicalJSON, digestPayload, verifyRelease, clientBlockers } from "../updates/contracts.mjs";
import { createClientUpdates } from "../updates/client-service.mjs";
import { signClientRelease } from "../tools/sign-client-release.mjs";
import { clientTrustFingerprints } from "../tools/package-client-trust.mjs";
import { readSourceClientManifest, readPackagedClientManifest } from "../tools/client-package-manifest.mjs";
import { windowsReleaseConfiguration } from "../tools/package-client-windows.mjs";
import { TEST_APP_ID, TEST_PRODUCT_NAME, TEST_PACKAGE_NAME, TEST_EXTENSION } from "../updates/test-build.mjs";

const require = createRequire(import.meta.url);
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const ids = { personal: "ai.centuarai.wanx.client", team: "ai.centuarai.wanx.studio.team.local" };
const channel = edition => edition === "team" ? "stable-studio" : "stable";
const now = Date.parse("2026-10-14T12:00:00Z");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keys = { fixture: publicKey.export({ type: "spki", format: "pem" }) };
const original = JSON.parse(await readFile(new URL("fixtures/wanx-upgrade-v1/client-release.json", import.meta.url), "utf8")).payload;
const envelope = patch => {
  const payload = { ...structuredClone(original), ...patch };
  return { payload, signature: { algorithm: "ed25519", keyId: "fixture", signatureBase64: sign(null, Buffer.from(canonicalJSON(payload)), privateKey).toString("base64") } };
};
const identity = edition => ({ edition, packaged: true, distributionClass: "formal", channel: channel(edition),
  productVersion: "1.0.0", buildId: "old", platform: "win32", arch: "x64", osVersion: "10.0.26100",
  installationScope: "per-user", hostProtocol: 1, securityEpoch: 0 });
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-edition-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test("client identity reads the packaged edition marker, including isolated packages", async t => {
  const root = await temporary(t), app = { getAppPath: () => root, isPackaged: true, getVersion: () => "1.0.0" };
  await writeFile(path.join(root, "package.json"), JSON.stringify({ wanxEdition: pkg.wanxEdition, wanxBuild: { channel: channel(pkg.wanxEdition) } }));
  assert.equal((await readClientIdentity({ app })).edition, pkg.wanxEdition);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: TEST_PACKAGE_NAME, productName: TEST_PRODUCT_NAME, wanxEdition: pkg.wanxEdition,
    wanxBuild: { distributionClass: "test-only", applicationId: TEST_APP_ID, testRunId: "edition", channel: "test-client-edition" } }));
  assert.equal((await readClientIdentity({ app })).edition, pkg.wanxEdition);
  for (const edition of [undefined, null, "enterprise"]) {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ wanxEdition: edition }));
    await assert.rejects(readClientIdentity({ app }), /EDITION|CONTRACT/);
  }
});

test("source and packaged manifests bind edition to the actual application identity", async t => {
  const root = await temporary(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
  assert.equal((await readSourceClientManifest(root)).pkg.wanxEdition, pkg.wanxEdition);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ ...pkg, wanxEdition: pkg.wanxEdition === "team" ? "personal" : "team" }));
  await assert.rejects(readSourceClientManifest(root), /CLIENT_SOURCE_MANIFEST_INVALID/);
  const source = path.join(root, "packed"), archive = path.join(root, "app.asar");
  await mkdir(source); await writeFile(path.join(source, "package.json"), JSON.stringify({ wanxEdition: "personal" }));
  await require("@electron/asar").createPackage(source, archive);
  assert.equal(readPackagedClientManifest(archive, "personal").wanxEdition, "personal");
  assert.throws(() => readPackagedClientManifest(archive, "team"), /EDITION/);
  const config = windowsReleaseConfiguration({ pkg, version: "1.2.0", arch: "x64", out: root, trustFile: "trust.json",
    publisherName: "Fixture", certificateSha1: "a".repeat(40), build: { channel: channel(pkg.wanxEdition) } });
  assert.equal(config.extraMetadata.wanxEdition, pkg.wanxEdition);
  assert.equal(config.appId, ids[pkg.wanxEdition]);
});

test("signed edition requires a client product and matching channel family without rewriting legacy bytes", () => {
  for (const edition of ["personal", "team"]) {
    const signed = envelope({ edition, channel: channel(edition) });
    assert.equal(verifyRelease(signed, { keys, product: "wanx-client", now }).release.edition, edition);
    assert.deepEqual(clientBlockers(signed.payload, identity(edition), []), []);
    const other = identity(edition === "personal" ? "team" : "personal");
    assert.ok(clientBlockers(signed.payload, other, []).some(item => item.code === "UPDATE_EDITION_MISMATCH"));
  }
  for (const patch of [{ edition: "team", channel: "stable" }, { edition: "personal", channel: "stable-studio" },
    { edition: null }, { edition: "enterprise" }, { edition: "team", product: "wanx-box" }]) {
    assert.throws(() => verifyRelease(envelope(patch), { keys, product: patch.product || "wanx-client", now }), /EDITION|CONTRACT/);
  }
  const legacy = envelope({ channel: "stable-studio" }), before = JSON.stringify(legacy);
  assert.equal(verifyRelease(legacy, { keys, product: "wanx-client", now }).digest, digestPayload(legacy.payload));
  assert.deepEqual(clientBlockers(legacy.payload, identity("team"), []), []);
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(Object.hasOwn(legacy.payload, "edition"), false);
});

test("cross-edition candidates block update without adding request fields or starting download", async () => {
  const release = envelope({ edition: "team", channel: "stable-studio" });
  const requests = []; let downloads = 0;
  const service = await createClientUpdates({ current: { ...identity("personal"), channel: "stable-studio" }, keys,
    now: () => now, installationId: "fixture", store: { load: async () => ({ schemaVersion: 1, sequences: {}, operation: null }), save: async () => {} },
    request: async input => { requests.push(input); return { status: "available", release, releaseDigest: digestPayload(release.payload), downloadUrls: {} }; },
    applications: { listInstalled: async () => [] }, createAdapter: async () => { downloads++; return {}; }, requestInstall: async () => {} });
  assert.equal((await service.check()).phase, "blocked");
  assert.ok(service.snapshot().blockers.some(item => item.code === "UPDATE_EDITION_MISMATCH"));
  await assert.rejects(service.download(), { code: "UPDATE_NOT_AVAILABLE" });
  assert.equal(downloads, 0);
  assert.equal(requests.some(request => Object.hasOwn(request.body, "edition")), false);
});

test("signing derives legacy edition only from exact app IDs and binds new reports explicitly", async t => {
  const root = await temporary(t), artifact = path.join(root, "app.zip"), reportPath = path.join(root, "report.json"), keyPath = path.join(root, "key.pem");
  const bytes = Buffer.from("edition signing fixture");
  await writeFile(artifact, bytes); await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  const base = { version: "1.2.0", platform: "macos", signed: true, notarized: true, distributionClass: "formal", arch: "arm64",
    updateTrust: clientTrustFingerprints({ schemaVersion: 1, keys }),
    build: { distributionClass: "formal", buildId: "fixture", channel: "stable", securityEpoch: 1, sourceCommit: "a".repeat(40), sourceDirty: false },
    updateArtifact: { path: artifact, kind: "mac-zip", notarized: true, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sha512: createHash("sha512").update(bytes).digest("base64") } };
  let serial = 0;
  async function signed(report, options = {}) {
    await writeFile(reportPath, JSON.stringify(report));
    const outputPath = path.join(root, `release-${serial++}.json`);
    await signClientRelease({ reportPath, outputPath, privateKeyPath: keyPath, artifactURL: "https://fixture.example.test/app.zip", keyId: "fixture",
      releaseId: `edition-${serial}`, metadataSequence: 1, supportedOsVersions: ["25.0.0"], compatibleApplications: [], now, expiresAt: "2099-01-01T00:00:00Z", ...options });
    return JSON.parse(await readFile(outputPath, "utf8"));
  }
  for (const edition of ["personal", "team"]) {
    const report = { ...base, appId: ids[edition], name: "unrelated display name", build: { ...base.build, channel: channel(edition) } };
    assert.equal((await signed(report)).payload.edition, edition);
    assert.equal((await signed({ ...report, edition })).payload.edition, edition);
    await assert.rejects(signed({ ...report, edition: edition === "team" ? "personal" : "team" }), /版别|EDITION/);
    await assert.rejects(signed(report, { channel: channel(edition === "team" ? "personal" : "team") }), /版别|EDITION/);
    await assert.rejects(signed({ ...report, build: { ...report.build, channel: channel(edition === "team" ? "personal" : "team") } },
      { channel: channel(edition) }), /版别|EDITION/);
  }
  for (const report of [{ ...base }, { ...base, appId: "unknown", name: "万象团队版" }, { ...base, appId: ids.personal, edition: null }])
    await assert.rejects(signed(report), /版别|EDITION/);
  const isolated = { ...base, edition: pkg.wanxEdition, appId: TEST_APP_ID, name: TEST_PRODUCT_NAME, version: "1.2.0-test.1", notarized: false,
    distributionClass: "test-only", build: { ...base.build, distributionClass: "test-only", applicationId: TEST_APP_ID, testRunId: "edition", channel: "test-client-edition", sourceSnapshot: "b".repeat(64) },
    updateArtifact: { ...base.updateArtifact, notarized: false } };
  const signedTest = await signed(isolated, { testOnly: true });
  assert.equal(signedTest.payload.edition, pkg.wanxEdition);
  assert.deepEqual(signedTest.payload.requiredExtensions, [TEST_EXTENSION]);
  const wrongTestEdition = envelope({ ...signedTest.payload, edition: pkg.wanxEdition === "personal" ? "team" : "personal" });
  assert.throws(() => verifyRelease(wrongTestEdition, { keys, product: "wanx-client", now,
    testIdentity: { ...isolated.build, packaged: true } }), /CONTRACT/);
  const noEdition = { ...isolated }; delete noEdition.edition;
  await assert.rejects(signed(noEdition, { testOnly: true }), /版别|EDITION/);
});
