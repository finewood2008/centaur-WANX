import { test } from "node:test";
import assert from "node:assert/strict";
import { SelectionGuard } from "../src/selection.mjs";
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
test("产品 A 慢响应不覆盖产品 B 部署表单，保存只提交 B 的配置", async () => {
  const guard = new SelectionGuard(), first = deferred(), second = deferred(); let form, selected = "A";
  const read = async (id, request) => { const current = guard.begin(id); const value = await request.promise; if (current()) form = value; };
  const a = read("A", first); selected = "B"; guard.select(selected); const b = read("B", second);
  second.resolve({ model: "B-model" }); await b; first.resolve({ model: "A-model" }); await a;
  assert.deepEqual({ applicationId: selected, body: form }, { applicationId: "B", body: { model: "B-model" } });
});
test("模型提供方慢响应不覆盖已切换的存储列表，旧 editor 不可重新激活", async () => {
  const guard = new SelectionGuard(), providers = deferred(), storage = deferred(); let rows = [], editor;
  const read = async (section, request) => { const current = guard.begin(section); const value = await request.promise; if (current()) rows = value; };
  const a = read("providers", providers); editor = { id: "provider-A" };
  guard.select("storage"); editor = undefined; const b = read("storage", storage);
  storage.resolve([{ id: "storage-B" }]); await b; providers.resolve([{ id: "provider-A" }]); await a;
  assert.deepEqual(rows, [{ id: "storage-B" }]); assert.equal(editor, undefined);
});
test("同一选择只使用最近读取结果，卸载或切盒使所有旧响应失效", () => {
  const guard = new SelectionGuard(); const first = guard.begin("box1:product"); const next = guard.begin("box1:product"); assert.equal(first(), false); assert.equal(next(), true);
  guard.select("box2:product"); assert.equal(next(), false); const last = guard.begin("box2:product"); guard.invalidate(); assert.equal(last(), false);
});
