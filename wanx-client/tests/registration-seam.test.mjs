import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const index = new URL("../local-ui/renderer/index.html", import.meta.url);
const html = await readFile(index, "utf8");
const source = (await Promise.all([...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(match => match[1]).filter(src => src !== "./device-setup.bundle.js")
  .map(src => readFile(new URL(src, index), "utf8")))).join("\n");

async function harness(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const events = new Map(), calls = [];
  const app = { innerHTML: "", addEventListener: (name, fn) => events.set(name, fn) };
  const state = { route: "auth", phase: "signed_out" };
  const button = { disabled: false, textContent: "获取验证码" };
  const inputs = { "#account-name": { value: "13800138000" }, '[data-action="send-registration-code"]': button };
  vm.runInNewContext(source, {
    window: { wanxClient: {
      getLocalState: async () => state,
      onLocalState() {},
      action: async (name, input) => { calls.push([name, input]); return options.action ? options.action(name, input) : { ok: true, value: { expiresIn: 300 }, state }; },
    } },
    document: { querySelector: selector => selector === "#app" ? app : inputs[selector] || null },
    FormData: class { constructor(form) { return Object.entries(form.values || {}); } },
    Date, setTimeout, clearTimeout, TextEncoder,
  });
  await new Promise(resolve => setImmediate(resolve));
  return {
    app, calls, inputs, button,
    click(action) { return events.get("click")({ target: { closest: () => ({ dataset: { action } }) } }); },
    submit(values) { return events.get("submit")({ preventDefault() {}, target: { dataset: { form: "auth" }, values } }); },
  };
}

test("registration requires a matching confirmation before submitting", async t => {
  const h = await harness(t);
  await h.click("auth-register");
  assert.match(h.app.innerHTML, /name="confirmPassword"/);
  await h.submit({ username: "13800138000", password: "password-one", confirmPassword: "password-two", code: "123456" });
  assert.equal(h.calls.length, 0);
  assert.match(h.app.innerHTML, /两次输入的密码不一致/);
});

test("registration SMS starts a resend countdown and blocks duplicate sends", async t => {
  const h = await harness(t);
  await h.click("auth-register");
  await h.click("send-registration-code");
  assert.match(h.app.innerHTML, /60.*后重新获取/);
  await h.click("send-registration-code");
  assert.equal(h.calls.length, 1);
  t.mock.timers.tick(1000);
  assert.equal(h.button.textContent, "59 秒后重新获取");
  await h.click("auth-login");
  await h.click("auth-register");
  assert.match(h.app.innerHTML, /59.*后重新获取/);
  t.mock.timers.tick(59000);
  assert.equal(h.button.disabled, false);
  assert.equal(h.button.textContent, "获取验证码");
  await h.click("send-registration-code");
  assert.equal(h.calls.length, 2);
});

test("SMS failures allow retries and rate limits start a cooldown", async t => {
  let code = "ACCOUNT_NETWORK_ERROR";
  const h = await harness(t, { action: () => ({ ok: false, code }) });
  await h.click("auth-register");
  await h.click("send-registration-code");
  assert.match(h.app.innerHTML, /无法连接账号服务/);
  assert.doesNotMatch(h.app.innerHTML, /秒后重新获取/);
  code = "SMS_RATE_LIMITED";
  await h.click("send-registration-code");
  assert.match(h.app.innerHTML, /60 秒后重新获取/);
  await h.click("send-registration-code");
  assert.equal(h.calls.length, 2);
});

test("registration blocks malformed inputs and sends only its public fields", async t => {
  const h = await harness(t);
  await h.click("auth-register");
  const valid = { username: " 13800138000 ", password: " 密码密码 ", confirmPassword: " 密码密码 ", code: "000001" };
  for (const patch of [
    { username: "bad" }, { password: "short" }, { password: "密".repeat(25) },
    { confirmPassword: "" }, { code: "12345" },
  ]) await h.submit({ ...valid, ...patch });
  assert.equal(h.calls.length, 0);
  await h.submit({ ...valid, role: "admin" });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [["auth.register", {
    username: "13800138000", password: " 密码密码 ", code: "000001",
  }]]);
});

test("in-flight SMS prevents a second request and tab changes", async t => {
  let finish;
  const h = await harness(t, { action: () => new Promise(resolve => { finish = resolve; }) });
  await h.click("auth-register");
  const sending = h.click("send-registration-code");
  await h.click("send-registration-code");
  await h.click("auth-login");
  assert.match(h.app.innerHTML, /确认密码/);
  assert.equal(h.calls.length, 1);
  finish({ ok: true });
  await sending;
  assert.match(h.app.innerHTML, /60 秒后重新获取/);
});

test("preload forwards registration and pins the registration SMS IPC", async () => {
  const calls = [], window = {};
  const preload = await readFile(new URL('../local-ui/remote-preload.cjs', import.meta.url), 'utf8');
  vm.runInNewContext(preload, { process: { platform: "win32" }, require: () => ({
    contextBridge: { exposeInMainWorld: (name, api) => { window[name] = api; } },
    ipcRenderer: { on() {}, invoke: async (name, input) => {
      calls.push([name, input]);
      return name === 'wanx-client:get-state' ? { account: { phase: 'signed_out' } } : {};
    } },
  }) });
  await window.wanxClient.action('auth.send-code', { username: '13800138000', scene: 'admin' });
  const response = await window.wanxClient.action('auth.register', { username: '13800138000', password: 'password', code: '000001', role: 'admin', confirmPassword: 'password' });
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(([name]) => name !== 'wanx-client:get-state'))), [
    ['wanx-client:send-registration-code', { phone: '13800138000' }],
    ['wanx-client:register', { phone: '13800138000', password: 'password', code: '000001' }],
  ]);
});
