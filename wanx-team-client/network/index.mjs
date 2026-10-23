import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { createSidecar as defaultCreateSidecar } from "./sidecar.mjs";
import { createTunnelAgent } from "./tunnel.mjs";

const failure = (code) => Object.assign(new Error(code), { code });
const knownErrors = new Set([
  "engine_missing",
  "engine_unavailable",
  "engine_exited",
  "engine_timeout",
  "engine_protocol_error",
  "auth_required",
  "auth_unsupported",
  "auth_failed",
  "auth_expired",
  "start_failed",
  "invalid_status",
  "network_unavailable",
]);
function canonicalIP(value) {
  if (typeof value !== "string" || value.includes("%")) return null;
  const [address, prefix, extra] = value.split("/");
  const family = isIP(address);
  if (!family || extra !== undefined) return null;
  if (
    prefix !== undefined &&
    (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128))
  )
    return null;
  return family === 6
    ? new URL(`http://[${address}]`).hostname.slice(1, -1)
    : address;
}

function normalizeURL(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\s\\?#@]/.test(value) ||
    !/^https?:\/\/[^/]+\/?$/i.test(value)
  ) {
    throw failure("invalid_endpoint");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw failure("invalid_endpoint");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.port === "0"
  )
    throw failure("invalid_endpoint");
  return url;
}

function parseStatus(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.peers))
    throw failure("invalid_status");
  const peers = data.peers.flatMap((peer) => {
    const ip = canonicalIP(peer?.ip);
    if (!ip) return [];
    const name =
      typeof peer.name === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,252}$/.test(peer.name)
        ? peer.name
        : ip;
    return [{ ip, name, connected: peer.connected === true }];
  });
  const ready = data.phase === "ready";
  const recovering = data.phase === "recovering";
  return {
    enabled: true,
    phase: ready ? "ready" : recovering ? "recovering" : "unavailable",
    reason: ready ? null : "network_unavailable",
    peers: ready || recovering ? peers : [],
  };
}

/** App-owned embedded engine. Disabled mode never starts a child process. */
export function createNetwork({
  binaryPath = fileURLToPath(
    new URL(
      `../native/bin/wanx-netbird-${process.platform}-${process.arch}${
        process.platform === "win32" ? ".exe" : ""
      }`,
      import.meta.url,
    ),
  ),
  configDir,
  managementURL = "https://p2p.qeeshu.com",
  deviceName = "wanx-client",
  createSidecar = defaultCreateSidecar,
  // Local IPC reads the engine's cached state; this does not poll the platform.
  // Keep interface changes from adding up to 15 seconds of stale UI state.
  pollIntervalMs = 1_000,
} = {}) {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0)
    throw new TypeError("pollIntervalMs must be positive");
  let state = { enabled: false, phase: "disabled", reason: null, peers: [] };
  let epoch = 0;
  let pending = null;
  let timer = null;
  let closed = false;
  let engine = null;
  let proxy = null;
  let recovery = null;
  let recoveryRequired = false;
  let retryAfter = 0;
  let degradedSince = null;
  let recoveryDelay = 5000;
  let restartDelay = 5000;
  let closePromise;
  const closing = new Set();
  const agents = new Map();
  const listeners = new Set();
  const baseParams = { managementURL, configDir, deviceName };
  const snapshot = () => ({
    ...state,
    peers: state.peers.map((peer) => ({ ...peer })),
    ...(state.authorization
      ? { authorization: { ...state.authorization } }
      : {}),
  });
  const publish = (next) => {
    // Fast status reads must not rebuild the control UI when nothing changed.
    if (JSON.stringify(state) === JSON.stringify(next)) return;
    state = next;
    for (const listener of listeners) listener(snapshot());
  };
  const clearAgents = () => {
    for (const agent of agents.values()) agent.destroy();
    agents.clear();
  };
  const stopTimer = () => {
    clearTimeout(timer);
    timer = null;
  };
  const dispose = () => {
    clearAgents();
    proxy = null;
    recoveryRequired = false;
    degradedSince = null;
    retryAfter = 0;
    recoveryDelay = 5000;
    const previous = engine;
    engine = null;
    if (!previous) return Promise.resolve();
    const cleanup = Promise.resolve(previous.close());
    closing.add(cleanup);
    cleanup.finally(() => closing.delete(cleanup));
    return cleanup;
  };
  const current = (generation) =>
    generation === epoch && state.enabled && !closed;
  const failed = (error) => {
    const code = knownErrors.has(error?.code)
      ? error.code
      : "engine_unavailable";
    clearAgents();
    proxy = null;
    publish({
      enabled: true,
      phase: code === "auth_required" ? "auth_required" : "unavailable",
      reason: code,
      peers: [],
    });
  };
  function getEngine(generation) {
    if (!engine) {
      engine = createSidecar({
        binaryPath,
        onFailure(code) {
          if (!current(generation)) return;
          epoch += 1;
          stopTimer();
          dispose();
          pending = null;
          failed(failure(code));
          schedule();
        },
      });
    }
    return engine;
  }
  const schedule = () => {
    stopTimer();
    const restart = !proxy && state.phase === "unavailable" &&
      ["start_failed", "network_unavailable", "engine_timeout", "engine_exited", "engine_unavailable"].includes(state.reason);
    if (state.enabled && (proxy || restart) && !closed) {
      timer = setTimeout(() => {
        void refresh();
      }, restart ? restartDelay : pollIntervalMs);
      if (restart) restartDelay = Math.min(restartDelay * 2, 60_000);
      timer.unref?.();
    }
  };
  function acceptStart(result, generation, preserveAgents = false) {
    if (!current(generation)) return;
    if (
      !result?.proxy ||
      !Number.isInteger(result.proxy.port) ||
      result.proxy.port < 1 ||
      result.proxy.port > 65535 ||
      typeof result.proxy.token !== "string" ||
      !/^[A-Za-z0-9_=-]{16,512}$/.test(result.proxy.token)
    )
      throw failure("invalid_status");
    const next = parseStatus(result.status);
    if (!preserveAgents) clearAgents();
    else if (proxy.port !== result.proxy.port || proxy.token !== result.proxy.token)
      throw failure("invalid_status");
    proxy = { port: result.proxy.port, token: result.proxy.token };
    restartDelay = 5000;
    publish(next);
    observeRecovery(next);
  }
  function observeRecovery(next) {
    if (next.phase === "ready") {
      recoveryRequired = false;
      degradedSince = null;
      retryAfter = 0;
      recoveryDelay = 5000;
    } else if (next.phase === "recovering") degradedSince ??= Date.now();
  }
  function retryRecovery() {
    retryAfter = Date.now() + recoveryDelay;
    recoveryDelay = Math.min(recoveryDelay * 2, 60_000);
  }
  async function start(sidecar, generation, extra = {}) {
    acceptStart(await sidecar.request("start", { ...baseParams, ...extra }), generation);
  }
  async function recoverEngine(sidecar, generation) {
    recoveryRequired = true;
    for (const agent of agents.values()) agent.resetConnections();
    publish({ ...state, phase: "recovering", reason: "network_unavailable" });
    try {
      acceptStart(await sidecar.request("recover"), generation, true);
      if (current(generation) && state.phase !== "ready") retryRecovery();
    } catch (error) {
      if (!current(generation)) return;
      if (!["start_failed", "network_unavailable"].includes(error.code)) throw error;
      retryRecovery();
      publish({ ...state, phase: "recovering", reason: "network_unavailable" });
    }
  }
  function networkChanged() {
    if (closed || !state.enabled) return Promise.resolve(snapshot());
    if (recovery) return recovery;
    const generation = epoch;
    const operation = (async () => {
      // Let an existing status/start request settle before scheduling recovery.
      if (pending) await pending;
      if (!current(generation) || !proxy) return snapshot();
      // If every active target still accepts a fresh connection, a switch did
      // not invalidate the data path. Keep healthy streams and engine intact.
      const targets = [...agents.values()];
      if (targets.length && !recoveryRequired) {
        const reachable = await Promise.all(targets.map((agent) => agent.probe()));
        if (!current(generation)) return snapshot();
        if (reachable.every(Boolean)) return refresh();
      }
      while (pending) await pending;
      if (!current(generation) || !proxy) return snapshot();
      return run(recoverEngine);
    })().finally(() => { if (recovery === operation) recovery = null; });
    recovery = operation;
    return operation;
  }
  function run(action) {
    if (pending) return pending;
    const generation = epoch;
    stopTimer();
    const operation = Promise.resolve()
      .then(async () => {
        if (!current(generation)) return snapshot();
        try {
          // A stopped engine still owns its identity files until process exit.
          // Keep the UI responsive, but never spawn a replacement concurrently.
          while (closing.size) {
            await Promise.all([...closing]);
            if (!current(generation)) return snapshot();
          }
          if (!current(generation)) return snapshot();
          await action(getEngine(generation), generation);
        } catch (error) {
          if (current(generation)) failed(error);
        }
        return snapshot();
      })
      .finally(() => {
        if (pending === operation) {
          pending = null;
          schedule();
        }
      });
    pending = operation;
    return operation;
  }
  function refresh() {
    if (!state.enabled || closed) return Promise.resolve(snapshot());
    return run(async (sidecar, generation) => {
      if (!proxy) return start(sidecar, generation);
      const next = parseStatus(await sidecar.request("status"));
      if (current(generation)) {
        observeRecovery(next);
        if (!["ready", "recovering"].includes(next.phase)) clearAgents();
        else if (next.phase === "ready") {
          for (const [url, agent] of agents) {
            const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
            if (
              !next.peers.some((peer) => peer.ip === host && peer.connected) &&
              state.peers.some((peer) => peer.ip === host && peer.connected)
            ) {
              agent.resetConnections();
            }
          }
        }
        publish(next);
        // Give the SDK's own reconnect loop time to repair transient control
        // outages. A healthy box path must not be interrupted by a status-only
        // failure, nor should one offline box restart all other connections.
        if (next.phase === "recovering" && Date.now() >= retryAfter &&
            (recoveryRequired || Date.now() - degradedSince >= 20_000)) {
          const reachable = await Promise.all([...agents.values()].map(agent => agent.probe()));
          if (!current(generation)) return;
          if (reachable.some(Boolean)) retryAfter = Date.now() + 20_000;
          else await recoverEngine(sidecar, generation);
        }
      }
    });
  }
  async function setEnabled(enabled) {
    if (typeof enabled !== "boolean")
      throw new TypeError("enabled must be boolean");
    if (closed) throw failure("network_closed");
    if (!enabled) {
      restartDelay = 5000;
      epoch += 1;
      stopTimer();
      pending = null;
      const cleanup = dispose();
      publish({ enabled: false, phase: "disabled", reason: null, peers: [] });
      await cleanup;
      return snapshot();
    }
    if (!state.enabled) {
      epoch += 1;
      publish({ enabled: true, phase: "checking", reason: null, peers: [] });
    }
    return refresh();
  }
  function requireEnabled() {
    if (closed) throw failure("network_closed");
    if (!state.enabled) throw failure("network_disabled");
    if (pending) throw failure("network_busy");
  }
  async function login() {
    requireEnabled();
    return run(async (sidecar, generation) => {
      clearAgents();
      proxy = null;
      publish({ enabled: true, phase: "authorizing", reason: null, peers: [] });
      const auth = await sidecar.request("login_begin", baseParams);
      if (!current(generation)) return;
      let verificationURL;
      try {
        verificationURL = new URL(auth.verificationURL);
      } catch {
        throw failure("invalid_status");
      }
      if (
        verificationURL.protocol !== "https:" ||
        verificationURL.username ||
        verificationURL.password ||
        typeof auth.userCode !== "string" ||
        auth.userCode.length > 128 ||
        !Number.isFinite(auth.expiresIn) ||
        auth.expiresIn <= 0 ||
        auth.expiresIn > 3600
      )
        throw failure("invalid_status");
      publish({
        enabled: true,
        phase: "authorizing",
        reason: null,
        peers: [],
        authorization: {
          verificationURL: verificationURL.href,
          userCode: auth.userCode,
          expiresIn: auth.expiresIn,
        },
      });
      await sidecar.request(
        "login_wait",
        {},
        { timeoutMs: (auth.expiresIn + 5) * 1000 },
      );
      if (current(generation)) await start(sidecar, generation);
    });
  }
  async function enroll({ setupKey } = {}) {
    requireEnabled();
    if (
      typeof setupKey !== "string" ||
      setupKey.length < 1 ||
      setupKey.length > 512 ||
      /[\r\n]/.test(setupKey)
    )
      throw failure("invalid_setup_key");
    return run(async (sidecar, generation) => {
      clearAgents();
      proxy = null;
      publish({ enabled: true, phase: "checking", reason: null, peers: [] });
      await start(sidecar, generation, { setupKey });
    });
  }
  async function resolveEndpoint({ url: value, mode }) {
    if (closed) throw failure("network_closed");
    const url = normalizeURL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (mode === "direct") {
      if (
        url.protocol === "http:" &&
        !["localhost", "127.0.0.1", "::1"].includes(host)
      )
        throw failure("direct_https_required");
      return { url: url.origin, mode };
    }
    if (mode !== "netbird") throw failure("invalid_network_mode");
    if (!state.enabled) throw failure("network_disabled");
    // URL parsing canonicalizes short/hex IPv4 and IPv4-mapped IPv6 forms.
    // A local address cannot identify the remote box in the private network.
    if (
      ["localhost", "localhost.", "::1", "::", "0.0.0.0"].includes(host) ||
      host.endsWith(".localhost") ||
      /^127\./.test(host) ||
      /^::ffff:(?:7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)$/.test(host)
    )
      throw failure("p2p_loopback_address");
    if (!isIP(host)) throw failure("netbird_ip_required");
    const generation = epoch;
    const next = await refresh();
    if (!current(generation)) throw failure("network_disabled");
    if (!["ready", "recovering"].includes(next.phase) || !proxy)
      throw failure(next.reason || "network_unavailable");
    const peer = next.peers.find((candidate) => candidate.ip === host);
    if (!peer) throw failure("netbird_peer_unknown");
    if (!peer.connected) throw failure("netbird_peer_disconnected");
    if (!agents.has(url.origin))
      agents.set(url.origin, createTunnelAgent({ url: url.origin, proxy }));
    return { url: url.origin, mode, peer, agent: agents.get(url.origin) };
  }
  function close() {
    if (closed) return closePromise;
    epoch += 1;
    closed = true;
    stopTimer();
    pending = null;
    dispose();
    publish({ enabled: false, phase: "disabled", reason: null, peers: [] });
    listeners.clear();
    closePromise = Promise.all([...closing]).then(() => undefined);
    return closePromise;
  }
  return {
    snapshot,
    subscribe(listener) {
      if (closed) throw failure("network_closed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setEnabled,
    refresh,
    networkChanged,
    login,
    enroll,
    resolveEndpoint,
    close,
  };
}
