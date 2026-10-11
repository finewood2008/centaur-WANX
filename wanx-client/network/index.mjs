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
  return {
    enabled: true,
    phase: ready ? "ready" : "unavailable",
    reason: ready ? null : "network_unavailable",
    peers: ready ? peers : [],
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
  pollIntervalMs = 15_000,
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
        },
      });
    }
    return engine;
  }
  const schedule = () => {
    stopTimer();
    if (state.enabled && proxy && !closed) {
      timer = setTimeout(() => {
        void refresh();
      }, pollIntervalMs);
      timer.unref?.();
    }
  };
  async function start(sidecar, generation, extra = {}) {
    const result = await sidecar.request("start", { ...baseParams, ...extra });
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
    clearAgents();
    proxy = { port: result.proxy.port, token: result.proxy.token };
    publish(next);
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
        if (next.phase !== "ready") clearAgents();
        else {
          for (const [url, agent] of agents) {
            const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
            if (
              !next.peers.some((peer) => peer.ip === host && peer.connected)
            ) {
              agent.destroy();
              agents.delete(url);
            }
          }
        }
        publish(next);
      }
    });
  }
  async function setEnabled(enabled) {
    if (typeof enabled !== "boolean")
      throw new TypeError("enabled must be boolean");
    if (closed) throw failure("network_closed");
    if (!enabled) {
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
    if (next.phase !== "ready" || !proxy)
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
    login,
    enroll,
    resolveEndpoint,
    close,
  };
}
