import { createNetwork } from "./network/index.mjs";
import { createDashboardGateway } from "./octop/gateway.mjs";
import { probeEndpoint } from "./octop/probe.mjs";

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
  const listeners = new Set();
  const closing = new Set();
  const connecting = new Set();

  function snapshot() {
    return structuredClone({
      network: network.snapshot(),
      phase,
      connection,
      reason,
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

  const unsubscribe = network.subscribe((state) => {
    if (closed) return;
    if (connection?.mode === "netbird" || pendingMode === "netbird") {
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
        ["unavailable", "auth_required"].includes(state.phase) ||
        lostPeer
      ) {
        // Invalidate synchronously; a delayed connect must not resurrect this session.
        void disconnect(
          state.enabled ? "network_unavailable" : "network_disabled",
        );
        return;
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
      await Promise.allSettled([...connecting]);
      await Promise.allSettled([...closing]);
      listeners.clear();
    },
  };
}
