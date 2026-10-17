import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createSpaceLinkBridge } from "../shell/space-links.mjs";

const get = (url, options = {}) => fetch(url, { ...options, headers: { Connection: "close", ...options.headers } });
function fixture() {
  let saved = null, calls = [], listener, box = "box-a", account = "a";
  const client = { snapshot: () => ({ phase: "ready", account: { phase: account ? "authenticated" : "out", accountId: account }, connection: { deviceId: box } }),
    subscribe(fn) { listener = fn; return () => {}; },
    applicationConnection: async () => ({ context() {}, request: async input => {
      calls.push(input);
      const value = input.path.endsWith("/agent-links") && input.method === "POST" ? { id: "a".repeat(32), token: "backend-secret", root: "b".repeat(32), expires: null }
        : input.path.endsWith("/agent-links") ? [{ id: "a".repeat(32), root: "b".repeat(32) }] : { id: "b".repeat(32), kind: "file", version: 1 };
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)) };
    } }),
  };
  return { client, store: { load: async () => saved, save: async value => { saved = structuredClone(value); } },
    serviceURL: "https://consumer.test", calls, get saved() { return saved; },
    change(newBox = box, newAccount = account) { box = newBox; account = newAccount; listener(); } };
}
test("stable local link, restart, logout, box binding, revocation, origin and method boundary", async t => {
  const f = fixture(); let bridge = await createSpaceLinkBridge(f); t.after(() => bridge.close());
  const link = await bridge.manage("create", { root: "b".repeat(32) });
  assert.equal((await get(link.url)).status, 200);
  assert.equal((await get(link.url, { headers: { Origin: "https://evil.test" } })).status, 403);
  assert.equal((await get(link.url + "?action=trash")).status, 405);
  assert.equal((await get(link.url, { method: "POST", body: "{}" })).status, 415);
  assert.equal((await get(link.url + "?owner=2")).status, 400);
  assert.ok(!JSON.stringify(await (await get(link.url)).json()).includes("backend-secret"));
  f.change("box-b"); assert.equal((await get(link.url)).status, 409);
  f.change("box-a", null); assert.equal((await get(link.url)).status, 503);
  f.change("box-a", "a"); assert.equal((await get(link.url)).status, 200);
  await bridge.close(); bridge = await createSpaceLinkBridge(f);
  assert.equal((await bridge.manage("list"))[0].url, link.url);
  assert.equal((await get(link.url)).status, 200);
  await bridge.manage("revoke", { id: link.id }); assert.equal((await get(link.url)).status, 403);
});
test("occupied persisted port fails without silently changing URLs", async t => {
  const f = fixture(), first = await createSpaceLinkBridge(f); t.after(() => first.close());
  const before = f.saved.port;
  await assert.rejects(createSpaceLinkBridge(f), /SPACE_LINK_PORT_IN_USE/);
  assert.equal(f.saved.port, before);
});
test("Host header rejects DNS rebinding and corrupt encrypted state fails closed", async t => {
  const f = fixture(), bridge = await createSpaceLinkBridge(f); t.after(() => bridge.close());
  const link = await bridge.manage("create", { root: "b".repeat(32) });
  const status = await new Promise((resolve, reject) => {
    http.get(link.url, { headers: { Host: "evil.test" } }, res => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
  assert.equal(status, 403);
  await assert.rejects(createSpaceLinkBridge({ ...f, store: { load: async () => ({ version: 2 }) } }), /SPACE_LINK_STORE_INVALID/);
});
