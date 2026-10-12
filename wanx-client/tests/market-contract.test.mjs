import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { verifyEnvelope } from "../applications/descriptor.mjs";
import { verifyPackageHash, extractApplicationArchive } from "../applications/archive.mjs";
import { compareVersions, validateVersion } from "../applications/version.mjs";

test("Node accepts the same release-tool fixture and SemVer vectors as Admin Python", async (t) => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/market-contract-v1.json", import.meta.url), "utf8"));
  const descriptor = verifyEnvelope(fixture.envelope, fixture.trustedKeys);
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = path.join(root, "fixture.wanxapp");
  await writeFile(archive, Buffer.from(fixture.archiveBase64, "base64"));
  await verifyPackageHash(archive, descriptor);
  await extractApplicationArchive(archive, path.join(root, "extracted"), descriptor);
  for (const [a, b, expected] of fixture.versionComparisons) assert.equal(compareVersions(a, b), expected);
  for (const version of fixture.invalidVersions) assert.throws(() => validateVersion(version));
});
