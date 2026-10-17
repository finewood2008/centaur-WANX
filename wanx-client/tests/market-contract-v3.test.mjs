import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { verifyEnvelope } from "../applications/descriptor.mjs";
import { validateCompatibility } from "../applications/compatibility.mjs";
import { extractApplicationArchive, verifyPackageHash } from "../applications/verified-archive.mjs";

test("shared v3 fixture verifies exact signed declarations and package bytes", async t => {
  const f = JSON.parse(await readFile(new URL("fixtures/market-contract-v3.json", import.meta.url), "utf8"));
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-v3-contract-")); t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = verifyEnvelope(f.envelope, f.trustedKeys);
  assert.equal(descriptor.schemaVersion, 3);
  assert.deepEqual(descriptor.compatibility, f.validCompatibility);
  const archive = path.join(root, "app.wanxapp"); await writeFile(archive, Buffer.from(f.archiveBase64, "base64"));
  await verifyPackageHash(archive, descriptor);
  const manifest = await extractApplicationArchive(archive, path.join(root, "extracted"), descriptor);
  assert.deepEqual(manifest.compatibility, descriptor.compatibility);
  for (const resourceDependencies of f.invalidResourceDependencies)
    assert.throws(() => validateCompatibility({ ...f.validCompatibility, resourceDependencies }, 3), { code: "APPLICATION_CONTRACT_UNSUPPORTED" });
});
