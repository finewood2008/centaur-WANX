import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Transform } from "node:stream";
import { gunzipSync } from "node:zlib";
import { MAX_BLOCK_MAP_BYTES, secureURL } from "./contracts.mjs";

const require = createRequire(import.meta.url);
const { CancellationError } = require("builder-util-runtime");
const { GenericDifferentialDownloader } = require("electron-updater/out/differentialDownloader/GenericDifferentialDownloader.js");
const MAX_MAP_JSON_BYTES = 64 * 1024 * 1024;
const MAX_BLOCKS = 1_000_000;
const quiet = { info() {}, warn() {}, error() {} };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const checkCancelled = token => { if (token.cancelled) throw new CancellationError(); };
const invalid = message => new Error(`Invalid differential update: ${message}`);

function parseBlockMap(bytes, description, artifactSize) {
  if (!positiveInteger(description?.sizeBytes) || description.sizeBytes > MAX_BLOCK_MAP_BYTES ||
      bytes.length !== description.sizeBytes || digest(bytes) !== description.sha256)
    throw invalid("block map digest or size");
  const map = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_MAP_JSON_BYTES }).toString("utf8"));
  if (map?.version !== "2" || !Array.isArray(map.files) || map.files.length !== 1)
    throw invalid("block map version or files");
  const file = map.files[0];
  if (file?.name !== "file" || file.offset !== 0 || !Array.isArray(file.sizes) ||
      !Array.isArray(file.checksums) || file.sizes.length === 0 || file.sizes.length > MAX_BLOCKS ||
      file.sizes.length !== file.checksums.length) throw invalid("block map structure");
  let size = 0;
  for (let i = 0; i < file.sizes.length; i++) {
    if (!positiveInteger(file.sizes[i]) || typeof file.checksums[i] !== "string" ||
        !/^[A-Za-z0-9+/]{8,128}={0,2}$/.test(file.checksums[i])) throw invalid("block map block");
    size += file.sizes[i];
    if (!Number.isSafeInteger(size) || size > artifactSize) throw invalid("block map extent");
  }
  if (size !== artifactSize) throw invalid("block map total size");
  return map;
}

function header(response, name) {
  const value = response.headers?.[name];
  return Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
}

// electron-updater's single-range downloader accepts HTTP 200 and unchecked
// Content-Range. Keep its reconstruction engine, but put a bounded, cancellable
// transport in front of every response it consumes.
function guardedExecutor(executor, { cancellationToken, artifactSize, mapSize }) {
  const active = new Set();
  const transport = {
    createRequest(options, onResponse) {
      const request = new EventEmitter();
      let inner, response, body, timer, finished = false, redirects = 0;
      let currentURL = secureURL(`${options.protocol}//${options.hostname}${options.port ? `:${options.port}` : ""}${options.path}`);
      let headers = { ...options.headers, "accept-encoding": "identity" };
      const range = headers.range ?? headers.Range;
      let expectedBytes = mapSize;
      let expectedRange;
      if (mapSize === undefined) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range || "");
        const start = Number(match?.[1]), end = Number(match?.[2]);
        if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            start < 0 || end < start || end >= artifactSize) throw invalid("requested range");
        expectedBytes = end - start + 1;
        expectedRange = `bytes ${start}-${end}/${artifactSize}`;
      }
      const cleanup = () => {
        clearTimeout(timer);
        cancellationToken.removeListener("cancel", cancel);
        active.delete(request);
      };
      const fail = error => {
        if (finished) return;
        finished = true;
        cleanup();
        response?.unpipe(body);
        body?.destroy(error);
        response?.destroy?.();
        inner?.abort();
        request.emit("error", error);
      };
      const cancel = () => fail(new CancellationError());
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(new Error("Differential update request timed out")), 60_000);
        timer.unref?.();
      };
      const redirect = location => {
        if (finished) return;
        try {
          const next = secureURL(new URL(location, currentURL).href);
          if (++redirects > 10) throw invalid("too many redirects");
          if (next.origin !== currentURL.origin) {
            headers = Object.fromEntries(Object.entries(headers).filter(([key]) =>
              !["authorization", "cookie", "host"].includes(key.toLowerCase())));
          }
          currentURL = next;
          const previous = inner;
          inner = null;
          previous?.abort();
          response?.destroy?.();
          response = null;
          start();
        } catch (error) { fail(error); }
      };
      const start = () => {
        if (finished) return;
        try {
          checkCancelled(cancellationToken);
          touch();
          const created = executor.createRequest({ ...options, protocol: currentURL.protocol,
            hostname: currentURL.hostname, port: currentURL.port || undefined,
            path: currentURL.pathname + currentURL.search, headers, redirect: "manual" }, incoming => {
            if (finished || inner !== created) { incoming.destroy?.(); return; }
            response = incoming;
            if ([301, 302, 303, 307, 308].includes(incoming.statusCode)) {
              const location = header(incoming, "location");
              if (location) redirect(location); else fail(invalid("redirect without location"));
              return;
            }
            const length = header(incoming, "content-length");
            const encoding = header(incoming, "content-encoding");
            if (incoming.statusCode !== (mapSize === undefined ? 206 : 200) ||
                expectedRange && header(incoming, "content-range") !== expectedRange ||
                length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) !== expectedBytes) ||
                encoding && encoding !== "identity") {
              fail(invalid("response status, range, length or encoding"));
              return;
            }
            let received = 0;
            body = new Transform({
              transform(chunk, _encoding, callback) {
                received += chunk.length;
                if (received > expectedBytes) callback(invalid("response exceeds declared size"));
                else { touch(); callback(null, chunk); }
              },
              flush(callback) { callback(received === expectedBytes ? null : invalid("truncated response")); },
            });
            body.statusCode = incoming.statusCode;
            body.headers = incoming.headers;
            body.on("error", fail);
            body.once("end", () => { if (!finished) { finished = true; cleanup(); } });
            incoming.on("error", fail);
            incoming.on("aborted", () => fail(invalid("aborted response")));
            onResponse(body);
            incoming.pipe(body);
          });
          inner = created;
          created.on("error", error => { if (inner === created) fail(error); });
          created.on("aborted", () => { if (inner === created) fail(invalid("aborted request")); });
          created.on("redirect", (_status, _method, location) => { if (inner === created) redirect(location); });
          created.end();
        } catch (error) { fail(error); }
      };
      request.end = () => {
        active.add(request);
        cancellationToken.onCancel(cancel);
        start();
      };
      request.abort = () => fail(new CancellationError());
      return request;
    },
    addErrorAndTimeoutHandlers(request, reject) { request.on("error", reject); },
    dispose() { for (const request of [...active]) request.abort(); },
  };
  return transport;
}

async function fetchBlockMap(url, description, options) {
  const transport = guardedExecutor(options.httpExecutor, { ...options, mapSize: description.sizeBytes });
  try {
    return await new Promise((resolve, reject) => {
      const request = transport.createRequest({ protocol: url.protocol, hostname: url.hostname,
        port: url.port || undefined, path: url.pathname + url.search,
        headers: options.requestHeaders }, response => {
        const chunks = [];
        response.on("error", reject);
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
      });
      transport.addErrorAndTimeoutHandlers(request, reject);
      request.end();
    });
  } finally { transport.dispose(); }
}

async function verifyFile(file, artifact, token) {
  checkCancelled(token);
  const info = await lstat(file);
  if (!info.isFile() || info.size !== artifact.sizeBytes) throw invalid("cached artifact size");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) { checkCancelled(token); hash.update(chunk); }
  if (hash.digest("hex") !== artifact.sha256) throw invalid("cached artifact digest");
}

async function boundedFile(file, limit) {
  const info = await lstat(file);
  if (!info.isFile() || info.size > limit) throw invalid("cached metadata size");
  return readFile(file);
}

const validDirectory = value => typeof value === "string" && /^base-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** The release signature is verified by the caller before prepare(). A map is
 * optional: malformed/unavailable maps and missing bases only disable delta.
 * Call promote() only after the complete artifact and OS signature checks. */
export function createDifferentialDownload({ configurationPath }) {
  const cacheDirectory = path.join(path.dirname(configurationPath), "differential-cache");
  const manifestPath = path.join(cacheDirectory, "current.json");
  let prepared = null;
  return {
    async prepare({ artifact, blockMapURL, httpExecutor, cancellationToken, requestHeaders, logger = quiet }) {
      prepared = null;
      checkCancelled(cancellationToken);
      if (!artifact.blockMap) return false;
      try {
        const description = { ...artifact.blockMap };
        if (!positiveInteger(description.sizeBytes) || description.sizeBytes > MAX_BLOCK_MAP_BYTES ||
            !/^[a-f0-9]{64}$/.test(description.sha256)) throw invalid("block map metadata");
        const bytes = await fetchBlockMap(secureURL(blockMapURL || description.url), description,
          { httpExecutor, cancellationToken, requestHeaders });
        const map = parseBlockMap(bytes, description, artifact.sizeBytes);
        checkCancelled(cancellationToken);
        prepared = { artifact: { sizeBytes: artifact.sizeBytes, sha256: artifact.sha256, sha512: artifact.sha512 },
          description, bytes, map, cancellationToken, logger };
        return true;
      } catch (error) {
        checkCancelled(cancellationToken);
        logger.warn(`Differential map unavailable; using full download: ${error.message}`);
        return false;
      }
    },
    async download({ fileInfo, downloadUpdateOptions, installerPath, httpExecutor, logger = quiet, onProgress }) {
      const token = downloadUpdateOptions.cancellationToken;
      checkCancelled(token);
      if (!prepared) return true;
      let transport;
      try {
        if (fileInfo.info.sha512 !== prepared.artifact.sha512 || fileInfo.info.size !== prepared.artifact.sizeBytes)
          throw invalid("target changed");
        const manifest = JSON.parse((await boundedFile(manifestPath, 4096)).toString("utf8"));
        if (manifest.schemaVersion !== 1 || !validDirectory(manifest.directory) ||
            !positiveInteger(manifest.artifact?.sizeBytes) || !/^[a-f0-9]{64}$/.test(manifest.artifact?.sha256))
          throw invalid("baseline manifest");
        const oldFile = path.join(cacheDirectory, manifest.directory, "artifact");
        await verifyFile(oldFile, manifest.artifact, token);
        const oldMapBytes = await boundedFile(path.join(cacheDirectory, manifest.directory, "artifact.blockmap"), MAX_BLOCK_MAP_BYTES);
        const oldMap = parseBlockMap(oldMapBytes, manifest.blockMap, manifest.artifact.sizeBytes);
        checkCancelled(token);
        transport = guardedExecutor(httpExecutor, { cancellationToken: token, artifactSize: prepared.artifact.sizeBytes });
        await new GenericDifferentialDownloader(fileInfo.info, transport, {
          newUrl: secureURL(fileInfo.url), oldFile, newFile: installerPath,
          isUseMultipleRangeRequest: false, requestHeaders: downloadUpdateOptions.requestHeaders,
          cancellationToken: token, logger, onProgress: onProgress || (() => {}),
        }).download(oldMap, prepared.map);
        checkCancelled(token);
        return false;
      } catch (error) {
        checkCancelled(token);
        logger.warn(`Differential download unavailable; using full download: ${error.message}`);
        return true;
      } finally { transport?.dispose(); }
    },
    async promote(file) {
      if (!prepared) return false;
      const { artifact, description, bytes, cancellationToken, logger } = prepared;
      let directory, pointer;
      try {
        checkCancelled(cancellationToken);
        await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
        const name = `base-${randomUUID()}`;
        directory = path.join(cacheDirectory, name);
        await mkdir(directory, { mode: 0o700 });
        await copyFile(file, path.join(directory, "artifact"));
        await verifyFile(path.join(directory, "artifact"), artifact, cancellationToken);
        await writeFile(path.join(directory, "artifact.blockmap"), bytes, { mode: 0o600 });
        let previous;
        try { previous = JSON.parse((await boundedFile(manifestPath, 4096)).toString("utf8")).directory; } catch {}
        pointer = path.join(cacheDirectory, `current-${randomUUID()}.json`);
        await writeFile(pointer, JSON.stringify({ schemaVersion: 1, directory: name, artifact,
          blockMap: { sizeBytes: description.sizeBytes, sha256: description.sha256 } }), { mode: 0o600 });
        checkCancelled(cancellationToken);
        await rename(pointer, manifestPath);
        directory = null;
        if (validDirectory(previous) && previous !== name)
          await rm(path.join(cacheDirectory, previous), { recursive: true, force: true });
        return true;
      } catch (error) {
        checkCancelled(cancellationToken);
        logger.warn(`Differential baseline unavailable for the next update: ${error.message}`);
        return false;
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
        if (pointer) await rm(pointer, { force: true }).catch(() => {});
      }
    },
  };
}
