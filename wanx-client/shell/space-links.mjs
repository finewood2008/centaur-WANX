import { createAgentSpaces } from "./agent-spaces.mjs";
import http from "node:http";
import { randomBytes } from "node:crypto";

const PREFIX = "/api/personal-space";
const MAX_BODY = 6 * 1024 * 1024;
const READS = new Set(["describe", "stat", "list", "read", "write-status"]);
const ACTIONS = new Set([...READS, "mkdir", "move", "trash", "restore", "restore-version", "begin-write", "write-chunk", "commit-write", "cancel-write"]);
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const json = (res, status, value) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }); res.end(JSON.stringify(value)); };
const uuid = value => { if (!/^[a-f0-9]{32}$/.test(value || "")) throw fail("SPACE_INVALID_ID", 400); return value; };

// This loopback service never accepts a backend URL/account/box from a caller.
// Credentials and scope are retrieved exclusively from the encrypted store.
export async function createSpaceLinkBridge({ client, store, serviceURL, onChanged = () => {}, mcpConfig = {}, profileDirectory }) {
  const saved = await store.load();
  if (saved && (saved.version !== 1 || !Array.isArray(saved.links) || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535))
    throw fail("SPACE_LINK_STORE_INVALID");
  const state = saved || { version: 1, port: 0, links: [] };
  let server, closed = false, generation = 0, writes = Promise.resolve();
  const controllers = new Set();
  const scope = () => {
    const s = client.snapshot();
    return s.account?.phase === "authenticated" && s.phase === "ready" && s.connection?.deviceId
      ? JSON.stringify([serviceURL, s.account.accountId, s.connection.deviceId]) : null;
  };
  let previousScope = scope();
  const unsubscribe = client.subscribe(() => {
    if (scope() === previousScope) return;
    previousScope = scope(); generation++;
    for (const controller of controllers) controller.abort();
  });
  const persist = () => { const copy = structuredClone(state); writes = writes.catch(() => {}).then(() => store.save(copy)); return writes; };
  const url = record => `http://127.0.0.1:${state.port}/space-links/${record.key}`;
  function assertScope(bound) {
    if (closed || !scope()) throw fail("BOX_CONNECTION_REQUIRED", 503);
    if (bound !== scope()) throw fail("SPACE_CONTEXT_CHANGED", 409);
  }
  async function remote(bound, route, { method = "GET", body, token } = {}) {
    assertScope(bound);
    const epoch = generation, connection = await client.applicationConnection();
    assertScope(bound);
    const controller = new AbortController(); controllers.add(controller);
    try {
      const response = await connection.request({
        path: PREFIX + route, method, headers: { "content-type": "application/json", ...(token ? { "x-space-link": token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
      });
      assertScope(bound); connection.context();
      if (epoch !== generation) throw fail("SPACE_CONTEXT_CHANGED");
      const bytes = Buffer.from(response.body || "");
      let value;
      try { value = JSON.parse(bytes.toString()); } catch {}
      if (response.status < 200 || response.status >= 300)
        throw fail(value?.detail?.code || (response.status === 404 ? "SPACE_LINK_UPGRADE_REQUIRED" : "SPACE_REQUEST_FAILED"), response.status);
      return { value, bytes, headers: response.headers || {}, status: response.status };
    } finally { controllers.delete(controller); }
  }
  async function access(record, input) {
    if (record.revoked) throw fail("SPACE_LINK_REVOKED", 403);
    if (!ACTIONS.has(input.action)) throw fail("SPACE_ACTION_INVALID", 400);
    const response = await remote(record.scope, "/agent-access", { method: "POST", body: input, token: record.token });
    if (!READS.has(input.action)) onChanged();
    return response;
  }
  const agents = createAgentSpaces({state,scope,assertScope,remote,persist,onChanged,mcpConfig,profileDirectory});
  async function handle(req, res) {
    try {
      if (req.headers.host !== `127.0.0.1:${state.port}` || (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${state.port}`))
        throw fail("SPACE_LINK_ORIGIN_DENIED", 403);
      const parsed = new URL(req.url, "http://127.0.0.1");
      const match = /^\/space-links\/([A-Za-z0-9_-]{43})$/.exec(parsed.pathname);
      const record = match && state.links.find(r => r.key === match[1]);
      const agentMatch = /^\/space-agents\/([A-Za-z0-9_-]{43})$/.exec(parsed.pathname);
      const enroll = parsed.pathname === "/space-agents/enroll";
      if (!record && !agentMatch && !enroll) throw fail("SPACE_LINK_NOT_FOUND", 404);
      let input;
      if (req.method === "GET") {
        const allowed = new Set(["action", "target", "offset", "length", "expected", "upload_id"]);
        if ([...parsed.searchParams.keys()].some(k => !allowed.has(k))) throw fail("SPACE_ACTION_INVALID", 400);
        input = Object.fromEntries(parsed.searchParams);
        input.action ||= "describe";
        if (!READS.has(input.action) && !(agentMatch && ["access", "connection-status"].includes(input.action))) throw fail("SPACE_METHOD_NOT_ALLOWED", 405);
        for (const key of ["offset", "length", "expected"]) if (input[key] !== undefined) input[key] = Number(input[key]);
      } else if (req.method === "POST") {
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw fail("SPACE_JSON_REQUIRED", 415);
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw fail("SPACE_REQUEST_TOO_LARGE", 413); chunks.push(chunk); }
        try { input = JSON.parse(Buffer.concat(chunks)); } catch { throw fail("SPACE_INVALID_JSON", 400); }
        if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("SPACE_INVALID_JSON", 400);
      } else throw fail("SPACE_METHOD_NOT_ALLOWED", 405);
      if (enroll) {
        if (req.method !== "POST") throw fail("SPACE_METHOD_NOT_ALLOWED",405);
        return json(res,200,await agents.enroll(input));
      }
      const response = agentMatch ? await agents.access(agentMatch[1],input) : await access(record, input);
      if (input.action === "read") {
        res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff",
          "x-content-sha256": response.headers["x-content-sha256"] || "", "x-file-sha256": response.headers["x-file-sha256"] || "", etag: response.headers.etag || "" });
        res.end(response.bytes);
      } else {
        const result = input.action === "describe" ? { resource: response.value, protocol: 1,
          scope: "Only this resource and its current descendants. No access outside this link.",
          transport: { get: "Add action=stat|list|read|write-status and parameters to this URL.", post: "POST application/json to this URL." },
          operations: {
            stat: { target: "entry ID; omitted means linked resource" },
            list: { target: "folder ID", offset: 0, length: 200 },
            read: { target: "file ID", offset: 0, length: 4194304, expected: "observed version" },
            mkdir: { target: "parent folder ID", name: "new directory" },
            move: { target: "entry ID", parent: "destination folder ID; omit to rename", name: "new name", expected: "observed version" },
            trash: { target: "entry ID", expected: "observed version" },
            restore: { target: "trashed descendant ID", expected: "version after deletion" },
            "restore-version": { target: "file ID", expected: "observed version" },
            "begin-write": { target: "file ID to overwrite or folder ID to create", upload_id: "fresh 32 hex UUID", size: "byte count", name: "name for new file", expected: "required for overwrite" },
            "write-chunk": { upload_id: "upload ID", offset: "confirmed byte offset", data: "base64, max 4 MiB decoded", digest: "chunk SHA256" },
            "commit-write": { upload_id: "upload ID", digest: "complete file SHA256" },
            "write-status": { upload_id: "upload ID" }, "cancel-write": { upload_id: "upload ID" },
          },
        } : response.value;
        json(res, 200, result);
      }
    } catch (error) { if (!res.headersSent) json(res, error.status || 503, { error: { code: error.code || "SPACE_LINK_UNAVAILABLE" } }); else res.destroy(); }
  }
  server = http.createServer({ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 8192 }, (req, res) => void handle(req, res));
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(state.port, "127.0.0.1", resolve); });
    state.port = server.address().port;
    await persist();
  } catch (error) {
    unsubscribe(); server.close();
    throw fail(error.code === "EADDRINUSE" ? "SPACE_LINK_PORT_IN_USE" : "SPACE_LINK_START_FAILED", 503);
  }
  return {
    async manage(action, input = {}) {
      const bound = scope(); assertScope(bound);
      if (["agent-config","spaces","requests","approve","reject","space-manage","connection-manage","grants","connection-audit","grant","grant-revoke","file-transfer"].includes(action)) return agents.manage(action,input);
      if (action === "config") return mcpConfig;
      if (action === "create") {
        const root = uuid(input.root);
        const result = (await remote(bound, "/agent-links", { method: "POST", body: { root, expires: input.expires ?? null } })).value;
        const record = { ...result, key: randomBytes(32).toString("base64url"), scope: bound };
        state.links.push(record);
        try { await persist(); } catch (error) {
          state.links.splice(state.links.indexOf(record), 1);
          await remote(bound, `/agent-links/${result.id}`, { method: "DELETE" }).catch(() => {});
          throw error;
        }
        return { id: record.id, url: url(record), root, expires: record.expires };
      }
      if (action === "list") {
        const links = (await remote(bound, "/agent-links")).value;
        return links.map(link => { const local = state.links.find(r => r.id === link.id && r.scope === bound);
          return { ...link, url: local && !local.revoked && !link.revoked ? url(local) : null }; });
      }
      const record = state.links.find(r => r.id === uuid(input.id) && r.scope === bound);
      if (action === "revoke") {
        if (record) { record.revoked = true; await persist(); }
        await remote(bound, `/agent-links/${input.id}`, { method: "DELETE" });
        return { ok: true };
      }
      if (action === "audit") return (await remote(bound, `/agent-links/${input.id}/audit`)).value;
      throw fail("SPACE_ACTION_INVALID", 400);
    },
    async close() {
      closed = true; unsubscribe();
      for (const c of controllers) c.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); await writes.catch(() => {});
    },
  };
}
