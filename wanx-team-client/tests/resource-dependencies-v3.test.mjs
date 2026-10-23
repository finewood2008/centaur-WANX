import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZipFile } from "yazl";
import { createApplicationBackend } from "../applications/backend.mjs";
import { validateCompatibility, evaluateApplicationCompatibility } from "../applications/compatibility.mjs";
import { validateDescriptor, verifyEnvelope } from "../applications/descriptor.mjs";
import { createApplicationInstaller } from "../applications/installer.mjs";
import { createApplicationManager } from "../applications/manager.mjs";
import { createApplicationMarket } from "../applications/market.mjs";
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
  const descriptor = { schemaVersion: 3, artifactId, applicationId: packaged.applicationId, version: packaged.version, os: "universal", arch: "universal", packageType: "wanxapp", fileName: "resources.wanxapp", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, minWanxVersion: "0.1.0", hostProtocol: 1, compatibility, manifest: { ...manifest, applicationId: packaged.applicationId, version: packaged.version,
    ...(packaged.releaseAccess ? { releaseAccess: packaged.releaseAccess } : {}) } };
  const archivePath = path.join(root, `${artifactId}.wanxapp`); await writeFile(archivePath, bytes);
  return { descriptor, envelope: envelopeFor(descriptor), archivePath };
}
const resources = () => [{ kind: "expert", resourceId: "zhijun-personal-companion", version: "4.0.0", status: "ready" }, { kind: "skill-package", resourceId: "research", version: "2.0.0", status: "ready" }];
const bindings = () => [{ kind: "expert", resourceId: "zhijun-personal-companion", version: "4.0.0", instanceId: "actual-expert-42" }, { kind: "skill-package", resourceId: "research", version: "2.0.0", packageId: "actual-skill-23" }];
const backend = () => ({ schemaVersion: 1, productId: "wanx", deviceId: "box-a", observedAt: new Date().toISOString(), authorization: { status: "ready" }, contracts: [{ id: "wanx-bridge.readiness", version: "1.0.0", features: ["read-only"] }], resources: resources(), bindings: bindings() });
function harness(value, options = {}) {
  const state = { accountId: "user-a", clientId: "client-a", boxId: "box-a", connection: "ready", phase: "ready" }, seen = [], connections = [], candidateSets = new Map();
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
          if (body.schemaVersion === 2) {
            const scope = { accountId: state.accountId, deviceId: state.boxId, ownershipEpoch: 1, artifactId: body.artifactId };
            const bindingSetId = input.path.endsWith("prepare")
              ? createHash("sha256").update(JSON.stringify([scope, body.operationId])).digest("hex") : body.bindingSetId;
            if (input.path.endsWith("prepare")) candidateSets.set(bindingSetId, body.operationId);
            Object.assign(result, { schemaVersion: 2, status: "ready", checks: [], applicationId: id, artifactId: body.artifactId, deviceId: state.boxId,
              bindingSetId, operationId: candidateSets.get(bindingSetId) || options.operationId || "test-operation", bindingScope: scope });
          }
          options.edit?.(result, input);
          return { status: options.status || 200, body: Buffer.from(options.body ?? JSON.stringify(result)) };
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

test("missing box preparation route or service is not reported as missing experts", async t => {
  const value = await artifact(await temporary(t));
  for (const [status, code] of [[404, "BACKEND_CONTRACT_INCOMPATIBLE"], [503, "APPLICATION_PREPARATION_UNAVAILABLE"]]) {
    const h = harness(value, { status });
    await assert.rejects(h.provider.prepareApplication({ manifest, descriptor: value.descriptor, operationId: "test-operation" }), { code });
    const nonJson = harness(value, { status, body: "Not Found" });
    await assert.rejects(nonJson.provider.prepareApplication({ manifest, descriptor: value.descriptor, operationId: "test-operation" }), { code });
  }
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

test("offline signed frontend stays staged; launch cannot skip preparation", async t => {
  const root = await temporary(t), value = await artifact(root), h = harness(value); h.state.phase = "disconnected";
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "apps"), trustedKeys, ...h.provider });
  t.after(() => manager.close());
  const installed = await manager.installVerifiedPackage(value);
  assert.equal(installed.resourcePreparation.status, "pending");
  assert.equal(installed.installationState, "pending");
  assert.equal((await manager.listInstalled())[0].resourcePreparation.status, "pending");
  assert.equal(h.seen.length, 0);
  await assert.rejects(manager.launch(applicationId), { code: "APPLICATION_RESOURCES_PENDING" });
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

test("candidate prepare preserves Bridge blocked codes before a binding set exists", async t => {
  const value = await artifact(await temporary(t));
  for (const [code, authorization] of [
    ["APP_ENTITLEMENT_REQUIRED", { status: "blocked", code: "APP_ENTITLEMENT_REQUIRED" }],
    ["RESOURCE_PRODUCT_PROFILE_UNSUPPORTED", { status: "ready" }],
  ]) {
    const h = harness(value, { edit(result, input) {
      if (!input.path.endsWith("prepare")) return;
      result.status = "blocked";
      result.authorization = authorization;
      result.code = code;
      delete result.bindingSetId;
      delete result.operationId;
      delete result.bindingScope;
    } });
    const prepared = await h.provider.prepareApplication({ manifest, descriptor: value.descriptor, operationId: "test-operation" });
    assert.equal(prepared.status, "blocked");
    assert.equal(prepared.code, code);
    assert.deepEqual(h.seen.map(item => item.path), ["/api/platform/applications/candidates/prepare"]);
  }
});

test("account or box changes while prepare is pending cannot publish the frontend or hand out bindings", async t => {
  for (const field of ["accountId", "boxId", "clientId"]) {
    const root = await temporary(t), value = await artifact(root), h = harness(value, { beforeResponse(input, state) { if (input.path.endsWith("prepare")) state[field] += "-changed"; } });
    const installer = createApplicationInstaller({ rootDir: path.join(root, "apps"), trustedKeys, ...h.provider });
    await assert.rejects(installer.installVerifiedPackage(value), { code: "NETWORK_CHANGED" });
    assert.equal((await installer.list())[0].installationState, "pending");
    await assert.rejects(installer.resolveCurrent(applicationId), { code: "APPLICATION_RESOURCES_PENDING" });
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
  const root = await temporary(t), value = await artifact(root), h = harness(value); let observed, spawned = 0, stopped = 0;
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "apps"), trustedKeys, ...h.provider,
    createConnection: () => { throw new Error("must not recapture a different connection"); },
    spawn(_file, _args, options) {
      spawned++;
      const child = Object.assign(new EventEmitter(), { pid: spawned, kill() { stopped++; child.emit("exit"); }, send() {} });
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
  await manager.launch(applicationId);
  assert.equal(spawned, 1, "same binding reuses the live child");
  h.state.boxId = "box-b";
  assert.equal((await manager.launch(applicationId)).state, "running");
  assert.equal((await manager.listInstalled())[0].bindingScope.deviceId, "box-b");
  assert.equal(spawned, 2); assert.equal(stopped, 1);
  assert.equal(observed.boxId, "box-b", "new binding receives a newly scoped Host session");
});


test("launch rejects incompatible preserved profile before preparing any remote resources", async t => {
  const root = await temporary(t), value = await artifact(root), h = harness(value);
  const applicationRoot = path.join(root, "apps");
  const manager = await createApplicationManager({ applicationRoot, trustedKeys, ...h.provider });
  t.after(() => manager.close());
  await manager.installVerifiedPackage(value);
  h.seen.length = 0;
  const profile = path.join(applicationRoot, ".runtime", applicationId);
  await mkdir(profile, { recursive: true }); await writeFile(path.join(profile, "Preferences"), "existing-data");
  await assert.rejects(manager.launch(applicationId), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  assert.equal(h.seen.length, 0);
});

for (const status of ["blocked", "pending"]) {
  test(`${status} update preserves the old pointer, package and data through restart`, async t => {
    const root = await temporary(t), rootDir = path.join(root, "apps");
    const first = await artifact(root), next = await artifact(root, { ...manifest, version: "1.1.0" });
    const initial = createApplicationInstaller({ rootDir, trustedKeys, ...harness(first).provider });
    const installed = await initial.installVerifiedPackage(first);
    const pointer = path.join(rootDir, applicationId, ".current-version.json");
    const before = await readFile(pointer, "utf8");
    const history = path.join(root, "customer-history.json");
    await writeFile(history, JSON.stringify({ conversations: ["customer data"] }));
    let preparation = { status, code: status === "blocked" ? "RESOURCE_MIGRATION_REQUIRED" : "APPLICATION_RESOURCES_PENDING" };
    const update = createApplicationInstaller({ rootDir, trustedKeys, ...harness(next).provider,
      prepareApplication: async () => preparation });
    const result = await update.installVerifiedPackage(next);
    assert.equal(result.artifactId, first.descriptor.artifactId);
    assert.equal(result.pendingInstallation.artifactId, next.descriptor.artifactId);
    assert.equal(result.pendingInstallation.resourcePreparation.status, status);
    assert.equal(await readFile(pointer, "utf8"), before);
    assert.equal(await readFile(path.join(installed.installPath, "main.mjs"), "utf8"), "export default {};\n");
    assert.deepEqual(JSON.parse(await readFile(history, "utf8")), { conversations: ["customer data"] });

    const restarted = createApplicationInstaller({ rootDir, trustedKeys, ...harness(next).provider });
    await restarted.recover();
    await restarted.prune(applicationId, "1.0.0");
    assert.equal((await restarted.resolveCurrent(applicationId)).artifactId, first.descriptor.artifactId);
    assert.equal((await restarted.list())[0].pendingInstallation.artifactId, next.descriptor.artifactId);
    const finished = await restarted.installVerifiedPackage(next);
    assert.equal(finished.artifactId, next.descriptor.artifactId);
    assert.equal(finished.resourcePreparation.status, "ready");
    assert.equal(finished.previous.artifactId, first.descriptor.artifactId);
    assert.equal((await restarted.list())[0].pendingInstallation, undefined);
  });
}

test("offline first install and repeated retries retain one candidate and never invent an active version", async t => {
  const root = await temporary(t), rootDir = path.join(root, "apps"), value = await artifact(root), h = harness(value);
  h.state.phase = "disconnected";
  const installer = createApplicationInstaller({ rootDir, trustedKeys, ...h.provider });
  await installer.installVerifiedPackage(value);
  await installer.installVerifiedPackage(value);
  await installer.recover();
  assert.equal(h.seen.length, 0);
  await assert.rejects(installer.resolveCurrent(applicationId), { code: "APPLICATION_RESOURCES_PENDING" });
  const entries = await readdir(path.join(rootDir, applicationId));
  assert.deepEqual(entries.filter(name => !name.startsWith(".")), [value.descriptor.artifactId]);
  assert.equal(entries.includes(".current-version.json"), false);
  const pending = (await installer.list())[0];
  assert.equal(pending.installationState, "pending");

  h.state.phase = "ready";
  const result = await installer.installVerifiedPackage(value);
  assert.equal(result.artifactId, value.descriptor.artifactId);
  assert.equal(result.installationState, undefined);
  assert.equal(h.seen.length, 2);
  assert.equal((await installer.resolveCurrent(applicationId)).artifactId, value.descriptor.artifactId);
});

test("preparation exception retains the usable old version and a retryable candidate", async t => {
  const root = await temporary(t), rootDir = path.join(root, "apps");
  const first = await artifact(root), next = await artifact(root, { ...manifest, version: "1.1.0" });
  await createApplicationInstaller({ rootDir, trustedKeys, ...harness(first).provider }).installVerifiedPackage(first);
  const h = harness(next, { status: 503 });
  const installer = createApplicationInstaller({ rootDir, trustedKeys, ...h.provider });
  await assert.rejects(installer.installVerifiedPackage(next), { code: "APPLICATION_PREPARATION_UNAVAILABLE" });
  assert.equal((await installer.resolveCurrent(applicationId)).artifactId, first.descriptor.artifactId);
  await installer.recover();
  assert.equal((await installer.list())[0].pendingInstallation.resourcePreparation.code, "APPLICATION_PREPARATION_UNAVAILABLE");
});

test("retries reverify the staged package before preparing resources", async t => {
  const root = await temporary(t), rootDir = path.join(root, "apps"), value = await artifact(root), h = harness(value);
  h.state.phase = "disconnected";
  const installer = createApplicationInstaller({ rootDir, trustedKeys, ...h.provider });
  const pending = await installer.installVerifiedPackage(value);
  await writeFile(path.join(pending.installPath, "main.mjs"), "tampered");
  h.state.phase = "ready";
  await assert.rejects(installer.installVerifiedPackage(value), { code: "MARKET_PACKAGE_INVALID" });
  assert.equal(h.seen.length, 0);
  await assert.rejects(installer.resolveCurrent(applicationId), { code: "APPLICATION_RESOURCES_PENDING" });
});

for (const field of ["accountId", "boxId", "clientId"]) {
  test(`changing ${field} after preparation and before pointer commit cannot activate the candidate`, async t => {
    const root = await temporary(t), rootDir = path.join(root, "apps");
    const first = await artifact(root), next = await artifact(root, { ...manifest, version: "1.1.0", releaseAccess: "account" });
    await createApplicationInstaller({ rootDir, trustedKeys, ...harness(first).provider }).installVerifiedPackage(first);
    const h = harness(next); let permits = 0;
    const installer = createApplicationInstaller({ rootDir, trustedKeys, ...h.provider,
      authorizeRelease: async () => {
        if (++permits === 2) h.state[field] += "-changed";
        return { assertLive() {}, assertSession() {} };
      },
    });
    await assert.rejects(installer.installVerifiedPackage(next), { code: "NETWORK_CHANGED" });
    assert.equal((await installer.resolveCurrent(applicationId)).artifactId, first.descriptor.artifactId);
    assert.equal((await installer.list())[0].pendingInstallation.artifactId, next.descriptor.artifactId);
    assert.equal(permits, 2);
  });
}

test("retry uses the newly selected account and box instead of old pending readiness", async t => {
  const root = await temporary(t), rootDir = path.join(root, "apps"), value = await artifact(root), h = harness(value);
  h.state.phase = "disconnected";
  const installer = createApplicationInstaller({ rootDir, trustedKeys, ...h.provider });
  await installer.installVerifiedPackage(value);
  h.state.phase = "ready";
  h.state.accountId = "user-b";
  const denied = harness(value, { edit(result) {
    result.status = "blocked"; result.authorization = { status: "blocked", code: "APP_ENTITLEMENT_REQUIRED" };
  } });
  denied.state.accountId = "user-b";
  const retry = createApplicationInstaller({ rootDir, trustedKeys, ...denied.provider });
  const result = await retry.installVerifiedPackage(value);
  assert.equal(result.installationState, "pending");
  assert.equal(result.resourcePreparation.code, "APP_ENTITLEMENT_REQUIRED");
  assert.equal(denied.seen.length, 1);
  await assert.rejects(retry.resolveCurrent(applicationId), { code: "APPLICATION_RESOURCES_PENDING" });
});

test("market does not advertise a pending package as current and can retry that same artifact", async t => {
  const root = await temporary(t), value = await artifact(root), h = harness(value), queries = [];
  h.state.phase = "disconnected";
  const installer = createApplicationInstaller({ rootDir: path.join(root, "apps"), trustedKeys, ...h.provider });
  const market = createApplicationMarket({ wanxVersion: "0.2.0", platform: "darwin", arch: "arm64", trustedKeys,
    applications: { ...installer, listInstalled: installer.list }, ...h.provider,
    request: async input => {
      if (input.path.endsWith("/candidate")) {
        queries.push(input.body);
        return { status: "available", release: { version: value.descriptor.version }, artifact: {
          ...value.descriptor, status: "ready", envelope: value.envelope,
        } };
      }
      return { artifactId: value.descriptor.artifactId, url: "https://example.test/application",
        expiresAt: new Date(Date.now() + 300000).toISOString() };
    },
    fetch: async () => new Response(await readFile(value.archivePath)),
  });
  t.after(() => market.close());
  assert.equal((await market.candidate(applicationId)).status, "available");
  assert.equal((await market.install(applicationId)).installationState, "pending");
  assert.equal((await market.candidate(applicationId)).status, "available");
  assert.equal(queries.every(query => !Object.hasOwn(query, "currentVersion")), true);
  h.state.phase = "ready";
  const ready = await market.install(applicationId);
  assert.equal(ready.resourcePreparation.status, "ready");
  assert.equal(ready.artifactId, value.descriptor.artifactId);
  assert.equal((await market.candidate(applicationId)).status, "up_to_date");
  assert.equal(queries.at(-1).currentVersion, "1.0.0");
});


test("candidate installation stores its binding with the artifact and retries one operation after restart", async t => {
  const root = await temporary(t), rootDir = path.join(root, "apps"), value = await artifact(root);
  let available = false;
  const h = harness(value, { edit(result) { if (!available) { result.status = "blocked"; result.code = "RESOURCE_MIGRATION_REQUIRED"; } } });
  const initial = createApplicationInstaller({ rootDir, trustedKeys, ...h.provider });
  const pending = await initial.installVerifiedPackage(value);
  const firstRequest = h.seen[0];
  assert.equal(firstRequest.path, "/api/platform/applications/candidates/prepare");
  assert.deepEqual(firstRequest.body, { schemaVersion: 2, applicationId, artifactId: value.descriptor.artifactId, operationId: pending.operationId });
  const restarted = createApplicationInstaller({ rootDir, trustedKeys, ...h.provider });
  await restarted.recover(); available = true;
  const ready = await restarted.installVerifiedPackage(value);
  assert.equal(ready.operationId, pending.operationId);
  assert.equal(h.seen[1].body.operationId, pending.operationId);
  const selection = JSON.parse(await readFile(path.join(rootDir, applicationId, ".current-version.json")));
  assert.equal(selection.key, value.descriptor.artifactId);
  assert.equal(selection.bindingSetId, ready.bindingSetId);
  assert.deepEqual(selection.bindingScope, { accountId: "user-a", deviceId: "box-a", ownershipEpoch: 1, artifactId: value.descriptor.artifactId });
  const beforeLaunch = h.seen.length;
  const context = await h.provider.getCompatibilityContext({ manifest: ready, descriptor: ready.descriptor, phase: "launch" });
  assert.equal(h.seen.length, beforeLaunch + 1, "candidate launch never mutates legacy bindings");
  assert.deepEqual(h.seen.at(-1), { path: "/api/platform/applications/readiness", body: {
    schemaVersion: 2, applicationId, artifactId: value.descriptor.artifactId, compatibility, bindingSetId: ready.bindingSetId,
  } });
  assert.equal(context.applicationConnection.context().bindingSetId, ready.bindingSetId);
  assert.deepEqual(context.applicationConnection.context().resourceBindings, bindings());
});

test("old Bridge contracts cannot activate a candidate or fall back to legacy preparation", async t => {
  for (const options of [{ status: 404 }, { edit(result) { result.schemaVersion = 1; } }]) {
    const root = await temporary(t), value = await artifact(root), h = harness(value, options);
    const installer = createApplicationInstaller({ rootDir: path.join(root, "apps"), trustedKeys, ...h.provider });
    await assert.rejects(installer.installVerifiedPackage(value), { code: options.status ? "BACKEND_CONTRACT_INCOMPATIBLE" : "APPLICATION_PREPARATION_INVALID" });
    assert.equal((await installer.list())[0].installationState, "pending");
    assert.equal(h.seen.length, 1);
    assert.equal(h.seen[0].path, "/api/platform/applications/candidates/prepare");
    await assert.rejects(installer.resolveCurrent(applicationId), { code: "APPLICATION_RESOURCES_PENDING" });
  }
});

test("candidate scopes, identities and operations are checked before selection commit", async t => {
  const mutations = [
    result => { result.bindingScope.accountId = "different-account"; },
    result => { result.bindingScope.deviceId = "different-box"; },
    result => { result.bindingScope.artifactId = randomUUID(); },
    result => { result.bindingScope.ownershipEpoch = 0; },
    result => { result.bindingScope.ownershipEpoch = "1"; },
    result => { result.operationId = "different-operation"; },
    result => { result.bindingSetId = "not-a-binding-set"; },
  ];
  for (const edit of mutations) {
    const root = await temporary(t), value = await artifact(root), h = harness(value, { edit });
    const installer = createApplicationInstaller({ rootDir: path.join(root, "apps"), trustedKeys, ...h.provider });
    await assert.rejects(installer.installVerifiedPackage(value), { code: "APPLICATION_PREPARATION_INVALID" });
    await assert.rejects(installer.resolveCurrent(applicationId), { code: "APPLICATION_RESOURCES_PENDING" });
  }
});

test("resource-free v3 applications activate offline without preparing or manufacturing a binding", async t => {
  const root = await temporary(t), noResources = { ...manifest, compatibility: { ...compatibility, resourceDependencies: [] } };
  const value = await artifact(root, noResources);
  value.descriptor.compatibility = noResources.compatibility; value.descriptor.manifest = noResources;
  value.envelope = envelopeFor(value.descriptor);
  const h = harness(value); h.state.phase = "disconnected";
  const installer = createApplicationInstaller({ rootDir: path.join(root, "apps"), trustedKeys, ...h.provider });
  const ready = await installer.installVerifiedPackage(value);
  assert.equal(ready.artifactId, value.descriptor.artifactId);
  assert.equal(ready.bindingSetId, undefined); assert.equal(ready.installationState, undefined);
  assert.equal(h.seen.length, 0);
});

test("rollback swaps the previous artifact and its matching binding together", async t => {
  const root = await temporary(t), rootDir = path.join(root, "apps");
  const first = await artifact(root), next = await artifact(root, { ...manifest, version: "1.1.0" });
  const original = await createApplicationInstaller({ rootDir, trustedKeys, ...harness(first).provider }).installVerifiedPackage(first);
  const h = harness(next), installer = createApplicationInstaller({ rootDir, trustedKeys, ...h.provider,
    getCompatibilityContext: input => input.phase === "rollback" ? {
      clientVersion: "0.2.0", hostProtocol: 1, localDataSchemaVersion: "1.0.0", backend: backend(),
    } : h.provider.getCompatibilityContext(input) });
  const updated = await installer.installVerifiedPackage(next);
  assert.equal(updated.previous.bindingSetId, original.bindingSetId);
  const rolledBack = await installer.rollback(applicationId);
  assert.equal(rolledBack.artifactId, first.descriptor.artifactId);
  assert.equal(rolledBack.bindingSetId, original.bindingSetId);
  assert.equal(rolledBack.operationId, original.operationId);
  assert.deepEqual(rolledBack.bindingScope, original.bindingScope);
  assert.equal(rolledBack.previous.bindingSetId, updated.bindingSetId);
});

test("rollback prepares the retained artifact on the current box before atomically switching its binding", async t => {
  const root = await temporary(t), rootDir = path.join(root, "apps");
  const first = await artifact(root), next = await artifact(root, { ...manifest, version: "1.1.0" });
  const h = harness(next), installer = createApplicationInstaller({ rootDir, trustedKeys, ...h.provider,
    getCompatibilityContext: async input => ({ ...await h.provider.getCompatibilityContext(input), localDataSchemaVersion: "1.0.0" }),
  });
  const original = await installer.installVerifiedPackage(first);
  await installer.installVerifiedPackage(next);
  h.state.boxId = "box-b"; h.state.accountId = "user-b";
  const updated = await installer.prepareCurrent(applicationId);
  const pointer = path.join(rootDir, applicationId, ".current-version.json"), before = await readFile(pointer, "utf8");
  assert.equal((await installer.assertRollbackCompatible(applicationId)).status, "ready");
  assert.equal(await readFile(pointer, "utf8"), before);
  const rolledBack = await installer.rollback(applicationId);
  assert.equal(rolledBack.artifactId, original.artifactId);
  assert.equal(rolledBack.operationId, original.operationId);
  assert.notEqual(rolledBack.bindingSetId, original.bindingSetId);
  assert.deepEqual(rolledBack.bindingScope, { accountId: "user-b", deviceId: "box-b", ownershipEpoch: 1, artifactId: original.artifactId });
  assert.equal(rolledBack.previous.bindingSetId, updated.bindingSetId);
  const preparations = h.seen.filter(item => item.path.endsWith("prepare") && item.body.artifactId === original.artifactId);
  assert.equal(preparations.length, 3);
  assert.ok(preparations.every(item => item.body.operationId === original.operationId));
});

test("rollback preflight and commit preserve the current version when current-box preparation is not ready", async t => {
  for (const failure of ["offline", "blocked", "contract", "data", "session"]) {
    const root = await temporary(t), rootDir = path.join(root, "apps");
    const first = await artifact(root), next = await artifact(root, { ...manifest, version: "1.1.0" });
    let reject = false;
    const h = harness(next, {
      edit(result, input) {
        if (!reject) return;
        if (failure === "blocked") { result.status = "blocked"; result.code = "APP_ENTITLEMENT_REQUIRED"; }
        if (failure === "contract" && input.path.endsWith("readiness")) result.contracts = [];
      },
    });
    const installer = createApplicationInstaller({ rootDir, trustedKeys, ...h.provider,
      getCompatibilityContext: async input => ({ ...await h.provider.getCompatibilityContext(input),
        localDataSchemaVersion: reject && failure === "data" ? "2.0.0" : "1.0.0",
        ...(reject && failure === "session" ? { assertCurrent() { throw Object.assign(new Error("NETWORK_CHANGED"), { code: "NETWORK_CHANGED" }); } } : {}),
      }),
    });
    await installer.installVerifiedPackage(first); await installer.installVerifiedPackage(next);
    h.state.boxId = "box-b";
    const selected = await installer.prepareCurrent(applicationId);
    const pointer = path.join(rootDir, applicationId, ".current-version.json"), before = await readFile(pointer, "utf8");
    reject = true;
    if (failure === "offline") h.state.phase = "disconnected";
    const code = { offline: "APPLICATION_RESOURCES_PENDING", blocked: "APP_ENTITLEMENT_REQUIRED",
      contract: "BACKEND_CONTRACT_INCOMPATIBLE", data: "APPLICATION_DATA_SCHEMA_INCOMPATIBLE", session: "NETWORK_CHANGED" }[failure];
    await assert.rejects(installer.assertRollbackCompatible(applicationId), { code });
    await assert.rejects(installer.rollback(applicationId), { code });
    assert.equal(await readFile(pointer, "utf8"), before);
    assert.equal((await installer.resolveCurrent(applicationId)).bindingSetId, selected.bindingSetId);
  }
});

test("preparing a selected artifact for another account and box is scoped, idempotent and failure safe", async t => {
  const root = await temporary(t), rootDir = path.join(root, "apps"), value = await artifact(root);
  let blocked = false;
  const h = harness(value, { edit(result) { if (blocked) { result.status = "blocked"; result.code = "APP_ENTITLEMENT_REQUIRED"; } } });
  const installer = createApplicationInstaller({ rootDir, trustedKeys, ...h.provider });
  const initial = await installer.installVerifiedPackage(value);
  h.state.accountId = "user-b"; h.state.boxId = "box-b"; blocked = true;
  const pointer = path.join(rootDir, applicationId, ".current-version.json"), before = await readFile(pointer, "utf8");
  const denied = await installer.prepareCurrent(applicationId);
  assert.equal(denied.resourcePreparation.status, "blocked");
  assert.equal(await readFile(pointer, "utf8"), before);
  blocked = false;
  const rebound = await installer.prepareCurrent(applicationId);
  assert.equal(rebound.artifactId, initial.artifactId);
  assert.equal(rebound.operationId, initial.operationId);
  assert.notEqual(rebound.bindingSetId, initial.bindingSetId);
  assert.deepEqual(rebound.bindingScope, { accountId: "user-b", deviceId: "box-b", ownershipEpoch: 1, artifactId: initial.artifactId });
  assert.equal((await installer.prepareCurrent(applicationId)).bindingSetId, rebound.bindingSetId);
  assert.equal(h.seen.filter(item => item.path.endsWith("prepare")).every(item => item.body.operationId === initial.operationId), true);
  h.state.accountId = "user-a"; h.state.boxId = "box-a";
  assert.equal((await installer.prepareCurrent(applicationId)).bindingSetId, initial.bindingSetId);
});

test("a damaged candidate marker cannot hide or prune a committed usable application", async t => {
  const root = await temporary(t), rootDir = path.join(root, "apps"), value = await artifact(root);
  const installer = createApplicationInstaller({ rootDir, trustedKeys, ...harness(value).provider });
  const ready = await installer.installVerifiedPackage(value);
  await writeFile(path.join(rootDir, applicationId, ".pending-install.json"), "incomplete");
  assert.equal((await installer.list())[0].artifactId, ready.artifactId);
  await installer.prune(applicationId);
  assert.equal((await installer.resolveCurrent(applicationId)).bindingSetId, ready.bindingSetId);
});


test("rebind cannot replace the selected binding after its account changes during the final permit check", async t => {
  const root = await temporary(t), rootDir = path.join(root, "apps"), value = await artifact(root, { ...manifest, releaseAccess: "account" });
  const h = harness(value); let checks = 0;
  const installer = createApplicationInstaller({ rootDir, trustedKeys, ...h.provider,
    authorizeRelease: async () => {
      if (++checks === 4) h.state.accountId = "another-account";
      return { assertLive() {}, assertSession() {} };
    },
  });
  await installer.installVerifiedPackage(value);
  const pointer = path.join(rootDir, applicationId, ".current-version.json"), before = await readFile(pointer, "utf8");
  await assert.rejects(installer.prepareCurrent(applicationId), { code: "NETWORK_CHANGED" });
  assert.equal(await readFile(pointer, "utf8"), before);
});

test("rollback keeps the selected artifact and binding if readiness connection expires before commit", async t => {
  const root = await temporary(t), rootDir = path.join(root, "apps");
  const first = await artifact(root), next = await artifact(root, { ...manifest, version: "1.1.0" });
  await createApplicationInstaller({ rootDir, trustedKeys, ...harness(first).provider }).installVerifiedPackage(first);
  const h = harness(next), installer = createApplicationInstaller({ rootDir, trustedKeys, ...h.provider,
    getCompatibilityContext: input => input.phase === "rollback" ? {
      clientVersion: "0.2.0", hostProtocol: 1, localDataSchemaVersion: "1.0.0", backend: backend(),
      assertCurrent() { throw Object.assign(new Error("NETWORK_CHANGED"), { code: "NETWORK_CHANGED" }); },
    } : h.provider.getCompatibilityContext(input),
  });
  const updated = await installer.installVerifiedPackage(next);
  await assert.rejects(installer.rollback(applicationId), { code: "NETWORK_CHANGED" });
  assert.equal((await installer.resolveCurrent(applicationId)).artifactId, updated.artifactId);
  assert.equal((await installer.resolveCurrent(applicationId)).bindingSetId, updated.bindingSetId);
});


test("candidate preparation cannot activate an update until full readiness contracts and authorization pass", async t => {
  for (const [code, edit] of [
    ["BACKEND_CONTRACT_INCOMPATIBLE", result => { result.contracts = []; }],
    ["APP_ENTITLEMENT_REQUIRED", result => { result.authorization = { status: "blocked", code: "APP_ENTITLEMENT_REQUIRED" }; }],
    ["RESOURCE_RELEASE_WITHDRAWN", result => { result.status = "blocked"; result.checks = [{ code: "RESOURCE_RELEASE_WITHDRAWN" }]; }],
    ["APPLICATION_PREPARATION_INVALID", result => { result.bindingScope.ownershipEpoch++; }],
  ]) {
    const root = await temporary(t), rootDir = path.join(root, "apps");
    const first = await artifact(root), next = await artifact(root, { ...manifest, version: "1.1.0" });
    const initial = await createApplicationInstaller({ rootDir, trustedKeys, ...harness(first).provider }).installVerifiedPackage(first);
    const h = harness(next, { edit(result, input) { if (input.path.endsWith("readiness")) edit(result); } });
    const installer = createApplicationInstaller({ rootDir, trustedKeys, ...h.provider });
    await assert.rejects(installer.installVerifiedPackage(next), { code });
    const current = await installer.resolveCurrent(applicationId);
    assert.equal(current.artifactId, initial.artifactId);
    assert.equal(current.bindingSetId, initial.bindingSetId);
    assert.equal((await installer.list())[0].pendingInstallation.resourcePreparation.code, code);
    assert.deepEqual(h.seen.map(item => item.path), ["/api/platform/applications/candidates/prepare", "/api/platform/applications/readiness"]);
  }
});


test("explicit selection after legacy migration retains the prepared signed artifact binding", async t => {
  const root = await temporary(t), rootDir = path.join(root, "apps"), value = await artifact(root), legacy = path.join(rootDir, applicationId, "legacy");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, ".wanx-install.json"), JSON.stringify({ ...manifest, protocolVersion: 1,
    compatibility: undefined, version: "legacy", installPath: legacy }));
  const installer = createApplicationInstaller({ rootDir, trustedKeys, ...harness(value).provider });
  await installer.selectCurrent(applicationId, "legacy");
  assert.equal((await installer.installVerifiedPackage(value)).selectionRequired, true);
  const selected = await installer.selectCurrent(applicationId, value.descriptor.version);
  assert.equal(selected.artifactId, value.descriptor.artifactId);
  assert.match(selected.bindingSetId, /^[a-f0-9]{64}$/);
  assert.equal(selected.bindingScope.artifactId, selected.artifactId);
});


test("client consumes the real Python candidate preparation contract without changing resource identities", async t => {
  const actual = JSON.parse(await readFile(new URL("../../wanx-bridge/tests/fixtures/resources-prepare-v2.json", import.meta.url), "utf8"));
  t.mock.method(Date, "now", () => Date.parse(actual.observedAt) + 100);
  const currentManifest = { ...manifest, applicationId: actual.applicationId, compatibility: {
    ...compatibility, backendProductId: actual.backendProductId, backendContracts: [],
    resourceDependencies: actual.resources.map(({ kind, resourceId, version }) => ({ kind, resourceId, minVersion: version })),
  } };
  const context = { accountId: actual.bindingScope.accountId, clientId: "fixture-client", boxId: actual.deviceId, connection: "ready" };
  const requests = [], descriptor = { schemaVersion: 3, artifactId: actual.artifactId };
  const provider = createApplicationBackend({ clientVersion: "0.2.0", account: { getIdentity: () => ({ accountId: context.accountId }) }, client: {
    snapshot: () => ({ phase: "ready", connection: { deviceId: actual.deviceId } }),
    applicationConnection: async () => ({ context: () => context, request: async input => {
      requests.push({ path: input.path, body: JSON.parse(input.body) });
      return { status: 200, body: Buffer.from(JSON.stringify(input.path.endsWith("prepare") ? actual : {
        ...actual, productId: actual.backendProductId, contracts: [], checks: [], readOnly: true,
      })) };
    } }),
  } });
  const prepared = await provider.prepareApplication({ manifest: currentManifest, descriptor, operationId: actual.operationId });
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.bindingSetId, actual.bindingSetId);
  assert.deepEqual(prepared.bindingScope, actual.bindingScope);
  const runtime = await provider.getCompatibilityContext({ manifest: { ...currentManifest, ...prepared }, descriptor, phase: "launch" });
  assert.deepEqual(runtime.applicationConnection.context().resourceBindings, actual.bindings);
  assert.deepEqual(requests.map(item => item.path), ["/api/platform/applications/candidates/prepare",
    "/api/platform/applications/readiness", "/api/platform/applications/readiness"]);
  assert.equal(requests[0].body.operationId, actual.operationId);
  assert.equal(requests[1].body.bindingSetId, actual.bindingSetId);
});
