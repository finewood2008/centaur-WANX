import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZipFile } from "yazl";
import { validateCompatibility, evaluateApplicationCompatibility } from "../applications/compatibility.mjs";
import { validateApplicationManifest } from "../applications/manifest.mjs";
import { verifyEnvelope } from "../applications/descriptor.mjs";
import { createApplicationInstaller } from "../applications/installer.mjs";
import { createApplicationManager } from "../applications/manager.mjs";
import { createApplicationMarket } from "../applications/market.mjs";

const applicationId = "centaurai.wanx.zhijun";
const compatibility = {
  backendProductId: "wanx", clientRange: ">=0.1.0 <1.0.0", hostProtocolRange: ">=1.0.0 <2.0.0",
  backendContracts: [{ id: "wanx-bridge.readiness", range: ">=1.0.0 <2.0.0", features: ["read-only"] }],
  requiredExperts: [], localDataSchema: { readRange: ">=1.0.0 <2.0.0", writeVersion: "1.0.0" },
};
const manifest = { applicationId, name: "知君", version: "1.0.0", protocolVersion: 2, runtime: "electron", entrypoint: "main.mjs", capabilities: ["identity.read"], compatibility };
const backend = () => ({ schemaVersion: 1, productId: "wanx", deviceId: "box-a", observedAt: new Date().toISOString(),
  authorization: { status: "ready" }, contracts: [{ id: "wanx-bridge.readiness", version: "1.0.0", features: ["read-only"] }], experts: [] });
const runtime = () => ({ clientVersion: "0.2.0", hostProtocol: 1, backend: backend(), backendRequired: true });
const keys = generateKeyPairSync("ed25519"), trustedKeys = { test: keys.publicKey.export({ type: "spki", format: "pem" }) };
const envelopeFor = value => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { keyId: "test", descriptorBase64: bytes.toString("base64"), signatureBase64: sign(null, bytes, keys.privateKey).toString("base64") };
};
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-compatibility-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function artifact(root, version = "1.0.0", contract = compatibility, packaged = null) {
  const value = { ...manifest, version, compatibility: contract }, zip = new ZipFile(), chunks = [];
  zip.addBuffer(Buffer.from(JSON.stringify(packaged || value)), "wanx-app.json");
  zip.addBuffer(Buffer.from("export default {};\n"), "main.mjs");
  const done = new Promise((resolve, reject) => { zip.outputStream.on("data", chunk => chunks.push(chunk)); zip.outputStream.on("error", reject); zip.outputStream.on("end", resolve); });
  zip.end(); await done;
  const bytes = Buffer.concat(chunks), artifactId = randomUUID();
  const descriptor = { schemaVersion: 2, artifactId, applicationId, version, os: "universal", arch: "universal", packageType: "wanxapp", fileName: `app-${version}.wanxapp`, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, minWanxVersion: "0.1.0", hostProtocol: 1, compatibility: contract, manifest: value };
  const archivePath = path.join(root, `${artifactId}.wanxapp`);
  await writeFile(archivePath, bytes);
  return { descriptor, envelope: envelopeFor(descriptor), archivePath };
}
const candidate = value => ({ status: "available", release: { version: value.descriptor.version }, artifact: { ...value.descriptor, status: "ready", envelope: value.envelope } });

test("contract v2 is signed consistently and rejects unknown mandatory extensions", async t => {
  const value = await artifact(await temporary(t));
  assert.equal(verifyEnvelope(value.envelope, trustedKeys).schemaVersion, 2);
  for (const edit of [{ ...value.descriptor, critical: ["new-expert-policy"] }, { ...value.descriptor, unknownDependency: true },
    { ...value.descriptor, schemaVersion: 1 }, { ...value.descriptor, compatibility: { ...compatibility, clientRange: ">=0.3.0 <1.0.0" } }])
    assert.throws(() => verifyEnvelope(envelopeFor(edit), trustedKeys), { code: "MARKET_INVALID_DESCRIPTOR" });
  for (const edit of [{ ...compatibility, requiredModels: [] }, { ...compatibility, clientRange: "*" },
    { ...compatibility, clientRange: ">=2.0.0 <1.0.0" }, { ...compatibility, hostProtocolRange: "^1.0.0" }])
    assert.throws(() => validateCompatibility(edit), { code: "APPLICATION_CONTRACT_UNSUPPORTED" });
  assert.throws(() => validateApplicationManifest({ ...manifest, protocolVersion: 1 }), { code: "APPLICATION_CONTRACT_UNSUPPORTED" });
  assert.throws(() => validateApplicationManifest({ ...manifest, newRequiredContract: {} }), { code: "APPLICATION_CONTRACT_UNSUPPORTED" });
});

test("client and Host upper bounds, backend capabilities and authorization are separate checks", () => {
  assert.equal(evaluateApplicationCompatibility(manifest, runtime()).status, "ready");
  assert.equal(evaluateApplicationCompatibility(manifest, { ...runtime(), clientVersion: "1.0.0" }).checks[0].code, "CLIENT_VERSION_INCOMPATIBLE");
  assert.equal(evaluateApplicationCompatibility(manifest, { ...runtime(), hostProtocol: 2 }).checks[0].code, "HOST_PROTOCOL_INCOMPATIBLE");
  assert.equal(evaluateApplicationCompatibility(manifest, { clientVersion: "0.2.0", hostProtocol: 1 }).checks[0].code, "BACKEND_CAPABILITIES_UNKNOWN");
  const revoked = { ...runtime(), backend: { ...backend(), authorization: { status: "blocked", code: "APP_ENTITLEMENT_REQUIRED" } } };
  assert.equal(evaluateApplicationCompatibility(manifest, revoked).checks[0].code, "APP_ENTITLEMENT_REQUIRED");
  assert.equal(evaluateApplicationCompatibility(manifest, revoked, { phase: "candidate" }).status, "ready");
  assert.equal(evaluateApplicationCompatibility({ protocolVersion: 1 }, {}).status, "legacy");
});

test("expert names and catalog versions cannot masquerade as verified instance versions", () => {
  const required = { templateId: "zhijun-personal-companion", role: "companion", count: 1, required: true, versionRange: ">=1.0.0 <2.0.0" };
  const app = { ...manifest, compatibility: { ...compatibility, requiredExperts: [required] } };
  const actual = { ...runtime(), backend: { ...backend(), experts: [{ ...required, status: "ready", instances: [{ name: "知君", version: "1.0.0" }] }] } };
  assert.equal(evaluateApplicationCompatibility(app, actual).checks[0].code, "EXPERT_VERSION_UNKNOWN");
  app.compatibility.requiredExperts = [{ ...required, count: 2 }];
  actual.backend.experts[0].instances = [1, 2].map(() => ({ instanceId: "same-instance", version: "1.0.0", status: "ready" }));
  assert.equal(evaluateApplicationCompatibility(app, actual).checks[0].code, "EXPERT_VERSION_UNKNOWN");
});

test("stale, future and another device's capability evidence cannot authorize launch", () => {
  for (const observedAt of [new Date(Date.now() - 300001).toISOString(), new Date(Date.now() + 61000).toISOString()])
    assert.equal(evaluateApplicationCompatibility(manifest, { ...runtime(), backend: { ...backend(), observedAt } }).checks[0].code, "BACKEND_CAPABILITIES_UNKNOWN");
  assert.equal(evaluateApplicationCompatibility(manifest, { ...runtime(), expectedDeviceId: "box-b" }).checks[0].code, "BACKEND_CAPABILITIES_UNKNOWN");
});

test("unsigned import checks requirements before creating or replacing an installation", async t => {
  const root = await temporary(t), sourceDir = path.join(root, "source");
  await mkdir(sourceDir); await writeFile(path.join(sourceDir, "main.mjs"), "");
  await writeFile(path.join(sourceDir, "application.manifest.json"), JSON.stringify(manifest));
  const installer = createApplicationInstaller({ rootDir: path.join(root, "installed"), getCompatibilityContext: () => ({ clientVersion: "1.0.0", hostProtocol: 1 }) });
  await assert.rejects(installer.install({ sourceDir }), { code: "CLIENT_VERSION_INCOMPATIBLE" });
  assert.deepEqual(await installer.list(), []);
});

test("signed installation works offline but launch rechecks the selected backend before a session", async t => {
  const root = await temporary(t), value = await artifact(root), applicationRoot = path.join(root, "installed");
  const offline = () => ({ clientVersion: "0.2.0", hostProtocol: 1 });
  const installer = createApplicationInstaller({ rootDir: applicationRoot, trustedKeys, getCompatibilityContext: offline });
  await installer.installVerifiedPackage(value);
  let connections = 0;
  const manager = await createApplicationManager({ applicationRoot, trustedKeys, getCompatibilityContext: offline, createConnection: () => { connections++; throw new Error("must not run"); } });
  await assert.rejects(manager.launch(applicationId), { code: "BACKEND_CAPABILITIES_UNKNOWN" });
  assert.equal(connections, 0);
  assert.equal((await installer.resolveCurrent(applicationId)).version, "1.0.0");
  await manager.close();
});

test("package requirements must equal the signed descriptor, preserving the prior current version", async t => {
  const root = await temporary(t), installer = createApplicationInstaller({ rootDir: path.join(root, "installed"), trustedKeys, getCompatibilityContext: runtime });
  await installer.installVerifiedPackage(await artifact(root));
  const altered = { ...manifest, version: "1.1.0", compatibility: { ...compatibility, backendContracts: [] } };
  await assert.rejects(installer.installVerifiedPackage(await artifact(root, "1.1.0", compatibility, altered)), { code: "MARKET_PACKAGE_INVALID" });
  assert.equal((await installer.resolveCurrent(applicationId)).version, "1.0.0");
});

test("rollback requires actual data schema evidence and keeps the pointer on failure", async t => {
  const root = await temporary(t); let schema;
  const installer = createApplicationInstaller({ rootDir: path.join(root, "installed"), trustedKeys, getCompatibilityContext: () => ({ ...runtime(), localDataSchemaVersion: schema }) });
  await installer.installVerifiedPackage(await artifact(root));
  await installer.installVerifiedPackage(await artifact(root, "1.1.0"));
  await assert.rejects(installer.rollback(applicationId), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  assert.equal((await installer.resolveCurrent(applicationId)).version, "1.1.0");
  schema = "2.0.0";
  await assert.rejects(installer.rollback(applicationId), { code: "APPLICATION_DATA_SCHEMA_INCOMPATIBLE" });
  schema = "1.0.0";
  assert.equal((await installer.rollback(applicationId)).version, "1.0.0");
});

test("market requests a compatible historical candidate and independently verifies it", async t => {
  const root = await temporary(t), current = await artifact(root, "2.0.0", { ...compatibility, backendContracts: [{ id: "wanx-bridge.readiness", range: ">=2.0.0 <3.0.0", features: [] }] });
  const history = await artifact(root, "1.5.0"), requests = [];
  const market = createApplicationMarket({ wanxVersion: "0.2.0", platform: "darwin", arch: "arm64", trustedKeys, getCompatibilityContext: runtime,
    applications: { listInstalled: async () => [] }, request: async input => { requests.push(input); return input.body.backendReadiness ? { ...candidate(history), selection: "compatible_history" } : candidate(current); } });
  const selected = await market.candidate(applicationId);
  assert.equal(selected.selection, "compatible_history");
  assert.equal(selected.artifact.artifactId, history.descriptor.artifactId);
  assert.deepEqual(requests[0].body.supportedDescriptorSchemas, [1, 2, 3]);
  assert.equal(requests[1].body.backendReadiness.deviceId, "box-a");
  await market.close();
});

test("market can offer client-compatible packages without connecting a box", async t => {
  const value = await artifact(await temporary(t));
  const market = createApplicationMarket({ wanxVersion: "0.2.0", platform: "darwin", arch: "arm64", trustedKeys,
    applications: { listInstalled: async () => [] }, request: async () => candidate(value) });
  assert.equal((await market.candidate(applicationId)).compatibility.status, "client_compatible");
  await market.close();
});

test("client maintenance takes an exclusive application mutation lock", async t => {
  const manager = await createApplicationManager({ applicationRoot: await temporary(t) });
  const release = manager.beginMaintenance();
  assert.equal(manager.isBusy(), true);
  assert.throws(() => manager.beginMaintenance(), { code: "UPDATE_IN_PROGRESS" });
  await assert.rejects(manager.install({}), { code: "UPDATE_IN_PROGRESS" });
  await assert.rejects(manager.selectCurrent(applicationId, "1.0.0"), { code: "UPDATE_IN_PROGRESS" });
  await assert.rejects(manager.launch(applicationId), { code: "UPDATE_IN_PROGRESS" });
  release(); release(); assert.equal(manager.isBusy(), false);
  await manager.close();
});
