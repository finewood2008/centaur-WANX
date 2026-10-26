import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await Promise.all(["../local-ui/renderer/app-catalog.js", "../local-ui/panel/panel.js"].map(file => readFile(new URL(file, import.meta.url), "utf8")))).join("\n");
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
const connectedState = () => ({
  ...baseState(), phase: "ready",
  connection: { mode: "local", deviceId: "box-102", name: "本机万象" },
});
const uploadState = () => ({
  phase: "ready", scope: "scope-a", accountId: "account-1", boxId: "box-102", tasks: [],
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
async function harness(initial = baseState(), getBalance = async () => ({ available: 0 }), initialSpace = null, getApplicationNames = async () => []) {
  let current = structuredClone(initial), markup = "", select = null, listener, spaceListener;
  let spaceValue = initialSpace, uploads = [];
  const classes = new Set(), overlayClasses = new Set();
  const overlay = { hidden: true, innerHTML: "", classList: { toggle(name, yes) { if (yes) overlayClasses.add(name); else overlayClasses.delete(name); } } };
  const events = new Map(), documentEvents = new Map(), responses = new Map(), focusEvents = new Map(), calls = [];
  const root = {
    scrollHeight: 264,
    classList: { toggle(name, yes) { if (yes) classes.add(name); else classes.delete(name); } },
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
    getApplicationNames,
    ...(initialSpace ? {
      getSpace: async () => spaceValue, refreshSpace: async () => spaceValue,
      onSpace(fn) { spaceListener = fn; },
      uploadDroppedFiles: async (files, scope) => { uploads.push({ files, scope }); return responses.get("upload")?.(files, scope) || { ok: true }; },
      transfer: async (...args) => { calls.push(["transfer", ...args]); return responses.get("transfer")?.(...args); },
    } : {}),
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
      body:{classList:{toggle(){}}},
      getElementById(id) { return id === "panel" ? root : id === "panel-drop" && initialSpace ? overlay : null; },
      addEventListener(name, fn) { documentEvents.set(name, fn); },
    },
    requestAnimationFrame: callback => queueMicrotask(callback), setTimeout,
  });
  await settle();
  return {
    root, calls, overlay, uploads,
    async space(value) { spaceValue = value; spaceListener(value); await settle(); },
    async drag(type, { types = ["Files"], files = [], items = [] } = {}) {
      const event = { dataTransfer: { types, files, items }, preventDefault() { this.prevented = true; } };
      await events.get(type)(event); await settle(); return event;
    },
    get html() { return markup; },
    actions() { return calls.filter(([name]) => !["desktop-resize", "panel-balance"].includes(name)); },
    respond(name, fn) { responses.set(name, fn); },
    async noteView(opened) { focusEvents.get("wanx-note-view")?.({detail:{opened}}); await settle(); },
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

test("panel header opens box management directly", async () => {
  const h = await harness();
  assert.match(h.html, /data-app="centaurai\.wanx\.zhijun"/);
  assert.doesNotMatch(h.html, /data-action="boxes"|data-device=|>管理盒子</);
  await h.click({ app: application.applicationId });
  assert.deepEqual(h.actions(), [["applications-request-open", { applicationId: application.applicationId }]]);
  assert.match(h.html, /class="box-button" data-page="boxes" aria-label="打开盒子"/);
  assert.doesNotMatch(h.html, /打开设置/);
  await h.click({ page: "boxes" });
  assert.deepEqual(h.actions().at(-1), ["desktop-open", { page: "boxes" }]);
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
  assert.match(h.html, /积分，1,250点/);
  assert.match(h.html, /查看消耗明细/);
  await h.click({ page: "credits" });
  assert.deepEqual(h.actions(), [["desktop-open", { page: "credits" }]]);
  await h.focus();
  assert.equal(h.calls.filter(([name]) => name === "panel-balance").length, 2);
});

test("quick panel accepts integer wallet balances", async () => {
  for (const value of ['1,998', '0', '-2']) {
    const h = await harness(baseState(), async () => ({ available_text: value, sync_state: "synced" }));
    assert.ok(h.html.includes(`${value}<small>点`));
  }
});

test("quick panel accepts the localized tiny debt display", async () => {
  const h = await harness(baseState(), async () => ({ available_text: "欠费不足 1 积分", sync_state: "stale" }));
  assert.match(h.html, /欠费不足 1 积分/);
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

test("official app icons share the store catalog without changing open behavior", async () => {
  const h = await harness(baseState());
  assert.match(h.html, /app-icons\/zhijun-v1\.png/);
  assert.match(h.html, /data-app="centaurai.wanx.zhijun"/);
});

test("whole panel drop overlay is stable through updates and submits multiple files to the captured scope", async () => {
  const h = await harness(connectedState(), undefined, uploadState());
  assert.match(h.html, /points-value">0<small>点/);
  assert.match(h.html, /data-page="credits"/);
  const before = h.html, count = h.calls.filter(([name]) => name === "desktop-resize").length;
  await h.drag("dragenter");
  assert.equal(h.overlay.hidden, false);
  assert.match(h.overlay.innerHTML, /松开上传到文件空间/);
  assert.match(h.overlay.innerHTML, /本机万象 · 全部文件根目录/);
  await h.drag("dragenter"); await h.drag("dragleave");
  assert.equal(h.overlay.hidden, false, "nested drag events retain the overlay");
  await h.space({ ...uploadState(), tasks: [{ id: "a".repeat(32), name: "file.bin", size: 100, offset: 40, phase: "running" }] });
  assert.equal(h.html, before, "do not replace the underlying content during a drag");
  assert.equal(h.calls.filter(([name]) => name === "desktop-resize").length, count);
  const files = [{ name: "one.txt" }, { name: "two.txt" }];
  await h.drag("drop", { files });
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].scope, "scope-a");
  assert.equal(h.uploads[0].files.length, 2);
  assert.equal(h.overlay.hidden, true);
  assert.match(h.html, /value="40"/);
  await h.click({ transfer: "a".repeat(32), command: "pause" });
  assert.deepEqual(h.calls.at(-1), ["transfer", "pause", "a".repeat(32), "scope-a"]);
  await h.space({ ...uploadState(), tasks: [{ id: "a".repeat(32), name: "file.bin", size: 100, offset: 40, phase: "paused" }] });
  assert.match(h.html, /data-command="resume"/);
  await h.click({ transfer: "a".repeat(32), command: "resume" });
  assert.deepEqual(h.calls.at(-1), ["transfer", "resume", "a".repeat(32), "scope-a"]);
  await h.space({ ...uploadState(), tasks: [{ name: "file.bin", size: 100, offset: 100, phase: "complete" }] });
  assert.doesNotMatch(h.html, /panel-transfers|value="100"|已将.*加入上传队列/);
  assert.match(h.html, /class="space-entry" data-page="space"/);
  assert.match(h.html, /class="apps-link" data-page="applications"/);
  await h.click({ page: "space" });
  assert.deepEqual(h.actions().at(-1), ["desktop-open", { page: "space" }]);
});
test("panel ignores text, accepts directories, clears drag leave and rejects changed connections", async () => {
  const h = await harness(connectedState(), undefined, uploadState());
  await h.drag("dragenter", { types: ["text/plain"] }); assert.equal(h.overlay.hidden, true);
  await h.drag("dragenter"); await h.drag("dragleave"); assert.equal(h.overlay.hidden, true);
  await h.drag("dragenter");
  await h.drag("drop", { files: [{ name: "folder" }], items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }] });
  assert.equal(h.uploads.length, 1);
  await h.drag("dragenter");
  await h.update({ ...connectedState(), connection: { mode: "local", deviceId: "box-103" } });
  assert.match(h.overlay.innerHTML, /盒子或账号已变化/);
  await h.drag("drop", { files: [{ name: "one.txt" }] }); assert.equal(h.uploads.length, 1);
});
for (const [label, connection, storage] of [
  ["signed out", { ...connectedState(), account: { phase: "signed_out" } }, uploadState()],
  ["disconnected", baseState(), uploadState()],
  ["unsupported", connectedState(), { ...uploadState(), phase: "unsupported" }],
]) test(`panel does not submit files when ${label}`, async () => {
  const h = await harness(connection, undefined, storage);
  await h.drag("dragenter"); const event = await h.drag("dragover");
  assert.equal(event.dataTransfer.dropEffect, "none");
  await h.drag("drop", { files: [{ name: "one.txt" }] }); assert.equal(h.uploads.length, 0);
});

test("completed history disappears while the app heading entry and dedicated space footer remain", async () => {
  const h = await harness(connectedState(), undefined, { ...uploadState(), tasks: [
    { id: "a".repeat(32), name: "already-complete.txt", phase: "complete", size: 10, offset: 10 },
  ] });
  assert.doesNotMatch(h.html, /panel-transfers|already-complete/);
  const apps = h.html.match(/<section class="my-apps"[\s\S]*?<\/section>/)?.[0];
  assert.match(apps, /class="apps-link" data-page="applications"/);
  const footer = h.html.match(/<footer[\s\S]*?<\/footer>/)?.[0];
  assert.match(footer, /class="space-entry" data-page="space"/);
  assert.match(footer, /本机万象 · 全部文件/);
  assert.match(footer, /已就绪/);
  assert.match(footer, /class="note-entry" data-action="clipboard-toggle"/);
  assert.match(footer, /打开便签/);
  assert.doesNotMatch(footer, /class="space-drop-hint/);
  assert.match(footer, /拖入文件，保存到空间/);
  assert.doesNotMatch(footer, /data-page="applications"/);
  await h.click({ page: "applications" });
  assert.deepEqual(h.actions().at(-1), ["desktop-open", { page: "applications" }]);
});
test("quick panel reads real available points and opens the ledger without launching an application", async () => {
  const h = await harness(baseState(), async () => ({ available: 1250 }));
  assert.match(h.html, /1,250<small>点/);
  assert.match(h.html, /积分，1,250点/);
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


test("panel uses Admin names for rows, open labels and pending intents, refreshing on focus", async () => {
  const initial = pendingState();
  initial.applications[0].name = "超级参谋团";
  let names = [{ applicationId: application.applicationId, name: "个人议事厅" }];
  const h = await harness(initial, undefined, null, async () => names);
  assert.match(h.html, /class="app-name">个人议事厅</);
  assert.match(h.html, /aria-label="打开个人议事厅"/);
  assert.match(h.html, /个人议事厅需要连接一个盒子/);
  assert.doesNotMatch(h.html, /超级参谋团/);
  await h.click({ app: application.applicationId });
  assert.deepEqual(h.actions().at(-1), ["applications-request-open", { applicationId: application.applicationId }]);
  names = [{ applicationId: application.applicationId, name: "新 & <议事厅>" }];
  await h.focus();
  assert.match(h.html, /class="app-name">新 &amp; &lt;议事厅&gt;</);
  assert.doesNotMatch(h.html, /<议事厅>/);
  assert.equal(initial.applications[0].name, "超级参谋团");
});

test("panel keeps last Admin names offline and falls back for absent or blank names", async () => {
  let result = [{ applicationId: application.applicationId, name: "后台名称" }];
  const h = await harness(baseState(), undefined, null, async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  assert.match(h.html, /class="app-name">后台名称</);
  result = new Error("offline");
  await h.focus();
  assert.match(h.html, /class="app-name">后台名称</);
  for (const names of [[], [{ applicationId: application.applicationId, name: "  " }]]) {
    result = names;
    await h.focus();
    assert.match(h.html, /class="app-name">知君</);
  }
});

test("panel discards stale Admin names across account switches and signs out without fetching", async () => {
  const old = deferred(), next = deferred();
  let calls = 0;
  const h = await harness(baseState(), undefined, null, () => (++calls === 1 ? old.promise : next.promise));
  await h.focus();
  assert.equal(calls, 1, "deduplicate in-flight reads");
  const other = baseState(); other.account.accountId = "account-2";
  await h.update(other);
  assert.equal(calls, 2);
  next.resolve([{ applicationId: application.applicationId, name: "新账号名称" }]);
  await settle();
  old.resolve([{ applicationId: application.applicationId, name: "旧账号名称" }]);
  await settle();
  assert.match(h.html, /class="app-name">新账号名称</);
  assert.doesNotMatch(h.html, /旧账号名称/);
  await h.update({ ...other, account: { phase: "signed_out" } });
  await h.focus();
  assert.equal(calls, 2);
  assert.doesNotMatch(h.html, /新账号名称/);
});

test("quick panel shows the whole-batch rejection, escapes filenames, and keeps its compact idle layout", async () => {
  const h = await harness(connectedState(), async () => ({ available: 0 }), uploadState());
  h.respond("upload", () => ({ ok: false, code: "SPACE_UPLOAD_LIMIT", message: "单文件最大 200 MB：<large>.bin。本批文件未加入上传队列。" }));
  await h.drag("dragenter");
  assert.match(h.overlay.innerHTML, /文件夹自动分批上传.*200 MB/);
  await h.drag("drop", { files: [{ name: "<large>.bin" }, { name: "small.txt" }] });
  assert.match(h.html, /200 MB：&lt;large&gt;.bin.*本批文件未加入上传队列/);
  assert.doesNotMatch(h.html, /<large>|class="panel-transfers"/);
  assert.equal(h.overlay.hidden, true);
});

test('note page keeps its edit height and does not route pasted images to ordinary space uploads',async()=>{
 const h=await harness(connectedState(),async()=>({available:0}),uploadState());
 await h.noteView(true);
 assert.deepEqual(h.calls.filter(([n])=>n==='desktop-resize').at(-1),['desktop-resize',{height:560}]);
 const event=await h.drag('dragenter',{files:[{name:'image.png'}]});assert.equal(event.prevented,undefined);
 await h.drag('drop',{files:[{name:'image.png'}]});assert.equal(h.uploads.length,0);
 await h.space({...uploadState(),tasks:[]});
 assert.equal(h.calls.filter(([n])=>n==='desktop-resize').at(-1)[1].height,560);
 await h.noteView(false);assert.equal(h.calls.filter(([n])=>n==='desktop-resize').at(-1)[1].height,264);
});

test('folder batch panel reports scanning and partial failures, permits batch retry and hides healthy completion',async()=>{
 const h=await harness(connectedState(),undefined,uploadState());const batch={id:'b'.repeat(32),name:'资料目录',files:110,folders:3,completed:45,failed:0,pending:68,scanComplete:false,phase:'scanning'};
 await h.space({...uploadState(),imports:[batch],tasks:[{id:'a'.repeat(32),name:'中文.txt',size:100,offset:40,phase:'running'}]});assert.match(h.html,/正在扫描/);assert.match(h.html,/110 个文件/);assert.match(h.html,/暂停本批/);
 await h.space({...uploadState(),imports:[{...batch,scanComplete:true,phase:'failed',failed:2}],tasks:[{id:'a'.repeat(32),name:'中文.txt',size:100,offset:40,phase:'paused',error:'ECONNRESET'}]});assert.match(h.html,/2 项未完成/);assert.match(h.html,/重试问题项/);assert.match(h.html,/网络连接中断/);
 await h.space({...uploadState(),imports:[{...batch,scanComplete:true,phase:'complete',failed:0,pending:0}],tasks:[{id:'a'.repeat(32),name:'中文.txt',size:100,offset:100,phase:'complete'}]});assert.doesNotMatch(h.html,/class="panel-transfers"/);
});

test('accepted panel upload follows network state and retires its stale submission error',async()=>{
 const h=await harness(connectedState(),undefined,uploadState());
 h.respond('upload',()=>({ok:false,code:'SPACE_REQUEST_FAILED'}));
 await h.drag('dragenter');await h.drag('drop',{files:[{name:'样本.bin'}]});
 assert.match(h.html,/暂未确认操作结果/);
 const task={id:'a'.repeat(32),name:'样本.bin',size:200,offset:100,phase:'retrying',error:'SPACE_CHUNK_STALLED'};
 await h.space({...uploadState(),tasks:[task]});
 assert.match(h.html,/等待网络，恢复后自动继续/);assert.doesNotMatch(h.html,/暂未确认操作结果|上传未完成|上传失败|notice error/);
 await h.space({...uploadState(),tasks:[{...task,phase:'queued'}]});
 assert.match(h.html,/等待网络，恢复后自动继续/);assert.doesNotMatch(h.html,/等待上传|notice error/);
 await h.space({...uploadState(),tasks:[{...task,phase:'running',offset:150}]});
 assert.doesNotMatch(h.html,/等待网络，恢复后自动继续|notice error/);
 await h.space({...uploadState(),tasks:[{...task,phase:'complete',offset:200}]});
 await h.space({...uploadState(),tasks:[]});assert.doesNotMatch(h.html,/panel-transfers|暂未确认操作结果|notice error/);
});
test('a late failed panel reply cannot revive an error after the accepted upload completed',async()=>{
 const h=await harness(connectedState(),undefined,uploadState()),reply=deferred();h.respond('upload',()=>reply.promise);
 await h.drag('dragenter');const pending=h.drag('drop',{files:[{name:'样本.bin'}]});await settle();
 const task={id:'b'.repeat(32),name:'样本.bin',size:10,offset:10,phase:'complete'};
 await h.space({...uploadState(),tasks:[task]});reply.resolve({ok:false,code:'SPACE_REQUEST_FAILED'});await pending;
 await h.space(uploadState());assert.doesNotMatch(h.html,/暂未确认操作结果|notice error|panel-transfers/);
});
test('panel keeps unaccepted submissions and actionable errors separate from another recovering upload',async()=>{
 const task={id:'a'.repeat(32),name:'原有.bin',size:100,offset:50,phase:'retrying'};
 for(const [code,text] of [['SPACE_REQUEST_FAILED',/暂未确认操作结果/],['SPACE_DISK_FULL',/存储空间不足/],['ACCOUNT_LOGIN_REQUIRED',/请先登录万象/]]){
  const h=await harness(connectedState(),undefined,{...uploadState(),tasks:[task]});h.respond('upload',()=>({ok:false,code}));
  await h.drag('dragenter');await h.drag('drop',{files:[{name:'未入队.bin'}]});assert.match(h.html,text);
  await h.space({...uploadState(),tasks:[{...task,phase:'running'}]});assert.match(h.html,text);
 }
});
test('panel clears a transfer action network notice from the same batch without promising auto-resume for user pauses',async()=>{
 const id='b'.repeat(32),task={id:'a'.repeat(32),batchId:id,name:'样本.bin',size:100,offset:50,phase:'waiting'};
 const h=await harness(connectedState(),undefined,{...uploadState(),tasks:[task]});h.respond('transfer',()=>{throw Error('SPACE_REQUEST_FAILED');});
 await h.click({transfer:id,command:'pause-batch'});assert.match(h.html,/等待网络，恢复后自动继续/);assert.doesNotMatch(h.html,/notice error/);
 await h.space({...uploadState(),tasks:[{...task,phase:'paused',error:null}]});assert.match(h.html,/已暂停/);assert.doesNotMatch(h.html,/等待网络，恢复后自动继续|notice error/);
});

test("panel retains a healthy existing connection during management recovery", async () => {
  const state = { ...connectedState(), connection: { mode: "netbird", deviceId: "box-102", name: "测试盒子" }, network: { enabled: true, phase: "recovering" } };
  const h = await harness(state);
  assert.match(h.html, /card-caption">已连接/);
  await h.update({ ...state, phase: "recovering" });
  assert.doesNotMatch(h.html, /card-caption">已连接/);
  await h.update({ ...state, network: { enabled: true, phase: "unavailable" } });
  assert.doesNotMatch(h.html, /card-caption">已连接/);
});

test("local panel uses its own data identity without cloud and clears private uploads on lock", async () => {
  const value = { ...connectedState(), account: { phase: 'signed_out' },
    dataIdentity: { profileId: 'profile-a', clientId: 'client-a', generation: 1, phase: 'unlocked',
      selected: { boxId: 'box-102', boxKeyThumbprint: 'pin-a', principalId: 'principal-a', bindingId: 'binding-a',
        ownershipEpoch: 1, authorizationVersion: 1, sessionId: 'session-a' } } };
  value.connection.authorization = 'local-trust-v1';
  const dataOwnerId = JSON.stringify(['local-trust-v1', 'profile-a', 'box-102', 'pin-a', 1, 'principal-a']);
  const dataContextId = JSON.stringify([dataOwnerId, 'client-a', 1, 'binding-a', 1, 'session-a']);
  const privateSpace = { ...uploadState(), accountId: null, dataOwnerId, dataContextId,
    tasks: [{ id: 'private-upload', name: 'private-note.txt', phase: 'running', offset: 1, size: 100 }] };
  let balances = 0;
  const h = await harness(value, async () => { balances++; return { available: 5 }; }, privateSpace);
  assert.match(h.html, /data-app="centaurai.wanx.zhijun"/);
  assert.match(h.html, /private-note.txt/);
  assert.equal(balances, 0);
  await h.update({ ...value, account: { phase: 'authenticated', accountId: 'cloud-a' },
    dataIdentity: { ...value.dataIdentity, phase: 'locked', generation: 2, selected: null } });
  assert.doesNotMatch(h.html, /private-note.txt|data-app="centaurai.wanx.zhijun"/);
});
