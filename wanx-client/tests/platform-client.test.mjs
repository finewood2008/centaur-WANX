import test from "node:test";
import assert from "node:assert/strict";
import { createPlatformClient } from "../platform.mjs";
import { createClient } from "../client.mjs";
import { createNetwork } from "../network/index.mjs";

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
        return { networkSessionId: serverSession, devices: catalog };
      if (input.path === "/app-api/network/current") {
        serverSession = null;
        return { phase: "revoked" };
      }
      throw Error(`unexpected route ${input.path}`);
    },
    logout: async () => {
      calls.push({ path: "logout" });
      return publish({ phase: "signed_out", accountId: null, clientId: null });
    },
    close: async () => {},
  };
  const client = createPlatformClient({
    account,
    readPreference:
      options.readPreference || (async () => options.enabled ?? true),
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
              return {
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
        probe: async () => {},
        createGateway: async ({ session }) => ({
          url: "http://127.0.0.1:19800",
          close: async () => {
            item.gatewayClosed = true;
            await session?.close();
          },
        }),
      });
      return { network, client: transport };
    },
    async createSession(input) {
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
  assert.deepEqual(
    h.calls.slice(-2).map((c) => c.path),
    ["/app-api/network/current", "logout"],
  );
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
  const h = harness(t),
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
  const h = harness(t),
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
    if (input.path === "/app-api/network/restore")
      throw fail("ACCOUNT_NETWORK_ERROR");
  });
  await h.client.refreshDevices();
  assert.equal(h.client.snapshot().platform.phase, "ready");
  assert.equal(h.client.snapshot().phase, "ready");
  assert.equal(h.sessions[0].closed, false);
  h.override((input) => {
    if (input.path === "/app-api/network/restore")
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
