import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../local-ui/panel/panel.js", import.meta.url), "utf8");
const application = { applicationId: "centaurai.wanx.zhijun", name: "知君", version: "0.4.3" };
const devices = ["102", "103"].map(id => ({
  deviceId: `box-${id}`, displayName: `CentuarAI-AMD-${id}`, accessState: "ready", canOpen: true,
}));
const baseState = () => ({
  account: { phase: "authenticated", accountId: "account-1" },
  phase: "disconnected", platform: { phase: "ready" }, network: { phase: "ready", enabled: true },
  connection: null, devices: structuredClone(devices), applications: [{ ...application }],
  ui: { pendingOpen: null, applicationOperations: {}, lastDeviceId: "box-102" },
});
const pendingState = (phase = "confirm") => ({
  ...baseState(), ui: {
    pendingOpen: { id: "intent-1", applicationId: application.applicationId, deviceId: "box-102", phase },
    applicationOperations: {}, lastDeviceId: "box-102",
  },
});
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// The real renderer consumes the raw main-process snapshot; this fake DOM only
// models event delivery and the browser's selection of a <select> option.
async function harness(initial = baseState(), getBalance = async () => ({ available: 0 })) {
  let current = structuredClone(initial), markup = "", select = null, listener;
  const events = new Map(), documentEvents = new Map(), responses = new Map(), focusEvents = new Map(), calls = [];
  const root = {
    scrollHeight: 264,
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value;
      const contents = value.match(/<select id="target-box"[^>]*>([\s\S]*?)<\/select>/)?.[1];
      if (!contents) { select = null; return; }
      const options = [...contents.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
      select = { value: (options.find(option => /\bselected\b/.test(option[2])) || options[0])?.[1] || "" };
    },
    addEventListener(name, fn) { events.set(name, fn); },
    querySelector(selector) { return selector === "#target-box" ? select : null; },
  };
  const api = {
    getState: async () => structuredClone(current),
    getBalance: async () => { calls.push(["panel-balance"]); return getBalance(); },
    onState(fn) { listener = fn; },
    async action(name, input) {
      calls.push([name, input === undefined ? undefined : structuredClone(input)]);
      return responses.get(name)?.(input);
    },
  };
  vm.runInNewContext(source, {
    window: { wanxPanel: api, addEventListener: (name, fn) => focusEvents.set(name, fn) },
    document: {
      getElementById(id) { return id === "panel" ? root : null; },
      addEventListener(name, fn) { documentEvents.set(name, fn); },
    },
    requestAnimationFrame: callback => queueMicrotask(callback),
  });
  await settle();
  return {
    root, calls, get html() { return markup; },
    actions() { return calls.filter(([name]) => !["desktop-resize", "panel-balance"].includes(name)); },
    respond(name, fn) { responses.set(name, fn); },
    async focus() { focusEvents.get("focus")?.(); await settle(); },
    async update(value) { current = structuredClone(value); listener(current); await settle(); },
    async click(dataset, { disabled = false } = {}) {
      events.get("click")({ target: { closest: () => ({ dataset, disabled }) } });
      await settle();
    },
    changeTarget(value) {
      assert.ok(select, "a rendered box selector is required");
      select.value = value;
      events.get("change")({ target: { id: "target-box", value } });
    },
    async keydown(key) {
      let prevented = false;
      documentEvents.get("keydown")({ key, preventDefault() { prevented = true; } });
      await settle();
      return prevented;
    },
  };
}

test("panel focuses on applications and sends low-frequency box management to settings", async () => {
  const h = await harness();
  assert.match(h.html, /data-app="centaurai\.wanx\.zhijun"/);
  assert.doesNotMatch(h.html, /data-action="boxes"|data-device=|>管理盒子</);
  await h.click({ app: application.applicationId });
  assert.deepEqual(h.actions(), [["applications-request-open", { applicationId: application.applicationId }]]);
  await h.click({ page: "settings" });
  assert.deepEqual(h.actions().at(-1), ["desktop-open", { page: "settings" }]);
  assert.doesNotMatch(h.html, /<button[^>]*class="brand"|data-action="about"/);
  const before = h.actions().length;
  await h.click({ action: "about" });
  assert.equal(h.actions().length, before);
});

test("opening without a box requires explicit confirmation and cancellation forwards the current intent", async () => {
  const h = await harness();
  await h.click({ app: application.applicationId });
  assert.equal(h.actions().some(([name]) => name === "connect-box"), false);
  await h.update(pendingState());
  assert.match(h.html, /连接盒子并打开应用/);
  for (const device of devices) assert.ok(h.html.includes(device.displayName));
  h.changeTarget("box-103");
  await h.click({ action: "confirm" });
  assert.deepEqual(h.actions().at(-1), ["applications-confirm-open", { intentId: "intent-1", deviceId: "box-103" }]);
  await h.update(pendingState("connecting"));
  assert.match(h.html, /正在连接盒子/);
  assert.doesNotMatch(h.html, /data-action="confirm"/);
  await h.click({ action: "cancel" });
  assert.deepEqual(h.actions().at(-1), ["applications-cancel-open", { intentId: "intent-1" }]);
  await h.update(baseState());
  assert.doesNotMatch(h.html, /class="intent"/);
});

test("no available boxes hands off to management without cancelling the pending application", async () => {
  const initial = pendingState();
  initial.devices = [];
  const h = await harness(initial);
  assert.match(h.html, /发现或配置盒子/);
  assert.doesNotMatch(h.html, /id="target-box"/);
  await h.click({ page: "boxes" });
  assert.deepEqual(h.actions(), [["desktop-open", { page: "boxes" }]]);
});

test("a launch failure remains actionable and retry submits the actual application identifier", async () => {
  const state = pendingState("failed");
  state.ui.pendingOpen.error = "APPLICATION_START_TIMEOUT";
  state.ui.applicationOperations[application.applicationId] = { phase: "failed", error: "APPLICATION_START_TIMEOUT" };
  const h = await harness(state);
  assert.match(h.html, /应用启动超时，请重试/);
  assert.match(h.html, /data-app="centaurai\.wanx\.zhijun"[^>]*>重试/);
  await h.click({ app: application.applicationId });
  assert.deepEqual(h.actions().at(-1), ["applications-request-open", { applicationId: application.applicationId }]);
  h.respond("applications-request-open", () => { throw new Error("secret-internal-diagnostic"); });
  await h.click({ app: application.applicationId });
  assert.match(h.html, /操作未完成，请重试或在管理窗口查看/);
  assert.doesNotMatch(h.html, /secret-internal-diagnostic/);
});

test("pending application box selection survives state refresh; Escape dismisses the panel", async () => {
  const h = await harness(pendingState());
  h.changeTarget("box-103");
  await h.update(pendingState());
  assert.match(h.html, /value="box-103" selected/);
  assert.equal(await h.keydown("Escape"), true);
  assert.deepEqual(h.actions().at(-1), ["desktop-hide", undefined]);
  const count = h.actions().length;
  assert.equal(await h.keydown("Enter"), false);
  assert.equal(h.actions().length, count);
});

test("connected box is status text, with no direct switch action in the panel", async () => {
  const state = baseState();
  state.phase = "ready";
  state.connection = { mode: "netbird", deviceId: "box-102", name: devices[0].displayName };
  const h = await harness(state);
  assert.match(h.html, /class="box-status"/);
  assert.match(h.html, /CentuarAI-AMD-102/);
  assert.match(h.html, /已连接/);
  assert.doesNotMatch(h.html, /data-action="boxes"|data-device=|data-action="switch"/);
  await h.click({ device: "box-103" });
  assert.equal(h.actions().length, 0);
});

test("pending applications cannot select unavailable boxes and can open settings management", async () => {
  const state = pendingState();
  state.devices = [{ deviceId: "pending", displayName: "待授权盒子", accessState: "authorization_pending", canOpen: false }];
  const h = await harness(state);
  assert.doesNotMatch(h.html, /id="target-box"/);
  assert.match(h.html, /发现或配置盒子/);
  await h.click({ page: "boxes" });
  assert.deepEqual(h.actions(), [["desktop-open", { page: "boxes" }]]);
});

test("application, device and connection text cannot inject HTML into the quick panel", async () => {
  const state = pendingState();
  state.applications[0].name = '<img src=x onerror="alert(1)">';
  state.devices[0].displayName = '<script>alert("box")</script>';
  state.connection = { name: '<img src="box" onerror="alert(2)">' };
  const h = await harness(state);
  assert.match(h.html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(h.html, /&lt;script&gt;alert\(&quot;box&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(h.html, /<script>|<img src=x|<img src="box"/);

});

test("resize reports bounded content heights without repeatedly sending an unchanged height", async () => {
  const h = await harness();
  assert.deepEqual(h.calls.filter(([name]) => name === "desktop-resize"), [["desktop-resize", { height: 264 }]]);
  h.root.scrollHeight = 900;
  await h.update(baseState());
  assert.deepEqual(h.calls.at(-1), ["desktop-resize", { height: 560 }]);
  const count = h.calls.length;
  await h.update(baseState());
  assert.equal(h.calls.length, count);
  h.root.scrollHeight = 80;
  await h.update(baseState());
  assert.deepEqual(h.calls.at(-1), ["desktop-resize", { height: 240 }]);
});

test("logout removes the previous account's pending box choice", async () => {
  const h = await harness(pendingState());
  h.changeTarget("box-103");
  await h.update({ account: { phase: "signed_out" }, applications: [], devices: [], ui: {} });
  assert.match(h.html, /登录万象/);
  assert.doesNotMatch(h.html, /CentuarAI-AMD-103|id="target-box"/);
  const next = baseState();
  next.account = { phase: "authenticated", accountId: "account-2", clientId: "client-2" };
  await h.update(next);
  assert.match(h.html, /<h2>我的应用<\/h2>/);
});

test("same-account logout/login and a changed client identity both reset the remembered selector", async () => {
  const state = pendingState();
  state.account.clientId = "client-1";
  const h = await harness(state);
  h.changeTarget("box-103");
  await h.update({ account: { phase: "signed_out" }, applications: [], devices: [], ui: {} });
  await h.update(state);
  assert.match(h.html, /value="box-102" selected/);
  assert.doesNotMatch(h.html, /value="box-103" selected/);
  h.changeTarget("box-103");
  await h.update({ ...state, account: { ...state.account, clientId: "client-2" } });
  assert.match(h.html, /value="box-102" selected/);
});

test("network updates and ordinary token refresh preserve the current selector and page", async () => {
  const state = pendingState();
  state.account.clientId = "client-1";
  const h = await harness(state);
  h.changeTarget("box-103");
  const refreshed = { ...state, network: { ...state.network, phase: "checking" }, account: { ...state.account, expiresAt: 12345 } };
  await h.update(refreshed);
  assert.match(h.html, /value="box-103" selected/);
  await h.update({ ...refreshed, account: { ...refreshed.account, expiresAt: 23456 } });
  assert.match(h.html, /value="box-103" selected/);
});

test("an action rejected after logout and same-account login cannot publish its old error", async () => {
  const h = await harness();
  const pending = deferred();
  h.respond("applications-request-open", () => pending.promise);
  await h.click({ app: application.applicationId });
  await h.update({ account: { phase: "signed_out" }, applications: [], devices: [], ui: {} });
  await h.update(baseState());
  pending.reject(new Error("APPLICATION_START_TIMEOUT"));
  await settle();
  assert.doesNotMatch(h.html, /应用启动超时|notice error/);

  const current = deferred();
  h.respond("applications-request-open", () => current.promise);
  await h.click({ app: application.applicationId });
  await h.update({ ...baseState(), account: { ...baseState().account, expiresAt: 12345 } });
  current.reject(new Error("APPLICATION_START_TIMEOUT"));
  await settle();
  assert.match(h.html, /应用启动超时，请重试/);
});


test("quick panel reads real available points and opens the ledger without launching an application", async () => {
  const h = await harness(baseState(), async () => ({ available: 1250 }));
  assert.match(h.html, /1,250<small>点/);
  assert.match(h.html, /我的积分，1,250点/);
  assert.match(h.html, /查看消耗明细/);
  await h.click({ page: "credits" });
  assert.deepEqual(h.actions(), [["desktop-open", { page: "credits" }]]);
  await h.focus();
  assert.equal(h.calls.filter(([name]) => name === "panel-balance").length, 2);
});

test("balance loading, a real zero and failure remain distinct; repeated focus coalesces requests", async () => {
  const pending = deferred(); let reads = 0;
  const h = await harness(baseState(), () => { reads++; return reads === 1 ? pending.promise : Promise.reject(new Error("unavailable")); });
  assert.match(h.html, /正在读取…/);
  assert.doesNotMatch(h.html, /points-value">0/);
  await h.focus(); assert.equal(reads, 1);
  pending.resolve({ available: 0 }); await settle();
  assert.match(h.html, /points-value">0<small>点/);
  await h.focus();
  assert.match(h.html, /暂不可用/);
  assert.match(h.html, /points-value">—/);
  assert.doesNotMatch(h.html, /points-value">0/);
});

test("account switch and logout discard a delayed balance and never expose previous-account points", async () => {
  const old = deferred(), newer = deferred(); let reads = 0;
  const h = await harness(baseState(), () => ++reads === 1 ? old.promise : newer.promise);
  const next = baseState(); next.account.accountId = "account-2";
  await h.update(next);
  old.resolve({ available: 999 }); await settle();
  assert.doesNotMatch(h.html, /999<small>/);
  newer.resolve({ available: 42 }); await settle();
  assert.match(h.html, /42<small>点/);
  await h.update({ account: { phase: "signed_out" } });
  assert.match(h.html, /登录后查看/);
  assert.doesNotMatch(h.html, /42<small>|data-page="credits"/);
  await h.focus(); assert.equal(reads, 2);
});

for (const available of [-1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid point total ${available} is unavailable instead of displayed`, async () => {
    const h = await harness(baseState(), async () => ({ available }));
    assert.match(h.html, /暂不可用/);
    assert.match(h.html, /points-value">—/);
  });
}
