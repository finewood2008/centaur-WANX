import test from "node:test";
import assert from "node:assert/strict";
import { createUpdateChecks } from "../shell/update-checks.mjs";

function harness(options = {}) {
  let account = { phase: "authenticated", accountId: "one", clientId: "client" };
  let state = { current: { packaged: true, distributionClass: "formal" }, phase: "idle" };
  const timers = new Map(), checked = [];
  let check = async () => {};
  const scheduler = createUpdateChecks({
    getAccount: () => account,
    updates: { snapshot: () => state, check() { checked.push(account.accountId); return check(); } },
    setTimer(callback, delay) { const id = {}; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); }, ...options,
  });
  return { scheduler, timers, checked,
    account(value) { account = { ...account, ...value }; },
    state(value) { state = { ...state, ...value }; },
    check(value) { check = value; },
    async tick() {
      assert.equal(timers.size, 1);
      const [id, { callback, delay }] = [...timers][0];
      assert.equal(delay, 60 * 60 * 1000);
      timers.delete(id); callback();
      await scheduler.sync();
    },
  };
}

test("formal authenticated clients check on login and hourly without duplicate checks on refresh", async () => {
  const h = harness();
  h.account({ phase: "signed_out" });
  await h.scheduler.sync();
  assert.deepEqual(h.checked, []);
  assert.equal(h.timers.size, 0);
  h.account({ phase: "authenticated" });
  await Promise.all([h.scheduler.sync(), h.scheduler.sync()]);
  assert.deepEqual(h.checked, ["one"]);
  await h.scheduler.sync();
  assert.deepEqual(h.checked, ["one"]);
  await h.tick();
  assert.deepEqual(h.checked, ["one", "one"]);
  h.scheduler.close();
  assert.equal(h.timers.size, 0);
});

test("unconfigured, development, internal and explicit test runtimes never schedule checks", async () => {
  for (const patch of [
    { phase: "unavailable" }, { phase: "development" },
    { current: { packaged: false, distributionClass: "development" } },
    { current: { packaged: true, distributionClass: "unsigned-internal-only" } },
  ]) {
    const h = harness(); h.state(patch); await h.scheduler.sync();
    assert.deepEqual(h.checked, []); assert.equal(h.timers.size, 0); h.scheduler.close();
  }
  const h = harness({ enabled: false }); await h.scheduler.sync();
  assert.deepEqual(h.checked, []); assert.equal(h.timers.size, 0);
});

test("active update phases are not replaced and failures wait an hour before retrying", async () => {
  for (const phase of ["checking", "downloading", "downloaded", "installing"]) {
    const h = harness(); h.state({ phase }); await h.scheduler.sync();
    assert.deepEqual(h.checked, []);
    h.state({ phase: "idle" }); await h.tick();
    assert.deepEqual(h.checked, ["one"]); h.scheduler.close();
  }
  const h = harness(); h.check(async () => { throw new Error("offline"); });
  await h.scheduler.sync(); await h.scheduler.sync();
  assert.equal(h.checked.length, 1); assert.equal(h.timers.size, 1);
  await h.tick(); assert.equal(h.checked.length, 2); h.scheduler.close();
});

test("account changes wait for the previous check and shutdown prevents late timer recreation", async () => {
  const h = harness(); let finish;
  h.check(() => new Promise(resolve => { finish = resolve; }));
  const first = h.scheduler.sync();
  await Promise.resolve();
  h.account({ accountId: "two" }); h.scheduler.sync();
  assert.deepEqual(h.checked, ["one"]);
  h.check(async () => {}); finish(); await first; await h.scheduler.sync();
  assert.deepEqual(h.checked, ["one", "two"]);
  h.account({ phase: "signed_out" }); await h.scheduler.sync();
  assert.equal(h.timers.size, 0);
  h.account({ phase: "authenticated" });
  h.check(() => new Promise(resolve => { finish = resolve; }));
  const last = h.scheduler.sync(); await Promise.resolve();
  h.scheduler.close(); finish(); await last;
  assert.equal(h.timers.size, 0);
  await h.scheduler.sync(); assert.equal(h.checked.length, 3);
});


test("server-required hints coalesce concurrent requests and retry within a minute without a failure storm", async () => {
  let time = 0;
  const h = harness({ now: () => time });
  await Promise.all([h.scheduler.checkNow(), h.scheduler.checkNow()]);
  assert.deepEqual(h.checked, ["one"]);
  time = 10000;
  await h.scheduler.checkNow(); await h.scheduler.checkNow();
  assert.equal(h.checked.length, 1); assert.equal(h.timers.size, 1);
  const [id, delayed] = [...h.timers][0];
  assert.equal(delayed.delay, 50000);
  h.timers.delete(id); time = 60000; delayed.callback();
  await h.scheduler.sync();
  assert.equal(h.checked.length, 2);
  h.scheduler.close(); await h.scheduler.checkNow();
  assert.equal(h.timers.size, 0);
});


test("server-required hints recheck an already downloaded target while hourly checks preserve it", async () => {
  const h = harness(); h.state({ phase: "downloaded" });
  await h.scheduler.sync(); await h.tick();
  assert.deepEqual(h.checked, []);
  await h.scheduler.checkNow();
  assert.deepEqual(h.checked, ["one"]);
  h.scheduler.close();
});

test("a coalesced server-required hint still rechecks a downloaded target after the minute delay", async () => {
  let time = 0;
  const h = harness({ now: () => time });
  await h.scheduler.sync();
  h.state({ phase: "downloaded" }); time = 10000;
  await h.scheduler.checkNow(); await h.scheduler.checkNow();
  assert.equal(h.checked.length, 1); assert.equal(h.timers.size, 1);
  const [id, delayed] = [...h.timers][0];
  assert.equal(delayed.delay, 50000);
  h.timers.delete(id); time = 60000; delayed.callback(); await h.scheduler.sync();
  assert.equal(h.checked.length, 2);
  h.scheduler.close();
});

test("a server hint joins a queued ordinary check without losing the downloaded refresh intent", async () => {
  const h = harness(); h.state({ phase: "downloaded" });
  const pending = h.scheduler.sync();
  await Promise.all([pending, h.scheduler.checkNow(), h.scheduler.checkNow()]);
  assert.deepEqual(h.checked, ["one"]);
  h.scheduler.close();
});

test("server-required hints never interrupt active checking, downloading or installation", async () => {
  for (const phase of ["checking", "downloading", "installing"]) {
    const immediate = harness(); immediate.state({ phase });
    await immediate.scheduler.checkNow();
    assert.deepEqual(immediate.checked, []); immediate.scheduler.close();
    let time = 0;
    const delayed = harness({ now: () => time }); await delayed.scheduler.sync();
    delayed.state({ phase }); time = 10000; await delayed.scheduler.checkNow();
    const [id, queued] = [...delayed.timers][0];
    delayed.timers.delete(id); time = 60000; queued.callback(); await delayed.scheduler.sync();
    assert.equal(delayed.checked.length, 1); delayed.scheduler.close();
  }
});
