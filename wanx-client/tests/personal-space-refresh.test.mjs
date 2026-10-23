import test from "node:test";
import assert from "node:assert/strict";
import { createPersonalSpace } from "../shell/personal-space.mjs";

const deferred = () => Promise.withResolvers();
const failure = code => Object.assign(new Error(code), { code });
const response = value => ({ status: 200, body: Buffer.from(JSON.stringify(value)) });

async function fixture(t, { connect, request } = {}) {
  let state = { phase: "ready", account: { phase: "authenticated", accountId: "owner" }, connection: { deviceId: "box" } };
  const listeners = new Set(), calls = [];
  let connections = 0;
  const service = await createPersonalSpace({
    serviceURL: "https://account.test",
    store: { load: async () => [], save: async () => {} },
    client: {
      snapshot: () => state,
      subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      applicationConnection: async () => {
        const boxId = state.connection?.deviceId, accountId = state.account.accountId;
        const context = () => {
          if (boxId !== state.connection?.deviceId || accountId !== state.account.accountId || state.account.phase !== "authenticated") throw failure("NETWORK_CHANGED");
          return { boxId, accountId };
        };
        await connect?.(++connections);
        context();
        return { context, request: async input => {
          context();
          if (state.phase !== "ready") throw failure("NETWORK_NOT_READY");
          calls.push({ boxId, ...input });
          return await request?.(input, calls.length) ?? response({ protocolVersion: 1, boxId });
        } };
      },
    },
  });
  t.after(() => service.close());
  return { service, calls, connections: () => connections, state: update => {
    state = { ...state, ...update };
    for (const fn of listeners) fn();
  } };
}

test("a refresh superseded during connection recovery resolves without an IPC error", async t => {
  const gate = deferred();
  const f = await fixture(t, { connect: count => count === 1 ? gate.promise : undefined });
  const pending = f.service.refresh();
  f.state({ phase: "recovering" });
  f.state({ phase: "ready" });
  gate.resolve();
  const canceled = await pending;
  assert.equal(canceled.phase, "idle");
  assert.equal(canceled.error, null);
  assert.equal(f.calls.length, 0);
  const current = await f.service.refresh();
  assert.equal(current.phase, "ready");
  assert.equal(current.overview.boxId, "box");
  assert.equal(f.connections(), 2);
});

test("a stable connection reads the overview normally", async t => {
  const f = await fixture(t);
  const current = await f.service.refresh();
  assert.equal(current.phase, "ready");
  assert.equal(current.error, null);
  assert.deepEqual(current.overview, { protocolVersion: 1, boxId: "box" });
});

test("a cached lease cannot start an overview after a box switch", async t => {
  const f = await fixture(t);
  await f.service.refresh();
  const pending = f.service.refresh();
  f.state({ connection: { deviceId: "other" } });
  const expected = f.service.snapshot();
  assert.deepEqual(await pending, expected);
  assert.deepEqual(f.service.snapshot(), expected);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.service.refresh()).overview.boxId, "other");
});

for (const transition of ["box", "account", "logout", "round-trip", "offline", "close"]) {
  test(`a pending connection refresh is canceled on ${transition}`, async t => {
    const gate = deferred();
    const f = await fixture(t, { connect: () => gate.promise });
    const pending = f.service.refresh();
    if (transition === "box" || transition === "round-trip") f.state({ connection: { deviceId: "other" } });
    if (transition === "round-trip") f.state({ connection: { deviceId: "box" } });
    if (transition === "account") f.state({ account: { phase: "authenticated", accountId: "other" } });
    if (transition === "logout") f.state({ phase: "signed-out", account: { phase: "anonymous" }, connection: null });
    if (transition === "offline") f.state({ phase: "recovering" });
    if (transition === "close") await f.service.close();
    const expected = f.service.snapshot();
    gate.resolve();
    assert.deepEqual(await pending, expected);
    assert.deepEqual(f.service.snapshot(), expected);
    assert.equal(f.calls.length, 0);
  });
}

for (const outcome of ["success", "failure"]) {
  test(`a stale overview ${outcome} cannot overwrite a refreshed box`, async t => {
    const entered = deferred(), gate = deferred();
    const f = await fixture(t, { request: async (_input, count) => {
      if (count !== 1) return;
      entered.resolve();
      await gate.promise;
      if (outcome === "failure") throw failure("SPACE_CONNECTION_TIMEOUT");
      return response({ protocolVersion: 1, boxId: "stale" });
    } });
    const pending = f.service.refresh();
    await entered.promise;
    f.state({ connection: { deviceId: "other" } });
    const current = await f.service.refresh();
    assert.equal(current.overview.boxId, "other");
    gate.resolve();
    assert.deepEqual(await pending, current);
    assert.deepEqual(f.service.snapshot(), current);
  });
}

test("an overview superseded by same-box recovery does not publish old data", async t => {
  const entered = deferred(), gate = deferred();
  const f = await fixture(t, { request: async (_input, count) => {
    if (count !== 1) return;
    entered.resolve();
    await gate.promise;
    return response({ protocolVersion: 1, boxId: "stale" });
  } });
  const pending = f.service.refresh();
  await entered.promise;
  f.state({ phase: "recovering" });
  f.state({ phase: "ready" });
  gate.resolve();
  const canceled = await pending;
  assert.equal(canceled.overview, null);
  assert.equal(canceled.error, null);
  assert.equal((await f.service.refresh()).phase, "ready");
});

test("current connection failures still reject", async t => {
  const f = await fixture(t, { connect: () => { throw failure("ACCOUNT_ACCESS_DENIED"); } });
  await assert.rejects(f.service.refresh(), { code: "ACCOUNT_ACCESS_DENIED" });
  assert.equal(f.calls.length, 0);
});

for (const [code, reply, phase] of [
  ["ACCOUNT_ACCESS_DENIED", { status: 403, body: Buffer.from(JSON.stringify({ detail: { code: "ACCOUNT_ACCESS_DENIED" } })) }, "error"],
  ["SPACE_UPGRADE_REQUIRED", response({ protocolVersion: 2 }), "unsupported"],
]) {
  test(`current overview failures still report ${code}`, async t => {
    const f = await fixture(t, { request: () => reply });
    await assert.rejects(f.service.refresh(), { code });
    assert.equal(f.service.snapshot().error, code);
    assert.equal(f.service.snapshot().phase, phase);
  });
}
