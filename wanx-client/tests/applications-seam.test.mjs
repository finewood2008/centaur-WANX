import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplicationInstaller } from "../applications/installer.mjs";
import { validateApplicationManifest } from "../applications/manifest.mjs";

const manifest = {
  applicationId: "centaurai.wanx.zhijun",
  name: "知君",
  version: "0.4.2",
  protocolVersion: 1,
  runtime: "electron",
  entrypoint: "shell/main.cjs",
};

test("application manifest accepts a fixed electron entrypoint and rejects traversal", () => {
  assert.equal(validateApplicationManifest(manifest).applicationId, manifest.applicationId);
  assert.throws(() => validateApplicationManifest({ ...manifest, entrypoint: "../main.cjs" }), { code: "INVALID_APPLICATION_ENTRYPOINT" });
});

test("application manifest needs no capabilities and ignores legacy declarations", () => {
  const expected = validateApplicationManifest(manifest);
  for (const capabilities of [[], ["identity.read"], ["custom.capability"], null, "legacy"]) {
    assert.deepEqual(validateApplicationManifest({ ...manifest, capabilities }), expected);
  }
});

test("application installer copies a complete source atomically and records installation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-app-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "installed");
  await mkdir(path.join(source, "shell"), { recursive: true });
  await writeFile(path.join(source, "shell", "main.cjs"), "module.exports = {};\n");
  const installer = createApplicationInstaller({ rootDir: destination });
  const record = await installer.install({ sourceDir: source, manifest });
  assert.equal(record.applicationId, manifest.applicationId);
  assert.equal((await installer.list()).length, 1);
});

test('incomplete local copy cannot activate a package without its entrypoint',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wanx-incomplete-')),source=path.join(root,'source'),destination=path.join(root,'installed');
 await mkdir(path.join(source,'shell'),{recursive:true});await writeFile(path.join(source,'shell/main.cjs'),'module.exports = {};');
 const installer=createApplicationInstaller({rootDir:destination,copy:async(_source,target)=>{await mkdir(target,{recursive:true});}});
 await assert.rejects(installer.install({sourceDir:source,manifest}),{code:'APPLICATION_INSTALL_FAILED'});
 assert.deepEqual(await installer.list(),[]);
});
