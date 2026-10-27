import test from "node:test";
import assert from "node:assert/strict";
import { createPlatformClient } from "../platform.mjs";
import { createClient } from "../client.mjs";
import { createNetwork } from "../network/index.mjs";
import { createTeamConnection } from "../shell/team-connection.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));
const fail = (code, status) => Object.assign(new Error(code), { code, status });
const device = {
  deviceId: "box-1",
  identityDeviceId: "identity-1",
  displayName: "我的盒子",
  serviceUrl: "http://100.80.1.2:8088",
  ownershipEpoch: 1,
  authorizationVersion: 1,
  deviceRole: "owner",
};
function harness(t, options = {}) {
  let state = { phase: "signed_out", accountId: null, clientId: null };
  const listeners = new Set(),
    keys = new Set(),
    calls = [],
    transports = [],
    sessions = [];
  let serverSession = options.serverSession || null,
    nextID = 0,
    catalog = [device],
    override;
  const publish = (next) => {
    state = next;
    for (const listener of listeners) listener(next);
    return next;
  };
  const result = (phase = "ready") => ({
    enrollmentId: serverSession,
    networkSessionId: serverSession,
    phase,
    managementUrl: "https://p2p.qeeshu.com",
    leaseExpiresAt: Date.now() / 1000 + 300,
  });
  const account = {
    snapshot: () => structuredClone(state),
    getIdentity: () =>
      state.phase === "authenticated"
        ? { accountId: state.accountId, clientId: state.clientId }
        : null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restore: async () =>
      options.restoreIdentity
        ? publish({
            phase: "authenticated",
            accountId: options.restoreIdentity.accountId,
            clientId: options.restoreIdentity.clientId,
          })
        : state,
    loginPassword: async ({ phone }) =>
      publish({
        phase: "authenticated",
        accountId: phone,
        clientId: `client-${phone}`,
      }),
    loginSMS: async ({ phone }) =>
      publish({
        phase: "authenticated",
        accountId: phone,
        clientId: `client-${phone}`,
      }),
    sendSMS: async () => ({ expiresIn: 300 }),
    listDevices: async () =>
      catalog.map((d) => ({ deviceId: d.deviceId, deviceName: d.displayName })),
    request: async (input) => {
      calls.push(input);
      if (override) {
        const replacement = await override(input);
        if (replacement !== undefined) return replacement;
      }
      if (
        ["/app-api/network/boxes", "/app-api/network/boxes/prepare"].includes(
          input.path,
        )
      )
        return {
          boxes: catalog.map((item) => ({ ...item, accessState: "ready" })),
        };
      if (input.path === "/app-api/network/restore") {
        if (!serverSession) throw fail("NETWORK_ENROLLMENT_REQUIRED", 404);
        return result();
      }
      if (input.path === "/app-api/network/enrollments") {
        serverSession = `enrollment-${++nextID}`;
        return { ...result("enrolling"), setupKey: "private-registration-key" };
      }
      if (input.path.startsWith("/app-api/network/enrollments/"))
        return result();
      if (input.path === "/app-api/network/devices")
        return { networkSessionId: serverSession, devices: catalog, phase: "ready",
          leaseExpiresAt: result().leaseExpiresAt };
      if (input.path === "/app-api/network/current") {
        serverSession = null;
        return { phase: "revoked" };
      }
      throw Error(`unexpected route ${input.path}`);
    },
    logout: async (options) => {
      calls.push({ path: "logout", options });
      serverSession = null;
      return publish({ phase: "signed_out", accountId: null, clientId: null });
    },
    close: async () => {},
  };
  const client = createPlatformClient({
    account,
    localBoxes: options.localBoxes,
    localDataAccess: options.localDataAccess,
    readPreference: options.readPreference || (options.enabled === undefined ? undefined : async () => options.enabled),
    pollIntervalMs: 1,
    renewIntervalMs: options.renewIntervalMs ?? 60_000,
    writePreference: options.writePreference,
    resumeStore: options.resumeStore,
    measure: options.measure,
    createTransport(identity) {
      const key = JSON.stringify(identity);
      if (options.savedKeys?.has(key)) keys.add(key);
      const item = { identity, starts: 0, closed: false, gatewayClosed: false };
      transports.push(item);
      const network = createNetwork({
        configDir: key,
        createSidecar() {
          item.starts++;
          return {
            async request(method, params) {
              if (method === "start") {
                await options.onStart?.(params);
                if (params.setupKey) keys.add(key);
                if (!keys.has(key)) throw fail("auth_required");
                return {
                  proxy: { port: 19001, token: "private-network-token" },
                  status: {
                    phase: "ready",
                    peers: [{ ip: "100.80.1.2", connected: true }],
                  },
                };
              }
              return options.sidecarStatus?.() || {
                phase: "ready",
                peers: [{ ip: "100.80.1.2", connected: true }],
              };
            },
            close() {
              item.closed = true;
            },
          };
        },
      });
      item.network = network;
      const transport = createClient({
        network,
        probe: options.probe || (async () => {}),
        createGateway: async ({ session }) => ({
          url: "http://127.0.0.1:19800",
          request: options.gatewayRequest,
          close: async () => {
            item.gatewayClosed = true;
            await options.onGatewayClose?.();
            await session?.close();
          },
        }),
      });
      return { network, client: transport };
    },
    async createSession(input) {
      await options.onCreateSession?.(input);
      const session = {
        input,
        closed: false,
        close() {
          this.closed = true;
        },
      };
      sessions.push(session);
      return session;
    },
  });
  t.after(() => client.close());
  return {
    client,
    account,
    publishAccount: publish,
    calls,
    transports,
    sessions,
    keys,
    override: (handler) => {
      override = handler;
    },
    catalog: (value) => {
      catalog = value;
    },
  };
}

test("selecting the same healthy box keeps its gateway and authorized session", async t => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-a" });
  await h.client.connectBox("box-1");
  h.sessions[0].getToken = () => "live-test-token";
  const before = h.client.snapshot();
  const baseline = h.calls.length;
  await h.client.connectBox("box-1");
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0].closed, false);
  assert.equal(h.transports[0].gatewayClosed, false);
  assert.equal(h.calls.length, baseline);
  assert.deepEqual(h.client.snapshot().connection, before.connection);
});

test("reselecting after an unchanged directory refresh keeps the same session", async t => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-a" });
  await h.client.connectBox("box-1");
  h.sessions[0].getToken = () => "live-test-token";
  await h.client.refreshDevices();
  await h.client.connectBox("box-1");
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0].closed, false);
  h.sessions[0].input.onExpired("denied");
  await tick();
  assert.equal(h.client.snapshot().connection, null);
});

for (const state of ["missing token check", "expired token", "explicit disconnect"]) {
  test(`same-box selection reauthorizes after ${state}`, async t => {
    const h = harness(t);
    await h.client.loginPassword({ phone: "account-a" });
    await h.client.connectBox("box-1");
    if (state !== "missing token check") h.sessions[0].getToken = () => state === "expired token" ? "" : "live-test-token";
    if (state === "explicit disconnect") await h.client.disconnect();
    await h.client.connectBox("box-1");
    assert.equal(h.sessions.length, 2);
    assert.equal(h.sessions[0].closed, true);
    assert.equal(h.sessions[1].closed, false);
  });
}

for (const [field, value] of [
  ["ownershipEpoch", 2], ["authorizationVersion", 2], ["authorizationVersion", undefined],
  ["identityDeviceId", "replacement-identity"], ["serviceUrl", "http://100.80.1.2:8089"],
  ["deviceRole", "member"],
]) {
  test(`same-box selection reauthorizes after ${field} changes to ${value}`, async t => {
    const h = harness(t);
    await h.client.loginPassword({ phone: "account-a" });
    await h.client.connectBox("box-1");
    h.sessions[0].getToken = () => "live-test-token";
    h.catalog([{ ...device, [field]: value }]);
    await h.client.refreshDevices();
    await h.client.connectBox("box-1");
    assert.equal(h.sessions.length, 2);
    assert.equal(h.sessions[0].closed, true);
  });
}

test("same-box selection cannot preserve an expired network lease before its timer fires", async t => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-a" });
  await h.client.connectBox("box-1");
  h.sessions[0].getToken = () => "live-test-token";
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 301_000);
  await assert.rejects(h.client.connectBox("box-1"), { code: "NETWORK_NOT_READY" });
  assert.equal(h.sessions.length, 1);
});

for (const field of ["accountId", "clientId"]) {
  test(`same-box selection cannot preserve a connection after ${field} changes`, async t => {
    const h = harness(t);
    await h.client.loginPassword({ phone: "account-a" });
    await h.client.connectBox("box-1");
    h.sessions[0].getToken = () => "live-test-token";
    h.publishAccount({ phase: "authenticated", accountId: "account-a", clientId: "client-account-a", [field]: "replacement" });
    await assert.rejects(h.client.connectBox("box-1"), { code: "NETWORK_NOT_READY" });
    assert.equal(h.sessions.length, 1);
  });
}

test("same-box selection does not preserve a connection while its network is recovering", async t => {
  let recovering = false;
  const h = harness(t, { sidecarStatus: () => recovering ? {
    phase: "recovering", peers: [{ ip: "100.80.1.2", connected: true }],
  } : undefined });
  await h.client.loginPassword({ phone: "account-a" });
  await h.client.connectBox("box-1");
  h.sessions[0].getToken = () => "live-test-token";
  recovering = true;
  await h.transports[0].network.refresh();
  await h.client.connectBox("box-1");
  assert.equal(h.sessions.length, 2);
  assert.equal(h.sessions[0].closed, true);
});

test("same-box selection cannot retain access after the directory removes the box", async t => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-a" });
  await h.client.connectBox("box-1");
  h.sessions[0].getToken = () => "live-test-token";
  h.catalog([]);
  await h.client.refreshDevices();
  await assert.rejects(h.client.connectBox("box-1"), { code: "NETWORK_DEVICE_ACCESS_DENIED" });
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0].closed, true);
});

for (const cancel of [false, true]) {
  test(`expiry discovered during same-box selection cannot race a ${cancel ? "cancelled" : "fresh"} connection`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = deferred(), started = deferred();
    let attempts = 0, expiredPhase;
    const h = harness(t, { onCreateSession: async () => {
      if (++attempts === 2) { started.resolve(); await pending.promise; }
    } });
    await h.client.loginPassword({ phone: "account-a" });
    await h.client.connectBox("box-1");
    const original = h.sessions[0];
    // createPlatformSession.getToken synchronously expires and notifies its
    // owner before returning an empty token. Team expiry schedules recovery.
    original.getToken = () => {
      if (!original.closed) {
        original.close();
        original.input.onExpired("expired");
        expiredPhase = h.client.snapshot().phase;
      }
      return "";
    };
    const opening = h.client.connectBox("box-1");
    try {
      await started.promise;
      assert.equal(expiredPhase, "recovering");
      t.mock.timers.tick(0);
      await tick();
      assert.equal(attempts, 2, "the expiry recovery must not start a second grant");
      assert.equal(original.closed, true);
      if (cancel) await h.client.disconnect();
    } finally {
      pending.resolve();
      await opening;
    }
    t.mock.timers.tick(1000);
    await tick();
    assert.equal(attempts, 2);
    assert.equal(h.sessions.length, 2);
    assert.equal(h.sessions[1].closed, cancel);
    assert.equal(h.client.snapshot().connection?.deviceId ?? null, cancel ? null : "box-1");
    assert.equal(h.client.snapshot().phase, cancel ? "disconnected" : "ready");
  });
}

test("warm box selection does not wait for another cloud directory read", async t => {
  const steps = [];
  const h = harness(t, { measure: async (step, work) => { steps.push(step); return work(); } });
  await h.client.loginPassword({ phone: "account-a" });
  const waiting = deferred();
  const baseline = h.calls.length;
  h.override(input => input.path === "/app-api/network/devices" ? waiting.promise : undefined);
  const opening = h.client.connectBox("box-1");
  try {
    await tick();
    assert.equal(h.sessions.length, 1, "fresh box authentication starts without directory latency");
    assert.equal(h.calls.slice(baseline).some(call => call.path === "/app-api/network/devices"), false);
    assert.equal((await opening).phase, "ready");
    assert.ok(steps.includes("box.connect"));
    assert.equal(steps.includes("box.directory"), false);
  } finally {
    waiting.resolve({ networkSessionId: "enrollment-1", devices: [device] });
    await opening;
  }
});

test("box selection refuses an expired lease before its timer runs", async t => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-a" });
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 301_000);
  const baseline = h.calls.length;
  await assert.rejects(h.client.connectBox("box-1"), { code: "NETWORK_NOT_READY" });
  assert.equal(h.sessions.length, 0);
  assert.equal(h.calls.length, baseline);
});

test("a cached address failure refreshes the same authorized box once", async t => {
  const probed = [], steps = [];
  const h = harness(t, {
    probe: async url => { probed.push(url); if (probed.length === 1) throw fail("health_unavailable"); },
    measure: async (step, work) => { steps.push(step); return work(); },
  });
  await h.client.loginPassword({ phone: "account-a" });
  const baseline = h.calls.length;
  const moved = { ...device, serviceUrl: "http://100.80.1.2:8089" };
  h.catalog([moved]);
  const state = await h.client.connectBox("box-1");
  assert.equal(state.phase, "ready");
  assert.equal(state.connection.deviceId, "box-1");
  assert.equal(state.connection.url, moved.serviceUrl);
  assert.deepEqual(probed, [device.serviceUrl, moved.serviceUrl]);
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0].input.device.deviceId, "box-1");
  assert.equal(h.calls.slice(baseline).filter(call => call.path === "/app-api/network/devices").length, 1);
  assert.equal(steps.filter(step => step === "box.directory").length, 1);
});

test("a fresh directory removing the selected box never retries its cached address", async t => {
  let probes = 0;
  const h = harness(t, { probe: async () => { probes++; throw fail("health_unavailable"); } });
  await h.client.loginPassword({ phone: "account-a" });
  h.catalog([]);
  await assert.rejects(h.client.connectBox("box-1"), { code: "NETWORK_DEVICE_ACCESS_DENIED" });
  assert.equal(probes, 1);
  assert.equal(h.sessions.length, 0);
  assert.equal(h.client.snapshot().phase, "disconnected");
});

test("a failing refreshed route is not retried again", async t => {
  let probes = 0;
  const h = harness(t, { probe: async () => { probes++; throw fail("health_unavailable"); } });
  await h.client.loginPassword({ phone: "account-a" });
  const baseline = h.calls.length;
  await assert.rejects(h.client.connectBox("box-1"), { code: "health_unavailable" });
  assert.equal(probes, 2);
  assert.equal(h.calls.slice(baseline).filter(call => call.path === "/app-api/network/devices").length, 1);
});

for (const code of ["ACCOUNT_ACCESS_DENIED", "BOX_PLATFORM_AUTH_FAILED", "NETWORK_SESSION_REVOKED", "NETWORK_REVOCATION_PENDING"]) {
  test(`a live grant denial never falls back to cached authorization: ${code}`, async t => {
    const h = harness(t, { onCreateSession: async () => { throw fail(code, 403); } });
    await h.client.loginPassword({ phone: "account-a" });
    const baseline = h.calls.length;
    await assert.rejects(h.client.connectBox("box-1"), { code });
    assert.equal(h.calls.length, baseline);
    assert.equal(h.sessions.length, 0);
    assert.equal(h.client.snapshot().phase, "disconnected");
  });
}

test("an endpoint missing from the current session requires a fresh directory", async t => {
  const h = harness(t);
  h.override(input => input.path === "/app-api/network/devices"
    ? { networkSessionId: "enrollment-1", devices: [] } : undefined);
  await h.client.loginPassword({ phone: "account-a" });
  const baseline = h.calls.length;
  h.override(undefined);
  assert.equal((await h.client.connectBox("box-1")).phase, "ready");
  assert.equal(h.calls.slice(baseline).filter(call => call.path === "/app-api/network/devices").length, 1);
  assert.equal(h.sessions.length, 1);
});

test("a changed account client cannot reuse the previous transport directory", async t => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-a" });
  h.publishAccount({ phase: "authenticated", accountId: "account-a", clientId: "replacement-client" });
  await assert.rejects(h.client.connectBox("box-1"), { code: "NETWORK_NOT_READY" });
  assert.equal(h.sessions.length, 0);
});

for (const pendingStage of ["directory", "grant"]) {
  for (const action of ["switch", "logout"]) {
    test(`${action} during ${pendingStage} cannot open the earlier box`, async t => {
      const waiting = deferred(), started = deferred();
      let first = true;
      const h = harness(t, {
        probe: async () => {
          if (pendingStage === "directory" && first) { first = false; throw fail("health_unavailable"); }
        },
        onCreateSession: async () => {
          if (pendingStage === "grant" && first) { first = false; started.resolve(); await waiting.promise; }
        },
      });
      const other = { ...device, deviceId: "box-2", identityDeviceId: "identity-2", serviceUrl: "http://100.80.1.2:8089" };
      h.catalog([device, other]);
      await h.client.loginPassword({ phone: "account-a" });
      if (pendingStage === "directory") h.override(input => {
        if (input.path === "/app-api/network/devices") { started.resolve(); return waiting.promise; }
      });
      const opening = h.client.connectBox("box-1");
      try {
        await started.promise;
        h.override(undefined);
        if (action === "switch") await h.client.connectBox("box-2");
        else await h.client.logout();
      } finally {
        waiting.resolve({ networkSessionId: "enrollment-1", devices: [] });
        await opening;
      }
      const state = h.client.snapshot();
      assert.equal(state.connection?.deviceId || null, action === "switch" ? "box-2" : null);
      assert.ok(h.sessions.filter(session => session.input.device.deviceId === "box-1").every(session => session.closed));
      if (action === "switch") assert.equal(h.sessions.find(session => session.input.device.deviceId === "box-2").closed, false);
    });
  }
}

for (const outcome of ["removed", "denied"]) {
  test(`a directory read predating warm selection cannot apply a late ${outcome} result`, async t => {
    const h = harness(t), waiting = deferred(), started = deferred();
    await h.client.loginPassword({ phone: "account-a" });
    h.override(async input => {
      if (input.path !== "/app-api/network/devices") return undefined;
      started.resolve();
      await waiting.promise;
      if (outcome === "denied") throw fail("NETWORK_SESSION_REVOKED", 403);
      return { networkSessionId: "enrollment-1", devices: [], phase: "ready", leaseExpiresAt: Date.now() / 1000 + 300 };
    });
    const refreshing = h.client.refreshDevices();
    try {
      await started.promise;
      await h.client.connectBox("box-1");
      assert.equal(h.sessions.length, 1);
    } finally {
      waiting.resolve();
      await refreshing;
    }
    assert.equal(h.client.snapshot().phase, "ready");
    assert.equal(h.client.snapshot().connection.deviceId, "box-1");
    assert.equal(h.sessions[0].closed, false);
  });
}

test("a directory removing the target while its live grant waits closes the late session", async t => {
  const waiting = deferred(), started = deferred();
  const h = harness(t, { onCreateSession: async () => { started.resolve(); await waiting.promise; } });
  await h.client.loginPassword({ phone: "account-a" });
  const opening = h.client.connectBox("box-1");
  const rejected = assert.rejects(opening, { code: "NETWORK_DEVICE_ACCESS_DENIED" });
  try {
    await started.promise;
    h.override(input => input.path === "/app-api/network/devices"
      ? { networkSessionId: "enrollment-1", devices: [], phase: "ready", leaseExpiresAt: Date.now() / 1000 + 300 }
      : undefined);
    await h.client.refreshDevices();
  } finally {
    waiting.resolve();
    await rejected;
  }
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0].closed, true);
  assert.equal(h.client.snapshot().phase, "disconnected");
});

test("refreshing an unchanged authorized directory does not prepare or restore the network", async t => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-a" });
  const baseline = h.calls.length;
  const starts = h.transports[0].starts;
  const state = await h.client.refreshDevices();
  assert.equal(state.devices[0].canOpen, true);
  assert.deepEqual(h.calls.slice(baseline).map(call => call.path).sort(), [
    "/app-api/network/boxes", "/app-api/network/devices",
  ]);
  assert.equal(h.transports[0].starts, starts);
});

test("concurrent device refreshes share the same directory and authorization reads", async t => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-a" });
  const baseline = h.calls.length;
  const gate = deferred();
  h.override(async input => {
    if (input.path === "/app-api/network/boxes") await gate.promise;
  });
  const first = h.client.refreshDevices();
  const second = h.client.refreshDevices();
  try {
    await tick();
    assert.equal(h.calls.slice(baseline).filter(call => call.path === "/app-api/network/boxes").length, 1);
  } finally {
    gate.resolve();
    await Promise.all([first, second]);
  }
  assert.equal(h.calls.slice(baseline).filter(call => call.path === "/app-api/network/devices").length, 1);
});

for (const reported of [
  {},
  { phase: "ready", leaseExpiresAt: 0 },
  { phase: "revocation_pending", leaseExpiresAt: Date.now() / 1000 + 300 },
]) {
  test(`device refresh rechecks session authority when phase or lease is unsuitable: ${JSON.stringify(reported)}`, async t => {
    const h = harness(t);
    await h.client.loginPassword({ phone: "account-a" });
    const baseline = h.calls.length;
    h.override(input => input.path === "/app-api/network/devices" ? {
      networkSessionId: "enrollment-1", devices: [device], ...reported,
    } : undefined);
    await h.client.refreshDevices();
    assert.equal(h.calls.slice(baseline).filter(call => call.path === "/app-api/network/restore").length, 1);
  });
}

test("a newly visible box still prepares and projects its network access", async t => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-a" });
  const baseline = h.calls.length;
  h.catalog([device, { ...device, deviceId: "box-2", identityDeviceId: "identity-2" }]);
  await h.client.refreshDevices();
  assert.equal(h.calls.slice(baseline).filter(call => call.path.endsWith("/prepare")).length, 1);
  assert.equal(h.calls.slice(baseline).filter(call => call.path.endsWith("/restore")).length, 1);
  assert.equal(h.client.snapshot().devices.length, 2);
});

for (const sessionState of [
  { phase: "revocation_pending", leaseExpiresAt: Date.now() / 1000 + 300 },
  { phase: "ready", leaseExpiresAt: 0 },
  { networkSessionId: null, phase: null, leaseExpiresAt: null },
  { networkSessionId: "replacement-session", phase: "ready", leaseExpiresAt: Date.now() / 1000 + 300 },
]) {
  test(`explicitly invalid device session stays closed if restoration is offline: ${JSON.stringify(sessionState)}`, async t => {
    const h = harness(t);
    await h.client.loginPassword({ phone: "account-a" });
    await h.client.connectBox("box-1");
    h.override(input => {
      if (input.path.endsWith("/devices"))
        return { networkSessionId: "enrollment-1", devices: [device], ...sessionState };
      if (input.path.endsWith("/restore")) throw fail("ACCOUNT_NETWORK_ERROR");
    });
    await h.client.refreshDevices();
    assert.equal(h.sessions[0].closed, true);
    assert.equal(h.client.snapshot().connection, null);
    assert.equal(h.client.snapshot().devices[0].canOpen, false);
  });
}

test("periodic box health does not depend on Admin availability while the existing lease is valid", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let probes = 0;
  const h = harness(t, { renewIntervalMs: 10_000, probe: async () => { probes++; },
    gatewayRequest: async () => ({ status: 200, body: Buffer.from('{"id":4}') }) });
  await h.client.initialize();
  await h.client.loginPassword({ phone: "owner" });
  await h.client.connectBox("box-1");
  const lease = await h.client.applicationConnection("test.app");
  h.override(() => { throw fail("ACCOUNT_NETWORK_ERROR", 503); });
  t.mock.timers.tick(30_000);
  await tick();
  assert.equal(probes, 2);
  assert.equal(h.client.snapshot().phase, "ready");
  assert.equal((await lease.request({ path: "/api/health" })).status, 200);
  assert.equal(h.transports[0].gatewayClosed, false);
  assert.equal(h.sessions.length, 1);
});

test("logout cancels pending periodic box health and a late failure cannot reconnect", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const wait = deferred();
  let probes = 0, signal;
  const h = harness(t, { probe: async (_url, options) => {
    if (++probes === 2) { signal = options.signal; await wait.promise; throw fail("health_timeout"); }
  } });
  await h.client.initialize();
  await h.client.loginPassword({ phone: "owner" });
  await h.client.connectBox("box-1");
  t.mock.timers.tick(30_000);
  await tick();
  await h.client.logout();
  assert.equal(signal.aborted, true);
  wait.resolve();
  await tick();
  t.mock.timers.tick(300_000);
  await tick();
  assert.equal(h.client.snapshot().connection, null);
  assert.equal(h.sessions.length, 1);
  assert.equal(probes, 2);
});

test("one product login automatically enrolls and opens only a server-authorized box with SSO", async (t) => {
  const h = harness(t);
  await h.client.initialize();
  assert.equal(
    h.transports.length,
    0,
    "signed-out does not spawn a network engine",
  );
  const logged = await h.client.loginPassword({
    phone: "13800000001",
    password: "test",
  });
  assert.equal(logged.platform.phase, "ready");
  assert.equal(logged.network.enabled, true);
  assert.equal(logged.devices.length, 1);
  assert.doesNotMatch(
    JSON.stringify(logged),
    /private-registration-key|private-network-token/,
  );
  await h.client.connectBox("box-1");
  assert.equal(h.client.snapshot().phase, "ready");
  assert.equal(h.sessions[0].input.networkSessionId, "enrollment-1");
  assert.equal(h.sessions[0].input.device.identityDeviceId, "identity-1");
  await assert.rejects(h.client.connectBox("not-owned"), {
    code: "NETWORK_DEVICE_ACCESS_DENIED",
  });
  await assert.rejects(
    h.client.connect({ mode: "netbird", url: device.serviceUrl }),
    { code: "NETWORK_USE_AUTHORIZED_DEVICE" },
  );
  await h.client.logout();
  assert.equal(h.client.snapshot().account.phase, "signed_out");
  assert.equal(h.sessions[0].closed, true);
  assert.equal(h.transports[0].closed, true);
  assert.deepEqual(h.calls.at(-1), {
    path: "logout", options: undefined,
  });
});

test("interactive login finishes authentication while box and network startup continue", async (t) => {
  const h = harness(t);
  const boxes = deferred();
  const measured = [];
  const originalLogin = h.account.loginPassword;
  h.account.loginPassword = async (input) => {
    measured.push("account");
    return originalLogin(input);
  };
  h.override(async (input) => {
    if (input.path === "/app-api/network/boxes" || input.path === "/app-api/network/boxes/prepare")
      await boxes.promise;
  });
  await h.client.initialize();
  const login = h.client.loginPassword(
    { phone: "13800000001", password: "test" },
    { waitForDevices: false },
  );
  let completed = false;
  void login.then(() => { completed = true; });
  await tick();
  assert.equal(completed, true, "login must not wait for box discovery");
  const logged = await login;
  assert.equal(logged.account.phase, "authenticated");
  assert.equal(logged.directory.phase, "loading");
  assert.deepEqual(measured, ["account"]);
  const ready = new Promise((resolve) => {
    const unsubscribe = h.client.subscribe((state) => {
      if (state.platform.phase === "ready") { unsubscribe(); resolve(state); }
    });
  });
  boxes.resolve();
  const connected = await ready;
  assert.equal(connected.devices.length, 1);
});

test("P2P-off login preserves local development and never requests enrollment", async (t) => {
  const h = harness(t, { enabled: false });
  await h.client.initialize();
  await h.client.loginSMS({ phone: "13800000001", code: "123456" });
  assert.equal(h.client.snapshot().network.phase, "disabled");
  assert.deepEqual(
    h.calls.map((call) => call.path),
    ["/app-api/network/boxes"],
  );
  await h.client.connect({
    mode: "direct",
    deviceId: "local",
    name: "Local",
    url: "http://127.0.0.1:8088",
  });
  assert.equal(h.transports[0].starts, 0);
  assert.equal(h.client.snapshot().phase, "ready");
  await assert.rejects(h.client.connectBox("box-1"), {
    code: "NETWORK_NOT_READY",
  });
});

test("switching off during enrollment ignores a late response and never starts the engine", async (t) => {
  const h = harness(t),
    waiting = deferred();
  h.override((input) =>
    input.path === "/app-api/network/enrollments" ? waiting.promise : undefined,
  );
  const login = h.client.loginPassword({
    phone: "13800000001",
    password: "test",
  });
  await tick();
  await h.client.setNetworkEnabled(false);
  waiting.resolve({
    enrollmentId: "late",
    networkSessionId: "late",
    phase: "enrolling",
    managementUrl: "https://p2p.qeeshu.com",
    setupKey: "do-not-use",
  });
  await login;
  assert.equal(h.client.snapshot().network.phase, "disabled");
  assert.equal(h.transports.length, 0);
});

test("reenabling uses the existing node, while lost local identity revokes before replacing", async (t) => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  await h.client.setNetworkEnabled(false);
  await h.client.setNetworkEnabled(true);
  assert.equal(
    h.calls.filter((c) => c.path === "/app-api/network/enrollments").length,
    1,
  );
  await h.client.setNetworkEnabled(false);
  h.keys.clear();
  await h.client.setNetworkEnabled(true);
  assert.equal(
    h.calls.filter((c) => c.path === "/app-api/network/enrollments").length,
    2,
  );
  assert.equal(h.transports.at(-1).identity.networkSessionId, "enrollment-2");
  assert.equal(h.client.snapshot().platform.phase, "ready");
});

test("account switch isolates network identity and clears prior box sessions", async (t) => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  await h.client.connectBox("box-1");
  const old = h.transports[0].identity;
  await h.client.logout();
  await h.client.loginPassword({ phone: "13800000002", password: "test" });
  assert.notEqual(h.transports.at(-1).identity.accountId, old.accountId);
  assert.equal(h.sessions[0].closed, true);
  assert.equal(h.client.snapshot().phase, "disconnected");
});

test("authorization removal closes a selected box and refresh refuses stale directory entries", async (t) => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  await h.client.connectBox("box-1");
  h.catalog([]);
  await h.client.refreshDevices();
  assert.equal(h.client.snapshot().phase, "disconnected");
  assert.equal(h.sessions[0].closed, true);
  assert.deepEqual(h.client.snapshot().devices, []);
});

test("deployment or untrusted management responses cannot fall back to manual network authorization", async (t) => {
  const h = harness(t);
  h.override((input) =>
    input.path === "/app-api/network/restore"
      ? {
          enrollmentId: "x",
          networkSessionId: "x",
          phase: "ready",
          managementUrl: "https://untrusted.invalid",
          leaseExpiresAt: Date.now() / 1000 + 300,
        }
      : undefined,
  );
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  assert.equal(h.client.snapshot().platform.reason, "NETWORK_INVALID_RESPONSE");
  assert.equal(h.transports.length, 0);
  assert.equal(h.client.loginNetwork, undefined);
  assert.equal(h.client.enrollNetwork, undefined);
});

test("confirmed revoked restore creates exactly one replacement enrollment", async (t) => {
  const h = harness(t);
  h.override((input) =>
    input.path === "/app-api/network/restore"
      ? {
          enrollmentId: "old-session",
          networkSessionId: "old-session",
          phase: "revoked",
          managementUrl: "https://p2p.qeeshu.com",
        }
      : undefined,
  );
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  assert.equal(h.client.snapshot().platform.phase, "ready");
  assert.equal(
    h.calls.filter((input) => input.path === "/app-api/network/enrollments")
      .length,
    1,
  );
  assert.equal(h.transports.length, 1);
  assert.notEqual(h.transports[0].identity.networkSessionId, "old-session");
});

for (const pending of ["NETWORK_SESSION_REVOKED", "NETWORK_REVOCATION_PENDING"]) {
  test(`login remains available while ${pending} clears before network restoration`, { timeout: 1000 }, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = harness(t);
    let cleaning = true;
    h.override(input => {
      if (input.path !== "/app-api/network/restore" || !cleaning) return;
      if (pending === "NETWORK_SESSION_REVOKED") throw fail(pending, 401);
      return { enrollmentId: "old-session", networkSessionId: "old-session",
        phase: "revocation_pending", managementUrl: "https://p2p.qeeshu.com" };
    });
    await h.client.initialize();
    await h.client.loginPassword({ phone: "13800000001" }, { waitForDevices: false });
    await tick();
    assert.equal(h.client.snapshot().account.phase, "authenticated");
    assert.equal(h.client.snapshot().platform.reason, pending);
    assert.equal(h.transports.length, 0);
    assert.equal(h.calls.some(input => input.path === "/app-api/network/enrollments"), false);
    assert.equal(h.calls.some(input => input.method === "DELETE"), false);
    const ready = new Promise(resolve => {
      const unsubscribe = h.client.subscribe(state => {
        if (state.platform.phase === "ready") { unsubscribe(); resolve(); }
      });
    });
    cleaning = false;
    t.mock.timers.tick(5000);
    await tick();
    assert.equal(h.calls.filter(input => input.path === "/app-api/network/restore").length, 2);
    await ready;
    assert.equal(h.client.snapshot().platform.phase, "ready", "network retries after old-session cleanup without another login");
    assert.equal(h.transports.length, 1);
    assert.equal(h.calls.filter(input => input.path === "/app-api/network/enrollments").length, 1);
  });
}

test("pending revocation restore preserves the directory without starting or replacing a network", async (t) => {
  const h = harness(t);
  h.override((input) =>
    input.path === "/app-api/network/restore"
      ? {
          enrollmentId: "old-session",
          networkSessionId: "old-session",
          phase: "revocation_pending",
          managementUrl: "https://p2p.qeeshu.com",
        }
      : undefined,
  );
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  assert.equal(
    h.client.snapshot().platform.reason,
    "NETWORK_REVOCATION_PENDING",
  );
  assert.equal(h.transports.length, 0);
  assert.equal(
    h.calls.some((input) => input.path === "/app-api/network/enrollments"),
    false,
  );
  assert.equal(h.client.snapshot().devices[0].deviceId, "box-1");
  assert.equal(h.client.snapshot().devices[0].canOpen, false);
});

for (const [phase, reason] of [
  ["revoked", "NETWORK_ENROLLMENT_REQUIRED"],
  ["revocation_pending", "NETWORK_REVOCATION_PENDING"],
]) {
  test(`terminal ${phase} during enrollment polling closes transport and never loops registration`, async (t) => {
    const h = harness(t);
    h.override((input) =>
      input.path.startsWith("/app-api/network/enrollments/")
        ? {
            enrollmentId: "enrollment-1",
            networkSessionId: "enrollment-1",
            phase,
            managementUrl: "https://p2p.qeeshu.com",
          }
        : undefined,
    );
    await h.client.loginPassword({ phone: "13800000001", password: "test" });
    assert.equal(h.client.snapshot().platform.reason, reason);
    assert.equal(h.transports.length, 1);
    assert.equal(h.transports[0].closed, true);
    assert.equal(h.client.snapshot().devices[0].canOpen, false);
    assert.equal(
      h.calls.filter((input) => input.path === "/app-api/network/enrollments")
        .length,
      1,
    );
    assert.equal(
      h.calls.some((input) => input.path === "/app-api/network/devices"),
      false,
    );
  });
}

test("unknown phases and untrusted terminal responses cannot trigger replacement enrollment", async (t) => {
  for (const response of [
    { phase: "unexpected", managementUrl: "https://p2p.qeeshu.com" },
    { phase: "revoked", managementUrl: "https://untrusted.invalid" },
    { phase: "revocation_pending", managementUrl: "https://untrusted.invalid" },
  ]) {
    const h = harness(t);
    h.override((input) =>
      input.path === "/app-api/network/restore"
        ? {
            enrollmentId: "old-session",
            networkSessionId: "old-session",
            ...response,
          }
        : undefined,
    );
    await h.client.loginPassword({ phone: "13800000001", password: "test" });
    assert.equal(
      h.client.snapshot().platform.reason,
      "NETWORK_INVALID_RESPONSE",
    );
    assert.equal(h.transports.length, 0);
    assert.equal(
      h.calls.some((input) => input.path === "/app-api/network/enrollments"),
      false,
    );
  }
});

test("lost one-time enrollment response is revoked and replaced even while enrolling", async (t) => {
  const h = harness(t);
  h.override((input) =>
    input.path === "/app-api/network/restore"
      ? {
          enrollmentId: "lost",
          networkSessionId: "lost",
          phase: "enrolling",
          managementUrl: "https://p2p.qeeshu.com",
        }
      : undefined,
  );
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  assert.equal(h.client.snapshot().platform.phase, "ready");
  const paths = h.calls.map((c) => c.path);
  assert.ok(
    paths.indexOf("/app-api/network/current") <
      paths.indexOf("/app-api/network/enrollments"),
  );
});

test("disconnect cancels a pending box directory selection", async (t) => {
  const h = harness(t, { probe: async () => { throw fail("health_unavailable"); } }),
    waiting = deferred();
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  h.override((input) =>
    input.path === "/app-api/network/devices" ? waiting.promise : undefined,
  );
  const opening = h.client.connectBox("box-1");
  await tick();
  await h.client.disconnect();
  waiting.resolve({ networkSessionId: "enrollment-1", devices: [device] });
  await opening;
  assert.equal(h.sessions.length, 0);
  assert.equal(h.client.snapshot().phase, "disconnected");
});

test("a delayed earlier box selection cannot replace the latest selection", async (t) => {
  let first = true;
  const h = harness(t, { probe: async () => { if (first) { first = false; throw fail("health_unavailable"); } } }),
    waiting = deferred();
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  h.override((input) =>
    input.path === "/app-api/network/devices" ? waiting.promise : undefined,
  );
  const opening = h.client.connectBox("box-1");
  await tick();
  h.override(undefined);
  await h.client.connectBox("box-1");
  waiting.resolve({ networkSessionId: "enrollment-1", devices: [] });
  await opening;
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0].closed, false);
  assert.equal(h.client.snapshot().phase, "ready");
});

test("the network lease expires even when a renewal request hangs", async (t) => {
  const h = harness(t),
    waiting = deferred();
  h.override((input) =>
    input.path.startsWith("/app-api/network/enrollments/")
      ? {
          enrollmentId: "enrollment-1",
          networkSessionId: "enrollment-1",
          phase: "ready",
          managementUrl: "https://p2p.qeeshu.com",
          leaseExpiresAt: Date.now() / 1000 + 0.15,
        }
      : undefined,
  );
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  await h.client.connectBox("box-1");
  h.override((input) =>
    input.path === "/app-api/network/restore" ? waiting.promise : undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.equal(h.client.snapshot().platform.reason, "NETWORK_LEASE_EXPIRED");
  assert.equal(h.sessions[0].closed, true);
  assert.equal(h.client.snapshot().phase, "disconnected");
  waiting.resolve({});
  await tick();
  assert.equal(h.client.snapshot().platform.reason, "NETWORK_LEASE_EXPIRED");
});

test("enabling and disabling P2P preserves a local Dashboard connection", async (t) => {
  const h = harness(t, { enabled: false });
  await h.client.initialize();
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  await h.client.connect({
    mode: "direct",
    deviceId: "local",
    name: "Local",
    url: "http://127.0.0.1:8088",
  });
  const direct = h.transports[0];
  await h.client.setNetworkEnabled(true);
  assert.equal(h.client.snapshot().phase, "ready");
  assert.equal(h.client.snapshot().connection.mode, "direct");
  await h.client.setNetworkEnabled(false);
  assert.equal(h.client.snapshot().phase, "ready");
  assert.equal(direct.gatewayClosed, false);
  assert.equal(direct.closed, false);
});

test("late startup preference cannot override an explicit P2P-off action", async (t) => {
  const waiting = deferred();
  const h = harness(t, { readPreference: () => waiting.promise });
  const starting = h.client.initialize();
  await h.client.setNetworkEnabled(false);
  waiting.resolve(true);
  await starting;
  assert.equal(h.client.snapshot().network.enabled, false);
  assert.equal(h.transports.length, 0);
});

test("a slow older disable cannot overwrite the latest saved P2P preference", async (t) => {
  const saved = [],
    waiting = deferred();
  const h = harness(t, { writePreference: async (value) => saved.push(value) });
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  const network = h.transports[0].network;
  const original = network.setEnabled;
  network.setEnabled = async (value) => {
    const result = await original(value);
    if (!value) await waiting.promise;
    return result;
  };
  const stopping = h.client.setNetworkEnabled(false);
  await tick();
  await h.client.setNetworkEnabled(true);
  waiting.resolve();
  await stopping;
  assert.equal(h.client.snapshot().network.enabled, true);
  assert.equal(saved.at(-1), true);
});

test("temporary control-plane failure keeps a valid box session until its lease", async (t) => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  await h.client.connectBox("box-1");
  h.override((input) => {
    if (["/app-api/network/restore", "/app-api/network/devices"].includes(input.path))
      throw fail("ACCOUNT_NETWORK_ERROR");
  });
  await h.client.refreshDevices();
  assert.equal(h.client.snapshot().platform.phase, "ready");
  assert.equal(h.client.snapshot().phase, "ready");
  assert.equal(h.sessions[0].closed, false);
  h.override((input) => {
    if (["/app-api/network/restore", "/app-api/network/devices"].includes(input.path))
      throw fail("ACCOUNT_ACCESS_DENIED", 403);
  });
  await h.client.refreshDevices();
  assert.equal(h.client.snapshot().platform.reason, "ACCOUNT_ACCESS_DENIED");
  assert.equal(h.sessions[0].closed, true);
});

test("existing registry device IDs containing dots can be opened", async (t) => {
  const h = harness(t);
  h.catalog([
    {
      ...device,
      deviceId: "registry.box-1",
      identityDeviceId: "centauros-1234567890abcdef12345678",
    },
  ]);
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  await h.client.connectBox("registry.box-1");
  assert.equal(h.client.snapshot().phase, "ready");
  assert.equal(h.sessions[0].input.device.deviceId, "registry.box-1");
});

test("a rejected duplicate login cannot cancel the active network lease", async (t) => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  await h.client.connectBox("box-1");
  await assert.rejects(
    h.client.loginPassword({ phone: "13800000002", password: "test" }),
    { code: "ACCOUNT_ALREADY_SIGNED_IN" },
  );
  assert.equal(h.client.snapshot().account.accountId, "13800000001");
  assert.equal(h.client.snapshot().phase, "ready");
});

function localApproval({ locked = false, approved = false } = {}) {
  return {
    snapshot: () => ({ phase: locked ? "locked" : "unlocked", profileId: approved ? "local-profile" : null }),
    listBoxes: () => approved ? [{ boxId: device.deviceId, locked }] : [],
    isProtectedBox: id => approved && id === device.deviceId,
    subscribe: () => () => {},
  };
}

test("team cloud directory cannot advertise a usable network peer as locally approved", async t => {
  const localDataAccess = localApproval();
  const h = harness(t, { localDataAccess });
  const team = createTeamConnection({ base: h.client, localDataAccess });
  await team.loginPassword({ phone: "account-a" });
  const listed = team.snapshot().devices[0];
  assert.equal(team.snapshot().platform.phase, "ready");
  assert.equal(listed.networkReady, true, "network readiness remains independent of device approval");
  assert.equal(listed.canOpen, false);
  assert.equal(listed.accessState, "device_approval_required");
  await assert.rejects(team.connectBox(device.deviceId), { code: "TEAM_DEVICE_APPROVAL_REQUIRED" });
  assert.equal(h.sessions.length, 0, "cloud credentials must never bypass the local approval gate");
});

test("team with identity security disabled connects through platform authorization and obeys later revocation", async t => {
  const h = harness(t);
  const team = createTeamConnection({ base: h.client, identitySecurityEnabled: false });
  await team.loginPassword({ phone: "account-a" });
  assert.equal(team.snapshot().devices[0].canOpen, true);
  assert.equal(team.snapshot().dataIdentity, undefined);
  await team.connectBox(device.deviceId);
  assert.equal(team.snapshot().phase, "ready");
  assert.equal(team.snapshot().connection.mode, "netbird");
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0].input.device.deviceId, device.deviceId);
  h.override(input => input.path.startsWith("/app-api/network/boxes")
    ? { boxes: [{ ...device, accessState: "access_denied" }] } : undefined);
  await team.refreshDevices();
  assert.equal(team.snapshot().devices[0].canOpen, false);
  assert.equal(h.sessions[0].closed, true);
  await assert.rejects(team.connectBox(device.deviceId), { code: "NETWORK_DEVICE_ACCESS_DENIED" });
  assert.equal(h.sessions.length, 1);
});

test("registered development boxes also require team device approval before offering connect", async t => {
  const h = harness(t, { localDataAccess: localApproval(), enabled: false,
    localBoxes: { list: async () => [{ deviceId: "development-box", displayName: "开发盒子", local: true,
      canOpen: true, accessState: "ready", serviceUrl: "http://127.0.0.1:8088" }] },
  });
  await h.client.initialize();
  await h.client.loginPassword({ phone: "account-a" });
  const listed = h.client.snapshot().devices.find(box => box.deviceId === "development-box");
  assert.equal(listed.canOpen, false);
  assert.equal(listed.accessState, "device_approval_required");
  await assert.rejects(h.client.connectBox(listed.deviceId), { code: "TEAM_DEVICE_APPROVAL_REQUIRED" });
});

for (const accessState of ["access_denied", "network_unconfigured", "authorization_pending"]) {
  test(`team local approval must not hide cloud ${accessState}`, async t => {
    const h = harness(t, { localDataAccess: localApproval(), enabled: false });
    h.override(input => input.path === "/app-api/network/boxes"
      ? { boxes: [{ ...device, accessState }] } : undefined);
    await h.client.initialize();
    await h.client.loginPassword({ phone: "account-a" });
    assert.equal(h.client.snapshot().devices[0].accessState, accessState);
    assert.equal(h.client.snapshot().devices[0].canOpen, false);
  });
}

for (const locked of [false, true]) {
  test(`team approved device retains its ${locked ? "locked" : "connectable"} state`, async t => {
    const h = harness(t, { localDataAccess: localApproval({ approved: true, locked }) });
    const listed = h.client.snapshot().devices[0];
    assert.equal(listed.authorization, "local-trust-v1");
    assert.equal(listed.accessState, locked ? "locked" : "ready");
    assert.equal(listed.canOpen, !locked);
    assert.equal(listed.networkReady, !locked);
  });
}

test("a failed preference write cannot remove an existing hard lease deadline", async (t) => {
  const h = harness(t, {
      writePreference: async () => {
        throw Error("disk unavailable");
      },
    }),
    waiting = deferred();
  h.override((input) =>
    input.path.startsWith("/app-api/network/enrollments/")
      ? {
          enrollmentId: "enrollment-1",
          networkSessionId: "enrollment-1",
          phase: "ready",
          managementUrl: "https://p2p.qeeshu.com",
          leaseExpiresAt: Date.now() / 1000 + 0.15,
        }
      : undefined,
  );
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  await h.client.connectBox("box-1");
  await assert.rejects(h.client.setNetworkEnabled(true), /disk unavailable/);
  h.override((input) =>
    input.path === "/app-api/network/restore" ? waiting.promise : undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.equal(h.client.snapshot().platform.reason, "NETWORK_LEASE_EXPIRED");
  assert.equal(h.sessions[0].closed, true);
  waiting.resolve({});
  await tick();
});

test("associated boxes appear before slow enrollment completes", async (t) => {
  const h = harness(t),
    waiting = deferred();
  h.override((input) =>
    input.path === "/app-api/network/restore" ? waiting.promise : undefined,
  );
  const login = h.client.loginPassword({
    phone: "13800000001",
    password: "test",
  });
  await tick();
  assert.equal(h.client.snapshot().directory.phase, "ready");
  assert.equal(h.client.snapshot().devices[0].deviceId, "box-1");
  assert.equal(h.client.snapshot().devices[0].canOpen, false);
  await h.client.setNetworkEnabled(false);
  waiting.resolve({});
  await login;
});

test("directory GET can display boxes while preparation is slow; preparation then wins", async (t) => {
  const h = harness(t),
    waiting = deferred();
  h.override((input) =>
    input.path === "/app-api/network/boxes/prepare"
      ? waiting.promise
      : input.path === "/app-api/network/boxes"
      ? { boxes: [{ ...device, accessState: "authorization_pending" }] }
      : undefined,
  );
  const login = h.client.loginPassword({
    phone: "13800000001",
    password: "test",
  });
  await tick();
  assert.equal(
    h.client.snapshot().devices[0].accessState,
    "authorization_pending",
  );
  waiting.resolve({ boxes: [{ ...device, accessState: "ready" }] });
  await login;
  assert.equal(h.client.snapshot().devices[0].canOpen, true);
});

test("renewals do not repeat preparation and refresh turns pending into ready", async (t) => {
  const h = harness(t, { renewIntervalMs: 15 });
  h.override((input) =>
    input.path.startsWith("/app-api/network/boxes")
      ? { boxes: [{ ...device, accessState: "network_unconfigured" }] }
      : undefined,
  );
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  assert.equal(h.client.snapshot().devices[0].canOpen, false);
  await assert.rejects(h.client.connectBox("box-1"), {
    code: "NETWORK_DEVICE_ACCESS_DENIED",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    h.calls.filter((call) => call.path.endsWith("boxes/prepare")).length,
    1,
  );
  h.override(undefined);
  await h.client.refreshDevices();
  assert.equal(
    h.calls.filter((call) => call.path.endsWith("boxes/prepare")).length,
    2,
  );
  assert.equal(h.client.snapshot().devices[0].canOpen, true);
});

test("transient network renewal retains endpoints only within their existing lease", async (t) => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  h.override((input) => {
    if (input.path === "/app-api/network/restore")
      throw fail("ACCOUNT_NETWORK_ERROR");
  });
  await h.client.refreshDevices();
  assert.equal(h.client.snapshot().devices.length, 1);
  assert.equal(h.client.snapshot().devices[0].canOpen, true);
  assert.equal(h.client.snapshot().directory.phase, "ready");
});

test("undeployed directory shows account boxes read-only while P2P is disabled", async (t) => {
  const h = harness(t, { enabled: false });
  await h.client.initialize();
  h.override((input) => {
    if (input.path === "/app-api/network/boxes")
      throw fail("NETWORK_SERVICE_NOT_DEPLOYED", 404);
  });
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  assert.equal(h.client.snapshot().directory.phase, "unavailable");
  assert.equal(
    h.client.snapshot().directory.reason,
    "NETWORK_SERVICE_NOT_DEPLOYED",
  );
  assert.deepEqual(h.client.snapshot().devices, [
    {
      deviceId: "box-1",
      displayName: "我的盒子",
      deviceRole: undefined,
      accessState: "service_unavailable",
      networkReady: false,
      canOpen: false,
    },
  ]);
  assert.equal(h.transports.length, 0);
  assert.deepEqual(
    h.calls.map((call) => call.path),
    ["/app-api/network/boxes"],
  );
});

for (const first of ["directory", "prepare"]) {
  test(`undeployed account service retains read-only boxes when ${first} finishes first`, async (t) => {
    const h = harness(t),
      listing = deferred(),
      preparation = deferred();
    h.account.listDevices = () => listing.promise;
    h.override(async (input) => {
      if (input.path === "/app-api/network/boxes/prepare") {
        await preparation.promise;
        throw fail("NETWORK_SERVICE_NOT_DEPLOYED", 404);
      }
      if (input.path === "/app-api/network/boxes")
        throw fail("NETWORK_SERVICE_NOT_DEPLOYED", 404);
    });
    const login = h.client.loginPassword({
      phone: "13800000001",
      password: "test",
    });
    await tick();
    const rows = [
      { deviceId: "owned-box", deviceName: "已关联盒子", role: "owner" },
    ];
    if (first === "directory") listing.resolve(rows);
    else preparation.resolve();
    await tick();
    listing.resolve(rows);
    preparation.resolve();
    await login;
    assert.deepEqual(h.client.snapshot().devices, [
      {
        deviceId: "owned-box",
        displayName: "已关联盒子",
        deviceRole: "owner",
        accessState: "service_unavailable",
        networkReady: false,
        canOpen: false,
      },
    ]);
    assert.deepEqual(h.client.snapshot().directory, {
      phase: "unavailable",
      reason: "NETWORK_SERVICE_NOT_DEPLOYED",
    });
    assert.equal(
      h.client.snapshot().platform.reason,
      "NETWORK_SERVICE_NOT_DEPLOYED",
    );
    await assert.rejects(h.client.connectBox("owned-box"), {
      code: "NETWORK_NOT_READY",
    });
    assert.equal(h.transports.length, 0);
    assert.equal(
      h.calls.some((call) => call.path === "/app-api/network/restore"),
      false,
    );
  });
}

test("authentication failures never query the compatibility account directory", async (t) => {
  const h = harness(t, { enabled: false });
  await h.client.initialize();
  let fallbackCalls = 0;
  h.account.listDevices = async () => {
    fallbackCalls++;
    return [];
  };
  h.override((input) => {
    if (input.path === "/app-api/network/boxes")
      throw fail("ACCOUNT_SESSION_EXPIRED", 401);
  });
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  assert.equal(fallbackCalls, 0);
  assert.equal(h.client.snapshot().directory.reason, "ACCOUNT_SESSION_EXPIRED");
  assert.deepEqual(h.client.snapshot().devices, []);
});

test("late compatibility directory cannot cross logout and account switch", async (t) => {
  const h = harness(t, { enabled: false }),
    waiting = deferred();
  await h.client.initialize();
  h.account.listDevices = () => waiting.promise;
  h.override((input) => {
    if (input.path === "/app-api/network/boxes")
      throw fail("NETWORK_SERVICE_NOT_DEPLOYED", 404);
  });
  const login = h.client.loginPassword({
    phone: "13800000001",
    password: "test",
  });
  await tick();
  await h.client.logout();
  h.override(undefined);
  h.catalog([{ ...device, deviceId: "new-account-box" }]);
  await h.client.loginPassword({ phone: "13800000002", password: "test" });
  waiting.resolve([{ deviceId: "old-account-box", deviceName: "旧账号盒子" }]);
  await login;
  assert.deepEqual(
    h.client.snapshot().devices.map((box) => box.deviceId),
    ["new-account-box"],
  );
  assert.equal(h.client.snapshot().directory.phase, "ready");
});

test("late prior-account directory cannot leak after logout and a new login", async (t) => {
  const h = harness(t, { enabled: false }),
    waiting = deferred();
  await h.client.initialize();
  h.override((input) =>
    input.path === "/app-api/network/boxes" ? waiting.promise : undefined,
  );
  const login = h.client.loginPassword({
    phone: "13800000001",
    password: "test",
  });
  await tick();
  await h.client.logout();
  h.override(undefined);
  h.catalog([{ ...device, deviceId: "box-new" }]);
  await h.client.loginPassword({ phone: "13800000002", password: "test" });
  waiting.resolve({ boxes: [{ ...device, accessState: "ready" }] });
  await login;
  assert.deepEqual(
    h.client.snapshot().devices.map((box) => box.deviceId),
    ["box-new"],
  );
});

test("P2P cancellation ignores late preparation and retains the refreshed read-only directory", async (t) => {
  const h = harness(t),
    waiting = deferred();
  h.override((input) =>
    input.path === "/app-api/network/boxes/prepare"
      ? waiting.promise
      : undefined,
  );
  const login = h.client.loginPassword({
    phone: "13800000001",
    password: "test",
  });
  await tick();
  await h.client.setNetworkEnabled(false);
  waiting.resolve({
    boxes: [{ ...device, deviceId: "old-box", accessState: "ready" }],
  });
  await login;
  assert.deepEqual(
    h.client.snapshot().devices.map((box) => box.deviceId),
    ["box-1"],
  );
  assert.equal(h.client.snapshot().devices[0].canOpen, false);
  assert.equal(h.transports.length, 0);
});

test("background renewal observes authorization ACK without repeating preparation", async (t) => {
  const h = harness(t, { renewIntervalMs: 15 });
  h.override((input) =>
    input.path.startsWith("/app-api/network/boxes")
      ? { boxes: [{ ...device, accessState: "authorization_pending" }] }
      : undefined,
  );
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  assert.equal(h.client.snapshot().devices[0].canOpen, false);
  h.override(undefined);
  const deadline = Date.now() + 1000;
  while (!h.client.snapshot().devices[0].canOpen && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.client.snapshot().devices[0].canOpen, true);
  assert.equal(
    h.calls.filter((call) => call.path.endsWith("boxes/prepare")).length,
    1,
  );
  assert.ok(h.calls.filter((call) => call.path.endsWith("/boxes")).length >= 2);
});

test("revoked access leaves linked box visible but closes its session and blocks reopening", async (t) => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  await h.client.connectBox("box-1");
  h.override((input) =>
    input.path.startsWith("/app-api/network/boxes")
      ? { boxes: [{ ...device, accessState: "access_denied" }] }
      : undefined,
  );
  await h.client.refreshDevices();
  assert.equal(h.client.snapshot().devices[0].accessState, "access_denied");
  assert.equal(h.client.snapshot().devices[0].canOpen, false);
  assert.equal(h.sessions[0].closed, true);
  await assert.rejects(h.client.connectBox("box-1"), {
    code: "NETWORK_DEVICE_ACCESS_DENIED",
  });
});

test("a linked box needing an authorization upgrade does not block other ready boxes", async (t) => {
  const h = harness(t);
  h.override((input) =>
    input.path.startsWith("/app-api/network/boxes")
      ? {
          boxes: [
            { ...device, accessState: "ready" },
            {
              ...device,
              deviceId: "legacy-box",
              accessState: "authorization_unavailable",
            },
          ],
        }
      : undefined,
  );
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  assert.equal(h.client.snapshot().directory.phase, "ready");
  assert.equal(h.client.snapshot().devices[0].canOpen, true);
  assert.equal(
    h.client.snapshot().devices[1].accessState,
    "authorization_unavailable",
  );
  assert.equal(h.client.snapshot().devices[1].canOpen, false);
  await assert.rejects(h.client.connectBox("legacy-box"), {
    code: "NETWORK_DEVICE_ACCESS_DENIED",
  });
  await h.client.connectBox("box-1");
  assert.equal(h.client.snapshot().phase, "ready");
});

function memoryResume() {
  let value = null;
  return {
    load: async () => value && structuredClone(value),
    save: async (next) => {
      value = structuredClone(next);
    },
    clear: async () => {
      value = null;
    },
  };
}

test("saved identity warms the engine while cloud prepares, but cannot authorize a box", async (t) => {
  const store = memoryResume();
  const first = harness(t, { resumeStore: store });
  await first.client.loginPassword({ phone: "account-1" });
  await first.client.close();
  const saved = await store.load();
  assert.deepEqual(
    Object.keys(saved).sort(),
    [
      "accountId",
      "clientId",
      "managementURL",
      "networkSessionId",
      "version",
    ].sort(),
  );
  const next = harness(t, {
    resumeStore: store,
    restoreIdentity: saved,
    serverSession: saved.networkSessionId,
    savedKeys: first.keys,
  });
  const prepared = deferred();
  next.override(async (input) => {
    if (input.path.endsWith("/prepare")) await prepared.promise;
  });
  const opening = next.client.initialize();
  await tick();
  await tick();
  assert.equal(next.transports.length, 1);
  assert.equal(next.transports[0].network.snapshot().phase, "ready");
  assert.equal(next.client.snapshot().devices[0].canOpen, false);
  await assert.rejects(next.client.connectBox("box-1"), {
    code: "NETWORK_NOT_READY",
  });
  prepared.resolve();
  await opening;
  assert.equal(
    next.transports.length,
    1,
    "reuse exactly the confirmed warm engine",
  );
  assert.equal(next.client.snapshot().devices[0].canOpen, true);
});

test("a different account cannot prewarm the previous account's saved identity", async (t) => {
  const store = memoryResume();
  await store.save({
    version: 1,
    accountId: "other",
    clientId: "other-client",
    managementURL: "https://p2p.qeeshu.com",
    networkSessionId: "old-session",
  });
  const h = harness(t, {
    resumeStore: store,
    restoreIdentity: { accountId: "new-account", clientId: "new-client" },
  });
  const prepared = deferred();
  h.override(async (input) => {
    if (input.path.endsWith("/prepare")) await prepared.promise;
  });
  const opening = h.client.initialize();
  await tick();
  await tick();
  assert.equal(h.transports.length, 0);
  prepared.resolve();
  await opening;
  assert.equal(h.transports[0].identity.accountId, "new-account");
  await h.client.logout();
  await h.client.close();
  assert.equal(await store.load(), null);
});

test("cloud revocation closes a prewarmed engine without publishing endpoints", async (t) => {
  const store = memoryResume();
  const first = harness(t, { resumeStore: store });
  await first.client.loginPassword({ phone: "account-1" });
  await first.client.close();
  const saved = await store.load();
  const h = harness(t, {
    resumeStore: store,
    restoreIdentity: saved,
    serverSession: saved.networkSessionId,
    savedKeys: first.keys,
  });
  h.override((input) => {
    if (input.path === "/app-api/network/restore")
      throw fail("ACCOUNT_ACCESS_DENIED", 403);
  });
  await h.client.initialize();
  assert.equal(h.transports.length, 1);
  assert.equal(h.transports[0].closed, true);
  assert.equal(
    h.client.snapshot().devices.some((box) => box.canOpen),
    false,
  );
  await h.client.close();
  assert.equal(await store.load(), null);
});

test("background directory refresh keeps valid buttons, then atomically applies revocation", async (t) => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-1" });
  await h.client.connectBox("box-1");
  const waiting = deferred();
  h.override(async (input) => {
    if (input.path.includes("/network/boxes")) {
      await waiting.promise;
      return { boxes: [] };
    }
  });
  const refreshing = h.client.refreshDevices();
  await tick();
  assert.equal(h.client.snapshot().directory.phase, "ready");
  assert.equal(h.client.snapshot().directory.refreshing, true);
  assert.equal(h.client.snapshot().devices[0].canOpen, true);
  assert.equal(h.sessions[0].closed, false);
  waiting.resolve();
  await refreshing;
  assert.equal(h.sessions[0].closed, true);
  assert.equal(h.client.snapshot().devices.length, 0);
});

test("system network notifications cannot enable a disabled or signed-out network", async (t) => {
  const h = harness(t);
  await h.client.networkChanged();
  assert.equal(h.transports.length, 0);
  await h.client.loginPassword({ phone: "account-1" });
  let recoveries = 0;
  h.transports[0].network.networkChanged = async () => {
    recoveries++;
  };
  await h.client.networkChanged();
  assert.equal(recoveries, 1);
  await h.client.setNetworkEnabled(false);
  await h.client.networkChanged();
  assert.equal(recoveries, 1);
});

test("connectivity return retries a prior offline startup but not a denied account", async (t) => {
  const h = harness(t);
  h.override((input) => {
    if (input.path.endsWith("/prepare")) throw fail("ACCOUNT_NETWORK_ERROR");
  });
  await h.client.loginPassword({ phone: "account-1" });
  assert.equal(h.client.snapshot().platform.phase, "unavailable");
  h.override(undefined);
  await h.client.networkChanged();
  assert.equal(h.client.snapshot().platform.phase, "ready");
  h.override((input) => {
    if (input.path.endsWith("/restore"))
      throw fail("ACCOUNT_ACCESS_DENIED", 403);
  });
  await h.client.refreshDevices();
  const count = h.calls.length;
  await h.client.networkChanged();
  assert.equal(
    h.calls.length,
    count,
    "system notification cannot retry a terminal auth denial",
  );
});

test("network event during a failed native start retries the confirmed saved identity", async (t) => {
  const store = memoryResume();
  const first = harness(t, { resumeStore: store });
  await first.client.loginPassword({ phone: "account-1" });
  await first.client.close();
  const saved = await store.load();
  const waiting = deferred();
  let failurePending = true;
  const h = harness(t, {
    resumeStore: store,
    restoreIdentity: saved,
    serverSession: saved.networkSessionId,
    savedKeys: first.keys,
    onStart: async () => {
      if (failurePending) {
        await waiting.promise;
        failurePending = false;
        throw fail("start_failed");
      }
    },
  });
  const login = h.client.initialize();
  await tick();
  await tick();
  const changed = h.client.networkChanged();
  waiting.resolve();
  await login;
  await changed;
  assert.equal(h.client.snapshot().platform.phase, "ready");
  assert.equal(h.client.snapshot().devices[0].canOpen, true);
  assert.equal(h.transports[0].closed, true);
});

test("box readiness follows its own connected peer during management recovery", async (t) => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-1" });
  const network = h.transports[0].network;
  const original = network.snapshot;
  network.snapshot = () => ({ ...original(), phase: "recovering" });
  assert.equal(h.client.snapshot().network.phase, "recovering");
  assert.equal(h.client.snapshot().devices[0].canOpen, true);
  network.snapshot = () => ({ ...original(), peers: [] });
  assert.equal(h.client.snapshot().devices[0].networkReady, false);
  assert.equal(h.client.snapshot().devices[0].canOpen, false);
});

test('application connection seam: confirmed recovery preserves the lease, logout revokes it synchronously', async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let connected=true,healthy=true;
  const h=harness(t,{
    sidecarStatus:()=>({phase:'ready',peers:[{ip:'100.80.1.2',connected}]}),
    probe:async()=>{if(!healthy)throw fail('health_timeout');},
    gatewayRequest:async()=>({status:200,body:Buffer.from('{"id":4}')}),
  });
  await h.client.loginPassword({phone:'13800000001',password:'test'});
  await h.client.connectBox('box-1');
  const lease=await h.client.applicationConnection();
  const states=[];const off=lease.subscribe(()=>{try{states.push(lease.context().connection);}catch{states.push('expired');}});
  t.after(off);
  connected=false;await h.transports[0].network.refresh();
  assert.equal(lease.context().connection,'ready','peer status alone cannot interrupt the application');
  t.mock.timers.tick(0);await tick();
  assert.equal(lease.context().connection,'ready');
  assert.equal(states.includes('recovering'),false);
  assert.equal((await lease.request({path:'/api/action'})).status,200);
  connected=true;await h.transports[0].network.refresh();
  healthy=false;connected=false;await h.transports[0].network.refresh();
  assert.equal(lease.context().connection,'ready');
  t.mock.timers.tick(0);await tick();
  assert.equal(lease.context().connection,'recovering');
  assert.throws(()=>lease.request({path:'/api/action'}),{code:'NETWORK_NOT_READY'});
  connected=true;healthy=true;await h.transports[0].network.refresh();
  assert.equal(lease.context().connection,'recovering','ready status must not clear failed data-path health');
  await h.client.retryConnection();
  assert.equal(lease.context().connection,'ready');
  assert.equal((await lease.request({path:'/api/action'})).status,200);
  assert.equal(h.sessions.length,1,'recovery retains the authorized application lease');
  const loggingOut=h.client.logout();
  assert.throws(()=>lease.context(),{code:'NETWORK_CHANGED'});
  assert.ok(states.includes('expired'));await loggingOut;
});

test('application connection seam: box-session expiry cannot be revived by reconnecting the same device', async t => {
  const h=harness(t,{gatewayRequest:async()=>({status:200,body:Buffer.from('{"id":4}')})});
  await h.client.loginPassword({phone:'13800000001',password:'test'});
  await h.client.connectBox('box-1');
  const lease=await h.client.applicationConnection();
  h.sessions[0].input.onExpired();
  assert.throws(()=>lease.context(),{code:'NETWORK_CHANGED'});
  await h.client.connectBox('box-1');
  assert.throws(()=>lease.context(),{code:'NETWORK_CHANGED'});
  assert.equal((await h.client.applicationConnection()).context().boxId,'box-1');
});

test("signed resource backend selection preserves legacy product scope and cannot escalate through request fields", async t => {
  const requests = [];
  const h = harness(t, { gatewayRequest: async input => {
    requests.push(input);
    return { status: 200, body: Buffer.from('{"id":4}') };
  } });
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  await h.client.connectBox("box-1");
  const id = "centaurai.wanx.superadvisors";
  const legacy = await h.client.applicationConnection(id);
  await legacy.request({ path: "/api/agents", applicationScope: "wanx", applicationExchange: true });
  assert.equal(requests.at(-1).applicationScope, "super-advisory");
  assert.equal(requests.at(-1).applicationExchange, false);
  const resourceApp = await h.client.applicationConnection(id, { backendProductId: "wanx" });
  await resourceApp.request({ path: "/api/agents", applicationScope: "super-advisory", applicationExchange: true });
  assert.equal(requests.at(-1).applicationScope, undefined);
  assert.equal(requests.at(-1).applicationExchange, false);
  const scoped = await h.client.applicationConnection("test.resource-app", { backendProductId: "super-advisory" });
  await scoped.request({ path: "/api/agents" });
  assert.equal(requests.at(-1).applicationScope, "super-advisory");
  const before = requests.length;
  for (const options of [{ backendProductId: "admin" }, { backendProductId: "wanx", arbitrary: true }, {}, null, []])
    await assert.rejects(h.client.applicationConnection(id, options), { code: "BOX_APPLICATION_SCOPE_FORBIDDEN" });
  assert.equal(requests.length, before);
});

test("ownership transfer closes the selected box and refreshes authoritative access", async t => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  await h.client.connectBox("box-1");
  h.account.createOwnershipTransfer = async input => ({ deviceId: input.deviceId, state: "pending_target", direction: "outgoing" });
  const result = await h.client.createOwnershipTransfer({ deviceId: "box-1" });
  assert.equal(result.state, "pending_target");
  assert.equal(result.refreshRequired, false);
  assert.equal(h.sessions[0].closed, true);
  assert.notEqual(h.client.snapshot().phase, "ready");
  assert.equal(h.client.snapshot().devices.length, 1, "owner remains owner while recipient has not accepted");
});

test("accepting ownership refreshes newly owned boxes even with P2P disabled", async t => {
  const h = harness(t, { enabled: false });
  h.catalog([]);
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  h.account.acceptOwnershipTransfer = async () => {
    h.catalog([{ ...device, ownershipEpoch: 2 }]);
    return { deviceId: "box-1", state: "completed", ownershipEpoch: 2 };
  };
  const value = await h.client.acceptOwnershipTransfer({ transferId: "transfer-1", retainData: true });
  assert.equal(value.state, "completed");
  assert.equal(value.refreshRequired, false);
  assert.equal(h.client.snapshot().devices[0].deviceId, "box-1");
});

test("late ownership completion cannot refresh or disconnect a newly logged-in account", async t => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  const pending = deferred();
  h.account.acceptOwnershipTransfer = () => pending.promise;
  const accepting = h.client.acceptOwnershipTransfer({ transferId: "transfer-1" });
  await h.client.logout();
  await h.client.loginPassword({ phone: "13800000002", password: "test" });
  await h.client.connectBox("box-1");
  pending.resolve({ deviceId: "box-1", state: "completed" });
  await assert.rejects(accepting, { code: "ACCOUNT_CANCELLED" });
  assert.equal(h.client.snapshot().phase, "ready");
});

// Exercise the scheduled renewal, not a manual refresh (which leaves its old timer alive).
test("background renewal retries a temporary outage after retiring an unhealthy engine", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let offline = false;
  const h = harness(t, { sidecarStatus: () => offline ? { phase: "unavailable", peers: [] } : undefined });
  await h.client.loginPassword({ phone: "account-1" });
  offline = true;
  await h.transports[0].network.refresh();
  h.override(input => { if (input.path.endsWith("/restore")) throw fail("ACCOUNT_NETWORK_ERROR"); });
  t.mock.timers.tick(60_000);
  await tick();
  assert.equal(h.client.snapshot().platform.phase, "unavailable");
  assert.equal(h.transports[0].closed, true);
  offline = false;
  h.override(undefined);
  t.mock.timers.tick(5_000);
  await tick();
  assert.equal(h.client.snapshot().platform.phase, "ready");
  assert.equal(h.client.snapshot().devices[0].canOpen, true);
});

for (const stop of ["disable", "logout", "close", "denied"]) {
  test(`pending automatic retry stops on ${stop}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = harness(t);
    h.override(input => { if (input.path.endsWith("/prepare")) throw fail("ACCOUNT_NETWORK_ERROR"); });
    await h.client.loginPassword({ phone: "account-1" });
    if (stop === "disable") await h.client.setNetworkEnabled(false);
    if (stop === "logout") await h.client.logout();
    if (stop === "close") await h.client.close();
    if (stop === "denied") {
      h.override(input => { if (input.path.endsWith("/prepare")) throw fail("ACCOUNT_ACCESS_DENIED", 403); });
      await h.client.refreshDevices();
    }
    const calls = h.calls.length;
    h.override(undefined);
    t.mock.timers.tick(120_000);
    await tick();
    assert.equal(h.calls.length, calls);
    assert.notEqual(h.client.snapshot().platform.phase, "ready");
  });
}

test("offline activation retries with bounded backoff and recovers without a system event", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(t);
  h.override(input => { if (input.path.endsWith("/prepare")) throw fail("ACCOUNT_NETWORK_ERROR"); });
  await h.client.loginPassword({ phone: "account-1" });
  for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
    const before = h.calls.length;
    t.mock.timers.tick(delay - 1);
    await tick();
    assert.equal(h.calls.length, before, "must not retry before backoff elapses");
    t.mock.timers.tick(1);
    await tick();
    assert.ok(h.calls.length > before, "must retry after backoff elapses");
  }
  h.override(undefined);
  const recovered = new Promise(resolve => {
    const unsubscribe = h.client.subscribe(state => {
      if (state.platform.phase === "ready") { unsubscribe(); resolve(); }
    });
    t.after(unsubscribe);
  });
  t.mock.timers.tick(60_000);
  await recovered;
  assert.equal(h.client.snapshot().platform.phase, "ready");
});

test("a hard lease deadline cancels pending recovery and cannot revive old access", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(t);
  h.override(input => input.path.startsWith("/app-api/network/enrollments/") ? {
    enrollmentId: "enrollment-1", networkSessionId: "enrollment-1", phase: "ready",
    managementUrl: "https://p2p.qeeshu.com", leaseExpiresAt: Date.now() / 1000 + 2,
  } : undefined);
  await h.client.loginPassword({ phone: "account-1" });
  h.override(input => { if (input.path.endsWith("/restore")) throw fail("ACCOUNT_NETWORK_ERROR"); });
  t.mock.timers.tick(1_000);
  await tick();
  assert.equal(h.client.snapshot().platform.phase, "ready");
  t.mock.timers.tick(1_000);
  await tick();
  assert.equal(h.client.snapshot().platform.reason, "NETWORK_LEASE_EXPIRED");
  const calls = h.calls.length;
  h.override(undefined);
  t.mock.timers.tick(120_000);
  await tick();
  await h.client.networkChanged();
  assert.equal(h.calls.length, calls);
  assert.equal(h.client.snapshot().platform.reason, "NETWORK_LEASE_EXPIRED");
});

test("an old account retry cannot restart after signing into another account", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(t);
  h.override(input => { if (input.path.endsWith("/prepare")) throw fail("ACCOUNT_NETWORK_ERROR"); });
  await h.client.loginPassword({ phone: "account-1" });
  await h.client.logout();
  h.override(undefined);
  await h.client.loginPassword({ phone: "account-2" });
  const calls = h.calls.length;
  t.mock.timers.tick(5_000);
  await tick();
  assert.equal(h.calls.length, calls);
  assert.equal(h.client.snapshot().account.accountId, "account-2");
  assert.equal(h.client.snapshot().platform.phase, "ready");
});


test("logout completes locally while old gateway drains without changing the next login", async t => {
  const stopped = deferred();
  t.after(() => stopped.resolve());
  const h = harness(t, {
    onGatewayClose: () => stopped.promise,
    gatewayRequest: async () => ({ status: 200, body: Buffer.from('{"id":4}') }),
  });
  await h.client.loginPassword({ phone: "account-1" });
  await h.client.connectBox("box-1");
  const lease = await h.client.applicationConnection();
  const loggingOut = h.client.logout();
  assert.throws(() => lease.context(), { code: "NETWORK_CHANGED" });
  await loggingOut;
  assert.equal(h.client.snapshot().account.phase, "signed_out");
  assert.equal(h.client.snapshot().connection, null);
  assert.equal(h.sessions[0].closed, false);
  const login = h.client.loginPassword({ phone: "account-2" });
  await tick();
  assert.equal(h.transports.length, 1, "new transport must wait for the old process to stop");
  stopped.resolve();
  await login;
  assert.equal(h.client.snapshot().account.accountId, "account-2");
  assert.equal(h.client.snapshot().platform.phase, "ready");
  assert.equal(h.transports[0].closed, true);
});


test("logout cleanup status cannot cancel the next login's network activation", async t => {
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-1" });
  await h.client.logout();
  const resume = deferred();
  const loginPassword = h.account.loginPassword;
  h.account.loginPassword = async input => {
    await resume.promise;
    return loginPassword(input);
  };
  const login = h.client.loginPassword({ phone: "account-1" });
  h.publishAccount({ phase: "signed_out", accountId: null, clientId: null, logoutPending: false });
  resume.resolve();
  await login;
  assert.equal(h.client.snapshot().account.phase, "authenticated");
  assert.equal(h.client.snapshot().platform.phase, "ready");
  assert.equal(h.client.snapshot().devices.length, 1);
});

test("password reset sign-out retires the selected box without remote logout and supports fresh login", async t => {
  const h = harness(t);
  h.account.changePassword = async () => {
    h.publishAccount({ phase: "signed_out", accountId: null, clientId: null, reason: "password_reset" });
    return { passwordReset: true };
  };
  await h.client.initialize();
  await h.client.loginPassword({ phone: "13800000001", password: "test" });
  await h.client.connectBox("box-1");
  assert.equal(h.client.snapshot().phase, "ready");
  assert.deepEqual(await h.client.changePassword({ code: "000001", password: "new-password" }), { passwordReset: true });
  const state = h.client.snapshot();
  assert.equal(state.account.reason, "password_reset");
  assert.equal(state.connection, null);
  assert.deepEqual(state.devices, []);
  assert.equal(state.platform.phase, "idle");
  await tick();
  assert.equal(h.sessions[0].closed, true);
  assert.equal(h.transports[0].closed, true);
  assert.equal(h.calls.some(call => call.path === "logout" || call.path === "/app-api/network/current"), false);
  await h.client.loginPassword({ phone: "13800000001", password: "new-password" });
  assert.equal(h.client.snapshot().platform.phase, "ready");
});

test("pending authorization is observed after two seconds without renewing or preparing again", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(t);
  const published = [];
  h.client.subscribe(state => published.push(state));
  let pending = true;
  h.override(input => input.path.startsWith("/app-api/network/boxes")
    ? { boxes: [{ ...device, accessState: pending ? "authorization_pending" : "ready" }] } : undefined);
  await h.client.loginPassword({ phone: "account-1" });
  const initialCalls = h.calls.length;
  assert.equal(h.client.snapshot().devices[0].canOpen, false);
  pending = false;
  t.mock.timers.tick(1999);
  await tick();
  assert.equal(h.calls.length, initialCalls);
  t.mock.timers.tick(1);
  await tick();
  assert.equal(h.client.snapshot().devices[0].canOpen, true);
  assert.deepEqual(h.calls.slice(initialCalls).map(call => call.path), ["/app-api/network/boxes", "/app-api/network/devices"]);
  assert.equal(published.at(-1).devices[0].canOpen, true);
  const afterReady = h.calls.length;
  t.mock.timers.tick(4000);
  await tick();
  assert.equal(h.calls.length, afterReady);
});

test("another box awaiting authorization never disconnects the ready selected box", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(t);
  h.override(input => input.path.startsWith("/app-api/network/boxes")
    ? { boxes: [{ ...device, accessState: "ready" }, { ...device, deviceId: "box-2", accessState: "authorization_pending" }] } : undefined);
  await h.client.loginPassword({ phone: "account-1" });
  await h.client.connectBox("box-1");
  t.mock.timers.tick(2000);
  await tick();
  assert.equal(h.client.snapshot().connection.deviceId, "box-1");
  assert.equal(h.client.snapshot().phase, "ready");
  assert.equal(h.sessions[0].closed, false);
  assert.equal(h.calls.filter(call => call.path.endsWith("/prepare")).length, 1);
});

test("fast authorization polling is bounded to one minute and normal renewal continues", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(t, { renewIntervalMs: 120_000 });
  h.override(input => input.path.startsWith("/app-api/network/boxes")
    ? { boxes: [{ ...device, accessState: "authorization_pending" }] } : undefined);
  await h.client.loginPassword({ phone: "account-1" });
  const count = () => h.calls.filter(call => call.path === "/app-api/network/boxes").length;
  const initial = count();
  for (let i = 0; i < 30; i++) {
    t.mock.timers.tick(2000);
    await tick();
  }
  assert.equal(count() - initial, 29);
  t.mock.timers.tick(4000);
  await tick();
  assert.equal(count() - initial, 29);
  t.mock.timers.tick(56000);
  await tick();
  assert.equal(count() - initial, 30);
  t.mock.timers.tick(2000);
  await tick();
  assert.equal(count() - initial, 30, "renewal must not restart an endless fast polling loop");
  assert.equal(h.calls.filter(call => call.path.endsWith("/prepare")).length, 1);
});

for (const stop of ["disable", "logout", "close"]) {
  test(`authorization polling cancels a late directory response on ${stop}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = harness(t);
    h.override(input => input.path.startsWith("/app-api/network/boxes")
      ? { boxes: [{ ...device, accessState: "authorization_pending" }] } : undefined);
    await h.client.loginPassword({ phone: "account-1" });
    const waiting = deferred();
    h.override(input => input.path === "/app-api/network/boxes" ? waiting.promise : undefined);
    t.mock.timers.tick(2000);
    await tick();
    h.override(undefined);
    if (stop === "disable") await h.client.setNetworkEnabled(false);
    if (stop === "logout") await h.client.logout();
    if (stop === "close") await h.client.close();
    const callCount = h.calls.length;
    waiting.resolve({ boxes: [{ ...device, deviceId: "stale-box", accessState: "ready" }] });
    await tick();
    t.mock.timers.tick(10000);
    await tick();
    assert.equal(h.calls.length, callCount);
    assert.equal(h.client.snapshot().devices.some(box => box.deviceId === "stale-box"), false);
    assert.equal(h.client.snapshot().devices.some(box => box.canOpen), false);
  });
}

test("authorization ACK retries a temporary endpoint failure without repeating preparation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(t);
  let pending = true, endpointFailed = false;
  h.override(input => {
    if (input.path.startsWith("/app-api/network/boxes"))
      return { boxes: [{ ...device, accessState: pending ? "authorization_pending" : "ready" }] };
    if (input.path === "/app-api/network/devices") {
      if (pending) return { networkSessionId: "enrollment-1", devices: [] };
      if (!endpointFailed) { endpointFailed = true; throw fail("ACCOUNT_NETWORK_ERROR"); }
    }
  });
  await h.client.loginPassword({ phone: "account-1" });
  pending = false;
  t.mock.timers.tick(2000);
  await tick();
  assert.equal(h.client.snapshot().devices[0].accessState, "ready");
  assert.equal(h.client.snapshot().devices[0].canOpen, false);
  t.mock.timers.tick(2000);
  await tick();
  assert.equal(h.client.snapshot().devices[0].canOpen, true);
  assert.equal(h.calls.filter(call => call.path.endsWith("/prepare")).length, 1);
  assert.equal(h.calls.filter(call => call.path.endsWith("/restore")).length, 1);
});

test("lease expiry cancels pending authorization reads and cannot reauthorize a late response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(t);
  h.override(input => {
    if (input.path.startsWith("/app-api/network/boxes"))
      return { boxes: [{ ...device, accessState: "authorization_pending" }] };
    if (input.path === "/app-api/network/enrollments/enrollment-1")
      return { enrollmentId: "enrollment-1", networkSessionId: "enrollment-1", phase: "ready",
        managementUrl: "https://p2p.qeeshu.com", leaseExpiresAt: Date.now() / 1000 + 5 };
  });
  await h.client.loginPassword({ phone: "account-1" });
  const waiting = deferred(), renewal = deferred();
  h.override(input => input.path === "/app-api/network/boxes" ? waiting.promise
    : input.path === "/app-api/network/restore" ? renewal.promise : undefined);
  t.mock.timers.tick(2000);
  await tick();
  t.mock.timers.tick(3000);
  await tick();
  assert.equal(h.client.snapshot().platform.reason, "NETWORK_LEASE_EXPIRED");
  const callCount = h.calls.length;
  waiting.resolve({ boxes: [{ ...device, deviceId: "stale-box", accessState: "ready" }] });
  renewal.resolve({});
  await tick();
  t.mock.timers.tick(10000);
  await tick();
  assert.equal(h.calls.length, callCount);
  assert.equal(h.client.snapshot().devices.some(box => box.canOpen || box.deviceId === "stale-box"), false);
});


test("registered local box connects with authentication while cloud network is disabled", async t => {
  let closed = 0;
  const local = { deviceId: "local-0123456789abcdef01234567", displayName: "本机万象", serviceUrl: "http://127.0.0.1:8089", local: true, accessState: "ready", canOpen: true };
  const h = harness(t, { enabled: false, localBoxes: {
    list: async () => [local],
    createSession: async (id, input) => { assert.equal(id, local.deviceId); assert.equal(input.url, local.serviceUrl); return { close() { closed++; } }; },
  } });
  await h.client.initialize();
  await h.client.loginPassword({ phone: "alice", password: "unused" });
  assert.equal(h.client.snapshot().devices[0].local, true);
  await h.client.connectBox(local.deviceId);
  assert.equal(h.client.snapshot().connection.mode, "local");
  assert.equal(h.client.snapshot().network.phase, "disabled");
  await h.client.setNetworkEnabled(false);
  assert.equal(h.client.snapshot().phase, "ready");
  await h.client.connect({ deviceId: "development", url: "http://127.0.0.1:8089", mode: "direct" });
  assert.equal(h.client.snapshot().connection.mode, "direct", "manual direct connection never gets trusted local status");
  assert.equal(closed, 1);
  await h.client.connectBox(local.deviceId);
  h.publishAccount({ phase: "authenticated", accountId: "other", clientId: "other-client" });
  await tick();
  assert.equal(h.client.snapshot().connection, null, "account switch closes local session");
});

test("local login failure never creates a ready connection", async t => {
  const local = { deviceId: "local-0123456789abcdef01234567", serviceUrl: "http://127.0.0.1:8089", local: true, canOpen: true };
  const h = harness(t, { enabled: false, localBoxes: { list: async () => [local], createSession: async () => { throw fail("LOCAL_BOX_AUTH_FAILED"); } } });
  await h.client.initialize(); await h.client.loginPassword({});
  await assert.rejects(h.client.connectBox(local.deviceId), { code: "LOCAL_BOX_AUTH_FAILED" });
  assert.equal(h.client.snapshot().connection, null);
  assert.equal(h.client.snapshot().phase, "disconnected");
});


test("local session expiry still disconnects after cloud network preference changes", async t => {
  let expire;
  const local = { deviceId: "local-0123456789abcdef01234567", serviceUrl: "http://127.0.0.1:8089", local: true, canOpen: true };
  const h = harness(t, { enabled: false, localBoxes: { list: async () => [local], createSession: async (_id, input) => {
    expire = input.onExpired; return { close() {} };
  } } });
  await h.client.initialize(); await h.client.loginPassword({}); await h.client.connectBox(local.deviceId);
  await h.client.setNetworkEnabled(false);
  expire(); await tick();
  assert.equal(h.client.snapshot().connection, null);
});

test("cloud preference change cancels an unfinished local login", async t => {
  const entered = deferred(), finish = deferred();
  const local = { deviceId: "local-0123456789abcdef01234567", serviceUrl: "http://127.0.0.1:8089", local: true, canOpen: true };
  const h = harness(t, { enabled: false, localBoxes: { list: async () => [local], createSession: async (_id, { signal }) => {
    entered.resolve(); await finish.promise; signal.throwIfAborted(); return { close() {} };
  } } });
  await h.client.initialize(); await h.client.loginPassword({});
  const connecting = h.client.connectBox(local.deviceId);
  await entered.promise; await h.client.setNetworkEnabled(false); finish.resolve(); await connecting;
  assert.equal(h.client.snapshot().connection, null);
});

test("pending cleanup retires the tunnel, polls with backoff and reconnects the same authorized box", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-1" });
  await h.client.connectBox("box-1");
  let pending = true;
  h.override(input => {
    if (input.path.endsWith("/devices") && pending) throw fail("NETWORK_REVOCATION_PENDING", 503);
    return input.path.endsWith("/restore") && pending ? {
    enrollmentId: "enrollment-1", networkSessionId: "enrollment-1",
    phase: "revocation_pending", managementUrl: "https://p2p.qeeshu.com",
    } : undefined;
  });
  await h.client.refreshDevices();
  assert.equal(h.transports[0].closed, true);
  assert.equal(h.client.snapshot().connection, null);
  assert.equal(h.client.snapshot().platform.reason, "NETWORK_REVOCATION_PENDING");
  const count = () => h.calls.filter(c => c.path.endsWith("/restore")).length;
  const before = count();
  t.mock.timers.tick(4999); await tick(); assert.equal(count(), before);
  t.mock.timers.tick(1); await tick(); assert.equal(count(), before + 1);
  assert.equal(h.transports.length, 1, "pending cannot create a replacement tunnel");
  pending = false;
  t.mock.timers.tick(10000); await tick();
  assert.equal(h.client.snapshot().phase, "ready");
  assert.equal(h.client.snapshot().connection.deviceId, "box-1");
  assert.equal(h.calls.filter(c => c.path === "/app-api/network/enrollments").length, 1);
});

for (const action of ["disconnect", "logout", "disable", "close", "denied"]) {
  test(`pending cleanup cannot reconnect after ${action}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = harness(t);
    await h.client.loginPassword({ phone: "account-1" });
    await h.client.connectBox("box-1");
    h.override(input => {
      if (input.path.endsWith("/devices")) throw fail("NETWORK_REVOCATION_PENDING", 503);
      return input.path.endsWith("/restore") ? {
      enrollmentId: "enrollment-1", networkSessionId: "enrollment-1",
      phase: "revocation_pending", managementUrl: "https://p2p.qeeshu.com",
      } : undefined;
    });
    await h.client.refreshDevices();
    if (action === "disconnect") await h.client.disconnect();
    if (action === "logout") await h.client.logout();
    if (action === "disable") await h.client.setNetworkEnabled(false);
    if (action === "close") await h.client.close();
    if (action === "denied") {
      h.override(input => { if (input.path.endsWith("/restore")) throw fail("ACCOUNT_ACCESS_DENIED", 403); });
      await h.client.refreshDevices();
    }
    h.override(undefined);
    t.mock.timers.tick(60000); await tick();
    assert.equal(h.client.snapshot().connection, null);
    if (action !== "disconnect") assert.equal(h.transports.length, 1);
  });
}

test("revocation cleanup only replaces enrollment after a confirmed revoked restore", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-1" });
  await h.client.connectBox("box-1");
  let phase = "revocation_pending";
  h.override(input => {
    if (input.path.endsWith("/devices") && phase === "revocation_pending") throw fail("NETWORK_REVOCATION_PENDING", 503);
    return input.path.endsWith("/restore") ? {
    enrollmentId: "enrollment-1", networkSessionId: "enrollment-1", phase,
    managementUrl: "https://p2p.qeeshu.com",
    } : undefined;
  });
  await h.client.refreshDevices();
  phase = "revoked";
  const recovered = new Promise(resolve => {
    const stop = h.client.subscribe(s => { if (s.phase === "ready") { stop(); resolve(); } });
    t.after(stop);
  });
  t.mock.timers.tick(5000);
  await recovered;
  assert.equal(h.client.snapshot().phase, "ready");
  assert.equal(h.client.snapshot().connection.deviceId, "box-1");
  assert.equal(h.calls.filter(c => c.path === "/app-api/network/enrollments").length, 2);
});

test("pending cleanup cannot reopen a box removed from the fresh authorized directory", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(t);
  await h.client.loginPassword({ phone: "account-1" });
  await h.client.connectBox("box-1");
  h.override(input => {
    if (input.path.endsWith("/devices")) throw fail("NETWORK_REVOCATION_PENDING", 503);
    return input.path.endsWith("/restore") ? {
    enrollmentId: "enrollment-1", networkSessionId: "enrollment-1",
    phase: "revocation_pending", managementUrl: "https://p2p.qeeshu.com",
    } : undefined;
  });
  await h.client.refreshDevices();
  h.catalog([]); h.override(undefined);
  t.mock.timers.tick(5000); await tick();
  assert.equal(h.client.snapshot().platform.phase, "ready");
  assert.equal(h.client.snapshot().connection, null);
  assert.equal(h.sessions.length, 1);
});

test("a native engine outage reconnects the user's box after the engine returns", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let offline = false, firstAgent, stale = false;
  const h = harness(t, {
    sidecarStatus: () => offline ? { phase: "unavailable", peers: [] } : undefined,
    probe: async (_url, { agent }) => {
      firstAgent ??= agent;
      if (offline || stale && agent === firstAgent) throw fail("network_unavailable");
    },
  });
  await h.client.loginPassword({ phone: "account-1" });
  await h.client.connectBox("box-1");
  offline = true;
  stale = true;
  await h.transports[0].network.refresh();
  assert.equal(h.client.snapshot().phase, "ready", "status loss must first confirm data-path health");
  t.mock.timers.tick(0); await tick();
  assert.equal(h.client.snapshot().phase, "recovering");
  assert.equal(h.client.snapshot().connection.deviceId, "box-1");
  assert.equal(h.sessions[0].closed, false, "status loss alone must not retire a valid app lease");
  offline = false;
  await h.transports[0].network.refresh();
  t.mock.timers.tick(30_000);
  await tick();
  assert.equal(h.client.snapshot().phase, "ready");
  assert.equal(h.client.snapshot().connection.deviceId, "box-1");
  assert.equal(h.sessions[0].closed, true, "a destroyed tunnel agent must retire its old session");
  assert.equal(h.sessions.length, 2, "fresh box authentication, never reuse the closed gateway");
});

test('natural box-token expiry automatically obtains a fresh authorized session', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness(t);await h.client.loginPassword({phone:'account-1'});await h.client.connectBox('box-1');
  h.sessions[0].getToken=()=>'';
  h.sessions[0].input.onExpired('expired');
  assert.equal(h.client.snapshot().phase,'recovering');
  assert.equal(h.client.snapshot().connection.deviceId,'box-1');
  t.mock.timers.tick(0);await tick();
  assert.equal(h.client.snapshot().phase,'ready');assert.equal(h.sessions.length,2);
});

for(const action of ['disconnect','logout','disable']) test(`natural token recovery cannot resume after ${action}`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const h=harness(t);
  await h.client.loginPassword({phone:'account-1'});await h.client.connectBox('box-1');
  h.sessions[0].getToken=()=>'';h.sessions[0].input.onExpired('expired');
  if(action==='disable')await h.client.setNetworkEnabled(false);else await h.client[action]();
  t.mock.timers.tick(600000);await tick();assert.equal(h.sessions.length,1);assert.equal(h.client.snapshot().connection,null);
});

test('selected box survives a hard network lease deadline only after fresh authorization',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const h=harness(t);
  h.override(input=>input.path.startsWith('/app-api/network/enrollments/')?{
    enrollmentId:'enrollment-1',networkSessionId:'enrollment-1',phase:'ready',
    managementUrl:'https://p2p.qeeshu.com',leaseExpiresAt:Date.now()/1000+2}:undefined);
  await h.client.loginPassword({phone:'account-1'});await h.client.connectBox('box-1');
  h.override(input=>{if(input.path.endsWith('/restore'))throw fail('ACCOUNT_NETWORK_ERROR');});
  t.mock.timers.tick(1000);await tick();t.mock.timers.tick(1000);await tick();
  assert.equal(h.client.snapshot().connection,null);assert.equal(h.sessions[0].closed,true);
  h.override(undefined);t.mock.timers.tick(5000);await tick();await tick();
  assert.equal(h.client.snapshot().connection.deviceId,'box-1');assert.equal(h.sessions.length,2);
});
