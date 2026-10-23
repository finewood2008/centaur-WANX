// Loopback-only feed for isolated installer validation. Never an Admin replacement.
import https from "node:https";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { digestPayload } from "../updates/contracts.mjs";
import { TEST_EXTENSION, TEST_APP_ID, validTestRunId } from "../updates/test-build.mjs";

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
      } else if (["GET", "HEAD"].includes(request.method) && request.url === "/client-update.zip") {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        if (report.distributionClass !== "test-only" || report.build?.testRunId !== payload.testIsolation.testRunId ||
            report.updateArtifact?.sha256 !== payload.artifacts[0]?.sha256) throw new Error("TEST_ARTIFACT_MISMATCH");
        const file = report.updateArtifact.path;
        response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": (await stat(file)).size });
        if (request.method === "HEAD") response.end(); else createReadStream(file).pipe(response);
      } else { response.writeHead(404); response.end(); }
    } catch (error) {
      if (!response.headersSent) response.writeHead(error.code === "ENOENT" ? 503 : 400, { "Content-Type": "application/json" });
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
