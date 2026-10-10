import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCentaurAIWanxClient, createHTTPTransport, createNativeHTTPTransport, operationRegistry } from "../dist/index.js";
import { generateWanxApplicationProject } from "../dist/project-generator.js";
import { bindCentaurAIWanxElectron } from "../dist/electron-main.js";
import { createCentaurAIWanxApp } from "../dist/renderer.js";

const product = { application_id: "demo.product", name: "示例产品", description: "SDK 集成验收", capabilities: ["memory"], agent_template: {}, resource_requirements: {} };
const deployment = { enabled: true, resource_bindings: {}, configuration: {} };
const manifest = { schema_version: 1, product, deployment };
const release = { version: "1.0.0", platform: "macos", arch: "arm64", url: "https://downloads.example.invalid/demo.zip", sha256: "a".repeat(64), min_wanx_version: "1.0.0", min_sdk_version: "0.1.0-alpha.2", recommended: false };
const operations = operationRegistry.filter(row => row.tags.includes("applications"));
const policy = { applicationId: "demo.product", operations: operations.map(row => row.operationId), sockets: [] };
async function fixture() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const buffers = []; for await (const chunk of request) buffers.push(chunk);
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: Buffer.concat(buffers).toString() });
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ native: true, application_id: product.application_id }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { requests, baseURL: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function exercise(client) {
  const api = client.applications;
  await api.list(); await api.create(product); await api.get(product.application_id); await api.update(product.application_id, { name: "更新产品" });
  await api.getDeployment(product.application_id); await api.putDeployment(product.application_id, deployment);
  await api.listReleases(product.application_id); await api.createRelease(product.application_id, release);
  await api.recommendRelease(product.application_id, release.version, { platform: release.platform, arch: release.arch });
  await api.listAccess(product.application_id); await api.putAccess(product.application_id, { user_id: 12, enabled: false });
  await api.getManifest(product.application_id); await api.compatibleRelease(product.application_id, { platform: "windows", arch: "x64", current_version: "0.1.0", sdk_version: "0.1.0-alpha.2" });
  await api.getProfile(product.application_id); await api.createProfile(product.application_id);
}

test("all 15 management protocol operations execute through the JS and Go policy catalogs", async () => {
  const f = await fixture();
  try {
    assert.equal(operations.length, 15);
    for (const native of [false, true]) {
      const transport = native ? await createNativeHTTPTransport({ baseURL: f.baseURL, token: "private-test", policy }) : createHTTPTransport({ baseURL: f.baseURL, token: async () => "private-test" });
      const client = createCentaurAIWanxClient({ transport, policy });
      try { await exercise(client); } finally { await client.close(); }
    }
    assert.equal(f.requests.length, 30);
    assert.ok(f.requests.every(request => request.authorization === "Bearer private-test"));
    assert.deepEqual(JSON.parse(f.requests[1].body), product);
    assert.equal(f.requests[12].path, "/api/applications/demo.product/release?platform=windows&arch=x64&current_version=0.1.0&sdk_version=0.1.0-alpha.2");
    const restricted = createCentaurAIWanxClient({ transport: createHTTPTransport({ baseURL: f.baseURL }), policy: { ...policy, operations: [] } });
    await assert.rejects(restricted.applications.list(), { code: "OPERATION_NOT_ALLOWED" }); await restricted.close();
  } finally { await f.close(); }
});

test("renderer management facade passes immutable main policy and keeps credential issuing routes host-only", async () => {
  const f = await fixture(); let handler;
  const host = { auth: {}, devices: {}, connection: { connect: async () => createCentaurAIWanxClient({ transport: createHTTPTransport({ baseURL: f.baseURL, token: async () => "hidden" }), policy }), disconnect: async () => {} }, dispose: async () => {} };
  const dispose = bindCentaurAIWanxElectron({ ipcMain: { handle(_channel, callback) { handler = callback; }, removeHandler() {} }, webContentsId: 4, documentURL: "file:///admin/index.html", host });
  const event = { sender: { id: 4 }, senderFrame: { url: "file:///admin/index.html", parent: null } };
  try {
    const app = createCentaurAIWanxApp({ bridge: { call: (method, params) => handler(event, { method, params }) }, policy });
    const client = await app.connection.connect({ deviceId: "synthetic-box" }); await exercise(client);
    assert.equal(f.requests.length, 15); assert.equal("native" in client, false);
    const injected = await handler(event, { method: "http.open", params: { request: { method: "GET", path: "/api/admin/applications?as_user=12", headers: {} } } });
    assert.equal(injected.code, "PUBLIC_CREDENTIAL_OVERRIDE"); await app.dispose();
  } finally { await dispose(); await f.close(); }
});

test("generator uses a local SDK package, no credentials, and refuses secrets or overwrites", async () => {
  const parent = await mkdtemp(join(tmpdir(), "wanx-project-generator-"));
  try {
    const tarball = join(parent, "sdk.tgz"); await writeFile(tarball, "synthetic-package");
    const directory = join(parent, "product"); const output = await generateWanxApplicationProject({ directory, manifest, sdkTarball: tarball });
    assert.ok(output.files.includes("electron/main.ts"));
    assert.equal(JSON.parse(await readFile(join(directory, "package.json"))).dependencies["centaurai-wanx"], "file:vendor/centaurai-wanx.tgz");
    assert.deepEqual(JSON.parse(await readFile(join(directory, "application.manifest.json"))), manifest);
    const main = await readFile(join(directory, "electron/main.ts"), "utf8");
    assert.ok(main.includes("application_id: applicationId")); assert.ok(main.includes("contextIsolation: true")); assert.ok(main.includes("APPLICATION_CONTRACT_NOT_SUPPORTED"));
    await assert.rejects(generateWanxApplicationProject({ directory, manifest, sdkTarball: tarball }), { code: "PROJECT_DIRECTORY_NOT_EMPTY" });
    await assert.rejects(generateWanxApplicationProject({ directory: join(parent, "secret"), sdkTarball: tarball, manifest: { ...manifest, deployment: { ...deployment, configuration: { apiKey: "never-export" } } } }), { code: "MANIFEST_CONTAINS_SECRETS" });
  } finally { await rm(parent, { recursive: true, force: true }); }
});
