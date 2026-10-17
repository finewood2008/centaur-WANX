import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ZipFile } from "yazl";
import { createApplicationBackend } from "../applications/backend.mjs";
import { createApplicationManager } from "../applications/manager.mjs";
import { createApplicationMarket } from "../applications/market.mjs";
import { createDashboardGateway } from "../octop/gateway.mjs";

const applicationId = "centaurai.wanx.zhijun";
const compatibility = {
  backendProductId: "wanx", clientRange: ">=0.1.0 <1.0.0", hostProtocolRange: ">=1.0.0 <2.0.0",
  backendContracts: [{ id: "wanx-bridge.readiness", range: ">=1.0.0 <2.0.0", features: ["read-only"] }],
  requiredExperts: [], localDataSchema: { readRange: ">=1.0.0 <2.0.0", writeVersion: "1.0.0" },
};
const keys = generateKeyPairSync("ed25519");
const trustedKeys = { review: keys.publicKey.export({ type: "spki", format: "pem" }) };
const backend = () => ({ schemaVersion: 1, productId: "wanx", deviceId: "review-box", observedAt: new Date().toISOString(),
  authorization: { status: "ready" }, contracts: [{ id: "wanx-bridge.readiness", version: "1.0.0", features: ["read-only"] }], experts: [] });
const context = () => ({ clientVersion: "0.2.0", hostProtocol: 1, backendRequired: true, expectedDeviceId: "review-box", backend: backend() });

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-upgrade-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function artifact(root, version, contract = compatibility, schemaVersion = 2, { entrypoint = "main.mjs", source = "export default {};\n" } = {}) {
  const manifest = { applicationId, name: "Review app", version, protocolVersion: schemaVersion, runtime: "electron", entrypoint,
    ...(schemaVersion === 2 ? { compatibility: contract } : {}) };
  const zip = new ZipFile(), chunks = [];
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "wanx-app.json");
  zip.addBuffer(Buffer.from(source), entrypoint);
  const done = new Promise((resolve, reject) => {
    zip.outputStream.on("data", chunk => chunks.push(chunk));
    zip.outputStream.on("error", reject); zip.outputStream.on("end", resolve);
  });
  zip.end(); await done;
  const archive = Buffer.concat(chunks), artifactId = randomUUID();
  const descriptor = { schemaVersion, artifactId, applicationId, version, os: "universal", arch: "universal", packageType: "wanxapp",
    fileName: `review-${version}.wanxapp`, sha256: createHash("sha256").update(archive).digest("hex"), size: archive.length,
    minWanxVersion: "0.1.0", hostProtocol: 1, manifest, ...(schemaVersion === 2 ? { compatibility: contract } : {}) };
  const bytes = Buffer.from(JSON.stringify(descriptor));
  const envelope = { keyId: "review", descriptorBase64: bytes.toString("base64"), signatureBase64: sign(null, bytes, keys.privateKey).toString("base64") };
  const archivePath = path.join(root, `${artifactId}.wanxapp`);
  await writeFile(archivePath, archive);
  return { descriptor, envelope, archivePath };
}

async function manager(t, root, getCompatibilityContext, { onSpawn, createConnection } = {}) {
  const children = [];
  const result = await createApplicationManager({ applicationRoot: path.join(root, "applications"), applicationId: "review-host", trustedKeys,
    getCompatibilityContext, createConnection: createConnection || (async () => ({ context: () => ({ connection: "ready", boxId: "review-box" }) })),
    spawn(_file, _args, options) {
      const child = Object.assign(new EventEmitter(), { pid: 1 });
      child.kill = () => { child.emit("exit", null, "SIGTERM"); return true; };
      child.send = () => {};
      children.push(child);
      queueMicrotask(async () => {
        try {
          await onSpawn?.(options);
          child.emit("message", { type: "wanx:application-ready", launchId: options.env.WANX_HOST_LAUNCH_ID });
        } catch (error) { child.emit("error", error); }
      });
      return child;
    },
  });
  t.after(() => result.close());
  return { result, children };
}

// Exercise the production shell provider itself, rather than replacing it with
// the synthetic compatibility context used by the existing unit tests.
async function shellProvider(client) {
  return createApplicationBackend({ client, clientVersion: "0.2.0",
    account: { getIdentity: () => ({ accountId: "review-account", clientId: "review-client" }) },
  }).getCompatibilityContext;
}

test("review: signed v2 reopens after Electron writes a profile using the real shell provider and HTTP gateway", async t => {
  const root = await temporary(t), seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(backend()));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const gateway = await createDashboardGateway({ targetURL: `http://127.0.0.1:${upstream.address().port}`,
    session: { getToken: () => "review-platform-token", close() {} } });
  t.after(() => gateway.close());
  const provider = await shellProvider({ snapshot: () => ({ phase: "ready", connection: { deviceId: "review-box" } }), applicationRequest: gateway.request });
  const value = await artifact(root, "1.0.0");
  const runtime = path.join(root, "applications", ".runtime", applicationId);
  const writerFile = path.join(root, "applications", ".data-access", `${applicationId}.json`);
  const { result, children } = await manager(t, root, provider, { async onSpawn() {
    assert.equal(JSON.parse(await readFile(writerFile, "utf8")).writer.artifactId, value.descriptor.artifactId);
    await mkdir(runtime, { recursive: true });
    await writeFile(path.join(runtime, "Preferences"), "simulated Chromium profile");
  } });
  await result.installVerifiedPackage(value);
  assert.equal((await result.launch(applicationId)).state, "running");
  assert.equal(children.length, 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { path: "/api/platform/applications/readiness", method: "POST", authorization: "Bearer review-platform-token",
    body: { schemaVersion: 1, applicationId, compatibility } });
  await result.close();
  const restarted = await manager(t, root, provider);
  assert.equal((await restarted.result.launch(applicationId)).state, "running");
  assert.equal(restarted.children.length, 1);
  assert.equal(seen.length, 2);
  assert.equal(await readFile(path.join(runtime, "Preferences"), "utf8"), "simulated Chromium profile");
  await assert.rejects(restarted.result.installVerifiedPackage(await artifact(root, "1.1.0")), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
});

test("review: real Electron v2 preserves its profile across Host restart and blocks historical reinstall", {
  skip: process.platform !== "darwin" || !process.env.WANX_ELECTRON_APP, timeout: 60000,
}, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wanx-review-electron-")));
  const profile = path.join(root, "isolated-profile"), applicationRoot = path.join(profile, "applications");
  const runner = path.join(root, "runner.mjs"), children = [];
  const provider = await shellProvider({ snapshot: () => ({ phase: "ready", connection: { deviceId: "review-box" } }),
    applicationRequest: async () => ({ status: 200, body: Buffer.from(JSON.stringify(backend())) }) });
  await writeFile(runner, `
    import { app } from 'electron';
    import { runManagedApplication } from ${JSON.stringify(new URL("../applications/runtime.mjs", import.meta.url).href)};
    runManagedApplication({ app, applicationRoot: ${JSON.stringify(applicationRoot)}, trustedKeys: ${JSON.stringify(trustedKeys)} })
      .catch(error => { console.error(error); app.exit(1); });
  `);
  const value = await artifact(root, "2.0.0", compatibility, 2, { entrypoint: "main.cjs", source: `
    const { app, BrowserWindow } = require('electron');
    const fs = require('node:fs');
    const path = require('node:path');
    app.whenReady().then(async () => {
      const filename = path.join(app.getPath('userData'), 'review-launches.json');
      const previous = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')).launches : 0;
      fs.writeFileSync(filename, JSON.stringify({ launches: previous + 1, userData: app.getPath('userData') }));
      const window = new BrowserWindow({ show: true, width: 400, height: 260, webPreferences: { sandbox: true } });
      await window.loadURL('data:text/html,<h1>Signed v2 continuity review</h1>');
    });
  ` });
  let current;
  t.after(async () => { await current?.close(); await rm(root, { recursive: true, force: true }); });
  const create = () => createApplicationManager({ applicationRoot, applicationId: "review-host", trustedKeys,
    getCompatibilityContext: provider, context: () => ({}),
    electronPath: path.join(process.env.WANX_ELECTRON_APP, "Contents/MacOS/Electron"),
    launcherArgs: [runner, `--user-data-dir=${profile}`],
    spawn(executable, args, options) { const child = spawn(executable, args, options); children.push(child); return child; },
  });
  current = await create();
  await current.installVerifiedPackage(value);
  assert.equal((await current.launch(applicationId)).state, "running");
  await current.close();
  const data = path.join(applicationRoot, ".runtime", applicationId);
  assert.equal(JSON.parse(await readFile(path.join(data, "review-launches.json"), "utf8")).launches, 1);
  current = await create();
  assert.equal((await current.launch(applicationId)).state, "running");
  const retained = JSON.parse(await readFile(path.join(data, "review-launches.json"), "utf8"));
  assert.equal(retained.launches, 2);
  assert.equal(retained.userData, data);
  assert.equal(children.length, 2);
  await current.stop(applicationId);
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  await current.uninstall(applicationId);
  await assert.rejects(current.installVerifiedPackage(await artifact(root, "1.0.0")), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  assert.equal(JSON.parse(await readFile(path.join(data, "review-launches.json"), "utf8")).launches, 2);
  assert.equal(JSON.parse(await readFile(path.join(applicationRoot, ".data-access", `${applicationId}.json`), "utf8")).writer.artifactId, value.descriptor.artifactId);
});

test("review: schema1 keeps launching without invoking the new readiness provider", async t => {
  const root = await temporary(t);
  const { result } = await manager(t, root, () => { throw new Error("legacy must not probe readiness"); });
  await result.installVerifiedPackage(await artifact(root, "1.0.0", compatibility, 1));
  assert.equal((await result.launch(applicationId)).state, "running");
});

test("review: reinstall rejects a signed historical package that cannot read preserved data", async t => {
  const root = await temporary(t);
  const { result, children } = await manager(t, root, () => ({ ...context(), localDataSchemaVersion: "2.0.0" }));
  await result.installVerifiedPackage(await artifact(root, "2.0.0", { ...compatibility,
    localDataSchema: { readRange: ">=2.0.0 <3.0.0", writeVersion: "2.0.0" } }));
  const runtime = path.join(root, "applications", ".runtime", applicationId);
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, "schema.json"), JSON.stringify({ version: "2.0.0", retainedUserData: true }));
  await result.uninstall(applicationId);
  assert.equal(JSON.parse(await readFile(path.join(runtime, "schema.json"))).retainedUserData, true);
  await assert.rejects(result.installVerifiedPackage(await artifact(root, "1.0.0")), { code: "APPLICATION_DATA_SCHEMA_INCOMPATIBLE" });
  assert.deepEqual(await result.listInstalled(), []);
  assert.equal(children.length, 0);
});

test("review: launch rechecks data changed since the package was installed", async t => {
  const root = await temporary(t);
  let schema = "1.0.0";
  const { result, children } = await manager(t, root, () => ({ ...context(), localDataSchemaVersion: schema }));
  await result.installVerifiedPackage(await artifact(root, "1.0.0"));
  await result.launch(applicationId);
  await result.stop(applicationId);
  schema = "2.0.0";
  await assert.rejects(result.launch(applicationId), { code: "APPLICATION_DATA_SCHEMA_INCOMPATIBLE" });
  assert.equal((await result.listInstalled())[0].version, "1.0.0");
  assert.equal(children.length, 1);
});

test("review: a possible writer is durable before spawning and blocks a different package after interrupted startup", async t => {
  const root = await temporary(t);
  let interrupted = true;
  const { result, children } = await manager(t, root, context, { async createConnection() {
    if (interrupted) throw new Error("review startup interrupted");
    return { context: () => ({ connection: "ready", boxId: "review-box" }) };
  } });
  const first = await artifact(root, "1.0.0");
  await result.installVerifiedPackage(first);
  await assert.rejects(result.launch(applicationId), /review startup interrupted/);
  assert.equal(children.length, 0);
  const record = JSON.parse(await readFile(path.join(root, "applications", ".data-access", `${applicationId}.json`), "utf8"));
  assert.equal(record.writer.artifactId, first.descriptor.artifactId);
  assert.equal(record.schemaVersion, 1);
  assert.equal(Object.hasOwn(record, "localDataSchemaVersion"), false);
  await assert.rejects(result.installVerifiedPackage(await artifact(root, "1.1.0")), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  interrupted = false;
  assert.equal((await result.launch(applicationId)).state, "running");
});

test("review: actual schema evidence permits a new writer but its old package cannot be reinstalled without new evidence", async t => {
  const root = await temporary(t);
  let schema;
  const { result } = await manager(t, root, () => ({ ...context(), localDataSchemaVersion: schema }));
  const first = await artifact(root, "1.0.0"), second = await artifact(root, "1.1.0");
  await result.installVerifiedPackage(first);
  await result.launch(applicationId);
  await result.stop(applicationId);
  schema = "1.0.0";
  await result.installVerifiedPackage(second);
  await result.launch(applicationId);
  await result.stop(applicationId);
  const record = JSON.parse(await readFile(path.join(root, "applications", ".data-access", `${applicationId}.json`), "utf8"));
  assert.equal(record.writer.artifactId, second.descriptor.artifactId);
  schema = undefined;
  await assert.rejects(result.rollback(applicationId), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  await result.uninstall(applicationId);
  await assert.rejects(result.installVerifiedPackage(first), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
});

test("review: malformed Host writer state is not treated as an empty profile", async t => {
  const root = await temporary(t);
  const { result, children } = await manager(t, root, context);
  await result.installVerifiedPackage(await artifact(root, "1.0.0"));
  const directory = path.join(root, "applications", ".data-access");
  await mkdir(directory);
  await writeFile(path.join(directory, `${applicationId}.json`), "{interrupted");
  await assert.rejects(result.launch(applicationId), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  assert.equal(children.length, 0);
});

test("review: non-file Host writer state is rejected before child access", async t => {
  const root = await temporary(t);
  const { result, children } = await manager(t, root, context);
  await result.installVerifiedPackage(await artifact(root, "1.0.0"));
  await mkdir(path.join(root, "applications", ".data-access", `${applicationId}.json`), { recursive: true });
  await assert.rejects(result.launch(applicationId), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  assert.equal(children.length, 0);
});

for (const redirected of ["record", "directory"]) test(`review: Host writer ${redirected} symlinks are rejected`, { skip: process.platform === "win32" }, async t => {
  const root = await temporary(t);
  const { result, children } = await manager(t, root, context);
  await result.installVerifiedPackage(await artifact(root, "1.0.0"));
  const outside = path.join(root, "outside"), directory = path.join(root, "applications", ".data-access");
  await mkdir(outside);
  if (redirected === "directory") await symlink(outside, directory);
  else {
    await mkdir(directory);
    await writeFile(path.join(outside, "record.json"), "{}");
    await symlink(path.join(outside, "record.json"), path.join(directory, `${applicationId}.json`));
  }
  await assert.rejects(result.launch(applicationId), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  assert.equal(children.length, 0);
});

test("review: compatibility providers cannot supply a continuity bypass for an external profile", async t => {
  const root = await temporary(t);
  const { result } = await manager(t, root, () => ({ ...context(), trustedDataContinuity: true, localDataPresent: false }));
  const runtime = path.join(root, "applications", ".runtime", applicationId);
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, "Preferences"), "external profile");
  await assert.rejects(result.installVerifiedPackage(await artifact(root, "1.0.0")), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
});

for (const legacy of [false, true]) test(`review: existing ${legacy ? "legacy" : "managed"} data with unknown schema blocks v2 reinstall`, async t => {
  const root = await temporary(t);
  const { result } = await manager(t, root, context);
  const runtime = legacy ? path.join(root, "application-data", applicationId) : path.join(root, "applications", ".runtime", applicationId);
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, "user-data.db"), "existing private data");
  await assert.rejects(result.installVerifiedPackage(await artifact(root, "1.0.0")), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  assert.equal(await readFile(path.join(runtime, "user-data.db"), "utf8"), "existing private data");
});

test("review: data created after installation requires schema evidence before v2 launch", async t => {
  const root = await temporary(t);
  const { result, children } = await manager(t, root, context);
  await result.installVerifiedPackage(await artifact(root, "1.0.0"));
  const runtime = path.join(root, "applications", ".runtime", applicationId);
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, "user-data.db"), "existing private data");
  await assert.rejects(result.launch(applicationId), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  assert.equal(children.length, 0);
});

test("review: installed latest v2 still checks the selected box and resolves compatible history", async t => {
  const root = await temporary(t);
  const latest = await artifact(root, "2.0.0", { ...compatibility,
    backendContracts: [{ id: "wanx-bridge.readiness", range: ">=2.0.0 <3.0.0", features: ["read-only"] }] });
  const history = await artifact(root, "1.0.0");
  const requests = [];
  let probes = 0;
  const market = createApplicationMarket({ wanxVersion: "0.2.0", platform: "darwin", arch: "arm64", trustedKeys,
    applications: { listInstalled: async () => [{ applicationId, version: "2.0.0", artifactId: latest.descriptor.artifactId }] },
    getCompatibilityContext: () => { probes++; return context(); },
    request: async input => {
      requests.push(input);
      if (input.body.backendReadiness) return { status: "local_newer", selection: "compatible_history", release: { version: history.descriptor.version },
        artifact: { ...history.descriptor, status: "ready", envelope: history.envelope } };
      return { status: "up_to_date", release: { version: latest.descriptor.version },
        artifact: { ...latest.descriptor, status: "ready", envelope: latest.envelope } };
    },
  });
  t.after(() => market.close());
  const selected = await market.candidate(applicationId);
  assert.ok(probes > 0, `selected ${selected.status} without checking the current box`);
  assert.ok(requests.some(input => input.body.backendReadiness), "must ask the catalog using current-box evidence");
  assert.equal(selected.status, "incompatible");
  assert.equal(selected.reason, "compatible_history_requires_recovery");
  assert.equal(selected.artifact.artifactId, history.descriptor.artifactId);
  await assert.rejects(market.install(applicationId), { code: "MARKET_CANDIDATE_CHANGED" });
});

test("review: launch-time context for a no-data rollback supplies explicit schema evidence or blocks", async t => {
  const provider = await shellProvider({ snapshot: () => ({ phase: "ready", connection: { deviceId: "review-box" } }),
    applicationRequest: async () => ({ status: 200, body: Buffer.from(JSON.stringify(backend())) }) });
  const value = await provider({ manifest: { applicationId, compatibility }, phase: "rollback" });
  // This is a documented safe limitation: the shell has no trusted local-data
  // schema provider yet, so even same-schema v2 rollback remains unavailable.
  assert.equal(value.localDataSchemaVersion, undefined);
});

test("review: a newer local v2 cannot hide its incompatibility behind an older compatible catalog target", async t => {
  const root = await temporary(t);
  const local = await artifact(root, "2.0.0", { ...compatibility,
    backendContracts: [{ id: "wanx-bridge.readiness", range: ">=2.0.0 <3.0.0", features: [] }] });
  const target = await artifact(root, "1.0.0");
  const requests = [];
  const market = createApplicationMarket({ wanxVersion: "0.2.0", platform: "darwin", arch: "arm64", trustedKeys, getCompatibilityContext: context,
    applications: { listInstalled: async () => [{ ...local.descriptor.manifest, artifactId: local.descriptor.artifactId, envelope: local.envelope }] },
    request: async input => { requests.push(input); return { status: "local_newer", selection: "current", release: { version: target.descriptor.version },
      artifact: { ...target.descriptor, status: "ready", envelope: target.envelope } }; },
  });
  t.after(() => market.close());
  const selected = await market.candidate(applicationId);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.backendReadiness.deviceId, "review-box");
  assert.equal(selected.reason, "compatible_history_requires_recovery");
});

test("review: same-version imported schema1 preserves the legacy catalog result", async t => {
  const root = await temporary(t), value = await artifact(root, "1.0.0", compatibility, 1);
  const market = createApplicationMarket({ wanxVersion: "0.2.0", platform: "darwin", arch: "arm64", trustedKeys,
    applications: { listInstalled: async () => [{ ...value.descriptor.manifest }] },
    getCompatibilityContext: () => { throw new Error("legacy must not probe readiness"); },
    request: async () => ({ status: "up_to_date", release: { version: value.descriptor.version },
      artifact: { ...value.descriptor, status: "ready", envelope: value.envelope } }),
  });
  t.after(() => market.close());
  assert.equal((await market.candidate(applicationId)).status, "up_to_date");
});

test("review: an up-to-date response still rejects a tampered signed target", async t => {
  const root = await temporary(t), value = await artifact(root, "1.0.0");
  const market = createApplicationMarket({ wanxVersion: "0.2.0", platform: "darwin", arch: "arm64", trustedKeys, getCompatibilityContext: context,
    applications: { listInstalled: async () => [{ ...value.descriptor.manifest, artifactId: value.descriptor.artifactId }] },
    request: async () => ({ status: "up_to_date", release: { version: value.descriptor.version },
      artifact: { ...value.descriptor, status: "ready", envelope: { ...value.envelope, signatureBase64: Buffer.alloc(64).toString("base64") } } }),
  });
  t.after(() => market.close());
  await assert.rejects(market.candidate(applicationId), { code: "MARKET_INVALID_SIGNATURE" });
});

test("review: Bridge missing-expert errors show preparation guidance in the application UI", async () => {
  const source = await readFile(new URL("../local-ui/renderer/renderer.js", import.meta.url), "utf8");
  const start = source.indexOf("function marketErrorMessage(error)");
  const end = source.indexOf("\nfunction candidateLabel", start);
  assert.ok(start >= 0 && end > start);
  const display = new Function(`${source.slice(start, end)}; return marketErrorMessage;`)();
  assert.match(display({ code: "EXPERT_NOT_PREPARED" }), /助手.*准备/);
});

test("review: system-signature verification failures explain the installation blocker", async () => {
  const source = await readFile(new URL("../local-ui/renderer/renderer.js", import.meta.url), "utf8");
  const start = source.indexOf("function updateGuidance(code)");
  const end = source.indexOf("\nfunction ", start + 1);
  assert.ok(start >= 0 && end > start);
  const display = new Function(`${source.slice(start, end)}; return updateGuidance;`)();
  assert.match(display("UPDATE_SIGNATURE_VERIFICATION_FAILED"), /无法核验安装包的系统签名.*维护人员/);
});
