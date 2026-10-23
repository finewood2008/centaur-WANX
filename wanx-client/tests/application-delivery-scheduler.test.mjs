import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultApplicationScheduler } from "../applications/delivery-scheduler.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const timers = new Map(), calls = [];
  let scope = null, index = 0, result = { status: "ready" };
  const delivery = {
    invalidate() { calls.push("invalidate"); },
    async ensureDefaultApplications() { calls.push("ensure"); return result; },
  };
  const scheduler = createDefaultApplicationScheduler({ delivery, getScope: () => scope,
    setTimer(callback, delay) { const id = ++index; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  return { scheduler, delivery, timers, calls, setScope(value) { scope = value; }, setResult(value) { result = value; },
    fire() { const [id, timer] = [...timers][0]; timers.delete(id); timer.callback(); },
  };
}

test("scheduler waits for a ready scope and does not poll successful delivery", async () => {
  const h = harness();
  h.scheduler.sync(); h.scheduler.sync();
  assert.deepEqual(h.calls, []);
  h.setScope({ accountId: "customer", deviceId: "box" });
  const task = h.scheduler.sync();
  assert.equal(h.scheduler.sync(), task);
  await task;
  h.scheduler.sync(); h.scheduler.sync();
  assert.deepEqual(h.calls, ["invalidate", "ensure"]);
  assert.equal(h.timers.size, 0);
  await h.scheduler.close();
});

test("pending retries once every sixty seconds and stops when ready", async () => {
  const h = harness(); h.setResult({ status: "pending" });
  h.setScope({ accountId: "customer", deviceId: "box" });
  await h.scheduler.sync();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 60000);
  for (let index = 0; index < 10; index++) h.scheduler.sync();
  assert.deepEqual(h.calls, ["invalidate", "ensure"]);
  h.fire(); await settle();
  assert.equal(h.timers.size, 1);
  h.setResult({ status: "ready" }); h.fire(); await settle();
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.calls, ["invalidate", "ensure", "ensure", "ensure"]);
  await h.scheduler.close();
});

for (const status of ["waiting", "cancelled"]) {
  test(`${status} from a transient session change retries while the same ready scope remains`, async () => {
    const h = harness(); h.setResult({ status });
    h.setScope({ accountId: "customer", deviceId: "box" });
    await h.scheduler.sync();
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].delay, 60000);
    for (let index = 0; index < 10; index++) h.scheduler.sync();
    assert.deepEqual(h.calls, ["invalidate", "ensure"]);
    h.setResult({ status: "ready" }); h.fire(); await settle();
    assert.deepEqual(h.calls, ["invalidate", "ensure", "ensure"]);
    assert.equal(h.timers.size, 0);
    await h.scheduler.close();
  });

  test(`late ${status} does not retry after disconnect, scope replacement or close`, async () => {
    for (const transition of ["disconnect", "replace", "close"]) {
      const h = harness(); let finish;
      h.delivery.ensureDefaultApplications = () => {
        h.calls.push("ensure");
        if (h.calls.filter(call => call === "ensure").length === 1) return new Promise(resolve => { finish = resolve; });
        return Promise.resolve({ status: "ready" });
      };
      h.setScope({ accountId: "customer", deviceId: "box-a" });
      const previous = h.scheduler.sync(); await settle();
      let closing;
      if (transition === "close") closing = h.scheduler.close();
      else {
        h.setScope(transition === "disconnect" ? null : { accountId: "customer", deviceId: "box-b" });
        await h.scheduler.sync();
      }
      finish({ status }); await previous; await closing;
      assert.equal(h.timers.size, 0, transition);
      await h.scheduler.close();
    }
  });
}

test("disconnect cancels retry and reconnecting the same box starts a new preparation pass", async () => {
  const h = harness(); h.setResult({ status: "pending" });
  const ready = { accountId: "customer", deviceId: "box" };
  h.setScope(ready); await h.scheduler.sync();
  h.setScope(null); h.scheduler.sync();
  assert.equal(h.timers.size, 0);
  h.setScope(ready); await h.scheduler.sync();
  assert.deepEqual(h.calls, ["invalidate", "ensure", "invalidate", "invalidate", "ensure"]);
  assert.equal(h.timers.size, 1);
  await h.scheduler.close(); assert.equal(h.timers.size, 0);
});

test("progress publication that synchronously calls sync cannot recurse or restart delivery", async () => {
  const h = harness();
  h.delivery.ensureDefaultApplications = async () => {
    h.calls.push("ensure");
    for (let index = 0; index < 12; index++) h.scheduler.sync();
    return { status: "ready" };
  };
  h.setScope({ accountId: "customer", deviceId: "box" });
  await h.scheduler.sync();
  assert.deepEqual(h.calls, ["invalidate", "ensure"]);
  assert.equal(h.timers.size, 0);
  await h.scheduler.close();
});

test("late results from a prior box cannot schedule retries in the new scope", async () => {
  const h = harness(); let finish;
  h.delivery.ensureDefaultApplications = () => {
    h.calls.push("ensure");
    if (h.calls.filter(call => call === "ensure").length === 1) return new Promise(resolve => { finish = resolve; });
    return Promise.resolve({ status: "ready" });
  };
  h.setScope({ accountId: "customer", deviceId: "box-a" });
  const previous = h.scheduler.sync(); await settle();
  h.setScope({ accountId: "customer", deviceId: "box-b" });
  await h.scheduler.sync(); finish({ status: "pending" }); await previous;
  assert.deepEqual(h.calls, ["invalidate", "ensure", "invalidate", "ensure"]);
  assert.equal(h.timers.size, 0);
  await h.scheduler.close();
});

test("account changes invalidate active preparation and fresh accounts run once", async () => {
  const h = harness();
  h.setScope({ accountId: "customer-a", deviceId: "box" }); await h.scheduler.sync();
  h.setScope({ accountId: "customer-b", deviceId: "box" }); await h.scheduler.sync();
  assert.deepEqual(h.calls, ["invalidate", "ensure", "invalidate", "ensure"]);
  await h.scheduler.close();
});

test("a rejected preparation promise is contained and retried without breaking connection events", async () => {
  const h = harness();
  h.delivery.ensureDefaultApplications = () => { h.calls.push("ensure"); throw Error("offline"); };
  h.setScope({ accountId: "customer", deviceId: "box" });
  await h.scheduler.sync();
  assert.equal(h.timers.size, 1);
  h.fire(); await settle();
  assert.equal(h.timers.size, 1);
  await h.scheduler.close(); assert.equal(h.timers.size, 0);
});

test("closing prevents late in-flight completion and old timer callbacks from scheduling", async () => {
  const h = harness(); let finish;
  h.delivery.ensureDefaultApplications = () => new Promise(resolve => { finish = resolve; });
  h.setScope({ accountId: "customer", deviceId: "box" });
  const running = h.scheduler.sync(); await settle();
  const closed = h.scheduler.close(); finish({ status: "pending" });
  await Promise.all([running, closed]);
  h.scheduler.sync();
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.calls, ["invalidate", "invalidate"]);
});
