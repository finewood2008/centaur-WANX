import { createNetwork } from "./network/index.mjs";
import { createDashboardGateway } from "./octop/gateway.mjs";
import { probeEndpoint } from "./octop/probe.mjs";
import { validateApplicationConnectionOptions } from "./applications/backend-scope.mjs";

const HEALTH_INTERVAL_MS = 30_000;
const MAX_RECOVERY_ATTEMPTS = 3;
const AUTH_FAILURES = new Set([
  "auth_required", "auth_failed", "auth_expired", "auth_unsupported",
  "NETWORK_DEVICE_ACCESS_DENIED", "ACCOUNT_LOGIN_REQUIRED",
  "BOX_PLATFORM_AUTH_FAILED", "LOCAL_BOX_AUTH_FAILED",
]);

/** Owns only this application's connections, never the shared NetBird daemon. */
export function createClient({
  network = createNetwork(),
  createGateway = createDashboardGateway,
  probe = probeEndpoint,
} = {}) {
  let phase = "disconnected";
  let connection = null;
  let pendingMode = null;
  let reason = null;
  let gateway = null;
  let epoch = 0;
  let closed = false;
  let pendingProbe = null;
  let healthTimer, healthController, activeEndpoint, activeSessionFactory;
  let recovery = null;
  const listeners = new Set();
  const closing = new Set();
  const connecting = new Set();
  const healthChecks = new Set();

  function snapshot() {
    return structuredClone({
      network: network.snapshot(),
      phase,
      connection,
      reason,
      recovery,
    });
  }
  function emit() {
    const state = snapshot();
    for (const listener of listeners) listener(state);
  }
  function dispose(value) {
    if (!value) return Promise.resolve();
    const promise = Promise.resolve(value.close());
    closing.add(promise);
    promise.then(
      () => closing.delete(promise),
      () => closing.delete(promise),
    );
    return promise;
  }
  async function disconnect(nextReason = null) {
    epoch += 1;
    clearTimeout(healthTimer);
    healthController?.abort();
    healthController = null;
    activeEndpoint = null;
    activeSessionFactory = null;
    if (nextReason !== "connection_retries_exhausted") recovery = null;
    pendingProbe?.abort();
    pendingProbe = null;
    const previous = gateway;
    gateway = null;
    connection = null;
    pendingMode = null;
    phase = "disconnected";
    reason = nextReason;
    emit();
    await dispose(previous);
    return snapshot();
  }

  function scheduleHealthCheck(generation) {
    if (closed || generation !== epoch || !connection) return;
    clearTimeout(healthTimer);
    healthTimer = setTimeout(() => {
      const task = checkHealth(generation);
      healthChecks.add(task);
      task.then(() => healthChecks.delete(task), () => healthChecks.delete(task));
    }, HEALTH_INTERVAL_MS);
    healthTimer.unref?.();
  }

  async function checkHealth(generation) {
    const live = () => !closed && generation === epoch && Boolean(connection);
    if (!live()) return;
    const controller = new AbortController();
    healthController = controller;
    const check = (endpoint = activeEndpoint) => probe(endpoint.url, {
      agent: endpoint.agent, signal: controller.signal,
    });
    try {
      if (!recovery) {
        try {
          await check();
          if (!live()) return;
          phase = "ready";
          reason = null;
          emit();
          return;
        } catch {
          if (!live()) return;
          recovery = { deviceId: connection.deviceId, attempt: 0, maxAttempts: MAX_RECOVERY_ATTEMPTS, status: "retrying" };
        }
      }
      recovery.attempt++;
      phase = "recovering";
      reason = "network_unavailable";
      emit();
      try {
        // Repair only this client's path. Keep the gateway and application leases
        // alive; reconnecting via connectBox would unnecessarily require Admin SSO.
        if (connection.mode === "netbird") await network.networkChanged();
        if (!live()) return;
        const endpoint = await network.resolveEndpoint(connection);
        if (!live()) return;
        await check(endpoint);
        if (!live()) return;
        if (endpoint.agent !== activeEndpoint.agent) {
          // An engine restart destroys its old tunnel agent. Re-authorize through
          // the normal session factory; never reuse credentials across accounts.
          let session, replacement;
          try {
            session = await activeSessionFactory?.({ ...endpoint, signal: controller.signal });
            if (!live()) { await session?.close(); return; }
            replacement = await createGateway({
              deviceId: connection.deviceId, targetURL: endpoint.url,
              agent: endpoint.agent, session,
            });
            if (!live()) { await dispose(replacement); return; }
          } catch (error) {
            await session?.close();
            throw error;
          }
          const previous = gateway;
          gateway = replacement;
          activeEndpoint = endpoint;
          connection = { ...connection, gatewayURL: replacement.url };
          await dispose(previous);
          if (!live()) return;
        }
        recovery = null;
        phase = "ready";
        reason = null;
        emit();
      } catch (error) {
        if (!live()) return;
        if ([401, 403].includes(error.status) || AUTH_FAILURES.has(error.code || error.message)) {
          await disconnect("connection_authorization_required");
          return;
        }
        if (recovery.attempt >= MAX_RECOVERY_ATTEMPTS) {
          recovery.status = "failed";
          await disconnect("connection_retries_exhausted");
        }
      }
    } finally {
      if (healthController === controller) healthController = null;
      scheduleHealthCheck(generation);
    }
  }

  const unsubscribe = network.subscribe((state) => {
    if (closed) return;
    if (connection?.mode === "netbird" || pendingMode === "netbird") {
      if (AUTH_FAILURES.has(state.reason)) {
        void disconnect("connection_authorization_required");
        return;
      }
      const lostPeer =
        connection &&
        state.phase === "ready" &&
        !state.peers.some(
          (peer) =>
            peer.ip ===
              new URL(connection.url).hostname.replace(/^\[|\]$/g, "") &&
            peer.connected,
        );
      if (
        !state.enabled ||
        state.phase === "auth_required" ||
        (state.phase === "unavailable" && !connection)
      ) {
        // Invalidate synchronously; a delayed connect must not resurrect this session.
        void disconnect(
          state.enabled ? "network_unavailable" : "network_disabled",
        );
        return;
      }
      if (connection) {
        phase = recovery || ["recovering", "unavailable"].includes(state.phase) || lostPeer ? "recovering" : "ready";
        reason = phase === "recovering" ? "network_unavailable" : null;
      }
    }
    emit();
  });

  async function connect(input, { createSession } = {}) {
    if (closed) throw new Error("client_closed");
    if (
      !input ||
      typeof input.deviceId !== "string" ||
      !/^[\w.-]{1,128}$/.test(input.deviceId) ||
      !["direct", "netbird"].includes(input.mode) ||
      typeof input.url !== "string" ||
      (input.name !== undefined &&
        (typeof input.name !== "string" || input.name.length > 128))
    ) {
      throw new Error("invalid_connection");
    }
    const stopping = disconnect();
    const requestEpoch = epoch;
    await stopping;
    if (closed || requestEpoch !== epoch) return snapshot();
    const attempt = ++epoch;
    phase = "connecting";
    pendingMode = input.mode;
    emit();
    let created;
    let platformSession;
    try {
      const endpoint = await network.resolveEndpoint(input);
      if (attempt !== epoch || closed) return snapshot();
      const controller = new AbortController();
      pendingProbe = controller;
      await probe(endpoint.url, {
        signal: controller.signal,
        agent: endpoint.agent,
      });
      if (attempt !== epoch || closed) return snapshot();
      if (createSession) {
        platformSession = await createSession({
          url: endpoint.url,
          agent: endpoint.agent,
          signal: controller.signal,
        });
        if (attempt !== epoch || closed) {
          await platformSession.close();
          return snapshot();
        }
      }
      created = await createGateway({
        deviceId: input.deviceId,
        targetURL: endpoint.url,
        agent: endpoint.agent,
        session: platformSession,
      });
      pendingProbe = null;
      if (attempt !== epoch || closed) {
        await dispose(created);
        return snapshot();
      }
      gateway = created;
      activeEndpoint = endpoint;
      activeSessionFactory = createSession;
      connection = {
        deviceId: input.deviceId,
        name: input.name || input.deviceId,
        url: endpoint.url,
        mode: input.mode,
        gatewayURL: created.url,
      };
      pendingMode = null;
      phase = "ready";
      reason = null;
      scheduleHealthCheck(attempt);
      emit();
      return snapshot();
    } catch (error) {
      if (platformSession && !created) await platformSession.close();
      if (attempt !== epoch || closed) return snapshot();
      pendingProbe = null;
      if (created) await dispose(created);
      phase = "disconnected";
      pendingMode = null;
      reason = error.code || error.message || "connection_failed";
      emit();
      throw error;
    }
  }

  return {
    snapshot,
    async request(input) {
      if (closed || !gateway) throw new Error("SESSION_CLOSED");
      return gateway.request(input);
    },
    async openWebSocket(input) {
      if (closed || !gateway) throw new Error("SESSION_CLOSED");
      return gateway.openWebSocket(input);
    },
    applicationConnection(applicationId, options) {
      const selectedProduct = validateApplicationConnectionOptions(options)?.backendProductId;
      if (closed || !gateway) throw new Error("SESSION_CLOSED");
      const lease = gateway;
      const applicationScope = selectedProduct === "wanx" ? undefined : selectedProduct || (applicationId === "centaurai.wanx.superadvisors" ? "super-advisory" : undefined);
      const assertLive = () => { if (closed || gateway !== lease) throw new Error("SESSION_CLOSED"); };
      return {
        request: (input) => { assertLive(); return lease.request({ ...input, applicationScope, applicationExchange: false }); },
        openStream: (input) => { assertLive(); return lease.openWebSocket({ ...input, applicationScope }); },
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setNetworkEnabled(enabled) {
      if (closed) throw new Error("client_closed");
      if (typeof enabled !== "boolean")
        throw new Error("invalid_network_switch");
      // Do not wait for a status subprocess before cutting off an overlay session.
      const stopping =
        !enabled &&
        (connection?.mode === "netbird" || pendingMode === "netbird")
          ? disconnect("network_disabled")
          : Promise.resolve();
      // Apply the switch before awaiting disposal so a later toggle wins.
      const switching = network.setEnabled(enabled);
      await Promise.all([stopping, switching]);
      return snapshot();
    },
    async networkChanged() {
      if (closed) return snapshot();
      await network.networkChanged();
      return snapshot();
    },
    async loginNetwork() {
      if (closed) throw new Error("client_closed");
      await network.login();
      return snapshot();
    },
    async enrollNetwork(input) {
      if (closed) throw new Error("client_closed");
      if (!input || typeof input.setupKey !== "string")
        throw new Error("invalid_setup_key");
      await network.enroll({ setupKey: input.setupKey });
      return snapshot();
    },
    connect(input, options) {
      const task = connect(input, options);
      connecting.add(task);
      task.then(
        () => connecting.delete(task),
        () => connecting.delete(task),
      );
      return task;
    },
    disconnect: () => disconnect(),
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      const stopping = disconnect();
      await network.close();
      await stopping;
      await Promise.allSettled([...healthChecks]);
      await Promise.allSettled([...connecting]);
      await Promise.allSettled([...closing]);
      listeners.clear();
    },
  };
}
