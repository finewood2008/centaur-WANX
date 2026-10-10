import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { createCentaurAIWanxClient, createHTTPTransport, createNativeHTTPTransport, operationRegistry, moduleRegistry, parseSSE } from "../dist/index.js";

const policy = { applicationId: "omnia-desktop", operations: operationRegistry.map(o => o.operationId), sockets: ["chat", "notifications", "terminal", "browser-stream", "desktop-stream", "mobile-stream", "mobile-adb-shell"], agents: ["agent-1"] };
async function fixture() {
  const received = [];
  const server = createServer(async (req, res) => {
    const buffers = []; for await (const chunk of req) buffers.push(chunk);
    const body = Buffer.concat(buffers);
    received.push({ method: req.method, path: req.url, headers: req.headers, body });
    if (req.headers.accept === "text/event-stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const bytes = Buffer.from("id: native-cursor\nevent: delta\ndata: 知君\n\n");
      for (const byte of bytes) res.write(Buffer.from([byte])); res.end(); return;
    }
    res.writeHead(req.url.includes("/candidates/reject") ? 403 : 200, { "content-type": "application/json", "set-cookie": "private-session=hidden" });
    res.end(JSON.stringify({ native: true, method: req.method, path: req.url }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  return { server, baseURL, received, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test("all 457 baseline and 15 management and 9 brainstorm bindings call an HTTP server", async () => {
  const f = await fixture(); const client = createCentaurAIWanxClient({ transport: createHTTPTransport({ baseURL: f.baseURL, token: async () => "host-token" }), policy });
  try {
    assert.equal(Object.keys(moduleRegistry).length, 44);
    for (const op of operationRegistry) {
      const input = { path: Object.fromEntries(op.parameters.filter(p => p.in === "path").map(p => [p.name, p.name === "agent_id" ? "agent-1" : "resource-1"])), query: Object.fromEntries(op.parameters.filter(p => p.in === "query" && p.required).map(p => [p.name, p.schema.type === "integer" ? 1 : "value"])) };
      if (op.bodyRequired) input.body = op.contentTypes.includes("multipart/form-data") ? new FormData() : {};
      const module = Object.entries(moduleRegistry).find(([, methods]) => Object.values(methods).includes(op.operationId))[0];
      const response = await client.modules[module][op.alias](input);
      assert.equal(response.status, 200);
      if (op.stream === "sse") assert.ok(response.body.includes("知君"));
      else { assert.equal(response.body.native, true); assert.equal(response.body.method, op.method); }
      assert.equal(Object.keys(response.headers).some(k => k.toLowerCase() === "set-cookie"), false);
    }
    assert.equal(f.received.length, 481);
    assert.ok(f.received.every(r => r.headers.authorization === "Bearer host-token"));
  } finally { await client.close(); await f.close(); }
});

test("memory remains agent-bound, raw server failures are preserved, writes are never replayed", async () => {
  const f = await fixture(); const client = createCentaurAIWanxClient({ transport: createHTTPTransport({ baseURL: f.baseURL }), policy });
  try {
    const memory = client.agents.use("agent-1").memory;
    await memory.getAtom({ path: { atom_id: "atom:1" } });
    assert.equal(f.received[0].path, "/api/agents/agent-1/memory/atoms/atom%3A1");
    const rejected = await memory.rejectCandidate({ path: { candidate_id: "reject" } });
    assert.equal(rejected.status, 403); assert.equal(f.received.length, 2);
    await assert.rejects(memory.getAtom({ path: { agent_id: "another", atom_id: "1" } }), { code: "BOUND_AGENT_OVERRIDE" });
    await assert.rejects(memory.listAtoms({ header: { authorization: "Bearer injected" } }), { code: "PUBLIC_CREDENTIAL_OVERRIDE" });
    assert.throws(() => client.agents.use("another"), { code: "AGENT_NOT_ALLOWED" });
    await assert.rejects(memory.getAtom({ path: { atom_id: "../private" } }), { code: "INVALID_PATH_PARAMETER" });
    await client.close(); await assert.rejects(memory.listAtoms({ body: {} }), { code: "SESSION_CLOSED" });
  } finally { await client.close(); await f.close(); }
});

test("multipart keeps file name, bytes and field values", async () => {
  const f = await fixture(); const client = createCentaurAIWanxClient({ transport: createHTTPTransport({ baseURL: f.baseURL }), policy });
  try {
    const form = new FormData(); form.append("file", new Blob([new Uint8Array([0, 255, 7])]), "native-memory.hmpkg"); form.append("force", "false");
    await client.agents.use("agent-1").memory.adoptPortable({ body: form });
    const got = await new Response(f.received[0].body, { headers: { "content-type": f.received[0].headers["content-type"] } }).formData();
    assert.equal(got.get("file").name, "native-memory.hmpkg"); assert.deepEqual([...new Uint8Array(await got.get("file").arrayBuffer())], [0, 255, 7]); assert.equal(got.get("force"), "false");
  } finally { await client.close(); await f.close(); }
});

test("SSE handles UTF-8, CRLF, id, comments, multiple data lines and partial EOF", async () => {
  const bytes = Buffer.from("\uFEFF: comment\r\nid: cursor\r\nevent: delta\r\nretry: 1000\r\ndata: 你好\r\ndata: second\r\n\r\ndata: unfinished");
  const chunks = (async function* () { for (const byte of bytes) yield new Uint8Array([byte]); })();
  const events = []; for await (const e of parseSSE(chunks)) events.push(e);
  assert.deepEqual(events, [{ event: "delta", data: "你好\nsecond", id: "cursor", retry: 1000 }]);
});

test("all seven WebSocket endpoints authenticate, preserve text and binary and close", async () => {
  const f = await fixture(); const sockets = new WebSocketServer({ server: f.server }); const paths = [];
  sockets.on("connection", (socket, req) => { paths.push(req.url); socket.on("message", (data, binary) => socket.send(data, { binary })); });
  const client = createCentaurAIWanxClient({ transport: createHTTPTransport({ baseURL: f.baseURL, token: async () => "host-only" }), policy });
  try {
    for (const endpoint of policy.sockets) {
      const socket = await client.openSocket({ endpoint, ...(["chat", "terminal"].includes(endpoint) ? { agentId: "agent-1" } : {}) });
      const frames = socket.frames[Symbol.asyncIterator]();
      await socket.send({ kind: "text", text: "中文" }); assert.deepEqual((await frames.next()).value, { kind: "text", text: "中文" });
      await socket.send({ kind: "binary", bytes: new Uint8Array([0, 255]) }); assert.deepEqual([...(await frames.next()).value.bytes], [0, 255]);
      await socket.close(); await frames.return();
    }
    assert.equal(paths.length, 7); assert.ok(paths.every(p => new URL(p, f.baseURL).searchParams.get("token") === "host-only"));
  } finally { await client.close(); for (const ws of sockets.clients) ws.terminate(); await new Promise(resolve => sockets.close(resolve)); await f.close(); }
});

test("Go native process executes memory HTTP and blocks application or agent escape", async () => {
  const f = await fixture(); const transport = await createNativeHTTPTransport({ baseURL: f.baseURL, token: "native-private", policy });
  const client = createCentaurAIWanxClient({ transport, policy });
  try {
    await client.agents.use("agent-1").memory.listAtoms({ body: { limit: 20 } });
    assert.equal(f.received[0].headers.authorization, "Bearer native-private");
    assert.deepEqual(JSON.parse(f.received[0].body), { limit: 20 });
    await assert.rejects(transport.request({ method: "GET", path: "/api/agents/another/memory/atoms/a", headers: {} }), { code: "AGENT_NOT_ALLOWED" });
    await assert.rejects(transport.request({ method: "GET", path: "/api/internal/private", headers: {} }), { code: "UNKNOWN_OPERATION" });
    await assert.rejects(client.modules.voice.transcribeAudio({ body: { file: new Uint8Array(2 * 1024 * 1024 + 1) } }), { code: "REQUEST_BODY_TOO_LARGE" });
  } finally { await client.close(); await f.close(); }
});
