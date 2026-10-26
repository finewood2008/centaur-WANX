import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { createRequire } from "node:module";
import { gunzipSync, gzipSync } from "node:zlib";
import { createElectronUpdateAdapter } from "../updates/electron.mjs";
import { MAX_BLOCK_MAP_BYTES } from "../updates/contracts.mjs";
import { createClientBlockMap } from "../tools/client-blockmap.mjs";

const require = createRequire(import.meta.url);
const { NsisUpdater } = require("electron-updater/out/NsisUpdater.js");
const { AppUpdater } = require("electron-updater/out/AppUpdater.js");
const { MacUpdater } = require("electron-updater/out/MacUpdater.js");
const { HttpExecutor, configureRequestUrl, configureRequestOptions } = require("builder-util-runtime");
const certificate = await readFile(new URL("fixtures/tls/server-cert.pem", import.meta.url));
const key = await readFile(new URL("fixtures/tls/server-key.pem", import.meta.url));
const blockSize = 64 * 1024;
const base = Buffer.concat(Array.from({ length: 16 }, (_, index) => Buffer.alloc(blockSize, index)));
const target = Buffer.from(base);
target.fill(100, 5 * blockSize, 6 * blockSize);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sha512 = bytes => createHash("sha512").update(bytes).digest("base64");
function blockMap(bytes) {
  const sizes = [], checksums = [];
  for (let start = 0; start < bytes.length; start += blockSize) {
    const chunk = bytes.subarray(start, start + blockSize);
    sizes.push(chunk.length);
    checksums.push(createHash("sha256").update(chunk).digest("base64"));
  }
  return { version: "2", files: [{ name: "file", offset: 0, sizes, checksums }] };
}

class HttpsExecutor extends HttpExecutor {
  createRequest(options, callback) {
    return https.request({ ...options, ca: certificate, servername: "box.wanx.test" }, callback);
  }
  async download(url, destination, options) {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers };
      configureRequestUrl(url, requestOptions);
      configureRequestOptions(requestOptions);
      this.doDownload(requestOptions, { destination, options, onCancel,
        callback: error => error ? reject(error) : resolve(destination), responseHandler: null }, 0);
    });
  }
}

async function fixture(t, platform = "win32") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-delta-https-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payloads = new Map(), redirects = new Map(), requests = [];
  let rangeMode = "valid", onRange = () => {};
  const server = https.createServer({ key, cert: certificate }, (request, response) => {
    const bytes = payloads.get(request.url);
    const record = { url: request.url, range: request.headers.range, headers: request.headers, bytes: 0 };
    requests.push(record);
    if (redirects.has(request.url)) { response.writeHead(302, { location: redirects.get(request.url) }).end(); return; }
    if (!bytes) { response.writeHead(404).end(); return; }
    const send = (status, content, headers = {}) => {
      record.bytes = content.length;
      response.writeHead(status, { "content-length": content.length, ...headers }).end(content);
    };
    if (!request.headers.range) { send(200, bytes); return; }
    onRange();
    if (rangeMode === "stall") return;
    if (rangeMode === "ignore") { send(200, bytes); return; }
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
    assert.ok(match, "one range per request");
    const start = Number(match[1]), end = Number(match[2]);
    let chunk = bytes.subarray(start, end + 1);
    if (rangeMode === "corrupt") { chunk = Buffer.from(chunk); chunk[0] ^= 255; }
    if (rangeMode === "overlong") chunk = Buffer.concat([chunk, Buffer.from("extra")]);
    if (rangeMode === "truncated") chunk = chunk.subarray(0, chunk.length - 1);
    const contentRange = rangeMode === "wrong-range" ? `bytes 0-${end}/${bytes.length}` : `bytes ${start}-${end}/${bytes.length}`;
    if (["overlong", "truncated"].includes(rangeMode)) {
      record.bytes = chunk.length;
      response.writeHead(206, { "content-range": contentRange }).end(chunk);
    } else send(206, chunk, { "content-range": contentRange });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `https://127.0.0.1:${server.address().port}`;
  function release(version, bytes, { map = blockMap(bytes), rawMap, publishedMap, withMap = true } = {}) {
    const pathname = `/client-${version}.${platform === "darwin" ? "zip" : "exe"}`;
    const mapBytes = rawMap || gzipSync(JSON.stringify(map));
    payloads.set(pathname, bytes);
    payloads.set(`${pathname}.blockmap`, publishedMap || mapBytes);
    const artifact = { component: "wanx-client", kind: platform === "darwin" ? "mac-zip" : "nsis", url: origin + pathname,
      sizeBytes: bytes.length, sha256: sha256(bytes), sha512: sha512(bytes) };
    if (withMap) artifact.blockMap = { url: artifact.url + ".blockmap", sizeBytes: mapBytes.length, sha256: sha256(mapBytes) };
    return { version, createdAt: "2026-10-26T00:00:00Z", platform: { os: platform, arch: "x64" }, artifacts: [artifact] };
  }
  let updater;
  const app = { version: "1.0.0", name: "delta-fixture", isPackaged: true,
    userDataPath: directory, baseCachePath: directory, whenReady: async () => {},
    onQuit() {}, quit() { throw new Error("test must never install"); } };
  class RealNsisUpdater extends NsisUpdater {
    constructor() {
      super(undefined, app);
      updater = this;
      this.httpExecutor = new HttpsExecutor();
    }
  }
  // Exercise the actual Mac download/cache method and AppUpdater, replacing
  // only the final native Squirrel handoff so the test cannot install anything.
  class MacDownloadUpdater extends AppUpdater {
    constructor() { super(undefined, app); updater = this; this.httpExecutor = new HttpsExecutor(); }
    doDownloadUpdate(options) { return MacUpdater.prototype.doDownloadUpdate.call(this, options); }
    debug() {}
    async updateDownloaded(_file, event) { this.emit("update-downloaded", event); }
  }
  if (platform === "darwin") t.mock.method(childProcess, "execFileSync", () => "x86_64");
  t.mock.method(childProcess, "execFile", (_command, _args, _options, callback) =>
    callback(null, "WINDOWS_SIGNATURE_VERIFIED\r\n", ""));
  const adapter = await createElectronUpdateAdapter({ platform,
    configurationPath: path.join(directory, "electron.yml"), installationDirectory: directory,
    windowsPublisherNames: ["Fixture Publisher"], load: async () => ({ NsisUpdater: RealNsisUpdater, MacUpdater: MacDownloadUpdater }) });
  t.after(() => adapter.close());
  const initial = release("2.0.0", base);
  const next = release("3.0.0", target);
  return { directory, adapter, updater, requests, payloads, redirects, release, initial, next,
    rangeMode(value) { rangeMode = value; }, onRange(callback) { onRange = callback; },
    async seed() { await adapter.download(initial, {}, { onProgress() {} }); requests.length = 0; },
  };
}

test("real NsisUpdater seeds on first full download, then reconstructs using HTTPS byte ranges", async t => {
  const f = await fixture(t);
  const first = await f.adapter.download(f.initial, {}, { onProgress() {} });
  assert.deepEqual(await readFile(first.file), base);
  assert.equal(f.requests.filter(item => item.range).length, 0);
  assert.equal(f.requests.find(item => item.url === "/client-2.0.0.exe").bytes, base.length);
  f.requests.length = 0;
  const progress = [];
  const downloaded = await f.adapter.download(f.next, {}, { onProgress: value => progress.push(value) });
  assert.deepEqual(await readFile(downloaded.file), target);
  assert.equal(f.requests.filter(item => item.range).length, 1);
  assert.equal(f.requests.find(item => item.range).bytes, blockSize);
  assert.ok(f.requests.reduce((sum, item) => sum + item.bytes, 0) < target.length / 8,
    "counting the map, less than one eighth of the full installer crossed HTTPS");
  assert.equal(progress.at(-1).percent, 100);
  assert.equal(progress.at(-1).total, blockSize);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.ok(f.requests.every(item => item.url.startsWith("/client-3.0.0.exe")), "never guesses an old map URL");
});

for (const mode of ["ignore", "wrong-range", "overlong", "truncated", "corrupt"]) {
  test(`real NsisUpdater falls back to verified full artifact after ${mode} range response`, async t => {
    const f = await fixture(t);
    await f.seed();
    f.rangeMode(mode);
    const downloaded = await f.adapter.download(f.next, {}, { onProgress() {} });
    assert.deepEqual(await readFile(downloaded.file), target);
    assert.equal(f.requests.filter(item => item.range).length, 1);
    assert.equal(f.requests.filter(item => item.url === "/client-3.0.0.exe" && !item.range).length, 1);
  });
}

test("cancelling a stalled HTTPS range aborts promptly and never starts a full download", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.seed();
  const controller = new AbortController();
  f.rangeMode("stall");
  f.onRange(() => controller.abort());
  await assert.rejects(f.adapter.download(f.next, {}, { signal: controller.signal, onProgress() {} }), /cancelled|abort/i);
  assert.equal(f.requests.filter(item => item.range).length, 1);
  assert.equal(f.requests.filter(item => item.url === "/client-3.0.0.exe" && !item.range).length, 0);
});

test("tampered cached artifact is rejected before range requests, with a successful full fallback", async t => {
  const f = await fixture(t);
  await f.seed();
  const cache = path.join(f.directory, "differential-cache");
  const manifest = JSON.parse(await readFile(path.join(cache, "current.json"), "utf8"));
  await writeFile(path.join(cache, manifest.directory, "artifact"), Buffer.alloc(base.length));
  const downloaded = await f.adapter.download(f.next, {}, { onProgress() {} });
  assert.deepEqual(await readFile(downloaded.file), target);
  assert.equal(f.requests.filter(item => item.range).length, 0);
});

test("tampered block map cannot enter the downloader or replace the verified baseline", async t => {
  const f = await fixture(t);
  await f.seed();
  const pointer = path.join(f.directory, "differential-cache", "current.json");
  const before = await readFile(pointer, "utf8");
  const altered = gzipSync(JSON.stringify(blockMap(base)));
  const bad = f.release("4.0.0", target, { publishedMap: altered });
  const downloaded = await f.adapter.download(bad, {}, { onProgress() {} });
  assert.deepEqual(await readFile(downloaded.file), target);
  assert.equal(f.requests.filter(item => item.range).length, 0);
  assert.equal(await readFile(pointer, "utf8"), before);
});

test("signed malformed maps and oversized compressed map metadata only disable delta", async t => {
  const f = await fixture(t);
  await f.seed();
  const maps = [
    { version: "2", files: [] },
    { version: "2", files: [{ ...blockMap(target).files[0], offset: -1 }] },
    { version: "2", files: [{ ...blockMap(target).files[0], sizes: [-1] }] },
    { version: "2", files: [{ ...blockMap(target).files[0], sizes: Array(16).fill(1) }] },
  ];
  for (let index = 0; index < maps.length; index++) {
    f.requests.length = 0;
    const candidate = f.release(`4.0.${index}`, target, { map: maps[index] });
    assert.deepEqual(await readFile((await f.adapter.download(candidate, {}, { onProgress() {} })).file), target);
    assert.equal(f.requests.filter(item => item.range).length, 0);
  }
  f.requests.length = 0;
  const oversized = f.release("5.0.0", target);
  oversized.artifacts[0].blockMap.sizeBytes = MAX_BLOCK_MAP_BYTES + 1;
  await f.adapter.download(oversized, {}, { onProgress() {} });
  assert.equal(f.requests.filter(item => item.url.endsWith(".blockmap")).length, 0);
});

test("a release without block map clears the previous session and uses the full artifact", async t => {
  const f = await fixture(t);
  await f.seed();
  const candidate = f.release("4.0.0", target, { withMap: false });
  const downloaded = await f.adapter.download(candidate, {}, { onProgress() {} });
  assert.deepEqual(await readFile(downloaded.file), target);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].range, undefined);
});

test("real packaging blockmaps roundtrip through the real updater and save HTTPS transfer bytes", async t => {
  const f = await fixture(t);
  const original = createCipheriv("aes-256-ctr", Buffer.alloc(32, 7), Buffer.alloc(16)).update(Buffer.alloc(4 * 1024 * 1024));
  const changed = Buffer.from(original);
  changed.fill(99, 2 * 1024 * 1024, 2 * 1024 * 1024 + 4096);
  const originalFile = path.join(f.directory, "packaged-old.exe"), changedFile = path.join(f.directory, "packaged-new.exe");
  await writeFile(originalFile, original);
  await writeFile(changedFile, changed);
  const oldReport = await createClientBlockMap(originalFile);
  const newReport = await createClientBlockMap(changedFile);
  const oldMap = await readFile(oldReport.path), newMap = await readFile(newReport.path);
  assert.equal(JSON.parse(gunzipSync(newMap)).files[0].checksums[0].length, 24);
  await f.adapter.download(f.release("2.1.0", original, { rawMap: oldMap }), {}, { onProgress() {} });
  f.requests.length = 0;
  const downloaded = await f.adapter.download(f.release("3.1.0", changed, { rawMap: newMap }), {}, { onProgress() {} });
  assert.deepEqual(await readFile(downloaded.file), changed);
  assert.ok(f.requests.some(item => item.range));
  assert.ok(f.requests.reduce((sum, item) => sum + item.bytes, 0) < changed.length / 4);
  assert.equal(f.requests.filter(item => item.url === "/client-3.1.0.exe" && !item.range).length, 0);
});

test("MacUpdater download/cache workflow seeds update.zip and reuses a verified baseline", async t => {
  const f = await fixture(t, "darwin");
  await f.seed();
  const nativeCache = path.join(f.updater.downloadedUpdateHelper.cacheDir, "update.zip");
  assert.deepEqual(await readFile(nativeCache), base);
  const downloaded = await f.adapter.download(f.next, {}, { onProgress() {} });
  assert.deepEqual(await readFile(downloaded.file), target);
  assert.deepEqual(await readFile(nativeCache), target);
  assert.equal(f.requests.filter(item => item.range).length, 1);
});

test("bounded decompression rejects a signed gzip bomb while preserving full-download availability", async t => {
  const f = await fixture(t);
  await f.seed();
  const candidate = f.release("4.0.0", target, { rawMap: gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1, 32)) });
  const downloaded = await f.adapter.download(candidate, {}, { onProgress() {} });
  assert.deepEqual(await readFile(downloaded.file), target);
  assert.equal(f.requests.filter(item => item.range).length, 0);
});

test("HTTPS map and range redirects work and cross-origin credentials are removed", async t => {
  const f = await fixture(t);
  await f.seed();
  const received = [];
  const cdn = https.createServer({ key, cert: certificate }, (request, response) => {
    received.push(request.headers);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
    const chunk = target.subarray(Number(start), Number(end) + 1);
    response.writeHead(206, { "content-length": chunk.length,
      "content-range": `bytes ${start}-${end}/${target.length}` }).end(chunk);
  });
  await new Promise(resolve => cdn.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { cdn.closeAllConnections(); cdn.close(resolve); }));
  f.payloads.set("/redirected.blockmap", f.payloads.get("/client-3.0.0.exe.blockmap"));
  f.redirects.set("/client-3.0.0.exe.blockmap", "/redirected.blockmap");
  f.redirects.set("/client-3.0.0.exe", `https://127.0.0.1:${cdn.address().port}/client.exe`);
  f.updater.requestHeaders = { authorization: "Bearer fixture-secret", cookie: "fixture=secret" };
  const downloaded = await f.adapter.download(f.next, {}, { onProgress() {} });
  assert.deepEqual(await readFile(downloaded.file), target);
  assert.equal(received.length, 1);
  assert.equal(received[0].authorization, undefined);
  assert.equal(received[0].cookie, undefined);
  assert.ok(f.requests.some(item => item.url === "/redirected.blockmap"));
  assert.equal(f.requests.find(item => item.range).headers.authorization, "Bearer fixture-secret");
});
