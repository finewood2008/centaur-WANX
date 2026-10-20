import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPersonalSpace } from "../shell/personal-space.mjs";
const hash = b => createHash("sha256").update(b).digest("hex");
const waitFor = async fn => { for (const deadline = Date.now() + 10_000; Date.now() < deadline;) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error("state timed out"); };
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-space-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let state = { phase: "ready", account: { phase: "authenticated", accountId: "owner" }, connection: { deviceId: "box" } };
  const listeners = new Set(); let saved = [], uploaded = [], remote;
  const requests = [];
  const payload = Buffer.alloc(36 * 1024 * 1024, 7);
  const client = { snapshot: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, async applicationConnection() {
    const identity = JSON.stringify(state);
    const context = () => { if (JSON.stringify(state) !== identity) throw new Error("NETWORK_CHANGED"); return {}; };
    return { context, async request(input) {
      requests.push(input); context(); await overrides.beforeRequest?.(input);
      let value = {};
      if (input.path.endsWith("/overview")) value = { protocolVersion: 1 };
      else if (input.path.endsWith("/uploads") && input.method === "POST") { const b = JSON.parse(input.body); remote ||= { ...b, offset: 0, state: "pending" }; value = remote; }
      else if (input.method === "PUT") { assert.ok(input.body.length <= 1024 * 1024); assert.equal(input.headers["x-content-sha256"], hash(input.body)); uploaded.push(input.body); remote.offset += input.body.length; value = { offset: remote.offset }; }
      else if (input.path.endsWith("/complete")) { assert.equal(JSON.parse(input.body).digest, hash(Buffer.concat(uploaded))); remote.state = "complete"; }
      else if (input.path.includes("/content")) { const offset = Number(new URL(input.path, "http://test").searchParams.get("offset")); const bytes = payload.subarray(offset, offset + 4 * 1024 * 1024); return { status: 200, headers: { "x-content-sha256": hash(bytes) }, body: bytes }; }
      else if (input.path.includes("/files/")) value = { id: "a".repeat(32), kind: "file", name: "remote.bin", size: payload.length, digest: hash(payload) };
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)) };
    } };
  } };
  const source = path.join(root, "source.bin"), destination = path.join(root, "saved.bin");
  await writeFile(source, payload);
  const options = { client, store: { async load() { return structuredClone(saved); }, async save(v) { saved = structuredClone(v); } }, serviceURL: "https://accounts.test", chooseUploads: overrides.chooseUploads || (async () => [source]), chooseDownload: async () => destination };
  let service = await createPersonalSpace(options);
  t.after(() => service.close());
  return { get service() { return service; }, async restart() { await service.close(); service = await createPersonalSpace(options); }, requests, payload, source, destination, saved: () => saved, switch(value) { state = { ...state, ...value }; for (const fn of listeners) fn(); } };
}
test("large transfers remain chunked, private paths stay out of renderer, and download is verified", async t => {
  const f = await fixture(t);
  await f.service.uploads("");
  await waitFor(() => f.service.snapshot().tasks[0]?.phase === "complete");
  assert.equal(f.requests.filter(r => r.method === "PUT").length, 36);
  assert.equal(f.service.snapshot().tasks[0].localPath, undefined);
  await f.service.download("a".repeat(32));
  await waitFor(() => f.service.snapshot().tasks[1]?.phase === "complete");
  assert.equal((await stat(f.destination)).size, f.payload.length);
  assert.equal(hash(await readFile(f.destination)), hash(f.payload));
});
test("logout aborts late upload completion and a new account sees no previous tasks", async t => {
  let release; const blocked = new Promise(r => { release = r; });
  const f = await fixture(t, { beforeRequest: async input => { if (input.method === "PUT") await blocked; } });
  await f.service.uploads("");
  await waitFor(() => f.requests.some(r => r.method === "PUT"));
  f.switch({ account: { phase: "authenticated", accountId: "another" } });
  release();
  await waitFor(() => f.saved()[0]?.phase === "paused");
  assert.deepEqual(f.service.snapshot().tasks, []);
  assert.equal(f.requests.some(r => r.path.endsWith("/complete")), false);
  f.switch({ account: { phase: "authenticated", accountId: "owner" } });
  assert.equal(f.service.snapshot().tasks[0].phase, "paused");
});
test("dropped files use the same verified transfer queue without opening a picker", async t => {
  const f = await fixture(t, { chooseUploads: async () => { throw new Error('unexpected picker'); } });
  await f.service.uploads('b'.repeat(32), [f.source]);
  await waitFor(() => f.service.snapshot().tasks[0]?.phase === 'complete');
  const created = JSON.parse(f.requests.find(r => r.method === 'POST' && r.path.endsWith('/uploads')).body);
  assert.equal(created.parent, 'b'.repeat(32));
  assert.equal(created.size, f.payload.length);
  assert.equal(f.requests.filter(r => r.method === 'PUT').length, 36);
  assert.equal(f.service.snapshot().tasks[0].localPath, undefined);
});
test("invalid drops and directories do not create remote uploads", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.uploads('', ['relative.bin']), { code: 'SPACE_INVALID_DROP' });
  await assert.rejects(f.service.uploads('', [path.dirname(f.source)]), { code: 'SPACE_DROP_FILES_ONLY' });
  assert.deepEqual(f.service.snapshot().tasks, []);
  assert.equal(f.requests.some(r => r.method === 'POST'), false);
});
test("resuming requires the original local file and never silently uploads a changed source", async t => {
  let release; const blocked = new Promise(r => { release = r; });
  const f = await fixture(t, { beforeRequest: async input => { if (input.method === "PUT") await blocked; } });
  await f.service.uploads("");
  await waitFor(() => f.requests.some(r => r.method === "PUT"));
  const task = f.service.snapshot().tasks[0];
  const paused = f.service.transfer("pause", task.id); release(); await paused;
  await writeFile(f.source, "changed");
  await f.service.transfer("resume", task.id);
  await waitFor(() => f.service.snapshot().tasks[0].error === "SPACE_LOCAL_FILE_CHANGED");
  assert.equal(f.requests.some(r => r.path.endsWith("/complete")), false);
});
test("restart automatically resumes an active transfer from the box committed offset", async t => {
  let release, held = false; const blocked = new Promise(r => { release = r; });
  const f = await fixture(t, { beforeRequest: async input => { if (input.method === "PUT" && !held) { held = true; await blocked; } } });
  await f.service.uploads("");
  await waitFor(() => held);
  const taskId = f.service.snapshot().tasks[0].id;
  const restarting = f.restart(); release(); await restarting;
  assert.equal(f.service.snapshot().tasks[0].id, taskId);
  await waitFor(() => f.service.snapshot().tasks[0]?.phase === "complete");
  assert.equal(f.requests.filter(r => r.method === "PUT").length, 36);
  assert.equal(f.service.snapshot().tasks[0].offset, f.payload.length);
});
test("canceling while the box changes never sends cancellation to the new box", async t => {
  let release; const blocked = new Promise(r => { release = r; });
  const f = await fixture(t, { beforeRequest: async input => { if (input.method === "PUT") await blocked; } });
  await f.service.uploads("");
  await waitFor(() => f.requests.some(r => r.method === "PUT"));
  const cancel = f.service.transfer("cancel", f.service.snapshot().tasks[0].id);
  f.switch({ connection: { deviceId: "other-box" } }); release();
  await assert.rejects(cancel, { code: "SPACE_CONTEXT_CHANGED" });
  assert.equal(f.requests.some(r => r.method === "DELETE"), false);
});
test("unreadable encrypted records block new transfers without overwriting records or trapping quit", async () => {
  let writes = 0;
  const service = await createPersonalSpace({
    client: { snapshot: () => ({ account: { phase: "signed_out" } }), subscribe: () => () => {} },
    store: { async load() { throw new Error("Keychain unavailable"); }, async save() { writes++; } },
    serviceURL: "https://accounts.test", chooseUploads: async () => [], chooseDownload: async () => null,
  });
  await assert.rejects(service.uploads(""), { code: "SECURE_STORAGE_READ_FAILED" });
  await service.close();
  assert.equal(writes, 0);
});

test("captured panel scope cannot enqueue into a box changed during connection setup", async t => {
  const f = await fixture(t);
  await f.service.refresh();
  const scope = f.service.snapshot().scope;
  const pending = f.service.uploads("", [f.source], scope);
  f.switch({ connection: { deviceId: "another-box" } });
  await assert.rejects(pending, { code: "SPACE_CONTEXT_CHANGED" });
  assert.deepEqual(f.service.snapshot().tasks, []);
  assert.equal(f.requests.some(r => r.method === "POST"), false);
});
