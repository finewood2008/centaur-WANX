import { createNetwork } from "./network/index.mjs";
import { createDashboardGateway } from "./octop/gateway.mjs";
import { probeEndpoint } from "./octop/probe.mjs";
import { validateApplicationConnectionOptions } from "./applications/backend-scope.mjs";

const HEALTH_INTERVAL_MS = 30_000;
const RECOVERY_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000];
const AUTH_FAILURES = new Set([
  "auth_required", "auth_failed", "auth_expired", "auth_unsupported",
  "NETWORK_DEVICE_ACCESS_DENIED", "ACCOUNT_LOGIN_REQUIRED",
  "BOX_PLATFORM_AUTH_FAILED", "LOCAL_BOX_AUTH_FAILED",
]);
const TRANSPORT_FAILURES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EAI_AGAIN", "CONNECT_TIMEOUT", "health_timeout", "health_unavailable", "network_unavailable", "network_recovering", "tunnel_timeout", "tunnel_rejected", "netbird_peer_disconnected"]);

/** Owns only this application's connections, never the shared NetBird daemon. */
export function createClient({
  network = createNetwork(),
  createGateway = createDashboardGateway,
  probe = probeEndpoint,
  onRecovery = () => {},
  measure = (_step, operation) => operation(),
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
  let boxSession = null;
  const businessGateways = new Map();
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
  function requestRecovery() {
    if (closed || !connection) return snapshot();
    recovery ||= { deviceId: connection.deviceId, attempt: 0, status: "retrying", startedAt: Date.now() };
    phase = "recovering";
    reason = "network_unavailable";
    emit();
    scheduleHealthCheck(epoch, 0);
    return snapshot();
  }
  async function recoverOnFailure(operation) {
    const generation = epoch;
    try { return await operation(); }
    catch (error) {
      // A failed business socket does not prove the whole box is offline.
      // Confirm health before changing the shared state and closing app views.
      if (generation === epoch && !recovery && !healthController &&
          TRANSPORT_FAILURES.has(error.code || error.message)) scheduleHealthCheck(generation, 0);
      throw error; // Never replay business writes, model calls, or stream messages.
    }
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
    recovery = null;
    pendingProbe?.abort();
    pendingProbe = null;
    const previous = gateway;
    const businesses = [...businessGateways.values()];
    businessGateways.clear();
    boxSession = null;
    gateway = null;
    connection = null;
    pendingMode = null;
    phase = "disconnected";
    reason = nextReason;
    emit();
    await Promise.all([dispose(previous), ...businesses.map(p => p.then(dispose, () => {}))]);
    return snapshot();
  }

  function scheduleHealthCheck(generation, delayMs = recovery ? RECOVERY_DELAYS_MS[Math.min(Math.max(0, recovery.attempt - 1), RECOVERY_DELAYS_MS.length - 1)] : HEALTH_INTERVAL_MS) {
    if (closed || generation !== epoch || !connection) return;
    clearTimeout(healthTimer);
    healthTimer = setTimeout(() => {
      const task = checkHealth(generation);
      healthChecks.add(task);
      task.then(() => healthChecks.delete(task), () => healthChecks.delete(task));
    }, delayMs);
    healthTimer.unref?.();
  }

  async function checkHealth(generation) {
    const live = () => !closed && generation === epoch && Boolean(connection);
    if (!live() || healthController) return;
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
        } catch (error) {
          if (!live()) return;
          recovery = { deviceId: connection.deviceId, attempt: 0, status: "retrying", startedAt: Date.now() };
          onRecovery({ action: "detected", errorCode: error.code || error.message });
        }
      }
      recovery.attempt++;
      recovery.nextRetryAt = null;
      phase = "recovering";
      reason = "network_unavailable";
      emit();
      onRecovery({ action: "attempt", attempt: recovery.attempt });
      try {
        // Repair only this client's path. Keep the gateway and application leases
        // alive; reconnecting via connectBox would unnecessarily require Admin SSO.
        let endpoint;
        try {
          endpoint = await network.resolveEndpoint(connection);
          if (!live()) return;
          await check(endpoint);
        } catch (error) {
          if (!live()) return;
          // A restarted engine needs time to receive its peer map. Repeated
          // recover commands here reset that handshake and prolong the outage.
          if (connection.mode !== "netbird" || ["netbird_peer_unknown", "netbird_peer_disconnected"].includes(error.code || error.message)) throw error;
          await network.networkChanged();
          if (!live()) return;
          endpoint = await network.resolveEndpoint(connection);
          if (!live()) return;
          await check(endpoint);
        }
        if (!live()) return;
        if (endpoint.agent !== activeEndpoint.agent || boxSession?.getToken && !boxSession.getToken()) {
          // An engine restart destroys its old tunnel agent. Re-authorize through
          // the normal session factory; never reuse credentials across accounts.
          let session, replacement;
          try {
            session = await activeSessionFactory?.({ ...endpoint, signal: controller.signal });
            if (!live()) { await session?.close(); return; }
            if (gateway.replaceTransport) {
              gateway.replaceTransport({ agent: endpoint.agent, session });
              replacement = gateway;
            } else replacement = await createGateway({
              deviceId: connection.deviceId, targetURL: endpoint.url,
              agent: endpoint.agent, session,
            });
            if (!live()) { await dispose(replacement); return; }
          } catch (error) {
            await session?.close();
            throw error;
          }
          const previous = gateway;
          const businesses = [...businessGateways.values()];
          businessGateways.clear();
          gateway = replacement;
          boxSession = session;
          activeEndpoint = endpoint;
          connection = { ...connection, gatewayURL: replacement.url };
          await Promise.all([previous !== replacement ? dispose(previous) : null, ...businesses.map(p => p.then(dispose, () => {}))]);
          if (!live()) return;
        }
        onRecovery({ action: "restored", attempt: recovery.attempt, durationMs: Date.now() - recovery.startedAt });
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
        const delayMs = RECOVERY_DELAYS_MS[Math.min(recovery.attempt - 1, RECOVERY_DELAYS_MS.length - 1)];
        recovery.nextRetryAt = Date.now() + delayMs;
        onRecovery({ action: "waiting", attempt: recovery.attempt, delayMs, errorCode: error.code || error.message });
        emit();
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
        const disrupted = ["recovering", "unavailable"].includes(state.phase) || lostPeer;
        // Peer/control status is advisory: an existing data path may still work.
        // Confirm health before interrupting app views or announcing an outage.
        if (disrupted && !recovery && !healthController) scheduleHealthCheck(epoch, 0);
        phase = recovery ? "recovering" : "ready";
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
    const stopping = measure("box.cleanup", () => disconnect());
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
      const endpoint = await measure("box.endpoint", () => network.resolveEndpoint(input));
      if (attempt !== epoch || closed) return snapshot();
      const controller = new AbortController();
      pendingProbe = controller;
      await measure("box.health", () => probe(endpoint.url, {
        signal: controller.signal,
        agent: endpoint.agent,
      }));
      if (attempt !== epoch || closed) return snapshot();
      if (createSession) {
        platformSession = await measure("box.session", () => createSession({
          url: endpoint.url,
          agent: endpoint.agent,
          signal: controller.signal,
        }));
        if (attempt !== epoch || closed) {
          await platformSession.close();
          return snapshot();
        }
      }
      created = await measure("box.gateway", () => createGateway({
        deviceId: input.deviceId,
        targetURL: endpoint.url,
        agent: endpoint.agent,
        session: platformSession,
      }));
      pendingProbe = null;
      if (attempt !== epoch || closed) {
        await dispose(created);
        return snapshot();
      }
      gateway = created;
      activeEndpoint = endpoint;
      activeSessionFactory = createSession;
      boxSession = platformSession;
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
      return recoverOnFailure(() => gateway.request(input));
    },
    async openWebSocket(input) {
      if (closed || !gateway) throw new Error("SESSION_CLOSED");
      return recoverOnFailure(() => gateway.openWebSocket(input));
    },
    applicationConnection(applicationId, options) {
      const selectedProduct = validateApplicationConnectionOptions(options)?.backendProductId;
      if (closed || !gateway) throw new Error("SESSION_CLOSED");
      const lease = gateway;
      const applicationScope = selectedProduct === "wanx" ? undefined : selectedProduct || (applicationId === "centaurai.wanx.superadvisors" ? "super-advisory" : undefined);
      const assertLive = () => { if (closed || gateway !== lease) throw new Error("SESSION_CLOSED"); };
      return {
        request: (input) => { assertLive(); return recoverOnFailure(() => lease.request({ ...input, applicationScope, applicationExchange: false })); },
        async businessRequest(service, input) {
          assertLive();
          // Fixed first-party service on this exact peer. Callers cannot choose
          // another host, port or unrelated API; credentials stay in main.
          if (service !== "clipboard" || selectedProduct || applicationId ||
              typeof input?.path !== "string" || !/^\/api\/clipboard\/v1(?:\/|\?|$)/.test(input.path) ||
              /[\\#\x00-\x1f]/.test(input.path) || /(?:^|\/)\.{1,2}(?:\/|\?|$)/.test(input.path) || /%2e|%2f|%5c/i.test(input.path))
            throw Object.assign(new Error("BUSINESS_SERVICE_SCOPE"), { code: "BUSINESS_SERVICE_SCOPE" });
          // Platform boxes expose business routes through their authenticated
          // ingress. A second peer port is not part of the granted P2P route.
          if (boxSession) {
            const result = await lease.request({ ...input, applicationScope: undefined, applicationExchange: false });
            assertLive();
            return result;
          }
          if (!businessGateways.has(service)) {
            const destination = new URL(connection.url); destination.port = "8092";
            const mode = connection.mode, parent = boxSession, deviceId = connection.deviceId;
            const pending = (async () => {
              const endpoint = await network.resolveEndpoint({ url: destination.origin, mode });
              assertLive();
              const child = await createGateway({ deviceId, targetURL: endpoint.url, agent: endpoint.agent,
                session: parent ? { getToken: () => parent.getToken(), close() {}, applicationExchangePath: parent.applicationExchangePath } : undefined,
                businessService: service });
              if (closed || gateway !== lease) { await child.close(); throw new Error("SESSION_CLOSED"); }
              return child;
            })();
            businessGateways.set(service, pending);
            pending.catch(() => { if (businessGateways.get(service) === pending) businessGateways.delete(service); });
          }
          const child = await businessGateways.get(service);
          assertLive();
          const result = await child.request(input);
          assertLive();
          return result;
        },
        openStream: (input) => { assertLive(); return recoverOnFailure(() => lease.openWebSocket({ ...input, applicationScope })); },
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
      if (connection && !healthController) await checkHealth(epoch);
      return snapshot();
    },
    async retryConnection() {
      if (closed || !connection) return snapshot();
      clearTimeout(healthTimer);
      await checkHealth(epoch);
      return snapshot();
    },
    recoverSession() {
      return requestRecovery();
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
