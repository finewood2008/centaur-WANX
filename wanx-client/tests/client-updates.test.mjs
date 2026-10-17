import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJSON, digestPayload, verifyRelease } from "../updates/contracts.mjs";
import { createClientUpdates } from "../updates/client-service.mjs";
import { SignedReleaseProvider, verifyDownloadedFile } from "../updates/electron.mjs";
import { createUpdateStore } from "../updates/store.mjs";

const now = Date.parse("2026-10-14T12:00:00Z");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keys = { test: publicKey.export({ type: "spki", format: "pem" }) };
const bytes = Buffer.from("signed client package");
const artifact = { component: "wanx-client", kind: "mac-zip", url: "https://updates.example.test/wanx.zip",
  sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sha512: createHash("sha512").update(bytes).digest("base64") };
const current = { productVersion: "1.0.0", buildId: "build-1", packaged: true, distributionClass: "formal", channel: "stable",
  platform: "darwin", arch: "arm64", osVersion: "25.0.0", hostProtocol: 1, securityEpoch: 1 };
function release(patch = {}) {
  const payload = { schemaVersion: 1, purpose: "wanx.release.v1", releaseId: "client-1.1.0", product: "wanx-client", version: "1.1.0",
    buildId: "build-2", metadataSequence: 2, securityEpoch: 1, channel: "stable", platform: { os: "darwin", arch: "arm64", osVersion: "25.0.0" },
    supportedOsVersions: ["25.0.0"], backendContract: 1, hostProtocol: 1, dataPolicy: "backward-compatible", requiredExtensions: [],
    compatibleApplications: [{ applicationId: "example.app", versionRange: "^2.0.0" }],
    components: { "wanx-client": { version: "1.1.0", sha256: artifact.sha256 } }, artifacts: [artifact],
    createdAt: "2026-10-14T00:00:00Z", expiresAt: "2026-11-14T00:00:00Z", ...patch };
  return { payload, signature: { algorithm: "ed25519", keyId: "test", signatureBase64: sign(null, Buffer.from(canonicalJSON(payload)), privateKey).toString("base64") } };
}
function response(envelope = release(), status = "available") {
  return { status, release: envelope, releaseDigest: digestPayload(envelope.payload), downloadUrls: {} };
}
function memoryStore(initial) {
  let saved = initial || { schemaVersion: 1, sequences: {}, operation: null };
  return { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); }, read: () => saved };
}
async function harness(options = {}) {
  let result = response(), calls = 0, downloads = 0, installs = 0, maintenance = false;
  let installed = [{ applicationId: "example.app", version: "2.0.1", artifactId: "app-old" }];
  const store = options.store || memoryStore();
  const service = await createClientUpdates({ current, keys, now: () => now, installationId: "installation-one", store,
    request: async () => { calls++; return structuredClone(result); },
    applications: { listInstalled: async () => installed, beginMaintenance() { assert.equal(maintenance, false); maintenance = true; return () => { maintenance = false; }; } },
    createAdapter: async () => ({ download: async () => { downloads++; return { file: "download.zip" }; }, verify: async () => {}, install() { installs++; }, close() {} }),
    requestInstall: async finalize => finalize(), ...options });
  return { service, store, offer: value => { result = value; }, installed: value => { installed = value; }, calls: () => calls,
    downloads: () => downloads, installs: () => installs, maintenance: () => maintenance };
}

test("signed release rejects tampering, unknown contracts, expiration and unsafe numbers", () => {
  assert.equal(verifyRelease(release(), { keys, product: "wanx-client", now }).release.version, "1.1.0");
  const bad = release(); bad.payload.version = "8.0.0";
  assert.throws(() => verifyRelease(bad, { keys, product: "wanx-client", now }), { code: "SIGNATURE_INVALID" });
  for (const patch of [{ requiredExtensions: ["new-contract"] }, { requiredExtensions: {} }])
    assert.throws(() => verifyRelease(release(patch), { keys, product: "wanx-client", now }), { code: "CONTRACT_UNSUPPORTED" });
  assert.throws(() => verifyRelease(release({ expiresAt: "2026-10-13T00:00:00Z" }), { keys, product: "wanx-client", now }), { code: "UPDATE_INVALID_RELEASE" });
  assert.throws(() => canonicalJSON({ value: 1.5 }), { code: "CONTRACT_UNSUPPORTED" });
  assert.throws(() => verifyRelease(release(), { keys: {}, product: "wanx-client", now }), { code: "UPDATE_UNTRUSTED_KEY" });
});

test("a controlled download requires a separate install confirmation; success requires new running identity", async () => {
  const h = await harness();
  assert.equal((await h.service.check()).phase, "available");
  assert.equal(h.downloads(), 0);
  assert.equal((await h.service.download()).phase, "downloaded");
  assert.equal(h.installs(), 0);
  assert.equal(h.store.read().operation.phase, "downloaded");
  await h.service.install({ confirmed: true });
  assert.equal(h.installs(), 1);
  assert.equal(h.store.read().operation.phase, "installing");
  const old = await harness({ store: h.store });
  assert.equal((await old.service.ready()).reason, "UPDATE_RECOVERY_REQUIRED");
  const other = await harness({ store: h.store, current: { ...current, productVersion: "1.1.0", buildId: "build-2" }, installationId: "other-copy" });
  assert.equal((await other.service.ready()).lastResult.phase, "interrupted");
  const upgraded = await harness({ store: h.store, current: { ...current, productVersion: "1.1.0", buildId: "build-2" } });
  assert.equal((await upgraded.service.ready()).phase, "succeeded");
  assert.equal(h.store.read().operation.phase, "succeeded");
});

test("development, internal and unconfigured builds cannot contact the update endpoint", async () => {
  for (const override of [{ current: { ...current, packaged: false } }, { current: { ...current, distributionClass: "unsigned-internal-only" } }, { keys: {} }]) {
    const h = await harness(override);
    await assert.rejects(h.service.check());
    assert.equal(h.calls(), 0); assert.equal(h.downloads(), 0);
  }
});

test("same SemVer rebuilds, unknown OS and incompatible installed apps block activation", async () => {
  for (const patch of [
    { version: "1.0.0", buildId: "other-build", components: { "wanx-client": { version: "1.0.0", sha256: artifact.sha256 } } },
    { supportedOsVersions: [] }, { compatibleApplications: [] }, { securityEpoch: 0 },
  ]) {
    const h = await harness(); h.offer(response(release(patch)));
    assert.equal((await h.service.check()).phase, "blocked");
    await assert.rejects(h.service.download()); assert.equal(h.downloads(), 0);
  }
});

test("signed metadata sequence cannot regress or reuse a sequence for different bytes across restart", async () => {
  const h = await harness(); await h.service.check();
  for (const patch of [{ metadataSequence: 1 }, { buildId: "replacement" }]) {
    const restarted = await harness({ store: h.store }); restarted.offer(response(release(patch)));
    await assert.rejects(restarted.service.check(), { code: "UPDATE_METADATA_REPLAY" });
  }
});

test("withdrawal and baseline changes between download and install retain the running Host", async () => {
  const h = await harness(); await h.service.check(); await h.service.download();
  h.offer({ status: "blocked", reasonCode: "RELEASE_WITHDRAWN" });
  await assert.rejects(h.service.install({ confirmed: true }), { code: "RELEASE_WITHDRAWN" });
  assert.equal(h.installs(), 0); assert.equal(h.maintenance(), false);
  const h2 = await harness(); await h2.service.check(); await h2.service.download();
  h2.installed([{ applicationId: "example.app", version: "2.1.0", artifactId: "changed" }]);
  await assert.rejects(h2.service.install({ confirmed: true }), { code: "PLAN_STALE" });
  assert.equal(h2.installs(), 0); assert.equal(h2.maintenance(), false);
});

test("account invalidation cannot resurrect a late candidate", async () => {
  let reply;
  const h = await harness({ request: () => new Promise(resolve => { reply = resolve; }) });
  const checking = h.service.check();
  while (!reply) await new Promise(resolve => setImmediate(resolve));
  h.service.invalidate(); reply(response());
  await assert.rejects(checking, { code: "UPDATE_SESSION_CHANGED" });
  assert.equal(h.service.snapshot().candidate, null);
  assert.equal(h.service.snapshot().phase, "idle");
});

test("the signed provider fixes version and hash and downloaded file bytes are checked again", async t => {
  const provider = new SignedReleaseProvider({ release: release().payload });
  const info = await provider.getLatestVersion();
  assert.equal(info.version, "1.1.0"); assert.equal(info.files[0].sha512, artifact.sha512);
  assert.equal(provider.resolveFiles(info)[0].url.href, artifact.url);
  assert.throws(() => new SignedReleaseProvider({ release: release().payload, downloadUrls: { "wanx-client": "http://unsafe.test/wanx.zip" } }), { code: "UPDATE_INVALID_ARTIFACT" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-update-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "client.zip"); await writeFile(file, bytes);
  await verifyDownloadedFile(file, artifact);
  await writeFile(file, Buffer.alloc(bytes.length));
  await assert.rejects(verifyDownloadedFile(file, artifact), { code: "UPDATE_ARTIFACT_MISMATCH" });
});

test("persistent state survives new store instances and corrupted state disables only updating", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-update-state-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json"); const store = createUpdateStore(file);
  await store.save({ schemaVersion: 1, sequences: { stable: { sequence: 4 } }, operation: null });
  assert.equal((await createUpdateStore(file).load()).sequences.stable.sequence, 4);
  await writeFile(file, "broken JSON");
  const h = await harness({ store: createUpdateStore(file) });
  assert.equal(h.service.snapshot().reason, "UPDATE_STATE_INVALID");
  await assert.rejects(h.service.check(), { code: "UPDATE_STATE_INVALID" });
});
