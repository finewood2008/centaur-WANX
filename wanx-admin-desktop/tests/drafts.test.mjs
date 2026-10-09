import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDraftStore, validateProductDraft } from "../shell/drafts.mjs";
test("本机产品草稿在盒子、用户、产品之间隔离，重开后可恢复", async t => {
  const directory = await mkdtemp(join(tmpdir(), "wanx-admin-draft-test-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "product-drafts.json"), store = createDraftStore(file), scope = { boxId: "box-a", userId: 1, applicationId: "product.one" };
  const product = { application_id: "product.one", name: "草稿", capabilities: ["memory"], agent_template: {}, resource_requirements: {} };
  await store.put(scope, product);
  assert.deepEqual((await createDraftStore(file).get(scope)).product, product);
  await Promise.all([store.put({ ...scope, applicationId: "other.a" }, { name: "A" }), store.put({ ...scope, applicationId: "other.b" }, { name: "B" })]);
  assert.equal((await store.get({ ...scope, applicationId: "other.a" })).product.name, "A");
  assert.equal((await store.get({ ...scope, applicationId: "other.b" })).product.name, "B");
  for (const other of [{ ...scope, boxId: "box-b" }, { ...scope, userId: 2 }, { ...scope, applicationId: "product.two" }]) assert.equal(await store.get(other), null);
});
test("本机草稿拒绝凭据、密钥和不属于产品定义的字段", () => {
  for (const value of [{ name: "test", token: "secret" }, { name: "test", agent_template: { provider: { api_key: "secret" } } }, { name: "test", resource_requirements: { secret_key: "secret" } }, { name: "test", agent_template: { serialized: '{"api_key":"secret"}' } }]) assert.throws(() => validateProductDraft(value), /草稿/);
  assert.equal(validateProductDraft({ name: "允许不完整草稿", agent_template: {}, resource_requirements: {} }).name, "允许不完整草稿");
});
