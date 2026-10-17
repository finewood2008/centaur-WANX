import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await Promise.all(["discovery-selection.js", "credits.js", "personal-space.js", "app-catalog.js", "store-carousel.js", "support.js", "renderer.js"].map(name => readFile(new URL(`../local-ui/renderer/${name}`, import.meta.url), "utf8")))).join("\n");
const client = { current: { productVersion: "0.1.4", buildId: "dev-abc123", distributionClass: "development", platform: "darwin", arch: "arm64" }, phase: "development" };
const release = { payload: { releaseId: "box-v2", version: "2.0.0", releaseNotes: "修复稳定性" } };
const plan = { planId: "plan-1", deviceId: "box-1", releaseId: "box-v2", release, planDigest: "a".repeat(64), expiresAt: new Date(Date.now() + 600000).toISOString(), impact: { serviceInterruption: true, dataMigration: false }, dataPolicy: "backward-compatible" };
function state(box = {}) {
  return { route: "applications", phase: "ready", account: { accountId: "account-1" }, activeDeviceId: "box-1", devices: [{ deviceId: "box-1", displayName: "我的盒子" }, { deviceId: "box-2", displayName: "第二台盒子" }], network: { enabled: true, phase: "ready" }, applications: [], upgrades: { client, box: { deviceId: "box-1", canUpgrade: true, phase: "unknown", ...box } } };
}
async function harness(initial = state(), onAction = async () => {}, timers = null) {
  let current = structuredClone(initial), listener;
  const events = new Map(), calls = [];
  const app = { innerHTML: "", querySelector: () => null, addEventListener: (name, fn) => events.set(name, fn) };
  const window = { wanxClient: {
    getLocalState: async () => current, onLocalState: fn => { listener = fn; },
    action: async (action, input) => {
      calls.push({ action, input: structuredClone(input) });
      const override = await onAction(action, input, current);
      if (override) return override;
      return { ok: true, value: action === "market.list" ? { items: [] } : undefined, state: structuredClone(current) };
    },
  } };
  vm.runInNewContext(source, { window, document: { addEventListener() {}, querySelector: selector => selector === "#app" ? app : null }, Date, TextEncoder,
    setTimeout: timers ? (callback, delay) => { if (delay !== 5000) return setTimeout(callback, delay); const id = Symbol(); timers.set(id, callback); return id; } : setTimeout,
    clearTimeout: timers ? id => { if (typeof id === "symbol") timers.delete(id); else clearTimeout(id); } : clearTimeout,
    setInterval: () => null, clearInterval: () => {},
  });
  await new Promise(resolve => setImmediate(resolve));
  const click = (action, data = {}) => events.get("click")({ target: { closest: () => ({ dataset: { action, ...data } }) } });
  await click("show-settings");
  return { app, calls, click, update(next) { current = structuredClone(next); listener(current); } };
}

test("settings show build identity and unknown box evidence without claiming current", async () => {
  const h = await harness();
  assert.match(h.app.innerHTML, /万象客户端.*v0\.1\.4/);
  assert.match(h.app.innerHTML, /dev-abc123/);
  assert.match(h.app.innerHTML, /版本待核验/);
  assert.doesNotMatch(h.app.innerHTML, /已是.*最新|data-action="updates-client-install"/);
});

test("reported installed versions without running evidence stay unverified", async () => {
  const h = await harness(state({ phase: "blocked", reason: "INVENTORY_UNKNOWN", inventory: {
    updaterVersion: "1.1.0", otaReady: false, suiteVersion: null,
    components: { wanx: { installedVersion: "build-1", runningVersion: null, evidenceStatus: "unknown", health: "healthy" } },
  } }));
  assert.match(h.app.innerHTML, /版本待核验/);
  assert.match(h.app.innerHTML, /已运行，自动更新条件待核验/);
  assert.doesNotMatch(h.app.innerHTML, /部分更新 \/ 自定义组合|联系盒主完成管理组件引导/);
});

test("client restart installation requires confirmation and an unchanged downloaded release", async () => {
  const initial = state();
  initial.upgrades.client = { ...client, phase: "downloaded", candidate: { releaseId: "client-v2", productVersion: "2.0.0", requiresRestart: true } };
  const h = await harness(initial);
  await h.click("updates-client-install");
  assert.match(h.app.innerHTML, /role="alertdialog"/);
  assert.equal(h.calls.filter(call => call.action === "updates.client.install").length, 0);
  await h.click("market-confirm");
  assert.deepEqual(h.calls.find(call => call.action === "updates.client.install").input, { confirmed: true });
  await h.click("updates-client-install");
  h.update({ ...initial, upgrades: { ...initial.upgrades, client: { ...initial.upgrades.client, candidate: { releaseId: "client-v3", productVersion: "3.0.0" } } } });
  assert.doesNotMatch(h.app.innerHTML, /role="alertdialog"/);
  await h.click("market-confirm");
  assert.equal(h.calls.filter(call => call.action === "updates.client.install").length, 1);
});

test("download progress uses actual bytes and an unknown total remains indeterminate", async () => {
  const initial = state();
  initial.upgrades.client = { ...client, phase: "downloading", progress: { transferred: 1024, total: null } };
  const h = await harness(initial);
  assert.match(h.app.innerHTML, /1 KB · 总大小待确认/);
  assert.doesNotMatch(h.app.innerHTML, /progress aria-label="客户端下载进度" max=/);
});

test("box preflight does not execute before confirmation and switching boxes discards its plan", async () => {
  const initial = state({ phase: "available", candidate: { status: "available", release } });
  const h = await harness(initial, async (action, input, current) => {
    if (action === "updates.box.plan") current.upgrades.box = { ...current.upgrades.box, phase: "planned", plan };
  });
  await h.click("updates-box-plan");
  assert.match(h.app.innerHTML, /确认更新盒子/);
  assert.equal(h.calls.filter(call => call.action === "updates.box.execute").length, 0);
  h.update({ ...initial, activeDeviceId: "box-2" });
  assert.doesNotMatch(h.app.innerHTML, /role="alertdialog"/);
  await h.click("market-confirm");
  assert.equal(h.calls.filter(call => call.action === "updates.box.execute").length, 0);
  assert.doesNotMatch(h.app.innerHTML, /data-action="updates-box-plan"/);
});

test("box confirmation dispatches only the fixed plan and selected device", async () => {
  const h = await harness(state({ phase: "available", candidate: { status: "available", release } }), async (action, input, current) => {
    if (action === "updates.box.plan") current.upgrades.box = { ...current.upgrades.box, phase: "planned", plan };
  });
  await h.click("updates-box-plan");
  await h.click("market-confirm");
  assert.deepEqual(h.calls.find(call => call.action === "updates.box.execute").input, { deviceId: "box-1", planId: "plan-1", confirmed: true });
});

test("partial components and restored programs are not displayed as successful suite updates", async () => {
  const h = await harness(state({ inventory: { suiteVersion: "2.0.0", observedAt: new Date(Date.now() - 3600000).toISOString(), components: { bridge: { installedVersion: "2.0.0", runningVersion: "1.0.0", evidenceStatus: "drifted", health: "healthy" } } }, operation: { operationId: "op-1", state: "rolled_back", serviceAvailable: true, allowedActions: ["replan"] } }));
  assert.match(h.app.innerHTML, /部分更新 \/ 自定义组合/);
  assert.match(h.app.innerHTML, /报告已过期/);
  assert.match(h.app.innerHTML, /本次更新未成功/);
  assert.doesNotMatch(h.app.innerHTML, /已核验更新成功|data-action="updates-box-resume"/);
});

test("maintenance errors expose guidance while only server allowed resume is actionable", async () => {
  const h = await harness(state({ phase: "failed", operation: { operationId: "op-1", state: "needs_attention", errorCode: "RECOVERY_REQUIRED", allowedActions: ["status", "contact-owner"] } }));
  assert.match(h.app.innerHTML, /请保留当前状态/);
  assert.match(h.app.innerHTML, /op-1/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="updates-box-resume"|data-action="updates-box-cancel"/);
});

test("members can read update status but cannot plan, resume or cancel a box update", async () => {
  const h = await harness(state({ canUpgrade: false, phase: "available", candidate: { status: "available", release }, operation: { operationId: "op-1", state: "failed", allowedActions: ["resume", "cancel"] } }));
  assert.match(h.app.innerHTML, /请联系盒主更新/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="updates-box-(?:plan|resume|cancel)"/);
  for (const action of ["updates-box-plan", "updates-box-resume", "updates-box-cancel"]) await h.click(action);
  assert.equal(h.calls.some(call => /^updates\.box\.(?:plan|resume|cancel|execute)$/.test(call.action)), false);
});

test("active task controls remain available, polling pauses on failure and leaving settings stops it", async () => {
  const timers = new Map();
  let fail = false;
  const initial = state({ phase: "executing", operation: { operationId: "op-1", state: "downloading", allowedActions: ["status", "cancel"] } });
  const h = await harness(initial, async action => { if (action === "updates.box.status" && fail) throw new Error("offline"); }, timers);
  assert.doesNotMatch(h.app.innerHTML, /data-action="updates-box-status"[^>]*disabled/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="updates-box-cancel"[^>]*disabled/);
  assert.equal(timers.size, 1);
  const callback = [...timers.values()][0]; timers.clear(); fail = true;
  await callback();
  assert.equal(timers.size, 0);
  assert.match(h.app.innerHTML, /自动刷新已暂停/);
  fail = false; await h.click("updates-box-status");
  assert.equal(timers.size, 1);
  await h.click("show-applications");
  assert.equal(timers.size, 0);
});

test("late task polling from a different selected box never replaces current state", async () => {
  const timers = new Map();
  let release;
  const initial = state({ phase: "executing", operation: { operationId: "op-1", state: "verifying", allowedActions: ["status"] } });
  const h = await harness(initial, action => action === "updates.box.status" ? new Promise(resolve => { release = resolve; }) : undefined, timers);
  const callback = [...timers.values()][0]; timers.clear();
  const request = callback();
  h.update({ ...initial, activeDeviceId: "box-2", upgrades: { client, box: { deviceId: "box-2", phase: "unknown" } } });
  release(); await request;
  assert.match(h.app.innerHTML, /<dd>box-2<\/dd>/);
  assert.doesNotMatch(h.app.innerHTML, /任务 op-1/);
  assert.equal(timers.size, 0);
});

test("new application compatibility errors direct users to update WanX or ask the owner", async () => {
  for (const [code, message] of [["CLIENT_VERSION_INCOMPATIBLE", /设置中更新万象/], ["BACKEND_CONTRACT_INCOMPATIBLE", /联系盒主更新/]]) {
    const initial = state();
    initial.applications = [{ applicationId: "app-1", name: "测试应用", version: "1.0.0" }];
    const h = await harness(initial, action => { if (action === "applications.request-open") throw new Error(code); });
    await h.click("show-applications");
    await h.click("applications-launch", { applicationId: "app-1" });
    assert.match(h.app.innerHTML, message);
    assert.doesNotMatch(h.app.innerHTML, /暂时无法完成应用市场操作/);
  }
});

test("unknown assistant, authorization and data compatibility keep existing content with a useful next step", async () => {
  for (const [code, message] of [["EXPERT_VERSION_UNKNOWN", /现有内容已保留/], ["APP_AUTHORIZATION_UNVERIFIED", /重新登录后重试/], ["APPLICATION_DATA_COMPATIBILITY_UNKNOWN", /保留当前版本/]]) {
    const initial = state();
    initial.applications = [{ applicationId: "app-1", name: "测试应用", version: "1.0.0" }];
    const h = await harness(initial, action => { if (action === "applications.request-open") throw new Error(code); });
    await h.click("show-applications");
    await h.click("applications-launch", { applicationId: "app-1" });
    assert.match(h.app.innerHTML, message);
    assert.doesNotMatch(h.app.innerHTML, /暂时无法完成应用市场操作/);
  }
});

test("market dependency reasons explain preparation without offering an incompatible install", async () => {
  for (const [reason, message] of [["backend_contract", /联系盒主更新/], ["backend_evidence_stale", /连接盒子并刷新/], ["expert_not_ready", /联系盒主完成准备/], ["expert_version_unknown", /现有内容已保留/]]) {
    const h = await harness(state(), action => action === "market.list" ? { ok: true, value: { items: [{ applicationId: "app-1", name: "测试应用" }] } } : action === "market.candidate" ? { ok: true, value: { status: "incompatible", reason } } : undefined);
    await h.click("show-applications");
    assert.match(h.app.innerHTML, message);
    assert.doesNotMatch(h.app.innerHTML, /data-action="market-install"/);
  }
});
