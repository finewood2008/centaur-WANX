// Offline consumer contract: loads the real Electron service, replaces only Host I/O.
// Run: node wanx-bridge/tests/contracts/starlink.contract.mjs <STARLINK project root>
// Synthetic responses describe the consumer contract, not Semantica availability.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

assert.ok(process.argv[2], "Pass the STARLINK project root; no running backend is needed");
const source = path.resolve(process.argv[2], "desktop/shell/service.mjs");
const { SemanticaService } = await import(pathToFileURL(source).href);
const sourceText = await readFile(source, "utf8");
const prefix = "/api/semantica";
const warehouse = "10000000-0000-4000-8000-000000000001";
const scoped = `/warehouses/${warehouse}`;
const operation = "contract-operation";
const common = { warehouseId: warehouse, operationId: operation };
const digest = data => createHash("sha256").update(data).digest("hex");
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});
const page = { items: [], total: 0 };
const document = { id: "doc-a", original_name: "contract.txt", status: "ready", active_version_id: "v1" };
const detail = { document, version: { id: "v1" }, segments: [], blocks: [], block_count: 0,
  segment_next_offset: 0, processing: { text_ready: true, delivery_status: "pending" } };
const policy = { enabled: true, semantic_enabled: false, revision: 1, rules: [] };
const skill = { id: "contract-skill", title: "Contract", skill_revision: 1, draft_revision: 1 };
const confirmation = { expected_revision: 1, expected_draft_revision: 1,
  typed_name: "Contract", confirm: true, invalidate_dependents: false };

function setup(handler, extra = {}) {
  return new SemanticaService({ host: {
    context: async () => ({ boxId: "contract-box", user: { id: 7, username: "contract" }, connection: "ready" }),
    onSessionInvalidated: () => () => {}, close() {}, request: handler,
  }, ...extra });
}

// [action, input, method, suffix, exact JSON body, synthetic response, timeout]
const cases = [
  ["warehouses", {}, "GET", "/warehouses", undefined, page],
  ["runtime", {}, "GET", "/warehouses/runtime", undefined, { local_only: true, model: "fixture", embedding: "fixture", host_api_prefix: prefix + "/open/v1" }],
  ["warehouse", { id: warehouse }, "GET", scoped, undefined, { id: warehouse, name: "Contract", state: "active" }],
  ["create-warehouse", { name: "Contract", description: "fixture" }, "POST", "/warehouses", { operation_id: operation, name: "Contract", description: "fixture" }, { id: warehouse }],
  ["keys", {}, "GET", scoped + "/keys", undefined, page],
  ["create-key", { name: "Contract", days: 30 }, "POST", scoped + "/keys", { operation_id: operation, name: "Contract", days: 30, scopes: ["documents", "evidence", "graph", "reasoning", "search"] }, { token: "xg_fixture", key: { id: "key-a" } }],
  ["create-key", { name: "Contract", days: 1, scopes: ["search"] }, "POST", scoped + "/keys", { operation_id: operation, name: "Contract", days: 1, scopes: ["search"] }, { key: { scopes: ["search"] } }],
  ["revoke-key", { id: "key-a" }, "POST", scoped + "/keys/key-a/revoke", { operation_id: operation }, { revoked: true }],
  ["prepare-clear", {}, "POST", scoped + "/clear/prepare", { operation_id: operation }, { confirmation_token: "fixture", warehouse: { name: "Contract" } }],
  ["prepare-delete", {}, "POST", scoped + "/delete/prepare", { operation_id: operation }, { confirmation_token: "fixture", warehouse: { name: "Contract" } }],
  ["clear-warehouse", { token: "fixture", typedName: "Contract" }, "POST", scoped + "/clear", { operation_id: operation, confirmation_token: "fixture", typed_name: "Contract" }, { state: "clearing" }],
  ["delete-warehouse", { token: "fixture", typedName: "Contract" }, "POST", scoped + "/delete", { operation_id: operation, confirmation_token: "fixture", typed_name: "Contract" }, { state: "deleting" }],
  ["export-warehouse", {}, "POST", scoped + "/exports", { operation_id: operation }, { id: "transfer-a", kind: "export", state: "queued" }],
  ["transfers", {}, "GET", "/warehouses/transfers", undefined, page],
  ["transfer", { id: "transfer-a" }, "GET", "/warehouses/transfers/transfer-a", undefined, { id: "transfer-a", state: "ready" }],
  ["documents", { offset: 100 }, "GET", scoped + "/documents?limit=100&offset=100", undefined, { items: [document], total: 101 }],
  ["document", { id: "doc-a", offset: 100 }, "GET", scoped + "/documents/doc-a?segment_offset=100&segment_limit=100", undefined, detail],
  ["jobs", { offset: 100 }, "GET", scoped + "/jobs?limit=100&offset=100", undefined, { ...page, limit: 100, offset: 100, activity: {} }],
  ["graph", {}, "GET", scoped + "/owner/graph?limit=120", undefined, { nodes: [], edges: [] }],
  ["retrieval", {}, "GET", scoped + "/retrieval/status", undefined, { ready: true, index: null }],
  ["search", { query: "合同", documentIds: ["doc-a"], entityTypes: ["PERSON"] }, "POST", scoped + "/search", { query: "合同", document_ids: ["doc-a"], entity_types: ["PERSON"], limit: 10 }, { items: [], graph: { nodes: [], edges: [] } }, 90000],
  ["sensitive", {}, "GET", scoped + "/sensitive/settings", undefined, policy],
  ["save-sensitive", { payload: { expected_revision: 1, enabled: true, semantic_enabled: false, rules: [] } }, "PUT", scoped + "/sensitive/settings", { operation_id: operation, payload: { expected_revision: 1, enabled: true, semantic_enabled: false, rules: [] } }, policy],
  ["correct", { id: "doc-a", versionId: "v1", segments: [{ id: "segment-a", text: "更正" }] }, "POST", scoped + "/documents/doc-a/correction", { operation_id: operation, payload: { base_version_id: "v1", segments: [{ id: "segment-a", text: "更正" }] } }, detail],
  ["retry-job", { id: "job-a" }, "POST", scoped + "/jobs/job-a/retry", { operation_id: operation }, { id: "job-a", status: "queued" }],
  ["build-index", {}, "POST", scoped + "/retrieval/indexes", { operation_id: operation }, { index: {}, job: { id: "job-a" }, reused: false }],
  ["skills", { offset: 20, keyword: "方法 & A" }, "GET", scoped + "/skills?limit=20&offset=20&keyword=" + encodeURIComponent("方法 & A"), undefined, { items: [skill], total: 1 }],
  ["skill", { id: skill.id, path: "references/a b.md" }, "GET", scoped + "/skills/contract-skill?path=" + encodeURIComponent("references/a b.md"), undefined, { skill, version: "1.0.0", files: [], file: { path: "references/a b.md", text: "fixture" } }],
  ["delete-skill", { id: skill.id, confirmation }, "POST", scoped + "/skills/contract-skill/delete", { ...confirmation, operation_id: operation }, { deleted: true }],
  ["processing", {}, "GET", "/processing?warehouse_id=" + warehouse, undefined, { effective: {}, stages: [], revision: 1, inherit: true, affected_warehouses: [] }],
  ["processing", { scope: "default" }, "GET", "/processing", undefined, { effective: {}, stages: [], revision: 1, inherit: false, affected_warehouses: [] }],
  ["model-catalog", {}, "GET", "/processing/catalog", undefined, { items: [{ id: "model-a", revision: "r1", available: true }] }],
  ["check-models", { config: { extraction: "model-a", cloud_confirmations: ["r1"] } }, "POST", "/processing/check", { extraction: "model-a", cloud_confirmations: ["r1"], warehouse_id: warehouse, operation_id: "$uuid" }, { check_id: "check-a" }, 330000],
  ["save-models", { scope: "default", config: { expected_revision: 1, inherit: false, check_id: "check-a" } }, "PUT", "/processing", { expected_revision: 1, inherit: false, check_id: "check-a", warehouse_id: null, operation_id: "$uuid" }, { revision: 2 }, 330000],
  ["reprocess-models", { documents: [{ id: "doc-a", version_id: "v1" }], expectedSignature: "a".repeat(64) }, "POST", "/processing/reprocess", { operation_id: operation, warehouse_id: warehouse, documents: [{ id: "doc-a", version_id: "v1" }], expected_signature: "a".repeat(64) }, { job_ids: ["job-a"] }],
];

const reasoningArguments = {
  discover: { query: "合同", limit: 5 },
  prepare: { skill_id: skill.id, idempotency_key: "prepare-a", document_ids: ["doc-a"], detect: true, delivery_mode: "masked" },
  reference: { skill_id: skill.id, reference_id: "ref-a", preparation_id: "prep-a", detect: true, delivery_mode: "masked" },
  scope: { preparation_id: "prep-a" },
  search: { preparation_id: "prep-a", query: "合同", limit: 5 },
  evidence: { preparation_id: "prep-a", evidence_id: "evidence-a" },
  "read-document": { preparation_id: "prep-a", document_id: "doc-a", detect: true },
  coverage: { preparation_id: "prep-a" },
};
for (const [op, args] of Object.entries(reasoningArguments)) {
  cases.push(["reasoning", { operation: op, arguments: args }, "POST", scoped + "/reasoning/" + op,
    { operation_id: operation, arguments: args },
    { preparation_id: "prep-a", preparation_status: "ready", fully_executable: false,
      detection_status: "unverified", next_action: "detect_reasoning", content: { references: [] } }, 330000]);
}

for (const [index, [action, input, method, suffix, body, reply, timeout = 60000]] of cases.entries()) {
  test(`${index + 1}. ${action}: ${method} ${suffix}`, async () => {
    let calls = 0;
    const service = setup(async (endpoint, options) => {
      calls++;
      assert.equal(endpoint, prefix + suffix);
      assert.equal(options.method, method);
      assert.equal(options.timeoutMs, timeout);
      assert.ok(options.signal instanceof AbortSignal);
      const actual = options.body === undefined ? undefined : JSON.parse(JSON.stringify(options.body));
      if (body?.operation_id === "$uuid") {
        assert.match(actual.operation_id, /^[a-f0-9-]{36}$/);
        actual.operation_id = "$uuid";
      }
      assert.deepEqual(actual, body);
      return json(reply);
    });
    try {
      assert.deepEqual(await service.call(action, { ...common, ...input }), reply);
      assert.equal(calls, 1);
    } finally { service.close(); }
  });
}

test("initialization requires all four envelopes, without an extra data/result wrapper", async () => {
  const replies = {
    "/status": { version: "fixture", document_formats: ["txt"], document_max_bytes: 1024 },
    "/capabilities": { accepted_suffixes: [".txt"], document_max_bytes: 1024 },
    "/warehouses": { items: [{ id: warehouse, name: "Contract", state: "active" }] },
    "/warehouses/runtime": { local_only: true, model: "fixture", embedding: "fixture" },
  };
  const seen = [];
  const service = setup(async (endpoint, options) => {
    seen.push(endpoint);
    assert.equal(options.method, "GET");
    assert.ok(replies[endpoint.slice(prefix.length)]);
    return json(replies[endpoint.slice(prefix.length)]);
  });
  try {
    const result = await service.call("initialize");
    assert.deepEqual(seen.sort(), Object.keys(replies).map(p => prefix + p).sort());
    for (const [key, endpoint] of Object.entries({ status: "/status", capabilities: "/capabilities", warehouses: "/warehouses", runtime: "/warehouses/runtime" })) {
      assert.deepEqual(result[key], replies[endpoint]);
    }
    assert.equal(result.retrieval, null);
    assert.equal(result.identity.boxId, "contract-box");
  } finally { service.close(); }
});

async function withDirectory(work) {
  const temporaryRoot = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, "wanx-starlink-contract-"));
  try { await work(directory); }
  finally {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith("wanx-starlink-contract-"));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const migration of [false, true]) {
  test(`${migration ? "migration" : "document"} import keeps stable IDs, bounded chunks and commit envelope`, () => withDirectory(async directory => {
    const data = Buffer.alloc(1024 * 1024 + 17, 0x61);
    const filename = path.join(directory, migration ? "fixture.xingtu" : "fixture.txt");
    await writeFile(filename, data);
    const base = prefix + (migration ? "/warehouses" : scoped);
    let begin, received = 0, commits = 0, reconciles = 0;
    const reply = migration ? { id: "transfer-a", kind: "import", state: "ready", result: { warehouse_id: warehouse } }
      : { document, job: { id: "job-a" }, reused: false };
    const service = setup(async (endpoint, options) => {
      const body = options.body;
      if (endpoint === base + "/imports") {
        assert.equal(options.method, "POST");
        assert.deepEqual(Object.keys(body).sort(), ["operation_id", "external_document_id", "filename", "size_bytes", "sha256"].sort());
        assert.equal(body.filename, path.basename(filename));
        assert.equal(body.size_bytes, data.length);
        assert.equal(body.sha256, digest(data));
        begin = body;
        return json({ upload_handle: "upload-a", received_bytes: 0 });
      }
      if (endpoint === base + "/imports/upload-a") {
        assert.equal(options.method, "PATCH");
        assert.deepEqual(Object.keys(body).sort(), ["operation_id", "offset", "content_base64"].sort());
        assert.equal(body.operation_id, begin.operation_id);
        assert.equal(body.offset, received);
        const chunk = Buffer.from(body.content_base64, "base64");
        assert.ok(chunk.length <= 1024 * 1024);
        assert.deepEqual(chunk, data.subarray(received, received + chunk.length));
        received += chunk.length;
        return json({ offset: received });
      }
      if (endpoint === base + "/imports/upload-a/commit") {
        commits++;
        assert.equal(options.method, "POST");
        assert.deepEqual(body, { operation_id: begin.operation_id });
        assert.equal(received, data.length);
        if (!migration) throw new Error("simulated lost commit response");
        return json(reply);
      }
      assert.equal(endpoint, base + "/operations/" + begin.operation_id);
      assert.equal(options.method, "GET");
      reconciles++;
      return json({ status: "committed", result: reply });
    }, { selectFiles: async () => [filename], selectArchive: async () => [filename] });
    try {
      const [selected] = await service.call(migration ? "select-migration" : "select-files", common);
      const input = { handle: selected.handle, ...(migration ? {} : common) };
      const action = migration ? "import-migration" : "upload";
      assert.deepEqual(await service.call(action, input), reply);
      assert.deepEqual(await service.call(action, input), reply);
      assert.equal(commits, 1);
      assert.equal(reconciles, migration ? 0 : 1);
    } finally { service.close(); }
  }));
}

for (const migration of [false, true]) {
  test(`${migration ? "migration" : "original"} download consumes base64 JSON and verifies hashes`, () => withDirectory(async directory => {
    const data = Buffer.alloc(1024 * 1024 + 17, 0x62), hash = digest(data);
    const output = path.join(directory, "result.bin");
    const base = prefix + (migration ? "/warehouses/transfers/transfer-a" : scoped + "/documents/doc-a");
    let chunks = 0;
    const service = setup(async (endpoint, options) => {
      assert.equal(options.method, "GET");
      if (endpoint === base) return json(migration
        ? { id: "transfer-a", kind: "export", state: "ready", size_bytes: data.length, sha256: hash, result: { filename: "fixture.xingtu" } }
        : detail);
      const url = new URL(endpoint, "http://contract.invalid");
      assert.equal(url.pathname, base + "/blob");
      const offset = Number(url.searchParams.get("offset"));
      assert.equal(offset, chunks * 1024 * 1024);
      assert.equal(url.searchParams.get("length"), "1048576");
      if (!migration && offset) {
        assert.equal(url.searchParams.get("expected_sha256"), hash);
        assert.equal(url.searchParams.get("expected_origin_revision"), "3");
      }
      const chunk = data.subarray(offset, offset + 1024 * 1024);
      chunks++;
      return json({ document_id: "doc-a", offset, length: chunk.length, total_bytes: data.length,
        sha256: hash, origin_revision: 3, content_base64: chunk.toString("base64") });
    }, { selectSave: async () => output });
    try {
      assert.deepEqual(await service.call(migration ? "save-migration" : "download", { ...common, id: migration ? "transfer-a" : "doc-a" }), { saved: true });
      assert.deepEqual(await readFile(output), data);
      assert.equal(chunks, 2);
    } finally { service.close(); }
  }));
}

test("Skill import/download uses JSON base64; returned package shape is consumed intact", () => withDirectory(async directory => {
  const input = path.join(directory, "fixture.zip"), output = path.join(directory, "saved.zip");
  const data = Buffer.from("synthetic ZIP bytes: consumer does not parse archives");
  await writeFile(input, data);
  const service = setup(async (endpoint, options) => {
    if (endpoint.endsWith("/import")) {
      assert.equal(endpoint, prefix + scoped + "/skills/import");
      assert.equal(options.method, "POST");
      assert.deepEqual(options.body, { operation_id: operation, content_base64: data.toString("base64") });
      return json({ skill, files: [{ path: "SKILL.md" }] });
    }
    assert.equal(endpoint, prefix + scoped + "/skills/contract-skill/download");
    assert.equal(options.method, "GET");
    return json({ filename: "contract-skill.zip", content_base64: data.toString("base64"), sha256: digest(data) });
  }, { selectSkill: async () => [input], selectSave: async () => output });
  try {
    assert.equal((await service.call("import-skill", common)).skill.id, skill.id);
    assert.deepEqual(await service.call("download-skill", { ...common, id: skill.id }), { saved: true });
    assert.deepEqual(await readFile(output), data);
  } finally { service.close(); }
}));

test("Host drive and local selection actions do not turn into Semantica HTTP", async () => {
  const entry = { id: "space-a", name: "fixture.txt", kind: "file", size: 5, digest: "a".repeat(64), modified: "fixture" };
  const service = setup(() => assert.fail("unexpected Semantica request"));
  const seen = [];
  service.host.drive = {
    overview: async () => { seen.push("overview"); return {}; },
    list: async () => { seen.push("list"); return { parent: "", breadcrumbs: [], items: [entry] }; },
    stat: async () => { seen.push("stat"); return entry; },
  };
  try {
    assert.equal((await service.call("space-list")).items[0].id, entry.id);
    const [selected] = await service.call("select-space-files", { ...common, entries: [entry] });
    assert.equal(selected.spaceId, entry.id);
    assert.deepEqual(await service.call("release-files", { ...common, handles: [selected.handle] }), { released: true });
    assert.equal(service.files.size, 0);
    assert.deepEqual(await service.call("select-warehouse", common), { selected: true });
    assert.deepEqual(seen, ["overview", "list", "stat"]);
  } finally { service.close(); }
});

const errors = [
  [409, { code: "WAREHOUSE_BUSY", message: "此仓处理中" }, "WAREHOUSE_BUSY", "此仓处理中"],
  [409, { code: "SKILL_REVISION_CONFLICT", message: "版本变化" }, "SKILL_REVISION_CONFLICT", "版本变化"],
  [422, { code: "MODEL_INVALID_REQUEST", message: "模型参数错误" }, "MODEL_INVALID_REQUEST", "模型参数错误"],
  [403, { code: "ACCESS_KEY_INVALID", message: "凭证已撤销" }, "ACCESS_KEY_INVALID", "凭证已撤销"],
  [503, { code: "SEMANTICA_SERVICE_AUTH_FAILED" }, "SEMANTICA_SERVICE_AUTH_FAILED", undefined],
  [422, { detail: { code: "SKILL_INVALID_REQUEST", message: "原生嵌套错误" } }, "SEMANTICA_REQUEST_FAILED", undefined],
  [404, { detail: "not found" }, "SEMANTICA_UPGRADE_REQUIRED", undefined],
];
for (const status of [201, 202]) {
  test(`successful ${status} responses still require a JSON business object`, async () => {
    const reply = { document, job: { id: "job-a" }, reused: false };
    const service = setup(async () => json(reply, status));
    try { assert.deepEqual(await service.api("/imports/upload-a/commit", { method: "POST", body: { operation_id: operation } }), reply); }
    finally { service.close(); }
  });
}
test("raw binary cannot replace the desktop blob JSON response", async () => {
  const service = setup(async () => new Response(new Uint8Array([0, 255]), { status: 200 }));
  try {
    await assert.rejects(service.api(scoped + "/documents/doc-a/blob?offset=0&length=1048576"), { code: "SEMANTICA_INVALID_RESPONSE" });
  } finally { service.close(); }
});
for (const [status, body, code, message] of errors) {
  test(`error contract ${status} ${JSON.stringify(body)} -> ${code}`, async () => {
    const service = setup(async () => json(body, status));
    try {
      await assert.rejects(service.call("documents", common), error => {
        assert.equal(error.code, code);
        assert.equal(error.publicMessage, message);
        return true;
      });
      assert.equal(service.invalid, false);
    } finally { service.close(); }
  });
}

test("every current service action has a contract case or a workflow test", t => {
  const workflows = ["initialize", "select-warehouse", "space-list", "select-space-files", "release-files",
    "select-files", "select-migration", "upload", "import-migration", "save-migration", "download",
    "import-skill", "download-skill"];
  const covered = new Set([...cases.map(c => c[0]), ...workflows]);
  const actual = new Set([...sourceText.matchAll(/case\s+"([a-z-]+)"\s*:/g)].map(m => m[1]));
  assert.deepEqual([...covered].sort(), [...actual].sort());
  t.diagnostic(`service.mjs sha256=${digest(sourceText)}; ${actual.size} actions covered; mocked Host only`);
});
