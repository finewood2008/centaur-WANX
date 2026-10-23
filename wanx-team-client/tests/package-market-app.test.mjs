import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { readMarketOptions, readProjectManifest, resolveMarketTarget, stageMarketSource } from "../tools/package-market-app.mjs";
import { applyApplicationDependencyConfig } from "../tools/application-dependency-config.mjs";
import { packageApplication } from "../tools/package-application.mjs";
import { verifyEnvelope } from "../applications/descriptor.mjs";
import { extractApplicationArchive } from "../applications/verified-archive.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-market-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await mkdir(project);
  const local = { applicationId: "example.dialogue", name: "Dialogue", version: "0.3.1", protocolVersion: 1,
    runtime: "electron", launchMode: "shared", entrypoint: "main.cjs", capabilities: ["http.request"] };
  const market = { ...local, description: "", protocolVersion: 3, releaseAccess: "account", compatibility: {
    backendProductId: "wanx", clientRange: ">=0.1.4 <1.0.0", hostProtocolRange: ">=1.0.0 <2.0.0",
    backendContracts: [], resourceDependencies: [], localDataSchema: { readRange: ">=1.0.0 <2.0.0", writeVersion: "1.0.0" },
  } };
  await writeFile(path.join(project, "application.manifest.json"), JSON.stringify(local));
  await writeFile(path.join(project, "main.cjs"), "module.exports = {};\n");
  await mkdir(path.join(project, "market"));
  await writeFile(path.join(project, "market/wanx-app.json"), JSON.stringify(market));
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "market-fixture", private: true, scripts: { "build:market-source": "node build.mjs" } }));
  await writeFile(path.join(project, "build.mjs"), `import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
    await mkdir('dist/application',{recursive:true});
    const manifest=JSON.parse(await readFile('market/wanx-app.json','utf8'));
    manifest.version=process.env.WANX_MARKET_VERSION;
    await writeFile('dist/application/application.manifest.json',JSON.stringify(manifest));
    await writeFile('dist/application/package.json',JSON.stringify({name:'market-fixture',version:manifest.version}));
    await copyFile('main.cjs','dist/application/main.cjs');`);
  return { root, project, local, market };
}

test("standard v3 manifest produces matching signed and archive manifests without changing local development", async t => {
  const f = await fixture(t);
  const { manifest } = await readProjectManifest(f.project, "0.3.4");
  assert.equal(manifest.version, "0.3.4");
  assert.equal(manifest.releaseAccess, "account");
  const sourceDir = path.join(f.root, "staged");
  await stageMarketSource(f.project, sourceDir, manifest);
  await writeFile(path.join(sourceDir, "wanx-app.json"), JSON.stringify(manifest));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyFile = path.join(f.root, "test-only.pem");
  await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const result = await packageApplication({ sourceDir, outputDir: path.join(f.root, "release"), keyFile, keyId: "test-only" });
  const envelope = JSON.parse(await readFile(result.envelopePath, "utf8"));
  const descriptor = verifyEnvelope(envelope, { "test-only": publicKey.export({ type: "spki", format: "pem" }) });
  assert.equal(descriptor.schemaVersion, 3);
  assert.equal(descriptor.manifest.releaseAccess, "account");
  const extracted = path.join(f.root, "extracted");
  await extractApplicationArchive(result.archivePath, extracted, descriptor);
  for (const file of ["application.manifest.json", "wanx-app.json"])
    assert.deepEqual(JSON.parse(await readFile(path.join(extracted, file), "utf8")), descriptor.manifest);
  assert.equal(JSON.parse(await readFile(path.join(extracted, "package.json"), "utf8")).version, "0.3.4");
  assert.deepEqual(JSON.parse(await readFile(path.join(f.project, "application.manifest.json"), "utf8")), f.local);
});

test("standard market projects use one source command regardless of application ID", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project, "market/wanx-app.json"), JSON.stringify({
    ...f.market, platform: "darwin", arch: "arm64",
  }));
  const { manifest } = await readProjectManifest(f.project, "0.3.4");
  assert.equal(manifest.platform, "darwin");
  const sourceDir = path.join(f.root, "standard-staged");
  await stageMarketSource(f.project, sourceDir, manifest);
  assert.deepEqual(JSON.parse(await readFile(path.join(sourceDir, "application.manifest.json"))), manifest);
  assert.equal(JSON.parse(await readFile(path.join(sourceDir, "package.json"))).version, "0.3.4");
  assert.deepEqual(JSON.parse(await readFile(path.join(f.project, "application.manifest.json"))), f.local);

  await writeFile(path.join(f.project, "package.json"), JSON.stringify({ name: "market-fixture", scripts: {} }));
  await assert.rejects(readProjectManifest(f.project, "0.3.4"), /build:market-source/);
});

test("missing or invalid standard market manifests never fall back to a development manifest", async t => {
  const f = await fixture(t), file = path.join(f.project, "market/wanx-app.json");
  await rm(file);
  await assert.rejects(readProjectManifest(f.project, "0.3.4"), /缺少标准市场清单/);
  await writeFile(file, "{");
  await assert.rejects(readProjectManifest(f.project, "0.3.4"), SyntaxError);
  await writeFile(file, JSON.stringify({ ...f.market, protocolVersion: 1 }));
  await assert.rejects(readProjectManifest(f.project, "0.3.4"), { code: "APPLICATION_CONTRACT_UNSUPPORTED" });
  await writeFile(file, JSON.stringify(f.local));
  await assert.rejects(readProjectManifest(f.project, "0.3.4"), /仅支持协议 3 和账号许可/);
});

test("platform-specific market manifests select macOS and Windows targets", () => {
  const options = { targetConfigured: false, os: "universal", arch: "universal" };
  assert.deepEqual(resolveMarketTarget(options, { platform: "darwin", arch: "arm64" }), { targetOS: "macos", targetArch: "arm64" });
  assert.deepEqual(resolveMarketTarget(options, { platform: "win32", arch: "x64" }), { targetOS: "windows", targetArch: "x64" });
});

test("a build cannot substitute a different application behind the reviewed market manifest", async t => {
  const f = await fixture(t);
  const { manifest } = await readProjectManifest(f.project, "0.3.4");
  const script = path.join(f.project, "build.mjs");
  await writeFile(script, (await readFile(script, "utf8")).replace("manifest.version=", "manifest.applicationId='other.app'; manifest.version="));
  await assert.rejects(stageMarketSource(f.project, path.join(f.root, "staged"), manifest), /应用清单与发行清单不一致/);
});

test("a build cannot silently weaken the reviewed release contract", async t => {
  const f = await fixture(t);
  const { manifest } = await readProjectManifest(f.project, "0.3.4");
  const script = path.join(f.project, "build.mjs");
  await writeFile(script, (await readFile(script, "utf8")).replace("manifest.version=", "manifest.protocolVersion=1; delete manifest.releaseAccess; delete manifest.compatibility; manifest.version="));
  await assert.rejects(stageMarketSource(f.project, path.join(f.root, "staged"), manifest), /应用清单与发行清单不一致/);
});

test("a standard source must build the requested release version", async t => {
  const f = await fixture(t);
  const { manifest } = await readProjectManifest(f.project, "0.3.4");
  const script = path.join(f.project, "build.mjs");
  await writeFile(script, (await readFile(script, "utf8")).replace("process.env.WANX_MARKET_VERSION", '"0.3.1"'));
  await assert.rejects(stageMarketSource(f.project, path.join(f.root, "staged"), manifest), /版本与发行版本不一致/);
});

const dependencies = [
  { kind: "expert", resourceId: "researcher", minVersion: "1.2.3" },
  { kind: "skill-package", resourceId: "research-tools", minVersion: "2.0.0" },
];
const dependencyConfig = manifest => ({ schemaVersion: 1, applicationId: manifest.applicationId,
  version: manifest.version, resourceDependencies: structuredClone(dependencies) });

test("Admin dependency config is signed into both packaged manifests without changing source or build output", async t => {
  const f = await fixture(t);
  f.market.compatibility.backendContracts = [{ id: "research-api", range: ">=1.0.0 <2.0.0", features: ["search"] }];
  await writeFile(path.join(f.project, "market/wanx-app.json"), JSON.stringify(f.market));
  const sourceText = await readFile(path.join(f.project, "market/wanx-app.json"), "utf8");
  const { manifest } = await readProjectManifest(f.project, "0.3.4");
  const config = dependencyConfig(manifest), before = structuredClone({ manifest, config });
  const sourceDir = path.join(f.root, "staged");
  const finalManifest = await stageMarketSource(f.project, sourceDir, manifest, { dependencyConfig: config });
  assert.deepEqual({ manifest, config }, before);
  assert.deepEqual(finalManifest, { ...manifest, compatibility: { ...manifest.compatibility, resourceDependencies: dependencies } });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyFile = path.join(f.root, "test-only.pem");
  await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const result = await packageApplication({ sourceDir, outputDir: path.join(f.root, "release"), keyFile, keyId: "test-only" });
  const descriptor = verifyEnvelope(JSON.parse(await readFile(result.envelopePath, "utf8")), {
    "test-only": publicKey.export({ type: "spki", format: "pem" }),
  });
  assert.deepEqual(descriptor.manifest, finalManifest);
  assert.deepEqual(descriptor.compatibility, finalManifest.compatibility);
  const extracted = path.join(f.root, "extracted");
  await extractApplicationArchive(result.archivePath, extracted, descriptor);
  for (const file of ["application.manifest.json", "wanx-app.json"])
    assert.deepEqual(JSON.parse(await readFile(path.join(extracted, file), "utf8")), finalManifest);
  assert.equal(await readFile(path.join(f.project, "market/wanx-app.json"), "utf8"), sourceText);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.project, "application.manifest.json"), "utf8")), f.local);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.project, "dist/application/application.manifest.json"), "utf8")), manifest);
});

test("dependency config is bound to the exact application and release, and never upgrades a legacy product", async t => {
  const f = await fixture(t), manifest = f.market, config = dependencyConfig(manifest);
  for (const change of [{ applicationId: "other.app" }, { version: "0.3.2" }])
    assert.throws(() => applyApplicationDependencyConfig(manifest, { ...config, ...change }), /应用 ID 或版本/);
  assert.throws(() => applyApplicationDependencyConfig(f.local, config), /仅支持协议 3/);
  const special = { ...manifest, compatibility: { ...manifest.compatibility, backendProductId: "super-advisory" } };
  assert.throws(() => applyApplicationDependencyConfig(special, config), /仅支持 backendProductId=wanx/);
  assert.equal(applyApplicationDependencyConfig(special, { ...config, resourceDependencies: [] }).compatibility.backendProductId, "super-advisory");
});

test("dependency config rejects unknown fields and invalid resource requirements using the runtime validator", async t => {
  const f = await fixture(t), config = dependencyConfig(f.market);
  for (const value of [null, [], {}, { ...config, schemaVersion: "1" }, { ...config, schemaVersion: 2 },
    { ...config, accountId: "unexpected" }, { ...config, resourceDependencies: undefined }])
    assert.throws(() => applyApplicationDependencyConfig(f.market, value));
  const invalid = [null, {}, "researcher", [...dependencies, dependencies[0]],
    Array.from({ length: 65 }, (_, index) => ({ kind: "expert", resourceId: `expert-${index}`, minVersion: "1.0.0" })),
    ...[{ kind: "application" }, { resourceId: "../escape" }, { resourceId: "Upper" }, { minVersion: "^1.0.0" },
      { minVersion: "1.0.0-beta" }, { minVersion: "1.0.0+build" }, { minVersion: "2147483648.0.0" }, { optional: true }]
      .map(change => [{ ...dependencies[0], ...change }]),
  ];
  for (const resourceDependencies of invalid)
    assert.throws(() => applyApplicationDependencyConfig(f.market, { ...config, resourceDependencies }), { code: "APPLICATION_CONTRACT_UNSUPPORTED" });
  const boundary = [{ kind: "expert", resourceId: "1", minVersion: "2147483647.0.0" }];
  assert.deepEqual(applyApplicationDependencyConfig(f.market, { ...config, resourceDependencies: boundary }).compatibility.resourceDependencies, boundary);
});

test("Admin selection cannot hide a source build dependency mismatch", async t => {
  const f = await fixture(t), { manifest } = await readProjectManifest(f.project, "0.3.4");
  const script = path.join(f.project, "build.mjs"), config = dependencyConfig(manifest);
  await writeFile(script, (await readFile(script, "utf8")).replace("manifest.version=",
    `manifest.compatibility.resourceDependencies=${JSON.stringify(dependencies)}; manifest.version=`));
  await assert.rejects(stageMarketSource(f.project, path.join(f.root, "staged"), manifest, { dependencyConfig: config }), /应用清单与发行清单不一致/);
});

test("dependency config paths resolve relative to the local config and CLI overrides it", async t => {
  const f = await fixture(t), configFile = path.join(f.root, "release.json");
  await writeFile(configFile, JSON.stringify({ version: "0.3.4", "dependency-config": "dependencies.json" }));
  const fromFile = await readMarketOptions({ project: f.project, config: configFile });
  assert.equal(fromFile.dependencyConfigFile, path.join(f.root, "dependencies.json"));
  const override = await readMarketOptions({ project: f.project, config: configFile, "dependency-config": "replacement.json" });
  assert.equal(override.dependencyConfigFile, path.resolve("replacement.json"));
  await assert.rejects(readMarketOptions({ project: f.project, config: configFile, "dependency-config": "" }), /非空文件路径/);
});

test("market CLI reads the exported dependency file and rejects a different application before building or signing", async t => {
  const f = await fixture(t), config = dependencyConfig(f.market), file = path.join(f.root, "dependencies.json");
  await writeFile(file, JSON.stringify({ ...config, applicationId: "other.app" }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../tools/package-market-app.mjs", import.meta.url)),
    "--project", f.project, "--version", f.market.version, "--dependency-config", file], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /应用 ID 或版本/);
  await assert.rejects(readFile(path.join(f.project, "dist/application/application.manifest.json")), { code: "ENOENT" });
});

test("dependency staging rejects manifest symlinks without changing their source target", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), { manifest } = await readProjectManifest(f.project, "0.3.4");
  const target = path.join(f.project, "original-wanx.json");
  await writeFile(target, "original source");
  const script = path.join(f.project, "build.mjs");
  await writeFile(script, (await readFile(script, "utf8")) +
    `\nawait (await import('node:fs/promises')).symlink(${JSON.stringify(target)}, 'dist/application/wanx-app.json');`);
  await assert.rejects(stageMarketSource(f.project, path.join(f.root, "staged"), manifest,
    { dependencyConfig: dependencyConfig(manifest) }), /清单必须是普通文件/);
  assert.equal(await readFile(target, "utf8"), "original source");
});
