import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createIdentitySecuritySettings } from "../shell/identity-security.mjs";
import { registerControlActions } from "../shell/control.mjs";
import { createUIBroadcast } from "../shell/ui-broadcast.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-identity-security-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, filePath: path.join(directory, "identity-security.json") };
}

test("identity security is disabled on first launch without creating a preference", async t => {
  const { directory, filePath } = await fixture(t);
  const settings = await createIdentitySecuritySettings({ filePath });
  assert.deepEqual(settings.snapshot(), { enabled: false, active: false, restartRequired: false });
  assert.deepEqual(await readdir(directory), []);
});

test("identity security changes persist but only become active after restart in both directions", async t => {
  const { directory, filePath } = await fixture(t);
  await writeFile(filePath, JSON.stringify({ version: 1, enabled: true }));
  const first = await createIdentitySecuritySettings({ filePath });
  assert.deepEqual(await first.set({ enabled: false }), { enabled: false, active: true, restartRequired: true });
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { version: 1, enabled: false });
  if (process.platform !== "win32") assert.equal((await stat(filePath)).mode & 0o077, 0);
  assert.deepEqual(await readdir(directory), ["identity-security.json"]);
  const second = await createIdentitySecuritySettings({ filePath });
  assert.deepEqual(second.snapshot(), { enabled: false, active: false, restartRequired: false });
  assert.deepEqual(await second.set({ enabled: true }), { enabled: true, active: false, restartRequired: true });
  const third = await createIdentitySecuritySettings({ filePath });
  assert.deepEqual(third.snapshot(), { enabled: true, active: true, restartRequired: false });
});

test("identity security rejects incomplete or extended requests without writing a setting", async t => {
  const { directory, filePath } = await fixture(t);
  const settings = await createIdentitySecuritySettings({ filePath });
  for (const input of [null, undefined, false, [], {}, { enabled: 0 }, { enabled: "false" }, { enabled: false, active: false }, Object.assign(Object.create({ enabled: false }), { other: true })]) {
    await assert.rejects(settings.set(input), { code: "IDENTITY_SECURITY_INVALID_INPUT" });
  }
  assert.deepEqual(settings.snapshot(), { enabled: false, active: false, restartRequired: false });
  assert.deepEqual(await readdir(directory), []);
});

test("invalid identity security configuration never silently disables the feature", async t => {
  const { filePath } = await fixture(t);
  for (const contents of ["invalid json", "null", "{}", '{"version":1,"enabled":0}', '{"version":2,"enabled":false}', '{"version":1,"enabled":false,"extra":true}']) {
    await writeFile(filePath, contents);
    await assert.rejects(createIdentitySecuritySettings({ filePath }), { code: "IDENTITY_SECURITY_CONFIG_INVALID" });
    assert.equal(await readFile(filePath, "utf8"), contents);
  }
});

test("failed identity security writes leave the saved and active state unchanged and can be retried", async t => {
  const { directory } = await fixture(t);
  const parent = path.join(directory, "preferences");
  const settings = await createIdentitySecuritySettings({ filePath: path.join(parent, "identity-security.json") });
  await writeFile(parent, "not a directory");
  await assert.rejects(settings.set({ enabled: true }), { code: "IDENTITY_SECURITY_WRITE_FAILED" });
  assert.deepEqual(settings.snapshot(), { enabled: false, active: false, restartRequired: false });
  await rm(parent);
  assert.deepEqual(await settings.set({ enabled: true }), { enabled: true, active: false, restartRequired: true });
});

test("identity security read failures do not default to an unverified setting", async t => {
  const { directory } = await fixture(t);
  const parent = path.join(directory, "not-a-directory");
  await writeFile(parent, "blocked");
  await assert.rejects(createIdentitySecuritySettings({ filePath: path.join(parent, "identity-security.json") }), { code: "IDENTITY_SECURITY_READ_FAILED" });
});

test("queued identity security changes preserve request order and cancelling a pending change needs no restart", async t => {
  const { filePath } = await fixture(t);
  await writeFile(filePath, JSON.stringify({ version: 1, enabled: true }));
  const settings = await createIdentitySecuritySettings({ filePath });
  const values = await Promise.all([settings.set({ enabled: false }), settings.set({ enabled: true })]);
  assert.deepEqual(values, [
    { enabled: false, active: true, restartRequired: true },
    { enabled: true, active: true, restartRequired: false },
  ]);
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).enabled, true);
});

test("identity security setting crosses the trusted preload and broadcasts restart state without switching the live mode", async t => {
  const { filePath } = await fixture(t);
  await writeFile(filePath, JSON.stringify({ version: 1, enabled: true }));
  const identitySecurity = await createIdentitySecuritySettings({ filePath });
  const controlURL = "file:///wanx/local-ui/renderer/index.html";
  const mainFrame = { url: controlURL };
  const sent = [], handlers = new Map(), exposed = {};
  const webContents = { mainFrame, isDestroyed: () => false, send: (channel, state) => sent.push([channel, state]) };
  const control = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: mainFrame };
  const client = { snapshot: () => ({ account: { phase: "authenticated" } }) };
  const broadcast = createUIBroadcast({
    client, identitySecurity, applications: { listInstalled: async () => [] },
    uiState: { snapshot: () => ({}) }, startup: { get: () => ({}) }, windows: () => [control],
  });
  t.after(() => broadcast.dispose());
  registerControlActions({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, control, controlURL,
    client, identitySecurity, getState: broadcast.getState, publishState: broadcast.publish,
  });
  const preload = await readFile(new URL("../local-ui/remote-preload.cjs", import.meta.url), "utf8");
  vm.runInNewContext(preload, { process: { platform: process.platform }, require: () => ({
    contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
    ipcRenderer: { invoke: async (channel, input) => handlers.get(channel)(event, input), on() {}, removeListener() {} },
  }) });
  const reply = await exposed.wanxClient.action("identity-security.set", { enabled: false });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.value, { enabled: false, active: true, restartRequired: true });
  assert.deepEqual(reply.state.identitySecurity, reply.value);
  assert.ok(sent.some(([channel, state]) => channel === "wanx-client:state" && state.identitySecurity.enabled === false && state.identitySecurity.active === true));
  const set = handlers.get("wanx-client:identity-security-set");
  for (const foreign of [{ sender: {}, senderFrame: mainFrame }, { sender: webContents, senderFrame: { url: controlURL } }]) {
    assert.throws(() => set(foreign, { enabled: true }), /此页面无权/);
  }
  mainFrame.url = "https://untrusted.example/";
  assert.throws(() => set(event, { enabled: true }), /此页面无权/);
  assert.equal(identitySecurity.snapshot().enabled, false);
});
