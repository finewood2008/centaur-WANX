import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createApplicationReleaseAccess } from "../applications/release-access.mjs";
import { validateApplicationManifest } from "../applications/manifest.mjs";
import { createApplicationInstaller } from "../applications/installer.mjs";
import { createApplicationManager } from "../applications/manager.mjs";
import { createApplicationMarket } from "../applications/market.mjs";
import { createApplicationSession } from "../app-host/session.mjs";
import { packageApplication } from "../tools/package-application.mjs";
import { verifyEnvelope } from "../applications/descriptor.mjs";
import { extractApplicationArchive } from "../applications/verified-archive.mjs";
import { fromEnvironment } from "../host-sdk/index.cjs";

const appId = "test.gray-app", artifactId = "01234567-89ab-4cde-8fab-0123456789ab";
const compatibility = { backendProductId: "wanx", clientRange: ">=0.1.0 <1.0.0", hostProtocolRange: ">=1.0.0 <2.0.0",
  backendContracts: [], resourceDependencies: [], localDataSchema: { readRange: ">=1.0.0 <2.0.0", writeVersion: "1.0.0" } };
const manifest = { applicationId: appId, name: "灰度测试", version: "1.0.0", protocolVersion: 3, runtime: "electron",
  entrypoint: "main.mjs", compatibility, releaseAccess: "account" };
const descriptor = { schemaVersion: 3, applicationId: appId, artifactId, manifest };
const fail = code => Object.assign(new Error(code), { code });
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
function accountFixture({ now = () => Date.now(), response } = {}) {
  let accountId = "00000000-0000-4000-8000-000000000001", phase = "authenticated";
  const listeners = new Set(), calls = [];
  const account = {
    getIdentity: () => phase === "authenticated" ? { accountId, clientId: "client-a" } : null,
    snapshot: () => ({ phase }), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async request(input) {
      calls.push(input);
      return response ? response(input) : { applicationId: appId, artifactId: input.path.split("/").at(-2),
        accountId, channel: "gray", allowed: true, validForSeconds: 60, expiresAt: new Date(now() + 60_000).toISOString() };
    },
  };
  return { account, calls, change(id, next = "authenticated") { accountId = id; phase = next; for (const fn of listeners) fn({ phase }); } };
}
async function packaged(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-gray-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "source"), outputDir = path.join(root, "packages"), keyFile = path.join(root, "test.pem");
  await mkdir(sourceDir); const keys = generateKeyPairSync("ed25519");
  await writeFile(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  await writeFile(path.join(sourceDir, "wanx-app.json"), JSON.stringify(manifest));
  await writeFile(path.join(sourceDir, "main.mjs"), "export default {};\n");
  const value = await packageApplication({ sourceDir, outputDir, keyFile, keyId: "test" });
  const envelope = JSON.parse(await readFile(value.envelopePath));
  return { ...value, envelope, root, sourceDir, trustedKeys: { test: keys.publicKey.export({ type: "spki", format: "pem" }) } };
}
const context = () => ({ clientVersion: "0.2.0", hostProtocol: 1, backend: {
  schemaVersion: 1, productId: "wanx", deviceId: "box-a", observedAt: new Date().toISOString(), authorization: { status: "ready" }, resources: [], bindings: [], contracts: [] } });

test("only protocol 3 accepts the exact signed account release access marker", () => {
  assert.equal(validateApplicationManifest(manifest).releaseAccess, "account");
  for (const change of [{ protocolVersion: 1 }, { protocolVersion: 2 }, { releaseAccess: "optional" }, { releaseAccess: false }])
    assert.throws(() => validateApplicationManifest({ ...manifest, ...change }), { code: "APPLICATION_CONTRACT_UNSUPPORTED" });
});

test("packaging preserves the account marker inside both signed descriptor and verified ZIP", async t => {
  const value = await packaged(t), actual = verifyEnvelope(value.envelope, value.trustedKeys);
  assert.equal(actual.manifest.releaseAccess, "account");
  const extracted = await extractApplicationArchive(value.archivePath, path.join(value.root, "extracted"), actual);
  assert.equal(extracted.releaseAccess, "account");
  const altered = { ...actual, manifest: { ...actual.manifest } }; delete altered.manifest.releaseAccess;
  assert.throws(() => verifyEnvelope({ ...value.envelope, descriptorBase64: Buffer.from(JSON.stringify(altered)).toString("base64") }, value.trustedKeys), { code: "MARKET_INVALID_SIGNATURE" });
});

test("release authority uses the authenticated fixed account ID and sends no account override", async t => {
  let now = 1_800_000_000_000;
  const f = accountFixture({ now: () => now }), access = createApplicationReleaseAccess({ account: f.account, now: () => now });
  t.after(() => access.close());
  const permit = await access.authorize(descriptor);
  assert.equal(permit.accountId, f.account.getIdentity().accountId);
  assert.deepEqual(f.calls[0].body, {});
  assert.equal(f.calls[0].path, `/app-api/market/artifacts/${artifactId}/access`);
  now += 59_999; permit.assertLive(); now++;
  assert.throws(permit.assertLive, { code: "MARKET_RELEASE_ACCESS_EXPIRED" });
  await access.authorize(descriptor); assert.equal(f.calls.length, 2, "a new operation does not reuse a cached permit");
  assert.equal(await access.authorize({ manifest: { protocolVersion: 1 } }), null);
  assert.equal(await access.authorize({ manifest: { protocolVersion: 3 } }), null);
  assert.equal(f.calls.length, 2, "ordinary stable packages do not depend on the new endpoint");
});

test("wrong account, artifact, denial, malformed expiry and leases longer than sixty seconds fail closed", async t => {
  const now = 1_800_000_000_000;
  const base = { applicationId: appId, artifactId, accountId: "00000000-0000-4000-8000-000000000001", channel: "gray", allowed: true, expiresAt: new Date(now + 60_000).toISOString() };
  for (const change of [{ accountId: "other" }, { artifactId: "other" }, { applicationId: "other" }, { allowed: false }, { channel: "draft" }, { expiresAt: "bad" }, { expiresAt: new Date(now).toISOString() }, { expiresAt: new Date(now + 60_001).toISOString() }]) {
    const f = accountFixture({ response: () => ({ ...base, ...change }) });
    const access = createApplicationReleaseAccess({ account: f.account, now: () => now }); t.after(() => access.close());
    await assert.rejects(access.authorize(descriptor), { code: "MARKET_RELEASE_ACCESS_INVALID" });
  }
  const f = accountFixture({ response: () => { throw fail("MARKET_GRAY_ACCESS_DENIED"); } });
  const access = createApplicationReleaseAccess({ account: f.account }); t.after(() => access.close());
  await assert.rejects(access.authorize(descriptor), { code: "MARKET_GRAY_ACCESS_DENIED" });
});

test("account changes and same-account relogin invalidate both pending and previously issued access", async t => {
  const pending = deferred(), f = accountFixture({ response: () => pending.promise });
  const access = createApplicationReleaseAccess({ account: f.account }); t.after(() => access.close());
  const opening = access.authorize(descriptor), original = f.account.getIdentity().accountId;
  f.change(original, "signed_out"); f.change(original);
  pending.resolve({ applicationId: appId, artifactId, accountId: original, channel: "gray", allowed: true, expiresAt: new Date(Date.now() + 59_000).toISOString() });
  await assert.rejects(opening, { code: "MARKET_SESSION_CHANGED" });
  const permit = await access.authorize(descriptor);
  f.change("00000000-0000-4000-8000-000000000002");
  assert.equal(permit.signal.aborted, true);
  assert.throws(permit.assertLive, { code: "MARKET_SESSION_CHANGED" });
});

test("server TTL tolerates clocks two minutes apart and delayed responses cannot extend the local deadline", async t => {
  for (const skew of [-120_000, 120_000]) {
    const startedAt = 1_800_000_000_000; let now = startedAt;
    const f = accountFixture({ response: () => {
      now += 4000;
      return { applicationId: appId, artifactId, accountId: f.account.getIdentity().accountId, channel: "stable", allowed: true,
        validForSeconds: 59, expiresAt: new Date(now + skew + 59_000).toISOString() };
    } });
    const access = createApplicationReleaseAccess({ account: f.account, now: () => now }); t.after(() => access.close());
    const permit = await access.authorize(descriptor);
    assert.equal(permit.expiresAt, startedAt + 59_000);
    now = startedAt + 58_999; permit.assertLive(); now++;
    assert.throws(permit.assertLive, { code: "MARKET_RELEASE_ACCESS_EXPIRED" });
  }
});

test("invalid or exhausted server TTL cannot issue a release permit", async t => {
  for (const duration of [0, 61, 1.5, "60", null, -1]) {
    const f = accountFixture({ response: () => ({ applicationId: appId, artifactId, accountId: f.account.getIdentity().accountId,
      channel: "gray", allowed: true, validForSeconds: duration, expiresAt: new Date().toISOString() }) });
    const access = createApplicationReleaseAccess({ account: f.account }); t.after(() => access.close());
    await assert.rejects(access.authorize(descriptor), { code: "MARKET_RELEASE_ACCESS_INVALID" });
  }
  let now = 1_800_000_000_000;
  const f = accountFixture({ response: () => { now += 1001; return { applicationId: appId, artifactId,
    accountId: f.account.getIdentity().accountId, channel: "gray", allowed: true, validForSeconds: 1, expiresAt: new Date(now).toISOString() }; } });
  const access = createApplicationReleaseAccess({ account: f.account, now: () => now }); t.after(() => access.close());
  await assert.rejects(access.authorize(descriptor), { code: "MARKET_RELEASE_ACCESS_EXPIRED" });
});

test("copied signed packages require access and failed final recheck does not publish the installation", async t => {
  const value = await packaged(t); let checks = 0;
  const installer = createApplicationInstaller({ rootDir: path.join(value.root, "apps"), trustedKeys: value.trustedKeys, getCompatibilityContext: context,
    authorizeRelease: async () => { if (++checks === 2) throw fail("MARKET_GRAY_ACCESS_DENIED"); return { assertLive() {}, assertSession() {} }; } });
  await assert.rejects(installer.installVerifiedPackage(value), { code: "MARKET_GRAY_ACCESS_DENIED" });
  assert.equal(checks, 2); assert.deepEqual(await installer.list(), []);
  const unconfigured = createApplicationInstaller({ rootDir: path.join(value.root, "other"), trustedKeys: value.trustedKeys, getCompatibilityContext: context });
  await assert.rejects(unconfigured.installVerifiedPackage(value), { code: "MARKET_RELEASE_ACCESS_REQUIRED" });
  await assert.rejects(installer.install({ sourceDir: value.sourceDir, manifest }), { code: "MARKET_RELEASE_ACCESS_SIGNED_PACKAGE_REQUIRED" });
});

test("launch and repeated open recheck account access before any resource preparation or child activation", async t => {
  const value = await packaged(t); let allowed = true, requests = 0, spawned = 0, activated = 0, prepared = 0;
  const f = accountFixture();
  const original = f.account.request;
  f.account.request = async input => { requests++; if (!allowed) throw fail("MARKET_GRAY_ACCESS_DENIED"); return original(input); };
  const access = createApplicationReleaseAccess({ account: f.account }); t.after(() => access.close());
  const manager = await createApplicationManager({ applicationRoot: path.join(value.root, "apps"), trustedKeys: value.trustedKeys,
    authorizeRelease: (input, options) => access.authorize(input, options),
    getCompatibilityContext: async ({ phase }) => {
      if (phase === "launch") prepared++;
      return { ...context(), applicationConnection: { context: () => ({ accountId: f.account.getIdentity().accountId, connection: "ready", boxId: "box-a" }) } };
    },
    spawn(_file, _args, options) {
      spawned++;
      const child = Object.assign(new EventEmitter(), { pid: 1, send() { activated++; }, kill() { child.emit("exit"); } });
      queueMicrotask(() => child.emit("message", { type: "wanx:application-ready", launchId: options.env.WANX_HOST_LAUNCH_ID }));
      return child;
    },
  });
  t.after(() => manager.close());
  await manager.installVerifiedPackage(value);
  await manager.launch(appId); const previousRequests = requests;
  await manager.launch(appId); assert.ok(requests > previousRequests); assert.equal(spawned, 1); assert.equal(activated, 1);
  allowed = false; const previousPrepared = prepared;
  await assert.rejects(manager.launch(appId), { code: "MARKET_GRAY_ACCESS_DENIED" });
  assert.equal(prepared, previousPrepared); assert.equal(activated, 1);
});

test("market advertises release access support and refuses denied packages before obtaining storage URLs", async t => {
  const value = await packaged(t), calls = [];
  const market = createApplicationMarket({ wanxVersion: "0.2.0", platform: "darwin", arch: "arm64", trustedKeys: value.trustedKeys,
    applications: { listInstalled: async () => [] },
    request: async input => {
      calls.push(input); assert.ok(input.path.endsWith("/candidate"));
      return { status: "available", release: { version: "1.0.0" }, artifact: { ...value.descriptor, status: "ready", envelope: value.envelope } };
    }, authorizeRelease: async () => { throw fail("MARKET_GRAY_ACCESS_DENIED"); },
  });
  t.after(() => market.close());
  await market.candidate(appId); await assert.rejects(market.install(appId), { code: "MARKET_GRAY_ACCESS_DENIED" });
  assert.equal(calls.length, 2); assert.ok(calls.every(input => input.body.supportsReleaseAccess === true));
});

function shortPermit(ms = 300) {
  const expiresAt = Date.now() + ms;
  return { expiresAt, assertLive() { if (Date.now() >= expiresAt) throw fail("MARKET_RELEASE_ACCESS_EXPIRED"); } };
}
const hostOptions = connection => ({ hostApplicationId: "wanx-host", applicationId: appId, installPath: os.tmpdir(), createConnection: () => connection });

for (const renewal of ["denied", "hung"]) test(`release ${renewal} renewal closes SSE, WebSocket and pending HTTP without closing other sessions`, { timeout: 5000 }, async t => {
  const stream = new PassThrough(), pending = new AbortController();
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(wsServer, "listening");
  t.after(async () => { for (const ws of wsServer.clients) ws.terminate(); await new Promise(resolve => wsServer.close(resolve)); });
  let calls = 0, upstreamAborted = false;
  const connection = {
    context: () => ({ connection: "ready", boxId: "box-a" }),
    request: async input => {
      if (input.path.endsWith("/events")) { queueMicrotask(() => stream.write("data: first\n\n")); return { status: 200, headers: { "content-type": "text/event-stream" }, body: stream }; }
      if (input.path.endsWith("/pending")) return new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => { upstreamAborted = true; reject(fail("ABORTED")); }, { once: true }));
      return { status: 200, headers: {}, body: Buffer.from("ok") };
    },
    openStream: async () => { const ws = new WebSocket(`ws://127.0.0.1:${wsServer.address().port}`); await once(ws, "open"); return ws; },
  };
  const controlled = await createApplicationSession({ ...hostOptions(connection), authorizeRelease: async () => {
    if (++calls === 1) return shortPermit(600);
    if (renewal === "denied") throw fail("MARKET_GRAY_ACCESS_DENIED");
    return new Promise(() => {});
  } });
  const stable = await createApplicationSession(hostOptions(connection));
  const grayClient = fromEnvironment(controlled.environment), stableClient = fromEnvironment(stable.environment);
  t.after(async () => { pending.abort(); grayClient.close(); stableClient.close(); stream.destroy(); await controlled.close(); await stable.close(); });
  await grayClient.context();
  const response = await grayClient.request("/api/events"), reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  const streamClosed = assert.rejects(reader.read());
  const requested = grayClient.request("/api/pending", { signal: pending.signal });
  const requestClosed = assert.rejects(requested);
  const ws = await grayClient.openStream("/api/agents/expert/chat/ws"); await once(ws, "open");
  const wsClosed = once(ws, "close");
  await Promise.all([streamClosed, requestClosed, wsClosed]);
  assert.equal(upstreamAborted, true);
  assert.throws(controlled.assertLive, { code: "HOST_SESSION_EXPIRED" });
  assert.equal((await stableClient.request("/api/ok")).status, 200);
  assert.equal(stable.assertLive().connection, "ready");
  assert.equal(calls, 2);
});

test("renewal may extend a live application but never resurrect an expired one", { timeout: 4000 }, async t => {
  const late = deferred(); let calls = 0;
  const session = await createApplicationSession({ ...hostOptions({ context: () => ({ connection: "ready" }) }), authorizeRelease: async () => {
    calls++; return calls <= 2 ? shortPermit(180) : late.promise;
  } });
  t.after(() => session.close());
  await delay(220); assert.equal(session.assertLive().connection, "ready");
  await delay(100); assert.throws(session.assertLive, { code: "HOST_SESSION_EXPIRED" });
  late.resolve(shortPermit(1000)); await delay(10);
  assert.throws(session.assertLive, { code: "HOST_SESSION_EXPIRED" });
});
