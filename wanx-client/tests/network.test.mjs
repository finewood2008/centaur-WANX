import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createNetwork } from "../network/index.mjs";
import { createSidecar } from "../network/sidecar.mjs";

const connected = (
  peers = [{ ip: "100.80.1.2", name: "box.netbird.cloud", connected: true }],
) => ({ phase: "ready", reason: null, peers });
const proxy = { port: 19876, token: "private-proxy-token-do-not-expose" };
const started = (status = connected()) => ({ proxy, status });
const error = (code) => Object.assign(new Error("secret diagnostic"), { code });
const rejectsCode = (promise, code) =>
  assert.rejects(promise, (value) => value.code === code);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness(
  t,
  handler = (method) => (method === "start" ? started() : connected()),
  options = {},
) {
  const calls = [];
  const instances = [];
  const network = createNetwork({
    ...options,
    createSidecar(config) {
      const pending = new Set();
      const instance = {
        closed: false,
        fail: config.onFailure,
        request(method, params, requestOptions) {
          calls.push({ method, params, options: requestOptions });
          return new Promise((resolve, reject) => {
            pending.add(reject);
            Promise.resolve()
              .then(() => handler(method, params, instances.length))
              .then(resolve, reject)
              .finally(() => pending.delete(reject));
          });
        },
        close() {
          this.closed = true;
          for (const reject of pending) reject(error("network_disabled"));
        },
      };
      instances.push(instance);
      return instance;
    },
  });
  t.after(() => network.close());
  return { network, calls, instances };
}

test("disabled component and direct Web development never spawn embedded engine", async (t) => {
  const { network, instances } = harness(t);
  await network.refresh();
  await network.setEnabled(false);
  for (const url of [
    "http://localhost:8088",
    "http://127.0.0.1:8088/",
    "http://[::1]:8088",
    "https://wanx.example.com",
  ])
    assert.equal(
      (await network.resolveEndpoint({ url, mode: "direct" })).mode,
      "direct",
    );
  await rejectsCode(
    network.resolveEndpoint({ url: "http://100.80.1.2:8088", mode: "netbird" }),
    "network_disabled",
  );
  assert.equal(instances.length, 0);
});

test("missing packaged engine is recoverable and never leaks diagnostic text", async (t) => {
  const { network } = harness(t, () => {
    throw error("engine_missing");
  });
  assert.deepEqual(await network.setEnabled(true), {
    enabled: true,
    phase: "unavailable",
    reason: "engine_missing",
    peers: [],
  });
  assert.equal(
    (
      await network.resolveEndpoint({
        url: "http://localhost:8088",
        mode: "direct",
      })
    ).url,
    "http://localhost:8088",
  );
});

test("connected peer resolution supplies private agent and refreshes allowlist", async (t) => {
  let status = connected();
  const { network, calls } = harness(t, (method) =>
    method === "start" ? started(status) : status,
  );
  await network.setEnabled(true);
  const endpoint = await network.resolveEndpoint({
    url: "http://100.80.1.2:8088/",
    mode: "netbird",
  });
  assert.equal(endpoint.url, "http://100.80.1.2:8088");
  assert.equal(endpoint.peer.ip, "100.80.1.2");
  assert.equal(typeof endpoint.agent.createConnection, "function");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["start", "status"],
  );
  assert.ok(!JSON.stringify(network.snapshot()).includes(proxy.token));
  status = connected([]);
  await rejectsCode(
    network.resolveEndpoint({ url: endpoint.url, mode: "netbird" }),
    "netbird_peer_unknown",
  );
});

test("disconnected and unknown peers cannot resolve", async (t) => {
  const { network } = harness(t, (method) => {
    const status = connected([{ ip: "100.80.1.2", connected: false }]);
    return method === "start" ? started(status) : status;
  });
  await network.setEnabled(true);
  await rejectsCode(
    network.resolveEndpoint({ url: "http://100.80.1.2:8088", mode: "netbird" }),
    "netbird_peer_disconnected",
  );
  await rejectsCode(
    network.resolveEndpoint({ url: "http://100.80.1.3:8088", mode: "netbird" }),
    "netbird_peer_unknown",
  );
});

test("P2P local addresses report an address mistake before checking peers", async (t) => {
  const { network, calls } = harness(t);
  await network.setEnabled(true);
  for (const host of [
    "127.0.0.1",
    "127.1",
    "127.8.9.10",
    "0x7f000001",
    "localhost",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "0.0.0.0",
    "[::]",
  ]) {
    await rejectsCode(
      network.resolveEndpoint({ url: `http://${host}:8088`, mode: "netbird" }),
      "p2p_loopback_address",
    );
  }
  assert.deepEqual(
    calls.map((call) => call.method),
    ["start"],
  );
  assert.equal(
    (
      await network.resolveEndpoint({
        url: "http://127.0.0.1:8088",
        mode: "direct",
      })
    ).url,
    "http://127.0.0.1:8088",
  );
});

test("endpoint policy rejects URL injection and cleartext non-local direct routes", async (t) => {
  const { network } = harness(t);
  await network.setEnabled(true);
  for (const url of [
    "http://user:pass@100.80.1.2:8088",
    "http://@100.80.1.2:8088",
    "http://100.80.1.2:8088?",
    "http://100.80.1.2:8088#",
    "http://100.80.1.2:8088/api",
    "http://100.80.1.2:8088/../",
    "http://100.80.1.2/16",
    " http://100.80.1.2:8088",
    "http://100.80.1.2:0",
    "file:///etc/passwd",
    "http://100.80.1.2\\@example.com",
  ])
    await rejectsCode(
      network.resolveEndpoint({ url, mode: "netbird" }),
      "invalid_endpoint",
    );
  await rejectsCode(
    network.resolveEndpoint({
      url: "https://box.netbird.cloud",
      mode: "netbird",
    }),
    "netbird_ip_required",
  );
  await rejectsCode(
    network.resolveEndpoint({ url: "http://100.80.1.2:8088", mode: "direct" }),
    "direct_https_required",
  );
});

test("disable cancels startup and ignores late completion", async (t) => {
  let complete;
  const { network, instances } = harness(
    t,
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const enabling = network.setEnabled(true);
  await tick();
  const resolving = network.resolveEndpoint({
    url: "http://100.80.1.2:8088",
    mode: "netbird",
  });
  await network.setEnabled(false);
  assert.equal(instances[0].closed, true);
  complete(started());
  assert.equal((await enabling).phase, "disabled");
  await rejectsCode(resolving, "network_disabled");
  assert.deepEqual(network.snapshot().peers, []);
});

test("enable-disable in same turn never spawns engine", async (t) => {
  const { network, instances } = harness(t);
  const enabling = network.setEnabled(true);
  await network.setEnabled(false);
  await enabling;
  assert.equal(instances.length, 0);
});

test("old generation cannot overwrite newly enabled instance", async (t) => {
  let complete;
  const { network } = harness(t, (method, params, generation) =>
    generation === 1
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : started(connected([{ ip: "100.80.9.9/16", connected: true }])),
  );
  const old = network.setEnabled(true);
  await tick();
  await network.setEnabled(false);
  await network.setEnabled(true);
  complete(started());
  await old;
  assert.equal(network.snapshot().peers[0].ip, "100.80.9.9");
});

test("engine crash clears routes and refresh starts a fresh engine", async (t) => {
  const { network, instances } = harness(t);
  await network.setEnabled(true);
  instances[0].fail("engine_exited");
  assert.equal(network.snapshot().reason, "engine_exited");
  assert.deepEqual(network.snapshot().peers, []);
  assert.equal((await network.refresh()).phase, "ready");
  assert.equal(instances.length, 2);
});

test("malformed status clears stale peers and snapshot mutation stays isolated", async (t) => {
  let status = connected();
  const { network } = harness(t, (method) =>
    method === "start" ? started(status) : status,
  );
  await network.setEnabled(true);
  network.snapshot().peers[0].ip = "1.2.3.4";
  assert.equal(network.snapshot().peers[0].ip, "100.80.1.2");
  status = { phase: "ready" };
  assert.equal((await network.refresh()).reason, "invalid_status");
  assert.deepEqual(network.snapshot().peers, []);
});

test("polling stops on disable and close is terminal", async (t) => {
  const { network, calls } = harness(t, undefined, { pollIntervalMs: 5 });
  await network.setEnabled(true);
  await network.setEnabled(false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls.length, 1);
  network.close();
  await rejectsCode(network.setEnabled(true), "network_closed");
  await rejectsCode(
    network.resolveEndpoint({ url: "http://localhost:8088", mode: "direct" }),
    "network_closed",
  );
});

test("IPv6 canonicalization rejects malformed and scoped peers", async (t) => {
  const status = connected([
    { ip: "fd00:0:0:0:0:0:0:2/64", connected: true },
    { ip: "fe80::1%eth0", connected: true },
    { ip: "100.80.1.3/99", connected: true },
  ]);
  const { network } = harness(t, (method) =>
    method === "start" ? started(status) : status,
  );
  assert.equal((await network.setEnabled(true)).peers.length, 1);
  assert.equal(
    (
      await network.resolveEndpoint({
        url: "http://[fd00::2]:8088",
        mode: "netbird",
      })
    ).peer.ip,
    "fd00::2",
  );
});

test("SSO exposes only public authorization data then starts authenticated engine", async (t) => {
  let authorized = false;
  let complete;
  const events = [];
  const { network, calls } = harness(t, (method) => {
    if (method === "start") {
      if (!authorized) throw error("auth_required");
      return started();
    }
    if (method === "login_begin")
      return {
        verificationURL: "https://login.example.com/device",
        userCode: "ABCD",
        expiresIn: 60,
        accessToken: "not-public",
      };
    if (method === "login_wait")
      return new Promise((resolve) => {
        complete = () => {
          authorized = true;
          resolve({});
        };
      });
  });
  network.subscribe((state) => events.push(state));
  assert.equal((await network.setEnabled(true)).phase, "auth_required");
  const login = network.login();
  await tick();
  assert.deepEqual(network.snapshot().authorization, {
    verificationURL: "https://login.example.com/device",
    userCode: "ABCD",
    expiresIn: 60,
  });
  assert.ok(!JSON.stringify(events).includes("not-public"));
  complete();
  assert.equal((await login).phase, "ready");
  assert.equal(network.snapshot().authorization, undefined);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["start", "login_begin", "login_wait", "start"],
  );
});

test("disable during SSO aborts wait and cannot revive engine", async (t) => {
  let complete;
  const { network, calls } = harness(t, (method) => {
    if (method === "start") throw error("auth_required");
    if (method === "login_begin")
      return {
        verificationURL: "https://login.example.com/device",
        userCode: "ABCD",
        expiresIn: 60,
      };
    if (method === "login_wait")
      return new Promise((resolve) => {
        complete = resolve;
      });
  });
  await network.setEnabled(true);
  const login = network.login();
  await tick();
  await network.setEnabled(false);
  complete({});
  assert.equal((await login).phase, "disabled");
  assert.equal(calls.filter((call) => call.method === "start").length, 1);
  assert.equal(network.snapshot().authorization, undefined);
});

test("one-time enrollment key is sent only to start and excluded from state", async (t) => {
  const { network, calls } = harness(t, (method, params) => {
    if (!params.setupKey) throw error("auth_required");
    return started();
  });
  await network.setEnabled(true);
  assert.equal(
    (await network.enroll({ setupKey: "secret-one-time-key" })).phase,
    "ready",
  );
  assert.equal(calls.at(-1).params.setupKey, "secret-one-time-key");
  assert.ok(
    !JSON.stringify(network.snapshot()).includes("secret-one-time-key"),
  );
});

test("a running engine keeps polling through temporary management disconnects", async (t) => {
  let healthy = false;
  const { network } = harness(
    t,
    (method) => {
      const status = healthy
        ? connected()
        : { phase: "error", reason: "network_unavailable", peers: [] };
      return method === "start" ? started(status) : status;
    },
    { pollIntervalMs: 5 },
  );
  assert.equal((await network.setEnabled(true)).phase, "unavailable");
  const recovered = new Promise((resolve) => {
    const unsubscribe = network.subscribe((state) => {
      if (state.phase === "ready") {
        unsubscribe();
        resolve();
      }
    });
  });
  healthy = true;
  await Promise.race([
    recovered,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("polling did not recover")),
        1000,
      );
      recovered.finally(() => clearTimeout(timer));
    }),
  ]);
});

test("default polling observes a recovered network within one second without restarting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let status = connected();
  const { network, calls, instances } = harness(t, (method) =>
    method === "start" ? started(status) : status,
  );
  const events = [];
  network.subscribe((state) => events.push(state.phase));
  await network.setEnabled(true);
  const startedEvents = events.length;
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(
    events.length,
    startedEvents,
    "unchanged polls must not repaint UI",
  );

  status = { phase: "error", reason: "network_unavailable", peers: [] };
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(network.snapshot().phase, "unavailable");
  status = connected();
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(network.snapshot().phase, "ready");
  assert.equal(instances.length, 1);
  assert.equal(calls.filter((call) => call.method === "start").length, 1);

  const recoveredEvents = events.length;
  status = connected([{ ip: "100.80.1.2", connected: false }]);
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(events.length, recoveredEvents + 1);
  assert.equal(network.snapshot().peers[0].connected, false);
  await rejectsCode(
    network.resolveEndpoint({ url: "http://100.80.1.2:8088", mode: "netbird" }),
    "netbird_peer_disconnected",
  );

  await network.setEnabled(false);
  const stoppedCalls = calls.length;
  t.mock.timers.tick(15_000);
  await tick();
  assert.equal(calls.length, stoppedCalls, "disabled P2P must stop polling");
});

test("status polling remains single-flight when a local read is slow", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  const { network, calls } = harness(t, (method) =>
    method === "start"
      ? started()
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  await network.setEnabled(true);
  t.mock.timers.tick(1000);
  await tick();
  t.mock.timers.tick(10_000);
  await tick();
  assert.equal(calls.filter((call) => call.method === "status").length, 1);
  finish(connected());
  await tick();
  await network.setEnabled(false);
});

test("SSO rejects unsafe verification URLs before exposing authorization", async (t) => {
  const { network, calls } = harness(t, (method) => {
    if (method === "start") throw error("auth_required");
    return {
      verificationURL: "http://login.example.com/device",
      userCode: "ABCD",
      expiresIn: 60,
    };
  });
  await network.setEnabled(true);
  assert.equal((await network.login()).reason, "invalid_status");
  assert.equal(network.snapshot().authorization, undefined);
  assert.ok(!calls.some((call) => call.method === "login_wait"));
});

function childHarness(t, options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  const kills = [];
  child.kill = (signal) => {
    kills.push(signal);
    return true;
  };
  const failures = [];
  const sidecar = createSidecar({
    binaryPath: "/packaged/engine",
    onFailure: (code) => failures.push(code),
    shutdownTimeoutMs: 5,
    ...options,
    spawnProcess(path, args, spawnOptions) {
      assert.equal(path, "/packaged/engine");
      assert.deepEqual(args, []);
      assert.deepEqual(spawnOptions.stdio, ["pipe", "pipe", "pipe"]);
      return child;
    },
  });
  t.after(() => {
    sidecar.close();
    child.exitCode = 0;
    child.emit("exit", 0);
  });
  return { child, sidecar, failures, kills };
}

test("NDJSON RPC keeps enrollment secrets off argv and stderr outside protocol", async (t) => {
  const { child, sidecar } = childHarness(t);
  const result = sidecar.request("start", { setupKey: "private-key" });
  const request = JSON.parse(child.stdin.read().toString());
  assert.equal(request.params.setupKey, "private-key");
  child.stderr.write("SECRET diagnostic");
  child.stdout.write(
    JSON.stringify({ id: request.id, result: started() }) + "\n",
  );
  assert.deepEqual(await result, started());
});

test("EOF rejects pending RPC and reports engine exit", async (t) => {
  const { child, sidecar, failures } = childHarness(t);
  const result = sidecar.request("status");
  child.stdout.end();
  await rejectsCode(result, "engine_exited");
  assert.deepEqual(failures, ["engine_exited"]);
});

test("invalid or oversized protocol fails closed", async (t) => {
  const { child, sidecar, failures } = childHarness(t, { maxLineBytes: 64 });
  const result = sidecar.request("status");
  child.stdout.write("x".repeat(65));
  await rejectsCode(result, "engine_protocol_error");
  assert.deepEqual(failures, ["engine_protocol_error"]);
});

test("RPC deadlines terminate hung engines without logging data", async (t) => {
  const { sidecar, failures, kills } = childHarness(t, { requestTimeoutMs: 5 });
  await rejectsCode(sidecar.request("start"), "engine_timeout");
  assert.deepEqual(failures, ["engine_timeout"]);
  assert.equal(kills.length, 1);
});

test("close cancels RPC immediately, sends stop and forcibly bounds shutdown", async (t) => {
  const { child, sidecar, kills } = childHarness(t);
  const result = sidecar.request("login_wait");
  sidecar.close();
  await rejectsCode(result, "network_disabled");
  let sent = "";
  for await (const chunk of child.stdin) sent += chunk.toString();
  assert.match(sent, /"method":"stop"/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(kills, [undefined, "SIGKILL"]);
});

test("sidecar close is idempotent and resolves only after the child exits", async (t) => {
  const { child, sidecar } = childHarness(t, { shutdownTimeoutMs: 100 });
  let completed = false;
  const first = sidecar.close();
  assert.equal(sidecar.close(), first);
  first.then(() => {
    completed = true;
  });
  await tick();
  assert.equal(completed, false);
  child.exitCode = 0;
  child.emit("exit", 0);
  await first;
  assert.equal(completed, true);
});

test("sidecar close waits through termination escalation until forced exit", async (t) => {
  const { child, sidecar, kills } = childHarness(t);
  child.kill = (signal) => {
    kills.push(signal);
    if (signal === "SIGKILL")
      setImmediate(() => {
        child.exitCode = 137;
        child.emit("exit", 137);
      });
    return true;
  };
  await sidecar.close();
  assert.deepEqual(kills, [undefined, "SIGKILL"]);
  assert.equal(child.exitCode, 137);
});

test("failed spawn without an exit event still settles close", async (t) => {
  const { child, sidecar } = childHarness(t);
  const request = sidecar.request("start");
  child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
  await rejectsCode(request, "engine_missing");
  await sidecar.close();
});

function drainingNetwork(t) {
  const drains = [];
  let spawned = 0;
  let live = 0;
  const network = createNetwork({
    createSidecar() {
      spawned += 1;
      live += 1;
      assert.equal(live, 1, "only one engine may own the identity directory");
      return {
        request: async (method) =>
          method === "start" ? started() : connected(),
        close: () =>
          new Promise((resolve) => {
            let drained = false;
            drains.push(() => {
              if (drained) return;
              drained = true;
              live -= 1;
              resolve();
            });
          }),
      };
    },
  });
  t.after(() => {
    const close = network.close();
    for (const drain of drains) drain();
    return close;
  });
  return { network, drains, spawned: () => spawned };
}

test("quick OFF/ON waits for prior process exit without overwriting newer UI state", async (t) => {
  const { network, drains, spawned } = drainingNetwork(t);
  await network.setEnabled(true);
  let offDone = false;
  const off = network.setEnabled(false).then(() => {
    offDone = true;
  });
  assert.equal(network.snapshot().phase, "disabled");
  const on = network.setEnabled(true);
  assert.equal(network.snapshot().phase, "checking");
  await tick();
  assert.equal(offDone, false);
  assert.equal(
    spawned(),
    1,
    "replacement must not open shared config while old engine drains",
  );
  drains[0]();
  await Promise.all([off, on]);
  assert.equal(spawned(), 2);
  assert.equal(network.snapshot().phase, "ready");
  let closed = false;
  const close = network.close();
  assert.equal(network.close(), close);
  close.then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  drains[1]();
  await close;
  assert.equal(closed, true);
  assert.equal(network.snapshot().phase, "disabled");
});

test("close cancels a queued replacement and still waits for the old engine exit", async (t) => {
  const { network, drains, spawned } = drainingNetwork(t);
  await network.setEnabled(true);
  const off = network.setEnabled(false);
  const on = network.setEnabled(true);
  await tick();
  assert.equal(spawned(), 1);
  let closed = false;
  const close = network.close().then(() => {
    closed = true;
  });
  assert.equal(network.snapshot().phase, "disabled");
  await tick();
  assert.equal(closed, false);
  drains[0]();
  await Promise.all([off, on, close]);
  assert.equal(spawned(), 1, "queued stale ON must never spawn after close");
  assert.equal(closed, true);
  assert.equal(network.snapshot().phase, "disabled");
});

test("a newer OFF cancels a queued replacement before it can spawn", async (t) => {
  const { network, drains, spawned } = drainingNetwork(t);
  await network.setEnabled(true);
  const firstOff = network.setEnabled(false);
  const on = network.setEnabled(true);
  await tick();
  await network.setEnabled(false);
  drains[0]();
  await Promise.all([firstOff, on]);
  assert.equal(spawned(), 1);
  assert.equal(network.snapshot().phase, "disabled");
});


test("network changes deduplicate recovery and retain the existing target agent", async (t) => {
  let finish;
  const { network, calls } = harness(t, (method) => {
    if (method === "recover") return new Promise((resolve) => { finish = resolve; });
    return method === "start" ? started() : connected();
  });
  await network.setEnabled(true);
  const input = { url: "http://100.80.1.2:8088", mode: "netbird" };
  const initial = await network.resolveEndpoint(input);
  initial.agent.probe = async () => false;
  const first = network.networkChanged();
  assert.equal(network.networkChanged(), first);
  await tick();
  assert.equal(network.snapshot().phase, "recovering");
  finish(started());
  await first;
  assert.equal((await network.resolveEndpoint(input)).agent, initial.agent);
  assert.equal(calls.filter((c) => c.method === "recover").length, 1);
  assert.ok(!JSON.stringify(network.snapshot()).includes(proxy.token));
});

test("healthy target probe avoids restarting after an interface event", async (t) => {
  const { network, calls } = harness(t);
  await network.setEnabled(true);
  const endpoint = await network.resolveEndpoint({ url: "http://100.80.1.2:8088", mode: "netbird" });
  endpoint.agent.probe = async () => true;
  await network.networkChanged();
  assert.equal(calls.filter((c) => c.method === "recover").length, 0);
});

test("disabled network never starts recovery; disable cancels in-flight recovery", async (t) => {
  let finish;
  const { network, calls } = harness(t, (method) => method === "recover"
    ? new Promise((resolve) => { finish = resolve; })
    : started());
  await network.networkChanged();
  assert.equal(calls.length, 0);
  await network.setEnabled(true);
  const recovering = network.networkChanged();
  await tick();
  await network.setEnabled(false);
  finish(started());
  assert.equal((await recovering).phase, "disabled");
});

test("temporary recovery failure retries saved identity with backoff and stops on auth denial", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let denied = false;
  const { network, calls } = harness(t, (method) => {
    if (method === "recover") throw error(denied ? "auth_required" : "start_failed");
    return method === "start" ? started() : { phase: "recovering", peers: [] };
  });
  await network.setEnabled(true);
  assert.equal((await network.networkChanged()).phase, "recovering");
  await network.refresh();
  assert.equal(calls.filter((c) => c.method === "recover").length, 1);
  denied = true;
  t.mock.timers.tick(5_000);
  await tick();
  assert.equal(network.snapshot().phase, "auth_required");
  assert.equal(calls.filter((c) => c.method === "recover").length, 2);
});


test("control and peer connectivity changes preserve sockets; peer removal retires once", async (t) => {
  let status = connected();
  const { network } = harness(t, (method) => method === "start" ? started(status) : status);
  await network.setEnabled(true);
  const endpoint = await network.resolveEndpoint({ url: "http://100.80.1.2:8088", mode: "netbird" });
  let resets = 0;
  endpoint.agent.resetConnections = () => { resets++; };
  status = { phase: "recovering", peers: [] };
  await network.refresh();
  assert.equal(resets, 0);
  status = connected();
  await network.refresh();
  status = connected([{ ip: "100.80.1.2", connected: false }]);
  await network.refresh();
  await network.refresh();
  assert.equal(resets, 0, "a connectivity hint must not close an existing stream");
  status = connected([]);
  await network.refresh();
  await network.refresh();
  assert.equal(resets, 1, "removal from the current peer map still retires transport");
});


test("connected target resolves during control-plane recovery but missing/disconnected peers cannot", async (t) => {
  let status = connected();
  const { network } = harness(t, (method) => method === "start" ? started(status) : status);
  await network.setEnabled(true);
  const input = { url: "http://100.80.1.2:8088", mode: "netbird" };
  status = { ...connected(), phase: "recovering", reason: "network_unavailable" };
  const endpoint = await network.resolveEndpoint(input);
  assert.equal(endpoint.peer.connected, true);
  assert.equal(typeof endpoint.agent.createConnection, "function");
  status.peers[0].connected = false;
  await rejectsCode(network.resolveEndpoint(input), "netbird_peer_disconnected");
  status.peers = [];
  await rejectsCode(network.resolveEndpoint(input), "netbird_peer_unknown");
});

for (const code of ["engine_exited", "engine_timeout"]) {
  test(`${code} automatically starts a replacement engine without manual refresh`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { network, instances } = harness(t);
    await network.setEnabled(true);
    instances[0].fail(code);
    assert.equal(network.snapshot().phase, "unavailable");
    t.mock.timers.tick(4_999);
    await tick();
    assert.equal(instances.length, 1);
    t.mock.timers.tick(1);
    await tick();
    assert.equal(instances.length, 2);
    assert.equal(network.snapshot().phase, "ready");
  });
}

for (const stop of ["disable", "close"]) {
  test(`engine restart is cancelled by ${stop}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { network, instances } = harness(t);
    await network.setEnabled(true);
    instances[0].fail("engine_timeout");
    if (stop === "disable") await network.setEnabled(false);
    else await network.close();
    t.mock.timers.tick(60_000);
    await tick();
    assert.equal(instances.length, 1);
    assert.equal(network.snapshot().enabled, false);
  });
}

test("engine startup failures back off and stop retrying on authorization denial", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let code = "start_failed";
  const { network, calls } = harness(t, () => { throw error(code); });
  await network.setEnabled(true);
  for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
    const count = calls.length;
    t.mock.timers.tick(delay - 1);
    await tick();
    assert.equal(calls.length, count);
    t.mock.timers.tick(1);
    await tick();
    assert.equal(calls.length, count + 1);
  }
  code = "auth_required";
  t.mock.timers.tick(60_000);
  await tick();
  const count = calls.length;
  t.mock.timers.tick(120_000);
  await tick();
  assert.equal(calls.length, count);
  assert.equal(network.snapshot().phase, "auth_required");
});

test("an idle control connection recovers automatically after a sustained outage", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let down = false;
  const { network, calls } = harness(t, method => {
    if (method === "start") return started();
    if (method === "recover") { down = false; return started(); }
    return down ? { phase: "recovering", peers: [] } : connected();
  });
  await network.setEnabled(true);
  down = true;
  await network.refresh();
  t.mock.timers.tick(19_000);
  await tick();
  assert.equal(calls.filter(c => c.method === "recover").length, 0);
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(calls.filter(c => c.method === "recover").length, 1);
  assert.equal(network.snapshot().phase, "ready");
});

test("SDK self-recovery during the grace period avoids an engine restart", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let status = connected();
  const { network, calls } = harness(t, method => method === "start" ? started() : status);
  await network.setEnabled(true);
  status = { phase: "recovering", peers: [] };
  await network.refresh();
  t.mock.timers.tick(19_000);
  await tick();
  status = connected();
  t.mock.timers.tick(1000);
  await tick();
  t.mock.timers.tick(60_000);
  await tick();
  assert.equal(network.snapshot().phase, "ready");
  assert.equal(calls.filter(c => c.method === "recover").length, 0);
});

test("a recovery that starts but remains degraded retries with bounded backoff", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const down = { phase: "recovering", peers: [] };
  const { network, calls } = harness(t, method =>
    method === "start" ? started() : method === "recover" ? started(down) : down);
  await network.setEnabled(true);
  await network.refresh();
  t.mock.timers.tick(20_000);
  await tick();
  assert.equal(calls.filter(c => c.method === "recover").length, 1);
  for (const wait of [5000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
    const before = calls.filter(c => c.method === "recover").length;
    t.mock.timers.tick(wait - 1);
    await tick();
    await network.refresh();
    assert.equal(calls.filter(c => c.method === "recover").length, before);
    t.mock.timers.tick(1);
    await tick();
    await network.refresh();
    assert.equal(calls.filter(c => c.method === "recover").length, before + 1);
  }
});

test("a healthy target preserves streams during a prolonged control-plane outage", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let status = connected([
    { ip: "100.80.1.2", connected: true }, { ip: "100.80.1.3", connected: true },
  ]);
  const { network, calls } = harness(t, method => method === "start" ? started(status) : status);
  await network.setEnabled(true);
  const first = await network.resolveEndpoint({ url: "http://100.80.1.2:8088", mode: "netbird" });
  const second = await network.resolveEndpoint({ url: "http://100.80.1.3:8088", mode: "netbird" });
  let resets = 0;
  first.agent.probe = async () => false;
  second.agent.probe = async () => true;
  first.agent.resetConnections = second.agent.resetConnections = () => { resets++; };
  status = { phase: "recovering", peers: [] };
  await network.refresh();
  t.mock.timers.tick(20_000);
  await tick();
  t.mock.timers.tick(20_000);
  await tick();
  assert.equal(calls.filter(c => c.method === "recover").length, 0);
  assert.equal(resets, 0);
});

for (const stop of ["disable", "close"]) {
  test(`sustained-outage recovery is cancelled by ${stop}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { network, calls } = harness(t, method => method === "start" ? started() : { phase: "recovering", peers: [] });
    await network.setEnabled(true);
    await network.refresh();
    if (stop === "disable") await network.setEnabled(false);
    else await network.close();
    t.mock.timers.tick(60_000);
    await tick();
    assert.equal(calls.filter(c => c.method === "recover").length, 0);
    assert.equal(network.snapshot().enabled, false);
  });
}

test("automatic recovery stops after explicit authentication rejection", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { network, calls } = harness(t, method => {
    if (method === "recover") throw error("auth_required");
    return method === "start" ? started() : { phase: "recovering", peers: [] };
  });
  await network.setEnabled(true);
  await network.refresh();
  t.mock.timers.tick(20_000);
  await tick();
  assert.equal(network.snapshot().phase, "auth_required");
  const count = calls.length;
  t.mock.timers.tick(120_000);
  await tick();
  assert.equal(calls.length, count);
});

 test("interface change does not restart healthy targets because another target is offline", async t => {
  const status = connected([{ip:"100.80.1.2",connected:true},{ip:"100.80.1.3",connected:true}]);
  const {network,calls}=harness(t, method => method === "start" || method === "recover" ? started(status) : status);
  await network.setEnabled(true);
  const first=await network.resolveEndpoint({url:"http://100.80.1.2:8088",mode:"netbird"});
  const second=await network.resolveEndpoint({url:"http://100.80.1.3:8088",mode:"netbird"});
  first.agent.probe=async()=>false;second.agent.probe=async()=>true;
  let resets=0;
  first.agent.resetConnections=second.agent.resetConnections=()=>{resets++};
  await network.networkChanged();
  assert.equal(calls.filter(c=>c.method==="recover").length,0);
  assert.equal(resets,0);
 });
 test("stale native observations remain distinguishable without allowing a new target", async t => {
  const stale={phase:"recovering",reason:"network_status_stale",peers:[]};
  const {network}=harness(t, method => method === "start" ? started() : stale);
  await network.setEnabled(true);
  await network.refresh();
  assert.equal(network.snapshot().reason,"network_status_stale");
  await rejectsCode(network.resolveEndpoint({url:"http://100.80.1.2:8088",mode:"netbird"}),"netbird_peer_unknown");
 });

test("authoritative peer removal after a stale sample revokes existing transport", async t => {
 let status=connected();
 const {network}=harness(t,method=>method==="start"?started(status):status);
 await network.setEnabled(true);
 const input={url:"http://100.80.1.2:8088",mode:"netbird"};
 const endpoint=await network.resolveEndpoint(input);
 let resets=0;endpoint.agent.resetConnections=()=>{resets++};
 status={phase:"recovering",reason:"network_status_stale",peers:[]};
 await network.refresh();assert.equal(resets,0);
 status=connected([]);await network.refresh();await network.refresh();
 assert.equal(resets,1);
 await rejectsCode(network.resolveEndpoint(input),"netbird_peer_unknown");
 status=connected();const replacement=await network.resolveEndpoint(input);
 assert.notEqual(replacement.agent,endpoint.agent);
});
