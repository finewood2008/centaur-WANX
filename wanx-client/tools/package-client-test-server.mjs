// Loopback-only feed for isolated installer validation. Never an Admin replacement.
import https from "node:https";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { digestPayload, MAX_BLOCK_MAP_BYTES } from "../updates/contracts.mjs";
import { TEST_EXTENSION, TEST_APP_ID, validTestRunId } from "../updates/test-build.mjs";

function byteRange(header, size) {
  if (typeof header !== "string") return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !match[1] && !match[2]) return null;
  const first = Number(match[1]), last = Number(match[2]);
  if (![first, last].every(Number.isSafeInteger)) return null;
  const start = match[1] ? first : Math.max(0, size - last);
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  return start <= end && start < size && (match[1] || last > 0) ? { start, end } : null;
}

function matchingArtifact(report, payload) {
  const artifact = report.updateArtifact, signed = payload.artifacts?.[0];
  if (report.distributionClass !== "test-only" || report.build?.testRunId !== payload.testIsolation.testRunId ||
      !artifact || !signed || typeof artifact.path !== "string" ||
      !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0 ||
      artifact.sizeBytes !== signed.sizeBytes || artifact.sha256 !== signed.sha256 || artifact.sha512 !== signed.sha512)
    throw new Error("TEST_ARTIFACT_MISMATCH");
  const map = artifact.blockMap, signedMap = signed.blockMap;
  if (Object.hasOwn(artifact, "blockMap") || Object.hasOwn(signed, "blockMap")) {
    if (!map || !signedMap || typeof map.path !== "string" ||
        !Number.isSafeInteger(map.sizeBytes) || map.sizeBytes <= 0 || map.sizeBytes > MAX_BLOCK_MAP_BYTES ||
        map.sizeBytes !== signedMap.sizeBytes || !/^[a-f0-9]{64}$/.test(map.sha256) || map.sha256 !== signedMap.sha256)
      throw new Error("TEST_ARTIFACT_MISMATCH");
  }
  return artifact;
}

export async function startTestFeed({ keyPath, certificatePath, reportPath, releasePath, port = 0, readyPath }) {
  const server = https.createServer({ key: await readFile(keyPath), cert: await readFile(certificatePath) }, async (request, response) => {
    try {
      const release = JSON.parse(await readFile(releasePath, "utf8"));
      const payload = release.payload;
      if (payload?.product !== "wanx-client" || payload.requiredExtensions?.length !== 1 ||
          payload.requiredExtensions[0] !== TEST_EXTENSION || payload.testIsolation?.applicationId !== TEST_APP_ID ||
          !validTestRunId(payload.testIsolation?.testRunId) || payload.channel !== `test-client-${payload.testIsolation.testRunId}`)
        throw new Error("TEST_RELEASE_REQUIRED");
      if (request.method === "POST" && request.url === "/app-api/v1/upgrades/candidates") {
        const chunks = []; let length = 0;
        for await (const chunk of request) { length += chunk.length; if (length > 65536) throw new Error("INPUT_TOO_LARGE"); chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks));
        if (input.product !== "wanx-client" || input.channel !== payload.channel || input.platform?.os !== payload.platform.os ||
            input.platform?.arch !== payload.platform.arch || input.releaseId && input.releaseId !== payload.releaseId)
          throw new Error("TEST_SCOPE_MISMATCH");
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ status: input.currentVersion === payload.version ? "current" : "available",
          release, releaseDigest: digestPayload(payload), downloadUrls: {} }));
      } else if (["GET", "HEAD"].includes(request.method) && ["/client-update.zip", "/client-update.zip.blockmap"].includes(request.url)) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        const artifact = matchingArtifact(report, payload);
        if (request.url.endsWith(".blockmap")) {
          if (!artifact.blockMap) { response.writeHead(404); response.end(); return; }
          const map = artifact.blockMap;
          if ((await stat(map.path)).size !== map.sizeBytes) throw new Error("TEST_ARTIFACT_MISMATCH");
          const bytes = await readFile(map.path);
          if (bytes.length !== map.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== map.sha256)
            throw new Error("TEST_ARTIFACT_MISMATCH");
          // Blockmap hashes cover the gzip bytes, so never set Content-Encoding.
          response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length, "Cache-Control": "no-store" });
          response.end(request.method === "HEAD" ? undefined : bytes);
          return;
        }
        const file = artifact.path, size = (await stat(file)).size;
        if (size !== artifact.sizeBytes) throw new Error("TEST_ARTIFACT_MISMATCH");
        // HTTP Range applies only to GET. HEAD describes the full representation.
        const range = request.method === "GET" && request.headers.range !== undefined
          ? byteRange(request.headers.range, size) : undefined;
        if (range === null) {
          response.writeHead(416, { "Content-Range": `bytes */${size}`, "Content-Length": 0 }); response.end(); return;
        }
        response.writeHead(range ? 206 : 200, { "Content-Type": "application/zip", "Accept-Ranges": "bytes",
          "Content-Length": range ? range.end - range.start + 1 : size, "Cache-Control": "no-store",
          ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}) });
        if (request.method === "HEAD") response.end();
        else await pipeline(createReadStream(file, range), response);
      } else { response.writeHead(404); response.end(); }
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(error.code === "ENOENT" ? 503 : 400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "TEST_FEED_NOT_READY" }));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const url = `https://127.0.0.1:${server.address().port}/`;
  if (readyPath) await writeFile(readyPath, JSON.stringify({ url }) + "\n", { mode: 0o600 });
  return { server, url };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: Object.fromEntries(["key", "certificate", "report", "release", "port", "ready"].map(key => [key, { type: "string" }])) });
  const { server, url } = await startTestFeed({ keyPath: values.key, certificatePath: values.certificate,
    reportPath: values.report, releasePath: values.release, port: Number(values.port || 0), readyPath: values.ready });
  console.log(JSON.stringify({ testOnly: true, url }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit()));
}
