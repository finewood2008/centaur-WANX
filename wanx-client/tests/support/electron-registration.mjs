import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { createAccount } from "../../account/index.mjs";
import { createPlatformClient } from "../../platform.mjs";
import { registerControlActions } from "../../shell/control.mjs";

let window, client, saved = null, sendError = null, registerError = null;
const calls = [], rendererErrors = [];
const reply = data => new Response(JSON.stringify({ code: 200, data }));
async function verifyRegistration() {
try {
  await app.whenReady();
  ipcMain.handle("wanx:discovery:bluetooth-state", () => ({ status: "available" }));
  const account = createAccount({
    store: { load: async () => saved, save: async value => { saved = structuredClone(value); }, clear: async () => { saved = null; } },
    fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      calls.push({ path: new URL(url).pathname, body });
      if (url.endsWith('/sms/send')) {
        assert.equal(body.scene, 'consumer_register');
        await new Promise(resolve => setTimeout(resolve, 100));
        if (sendError) return new Response(JSON.stringify(sendError === 'SMS_DAILY_LIMIT' ? { code: 602 } : { code: 400, data: { errorCode: sendError }, msg: 'private server detail' }));
        return reply({ expiresIn: 300, debugCode: 'must-not-reach-renderer' });
      }
      if (url.endsWith('/password/register')) {
        assert.equal(body.phone, '13800138000');
        assert.equal(body.password, ' test-password ');
        assert.equal(body.code, '000001');
        assert.match(body.clientPublicKey, /PUBLIC KEY/);
        assert.equal(body.confirmPassword, undefined);
        await new Promise(resolve => setTimeout(resolve, 100));
        if (registerError) return new Response(JSON.stringify({ code: 400, data: { errorCode: registerError }, msg: 'private server detail' }));
        return reply({ accountId: 'test-account', clientId: body.clientId, accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 3600 });
      }
      if (url.endsWith('/devices')) return reply([]);
      throw Error(`Unexpected test request: ${new URL(url).pathname}`);
    },
  });
  client = createPlatformClient({ account, readPreference: async () => false });
  await client.initialize();
  const index = new URL('../../local-ui/renderer/index.html', import.meta.url);
  window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    preload: fileURLToPath(new URL('../../local-ui/remote-preload.cjs', import.meta.url)),
    contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  registerControlActions({ ipcMain, control: window, controlURL: index.href, client,
    market: { list: async () => ({ items: [] }) },
  });
  client.subscribe(state => window.webContents.send('wanx-client:state', state));
  await window.loadFile(fileURLToPath(index));
  const js = source => window.webContents.executeJavaScript(source);
  await js(`
    window.check = (condition, message) => { if (!condition) throw Error(message); };
    window.until = async predicate => {
      for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
      throw Error('UI did not reach expected state');
    };
    window.field = name => document.querySelector('[name="' + name + '"]');
    window.click = action => document.querySelector('[data-action="' + action + '"]').click();
    window.fill = (name, value) => { field(name).value = value; field(name).dispatchEvent(new Event('input', { bubbles: true })); };
    window.submit = () => document.querySelector('#auth-form').requestSubmit();
    window.idle = () => !document.querySelector('[type="submit"]')?.disabled;
    window.codeButton = () => document.querySelector('[data-action="send-registration-code"]');
    window.clockOffset = 0;
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + window.clockOffset;
    void 0;
  `);
  await js(`(async () => {
    await until(() => !!document.querySelector('[data-action="auth-register"]'));
    click('auth-register');
    check(field('confirmPassword').required, 'missing required confirmation');
    fill('username', 'bad'); click('send-registration-code');
    check(document.body.textContent.includes('11 位手机号'), 'invalid phone was not rejected');
    fill('username', '13800138000'); fill('password', ' test-password ');
    fill('confirmPassword', 'different-password'); fill('code', '000001');
    submit();
    check(document.body.textContent.includes('两次输入的密码不一致'), 'mismatch was not rejected');
    check(field('password').value === ' test-password ', 'validation erased password');
    fill('confirmPassword', ' test-password ');
  })()`);
  assert.equal(calls.length, 0);

  sendError = 'SMS_DAILY_LIMIT';
  await js(`(async () => {
    click('send-registration-code'); await until(idle);
    check(document.body.textContent.includes('今日验证码发送次数已达上限'), 'SMS failure not localized');
    check(!codeButton().disabled, 'failed send incorrectly starts countdown');
    check(field('password').value === ' test-password ', 'SMS failure erased password');
  })()`);
  sendError = null;
  await js(`(async () => {
    click('send-registration-code'); click('send-registration-code');
    check(codeButton().disabled, 'sending button not disabled');
    click('auth-login');
    check(!!field('confirmPassword'), 'tab changed during SMS send');
    await until(idle);
    check(/60.*后重新获取/.test(codeButton().textContent), 'countdown did not start at 60');
    check(field('password').value === ' test-password ', 'send erased password');
    check(field('confirmPassword').value === ' test-password ', 'send erased confirmation');
    check(field('code').value === '000001', 'send erased code');
    const input = field('password'); input.focus(); input.setSelectionRange(3, 5);
    await new Promise(resolve => setTimeout(resolve, 1100));
    check(/59.*后重新获取/.test(codeButton().textContent), 'countdown not ticking');
    check(field('password') === input && document.activeElement === input, 'timer replaced input or stole focus');
  })()`);
  assert.equal(calls.filter(c => c.path.endsWith('/sms/send')).length, 2);
  window.setSize(900, 620);
  await js(`(async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    const form = document.querySelector('#auth-form').getBoundingClientRect();
    check(codeButton().getBoundingClientRect().right <= form.right + 1, 'countdown overflows the form at minimum window width');
    check(document.documentElement.scrollWidth <= innerWidth, 'registration page overflows horizontally');
  })()`);
  window.setSize(1180, 760);
  window.webContents.send('wanx-client:state', client.snapshot());
  await js(`(async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    check(field('password').value === ' test-password ', 'state update erased password');
    check(document.activeElement === field('password'), 'state update lost focus');
    check(field('password').selectionStart === 3 && field('password').selectionEnd === 5, 'state update lost cursor');
    check(!document.querySelector('#app').innerHTML.includes('test-password'), 'password leaked into HTML');
    click('auth-login'); click('auth-register');
    check(codeButton().disabled, 'tab switch bypassed cooldown');
    check(field('password').value === '', 'mode change retained password');
    window.clockOffset += 61000;
    await until(() => !codeButton().disabled);
    check(codeButton().textContent === '获取验证码', 'expired countdown not reset');
    fill('password', ' test-password '); fill('confirmPassword', ' test-password '); fill('code', '000001');
  })()`);
  registerError = 'SMS_CODE_INVALID';
  await js(`(async () => {
    submit(); submit(); await until(idle);
    check(document.body.textContent.includes('验证码错误或已过期'), 'invalid code not localized');
    check(field('password').value === ' test-password ' && field('code').value === '000001', 'failed registration erased input');
  })()`);
  assert.equal(calls.filter(c => c.path.endsWith('/password/register')).length, 1);
  registerError = 'PASSWORD_ALREADY_SET';
  await js(`(async () => {
    submit(); await until(idle);
    check(document.body.textContent.includes('该手机号已注册'), 'duplicate account not localized');
  })()`);
  registerError = null;
  if (process.env.WANX_REGISTRATION_SCREENSHOT) {
    await writeFile(process.env.WANX_REGISTRATION_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
  }
  await js(`(async () => {
    submit();
    await until(() => document.body.textContent.includes('我的应用'));
    check(!field('password'), 'credentials remain after success');
    check(!document.body.textContent.includes('test-access'), 'token exposed');
  })()`);
  assert.equal(account.snapshot().phase, 'authenticated');
  assert.equal(saved.active.session.accountId, 'test-account');
  assert.deepEqual(rendererErrors, []);
  console.log('REGISTRATION_ELECTRON_PASS: validation, IPC, SMS errors, countdown, duplicate clicks, focus, polling, registration errors, session persistence and application home');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await client?.close();
  window?.destroy();
  app.exit(process.exitCode || 0);
}
}
void verifyRegistration();
