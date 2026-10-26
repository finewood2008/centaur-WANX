import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startTestFeed } from "../tools/package-client-test-server.mjs";
import { TEST_APP_ID, TEST_EXTENSION } from "../updates/test-build.mjs";
import { digestPayload } from "../updates/contracts.mjs";

const certificatePath = new URL("./fixtures/tls/server-cert.pem", import.meta.url);
const keyPath = new URL("./fixtures/tls/server-key.pem", import.meta.url);
const ca = await readFile(certificatePath);
const digest = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest(algorithm === "sha512" ? "base64" : "hex");

async function fixture(t, { withMap = true, bytes = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz") } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-test-feed-"));
  const artifactPath = path.join(root, "client.zip"), mapPath = `${artifactPath}.blockmap`;
  const reportPath = path.join(root, "report.json"), releasePath = path.join(root, "release.json");
  const mapBytes = gzipSync(JSON.stringify({ version: "2", files: [{ name: "file", offset: 0, sizes: [bytes.length], checksums: ["fixture"] }] }));
  const signed = { component: "wanx-client", kind: "mac-zip", url: "https://127.0.0.1/client-update.zip",
    sizeBytes: bytes.length, sha256: digest(bytes), sha512: digest(bytes, "sha512"),
    ...(withMap ? { blockMap: { url: "https://127.0.0.1/client-update.zip.blockmap", sizeBytes: mapBytes.length, sha256: digest(mapBytes) } } : {}) };
  const report = { distributionClass: "test-only", build: { testRunId: "fixture" },
    updateArtifact: { path: artifactPath, sizeBytes: signed.sizeBytes, sha256: signed.sha256, sha512: signed.sha512,
      ...(withMap ? { blockMap: { path: mapPath, sizeBytes: mapBytes.length, sha256: digest(mapBytes) } } : {}) } };
  const release = { payload: { schemaVersion: 1, product: "wanx-client", version: "1.0.1-test.2", releaseId: "fixture-release",
    channel: "test-client-fixture", requiredExtensions: [TEST_EXTENSION],
    testIsolation: { applicationId: TEST_APP_ID, testRunId: "fixture" }, platform: { os: "darwin", arch: "arm64" }, artifacts: [signed] } };
  const save = async () => { await writeFile(reportPath, JSON.stringify(report)); await writeFile(releasePath, JSON.stringify(release)); };
  await writeFile(artifactPath, bytes); await writeFile(mapPath, mapBytes); await save();
  const { server, url } = await startTestFeed({ keyPath, certificatePath, reportPath, releasePath });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const options = { ca, servername: "box.wanx.test", agent: false };
  const request = (route, { method = "GET", headers, body } = {}) => new Promise((resolve, reject) => {
    const req = https.request(new URL(route, url), { ...options, method, headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.once("error", reject);
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once("error", reject); req.end(body);
  });
  return { server, url, options, request, report, release, save, bytes, mapBytes, artifactPath, mapPath };
}

test("isolated HTTPS feed keeps old full releases and candidate scope working", async t => {
  const f = await fixture(t, { withMap: false });
  const full = await f.request("/client-update.zip");
  assert.equal(full.status, 200); assert.deepEqual(full.body, f.bytes);
  assert.equal(full.headers["content-length"], String(f.bytes.length));
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.equal((await f.request("/client-update.zip.blockmap")).status, 404);
  const head = await f.request("/client-update.zip", { method: "HEAD", headers: { Range: "bytes=2-4" } });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(head.headers["content-length"], String(f.bytes.length));
  assert.equal(head.headers["content-range"], undefined);
  const input = { product: "wanx-client", channel: "test-client-fixture", platform: { os: "darwin", arch: "arm64" }, currentVersion: "1.0.0" };
  const candidate = await f.request("/app-api/v1/upgrades/candidates", { method: "POST", body: JSON.stringify(input) });
  const result = JSON.parse(candidate.body);
  assert.equal(candidate.status, 200); assert.equal(result.status, "available");
  assert.deepEqual(result.release, f.release); assert.equal(result.releaseDigest, digestPayload(f.release.payload));
  assert.equal((await f.request("/app-api/v1/upgrades/candidates", { method: "POST", body: JSON.stringify({ ...input, channel: "stable" }) })).status, 400);
  f.release.payload.channel = "stable"; await f.save();
  assert.equal((await f.request("/client-update.zip")).status, 400);
});

test("blockmap responses preserve signed gzip bytes and reject report or file changes", async t => {
  const f = await fixture(t);
  const map = await f.request("/client-update.zip.blockmap");
  assert.equal(map.status, 200); assert.deepEqual(map.body, f.mapBytes);
  assert.equal(map.headers["content-type"], "application/octet-stream");
  assert.equal(map.headers["content-encoding"], undefined);
  assert.equal(map.headers["content-length"], String(f.mapBytes.length));
  const head = await f.request("/client-update.zip.blockmap", { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(head.headers["content-length"], String(f.mapBytes.length));
  const original = structuredClone(f.report.updateArtifact.blockMap);
  for (const invalid of [null, { ...original, sizeBytes: original.sizeBytes + 1 }, { ...original, sha256: "a".repeat(64) },
    { ...original, sizeBytes: 16 * 1024 * 1024 + 1 }]) {
    f.report.updateArtifact.blockMap = invalid; await f.save();
    assert.equal((await f.request("/client-update.zip.blockmap")).status, 400);
    assert.equal((await f.request("/client-update.zip")).status, 400);
  }
  delete f.report.updateArtifact.blockMap; await f.save();
  assert.equal((await f.request("/client-update.zip.blockmap")).status, 400);
  f.report.updateArtifact.blockMap = original; await f.save();
  await writeFile(f.mapPath, Buffer.alloc(f.mapBytes.length));
  assert.equal((await f.request("/client-update.zip.blockmap")).status, 400);
  await rm(f.mapPath);
  assert.equal((await f.request("/client-update.zip.blockmap")).status, 503);
});

test("ZIP single byte ranges return exact 206 bounds while invalid ranges return 416", async t => {
  const f = await fixture(t);
  for (const [header, start, end] of [["bytes=2-5", 2, 5], ["bytes=30-", 30, 35], ["bytes=-4", 32, 35], ["bytes=34-100", 34, 35], ["bytes=0-0", 0, 0]]) {
    const result = await f.request("/client-update.zip", { headers: { Range: header } });
    assert.equal(result.status, 206, header);
    assert.equal(result.headers["content-range"], `bytes ${start}-${end}/${f.bytes.length}`);
    assert.equal(result.headers["content-length"], String(end - start + 1));
    assert.deepEqual(result.body, f.bytes.subarray(start, end + 1));
  }
  for (const header of ["bytes=", "bytes=-", "bytes=-0", "bytes=36-", "bytes=5-2", "bytes=0-1,3-4", "items=0-1", "bytes=9007199254740992-", "bytes=0-9007199254740992"]) {
    const result = await f.request("/client-update.zip", { headers: { Range: header } });
    assert.equal(result.status, 416, header);
    assert.equal(result.headers["content-range"], `bytes */${f.bytes.length}`);
    assert.equal(result.body.length, 0);
  }
  f.report.updateArtifact.sizeBytes++; await f.save();
  assert.equal((await f.request("/client-update.zip", { headers: { Range: "bytes=0-1" } })).status, 400);
});

test("disconnecting during a ZIP response closes the stream and leaves the feed usable", { timeout: 10000 }, async t => {
  const f = await fixture(t, { bytes: Buffer.alloc(8 * 1024 * 1024, 42) });
  let sourceClosed;
  const closed = new Promise(resolve => { sourceClosed = resolve; });
  f.server.once("request", (_req, res) => res.once("pipe", source => source.once("close", sourceClosed)));
  await new Promise((resolve, reject) => {
    const req = https.get(new URL("/client-update.zip", f.url), f.options, res => {
      res.once("data", () => { res.destroy(); req.destroy(); resolve(); });
      res.on("error", () => {});
    });
    req.once("error", reject);
  });
  await closed;
  assert.equal((await f.request("/client-update.zip", { method: "HEAD" })).status, 200);
});

test("a file stream error terminates the response without an unhandled error or open source", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let sourceClosed;
  const closed = new Promise(resolve => { sourceClosed = resolve; });
  f.server.once("request", (_req, res) => res.once("pipe", source => {
    source.once("close", sourceClosed);
    source.destroy(new Error("test read failure"));
  }));
  await assert.rejects(f.request("/client-update.zip"));
  await closed;
  assert.equal((await f.request("/client-update.zip", { headers: { Range: "bytes=0-1" } })).status, 206);
});
