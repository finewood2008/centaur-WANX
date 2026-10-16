import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readProjectManifest, stageApplication } from "../tools/package-market-app.mjs";
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
  const market = { ...local, protocolVersion: 3, releaseAccess: "account", compatibility: {
    backendProductId: "wanx", clientRange: ">=0.1.4 <1.0.0", hostProtocolRange: ">=1.0.0 <2.0.0",
    backendContracts: [], resourceDependencies: [], localDataSchema: { readRange: ">=1.0.0 <2.0.0", writeVersion: "1.0.0" },
  } };
  await writeFile(path.join(project, "application.manifest.json"), JSON.stringify(local));
  await writeFile(path.join(project, "main.cjs"), "module.exports = {};\n");
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "market-fixture", private: true, scripts: { package: "node build.mjs" } }));
  await writeFile(path.join(project, "build.mjs"), `import {mkdir,copyFile} from 'node:fs/promises';
    await mkdir('dist/application',{recursive:true});
    for(const file of ['application.manifest.json','main.cjs']) await copyFile(file,'dist/application/'+file);`);
  return { root, project, local, market };
}

test("market-only v3 manifest produces matching signed and archive manifests without changing local development", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project, "market.manifest.json"), JSON.stringify(f.market));
  const { layout, manifest } = await readProjectManifest(f.project, "0.3.4");
  assert.equal(layout, "application");
  assert.equal(manifest.version, "0.3.4");
  assert.equal(manifest.releaseAccess, "account");
  const sourceDir = path.join(f.root, "staged");
  await stageApplication(f.project, sourceDir, manifest);
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
  assert.deepEqual(JSON.parse(await readFile(path.join(f.project, "application.manifest.json"), "utf8")), f.local);
});

test("projects without a market-only manifest retain their existing release protocol", async t => {
  const f = await fixture(t);
  const plain = await readProjectManifest(f.project, "0.3.4");
  assert.equal(plain.manifest.protocolVersion, 1);
  assert.equal(plain.manifest.releaseAccess, undefined);
  assert.equal(plain.layout, "application");
  await mkdir(path.join(f.project, "market"));
  await writeFile(path.join(f.project, "market/wanx-app.json"), JSON.stringify(f.local));
  assert.equal((await readProjectManifest(f.project, "0.3.4")).layout, "zhijun");
});

test("invalid or mismatched dedicated manifests never silently fall back to an unrestricted package", async t => {
  const f = await fixture(t), file = path.join(f.project, "market.manifest.json");
  await writeFile(file, "{");
  await assert.rejects(readProjectManifest(f.project, "0.3.4"), SyntaxError);
  for (const mismatch of [{ applicationId: "another.app" }, { entrypoint: "other.cjs" }, { name: "Other" }, { launchMode: "bundled" }]) {
    await writeFile(file, JSON.stringify({ ...f.market, ...mismatch }));
    await assert.rejects(readProjectManifest(f.project, "0.3.4"), /不一致/);
  }
  await writeFile(file, JSON.stringify({ ...f.market, protocolVersion: 1 }));
  await assert.rejects(readProjectManifest(f.project, "0.3.4"), { code: "APPLICATION_CONTRACT_UNSUPPORTED" });
});

test("a build cannot substitute a different application behind the reviewed market manifest", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project, "market.manifest.json"), JSON.stringify(f.market));
  const { manifest } = await readProjectManifest(f.project, "0.3.4");
  await writeFile(path.join(f.project, "application.manifest.json"), JSON.stringify({ ...f.local, applicationId: "other.app" }));
  await assert.rejects(stageApplication(f.project, path.join(f.root, "staged"), manifest), /applicationId 不一致/);
});
