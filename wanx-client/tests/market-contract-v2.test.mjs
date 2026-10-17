import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyEnvelope } from "../applications/descriptor.mjs";
import { extractApplicationArchive } from "../applications/verified-archive.mjs";

test("shared Python/Node market v2 fixture preserves signed dependencies and archive", async t => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/market-contract-v2.json", import.meta.url), "utf8"));
  const descriptor = verifyEnvelope(fixture.envelope, fixture.trustedKeys);
  assert.equal(descriptor.schemaVersion, 2);
  assert.equal(descriptor.manifest.protocolVersion, 2);
  assert.deepEqual(descriptor.compatibility, descriptor.manifest.compatibility);
  const archive = Buffer.from(fixture.archiveBase64, "base64");
  assert.equal(archive.length, descriptor.size);
  assert.equal(createHash("sha256").update(archive).digest("hex"), descriptor.sha256);
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-contract-v2-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, "fixture.wanxapp");
  await writeFile(archivePath, archive);
  await extractApplicationArchive(archivePath, path.join(directory, "unpacked"), descriptor);
});
