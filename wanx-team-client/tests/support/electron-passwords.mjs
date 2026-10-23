import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { createAccount } from "../../account/index.mjs";
import { createPlatformClient } from "../../platform.mjs";
import { registerControlActions } from "../../shell/control.mjs";

let window, client, saved = null, sendError = null, resetError = null;
const calls = [], rendererErrors = [];
const reply = data => new Response(JSON.stringify({ code: 200, data }));
const rejected = code => new Response(JSON.stringify({ code: 400, data: { errorCode: code }, msg: "private server detail" }));

async function verifyPasswords() {
  try {
    await app.whenReady();
    ipcMain.handle("wanx:discovery:bluetooth-state", () => ({ status: "available" }));
    const account = createAccount({
      store: { load: async () => saved, save: async value => { saved = structuredClone(value); }, clear: async () => { saved = null; } },
      fetch: async (url, options) => {
        const body = options.body && JSON.parse(options.body);
        const path = new URL(url).pathname;
        calls.push({ path, body });
        if (path.endsWith("/sms/send")) {
          assert.equal(body.phone, "13800138000");
          assert.equal(body.scene, "consumer_reset_password");
          await new Promise(resolve => setTimeout(resolve, 100));
          return sendError ? rejected(sendError) : reply({ expiresIn: 300, debugCode: "must-not-reach-renderer" });
        }
        if (path.endsWith("/password/reset")) {
          assert.deepEqual(body, { phone: "13800138000", code: "000001", password: " new-password " });
          await new Promise(resolve => setTimeout(resolve, 100));
          return resetError ? rejected(resetError) : reply(null);
        }
        if (path.endsWith("/password/login")) {
          assert.equal(body.phone, "13800138000");
          assert.equal(body.password, " new-password ");
          return reply({ accountId: "test-account", clientId: body.clientId, accessToken: "test-access", refreshToken: "test-refresh", expiresIn: 3600 });
        }
        if (path.endsWith("/devices")) return reply([]);
        throw Error(`Unexpected test request: ${path}`);
      },
    });
    client = createPlatformClient({ account, readPreference: async () => false });
    await client.initialize();
    const index = new URL("../../local-ui/renderer/index.html", import.meta.url);
    window = new BrowserWindow({ show: false, width: 1180, height: 900, webPreferences: {
      preload: fileURLToPath(new URL("../../local-ui/remote-preload.cjs", import.meta.url)),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    } });
    window.webContents.on("console-message", event => { if (event.level === "error") rendererErrors.push(event.message); });
    registerControlActions({ ipcMain, control: window, controlURL: index.href, client, market: { list: async () => ({ items: [] }) } });
    client.subscribe(state => window.webContents.send("wanx-client:state", state));
    await window.loadFile(fileURLToPath(index));
    const js = source => window.webContents.executeJavaScript(source);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function nativeSubmit(between, form = "password-change") {
      const point = await js(`(() => {
        const button = document.querySelector('[data-form="${form}"] [type="submit"]');
        button.scrollIntoView({ block: 'center' });
        const rect = button.getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      })()`);
      window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      await pause(40);
      if (between) await between();
      window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      await pause(40);
    }
    await js(`
      window.check = (condition, message) => { if (!condition) throw Error(message); };
      window.until = async predicate => {
        for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
        throw Error('UI did not reach expected state');
      };
      window.field = name => document.querySelector('[name="' + name + '"]');
      window.click = action => document.querySelector('[data-action="' + action + '"]').click();
      window.fill = (name, value) => { field(name).value = value; field(name).dispatchEvent(new Event('input', { bubbles: true })); };
      window.submit = () => document.querySelector('form').requestSubmit();
      window.idle = () => !document.querySelector('[type="submit"]')?.disabled;
      window.codeButton = () => document.querySelector('[data-action="send-reset-code"], [data-action="send-change-code"]');
      window.passwordNotice = () => document.querySelector('[data-form="password-change"] [data-password-notice]');
      window.authNotice = () => document.querySelector('#auth-form [data-auth-notice]');
      window.checkAuthNotice = text => {
        const notice = authNotice(), form = document.querySelector('#auth-form');
        check(notice && !notice.hidden && notice.textContent.includes(text), 'auth feedback missing inside form: ' + text);
        check(form.querySelector('[type="submit"]').previousElementSibling === notice, 'auth feedback is not next to submit');
        check([...document.querySelectorAll('.notice')].filter(item => item.textContent.includes(text)).length === 1, 'auth feedback duplicated outside form');
      };
      window.checkPasswordNotice = text => {
        const notice = passwordNotice(), form = document.querySelector('[data-form="password-change"]');
        check(notice && !notice.hidden && notice.textContent.includes(text), 'password feedback missing inside form: ' + text);
        check(form.querySelector('.settings-actions').previousElementSibling === notice, 'password feedback is not next to submit actions');
        check([...document.querySelectorAll('.notice')].filter(item => item.textContent.includes(text)).length === 1, 'password feedback duplicated outside form');
      };
      void 0;
    `);
    await js(`(async () => {
      await until(() => !!document.querySelector('[data-action="auth-reset"]'));
      click('auth-reset');
      check(document.querySelector('h1').textContent === '找回密码', 'recovery page missing');
      fill('username', 'bad'); click('send-reset-code');
      check(document.body.textContent.includes('11 位手机号'), 'invalid phone was not rejected');
      fill('username', '13800138000'); fill('password', 'short'); fill('confirmPassword', 'short'); fill('code', '000001');
      submit(); check(document.body.textContent.includes('8–72 字节'), 'weak password was not rejected');
      fill('password', ' new-password '); fill('confirmPassword', 'different-password');
      submit(); check(document.body.textContent.includes('两次输入的密码不一致'), 'mismatch was not rejected');
      fill('confirmPassword', ' new-password ');
    })()`);
    assert.equal(calls.length, 0);
    sendError = "SMS_CODE_INVALID";
    await js(`(async () => {
      click('send-reset-code'); await until(idle);
      check(!codeButton().disabled, 'failed send incorrectly starts cooldown');
      check(field('password').value === ' new-password ', 'send error erased password');
    })()`);
    sendError = null;
    await js(`(async () => {
      click('send-reset-code'); click('send-reset-code');
      check(codeButton().disabled, 'sending button not disabled');
      click('auth-login'); check(!!field('confirmPassword'), 'navigation changed during send');
      await until(idle);
      check(/60.*后重新获取/.test(codeButton().textContent), 'cooldown not shown');
      checkAuthNotice('验证码已发送');
      check(!document.body.textContent.includes('must-not-reach-renderer'), 'debug code exposed');
      field('password').focus(); field('password').setSelectionRange(3, 5);
    })()`);
    assert.equal(calls.filter(call => call.path.endsWith("/sms/send")).length, 2);
    window.setSize(900, 620);
    await pause(100);
    for (const code of ["", "123", "abcdef"]) {
      await js(`fill('code', ${JSON.stringify(code)})`);
      await nativeSubmit(undefined, "auth");
      await js(`(() => {
        checkAuthNotice('请输入 6 位短信验证码');
        check(field('password').value === ' new-password ', 'invalid recovery code erased password');
        check(codeButton().disabled, 'invalid recovery code reset SMS cooldown');
        const rect = authNotice().getBoundingClientRect();
        check(rect.top >= 0 && rect.bottom <= innerHeight, 'recovery feedback is outside the small-window viewport');
      })()`);
      window.webContents.send("wanx-client:state", client.snapshot());
      await pause(50);
      await js(`checkAuthNotice('请输入 6 位短信验证码')`);
    }
    assert.equal(calls.filter(call => call.path.endsWith("/password/reset")).length, 0,
      "empty or malformed recovery codes must not call the server");
    if (process.env.WANX_PASSWORD_SCREENSHOTS) await writeFile("/tmp/wanx-password-recovery-code-validation.png", (await window.webContents.capturePage()).toPNG());
    window.setSize(1180, 900);
    await js(`fill('code', '000001'); field('password').focus(); field('password').setSelectionRange(3, 5); void 0;`);
    window.webContents.send("wanx-client:state", client.snapshot());
    await js(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      check(field('password').value === ' new-password ', 'broadcast erased password');
      check(document.activeElement === field('password'), 'broadcast lost focus');
      check(field('password').selectionStart === 3 && field('password').selectionEnd === 5, 'broadcast lost selection');
      check(!document.querySelector('#app').innerHTML.includes('new-password '), 'password leaked into HTML');
    })()`);
    resetError = "SMS_CODE_INVALID";
    await js(`(async () => {
      submit(); submit(); await until(idle);
      checkAuthNotice('验证码错误或已过期');
      check(field('password').value === ' new-password ' && field('code').value === '000001', 'reset failure erased inputs');
    })()`);
    assert.equal(calls.filter(call => call.path.endsWith("/password/reset")).length, 1);
    resetError = null;
    if (process.env.WANX_PASSWORD_SCREENSHOTS) await writeFile("/tmp/wanx-password-recovery.png", (await window.webContents.capturePage()).toPNG());
    await js(`(async () => {
      submit(); await until(() => document.body.textContent.includes('密码重置成功'));
      check(!field('confirmPassword') && !field('code'), 'recovery secrets remain after success');
      check(field('password').value === '', 'password remains after reset');
      check(field('username').value === '13800138000', 'recovery lost login phone');
      fill('password', ' new-password '); submit();
      await until(() => !!document.querySelector('[data-action="show-settings"]'));
      click('show-settings'); click('password-open');
      check(document.body.textContent.includes('138****8000'), 'current account phone not masked');
      check(!field('username'), 'change allows overriding current account phone');
      window.invalidFields = []; window.changeSubmits = 0;
      document.addEventListener('invalid', event => invalidFields.push(event.target.name), true);
      document.addEventListener('submit', event => { if (event.target.dataset.form === 'password-change') changeSubmits++; }, true);
    })()`);
    const resetsBeforeValidation = calls.filter(call => call.path.endsWith("/password/reset")).length;
    for (const { input, message } of [
      { input: { password: "", confirmPassword: " new-password ", code: "000001" }, message: "请输入新密码" },
      { input: { password: " new-password ", confirmPassword: "", code: "000001" }, message: "请再次输入新密码" },
      { input: { password: " new-password ", confirmPassword: " new-password ", code: "" }, message: "请输入 6 位短信验证码" },
      { input: { password: " new-password ", confirmPassword: " new-password ", code: "123" }, message: "请输入 6 位短信验证码" },
    ]) {
      await js(`(() => { invalidFields = []; changeSubmits = 0; for (const [name,value] of Object.entries(${JSON.stringify(input)})) fill(name,value); })()`);
      await nativeSubmit();
      await js(`(() => {
        check(invalidFields.length === 0, 'native validation swallowed the submit event');
        check(changeSubmits === 1, 'first native click did not submit exactly once');
        checkPasswordNotice(${JSON.stringify(message)});
      })()`);
    }
    assert.equal(calls.filter(call => call.path.endsWith("/password/reset")).length, resetsBeforeValidation,
      "invalid input must not send password reset requests");
    await js(`(async () => {
      fill('password', ' new-password '); fill('confirmPassword', 'different-password'); fill('code', '000001');
      submit(); check(document.body.textContent.includes('两次输入的密码不一致'), 'change mismatch not rejected');
      fill('confirmPassword', ' new-password ');
      click('send-change-code'); click('send-change-code');
      check(codeButton().disabled, 'change sending button not disabled');
      await until(idle);
      check(/60.*后重新获取/.test(codeButton().textContent), 'change cooldown missing');
      check(field('password').value === ' new-password ', 'change SMS erased password');
      checkPasswordNotice('验证码已发送');
      field('password').focus(); field('password').setSelectionRange(3, 5);
    })()`);
    assert.equal(calls.filter(call => call.path.endsWith("/sms/send")).length, 3);
    window.webContents.send("wanx-client:state", client.snapshot());
    await js(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      check(field('password').value === ' new-password ' && document.activeElement === field('password'), 'change broadcast erased input or focus');
      check(field('password').selectionStart === 3 && field('password').selectionEnd === 5, 'change broadcast lost selection');
    })()`);
    window.setSize(900, 360);
    await js(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      window.changeInput = field('password');
      window.changeForm = document.querySelector('[data-form="password-change"]');
      changeInput.focus(); changeInput.setSelectionRange(3, 5);
      window.scrollTo(0, 0);
      await new Promise(resolve => requestAnimationFrame(resolve));
      check(changeInput.getBoundingClientRect().top >= innerHeight, 'small-window fixture does not put focused field outside viewport');
      check(window.scrollY === 0, 'manual scroll to page top failed');
    })()`);
    for (const phase of ["unavailable", "ready", "connecting", "unavailable"]) {
      const state = client.snapshot();
      window.webContents.send("wanx-client:state", { ...state, platform: { ...state.platform, phase }, network: { ...state.network, enabled: true, phase } });
      await js(`(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        check(Math.abs(window.scrollY) <= 1, 'background update pulled viewport back to focused password field');
        check(document.querySelector('[data-form="password-change"]') === changeForm, 'background update replaced password form');
        check(field('password') === changeInput && document.activeElement === changeInput, 'background update replaced input or lost focus');
        check(changeInput.selectionStart === 3 && changeInput.selectionEnd === 5, 'background update lost password selection');
        checkPasswordNotice('验证码已发送');
      })()`);
    }
    window.setSize(1180, 900);
    resetError = "SMS_CODE_INVALID";
    await nativeSubmit(async () => {
      const state = client.snapshot();
      window.webContents.send("wanx-client:state", { ...state, network: { ...state.network, enabled: true, phase: "failed" } });
      await pause(40);
    });
    await js(`(async () => {
      check(document.querySelector('[data-form="password-change"] [type="submit"]').textContent === '正在修改…', 'valid native click has no explicit busy feedback');
      check(!idle(), 'valid native click did not disable submit');
      submit();
      check(!passwordNotice()?.textContent.trim(), 'old SMS feedback remains during next request');
      await until(idle);
      checkPasswordNotice('验证码错误或已过期');
      check(field('password').value === ' new-password ' && field('code').value === '000001', 'change failure erased inputs');
    })()`);
    assert.equal(account.snapshot().phase, "authenticated");
    assert.equal(calls.filter(call => call.path.endsWith("/password/reset")).length, 3);
    resetError = null;
    if (process.env.WANX_PASSWORD_SCREENSHOTS) await writeFile("/tmp/wanx-password-change.png", (await window.webContents.capturePage()).toPNG());
    await nativeSubmit();
    await js(`(async () => {
      check(!passwordNotice()?.textContent.trim(), 'old error feedback remains during retry');
      await until(() => document.body.textContent.includes('密码修改成功'));
      check(document.querySelector('h1').textContent === '登录万象平台', 'change did not return to login');
      check(!field('confirmPassword') && !field('code'), 'change secrets remain after success');
      check(field('password').value === '', 'change password remains after success');
      check(idle(), 'login remains busy after password change');
      check(!document.body.textContent.includes('test-access'), 'access token exposed');
    })()`);
    assert.equal(account.snapshot().phase, "signed_out");
    assert.ok(!saved?.active?.session, "old session retained after password change");
    assert.equal(calls.filter(call => call.path.endsWith("/auth/logout")).length, 0);
    assert.deepEqual(rendererErrors, []);
    console.log("PASSWORDS_ELECTRON_PASS: recovery and authenticated change, native clicks/validation, SMS scene, duplicate guards, inline feedback, errors/retry, broadcast click/focus/scroll, secret clearing and local logout");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await client?.close();
    window?.destroy();
    app.exit(process.exitCode || 0);
  }
}
void verifyPasswords();
