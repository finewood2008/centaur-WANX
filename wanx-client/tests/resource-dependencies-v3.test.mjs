import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZipFile } from "yazl";
import { createApplicationBackend } from "../applications/backend.mjs";
import { validateCompatibility, evaluateApplicationCompatibility } from "../applications/compatibility.mjs";
import { validateDescriptor, verifyEnvelope } from "../applications/descriptor.mjs";
import { createApplicationInstaller } from "../applications/installer.mjs";
import { createApplicationManager } from "../applications/manager.mjs";
import { createApplicationSession } from "../app-host/session.mjs";
import sdk from "../host-sdk/index.cjs";

export const compatibility = {
  backendProductId: "wanx", clientRange: ">=0.1.0 <1.0.0", hostProtocolRange: ">=1.0.0 <2.0.0",
  backendContracts: [{ id: "wanx-bridge.readiness", range: ">=1.0.0 <2.0.0", features: ["read-only"] }],
  resourceDependencies: [{ kind: "expert", resourceId: "zhijun-personal-companion", minVersion: "1.0.0" },
    { kind: "skill-package", resourceId: "research", minVersion: "1.2.0" }],
  localDataSchema: { readRange: ">=1.0.0 <2.0.0", writeVersion: "1.0.0" },
};
const applicationId = "test.resource-app";
const manifest = { applicationId, name: "资源应用", version: "1.0.0", protocolVersion: 3, runtime: "electron", launchMode: "shared", entrypoint: "main.mjs", capabilities: ["identity.read", "experts.read"], compatibility };
const keys = generateKeyPairSync("ed25519"), trustedKeys = { test: keys.publicKey.export({ type: "spki", format: "pem" }) };
const envelopeFor = value => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { keyId: "test", descriptorBase64: bytes.toString("base64"), signatureBase64: sign(null, bytes, keys.privateKey).toString("base64") };
};
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-resources-v3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function artifact(root, packaged = manifest) {
  const zip = new ZipFile(), chunks = [];
  zip.addBuffer(Buffer.from(JSON.stringify(packaged)), "wanx-app.json");
  zip.addBuffer(Buffer.from("export default {};\n"), "main.mjs");
  const done = new Promise((resolve, reject) => { zip.outputStream.on("data", chunk => chunks.push(chunk)); zip.outputStream.on("error", reject); zip.outputStream.on("end", resolve); });
  zip.end(); await done;
  const bytes = Buffer.concat(chunks), artifactId = randomUUID();
  const descriptor = { schemaVersion: 3, artifactId, applicationId: packaged.applicationId, version: "1.0.0", os: "universal", arch: "universal", packageType: "wanxapp", fileName: "resources.wanxapp", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, minWanxVersion: "0.1.0", hostProtocol: 1, compatibility, manifest: { ...manifest, applicationId: packaged.applicationId } };
  const archivePath = path.join(root, `${artifactId}.wanxapp`); await writeFile(archivePath, bytes);
  return { descriptor, envelope: envelopeFor(descriptor), archivePath };
}
const resources = () => [{ kind: "expert", resourceId: "zhijun-personal-companion", version: "4.0.0", status: "ready" }, { kind: "skill-package", resourceId: "research", version: "2.0.0", status: "ready" }];
const bindings = () => [{ kind: "expert", resourceId: "zhijun-personal-companion", version: "4.0.0", instanceId: "actual-expert-42" }, { kind: "skill-package", resourceId: "research", version: "2.0.0", packageId: "actual-skill-23" }];
const backend = () => ({ schemaVersion: 1, productId: "wanx", deviceId: "box-a", observedAt: new Date().toISOString(), authorization: { status: "ready" }, contracts: [{ id: "wanx-bridge.readiness", version: "1.0.0", features: ["read-only"] }], resources: resources(), bindings: bindings() });
function harness(value, options = {}) {
  const state = { accountId: "user-a", clientId: "client-a", boxId: "box-a", connection: "ready", phase: "ready" }, seen = [], connections = [];
  const account = { getIdentity: () => ({ accountId: state.accountId, clientId: state.clientId }) };
  const client = {
    snapshot: () => ({ phase: state.phase, connection: state.phase === "ready" ? { deviceId: state.boxId } : null }),
    async applicationConnection(id, connectionOptions) {
      assert.equal(id, value.descriptor.applicationId);
      connections.push({ applicationId: id, options: connectionOptions });
      const captured = JSON.stringify(state);
      return {
        context() { if (JSON.stringify(state) !== captured) throw Object.assign(new Error("NETWORK_CHANGED"), { code: "NETWORK_CHANGED" }); return { ...state }; },
        async request(input) {
          const body = JSON.parse(input.body.toString()); seen.push({ path: input.path, body });
          await options.beforeResponse?.(input, state);
          const result = input.path.endsWith("prepare")
            ? { ...backend(), backendProductId: "wanx", status: "ready", applicationId: id, artifactId: value.descriptor.artifactId }
            : backend();
          options.edit?.(result, input);
          return { status: options.status || 200, body: Buffer.from(JSON.stringify(result)) };
        },
      };
    },
  };
  return { state, seen, connections, account, client, provider: createApplicationBackend({ client, account, clientVersion: "0.2.0" }) };
}

test("v3 has exact mandatory resource IDs, stable minimum versions and no upper bound", () => {
  assert.deepEqual(validateCompatibility(compatibility, 3), compatibility);
  const accepted = { ...compatibility, resourceDependencies: [{ kind: "expert", resourceId: "1", minVersion: "2147483647.0.0" }] };
  assert.equal(validateCompatibility(accepted, 3).resourceDependencies[0].resourceId, "1");
  for (const dep of [
    { ...compatibility.resourceDependencies[0], required: false },
    { ...compatibility.resourceDependencies[0], versionRange: ">=1.0.0 <2.0.0" },
    { kind: "expert", name: "知君", minVersion: "1.0.0" },
    { kind: "expert", resourceId: 1, minVersion: "1.0.0" },
    ...["1.0", "^1.0.0", "1.0.0-test", "1.0.0+build", "2147483648.0.0"].map(minVersion => ({ ...compatibility.resourceDependencies[0], minVersion })),
  ]) assert.throws(() => validateCompatibility({ ...compatibility, resourceDependencies: [dep] }, 3), { code: "APPLICATION_CONTRACT_UNSUPPORTED" });
  assert.throws(() => validateCompatibility({ ...compatibility, resourceDependencies: [compatibility.resourceDependencies[0], compatibility.resourceDependencies[0]] }, 3));
  assert.throws(() => validateCompatibility({ ...compatibility, requiredExperts: [] }, 3));
  assert.throws(() => validateCompatibility(compatibility, 2));
  assert.equal(validateCompatibility({ ...compatibility, resourceDependencies: [] }, 3).resourceDependencies.length, 0);
  assert.equal(evaluateApplicationCompatibility(manifest, { clientVersion: "0.2.0", hostProtocol: 1, backend: backend() }).status, "ready");
});

test("v3 signatures bind the exact resource declaration and schema", async t => {
  const value = await artifact(await temporary(t));
  assert.equal(verifyEnvelope(value.envelope, trustedKeys).schemaVersion, 3);
  for (const edit of [
    { ...value.descriptor, schemaVersion: 2 },
    { ...value.descriptor, compatibility: { ...compatibility, resourceDependencies: [] } },
    { ...value.descriptor, compatibility: { ...compatibility, resourceDependencies: [{ ...compatibility.resourceDependencies[0], minVersion: "1.0.0-test" }] } },
  ]) assert.throws(() => verifyEnvelope(envelopeFor(edit), trustedKeys), { code: "MARKET_INVALID_DESCRIPTOR" });
  const tampered = { ...value.envelope, descriptorBase64: Buffer.from(JSON.stringify({ ...value.descriptor, compatibility: { ...compatibility, resourceDependencies: [] } })).toString("base64") };
  assert.throws(() => verifyEnvelope(tampered, trustedKeys), { code: "MARKET_INVALID_SIGNATURE" });
});

test("missing downloaded resources are installable candidates, but download/name alone cannot authorize launch", () => {
  const runtime = { clientVersion: "0.2.0", hostProtocol: 1, backendRequired: true, backend: { ...backend(), resources: [], bindings: [] } };
  assert.equal(evaluateApplicationCompatibility(manifest, runtime, { phase: "candidate" }).status, "ready");
  assert.equal(evaluateApplicationCompatibility(manifest, runtime).checks[0].code, "APPLICATION_RESOURCES_NOT_READY");
  for (const wrong of [[], [{ name: "知君", version: "4.0.0", instanceId: "actual-expert-42" }], [...bindings(), bindings()[0]]]) {
    const failed = evaluateApplicationCompatibility(manifest, { ...runtime, backend: { ...backend(), bindings: wrong } });
    assert.equal(failed.status, "blocked");
  }
});

test("offline signed frontend installs pending; launch cannot skip preparation", async t => {
  const root = await temporary(t), value = await artifact(root), h = harness(value); h.state.phase = "disconnected";
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "apps"), trustedKeys, ...h.provider });
  t.after(() => manager.close());
  const installed = await manager.installVerifiedPackage(value);
  assert.equal(installed.resourcePreparation.status, "pending");
  assert.equal((await manager.listInstalled())[0].resourcePreparation.status, "pending");
  assert.equal(h.seen.length, 0);
  await assert.rejects(manager.launch(applicationId), { code: "NETWORK_NOT_READY" });
  assert.equal(h.seen.length, 0);
});

test("package bytes and manifest are verified before preparation mutates the box", async t => {
  const root = await temporary(t), value = await artifact(root), h = harness(value);
  const installer = createApplicationInstaller({ rootDir: path.join(root, "apps"), trustedKeys, ...h.provider });
  await writeFile(value.archivePath, Buffer.concat([await readFile(value.archivePath), Buffer.from("tampered")]));
  await assert.rejects(installer.installVerifiedPackage(value), { code: "MARKET_PACKAGE_HASH_MISMATCH" });
  assert.equal(h.seen.length, 0); assert.deepEqual(await installer.list(), []);
  const mismatch = await artifact(root, { ...manifest, compatibility: { ...compatibility, resourceDependencies: [] } });
  await assert.rejects(installer.installVerifiedPackage(mismatch), { code: "MARKET_PACKAGE_INVALID" });
  assert.equal(h.seen.length, 0);
});

test("prepare transmits only artifact identity; repeated calls use the authoritative same bindings", async t => {
  const value = await artifact(await temporary(t)), h = harness(value);
  const input = { manifest, descriptor: value.descriptor, phase: "launch" };
  const a = await h.provider.getCompatibilityContext(input), b = await h.provider.getCompatibilityContext(input);
  assert.deepEqual(a.applicationConnection.context().resourceBindings, bindings());
  assert.deepEqual(b.applicationConnection.context().resourceBindings, bindings());
  assert.deepEqual(h.seen[0], { path: "/api/platform/applications/prepare", body: { schemaVersion: 1, applicationId, artifactId: value.descriptor.artifactId } });
  assert.equal(h.seen[1].body.artifactId, value.descriptor.artifactId);
});

test("a signed v3 application uses its declared backend product even when its historical ID used another scope", async t => {
  const currentManifest = { ...manifest, applicationId: "centaurai.wanx.superadvisors" };
  const value = await artifact(await temporary(t), currentManifest), h = harness(value);
  const verified = verifyEnvelope(value.envelope, trustedKeys);
  await h.provider.getCompatibilityContext({ manifest: verified.manifest, descriptor: verified, phase: "launch" });
  assert.deepEqual(h.connections, [{ applicationId: currentManifest.applicationId, options: { backendProductId: "wanx" } }]);
});

test("client consumes an actual Python ResourceRuntime and Octop API preparation response", async t => {
  const actual = JSON.parse(await readFile(new URL("../../wanx-bridge/tests/fixtures/resources-prepare-v1.json", import.meta.url), "utf8"));
  // Preserve the exact producer payload, including timestamp type and field
  // spelling. The test clock models receiving it immediately after preparation.
  t.mock.method(Date, "now", () => Date.parse(actual.observedAt) + 100);
  const currentManifest = { ...manifest, applicationId: actual.applicationId, compatibility: {
    ...compatibility, backendProductId: actual.backendProductId,
    resourceDependencies: actual.resources.map(({ kind, resourceId, version }) => ({ kind, resourceId, minVersion: version })),
  } };
  const context = { accountId: "fixture-account", clientId: "fixture-client", boxId: actual.deviceId, connection: "ready" };
  const provider = createApplicationBackend({ clientVersion: "0.2.0", account: { getIdentity: () => ({ accountId: context.accountId }) }, client: {
    snapshot: () => ({ phase: "ready", connection: { deviceId: actual.deviceId } }),
    applicationConnection: async () => ({ context: () => context, request: async input => ({ status: 200,
      body: Buffer.from(JSON.stringify(input.path.endsWith("prepare") ? actual : {
        ...actual, productId: actual.backendProductId,
        contracts: [{ id: "wanx-bridge.readiness", version: "1.0.0", features: ["read-only"] }],
      })),
    }) }),
  } });
  const result = await provider.getCompatibilityContext({ manifest: currentManifest,
    descriptor: { schemaVersion: 3, artifactId: actual.artifactId }, phase: "launch" });
  assert.equal(evaluateApplicationCompatibility(currentManifest, result).status, "ready");
  assert.deepEqual(result.applicationConnection.context().resourceBindings, actual.bindings);
});

test("blocked entitlement, another artifact, stale evidence and unbound resources fail closed", async t => {
  const value = await artifact(await temporary(t));
  for (const edit of [
    result => { result.authorization = { status: "blocked" }; result.status = "blocked"; result.code = "APP_ENTITLEMENT_REQUIRED"; },
    result => { result.artifactId = randomUUID(); },
    result => { result.deviceId = "box-b"; },
    result => { result.backendProductId = "another-product"; },
    result => { result.observedAt = new Date(Date.now() - 300001).toISOString(); },
    result => { result.bindings = []; },
  ]) {
    const h = harness(value, { edit });
    await assert.rejects(h.provider.getCompatibilityContext({ manifest, descriptor: value.descriptor, phase: "launch" }));
  }
  const denied = harness(value, { edit(result) { result.status = "blocked"; result.authorization = { status: "blocked", code: "APP_ENTITLEMENT_REQUIRED" }; } });
  await assert.rejects(denied.provider.getCompatibilityContext({ manifest, descriptor: value.descriptor, phase: "launch" }), { code: "APP_ENTITLEMENT_REQUIRED" });
  assert.equal(denied.seen.length, 1);
  const h = harness(value, { edit(result, input) { if (input.path.endsWith("readiness")) result.authorization = { status: "blocked", code: "APP_ENTITLEMENT_REQUIRED" }; } });
  assert.equal(evaluateApplicationCompatibility(manifest, await h.provider.getCompatibilityContext({ manifest, descriptor: value.descriptor, phase: "launch" })).checks[0].code, "APP_ENTITLEMENT_REQUIRED");
  const drifted = harness(value, { edit(result, input) { if (input.path.endsWith("readiness")) result.bindings = []; } });
  assert.equal(evaluateApplicationCompatibility(manifest, await drifted.provider.getCompatibilityContext({ manifest, descriptor: value.descriptor, phase: "launch" })).checks[0].code, "APPLICATION_RESOURCES_NOT_READY");
});

test("account or box changes while prepare is pending cannot publish the frontend or hand out bindings", async t => {
  for (const field of ["accountId", "boxId", "clientId"]) {
    const root = await temporary(t), value = await artifact(root), h = harness(value, { beforeResponse(input, state) { if (input.path.endsWith("prepare")) state[field] += "-changed"; } });
    const installer = createApplicationInstaller({ rootDir: path.join(root, "apps"), trustedKeys, ...h.provider });
    await assert.rejects(installer.installVerifiedPackage(value), { code: "NETWORK_CHANGED" });
    assert.deepEqual(await installer.list(), []);
    assert.equal(h.seen.length, 1);
  }
});

test("Host SDK requests resolve the exact prepared expert ID without name lookup or instance creation", async t => {
  const requests = [], bindingContext = { connection: "ready", accountId: "user-a", clientId: "client-a", boxId: "box-a", resourceBindings: bindings() };
  const host = await createApplicationSession({ hostApplicationId: "wanx", applicationId, installPath: "/unused", createConnection: async () => ({ context: () => bindingContext,
    request: async input => { requests.push(input.path); return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{\"ok\":true}") }; },
  }) });
  const client = sdk.fromEnvironment(host.environment); t.after(() => { client.close(); return host.close(); });
  assert.equal((await client.resolveResourceBinding("expert", "zhijun-personal-companion")).instanceId, "actual-expert-42");
  assert.deepEqual(await (await client.requestExpert("zhijun-personal-companion", "/threads")).json(), { ok: true });
  assert.deepEqual(requests, ["/api/agents/actual-expert-42/threads"]);
  await assert.rejects(client.resolveResourceBinding("expert", "unrelated"), { code: "APPLICATION_RESOURCE_NOT_BOUND" });
  await assert.rejects(client.requestExpert("zhijun-personal-companion", "/%2e%2e/other"), { code: "APPLICATION_PATH_NOT_ALLOWED" });
});

test("manager launches with the very connection that produced the prepared bindings", async t => {
  const root = await temporary(t), value = await artifact(root), h = harness(value); let observed;
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "apps"), trustedKeys, ...h.provider,
    createConnection: () => { throw new Error("must not recapture a different connection"); },
    spawn(_file, _args, options) {
      const child = Object.assign(new EventEmitter(), { pid: 1, kill() { child.emit("exit"); }, send() {} });
      queueMicrotask(async () => {
        const client = sdk.fromEnvironment(options.env);
        try { observed = await client.context(); child.emit("message", { type: "wanx:application-ready", launchId: options.env.WANX_HOST_LAUNCH_ID }); }
        finally { client.close(); }
      });
      return child;
    },
  });
  t.after(() => manager.close());
  assert.equal((await manager.installVerifiedPackage(value)).resourcePreparation.status, "ready");
  assert.equal((await manager.launch(applicationId)).state, "running");
  assert.deepEqual(observed.resourceBindings, bindings());
  assert.equal(observed.artifactId, value.descriptor.artifactId);
  h.state.boxId = "box-b";
  await assert.rejects(manager.launch(applicationId));
});


test("launch rejects incompatible preserved profile before preparing any remote resources", async t => {
  const root = await temporary(t), value = await artifact(root), h = harness(value);
  h.state.phase = "disconnected";
  const applicationRoot = path.join(root, "apps");
  const manager = await createApplicationManager({ applicationRoot, trustedKeys, ...h.provider });
  t.after(() => manager.close());
  await manager.installVerifiedPackage(value);
  const profile = path.join(applicationRoot, ".runtime", applicationId);
  await mkdir(profile, { recursive: true }); await writeFile(path.join(profile, "Preferences"), "existing-data");
  h.state.phase = "ready";
  await assert.rejects(manager.launch(applicationId), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  assert.equal(h.seen.length, 0);
});
