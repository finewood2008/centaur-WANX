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
  let unsubscribeSession, unsubscribeRenewal, renewalController;
  let renewalDone = null;
  let activeLocalTrust;
  const localConnections = new Set();
  const businessGateways = new Map();
  const listeners = new Set();
  const closing = new Set();
  const connecting = new Set();
  const healthChecks = new Set();

  function snapshot() {
    let selected = connection;
    if (boxSession?.kind === 'local-trust-v1' && connection) {
      try { selected = { ...connection, dataContext: boxSession.context() }; } catch { selected = null; }
    }
    return structuredClone({
      network: network.snapshot(),
      phase,
      connection: selected,
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
    const previousTrust = activeLocalTrust; activeLocalTrust = null;
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
    const businesses = [...businessGateways.values()];
    businessGateways.clear();
    unsubscribeSession?.(); unsubscribeSession = null;
    unsubscribeRenewal?.(); unsubscribeRenewal = null;
    renewalController?.abort(); renewalController = null;
    for (const entry of [...localConnections]) entry.end(nextReason || 'LOCAL_DATA_SESSION_CLOSED');
    boxSession = null;
    gateway = null;
    connection = null;
    pendingMode = null;
    phase = "disconnected";
    reason = nextReason;
    emit();
    await Promise.all([dispose(previous), ...businesses.map(p => p.then(dispose, () => {}))]);
    if (previousTrust) network.releaseLocalDataEndpoints?.(previousTrust.scope);
    return snapshot();
  }

  function watchDataSession(session, generation) {
    unsubscribeSession?.(); unsubscribeRenewal?.();
    unsubscribeSession = session.onInvalidated((code) => { if (boxSession === session) void disconnect(code || 'LOCAL_DATA_SESSION_CLOSED'); });
    unsubscribeRenewal = session.onRenewalNeeded?.(() => { void renewDataSession(session, generation); });
  }

  async function renewDataSession(previousSession, generation) {
    if (closed || generation !== epoch || boxSession !== previousSession || renewalController) return;
    const controller = new AbortController(); renewalController = controller;
    let finishRenewal;
    const settled = new Promise(resolve => { finishRenewal = resolve; }); renewalDone = settled;
    // New launches wait for this rotation before acquiring a session. Existing
    // pending launches are included, and closed launches are dropped below.
    const entries = [...localConnections];
    const candidates = new Map();
    let next, replacement, installed = false;
    const current = () => !closed && generation === epoch && boxSession === previousSession && !controller.signal.aborted;
    try {
      next = await previousSession.renew({ signal: controller.signal });
      if (!current()) return;
      for (const entry of entries) {
        if (entry.ended) continue;
        try { await entry.ready; } catch (error) { if (entry.ended) continue; throw error; }
        if (!current()) return;
        if (entry.ended) continue;
        const candidate = entry.applicationId ? await entry.current.renew({ parentSession: next }) : next;
        if (entry.ended) { if (candidate !== next) candidate.close(); continue; }
        candidates.set(entry, candidate);
      }
      replacement = await createGateway({ deviceId: connection.deviceId, targetURL: activeEndpoint.url, agent: activeEndpoint.agent, session: next });
      if (!current()) return;
      for (const [entry, candidate] of candidates) {
        if (entry.ended) { if (candidate !== next) candidate.close(); candidates.delete(entry); }
        else if (!entry.current.isLive() || !candidate.isLive()) throw Object.assign(new Error('LOCAL_DATA_CONTEXT_CHANGED'), { code: 'LOCAL_DATA_CONTEXT_CHANGED' });
      }
      const previous = gateway, businesses = [...businessGateways.values()]; businessGateways.clear();
      unsubscribeSession?.(); unsubscribeRenewal?.();
      gateway = replacement; boxSession = next; installed = true;
      connection = { ...connection, gatewayURL: replacement.url, dataContext: next.context() };
      // This synchronous publication changes every retained launch only after
      // every fresh child independently passed its exact authority ceiling.
      for (const [entry, candidate] of candidates) entry.attach(candidate);
      watchDataSession(next, generation); reason = null; emit();
      // Closing the old channel aborts old streams. Stable Host wrappers remain
      // live, so SDKs reconnect with fresh proofs and never inherit old keys.
      await Promise.all([dispose(previous), ...businesses.map(p => p.then(dispose, () => {}))]);
    } catch (error) {
      if (current() && ['LOCAL_DATA_CONTEXT_CHANGED', 'LOCAL_DATA_FORBIDDEN', 'LOCAL_DATA_REQUIRED',
        'LOCAL_DATA_AUTHORITY_UNAVAILABLE', 'LOCAL_DATA_CLOCK_ROLLBACK', 'LOCAL_DATA_SCOPE_DENIED',
        'LOCAL_DATA_CAPABILITY_REQUIRED'].includes(error.code)) await disconnect(error.code);
      // Other creation failures never extend or resurrect the old lease. Its
      // existing watchdog still closes it at the original hard deadline.
    } finally {
      if (!installed) { if (replacement) await dispose(replacement); else next?.close(); }
      if (renewalController === controller) renewalController = null;
      if (renewalDone === settled) renewalDone = null;
      finishRenewal();
    }
  }

  function scheduleHealthCheck(generation, delayMs = HEALTH_INTERVAL_MS) {
    // Local sessions have signed one-second heartbeats and an active watchdog.
    // The legacy unauthenticated/CA health probe is not a second trust path.
    if (boxSession?.kind === "local-trust-v1") return;
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
        let endpoint;
        try {
          endpoint = await network.resolveEndpoint(connection);
          if (!live()) return;
          await check(endpoint);
        } catch (error) {
          if (!live()) return;
          // Let a restarting engine receive its peer map before asking it to
          // restart again. A healthy endpoint needs no engine recovery at all.
          if (connection.mode !== "netbird" || ["netbird_peer_unknown", "netbird_peer_disconnected"].includes(error.code || error.message)) throw error;
          await network.networkChanged();
          if (!live()) return;
          endpoint = await network.resolveEndpoint(connection);
          if (!live()) return;
          await check(endpoint);
        }
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
          const businesses = [...businessGateways.values()];
          businessGateways.clear();
          gateway = replacement;
          boxSession = session;
          activeEndpoint = endpoint;
          connection = { ...connection, gatewayURL: replacement.url };
          await Promise.all([dispose(previous), ...businesses.map(p => p.then(dispose, () => {}))]);
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
        // Peer/control status is advisory: an existing data path may still work.
        // Confirm health before interrupting app views or announcing an outage.
        const disrupted = ["recovering", "unavailable"].includes(state.phase) || lostPeer;
        if (disrupted && !recovery && !healthController) scheduleHealthCheck(epoch, 0);
        phase = recovery ? "recovering" : "ready";
        reason = phase === "recovering" ? "network_unavailable" : null;
      }
    }
    emit();
  });

  async function connect(input, { createSession, localTrust } = {}) {
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
    const connectionTrust = localTrust ? { ...localTrust, scope: `${localTrust.scope}:${attempt}` } : undefined;
    phase = "connecting";
    pendingMode = input.mode;
    emit();
    let created;
    let platformSession;
    try {
      const endpoint = await measure("box.endpoint", () => connectionTrust
        ? network.resolveLocalDataEndpoint(input, connectionTrust) : network.resolveEndpoint(input));
      if (attempt !== epoch || closed) { if (connectionTrust) network.releaseLocalDataEndpoints?.(connectionTrust.scope); return snapshot(); }
      const controller = new AbortController();
      pendingProbe = controller;
      if (!localTrust) await measure("box.health", () => probe(endpoint.url, {
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
      activeLocalTrust = connectionTrust;
      activeSessionFactory = createSession;
      boxSession = platformSession;
      connection = {
        deviceId: input.deviceId,
        name: input.name || input.deviceId,
        url: endpoint.url,
        mode: input.mode,
        gatewayURL: created.url,
        ...(platformSession?.kind === "local-trust-v1" ? {
          authorization: "local-trust-v1", route: input.mode === "netbird" ? "p2p" : "lan",
          dataContext: platformSession.context(),
        } : {}),
      };
      pendingMode = null;
      phase = "ready";
      reason = null;
      if (platformSession?.kind === 'local-trust-v1') watchDataSession(platformSession, attempt);
      scheduleHealthCheck(attempt);
      emit();
      return snapshot();
    } catch (error) {
      if (connectionTrust && activeLocalTrust !== connectionTrust) network.releaseLocalDataEndpoints?.(connectionTrust.scope);
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
      if (boxSession?.kind === "local-trust-v1") {
        if (closed || !gateway) throw new Error("SESSION_CLOSED");
        // Server caps each binding at 32 channels. Reserve room for a complete
        // independently authorized replacement batch and concurrent control.
        if (applicationId && [...localConnections].filter(entry => entry.applicationId && !entry.ended).length >= 14)
          throw Object.assign(new Error('LOCAL_DATA_CAPACITY'), { code: 'LOCAL_DATA_CAPACITY' });
        const generation = epoch, pendingRotation = renewalDone;
        const unavailable = () => Object.assign(new Error('LOCAL_DATA_SESSION_CLOSED'), { code: 'LOCAL_DATA_SESSION_CLOSED' });
        const entry = { applicationId, current: null, ended: false, listeners: new Set(), unwatch: null,
          end(code = 'LOCAL_DATA_SESSION_CLOSED') {
            if (entry.ended) return;
            entry.ended = true; entry.unwatch?.(); entry.unwatch = null; localConnections.delete(entry);
            if (applicationId) entry.current?.close();
            for (const listener of entry.listeners) { try { listener(code); } catch {} }
            entry.listeners.clear();
          },
          attach(session) {
            entry.unwatch?.(); entry.current = session;
            entry.unwatch = session.onInvalidated(code => { if (entry.current === session) entry.end(code); });
          },
        };
        localConnections.add(entry);
        const assertLive = () => {
          if (entry.ended || closed || epoch !== generation || !gateway || !boxSession?.isLive()) throw unavailable();
        };
        entry.ready = (async () => {
          if (pendingRotation) await pendingRotation;
          assertLive();
          const parent = boxSession;
          const selected = applicationId ? await parent.deriveApplication({ applicationId, launchId: options?.launchId, capabilities: options?.capabilities }) : parent;
          try { assertLive(); entry.attach(selected); return selected; }
          catch (error) { if (applicationId) selected.close(); throw error; }
        })();
        // Avoid an unhandled rejection if an app closes before asking context.
        entry.ready.catch(error => entry.end(error.code));
        const use = async operation => {
          assertLive(); await entry.ready; assertLive(); const selected = entry.current;
          const result = await operation(selected);
          try { assertLive(); if (entry.current !== selected) throw unavailable(); }
          catch (error) { result?.body?.destroy?.(); result?.terminate?.(); throw error; }
          return result;
        };
        return {
          kind: 'local-trust-v1',
          localContext: () => use(child => child.context()),
          currentLocalContext() { assertLive(); if (!entry.current) throw unavailable(); return entry.current.context(); },
          request: input => use(child => child.request(input)),
          openStream: input => use(child => child.openWebSocket(input)),
          businessRequest: (service, input) => {
            if (applicationId || service !== "clipboard" || !/^\/api\/clipboard\/v1(?:\/|\?|$)/.test(input?.path || ""))
              throw Object.assign(new Error("BUSINESS_SERVICE_SCOPE"), { code: "BUSINESS_SERVICE_SCOPE" });
            return use(child => child.request(input));
          },
          close: () => entry.end(),
          onInvalidated(listener) {
            if (entry.ended) { listener('LOCAL_DATA_SESSION_CLOSED'); return () => {}; }
            entry.listeners.add(listener); return () => entry.listeners.delete(listener);
          },
        };
      }
      const selectedProduct = validateApplicationConnectionOptions(options)?.backendProductId;
      if (closed || !gateway) throw new Error("SESSION_CLOSED");
      const lease = gateway;
      const applicationScope = selectedProduct === "wanx" ? undefined : selectedProduct || (applicationId === "centaurai.wanx.superadvisors" ? "super-advisory" : undefined);
      const assertLive = () => { if (closed || gateway !== lease) throw new Error("SESSION_CLOSED"); };
      return {
        request: (input) => { assertLive(); return lease.request({ ...input, applicationScope, applicationExchange: false }); },
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
