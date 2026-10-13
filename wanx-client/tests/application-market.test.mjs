import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm, access, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateKeyPairSync, randomUUID, createHash, sign } from "node:crypto";
import { ZipFile } from "yazl";
import { compareVersions, validateVersion } from "../applications/version.mjs";
import { verifyEnvelope, matchesApplicationTarget } from "../applications/descriptor.mjs";
import { createApplicationInstaller } from "../applications/installer.mjs";
import { createApplicationMarket } from "../applications/market.mjs";

const keys = generateKeyPairSync("ed25519");
const trustedKeys = { test: keys.publicKey.export({ type: "spki", format: "pem" }) };
const applicationId = "centaurai.wanx.zhijun";
const manifest = { applicationId, name: "知君", version: "1.0.0", protocolVersion: 1, runtime: "electron", entrypoint: "main.mjs", capabilities: ["identity.read"] };
const envelopeFor = (descriptor) => {
  const bytes = Buffer.from(JSON.stringify(descriptor));
  return { keyId: "test", descriptorBase64: bytes.toString("base64"), signatureBase64: sign(null, bytes, keys.privateKey).toString("base64") };
};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-market-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function artifact(root, version = "1.0.0", extras = [], changeManifest = {}) {
  const zip = new ZipFile(), chunks = [];
  const packagedManifest = { ...manifest, version, ...changeManifest };
  zip.addBuffer(Buffer.from(JSON.stringify(packagedManifest)), "wanx-app.json");
  zip.addBuffer(Buffer.from("export default {};\n"), "main.mjs", { mode: 0o100755 });
  for (const [name, content, options] of extras) zip.addBuffer(Buffer.from(content), name, options);
  const pending = new Promise((resolve, reject) => {
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", resolve);
  });
  zip.end(); await pending;
  const bytes = Buffer.concat(chunks), artifactId = randomUUID();
  const descriptor = { schemaVersion: 1, artifactId, applicationId, version, os: "macos", arch: "arm64", packageType: "wanxapp", fileName: `zhijun-${version}.wanxapp`, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, minWanxVersion: "0.1.0", hostProtocol: 1, manifest: { ...manifest, version } };
  const archivePath = path.join(root, artifactId + ".wanxapp");
  await writeFile(archivePath, bytes);
  return { archivePath, descriptor, envelope: envelopeFor(descriptor), bytes };
}
const candidateFor = (a) => ({ status: "available", release: { releaseId: "release-1", version: a.descriptor.version, revision: 1 }, artifact: { ...a.descriptor, status: "ready", envelope: a.envelope } });

test("SemVer follows numeric and prerelease precedence and ignores build metadata", () => {
  const versions = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.9.0", "1.10.0", "2.0.0"];
  for (let i = 1; i < versions.length; i++) assert.equal(compareVersions(versions[i - 1], versions[i]), -1);
  assert.equal(compareVersions("1.0.0+build2", "1.0.0+build10"), 0);
  for (const invalid of ["v1.0.0", "1.0", "01.0.0", "1.0.0-01", "1.0.0-", "1.0.0+", 1]) assert.throws(() => validateVersion(invalid));
});

test("descriptor keys must be independently trusted and signed exact bytes", async (t) => {
  const a = await artifact(await fixture(t));
  assert.equal(verifyEnvelope(a.envelope, trustedKeys).artifactId, a.descriptor.artifactId);
  assert.throws(() => verifyEnvelope(a.envelope, {}), { code: "MARKET_UNTRUSTED_KEY" });
  const edited = { ...a.envelope, descriptorBase64: Buffer.from(JSON.stringify({ ...a.descriptor, arch: "x64" })).toString("base64") };
  assert.throws(() => verifyEnvelope(edited, trustedKeys), { code: "MARKET_INVALID_SIGNATURE" });
});

test("one signed universal application installs on all supported host targets", async t => {
  const root = await fixture(t), a = await artifact(root);
  Object.assign(a.descriptor, { os: "universal", arch: "universal" });
  a.envelope = envelopeFor(a.descriptor);
  for (const platform of ["darwin", "win32"]) for (const arch of ["x64", "arm64"]) {
    const installer = createApplicationInstaller({ rootDir: path.join(root, platform, arch), trustedKeys });
    const market = createApplicationMarket({ wanxVersion: "0.1.0", platform, arch, trustedKeys,
      applications: { ...installer, listInstalled: installer.list },
      request: async input => input.path.endsWith("/candidate") ? candidateFor(a)
        : { artifactId: a.descriptor.artifactId, url: "https://example.test/app", expiresAt: new Date(Date.now() + 300000).toISOString() },
      fetch: async () => new Response(a.bytes),
    });
    assert.equal((await market.candidate(applicationId)).status, "available");
    await market.install(applicationId);
    assert.equal((await installer.resolveCurrent(applicationId)).artifactId, a.descriptor.artifactId);
    assert.equal((await market.candidate(applicationId)).status, "up_to_date");
    await market.close();
  }
});

test("universal signatures cannot conceal native or manifest platform restrictions", async t => {
  const a = await artifact(await fixture(t));
  const universal = { ...a.descriptor, os: "universal", arch: "universal" };
  for (const changed of [
    { os: "macos" }, { arch: "arm64" },
    { packageType: "dmg", fileName: "app.dmg" }, { packageType: "exe", fileName: "app.exe" },
    { manifest: { ...manifest, platform: "darwin" } },
    { manifest: { ...manifest, arch: "x64" } },
    { manifest: { ...manifest, launchMode: "bundled", platform: "darwin", arch: "arm64" } },
  ]) assert.throws(() => verifyEnvelope(envelopeFor({ ...universal, ...changed }), trustedKeys), { code: "MARKET_INVALID_DESCRIPTOR" });
  assert.equal(matchesApplicationTarget(universal, "windows", "x64"), true);
  assert.equal(matchesApplicationTarget(universal, "linux", "x64"), false);
  assert.equal(matchesApplicationTarget(a.descriptor, "macos", "arm64"), true);
  assert.equal(matchesApplicationTarget(a.descriptor, "macos", "x64"), false);
  assert.equal(matchesApplicationTarget(a.descriptor, "windows", "arm64"), false);
  for (const restriction of [
    { launchMode: "bundled", platform: "darwin", arch: "arm64" },
    { platform: "win32" }, { arch: "x64" },
  ]) assert.throws(() => verifyEnvelope(envelopeFor({ ...a.descriptor, manifest: { ...manifest, ...restriction } }), trustedKeys), { code: "MARKET_INVALID_DESCRIPTOR" });
  const relabeled = { ...a.envelope, descriptorBase64: Buffer.from(JSON.stringify(universal)).toString("base64") };
  assert.throws(() => verifyEnvelope(relabeled, trustedKeys), { code: "MARKET_INVALID_SIGNATURE" });
});

test("managed runtime accepts a signed universal application", {
  skip: !["darwin", "win32"].includes(process.platform),
}, async t => {
  const { runManagedApplication } = await import("../applications/runtime.mjs");
  const root = await fixture(t), a = await artifact(root), applicationRoot = path.join(root, "applications");
  Object.assign(a.descriptor, { os: "universal", arch: "universal" });
  a.envelope = envelopeFor(a.descriptor);
  const installer = createApplicationInstaller({ rootDir: applicationRoot, trustedKeys });
  const installed = await installer.installVerifiedPackage(a);
  const env = { WANX_HOST_CLIENT_APPLICATION_ID: applicationId, WANX_HOST_TOKEN: "test",
    WANX_HOST_SOCKET: "test", WANX_HOST_LAUNCH_ID: "test", WANX_HOST_INSTALL_ROOT: installed.installPath };
  const saved = Object.fromEntries([...Object.keys(env), "WANX_HOST_APPLICATION_DATA"].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  Object.assign(process.env, env);
  let name;
  const app = { setName(value) { name = value; }, setPath() {}, on() {}, once() {} };
  const listeners = new Set(process.listeners("message"));
  t.after(() => { for (const listener of process.listeners("message")) if (!listeners.has(listener)) process.off("message", listener); });
  await runManagedApplication({ applicationRoot, trustedKeys, app });
  assert.equal(name, "知君");
});

test("signed install switches current atomically, rejects downgrade, supports explicit rollback and preserves data", async (t) => {
  const root = await fixture(t), rootDir = path.join(root, "applications"), data = path.join(root, "application-data", applicationId);
  const installer = createApplicationInstaller({ rootDir, trustedKeys });
  const first = await artifact(root), second = await artifact(root, "1.1.0");
  await installer.installVerifiedPackage(first);
  const update = await installer.installVerifiedPackage(second);
  assert.deepEqual(update.previous, { version: "1.0.0", artifactId: first.descriptor.artifactId });
  assert.equal((await installer.list())[0].version, "1.1.0");
  await assert.rejects(installer.installVerifiedPackage(first), { code: "MARKET_UPDATE_NOT_AVAILABLE" });
  await installer.rollback(applicationId);
  assert.equal((await installer.list())[0].version, "1.0.0");
  await installer.installVerifiedPackage(second);
  assert.equal((await installer.list())[0].version, "1.1.0");
  if (process.platform !== "win32") assert.equal((await stat(path.join(update.installPath, "main.mjs"))).mode & 0o777, 0o700);
  await mkdir(data, { recursive: true }); await writeFile(path.join(data, "history"), "saved");
  await installer.uninstall(applicationId);
  assert.deepEqual(await installer.list(), []);
  assert.equal(await readFile(path.join(data, "history"), "utf8"), "saved");
});

test("logout at commit boundary retains current and removes the uncommitted target", async (t) => {
  const root = await fixture(t), rootDir = path.join(root, "applications");
  const installer = createApplicationInstaller({ rootDir, trustedKeys });
  const first = await artifact(root), second = await artifact(root, "1.1.0");
  await installer.installVerifiedPackage(first);
  const target = path.join(rootDir, applicationId, second.descriptor.artifactId);
  await assert.rejects(installer.installVerifiedPackage({ ...second, assertSession() {
    if (existsSync(target)) throw Object.assign(new Error("ACCOUNT_CANCELLED"), { code: "ACCOUNT_CANCELLED" });
  } }), { code: "ACCOUNT_CANCELLED" });
  assert.equal((await installer.list())[0].version, "1.0.0");
  assert.equal(existsSync(target), false);
});

test("startup never activates orphan signed records and cleans interrupted staging", async (t) => {
  const root = await fixture(t), rootDir = path.join(root, "applications");
  const installer = createApplicationInstaller({ rootDir, trustedKeys }), a = await artifact(root);
  await installer.installVerifiedPackage(a);
  await rm(path.join(rootDir, applicationId, ".current-version.json"));
  await mkdir(path.join(rootDir, applicationId, ".staging-interrupted"));
  await mkdir(path.join(rootDir, ".removed-interrupted"));
  assert.deepEqual(await installer.list(), []);
  await installer.recover();
  assert.equal(existsSync(path.join(rootDir, applicationId, a.descriptor.artifactId)), false);
  assert.equal(existsSync(path.join(rootDir, applicationId, ".staging-interrupted")), false);
  assert.equal(existsSync(path.join(rootDir, ".removed-interrupted")), false);
});

test("tampered ZIP and signed manifest mismatch leave active version intact", async (t) => {
  const root = await fixture(t), installer = createApplicationInstaller({ rootDir: path.join(root, "applications"), trustedKeys });
  const first = await artifact(root), bad = await artifact(root, "1.1.0", [], { capabilities: ["http.request"] });
  await installer.installVerifiedPackage(first);
  await assert.rejects(installer.installVerifiedPackage(bad), { code: "MARKET_PACKAGE_INVALID" });
  await writeFile(bad.archivePath, Buffer.alloc(bad.descriptor.size, 0));
  await assert.rejects(installer.installVerifiedPackage(bad), { code: "MARKET_PACKAGE_HASH_MISMATCH" });
  assert.equal((await installer.list())[0].version, "1.0.0");
});

for (const [name, extras] of [
  ["symbolic links", [["link", "../../outside", { mode: 0o120777 }]]],
  ["case-colliding implicit directories", [["Resources/a.json", "a"], ["resources/b.json", "b"]]],
  ["case-colliding files", [["A.txt", "a"], ["a.txt", "b"]]],
  ["reserved installer files", [[".wanx-install.json", "{}"]]],
  ["zip expansion bombs", [["large.txt", Buffer.alloc(2 * 1024 * 1024, 0)]]],
]) test(`archive rejects ${name}`, async (t) => {
  const root = await fixture(t), installer = createApplicationInstaller({ rootDir: path.join(root, "applications"), trustedKeys });
  await assert.rejects(installer.installVerifiedPackage(await artifact(root, "1.0.0", extras)), { code: "MARKET_PACKAGE_INVALID" });
  assert.deepEqual(await installer.list(), []);
});

test("market resolves and validates an exact target, downloads without account headers, and installs", async (t) => {
  const root = await fixture(t), a = await artifact(root);
  const installer = createApplicationInstaller({ rootDir: path.join(root, "applications"), trustedKeys });
  const calls = [];
  const market = createApplicationMarket({ wanxVersion: "0.1.0", platform: "darwin", arch: "arm64", trustedKeys,
    applications: { ...installer, listInstalled: installer.list },
    request: async (input) => {
      calls.push(input);
      return input.path.endsWith("/candidate") ? candidateFor(a) : { artifactId: a.descriptor.artifactId, url: "https://example.test/package", expiresAt: new Date(Date.now() + 300000).toISOString() };
    },
    fetch: async (url, options) => {
      assert.equal(url, "https://example.test/package"); assert.equal(options.headers, undefined); assert.equal(options.redirect, "error");
      return new Response(a.bytes);
    },
  });
  assert.equal((await market.candidate(applicationId)).status, "available");
  await market.install(applicationId);
  assert.equal((await installer.list())[0].artifactId, a.descriptor.artifactId);
  assert.equal(calls[0].body.os, "macos"); assert.equal(calls[0].body.arch, "arm64");
  assert.equal((await market.candidate(applicationId)).status, "up_to_date");
});

test("market refuses publication changes after confirmation and wrong architecture", async (t) => {
  const root = await fixture(t), first = await artifact(root), second = await artifact(root, "1.1.0");
  let selected = first;
  const market = createApplicationMarket({ wanxVersion: "0.1.0", platform: "darwin", arch: "arm64", trustedKeys,
    applications: { listInstalled: async () => [] }, request: async () => candidateFor(selected),
    fetch: () => { throw new Error("must not download"); },
  });
  await market.candidate(applicationId); selected = second;
  await assert.rejects(market.install(applicationId), { code: "MARKET_CANDIDATE_CHANGED" });
  selected = { ...second, descriptor: { ...second.descriptor, arch: "x64" } };
  selected.envelope = envelopeFor(selected.descriptor);
  await assert.rejects(market.candidate(applicationId), { code: "MARKET_INCOMPATIBLE" });
});

test("market refuses downgrade even if server marks older version available", async (t) => {
  const root = await fixture(t), a = await artifact(root);
  const market = createApplicationMarket({ wanxVersion: "0.1.0", platform: "darwin", arch: "arm64", trustedKeys,
    applications: { listInstalled: async () => [{ applicationId, version: "2.0.0", artifactId: "newer" }] }, request: async () => candidateFor(a) });
  assert.equal((await market.candidate(applicationId)).status, "local_newer");
});

test("market rejects candidate metadata that contradicts its signed descriptor", async (t) => {
  const a = await artifact(await fixture(t));
  for (const changed of [{ os: "windows" }, { arch: "x64" }, { packageType: "exe" },
    { fileName: "other.wanxapp" }, { status: "revoked" }]) {
    const candidate = candidateFor(a);
    Object.assign(candidate.artifact, changed);
    const market = createApplicationMarket({ wanxVersion: "0.1.0", platform: "darwin", arch: "arm64", trustedKeys,
      applications: { listInstalled: async () => [] }, request: async () => candidate,
      fetch: () => assert.fail("inconsistent candidates must not be downloaded"),
    });
    await assert.rejects(market.candidate(applicationId), { code: "MARKET_INCOMPATIBLE" });
  }
});

test("market rejects an offered artifact after logout and same-account relogin", async (t) => {
  const root = await fixture(t), a = await artifact(root); let epoch = 1;
  const market = createApplicationMarket({ wanxVersion: "0.1.0", platform: "darwin", arch: "arm64", trustedKeys,
    applications: { listInstalled: async () => [] }, request: async () => candidateFor(a),
    captureSession: () => { const captured = epoch; return () => { if (captured !== epoch) throw Object.assign(new Error(), { code: "ACCOUNT_CANCELLED" }); }; },
  });
  await market.candidate(applicationId); epoch++;
  await assert.rejects(market.install(applicationId), { code: "ACCOUNT_CANCELLED" });
});

test("ZIP traversal names cannot write outside the staged installation", async (t) => {
  const root = await fixture(t), a = await artifact(root, "1.0.0", [["safe.txt", "escape"]]);
  const bytes = Buffer.from(a.bytes);
  for (let at = bytes.indexOf("safe.txt"); at >= 0; at = bytes.indexOf("safe.txt", at + 8)) bytes.write("../x.txt", at, "utf8");
  await writeFile(a.archivePath, bytes);
  a.descriptor.sha256 = createHash("sha256").update(bytes).digest("hex"); a.envelope = envelopeFor(a.descriptor);
  const installer = createApplicationInstaller({ rootDir: path.join(root, "applications"), trustedKeys });
  await assert.rejects(installer.installVerifiedPackage(a), { code: "MARKET_PACKAGE_INVALID" });
  assert.equal(existsSync(path.join(root, "applications", applicationId, "x.txt")), false);
});

test("logout while downloading prevents committing an installation", async (t) => {
  const root = await fixture(t), a = await artifact(root); let live = true, installs = 0;
  const market = createApplicationMarket({ wanxVersion: "0.1.0", platform: "darwin", arch: "arm64", trustedKeys,
    applications: { listInstalled: async () => [], installVerifiedPackage: async () => { installs++; } },
    captureSession: () => () => { if (!live) throw Object.assign(new Error(), { code: "ACCOUNT_CANCELLED" }); },
    request: async (input) => input.path.endsWith("/candidate") ? candidateFor(a) : { artifactId: a.descriptor.artifactId, url: "https://example.test/package", expiresAt: new Date(Date.now() + 300000).toISOString() },
    fetch: async () => ({ ok: true, body: (async function* () { yield a.bytes.subarray(0, 10); live = false; yield a.bytes.subarray(10); })() }),
  });
  await market.candidate(applicationId);
  await assert.rejects(market.install(applicationId), { code: "ACCOUNT_CANCELLED" });
  assert.equal(installs, 0);
});

test("manager serializes launch against uninstall and only launches active version", async (t) => {
  const { createApplicationManager } = await import("../applications/manager.mjs");
  const { EventEmitter } = await import("node:events");
  const root = await fixture(t), a = await artifact(root), b = await artifact(root, "1.1.0");
  let child;
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "applications"), applicationId: "wanx-host", trustedKeys,
    context: () => ({}), spawn: (_exe, _args, { env }) => {
      child = new EventEmitter(); child.exitCode = null; child.kill = () => {};
      queueMicrotask(() => child.emit("message", { type: "wanx:application-ready", launchId: env.WANX_HOST_LAUNCH_ID }));
      return child;
    },
  });
  t.after(() => manager.close());
  await manager.installVerifiedPackage(a); await manager.installVerifiedPackage(b);
  await manager.launch(applicationId, "1.0.0"); // Stale UI version cannot override the current pointer.
  const removing = manager.uninstall(applicationId);
  await assert.rejects(manager.launch(applicationId), { code: "MARKET_OPERATION_BUSY" });
  child.exitCode = 0; child.emit("exit", 0); await removing;
  assert.deepEqual(await manager.listInstalled(), []);
});

test("market migration omits a selected legacy version and persists an explicit signed-version choice", async t => {
  const root = await fixture(t), rootDir = path.join(root, "applications"), a = await artifact(root);
  const legacy = path.join(rootDir, applicationId, "legacy");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, ".wanx-install.json"), JSON.stringify({ ...manifest, version: "legacy", installPath: legacy }));
  const installer = createApplicationInstaller({ rootDir, trustedKeys });
  let requests = 0;
  const market = createApplicationMarket({ wanxVersion: "0.1.0", platform: "darwin", arch: "arm64", trustedKeys,
    applications: { ...installer, listInstalled: installer.list },
    request: async input => {
      requests++;
      if (input.path.endsWith("/candidate")) {
        assert.equal(Object.hasOwn(input.body, "currentVersion"), false);
        return candidateFor(a);
      }
      return { artifactId: a.descriptor.artifactId, url: "https://example.test/app", expiresAt: new Date(Date.now() + 300000).toISOString() };
    }, fetch: async () => new Response(a.bytes),
  });
  assert.deepEqual(await market.candidate(applicationId), { status: "incompatible", reason: "version_selection_required" });
  assert.equal(requests, 0);
  await installer.selectCurrent(applicationId, "legacy");
  assert.equal((await market.candidate(applicationId)).status, "available");
  await market.install(applicationId);
  assert.equal((await installer.list())[0].selectionRequired, true);
  await installer.selectCurrent(applicationId, "1.0.0");
  assert.equal((await installer.resolveCurrent(applicationId)).artifactId, a.descriptor.artifactId);
  await access(legacy);
});

for (const expiresAt of [undefined, "invalid", "2000-01-01T00:00:00Z"]) {
  test(`market refuses ${expiresAt ?? "missing"} download expiry before contacting storage`, async t => {
    const a = await artifact(await fixture(t));
    const market = createApplicationMarket({ wanxVersion: "0.1.0", platform: "darwin", arch: "arm64", trustedKeys,
      applications: { listInstalled: async () => [] },
      request: async input => input.path.endsWith("/candidate") ? candidateFor(a)
        : { artifactId: a.descriptor.artifactId, url: "https://example.test/app", expiresAt },
      fetch: () => assert.fail("expired authorization must not reach storage"),
    });
    await market.candidate(applicationId);
    await assert.rejects(market.install(applicationId), { code: "MARKET_DOWNLOAD_EXPIRED" });
  });
}

test("market close aborts a stalled download, removes temporary files and rejects later work", async t => {
  const root = await fixture(t), a = await artifact(root);
  let downloading;
  const started = new Promise(resolve => { downloading = resolve; });
  const market = createApplicationMarket({ wanxVersion: "0.1.0", platform: "darwin", arch: "arm64", trustedKeys, temporaryRoot: root,
    applications: { listInstalled: async () => [], installVerifiedPackage: () => assert.fail("closed market cannot commit") },
    request: async input => input.path.endsWith("/candidate") ? candidateFor(a)
      : { artifactId: a.descriptor.artifactId, url: "https://example.test/app", expiresAt: new Date(Date.now() + 300000).toISOString() },
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }); downloading();
    }),
  });
  await market.candidate(applicationId);
  const installing = market.install(applicationId).catch(error => error.code);
  await started;
  await market.close();
  assert.equal(await installing, "MARKET_SESSION_CHANGED");
  await assert.rejects(market.list(), { code: "MARKET_SESSION_CHANGED" });
  const { readdir } = await import("node:fs/promises");
  assert.equal((await readdir(root)).some(name => name.startsWith("wanx-market-")), false);
});

test("signed upgrades keep the running process until next open and wait for its exit", async t => {
  const { createApplicationManager } = await import("../applications/manager.mjs");
  const { EventEmitter } = await import("node:events");
  const { setImmediate } = await import("node:timers/promises");
  const root = await fixture(t), a = await artifact(root), b = await artifact(root, "1.1.0");
  const children = [];
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "applications"), applicationId: "wanx-host", trustedKeys,
    context: () => ({}), spawn: (_exe, args, { env }) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, kills: 0, env, args });
      child.send = () => {};
      child.kill = () => { child.kills++; if (children.length > 1) child.emit("exit", 0); };
      children.push(child);
      queueMicrotask(() => child.emit("message", { type: "wanx:application-ready", launchId: env.WANX_HOST_LAUNCH_ID }));
      return child;
    },
  });
  t.after(() => manager.close());
  const installed = await manager.installVerifiedPackage(a);
  await Promise.all([manager.launch(applicationId), manager.launch(applicationId)]);
  await manager.installVerifiedPackage(b);
  assert.equal(children.length, 1); assert.equal(children[0].kills, 0);
  await access(installed.installPath);
  const opens = [manager.launch(applicationId, "1.0.0"), manager.launch(applicationId)];
  while (!children[0].kills) await setImmediate();
  assert.equal(children.length, 1);
  children[0].emit("exit", 0);
  const [first, second] = await Promise.all(opens);
  assert.equal(first.launchId, second.launchId);
  assert.equal(children.length, 2);
  assert.equal(path.basename(children[1].env.WANX_HOST_INSTALL_ROOT), b.descriptor.artifactId);
  assert.ok(children[1].args.includes("--wanx-managed-app"));
});

test("previous market state remains readable and rollback persists through the unified pointer", async t => {
  const root = await fixture(t), rootDir = path.join(root, "applications"), installer = createApplicationInstaller({ rootDir, trustedKeys });
  const a = await artifact(root), b = await artifact(root, "1.1.0");
  await installer.installVerifiedPackage(a); await installer.installVerifiedPackage(b);
  const directory = path.join(rootDir, applicationId);
  await rm(path.join(directory, ".current-version.json"));
  await writeFile(path.join(directory, ".wanx-state.json"), JSON.stringify({ schemaVersion: 1, current: b.descriptor.artifactId, previous: a.descriptor.artifactId }));
  assert.equal((await installer.resolveCurrent(applicationId)).version, "1.1.0");
  await installer.rollback(applicationId);
  assert.equal((await createApplicationInstaller({ rootDir, trustedKeys }).resolveCurrent(applicationId)).version, "1.0.0");
});

test("uninstall cancels session preparation and rejects a racing signed installation", async t => {
  const { createApplicationManager } = await import("../applications/manager.mjs");
  const root = await fixture(t), a = await artifact(root), b = await artifact(root, "1.1.0");
  let resolveConnection, entered;
  const preparing = new Promise(resolve => { entered = resolve; });
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "applications"), applicationId: "wanx-host", trustedKeys,
    context: () => ({}),
    createConnection: () => { entered(); return new Promise(resolve => { resolveConnection = resolve; }); },
    spawn: () => assert.fail("a canceled session must not spawn"),
  });
  t.after(() => manager.close());
  await manager.installVerifiedPackage(a);
  const opening = manager.launch(applicationId).catch(error => error.code);
  await preparing;
  const removing = manager.uninstall(applicationId);
  await assert.rejects(manager.installVerifiedPackage(b), { code: "MARKET_OPERATION_BUSY" });
  resolveConnection({ context: () => ({}) });
  await removing;
  assert.equal(await opening, "APPLICATION_START_CANCELED");
  assert.deepEqual(await manager.listInstalled(), []);
});
