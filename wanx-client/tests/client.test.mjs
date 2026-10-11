import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../client.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture({
  resolveEndpoint,
  createGateway,
  probe = async () => ({ ok: true }),
} = {}) {
  let state = { enabled: false, phase: "disabled", reason: null, peers: [] };
  const listeners = new Set();
  const created = [];
  let resolves = 0;
  const network = {
    snapshot: () => structuredClone(state),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async setEnabled(enabled) {
      state = {
        enabled,
        phase: enabled ? "ready" : "disabled",
        reason: null,
        peers: enabled ? [{ ip: "100.90.1.2", connected: true }] : [],
      };
      for (const fn of listeners) fn(state);
      return state;
    },
    async resolveEndpoint(input) {
      resolves += 1;
      if (input.mode === "netbird" && !state.enabled)
        throw new Error("network_disabled");
      return resolveEndpoint ? resolveEndpoint(input) : { url: input.url };
    },
    close() {},
  };
  const client = createClient({
    network,
    probe,
    createGateway:
      createGateway ||
      (async ({ targetURL }) => {
        const gateway = {
          targetURL,
          url: `http://127.0.0.1:${18000 + created.length}`,
          closed: false,
          async close() {
            this.closed = true;
          },
        };
        created.push(gateway);
        return gateway;
      }),
  });
  return {
    client,
    network,
    created,
    emit(next) {
      state = { ...state, ...next };
      for (const fn of listeners) fn(state);
    },
    get resolves() {
      return resolves;
    },
  };
}
const overlay = {
  deviceId: "box-a",
  name: "A",
  url: "http://100.90.1.2:8088/",
  mode: "netbird",
};
const direct = {
  deviceId: "local",
  url: "http://127.0.0.1:8088/",
  mode: "direct",
};

test("direct development works with the network disabled; toggling does not replace its session", async () => {
  const { client, created } = fixture();
  assert.equal(client.snapshot().network.enabled, false);
  await client.connect(direct);
  await client.setNetworkEnabled(true);
  await client.setNetworkEnabled(false);
  assert.equal(client.snapshot().connection.deviceId, "local");
  assert.equal(created[0].closed, false);
  await client.close();
  assert.equal(created[0].closed, true);
});

test("disable closes overlay immediately without a direct fallback", async () => {
  const { client, created } = fixture();
  await client.setNetworkEnabled(true);
  await client.connect(overlay);
  await client.setNetworkEnabled(false);
  assert.equal(created[0].closed, true);
  assert.equal(client.snapshot().connection, null);
  await assert.rejects(client.connect(overlay), /network_disabled/);
  assert.equal(created.length, 1);
  await client.close();
});

test("a late endpoint result cannot recreate a connection after disable", async () => {
  const wait = deferred();
  const { client, created } = fixture({ resolveEndpoint: () => wait.promise });
  await client.setNetworkEnabled(true);
  const connecting = client.connect(overlay);
  await new Promise(setImmediate);
  await client.setNetworkEnabled(false);
  wait.resolve({ url: overlay.url });
  await connecting;
  assert.equal(created.length, 0);
  assert.equal(client.snapshot().phase, "disconnected");
  await client.close();
});

test("a late gateway is closed after disconnect", async () => {
  const wait = deferred();
  let disposed = false;
  const { client } = fixture({ createGateway: () => wait.promise });
  const connecting = client.connect(direct);
  await new Promise(setImmediate);
  await client.disconnect();
  wait.resolve({
    url: "http://127.0.0.1:19000",
    async close() {
      disposed = true;
    },
  });
  await connecting;
  assert.equal(disposed, true);
  assert.equal(client.snapshot().connection, null);
  await client.close();
});

test("a newer box choice supersedes an earlier resolution and closes old gateway", async () => {
  const wait = deferred();
  const { client, created } = fixture({
    resolveEndpoint: (input) =>
      input.deviceId === "slow" ? wait.promise : { url: input.url },
  });
  await client.connect(direct);
  const slow = client.connect({ ...direct, deviceId: "slow" });
  await new Promise(setImmediate);
  await client.connect({ ...direct, deviceId: "latest" });
  wait.resolve({ url: direct.url });
  await slow;
  assert.equal(client.snapshot().connection.deviceId, "latest");
  assert.equal(created.length, 2);
  assert.equal(created[0].closed, true);
  await client.close();
});

test("transient peer/control-plane loss preserves gateway; terminal failure closes it", async () => {
  const { client, created, emit } = fixture();
  await client.setNetworkEnabled(true);
  await client.connect(overlay);
  emit({ peers: [] });
  assert.equal(client.snapshot().phase, "recovering");
  assert.equal(created[0].closed, false);
  emit({ phase: "recovering" });
  assert.equal(created[0].closed, false);
  emit({ phase: "ready", peers: [{ ip: "100.90.1.2", connected: true }] });
  assert.equal(client.snapshot().phase, "ready");
  assert.equal(created.length, 1, "recovery must not recreate login or gateway");
  emit({ phase: "unavailable" });
  assert.equal(created[0].closed, true);
  assert.equal(client.snapshot().reason, "network_unavailable");
  await client.close();
});

test("invalid identifiers and modes never enter transport resolution", async () => {
  const f = fixture();
  await assert.rejects(
    f.client.connect({ ...direct, deviceId: "../box" }),
    /invalid_connection/,
  );
  await assert.rejects(
    f.client.connect({ ...direct, mode: "other" }),
    /invalid_connection/,
  );
  assert.equal(f.resolves, 0);
  await f.client.close();
  await assert.rejects(f.client.connect(direct), /client_closed/);
});

test("disconnect aborts an in-flight health probe", async () => {
  let signal;
  const wait = deferred();
  const { client, created } = fixture({
    probe: (_url, options) => {
      signal = options.signal;
      return wait.promise;
    },
  });
  const connecting = client.connect(direct);
  await new Promise(setImmediate);
  await client.disconnect();
  assert.equal(signal.aborted, true);
  wait.resolve();
  await connecting;
  assert.equal(created.length, 0);
  await client.close();
});

test("an unavailable WANX never opens a Dashboard session", async () => {
  const { client, created } = fixture({
    probe: async () => {
      throw new Error("health_unavailable");
    },
  });
  await assert.rejects(client.connect(direct), /health_unavailable/);
  assert.equal(client.snapshot().phase, "disconnected");
  assert.equal(client.snapshot().reason, "health_unavailable");
  assert.equal(created.length, 0);
  await client.close();
});

test("a newer enable wins while an older disable drains the gateway", async () => {
  const drain = deferred();
  const { client } = fixture({
    createGateway: async () => ({
      url: "http://127.0.0.1:19000",
      close: () => drain.promise,
    }),
  });
  await client.setNetworkEnabled(true);
  await client.connect(overlay);
  const disabling = client.setNetworkEnabled(false);
  await client.setNetworkEnabled(true);
  drain.resolve();
  await disabling;
  assert.equal(client.snapshot().network.enabled, true);
  assert.equal(client.snapshot().connection, null);
  await client.close();
});

test("close waits for an in-flight gateway to be disposed", async () => {
  const creation = deferred();
  let disposed = false;
  let done = false;
  const { client } = fixture({ createGateway: () => creation.promise });
  const connecting = client.connect(direct);
  await new Promise(setImmediate);
  const closing = client.close().then(() => {
    done = true;
  });
  await new Promise(setImmediate);
  assert.equal(done, false);
  creation.resolve({
    url: "http://127.0.0.1:19000",
    async close() {
      disposed = true;
    },
  });
  await Promise.all([connecting, closing]);
  assert.equal(done, true);
  assert.equal(disposed, true);
});

for (const end of ["disabled", "auth_required"]) {
  test(`recovery cannot retain a gateway after ${end}`, async () => {
    const { client, created, emit } = fixture();
    await client.setNetworkEnabled(true);
    await client.connect(overlay);
    emit({ phase: "recovering" });
    emit({ enabled: end !== "disabled", phase: end });
    assert.equal(client.snapshot().connection, null);
    assert.equal(created[0].closed, true);
    await client.close();
  });
}
