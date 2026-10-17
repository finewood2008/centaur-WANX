import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerControlActions } from "../shell/control.mjs";
import { registerShutdown } from "../shell/shutdown.mjs";
import { createAccount } from "../account/index.mjs";

test("update IPC is restricted to the trusted management frame and explicit install confirmation", async () => {
  const handlers = new Map(), calls = [];
  const controlURL = "file:///trusted/index.html";
  const frame = { url: controlURL }, webContents = { mainFrame: frame };
  const control = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: frame };
  registerControlActions({ ipcMain: { handle: (name, action) => handlers.set(name, action) }, control, controlURL,
    client: { snapshot: () => ({ account: { phase: "authenticated" } }) },
    updates: { client: { install: input => calls.push(input) } } });
  const install = handlers.get("wanx-client:updates-client-install");
  assert.throws(() => install({ ...event, senderFrame: { url: controlURL } }, { confirmed: true }));
  assert.throws(() => install(event, {}), /UPDATE_CONFIRMATION_REQUIRED/);
  await install(event, { confirmed: true });
  assert.deepEqual(calls, [{ confirmed: true }]);
});

test("updater installation runs only after application and Host shutdown, without a plain quit", async () => {
  const events = [], app = new EventEmitter(); app.quit = () => events.push("quit");
  const shutdown = registerShutdown({ app, closeApplications: async () => events.push("apps"), closeHost: async () => events.push("host"), onError: assert.fail });
  await shutdown.requestInstall(() => events.push("install"));
  assert.deepEqual(events, ["apps", "host", "install"]);
  let prevented = false; app.emit("before-quit", { preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});

test("account exposes only allowlisted upgrade codes and keeps arbitrary server messages private", async () => {
  let response, saved;
  const account = createAccount({ store: { load: async () => null, save: async data => { saved = data; }, clear: async () => {} },
    fetch: async (url, options) => {
      if (url.endsWith("/login")) return new Response(JSON.stringify({ code: 200, data: { accountId: "account-1", clientId: JSON.parse(options.body).clientId, accessToken: "secret", refreshToken: "refresh", expiresIn: 3600 } }));
      return response;
    } });
  await account.loginPassword({ phone: "13800138000", password: "password" });
  assert.ok(saved);
  for (const code of ["PLAN_STALE", "UPDATE_PERMISSION_REQUIRED", "INVENTORY_STALE", "RELEASE_WITHDRAWN"]) {
    response = new Response(JSON.stringify({ success: false, code: 409, errorCode: code, msg: "private credential" }), { status: 409 });
    await assert.rejects(account.request({ method: "POST", path: "/app-api/v1/upgrades/plans", body: {} }), { code, message: code });
  }
  response = new Response(JSON.stringify({ success: false, code: 409, errorCode: "PRIVATE_SECRET", msg: "private credential" }), { status: 409 });
  await assert.rejects(account.request({ path: "/app-api/v1/upgrades/devices/box" }), { code: "ACCOUNT_REQUEST_FAILED" });
  response = new Response("<html>404</html>", { status: 404 });
  await assert.rejects(account.request({ path: "/app-api/v1/upgrades/devices/box" }), { code: "UPDATE_SERVICE_NOT_DEPLOYED" });
});
