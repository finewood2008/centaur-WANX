import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createCreditsReader } from "../account/credits.mjs";
import { registerControlActions } from "../shell/control.mjs";

test("unconfigured credits reads resolve as unavailable across startup IPC channels", async () => {
  const handlers = new Map();
  const controlURL = "file:///wanx/management.html";
  const panelURL = "file:///wanx/panel.html";
  const window = url => ({ isDestroyed: () => false, webContents: { mainFrame: { url } } });
  const control = window(controlURL), panel = window(panelURL);
  const client = { snapshot: () => ({ account: { phase: "authenticated", accountId: "a", clientId: "c" } }) };
  registerControlActions({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    control, controlURL, panel, panelURL, client,
    credits: createCreditsReader({ client }),
  });
  for (const [name, sender] of [
    ["panel-balance", panel],
    ["credits-balance", control],
    ["credits-transactions", control],
  ]) {
    const event = { sender: sender.webContents, senderFrame: sender.webContents.mainFrame };
    assert.deepEqual(await handlers.get(`wanx-client:${name}`)(event),
      { ok: false, code: "CREDITS_NOT_CONFIGURED" }, name);
  }
});

test("preload maps the unavailable IPC result to the existing credits error without inventing a zero balance", async () => {
  const source = await readFile(new URL("../local-ui/remote-preload.cjs", import.meta.url), "utf8");
  const exposed = {};
  const rawState = { account: { phase: "authenticated", accountId: "a", clientId: "c" } };
  const responses = new Map([
    ["wanx-client:credits-balance", { ok: false, code: "CREDITS_NOT_CONFIGURED" }],
    ["wanx-client:credits-transactions", { ok: false, code: "CREDITS_NOT_CONFIGURED" }],
  ]);
  vm.runInNewContext(source, {
    process: { platform: "darwin" },
    require: () => ({
      contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value; } },
      ipcRenderer: {
        on() {},
        invoke: async name => name === "wanx-client:get-state" ? rawState : responses.get(name),
      },
    }),
  });
  for (const action of ["credits.balance", "credits.transactions"]) {
    const result = await exposed.wanxClient.action(action);
    assert.equal(result.ok, false);
    assert.equal(result.code, "CREDITS_NOT_CONFIGURED");
  }
  responses.set("wanx-client:credits-balance", { available: 0, held: 0, paid_available: 0, gift_available: 0 });
  const zero = await exposed.wanxClient.action("credits.balance");
  assert.equal(zero.ok, true);
  assert.equal(zero.value.available, 0);
});
