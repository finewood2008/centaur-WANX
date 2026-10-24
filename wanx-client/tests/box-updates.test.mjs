import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalJSON, digestPayload, verifyRelease } from "../updates/contracts.mjs";
import { createBoxUpdates } from "../updates/box-service.mjs";

const fixture = name => readFile(new URL(`fixtures/wanx-upgrade-v1/${name}`, import.meta.url), "utf8");
const plan = JSON.parse(await fixture("plan.json"));
const keys = { "test-only-release-v1": await fixture("test-only-release-public.pem") };
const vectors = JSON.parse(await fixture("canonical-vectors.json"));
const now = Date.parse("2026-10-14T12:00:00Z");
const inventory = { schemaVersion: 1, ...plan.baseline, reportSequence: 3, observedAt: new Date(now).toISOString(), otaReady: true, suiteVersion: null, releaseId: null };
const operation = { operationId: "op-1", deviceId: plan.deviceId, planId: plan.planId, planDigest: plan.planDigest,
  state: "queued", attemptGeneration: 1, lastSequence: 0, allowedActions: ["cancel"], errorCode: null, serviceAvailable: true };
async function harness(options = {}) {
  let scope = { accountId: "account-1", deviceId: plan.deviceId }, device = { inventory, candidate: { status: "available", release: plan.release, releaseDigest: plan.releaseDigest }, activeOperation: null, canUpgrade: true };
  let currentPlan = plan, currentOperation = operation;
  const calls = [];
  const service = await createBoxUpdates({ getScope: () => scope, captureSession: () => () => {}, keys, now: () => now,
    request: async input => {
      calls.push(structuredClone(input));
      if (input.path.includes("/devices/")) return structuredClone(device);
      if (input.path.endsWith("/plans")) return structuredClone(currentPlan);
      return structuredClone(currentOperation);
    }, ...options });
  return { service, calls, scope: value => { scope = value; service.sync(); }, device: value => { device = value; },
    plan: value => { currentPlan = value; }, operation: value => { currentOperation = value; } };
}

test("Node verifies the Admin Python canonical signature, baseline and plan test vectors", async () => {
  assert.equal(canonicalJSON(plan.release.payload), vectors.releaseCanonicalUtf8);
  assert.equal(verifyRelease(plan.release, { product: "wanx-box", keys, now }).digest, vectors.releaseDigest);
  const { planDigest, ...payload } = plan;
  assert.equal(digestPayload(payload), planDigest);
  assert.equal(digestPayload(plan.baseline), vectors.baselineDigest);
  const client = JSON.parse(await fixture("client-release.json"));
  assert.equal(verifyRelease(client, { product: "wanx-client", keys, now }).release.product, "wanx-client");
});

test("foundation releases require the known box extension, module archive and new updater contract", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const foundationKeys = { foundation: publicKey.export({ type: "spki", format: "pem" }) };
  const payload = { ...structuredClone(plan.release.payload), requiredExtensions: ["wanx.foundation-modules.v1"], minUpdaterVersion: "1.1.0",
    components: { discovery: { version: "20261015-discovery", sha256: "a".repeat(64) } },
    artifacts: [{ component: "discovery", kind: "module-tar", sha256: "a".repeat(64), sizeBytes: 100, url: "https://example.test/discovery.tar.gz" }] };
  const signed = value => ({ payload: value, signature: { algorithm: "ed25519", keyId: "foundation",
    signatureBase64: sign(null, Buffer.from(canonicalJSON(value)), privateKey).toString("base64") } });
  const verify = (value, product = "wanx-box") => verifyRelease(signed(value), { product, keys: foundationKeys, now });
  assert.equal(verify(payload).release.artifacts[0].kind, "module-tar");
  for (const patch of [
    { requiredExtensions: [] }, { requiredExtensions: ["wanx.unknown.v1"] },
    { requiredExtensions: ["wanx.foundation-modules.v1", "wanx.foundation-modules.v1"] },
    { minUpdaterVersion: "1.0.0" }, { minUpdaterVersion: undefined },
  ]) {
    const invalid = { ...payload, ...patch };
    if (invalid.minUpdaterVersion === undefined) delete invalid.minUpdaterVersion;
    assert.throws(() => verify(invalid), { code: "CONTRACT_UNSUPPORTED" });
  }
  assert.throws(() => verify({ ...payload, product: "wanx-client" }, "wanx-client"), { code: "CONTRACT_UNSUPPORTED" });
  for (const patch of [{ kind: "docker-image" }, { imageId: null }, { imageId: `sha256:${"b".repeat(64)}` }, { sha512: "not-for-module-tar" }])
    assert.throws(() => verify({ ...payload, artifacts: [{ ...payload.artifacts[0], ...patch }] }), { code: "UPDATE_INVALID_ARTIFACT" });
  assert.throws(() => verify({ ...payload, components: { discovery: { ...payload.components.discovery, imageId: null } } }), { code: "UPDATE_INVALID_ARTIFACT" });
});

test("foundation inventory capabilities remain outside the legacy plan baseline", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const foundationKeys = { foundation: publicKey.export({ type: "spki", format: "pem" }) };
  const payload = { ...structuredClone(plan.release.payload), requiredExtensions: ["wanx.foundation-modules.v1"], minUpdaterVersion: "1.1.0",
    components: { p2p: { version: "20261015-p2p-recovery", sha256: "b".repeat(64) } },
    artifacts: [{ component: "p2p", kind: "module-tar", sha256: "b".repeat(64), sizeBytes: 100, url: "https://example.test/p2p.tar.gz" }] };
  const release = { payload, signature: { algorithm: "ed25519", keyId: "foundation",
    signatureBase64: sign(null, Buffer.from(canonicalJSON(payload)), privateKey).toString("base64") } };
  const { planDigest: _oldDigest, ...nextPlan } = { ...plan, release, releaseDigest: digestPayload(payload), steps: ["p2p"] };
  const h = await harness({ keys: foundationKeys });
  h.device({ inventory: { ...inventory, supportedExtensions: ["wanx.foundation-modules.v1"] }, canUpgrade: true,
    candidate: { status: "available", release, releaseDigest: nextPlan.releaseDigest } });
  h.plan({ ...nextPlan, planDigest: digestPayload(nextPlan) });
  assert.equal((await h.service.check()).phase, "available");
  assert.equal((await h.service.plan({ releaseId: plan.releaseId })).phase, "planned");
  assert.deepEqual(h.service.snapshot().inventory.supportedExtensions, ["wanx.foundation-modules.v1"]);
  assert.equal(h.service.snapshot().plan.baseline.supportedExtensions, undefined);
  for (const steps of [["wanx"], ["p2p", "p2p"], ["p2p", "discovery"], []]) {
    await h.service.check();
    const changedPlan = { ...nextPlan, steps };
    h.plan({ ...changedPlan, planDigest: digestPayload(changedPlan) });
    await assert.rejects(h.service.plan({ releaseId: plan.releaseId }), { code: "PLAN_STALE" });
  }
});

test("box inspection, fixed plan confirmation and operation status use authenticated Admin APIs", async () => {
  const h = await harness();
  assert.equal((await h.service.check()).phase, "available");
  assert.equal(h.service.snapshot().inventory.suiteVersion, null, "a candidate is never the actual suite version");
  assert.equal((await h.service.plan({ releaseId: plan.releaseId })).phase, "planned");
  await assert.rejects(h.service.execute({ planId: plan.planId }), { code: "UPDATE_CONFIRMATION_REQUIRED" });
  assert.equal(h.calls.filter(call => call.path.endsWith("/operations")).length, 0);
  assert.equal((await h.service.execute({ planId: plan.planId, confirmed: true })).phase, "executing");
  const submitted = h.calls.at(-1).body;
  assert.equal(submitted.planDigest, plan.planDigest); assert.equal(submitted.maintenanceConfirmed, true);
  await h.service.execute({ planId: plan.planId, confirmed: true });
  assert.equal(h.calls.at(-1).body.idempotencyKey, submitted.idempotencyKey);
  h.operation({ ...operation, state: "downloading", lastSequence: 2 });
  await h.service.status({ operationId: "op-1" });
  assert.equal(h.service.snapshot().operation.state, "downloading");
  h.operation({ ...operation, state: "queued", lastSequence: 1 });
  await assert.rejects(h.service.status({ operationId: "op-1" }), { code: "UPDATE_STALE_RESPONSE" });
  assert.equal(h.service.snapshot().operation.state, "downloading");
});

test("wrong baseline or modified impact cannot become a confirmed plan", async () => {
  for (const modified of [{ ...plan, planDigest: "0".repeat(64) }, { ...plan, impact: { serviceInterruption: false, dataMigration: true } }]) {
    const h = await harness(); await h.service.check(); h.plan(modified);
    await assert.rejects(h.service.plan({ releaseId: plan.releaseId }), { code: "PLAN_STALE" });
    assert.equal(h.service.snapshot().plan, null);
  }
});

test("unknown, stale, unsigned and offline inventories never authorize an upgrade", async () => {
  for (const value of [null, { ...inventory, observedAt: "2026-10-14T10:00:00Z" }]) {
    const h = await harness(); h.device({ inventory: value, candidate: { status: "blocked", reasonCode: "INVENTORY_UNKNOWN" }, canUpgrade: true });
    assert.equal((await h.service.check()).phase, "blocked");
    await assert.rejects(h.service.plan({ releaseId: plan.releaseId }), { code: "PLAN_STALE" });
  }
  const h = await harness({ keys: {} });
  assert.equal((await h.service.check()).reason, "UPDATE_NOT_CONFIGURED");
  assert.equal(h.service.snapshot().candidate, null);
});

test("switching account or box invalidates pending response, plan and operation", async () => {
  let reply;
  const h = await harness({ request: () => new Promise(resolve => { reply = resolve; }) });
  const checking = h.service.check();
  while (!reply) await new Promise(resolve => setImmediate(resolve));
  h.scope({ accountId: "account-2", deviceId: "other-box" });
  reply({ inventory, candidate: null, activeOperation: null });
  await assert.rejects(checking, { code: "UPDATE_SESSION_CHANGED" });
  assert.equal(h.service.snapshot().deviceId, "other-box"); assert.equal(h.service.snapshot().inventory, null);
  await assert.rejects(h.service.execute({ deviceId: plan.deviceId, planId: plan.planId, confirmed: true }), { code: "PLAN_STALE" });
});

test("cancellation remains requested until the device acknowledges a safe terminal state", async () => {
  const h = await harness(); h.device({ inventory, candidate: null, activeOperation: operation, canUpgrade: true });
  await h.service.check();
  h.operation({ ...operation, cancelRequested: true });
  await h.service.cancel({ operationId: "op-1" });
  assert.equal(h.service.snapshot().operation.state, "queued");
  await assert.rejects(h.service.resume({ operationId: "op-1", confirmed: true }), { code: "UPDATE_ACTION_NOT_ALLOWED" });
});

const currentRelease = { releaseId: "installed-release", version: "1.1.0-rc.2", channel: "test",
  components: ["wanx"], verifiedAt: inventory.observedAt };
const completedOperation = { ...operation, state: "succeeded", lastSequence: 8, allowedActions: ["status"] };

test("current release and completed history are explicit device evidence, never candidate metadata", async () => {
  const h = await harness();
  assert.equal(h.service.snapshot().currentRelease, null);
  assert.equal(h.service.snapshot().latestOperation, null);
  await h.service.check();
  assert.equal(h.service.snapshot().currentRelease, null);
  h.device({ inventory, currentRelease, latestOperation: completedOperation, canUpgrade: false });
  const checked = await h.service.check();
  assert.deepEqual(checked.currentRelease, currentRelease);
  assert.deepEqual(checked.latestOperation, completedOperation);
  assert.equal(checked.operation.state, "succeeded");
  assert.equal(checked.canUpgrade, false);
  h.device({ inventory, currentRelease, latestOperation: completedOperation, canUpgrade: true,
    candidate: { status: "available", release: plan.release, releaseDigest: plan.releaseDigest } });
  assert.equal((await h.service.check()).phase, "available", "historical success cannot hide a newer offered update");
  assert.equal((await h.service.plan({ releaseId: plan.releaseId })).phase, "planned");
  h.device({ inventory: { ...inventory, reportSequence: 4 } });
  await h.service.check();
  assert.equal(h.service.snapshot().currentRelease, null, "new inventory cannot inherit a prior release declaration");
  assert.equal(h.service.snapshot().latestOperation, null);
  h.scope({ accountId: "account-2", deviceId: "other-box" });
  assert.equal(h.service.snapshot().currentRelease, null);
  assert.equal(h.service.snapshot().operation, null);
});

test("current release rejects malformed or mismatched evidence and ignores stale inventory claims", async () => {
  for (const invalid of [plan.release, { ...currentRelease, components: [] },
    { ...currentRelease, components: ["wanx", "wanx"] }, { ...currentRelease, components: ["semantica"] },
    { ...currentRelease, verifiedAt: "2026-10-14T11:59:00Z" }, { ...currentRelease, version: null }]) {
    const h = await harness(); h.device({ inventory, currentRelease: invalid });
    await assert.rejects(h.service.check(), { code: "UPDATE_INVALID_RESPONSE" });
    assert.equal(h.service.snapshot().currentRelease, null);
  }
  for (const observedAt of ["2026-10-14T10:00:00Z", "2026-10-14T13:00:00Z"]) {
    const h = await harness(); h.device({ inventory: { ...inventory, observedAt }, currentRelease: { ...currentRelease, verifiedAt: observedAt } });
    assert.equal((await h.service.check()).currentRelease, null);
  }
});

test("equivalent UTC timestamp spellings bind the current release to the same inventory instant", async () => {
  for (const verifiedAt of ["2026-10-14T12:00:00Z", "2026-10-14T12:00:00.000+00:00", "2026-10-14T20:00:00+08:00"]) {
    const h = await harness();
    h.device({ inventory, currentRelease: { ...currentRelease, verifiedAt } });
    assert.equal((await h.service.check()).currentRelease.verifiedAt, verifiedAt);
  }
  for (const verifiedAt of ["not-a-date", "2026-10-14T12:00:00.001Z"]) {
    const h = await harness();
    h.device({ inventory, currentRelease: { ...currentRelease, verifiedAt } });
    await assert.rejects(h.service.check(), { code: "UPDATE_INVALID_RESPONSE" });
  }
});

test("active operations outrank terminal history and stale history cannot replace accepted evidence", async () => {
  const h = await harness();
  const activeOperation = { ...operation, operationId: "op-active", state: "downloading", lastSequence: 3 };
  h.device({ inventory, currentRelease, activeOperation, latestOperation: completedOperation });
  assert.equal((await h.service.check()).operation.operationId, "op-active");
  for (const latestOperation of [{ ...completedOperation, deviceId: "other-box" }, { ...completedOperation, state: "queued" },
    { ...completedOperation, lastSequence: 7 }]) {
    h.device({ inventory, latestOperation });
    await assert.rejects(h.service.check(), { code: latestOperation.lastSequence === 7 ? "UPDATE_STALE_RESPONSE" : "UPDATE_INVALID_RESPONSE" });
    assert.equal(h.service.snapshot().operation.operationId, "op-active");
    assert.equal(h.service.snapshot().latestOperation.lastSequence, 8);
  }
  h.device({ inventory, activeOperation: { ...activeOperation, lastSequence: 2 }, latestOperation: completedOperation });
  await assert.rejects(h.service.check(), { code: "UPDATE_STALE_RESPONSE" });
  assert.equal(h.service.snapshot().operation.lastSequence, 3);
});

test("terminal status refreshes current release with inventory and cannot retain an old declaration", async () => {
  const h = await harness(); h.device({ inventory, activeOperation: operation });
  await h.service.check(); h.operation(completedOperation);
  h.device({ inventory: { ...inventory, reportSequence: 4 }, currentRelease, latestOperation: completedOperation });
  assert.deepEqual((await h.service.status({ operationId: "op-1" })).currentRelease, currentRelease);
  h.device({ inventory: { ...inventory, reportSequence: 5 }, latestOperation: completedOperation });
  assert.equal((await h.service.status({ operationId: "op-1" })).currentRelease, null);
});

test("new ownership clears prior upgrade evidence and permits a fresh inventory sequence", async () => {
  const h = await harness();
  h.device({ inventory, currentRelease, latestOperation: completedOperation });
  await h.service.check();
  const newInventory = { ...inventory, ownershipEpoch: inventory.ownershipEpoch + 1, reportSequence: 1 };
  h.device({ inventory: newInventory, latestOperation: null });
  const changed = await h.service.check();
  assert.equal(changed.inventory.reportSequence, 1);
  for (const key of ["operation", "latestOperation", "currentRelease", "plan"]) assert.equal(changed[key], null);
  h.device({ inventory: { ...inventory, reportSequence: 100 }, latestOperation: completedOperation });
  await assert.rejects(h.service.check(), { code: "UPDATE_STALE_RESPONSE" });
  assert.equal(h.service.snapshot().inventory.ownershipEpoch, newInventory.ownershipEpoch);
  assert.equal(h.service.snapshot().operation, null);
  for (const ownershipEpoch of [undefined, -1, 1.5, "2"]) {
    h.device({ inventory: { ...newInventory, ownershipEpoch } });
    await assert.rejects(h.service.check(), { code: "UPDATE_INVALID_RESPONSE" });
  }
});

test("ownership change during terminal status refresh clears the old task and plan", async () => {
  const h = await harness();
  h.device({ inventory, currentRelease, activeOperation: operation });
  await h.service.check(); h.operation(completedOperation);
  h.device({ inventory: { ...inventory, ownershipEpoch: inventory.ownershipEpoch + 1, reportSequence: 1 } });
  const changed = await h.service.status({ operationId: operation.operationId });
  for (const key of ["operation", "latestOperation", "currentRelease", "plan", "candidate"]) assert.equal(changed[key], null);
});
