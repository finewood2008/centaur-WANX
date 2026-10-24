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
  recover = async () => {},
  measure,
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
    networkChanged: recover,
  };
  const client = createClient({
    network,
    probe,
    measure,
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

test("initial connection measures real transport stages and preserves probe failure", async t => {
  const stages = [];
  let unhealthy = false;
  const f = fixture({
    probe: async () => { if (unhealthy) throw new Error("health_timeout"); },
    measure: async (step, operation) => {
      try { const result = await operation(); stages.push([step, "completed"]); return result; }
      catch (error) { stages.push([step, "failed"]); throw error; }
    },
  });
  t.after(() => f.client.close());
  await f.client.connect(direct, { createSession: async () => ({ close: async () => {} }) });
  assert.deepEqual(stages, [
    ["box.cleanup", "completed"], ["box.endpoint", "completed"], ["box.health", "completed"],
    ["box.session", "completed"], ["box.gateway", "completed"],
  ]);
  stages.length = 0;
  unhealthy = true;
  await assert.rejects(f.client.connect(direct), /health_timeout/);
  assert.deepEqual(stages, [["box.cleanup", "completed"], ["box.endpoint", "completed"], ["box.health", "failed"]]);
  assert.equal(f.client.snapshot().phase, "disconnected");
});

const settle = () => new Promise(setImmediate);
async function advance(t, ms = 30_000) {
  t.mock.timers.tick(ms);
  await settle();
}

test("checks the selected box every 30 seconds through its original agent without replacing the gateway", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const agent = {}, probes = [];
  const f = fixture({
    resolveEndpoint: input => ({ url: input.url, agent }),
    probe: async (url, options) => { probes.push({ url, ...options }); },
  });
  t.after(() => f.client.close());
  await f.client.connect(direct);
  await advance(t, 29_999);
  assert.equal(probes.length, 1);
  await advance(t, 1);
  assert.equal(probes.length, 2);
  assert.equal(probes[1].agent, agent);
  assert.equal(probes[1].url, direct.url);
  await advance(t);
  assert.equal(probes.length, 3);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].closed, false);
});

test("automatic recovery backs off beyond three failures and restores the same selected box", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let down = false, recoveries = 0;
  const f = fixture({ probe: async () => { if (down) throw new Error("health_timeout"); },
    recover: async () => { recoveries++; } });
  t.after(() => f.client.close());
  await f.client.setNetworkEnabled(true);
  await f.client.connect(overlay);
  down = true;
  await advance(t);
  for (const delay of [1000, 2000, 5000, 10000, 30000, 60000, 60000]) {
    const previous = recoveries;
    await advance(t, delay - 1);
    assert.equal(recoveries, previous);
    await advance(t, 1);
    assert.equal(recoveries, previous + 1);
    assert.equal(f.client.snapshot().phase, "recovering");
    assert.equal(f.client.snapshot().connection.deviceId, overlay.deviceId);
    assert.equal(f.created[0].closed, false);
  }
  assert.ok(recoveries > 3);
  down = false;
  await f.client.retryConnection();
  assert.equal(f.client.snapshot().phase, "ready");
  assert.equal(f.client.snapshot().recovery, null);
  assert.equal(f.created.length, 1);
});

test("successful recovery preserves the application lease and resets the next outage budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let down = false, recoveries = 0, sessions = 0;
  const f = fixture({
    probe: async () => { if (down) throw new Error("health_unavailable"); },
    recover: async () => { recoveries++; down = false; },
    createGateway: async () => ({ url: "http://127.0.0.1:18000", request: async () => "alive", close() {} }),
  });
  t.after(() => f.client.close());
  await f.client.setNetworkEnabled(true);
  await f.client.connect(overlay, { createSession: async () => { sessions++; return { close() {} }; } });
  const lease = f.client.applicationConnection("test.app");
  for (let i = 0; i < 4; i++) {
    down = true;
    await advance(t);
    assert.equal(f.client.snapshot().phase, "ready");
    assert.equal(await lease.request({ path: "/api/health" }), "alive");
  }
  assert.equal(recoveries, 4);
  assert.equal(sessions, 1);
});

for (const action of ["disconnect", "close", "disable", "auth_required", "switch"]) {
  test(`${action} cancels a pending health check and ignores its late failure`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const wait = deferred();
    let probes = 0, pendingSignal, recoveries = 0;
    const f = fixture({
      probe: async (_url, { signal }) => {
        if (++probes === 2) { pendingSignal = signal; await wait.promise; throw new Error("health_timeout"); }
      },
      recover: async () => { recoveries++; },
    });
    t.after(() => f.client.close());
    await f.client.setNetworkEnabled(true);
    await f.client.connect(overlay);
    await advance(t);
    assert.ok(pendingSignal, "the periodic probe must have started");
    let closing;
    if (action === "disable") await f.client.setNetworkEnabled(false);
    else if (action === "auth_required") f.emit({ phase: "auth_required" });
    else if (action === "switch") await f.client.connect({ ...overlay, deviceId: "box-b" });
    else if (action === "close") closing = f.client.close();
    else await f.client[action]();
    assert.equal(pendingSignal.aborted, true);
    wait.resolve();
    await closing;
    await settle();
    await advance(t);
    assert.equal(recoveries, 0);
    assert.equal(f.client.snapshot().connection?.deviceId ?? null, action === "switch" ? "box-b" : null);
  });
}

test("slow health probes never overlap", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const wait = deferred();
  let probes = 0;
  const f = fixture({ probe: async () => { if (++probes > 1) await wait.promise; } });
  t.after(() => f.client.close());
  await f.client.connect(direct);
  await advance(t);
  await advance(t, 300_000);
  assert.equal(probes, 2);
  wait.resolve();
  await settle();
  await advance(t);
  assert.equal(probes, 3);
});

for (const code of ["auth_failed", "auth_expired", "auth_unsupported"]) {
  test(`${code} is terminal even when the network reports unavailable`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let recoveries = 0;
    const f = fixture({ recover: async () => { recoveries++; } });
    t.after(() => f.client.close());
    await f.client.setNetworkEnabled(true);
    await f.client.connect(overlay);
    f.emit({ phase: "unavailable", reason: code });
    assert.equal(f.client.snapshot().connection, null);
    assert.equal(f.client.snapshot().reason, "connection_authorization_required");
    await advance(t, 300_000);
    assert.equal(recoveries, 0);
  });
}

for (const denied of [false, true]) {
  test(`engine restart obtains a fresh authorized session${denied ? " and stops on denial" : " with a replacement gateway"}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const oldAgent = {}, newAgent = {};
    let agent = oldAgent, down = false, sessions = 0, recoveries = 0;
    const gateways = [];
    const f = fixture({
      resolveEndpoint: input => ({ url: input.url, agent }),
      probe: async (_url, options) => { if (down && options.agent === oldAgent) throw new Error("health_unavailable"); },
      recover: async () => { recoveries++; agent = newAgent; },
      createGateway: async ({ agent: gatewayAgent, session }) => {
        const gateway = { url: `http://127.0.0.1:${19000 + gateways.length}`, agent: gatewayAgent, closed: false,
          request: async () => "alive", close() { this.closed = true; session.close(); } };
        gateways.push(gateway);
        return gateway;
      },
    });
    t.after(() => f.client.close());
    await f.client.setNetworkEnabled(true);
    await f.client.connect(overlay, { createSession: async () => {
      if (++sessions > 1 && denied) throw Object.assign(new Error("denied"), { status: 403 });
      return { close() {} };
    } });
    const previousLease = f.client.applicationConnection("test.app");
    down = true;
    await advance(t);
    assert.equal(sessions, 2);
    assert.equal(gateways[0].closed, true);
    assert.throws(() => previousLease.request({}), /SESSION_CLOSED/);
    if (denied) {
      assert.equal(f.client.snapshot().reason, "connection_authorization_required");
      await advance(t, 300_000);
      assert.equal(recoveries, 1);
    } else {
      assert.equal(f.client.snapshot().phase, "ready");
      assert.equal(gateways[1].agent, newAgent);
      assert.equal(await f.client.applicationConnection("test.app").request({}), "alive");
    }
  });
}

test("close waits for a late recovery gateway to be disposed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldAgent = {}, newAgent = {}, wait = deferred();
  let agent = oldAgent, down = false, count = 0, closed = false, disposed = false;
  const f = fixture({
    resolveEndpoint: input => ({ url: input.url, agent }),
    probe: async (_url, options) => { if (down && options.agent === oldAgent) throw new Error("health_unavailable"); },
    recover: async () => { agent = newAgent; },
    createGateway: async () => ++count === 1 ? { url: "http://127.0.0.1:19000", close() {} } : wait.promise,
  });
  t.after(() => f.client.close());
  await f.client.setNetworkEnabled(true);
  await f.client.connect(overlay);
  down = true;
  await advance(t);
  assert.equal(count, 2);
  const closing = f.client.close().then(() => { closed = true; });
  await settle();
  assert.equal(closed, false);
  wait.resolve({ url: "http://127.0.0.1:19001", close() { disposed = true; } });
  await closing;
  assert.equal(disposed, true);
  assert.equal(f.client.snapshot().connection, null);
});

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

test("peer status recovery waits for data-path verification and preserves the gateway", async () => {
  const { client, created, emit } = fixture();
  await client.setNetworkEnabled(true);
  await client.connect(overlay);
  emit({ peers: [] });
  assert.equal(client.snapshot().phase, "recovering");
  assert.equal(created[0].closed, false);
  emit({ phase: "recovering" });
  assert.equal(created[0].closed, false);
  emit({ phase: "ready", peers: [{ ip: "100.90.1.2", connected: true }] });
  assert.equal(client.snapshot().phase, "recovering");
  await client.retryConnection();
  assert.equal(client.snapshot().phase, "ready");
  assert.equal(created.length, 1, "recovery must not recreate login or gateway");
  emit({ phase: "unavailable" });
  assert.equal(created[0].closed, false);
  assert.equal(client.snapshot().phase, "recovering");
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

test("business failure starts recovery without replaying the user's request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let writes = 0;
  const f = fixture({createGateway: async () => ({url:'http://127.0.0.1:19800',
    request: async () => {writes++; throw Object.assign(new Error('reset'),{code:'ECONNRESET'});}, close() {}})});
  t.after(()=>f.client.close());
  await f.client.connect(direct);
  await assert.rejects(f.client.request({method:'POST',path:'/api/chat',body:'one message'}),{code:'ECONNRESET'});
  assert.equal(f.client.snapshot().phase,'recovering');
  await advance(t,0);
  assert.equal(f.client.snapshot().phase,'ready');
  assert.equal(writes,1);
});

test("engine recovery can replace only the transport while retaining app leases", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldAgent={},newAgent={}; let agent=oldAgent,down=false,replaced=0,closed=false;
  const f=fixture({resolveEndpoint:input=>({url:input.url,agent}),
    probe:async(_url,input)=>{if(down&&input.agent===oldAgent)throw new Error('health_timeout');},
    recover:async()=>{agent=newAgent;},
    createGateway:async()=>({url:'http://127.0.0.1:19800',request:async()=> 'alive',
      replaceTransport(input){assert.equal(input.agent,newAgent);replaced++;},close(){closed=true;}})});
  t.after(()=>f.client.close());
  await f.client.setNetworkEnabled(true); await f.client.connect(overlay);
  const lease=f.client.applicationConnection('test.app'); down=true;
  await advance(t);
  assert.equal(f.client.snapshot().phase,'ready'); assert.equal(replaced,1);assert.equal(closed,false);
  assert.equal(await lease.request({path:'/api/health'}),'alive');
});

test("stopping a prolonged recovery prevents retry and network events from restoring it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let down=false,probes=0;
  const f=fixture({probe:async()=>{probes++;if(down)throw new Error('health_timeout');}});
  t.after(()=>f.client.close()); await f.client.connect(direct);down=true;
  await advance(t); await advance(t,1000); await advance(t,2000);await advance(t,5000);
  await f.client.disconnect();const before=probes;down=false;
  await advance(t,600000);await f.client.networkChanged();await f.client.retryConnection();
  assert.equal(probes,before);assert.equal(f.client.snapshot().connection,null);
});

test('peer-map synchronization retries without repeatedly restarting the engine',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let ready=true,restarts=0;
  const f=fixture({resolveEndpoint:input=>{if(!ready)throw Object.assign(new Error('unknown'),{code:'netbird_peer_unknown'});return {url:input.url};},recover:async()=>{restarts++;}});
  t.after(()=>f.client.close());await f.client.setNetworkEnabled(true);await f.client.connect(overlay);
  ready=false;f.emit({phase:'unavailable'});await advance(t,0);
  await advance(t,1000);await advance(t,2000);await advance(t,5000);
  assert.equal(restarts,0);assert.equal(f.client.snapshot().phase,'recovering');
  ready=true;f.emit({phase:'ready',peers:[{ip:'100.90.1.2',connected:true}]});
  await f.client.retryConnection();assert.equal(f.client.snapshot().phase,'ready');assert.equal(restarts,0);
});
