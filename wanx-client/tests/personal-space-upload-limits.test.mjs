import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPersonalSpace, MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES } from "../shell/personal-space.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-upload-limits-"));
  let chosen = [], saved = [], writes = 0;
  const requests = [], events = [];
  const state = { phase: "ready", account: { phase: "authenticated", accountId: "owner" }, connection: { deviceId: "box" } };
  const client = { snapshot: () => state, subscribe: () => () => {}, applicationConnection: async () => ({
    context() {}, request(input) { requests.push(input); throw Error("No network needed for preflight"); },
  }) };
  const service = await createPersonalSpace({ client, serviceURL: "https://accounts.test",
    chooseUploads: async () => chosen,
    store: { load: async () => [], save: async value => {
      saved = structuredClone(value); writes++;
      // Stop at the queue boundary: sparse 200 MB fixtures need no hashing/upload.
      if (value.length) state.phase = "recovering";
    } }, onEvent: event => events.push(event),
  });
  await new Promise(resolve => setImmediate(resolve));
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { service, requests, events, saved: () => saved, writes: () => writes,
    select(files) { chosen = files; state.phase = "ready"; },
    async file(name, size = 0) { const file = path.join(root, name), handle = await open(file, "wx"); try { await handle.truncate(size); } finally { await handle.close(); } return file; },
  };
}

for (const entry of ["picker", "drop"]) {
  for (const count of [19, 20, 21]) test(`${entry}: ${count} files respects the whole-batch count boundary`, async t => {
    const f = await fixture(t), paths = [];
    for (let i = 0; i < count; i++) paths.push(await f.file(`${i}.txt`));
    f.select(paths);
    const invoke = () => f.service.uploads("", entry === "drop" ? paths : undefined);
    if (count > MAX_UPLOAD_FILES) {
      const writes = f.writes();
      await assert.rejects(invoke(), error => error.code === "SPACE_UPLOAD_LIMIT" && /20.*21.*未加入/.test(error.message));
      assert.equal(f.service.snapshot().tasks.length, 0); assert.equal(f.writes(), writes); assert.equal(f.events.length, 0);
    } else { await invoke(); assert.equal(f.saved().length, count); }
    assert.equal(f.requests.length, 0);
  });
  for (const bytes of [0, MAX_UPLOAD_BYTES - 1, MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES + 1]) test(`${entry}: file size ${bytes} bytes`, async t => {
    const f = await fixture(t), file = await f.file("boundary.bin", bytes); f.select([file]);
    const invoke = () => f.service.uploads("", entry === "drop" ? [file] : undefined);
    if (bytes > MAX_UPLOAD_BYTES) {
      await assert.rejects(invoke(), error => error.code === "SPACE_UPLOAD_LIMIT" && /200 MB.*boundary.bin.*未加入/.test(error.message));
      assert.equal(f.saved().length, 0); assert.equal(f.events.length, 0);
    } else { await invoke(); assert.equal(f.saved()[0].size, bytes); }
    assert.equal(f.requests.length, 0);
  });
}

test("mixed oversized batch leaves an existing queue unchanged and lists every oversized basename", async t => {
  const f = await fixture(t), existing = await f.file("existing.txt", 1);
  await f.service.uploads("", [existing]);
  const before = structuredClone(f.saved()), writes = f.writes(), events = f.events.length;
  const small = await f.file("small.txt", 10), big1 = await f.file("大文件.bin", MAX_UPLOAD_BYTES + 1), big2 = await f.file("large.bin", MAX_UPLOAD_BYTES + 2);
  f.select([small, big1, big2]);
  await assert.rejects(f.service.uploads(""), error => {
    assert.equal(error.code, "SPACE_UPLOAD_LIMIT");
    assert.match(error.message, /以下 2 个文件.*大文件.bin、large.bin/);
    assert.ok(!error.message.includes(path.dirname(big1))); return true;
  });
  assert.deepEqual(f.saved(), before); assert.equal(f.writes(), writes); assert.equal(f.events.length, events); assert.equal(f.requests.length, 0);
});

test("empty selection/cancel writes nothing; count is checked before deduplication or stat", async t => {
  const f = await fixture(t), writes = f.writes();
  await f.service.uploads(""); assert.equal(f.writes(), writes);
  const missing = path.join(tmpdir(), "not-a-real-file-for-limit-test");
  await assert.rejects(f.service.uploads("", Array(21).fill(missing)), { code: "SPACE_UPLOAD_LIMIT" });
  assert.equal(f.writes(), writes); assert.deepEqual(f.saved(), []);
});

test('drop preserves visible Unicode names even when the disk basename is temporary', async t => {
  const f = await fixture(t), file = await f.file('temporary-123.bin', 1);
  const names = ['中文 报告（终稿）😀.png', 'cafe\u0301.txt'];
  await f.service.uploads('', [file, file], undefined, names);
  assert.deepEqual(f.saved().map(task => task.name), names);
});

test('invalid dropped names reject the entire batch before queueing', async t => {
  const f = await fixture(t), file = await f.file('temporary.bin', 1);
  for (const bad of [' 前导空格.txt', '尾部.txt ', '../escape.txt', 'x\\bad.txt', 'a\n.txt', 'x.', '字'.repeat(81)]) {
    await assert.rejects(f.service.uploads('', [file, file], undefined, ['正常.txt', bad]), {code: 'SPACE_INVALID_NAME'});
    assert.equal(f.saved().length, 0);
  }
  await assert.rejects(f.service.uploads('', [file], undefined, []));
  assert.equal(f.saved().length, 0);
});
