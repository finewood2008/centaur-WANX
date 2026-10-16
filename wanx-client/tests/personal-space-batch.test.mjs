import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPersonalSpace } from "../shell/personal-space.mjs";

const id = letter => letter.repeat(32);
const digest = data => createHash("sha256").update(data).digest("hex");
async function fixture(t, { choose, unsafeName } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-batch-")), destination = path.join(root, "downloads");
  await mkdir(destination);
  t.after(() => rm(root, { recursive: true, force: true }));
  const payloads = new Map([[id("a"), Buffer.from("alpha\n")], [id("b"), Buffer.from("中文批量下载\n")], [id("c"), Buffer.from("a,b\n1,2\n")]]);
  const entries = [
    { id: id("a"), parent: "", name: unsafeName || "alpha.txt", kind: "file" },
    { id: id("f"), parent: "", name: "项目", kind: "folder" },
    { id: id("b"), parent: id("f"), name: "笔记.txt", kind: "file" },
    { id: id("d"), parent: id("f"), name: "子目录", kind: "folder" },
    { id: id("e"), parent: id("f"), name: "空文件夹", kind: "folder" },
    { id: id("c"), parent: id("d"), name: "数据.csv", kind: "file" },
  ].map(entry => ({ ...entry, ...(entry.kind === "file" ? { size: payloads.get(entry.id).length, digest: digest(payloads.get(entry.id)) } : {}) }));
  let owner = "owner", notify, pickerCalls = 0;
  const snapshot = () => ({ phase: "ready", account: { phase: "authenticated", accountId: owner }, connection: { deviceId: "box" } });
  const switchOwner = () => { owner = "another"; notify(); };
  const client = { snapshot, subscribe(fn) { notify = fn; return () => {}; }, async applicationConnection() {
    const account = owner;
    const context = () => { if (owner !== account) throw new Error("SPACE_CONTEXT_CHANGED"); };
    return { context, async request(input) {
      context(); const url = new URL(input.path, "http://fixture"), itemId = url.pathname.split("/")[4];
      if (url.pathname.endsWith("/content")) {
        const bytes = payloads.get(itemId);
        return { status: 200, headers: { "x-content-sha256": digest(bytes) }, body: bytes };
      }
      const value = url.pathname.endsWith("/files") ? { items: entries.filter(entry => entry.parent === (url.searchParams.get("parent") || "")) } : entries.find(entry => entry.id === itemId);
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)) };
    } };
  } };
  const service = await createPersonalSpace({ client, store: { load: async () => [], save: async () => {} }, serviceURL: "http://fixture", chooseDownloadDirectory: async () => { pickerCalls++; return choose ? choose({ switchOwner, destination }) : destination; } });
  t.after(() => service.close());
  return { service, root, destination, payloads, pickerCalls: () => pickerCalls };
}
async function complete(service) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (service.snapshot().tasks.every(task => task.phase === "complete")) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(JSON.stringify(service.snapshot().tasks));
}
test("batch download chooses once, preserves folder hierarchy and empty folders, verifies content and avoids overwrites", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.destination, "alpha.txt"), "existing user data");
  const queued = await f.service.downloads([id("a"), id("f"), id("a")]);
  assert.equal(queued.count, 3); assert.equal(f.pickerCalls(), 1);
  await complete(f.service);
  assert.equal(await readFile(path.join(f.destination, "alpha.txt"), "utf8"), "existing user data");
  for (const [relative, itemId] of [["alpha (1).txt", id("a")], ["项目/笔记.txt", id("b")], ["项目/子目录/数据.csv", id("c")]]) assert.equal(digest(await readFile(path.join(f.destination, relative))), digest(f.payloads.get(itemId)));
  assert.deepEqual(await readdir(path.join(f.destination, "项目/空文件夹")), []);
  assert.ok(f.service.snapshot().tasks.every(task => !Object.hasOwn(task, "localPath") && !Object.hasOwn(task, "partialPath")));
});
test("canceled batch picker queues nothing and changes no local files", async t => {
  const f = await fixture(t, { choose: () => null });
  assert.deepEqual(await f.service.downloads([id("a")]), { canceled: true });
  assert.deepEqual(f.service.snapshot().tasks, []); assert.deepEqual(await readdir(f.destination), []);
});
test("switching account during the picker cannot queue old-account files", async t => {
  const f = await fixture(t, { choose: ({ switchOwner, destination }) => { switchOwner(); return destination; } });
  await assert.rejects(f.service.downloads([id("a"), id("f")]), { code: "SPACE_CONTEXT_CHANGED" });
  assert.deepEqual(f.service.snapshot().tasks, []); assert.deepEqual(await readdir(f.destination), []);
});
test("remote path components and malformed selection ids cannot escape a batch destination", async t => {
  const f = await fixture(t, { unsafeName: "../escape.txt" });
  await assert.rejects(f.service.downloads([id("a")]), { code: "SPACE_INVALID_NAME" });
  await assert.rejects(f.service.downloads(["../file"]), { code: "SPACE_INVALID_ID" });
  assert.deepEqual(f.service.snapshot().tasks, []); assert.deepEqual(await readdir(f.destination), []);
});
