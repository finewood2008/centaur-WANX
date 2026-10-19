import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createDefaultApplicationDelivery, createDefaultApplicationStore, DEFAULT_APPLICATION_IDS as ids } from "../applications/delivery.mjs";
import { createApplicationManager } from "../applications/manager.mjs";
import { createApplicationMarket } from "../applications/market.mjs";
import { writeApplicationZip } from "./support/application-zip.mjs";

const fail = code => Object.assign(new Error(code), { code });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function harness(t) {
  const root = await fixture(t), calls = [], installed = new Map(), issues = new Map();
  const store = createDefaultApplicationStore(path.join(root, "state"));
  let scope = { accountId: "customer-a", deviceId: "box-a" }, epoch = 0;
  const applications = {
    defaultApplicationDeliveryStore: store,
    async listInstalled() { return [...installed.values()]; },
    async prepareInstalledApplication(id, check) {
      check(); calls.push(["prepare", id]);
      if (issues.has(id)) throw fail(issues.get(id));
      return installed.get(id);
    },
  };
  const market = {
    async candidate(id, { assertSession }) {
      assertSession(); calls.push(["candidate", id]);
      if (issues.get(id) === "unavailable") return { status: "unavailable" };
      if (issues.get(id) === "incompatible") return { status: "incompatible" };
      return { status: "available" };
    },
    async install(id, { assertSession, onlyIfMissing }) {
      assert.equal(onlyIfMissing, true);
      assertSession(); calls.push(["install", id]);
      if (issues.has(id)) throw fail(issues.get(id));
      const record = { applicationId: id, version: "1.0.0", artifactId: randomUUID() };
      installed.set(id, record); return record;
    },
  };
  const options = { applications, market, getScope: () => scope, captureSession() {
    const captured = epoch;
    return () => { if (epoch !== captured || !scope) throw fail("MARKET_SESSION_CHANGED"); };
  } };
  const service = createDefaultApplicationDelivery(options);
  t.after(() => service.close());
  return { root, store, service, options, calls, installed, issues, applications, market,
    setScope(next) { scope = next; epoch++; }, currentScope: () => scope };
}

test("delivery waits for authentication and a ready box without querying market", async t => {
  const h = await harness(t); h.setScope(null);
  assert.deepEqual(await h.service.ensureDefaultApplications(), { status: "waiting", code: "DEFAULT_APPLICATION_CONNECTION_REQUIRED" });
  assert.deepEqual(h.calls, []);
});

test("default installation deduplicates, preserves installed versions, and only retries failed applications", async t => {
  const h = await harness(t);
  h.installed.set(ids[0], { applicationId: ids[0], version: "0.8.0", artifactId: randomUUID() });
  h.issues.set(ids[1], "unavailable"); h.issues.set(ids[2], "MARKET_RELEASE_ACCESS_DENIED");
  const first = h.service.ensureDefaultApplications();
  assert.equal(h.service.ensureDefaultApplications(), first);
  const result = await first;
  assert.equal(result.status, "pending");
  assert.deepEqual(result.items.map(item => item.status), ["existing", "pending", "pending", "installed", "installed"]);
  assert.equal(h.calls.some(([verb, id]) => id === ids[0] && verb === "candidate"), false);
  assert.equal(h.installed.get(ids[0]).version, "0.8.0");
  h.issues.clear(); h.calls.length = 0;
  assert.equal((await h.service.ensureDefaultApplications()).status, "ready");
  assert.deepEqual(h.calls, [["candidate", ids[1]], ["install", ids[1]], ["candidate", ids[2]], ["install", ids[2]]]);
  h.calls.length = 0;
  assert.equal((await h.service.ensureDefaultApplications()).status, "ready");
  assert.deepEqual(h.calls, []);
});

test("account and box scoped receipts prepare existing packages without upgrading", async t => {
  const h = await harness(t);
  await h.service.ensureDefaultApplications(); h.calls.length = 0;
  h.setScope({ accountId: "customer-b", deviceId: "box-b" });
  const second = await h.service.ensureDefaultApplications();
  assert.equal(second.status, "ready");
  assert.deepEqual(h.calls, ids.map(id => ["prepare", id]));
  assert.equal((await readdir(path.join(h.root, "state"))).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 2);
});

test("reconnecting the same box rechecks prepared dependencies without downloading or upgrading", async t => {
  const h = await harness(t);
  await h.service.ensureDefaultApplications(); h.calls.length = 0;
  h.service.invalidate();
  h.issues.set(ids[1], "APPLICATION_RESOURCE_VERSION_MISSING");
  const receipt = await h.service.ensureDefaultApplications();
  assert.equal(receipt.status, "pending");
  assert.equal(receipt.items[1].code, "APPLICATION_RESOURCE_VERSION_MISSING");
  assert.deepEqual(h.calls, ids.map(id => ["prepare", id]));
  h.issues.clear(); h.calls.length = 0;
  assert.equal((await h.service.ensureDefaultApplications()).status, "ready");
  assert.deepEqual(h.calls, [["prepare", ids[1]]]);
});

test("a current pending dependency invalidates success cached within the same connection", async t => {
  const h = await harness(t);
  await h.service.ensureDefaultApplications(); h.calls.length = 0;
  h.installed.get(ids[0]).resourcePreparation = { status: "pending", code: "APPLICATION_RESOURCES_PENDING" };
  h.issues.set(ids[0], "APPLICATION_RESOURCES_NOT_READY");
  const receipt = await h.service.ensureDefaultApplications();
  assert.equal(receipt.status, "pending");
  assert.equal(receipt.items[0].code, "APPLICATION_RESOURCES_NOT_READY");
  assert.deepEqual(h.calls, [["prepare", ids[0]]]);
});

test("a new connection or process never treats a previous success as current account authorization", async t => {
  const h = await harness(t);
  await h.service.ensureDefaultApplications(); h.calls.length = 0;
  h.issues.set(ids[4], "MARKET_RELEASE_ACCESS_DENIED");
  const restarted = createDefaultApplicationDelivery(h.options); t.after(() => restarted.close());
  const receipt = await restarted.ensureDefaultApplications();
  assert.equal(receipt.status, "pending");
  assert.equal(receipt.items[4].status, "pending");
  assert.equal(receipt.items[4].code, "MARKET_RELEASE_ACCESS_DENIED");
  assert.deepEqual(h.calls, ids.map(id => ["prepare", id]));
});

test("a changed account cancels downloads and never commits receipt or starts other applications", async t => {
  const h = await harness(t);
  h.market.install = async (_id, { assertSession }) => {
    h.setScope({ accountId: "another-customer", deviceId: "box-a" });
    assertSession(); throw Error("unreachable");
  };
  const result = await h.service.ensureDefaultApplications();
  assert.equal(result.status, "cancelled");
  assert.deepEqual(h.calls, [["candidate", ids[0]]]);
  assert.equal(await h.store.load(createHash("sha256").update(JSON.stringify(["customer-a", "box-a"])).digest("hex")), null);
  assert.equal(h.installed.size, 0);
});

test("invalidation aborts an in-flight request and allows the same scope to retry", async t => {
  const h = await harness(t), original = h.market.install;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  h.market.install = (_id, { assertSession }) => new Promise((_resolve, reject) => {
    started(); assertSession.signal.addEventListener("abort", () => reject(assertSession.signal.reason), { once: true });
  });
  const pending = h.service.ensureDefaultApplications();
  await entered; h.service.invalidate(); h.market.install = original;
  const retry = h.service.ensureDefaultApplications();
  assert.notEqual(retry, pending);
  assert.equal((await pending).status, "cancelled");
  assert.equal((await retry).status, "ready");
});

test("user removal persists across restart, box switch and account switch", async t => {
  const h = await harness(t);
  await h.service.ensureDefaultApplications();
  await h.store.dismiss(ids[0]); h.installed.delete(ids[0]);
  h.setScope({ accountId: "customer-b", deviceId: "box-b" });
  const restarted = createDefaultApplicationDelivery(h.options); t.after(() => restarted.close());
  h.calls.length = 0;
  assert.equal((await restarted.ensureDefaultApplications()).items[0].status, "dismissed");
  assert.equal(h.calls.some(([, id]) => id === ids[0]), false);
});

test("a removed application observed from an older receipt is not silently restored", async t => {
  const h = await harness(t);
  await h.service.ensureDefaultApplications(); h.installed.delete(ids[1]); h.calls.length = 0;
  assert.equal((await h.service.ensureDefaultApplications()).items[1].status, "dismissed");
  assert.equal(await h.store.isDismissed(ids[1]), true);
  assert.deepEqual(h.calls, []);
});

test("pending box dependencies remain pending and are retried without blocking other defaults", async t => {
  const h = await harness(t), original = h.market.install;
  h.market.install = async (id, options) => {
    const value = await original(id, options);
    if (id !== ids[1]) return value;
    Object.assign(value, { installationState: "pending", resourcePreparation: { status: "pending", code: "APPLICATION_RESOURCES_PENDING" } });
    return value;
  };
  const receipt = await h.service.ensureDefaultApplications();
  assert.equal(receipt.status, "pending");
  assert.equal(receipt.items[1].code, "APPLICATION_RESOURCES_PENDING");
  assert.equal(receipt.items.at(-1).status, "installed");
  h.market.install = original; h.calls.length = 0;
  assert.equal((await h.service.ensureDefaultApplications()).status, "ready");
  assert.deepEqual(h.calls, [["candidate", ids[1]], ["install", ids[1]]]);
});

test("corrupt delivery state fails closed and does not install or expose raw errors", async t => {
  const h = await harness(t), first = await h.service.ensureDefaultApplications();
  await writeFile(path.join(h.root, "state", `${first.scopeKey}.json`), "not json");
  h.calls.length = 0;
  assert.deepEqual(await h.service.ensureDefaultApplications(), { status: "pending", code: "DEFAULT_APPLICATION_STATE_INVALID" });
  assert.deepEqual(h.calls, []);
});

const keys = generateKeyPairSync("ed25519");
const trustedKeys = { delivery: keys.publicKey.export({ format: "pem", type: "spki" }) };
async function artifact(root, version) {
  const artifactId = randomUUID(), archivePath = path.join(root, `${artifactId}.wanxapp`);
  const manifest = { applicationId: ids[4], version, name: "知君", protocolVersion: 1, runtime: "electron", entrypoint: "main.mjs" };
  await writeApplicationZip(archivePath, [{ name: "wanx-app.json", body: JSON.stringify(manifest) }, { name: "main.mjs", body: "export default {};" }]);
  const bytes = await readFile(archivePath);
  const descriptor = { schemaVersion: 1, artifactId, applicationId: ids[4], version, os: "universal", arch: "universal", packageType: "wanxapp", fileName: `${version}.wanxapp`, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, minWanxVersion: "0.1.0", hostProtocol: 1, manifest };
  const encoded = Buffer.from(JSON.stringify(descriptor));
  const envelope = { keyId: "delivery", descriptorBase64: encoded.toString("base64"), signatureBase64: sign(null, encoded, keys.privateKey).toString("base64") };
  return { archivePath, envelope, descriptor, bytes };
}

test("manager records removal before uninstall and automatic installation cannot replace an installed version", async t => {
  const root = await fixture(t), one = await artifact(root, "1.0.0"), two = await artifact(root, "1.1.0");
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "apps"), trustedKeys });
  t.after(() => manager.close());
  await manager.installVerifiedPackage(one);
  assert.equal((await manager.installVerifiedPackage({ ...two, onlyIfMissing: true })).version, "1.0.0");
  assert.equal((await manager.listInstalled())[0].artifactId, one.descriptor.artifactId);
  await manager.uninstall(ids[4]);
  assert.equal(await manager.defaultApplicationDeliveryStore.isDismissed(ids[4]), true);
  assert.deepEqual(await manager.listInstalled(), []);
  await assert.rejects(manager.installVerifiedPackage({ ...two, onlyIfMissing: true }), { code: "DEFAULT_APPLICATION_USER_REMOVED" });
  // The user can still explicitly reinstall from the market.
  assert.equal((await manager.installVerifiedPackage(two)).version, "1.1.0");
});

test("normal market path preserves signature verification and passes the box session guard through download", async t => {
  const root = await fixture(t), value = await artifact(root, "1.0.0");
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "apps"), trustedKeys });
  t.after(() => manager.close());
  let box = "box-a";
  const check = () => { if (box !== "box-a") throw fail("DEFAULT_APPLICATION_SESSION_CHANGED"); };
  const market = createApplicationMarket({ applications: manager, trustedKeys, platform: "win32", arch: "x64", wanxVersion: "0.1.4",
    request: async input => input.path.endsWith("/candidate")
      ? { status: "available", release: { version: value.descriptor.version }, artifact: { ...value.descriptor, status: "ready", envelope: value.envelope } }
      : { artifactId: value.descriptor.artifactId, url: "https://market.invalid/app", expiresAt: new Date(Date.now() + 60000).toISOString() },
    fetch: async () => { box = "box-b"; return new Response(value.bytes); },
  });
  t.after(() => market.close());
  await market.candidate(ids[4], { assertSession: check });
  await assert.rejects(market.install(ids[4], { assertSession: check, onlyIfMissing: true }), { code: "DEFAULT_APPLICATION_SESSION_CHANGED" });
  assert.deepEqual(await manager.listInstalled(), []);
});

test("a manual installation during default download is preserved instead of silently upgraded", async t => {
  const root = await fixture(t), one = await artifact(root, "1.0.0"), two = await artifact(root, "1.1.0");
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "apps"), trustedKeys });
  t.after(() => manager.close());
  const market = createApplicationMarket({ applications: manager, trustedKeys, platform: "darwin", arch: "arm64", wanxVersion: "0.1.4",
    request: async input => input.path.endsWith("/candidate")
      ? { status: "available", release: { version: two.descriptor.version }, artifact: { ...two.descriptor, status: "ready", envelope: two.envelope } }
      : { artifactId: two.descriptor.artifactId, url: "https://market.invalid/app", expiresAt: new Date(Date.now() + 60000).toISOString() },
    fetch: async () => { await manager.installVerifiedPackage(one); return new Response(two.bytes); },
  });
  t.after(() => market.close());
  await market.candidate(ids[4]);
  assert.equal((await market.install(ids[4], { onlyIfMissing: true })).version, "1.0.0");
  assert.equal((await manager.listInstalled())[0].artifactId, one.descriptor.artifactId);
});

test("an uninstall during default download prevents reinstallation at the final commit", async t => {
  const root = await fixture(t), value = await artifact(root, "1.0.0");
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "apps"), trustedKeys });
  t.after(() => manager.close());
  const market = createApplicationMarket({ applications: manager, trustedKeys, platform: "darwin", arch: "arm64", wanxVersion: "0.1.4",
    request: async input => input.path.endsWith("/candidate")
      ? { status: "available", release: { version: value.descriptor.version }, artifact: { ...value.descriptor, status: "ready", envelope: value.envelope } }
      : { artifactId: value.descriptor.artifactId, url: "https://market.invalid/app", expiresAt: new Date(Date.now() + 60000).toISOString() },
    fetch: async () => { await manager.uninstall(ids[4]); return new Response(value.bytes); },
  });
  t.after(() => market.close());
  await market.candidate(ids[4]);
  await assert.rejects(market.install(ids[4], { onlyIfMissing: true }), { code: "DEFAULT_APPLICATION_USER_REMOVED" });
  assert.deepEqual(await manager.listInstalled(), []);
  assert.equal(await manager.defaultApplicationDeliveryStore.isDismissed(ids[4]), true);
});

test("receipt write rechecks the session immediately before atomic commit", async t => {
  const root = await fixture(t), store = createDefaultApplicationStore(path.join(root, "state"));
  const key = "a".repeat(64); let checks = 0;
  await assert.rejects(store.save(key, { schemaVersion: 1, scopeKey: key, items: [] }, () => {
    if (++checks === 2) throw fail("MARKET_SESSION_CHANGED");
  }), { code: "MARKET_SESSION_CHANGED" });
  assert.equal(await store.load(key), null);
  assert.deepEqual(await readdir(path.join(root, "state")), []);
});
