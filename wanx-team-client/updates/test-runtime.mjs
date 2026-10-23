// This path is reachable only from an explicitly isolated, signed test build.
// It never sends account credentials or adds a CA to the operating system.
import https from "node:https";
import { X509Certificate } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { isTestClientIdentity } from "./test-build.mjs";
import { updateError } from "./contracts.mjs";

export function testFeedURL(value) {
  let url;
  try { url = new URL(value); } catch { throw updateError("UPDATE_TEST_CONFIGURATION_INVALID"); }
  if (url.protocol !== "https:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) throw updateError("UPDATE_TEST_CONFIGURATION_INVALID");
  return url;
}

export async function createTestUpdateRuntime({ identity, app, session, resourcesPath = process.resourcesPath }) {
  if (!isTestClientIdentity(identity)) return null;
  const pkg = JSON.parse(await readFile(path.join(app.getAppPath(), "package.json"), "utf8"));
  const url = testFeedURL(pkg.wanxBuild.testFeedURL);
  const ca = await readFile(path.join(resourcesPath, "wanx-test-ca.pem"), "utf8");
  const fingerprint = new X509Certificate(ca).fingerprint256;
  if (fingerprint !== pkg.wanxBuild.testCAFingerprint) throw updateError("UPDATE_TEST_CONFIGURATION_INVALID");
  session.fromPartition("electron-updater", { cache: false }).setCertificateVerifyProc((request, callback) => {
    let matches = false;
    try { matches = request.hostname === "127.0.0.1" && new X509Certificate(request.certificate.data).fingerprint256 === fingerprint; }
    catch { /* A malformed certificate must fall back to normal verification. */ }
    callback(matches ? 0 : -3);
  });
  return {
    captureSession: () => () => {},
    request(input) {
      if (input.method !== "POST" || input.path !== "/app-api/v1/upgrades/candidates")
        throw updateError("UPDATE_TEST_CONFIGURATION_INVALID");
      return new Promise((resolve, reject) => {
        const bytes = Buffer.from(JSON.stringify(input.body));
        const request = https.request(new URL(input.path, url), { method: "POST", ca,
          headers: { "Content-Type": "application/json", "Content-Length": bytes.length }, timeout: 15000 }, response => {
          const chunks = []; let size = 0;
          response.on("data", chunk => { size += chunk.length; if (size > 1024 * 1024) request.destroy(updateError("UPDATE_INVALID_RESPONSE")); else chunks.push(chunk); });
          response.on("error", reject);
          response.on("end", () => {
            try {
              if (response.statusCode !== 200) throw updateError("UPDATE_REQUEST_FAILED");
              resolve(JSON.parse(Buffer.concat(chunks)));
            } catch (error) { reject(error); }
          });
        });
        request.on("timeout", () => request.destroy(updateError("UPDATE_REQUEST_FAILED")));
        request.on("error", reject); request.end(bytes);
      });
    },
    async ready(clientUpdates, argv = process.argv) {
      const directory = path.join(app.getPath("userData"), "updates");
      await mkdir(directory, { recursive: true });
      let writes = Promise.resolve();
      const record = snapshot => {
        const contents = JSON.stringify({ recordedAt: new Date().toISOString(), ...snapshot }, null, 2);
        writes = writes.then(async () => {
          const target = path.join(directory, "test-integration-status.json");
          await writeFile(`${target}.tmp`, contents, { mode: 0o600 });
          await rename(`${target}.tmp`, target);
        });
        return writes;
      };
      await record(clientUpdates.snapshot());
      clientUpdates.subscribe(snapshot => { void record(snapshot); });
      // No automatic action during normal test-app use. The integration runner
      // must explicitly request this sequence for this isolated application.
      if (argv.includes("--wanx-test-update") && clientUpdates.snapshot().lastResult?.phase !== "succeeded") {
        await clientUpdates.check();
        if (clientUpdates.snapshot().phase === "available") {
          await clientUpdates.download();
          await clientUpdates.install({ confirmed: true });
        }
      }
    },
  };
}
