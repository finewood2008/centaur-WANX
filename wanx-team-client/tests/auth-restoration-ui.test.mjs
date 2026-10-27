import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { rendererEvents } from "./support/renderer-events.mjs";

const index = new URL("../local-ui/renderer/index.html", import.meta.url);
const html = await readFile(index, "utf8");
const source = (await Promise.all([...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(match => match[1]).filter(src => src !== "./device-setup.bundle.js")
  .map(src => readFile(new URL(src, index), "utf8")))).join("\n");
const state = phase => ({ route: "auth", phase, account: { phase } });

async function harness(initialPhase) {
  const events = rendererEvents(), calls = [];
  let current = state(initialPhase), onState, form, markup = "";
  // Model actual form replacement and retention, including the submit's initial
  // disabled attribute, so a later render cannot silently re-enable an old form.
  const app = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value;
      const auth = value.match(/<form\b[^>]*data-form="auth"[^>]*>([\s\S]*?)<\/form>/);
      if (!auth) { form = null; return; }
      const button = auth[1].match(/<button\b([^>]*type="submit"[^>]*)>([\s\S]*?)<\/button>/);
      const submit = {
        disabled: /\bdisabled\b/.test(button[1]),
        innerHTML: button[2], classList: { toggle() {} }, setAttribute() {},
        get textContent() { return this.innerHTML.replace(/<[^>]*>/g, ""); },
      };
      const authNotice = {};
      form = {
        dataset: { form: "auth", mode: value.match(/data-mode="([^"]+)"/)[1] },
        elements: { username: { value: "13800138000" }, password: { value: "password" }, remember: { checked: true } },
        contains: () => false, addEventListener() {},
        querySelector: selector => selector === 'button[type="submit"]' ? submit : selector === '[data-auth-notice]' ? authNotice : null,
        replaceWith: retained => { form = retained; },
      };
    },
    querySelector: selector => selector === '[data-form="auth"]' ? form : null,
    addEventListener: (name, fn, capture) => events.add(name, fn, capture),
  };
  vm.runInNewContext(source, {
    window: { addEventListener() {}, wanxClient: {
      getLocalState: async () => current,
      onLocalState: listener => { onState = listener; },
      getRememberedLogin: async () => ({ remember: true }),
      action: async (name, input) => { calls.push([name, input]); return { ok: true, state: current }; },
    } },
    document: { body: { dataset: {}, append() {} }, createElement: () => ({ dataset: {}, setAttribute() {} }),
      addEventListener() {}, querySelector: selector => selector === "#app" ? app : null },
    FormData: class { constructor(node) { return Object.entries(node.elements)
      .map(([name, input]) => [name, name === "remember" ? input.checked ? "on" : "" : input.value]); } },
    Date, setTimeout, clearTimeout, setInterval() {}, clearInterval() {}, TextEncoder,
  });
  await new Promise(resolve => setImmediate(resolve));
  return {
    calls, form: () => form, submitButton: () => form.querySelector('button[type="submit"]'),
    publish(phase) { current = state(phase); onState(current); },
    submit() { return events.get("submit")({ preventDefault() {}, target: form }); },
  };
}

test("restoring an account disables the initial login form without a local login request", async () => {
  const h = await harness("authenticating");
  assert.equal(h.submitButton().disabled, true);
  assert.match(h.submitButton().textContent, /正在登录|正在恢复/);
  assert.deepEqual(h.calls, []);
});

test("native form submission during account restoration cannot start another login", async () => {
  const h = await harness("authenticating");
  await h.submit();
  assert.deepEqual(h.calls, []);
});

test("retained login form stays disabled while restoring and permits retry after restoration fails", async () => {
  const h = await harness("signed_out"), original = h.form();
  assert.equal(h.submitButton().disabled, false);
  h.publish("authenticating");
  assert.equal(h.form(), original);
  assert.equal(h.submitButton().disabled, true);
  assert.match(h.submitButton().textContent, /正在登录|正在恢复/);
  h.publish("authenticating");
  assert.equal(h.form(), original);
  assert.equal(h.submitButton().disabled, true);
  await h.submit();
  assert.deepEqual(h.calls, []);
  h.publish("signed_out");
  assert.equal(h.form(), original);
  assert.equal(h.submitButton().disabled, false);
  assert.equal(h.submitButton().textContent, "登录并进入");
  await h.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [["auth.login", {
    username: "13800138000", password: "password", remember: true,
  }]]);
});
