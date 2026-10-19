import test from "node:test";
import assert from "node:assert/strict";
import { registerControlActions } from "../shell/control.mjs";
import { createCreditWallet } from "../account/credit-wallet.mjs";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

test("wallet IPC allows trusted control without a box and serializes safe contract errors", async () => {
  const handlers = new Map();
  const url = "file:///client/index.html", frame = { url }, contents = { mainFrame: frame };
  const sent = [];
  const wallet = createCreditWallet({ request: async input => {
    sent.push(input);
    throw Object.assign(new Error("private server text"), { code: "ORDER_IN_PROGRESS", status: 409,
      request_id: "req-conflict", retryable: false, details: { blocking_order_ids: ["order-1"] } });
  } });
  registerControlActions({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    control: { webContents: contents, isDestroyed: () => false }, controlURL: url,
    client: { snapshot: () => ({ account: { phase: "authenticated" }, phase: "idle" }) }, creditWallet: wallet });
  const create = handlers.get("wanx-client:wallet-createOrder");
  assert.equal(typeof create, "function");
  assert.throws(() => create({ sender: {}, senderFrame: frame }, {}), /无权/);
  const result = await create({ sender: contents, senderFrame: frame }, { amount_fen: 5000, purchase_intent_id: "buy-1" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ORDER_IN_PROGRESS");
  assert.equal(result.error.request_id, "req-conflict");
  assert.deepEqual(result.error.details.blocking_order_ids, ["order-1"]);
  assert.doesNotMatch(JSON.stringify(result), /private server|Authorization|accessToken/);
  const injection = await create({ sender: contents, senderFrame: frame },
    { amount_fen: 5000, purchase_intent_id: "buy-2", url: "https://other.invalid" });
  assert.equal(injection.error.code, "CREDITS_INVALID_INPUT");
  assert.equal(sent.length, 1);
});

test("preload action retains wallet support ID and recovery order IDs", async () => {
  let exposed;
  const source = await readFile(new URL("../local-ui/remote-preload.cjs", import.meta.url), "utf8");
  vm.runInNewContext(source, { process: { platform: process.platform }, require: () => ({
    contextBridge: { exposeInMainWorld: (name, api) => { if (name === "wanxClient") exposed = api; } }, webUtils: {},
    ipcRenderer: { on() {}, invoke: async name => name === "wanx-client:get-state" ? { account: { phase: "authenticated" } } :
      { ok: false, error: { code: "ORDER_IN_PROGRESS", request_id: "request-123", status: 409,
        retryable: false, details: { blocking_order_ids: ["order-1"] } } } },
  }) });
  const result = await exposed.action("wallet.createOrder", { amount_fen: 5000, purchase_intent_id: "buy" });
  assert.equal(result.request_id, "request-123");
  assert.equal(result.details.blocking_order_ids[0], "order-1");
});
