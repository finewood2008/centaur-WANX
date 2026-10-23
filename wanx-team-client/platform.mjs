import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createPlatformSession } from "./octop/platform.mjs";
import { validateApplicationConnectionOptions } from "./applications/backend-scope.mjs";

const fail = (code) => Object.assign(new Error(code), { code });
const safeReason = (error) =>
  /^[A-Z][A-Z0-9_]{1,80}$/.test(error?.code || "")
    ? error.code
    : "NETWORK_UNAVAILABLE";
const validID = (value) =>
  typeof value === "string" && /^[\w-]{1,128}$/.test(value);
const validDeviceID = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9._-]{1,36}$/.test(value) &&
  value !== "." &&
  value !== "..";

/** Consumer authority owns enrollment and box selection. All credentials stay in main. */
export function createPlatformClient({
  account,
  createTransport,
  createSession = createPlatformSession,
  localBoxes,
  creditsServiceURL = "",
  managementURL = "https://p2p.qeeshu.com",
  readPreference = async () => true,
  writePreference = async () => {},
  renewIntervalMs = 60_000,
  pollIntervalMs = 500,
  pollAttempts = 60,
  resumeStore,
  measure = (_step, operation) => operation(),
} = {}) {
  let enabled = true;
  let transport = null,
    transportKey = null,
    unsubscribeTransport;
  let networkSession = null;
  let directTransport = null,
    unsubscribeDirect,
    activeLink = null;
  let localDevices = [], activeLocalDeviceId = null;
  let devices = [],
    boxes = [];
  let directory = { phase: "idle", reason: null };
  let directoryRevision = 0,
    prepareNeeded = true;
  let authorizationTimer, authorizationController, authorizationWork;
  let authorizationDeadline = 0;
  let authorizationEndpointsPending = false;
  let platform = { phase: "idle", reason: null };
  let epoch = 0,
    closed = false,
    timer,
    leaseTimer,
    activeController;
  let connectionEpoch = 0,
    selectionController;
  let switching = Promise.resolve(),
    activeWork = null;
  let refreshWork = null;
  let resumeHint = null;
  let retryActivation = false;
  let reconnectTarget = null;
  let retryDelay = 5000;
  let resumeWrites = Promise.resolve();
  const persistResume = (value) => {
    resumeHint = value;
    // Serialize writes with logout/identity invalidation. This is only a startup
    // hint, never an authorization snapshot or a reusable enrollment secret.
    resumeWrites = resumeWrites
      .catch(() => {})
      .then(() => (value ? resumeStore?.save(value) : resumeStore?.clear()))
      .catch(() => {});
    return resumeWrites;
  };
  const usableLease = () =>
    Boolean(
      networkSession && networkSession.leaseExpiresAt * 1000 > Date.now(),
    );
  const transientError = (error) =>
    error.retryable === true ||
    error.code === "ACCOUNT_NETWORK_ERROR" ||
    error.status === 429 ||
    (error.status >= 500 && error.status < 600);
  function validResume(value, identity) {
    return (
      value?.version === 1 &&
      value.accountId === identity.accountId &&
      value.clientId === identity.clientId &&
      value.managementURL === managementURL &&
      validID(value.networkSessionId)
    );
  }
  const draining = new Set(),
    listeners = new Set();
  const empty = () => ({
    phase: "disconnected",
    connection: null,
    reason: null,
  });
  const snapshot = () => {
    const connection = activeLink?.client.snapshot() || empty();
    if (activeLink === directTransport && activeLocalDeviceId && connection.connection?.deviceId === activeLocalDeviceId)
      connection.connection = { ...connection.connection, mode: "local" };
    const signedIn = account.snapshot().phase === "authenticated";
    const transportNetwork = transport?.network.snapshot();
    const network = !enabled
      ? { phase: "disabled", reason: null }
      : !signedIn
      ? { phase: "auth_required", reason: null }
      : platform.phase === "enrolling"
      ? { phase: "checking", reason: null }
      : platform.phase === "unavailable"
      ? { phase: "unavailable", reason: platform.reason }
      : transportNetwork || { phase: "checking", reason: null };
    return structuredClone({
      ...connection,
      account: account.snapshot(),
      devices: [...(signedIn ? localDevices : []), ...boxes.filter(box => !localDevices.some(local => local.deviceId === box.deviceId)).map((box) => {
        const endpoint = devices.find((item) => item.deviceId === box.deviceId);
        const host =
          endpoint &&
          new URL(endpoint.serviceUrl).hostname.replace(/^\[|\]$/g, "");
        const networkReady = Boolean(
          host &&
            ["ready", "recovering"].includes(transportNetwork?.phase) &&
            transportNetwork.peers.some(
              (peer) => peer.ip === host && peer.connected,
            ),
        );
        return {
          ...box,
          networkReady,
          canOpen: Boolean(
            enabled &&
              usableLease() &&
              networkReady &&
              platform.phase === "ready" &&
              directory.phase === "ready" &&
              box.accessState === "ready" &&
              endpoint,
          ),
        };
      })],
      directory,
      platform,
      network: { ...network, enabled, peers: [] },
    });
  };
  const emit = () => {
    const value = snapshot();
    for (const listener of listeners) listener(value);
    return value;
  };
  const current = (generation) => !closed && generation === epoch;
  const assertCurrent = (generation) => {
    if (!current(generation)) throw fail("NETWORK_CANCELLED");
  };
  function stopAuthorizationPolling({ reset = false } = {}) {
    clearTimeout(authorizationTimer);
    authorizationTimer = null;
    authorizationController?.abort();
    authorizationController = null;
    authorizationWork = null;
    if (reset) {
      authorizationDeadline = 0;
      authorizationEndpointsPending = false;
    }
  }
  function cancel() {
    stopAuthorizationPolling({ reset: true });
    retryActivation = false;
    reconnectTarget = null;
    retryDelay = 5000;
    epoch++;
    directoryRevision++;
    clearTimeout(timer);
    clearTimeout(leaseTimer);
    timer = null;
    connectionEpoch++;
    if (selectionController && activeLink === directTransport) void directTransport?.client.disconnect();
    selectionController?.abort();
    selectionController = null;
    activeController?.abort();
    activeController = null;
    activeWork = null;
    refreshWork = null;
  }
  function retireTransport() {
    unsubscribeTransport?.();
    unsubscribeTransport = null;
    const old = transport;
    if (activeLink === old) activeLink = null;
    transport = null;
    transportKey = null;
    if (!old) return Promise.resolve();
    const closing = Promise.resolve(old.client.close());
    draining.add(closing);
    closing.then(
      () => draining.delete(closing),
      () => draining.delete(closing),
    );
    return closing;
  }
  function retireDirect() {
    activeLocalDeviceId = null;
    unsubscribeDirect?.();
    unsubscribeDirect = null;
    const old = directTransport;
    directTransport = null;
    if (activeLink === old) activeLink = null;
    if (!old) return Promise.resolve();
    const closing = Promise.resolve(old.client.close());
    draining.add(closing);
    closing.then(
      () => draining.delete(closing),
      () => draining.delete(closing),
    );
    return closing;
  }
  function ensureTransport(identity, sessionId, generation) {
    const key = identity
      ? `${identity.accountId}:${identity.clientId}:${sessionId || "direct"}`
      : "direct";
    const operation = switching
      .catch(() => {})
      .then(async () => {
        assertCurrent(generation);
        if (transport && transportKey === key) return transport;
        await retireTransport();
        await Promise.allSettled([...draining]);
        assertCurrent(generation);
        transport = createTransport(
          identity ? { ...identity, networkSessionId: sessionId } : null,
        );
        transportKey = key;
        const target = transport;
        let previousConnection = null;
        unsubscribeTransport = target.client.subscribe(() => {
          const state = target.client.snapshot();
          const network = target.network.snapshot();
          if (activeLink === target && previousConnection?.mode === "netbird" &&
              !state.connection && state.reason === "network_unavailable" &&
              network.enabled !== false && network.phase !== "auth_required")
            reconnectTarget = { deviceId: previousConnection.deviceId, selection: connectionEpoch };
          previousConnection = state.connection;
          if (reconnectTarget && network.phase === "ready" && usableLease() &&
              platform.phase === "ready" && !activeWork)
            void activate();
          emit();
        });
        return transport;
      });
    switching = operation;
    return operation;
  }
  const authenticated = () => {
    const identity = account.getIdentity();
    if (!identity || account.snapshot().phase !== "authenticated")
      throw fail("ACCOUNT_LOGIN_REQUIRED");
    return identity;
  };
  function validateSession(value) {
    if (
      !value ||
      !validID(value.enrollmentId) ||
      !validID(value.networkSessionId) ||
      value.managementUrl !== managementURL ||
      !["enrolling", "ready", "revoked", "revocation_pending"].includes(
        value.phase,
      )
    )
      throw fail("NETWORK_INVALID_RESPONSE");
    if (value.phase === "revoked") throw fail("NETWORK_ENROLLMENT_REQUIRED");
    if (value.phase === "revocation_pending")
      throw fail("NETWORK_REVOCATION_PENDING");
    if (
      value.phase === "ready" &&
      (!Number.isFinite(value.leaseExpiresAt) ||
        value.leaseExpiresAt * 1000 <= Date.now())
    )
      throw fail("NETWORK_LEASE_EXPIRED");
    return value;
  }
  async function request(input, generation, signal) {
    const result = await account.request({ ...input, signal });
    assertCurrent(generation);
    signal?.throwIfAborted();
    return result;
  }
  function guardLease(generation) {
    clearTimeout(leaseTimer);
    leaseTimer = setTimeout(
      () => {
        if (!current(generation)) return;
        const interrupted = activeLink === transport ? transport?.client.snapshot().connection : null;
        cancel();
        networkSession = null;
        devices = [];
        platform = { phase: "unavailable", reason: "NETWORK_LEASE_EXPIRED" };
        void retireTransport().catch(() => {});
        // Remember only user intent, never expired credentials/endpoints. A fresh
        // cloud directory and lease must pass activateImpl before reconnecting.
        if (interrupted?.deviceId && enabled && account.snapshot().phase === "authenticated") {
          reconnectTarget = { deviceId: interrupted.deviceId, selection: connectionEpoch };
          retryActivation = true;
          schedule(epoch, 5000);
        }
        emit();
      },
      Math.max(1, networkSession.leaseExpiresAt * 1000 - Date.now()),
    );
    leaseTimer.unref?.();
  }
  function schedule(generation, interval = renewIntervalMs) {
    clearTimeout(timer);
    // A transient failure may retire the old lease; retry activation must still
    // run, and restore must authorize the replacement before exposing endpoints.
    if (!current(generation) || !enabled || (!networkSession && !retryActivation)) return;
    const remaining = networkSession ? networkSession.leaseExpiresAt * 1000 - Date.now() : Infinity;
    timer = setTimeout(
      () => {
        void activate();
      },
      Math.max(1, Math.min(interval, remaining / 2)),
    );
    timer.unref?.();
  }
  function scheduleAuthorizationPolling(generation) {
    clearTimeout(authorizationTimer);
    authorizationTimer = null;
    if (!current(generation) || !enabled || !usableLease() || platform.phase !== "ready") return;
    if (!authorizationEndpointsPending && !boxes.some(box => box.accessState === "authorization_pending")) {
      authorizationDeadline = 0;
      return;
    }
    // Device acknowledgement is asynchronous. Observe it promptly without
    // repeating preparation, network enrollment, or lease renewal.
    authorizationDeadline ||= Date.now() + 60_000;
    if (Date.now() >= authorizationDeadline) return;
    authorizationTimer = setTimeout(() => {
      authorizationTimer = null;
      if (!current(generation) || !enabled || !usableLease() || Date.now() >= authorizationDeadline) return;
      if (activeWork || authorizationWork) {
        scheduleAuthorizationPolling(generation);
        return;
      }
      const controller = new AbortController();
      authorizationController = controller;
      const work = (async () => {
        const waiting = new Set(boxes.filter(box => box.accessState === "authorization_pending").map(box => box.deviceId));
        const loaded = await loadDirectory(generation, { signal: controller.signal });
        if (!loaded || !current(generation) || !usableLease() || controller.signal.aborted) return;
        if (boxes.some(box => waiting.has(box.deviceId) && box.accessState === "ready"))
          authorizationEndpointsPending = true;
        if (authorizationEndpointsPending) {
          const target = transport;
          await target.network.refresh();
          assertCurrent(generation);
          controller.signal.throwIfAborted();
          await loadNetworkDevices(generation, controller.signal);
          authorizationEndpointsPending = false;
        }
      })().catch((error) => {
        if (current(generation) && !controller.signal.aborted && !transientError(error))
          authorizationEndpointsPending = false;
        // The regular renewal path owns error recovery and lease expiry.
      }).finally(() => {
        if (authorizationWork === work) authorizationWork = null;
        if (authorizationController === controller) authorizationController = null;
        if (current(generation)) scheduleAuthorizationPolling(generation);
      });
      authorizationWork = work;
    }, Math.min(2000, authorizationDeadline - Date.now()));
    authorizationTimer.unref?.();
  }
  async function loadDirectory(generation, { prepare = false, signal } = {}) {
    const revision = prepare ? directoryRevision : ++directoryRevision;
    const retain = directory.phase === "ready" && usableLease();
    directory = retain
      ? { phase: "ready", reason: null, refreshing: true }
      : { phase: "loading", reason: null };
    emit();
    try {
      const result = await request(
        {
          path: prepare
            ? "/app-api/network/boxes/prepare"
            : "/app-api/network/boxes",
          ...(prepare ? { method: "POST", body: {} } : {}),
        },
        generation,
        signal,
      );
      if (signal?.aborted || revision !== directoryRevision) return false;
      if (!Array.isArray(result?.boxes)) throw fail("NETWORK_INVALID_RESPONSE");
      const seen = new Set();
      const entries = result.boxes.map((box) => {
        if (
          !validDeviceID(box.deviceId) ||
          seen.has(box.deviceId) ||
          typeof box.displayName !== "string" ||
          box.displayName.length > 256 ||
          ![
            "ready",
            "authorization_pending",
            "authorization_unavailable",
            "access_denied",
            "network_unconfigured",
            "identity_unavailable",
          ].includes(box.accessState)
        )
          throw fail("NETWORK_INVALID_RESPONSE");
        seen.add(box.deviceId);
        return {
          deviceId: box.deviceId,
          displayName: box.displayName,
          deviceRole: box.deviceRole,
          accessState: box.accessState,
        };
      });
      if (prepare) directoryRevision++;
      boxes = entries;
      devices = devices.filter((device) =>
        boxes.some(
          (box) =>
            box.deviceId === device.deviceId && box.accessState === "ready",
        ),
      );
      directory = { phase: "ready", reason: null };
      const selected = transport?.client.snapshot().connection;
      if (
        selected?.mode === "netbird" &&
        !boxes.some(
          (box) =>
            box.deviceId === selected.deviceId && box.accessState === "ready",
        )
      )
        await transport.client.disconnect();
      if (current(generation)) emit();
      return true;
    } catch (error) {
      if (signal?.aborted || !current(generation) || revision !== directoryRevision) return false;
      if (retain && usableLease() && transientError(error)) {
        directory = {
          phase: "ready",
          reason: safeReason(error),
          refreshing: false,
        };
        emit();
        if (prepare) throw error;
        return false;
      }
      devices = [];
      if (!prepare && error.code === "NETWORK_SERVICE_NOT_DEPLOYED") {
        // The existing account directory is display-only until network APIs ship.
        // It never supplies endpoints, permissions or a ready network state.
        try {
          const linked = await account.listDevices();
          if (!current(generation) || revision !== directoryRevision)
            return false;
          const seen = new Set();
          if (!Array.isArray(linked)) throw fail("ACCOUNT_INVALID_RESPONSE");
          boxes = linked.map((box) => {
            if (
              !validDeviceID(box.deviceId) ||
              seen.has(box.deviceId) ||
              typeof box.deviceName !== "string" ||
              box.deviceName.length > 256
            )
              throw fail("ACCOUNT_INVALID_RESPONSE");
            seen.add(box.deviceId);
            return {
              deviceId: box.deviceId,
              displayName: box.deviceName,
              deviceRole: box.role,
              accessState: "service_unavailable",
            };
          });
        } catch (fallbackError) {
          if (!current(generation) || revision !== directoryRevision)
            return false;
          error = fallbackError;
        }
      }
      directory = { phase: "unavailable", reason: safeReason(error) };
      emit();
      if (prepare) throw error;
      return false;
    }
  }
  async function loadNetworkDevices(generation, signal, { requireLiveSession = false } = {}) {
    const result = await request(
      { path: "/app-api/network/devices" },
      generation,
      signal,
    );
    if (!Array.isArray(result?.devices))
      throw fail("NETWORK_INVALID_RESPONSE");
    if (result.networkSessionId !== networkSession?.networkSessionId)
      throw fail(requireLiveSession ? "NETWORK_SESSION_REVOKED" : "NETWORK_INVALID_RESPONSE");
    if (result.phase !== undefined && result.phase !== "ready")
      throw fail(result.phase === "revocation_pending" ? "NETWORK_REVOCATION_PENDING" : "NETWORK_SESSION_REVOKED");
    if (result.leaseExpiresAt !== undefined &&
        (!Number.isFinite(result.leaseExpiresAt) || result.leaseExpiresAt * 1000 <= Date.now()))
      throw fail("NETWORK_LEASE_EXPIRED");
    if (requireLiveSession && (result.phase !== "ready" ||
        !Number.isFinite(result.leaseExpiresAt) || result.leaseExpiresAt * 1000 <= Date.now())) {
      // Older servers do not expose phase on this read. Use their existing
      // restore protocol, never infer current authority from a cached lease.
      throw fail("NETWORK_SESSION_RECHECK_REQUIRED");
    }
    devices = result.devices.map((device) => {
      if (
        !validDeviceID(device.deviceId) ||
        !validID(device.identityDeviceId) ||
        typeof device.displayName !== "string" ||
        device.displayName.length > 256
      )
        throw fail("NETWORK_INVALID_RESPONSE");
      const url = new URL(device.serviceUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw fail("NETWORK_INVALID_RESPONSE");
      return {
        deviceId: device.deviceId,
        identityDeviceId: device.identityDeviceId,
        displayName: device.displayName,
        serviceUrl: url.origin,
        ownershipEpoch: device.ownershipEpoch,
        authorizationVersion: device.authorizationVersion,
        deviceRole: device.deviceRole,
      };
    });
    const selected = transport?.client.snapshot().connection;
    if (
      selected?.mode === "netbird" &&
      !devices.some(
        (device) =>
          device.deviceId === selected.deviceId &&
          device.serviceUrl === selected.url,
      )
    )
      await transport.client.disconnect();
    return emit();
  }
  async function activateImpl(generation, signal) {
    retryActivation = false;
    const identity = authenticated();
    if (!enabled) return snapshot();
    // Only an identity bound to this account/client can be warmed. Cloud
    // confirmation below remains mandatory before exposing any endpoint.
    const warming =
      !transport && validResume(resumeHint, identity)
        ? ensureTransport(identity, resumeHint.networkSessionId, generation)
            .then(async (target) => ({
              target,
              status: await target.network.setEnabled(true),
            }))
            .catch(() => null)
        : null;
    if (platform.phase !== "ready")
      platform = { phase: "enrolling", reason: null };
    emit();
    if (prepareNeeded) {
      const prepared = await loadDirectory(generation, {
        prepare: true,
        signal,
      });
      assertCurrent(generation);
      prepareNeeded = !prepared;
    } else {
      await loadDirectory(generation, { signal });
      assertCurrent(generation);
    }
    let enrollment;
    try {
      enrollment = validateSession(
        await request(
          { method: "POST", path: "/app-api/network/restore", body: {} },
          generation,
          signal,
        ),
      );
    } catch (error) {
      // A new account session can precede server-side cleanup of its old
      // network enrollment. Retry only restoration; never enroll over it.
      if (["NETWORK_SESSION_REVOKED", "NETWORK_REVOCATION_PENDING"].includes(error.code)) {
        error.retryable = true;
        throw error;
      }
      if (error.code !== "NETWORK_ENROLLMENT_REQUIRED") throw error;
      enrollment = validateSession(
        await request(
          {
            method: "POST",
            path: "/app-api/network/enrollments",
            body: { requestId: randomUUID() },
          },
          generation,
          signal,
        ),
      );
    }
    let target = await ensureTransport(
      identity,
      enrollment.networkSessionId,
      generation,
    );
    const warmed = await warming;
    assertCurrent(generation);
    let status =
      warmed?.target === target
        ? warmed.status
        : await target.network.setEnabled(true);
    assertCurrent(generation);
    if (status.phase === "auth_required" && !enrollment.setupKey) {
      // Includes a committed enrollment whose one-time key response was lost.
      // Revoke before replacing; never try to retrieve or reuse its old key.
      await request(
        { method: "DELETE", path: "/app-api/network/current" },
        generation,
        signal,
      );
      enrollment = validateSession(
        await request(
          {
            method: "POST",
            path: "/app-api/network/enrollments",
            body: { requestId: randomUUID() },
          },
          generation,
          signal,
        ),
      );
      target = await ensureTransport(
        identity,
        enrollment.networkSessionId,
        generation,
      );
      status = await target.network.setEnabled(true);
      assertCurrent(generation);
    }
    if (enrollment.setupKey) {
      const setupKey = enrollment.setupKey;
      delete enrollment.setupKey;
      status = await target.network.enroll({ setupKey });
      assertCurrent(generation);
    }
    if (status.phase !== "ready" && status.phase !== "recovering") {
      const error = fail("NETWORK_ENGINE_UNAVAILABLE");
      error.retryable =
        status.phase === "unavailable" &&
        ["start_failed", "network_unavailable", "engine_timeout", "engine_exited", "engine_unavailable"].includes(
          status.reason,
        );
      throw error;
    }
    for (
      let attempt = 0;
      enrollment.phase !== "ready" && attempt < pollAttempts;
      attempt++
    ) {
      await delay(pollIntervalMs, undefined, { signal });
      enrollment = validateSession(
        await request(
          { path: `/app-api/network/enrollments/${enrollment.enrollmentId}` },
          generation,
          signal,
        ),
      );
    }
    if (enrollment.phase !== "ready") throw fail("NETWORK_ENROLLMENT_TIMEOUT");
    networkSession = enrollment;
    guardLease(generation);
    await target.network.refresh();
    assertCurrent(generation);
    await loadNetworkDevices(generation, signal);
    authorizationEndpointsPending = false;
    platform = { phase: "ready", reason: null };
    void persistResume({
      version: 1,
      accountId: identity.accountId,
      clientId: identity.clientId,
      networkSessionId: enrollment.networkSessionId,
      managementURL,
    });
    retryDelay = 5000;
    schedule(generation);
    scheduleAuthorizationPolling(generation);
    // Restore only the user's last interrupted selection, after fresh directory,
    // network and box authorization. Never take over a subsequent user selection.
    const resume = reconnectTarget;
    if (resume && resume.selection === connectionEpoch && (!activeLink || activeLink === transport)) {
      reconnectTarget = null;
      const selection = connectionEpoch + 1;
      try { await api.connectBox(resume.deviceId); }
      catch (error) {
        if (current(generation) && selection === connectionEpoch && transientError(error))
          reconnectTarget = { ...resume, selection };
      }
    }
    return emit();
  }
  function activate() {
    if (activeWork) return activeWork;
    // A manual/system-triggered attempt replaces any previously scheduled retry.
    clearTimeout(timer);
    const generation = epoch;
    stopAuthorizationPolling();
    const controller = new AbortController();
    activeController = controller;
    const work = activateImpl(generation, controller.signal)
      .catch(async (error) => {
        if (current(generation)) {
          const pendingCleanup = ["NETWORK_SESSION_REVOKED", "NETWORK_REVOCATION_PENDING"].includes(error.code);
          const transient = !pendingCleanup && transientError(error);
          // Pending cleanup is not authorization to keep the old tunnel alive.
          // Poll restore with backoff; only a confirmed revoked response may
          // trigger replacement enrollment through the existing validation path.
          const retryable = transient || pendingCleanup;
          retryActivation = retryable;
          const backoff = retryDelay;
          if (retryable) retryDelay = Math.min(retryDelay * 2, 60_000);
          if (
            transient &&
            platform.phase === "ready" &&
            networkSession?.leaseExpiresAt * 1000 > Date.now() &&
            ["ready", "recovering"].includes(
              transport?.network.snapshot().phase,
            )
          ) {
            // Existing authorization remains bounded by the independent deadline.
            schedule(generation, backoff);
            return emit();
          }
          const interrupted = activeLink === transport ? activeLink?.client.snapshot().connection : null;
          if (retryable && interrupted?.deviceId)
            reconnectTarget = { deviceId: interrupted.deviceId, selection: connectionEpoch };
          if (!retryable) reconnectTarget = null;
          clearTimeout(leaseTimer);
          networkSession = null;
          devices = [];
          platform = { phase: "unavailable", reason: safeReason(error) };
          if (!transient) void persistResume(null);
          await retireTransport();
          if (current(generation)) {
            if (retryable) schedule(generation, backoff);
            emit();
          }
        }
        return snapshot();
      })
      .finally(() => {
        if (current(generation)) scheduleAuthorizationPolling(generation);
        if (activeWork === work) {
          activeWork = null;
          activeController = null;
        }
      });
    activeWork = work;
    return work;
  }
  let accountKey = account.getIdentity()?.accountId || null;
  let accountPhase = account.snapshot().phase;
  const unsubscribeAccount = account.subscribe((state) => {
    if (closed) return;
    const nextAccountKey =
      state.phase === "authenticated" ? state.accountId : null;
    if (
      (state.phase === "signed_out" && accountPhase !== "signed_out") ||
      (accountKey && nextAccountKey && accountKey !== nextAccountKey)
    ) {
      cancel();
      networkSession = null;
      devices = [];
      boxes = [];
      directory = { phase: "idle", reason: null };
      prepareNeeded = true;
      void persistResume(null);
      platform = { phase: "idle", reason: null };
      void retireTransport().catch(() => {});
      void retireDirect().catch(() => {});
    }
    accountKey = nextAccountKey;
    accountPhase = state.phase;
    emit();
  });
  async function afterLogin(action, { waitForDevices = true } = {}) {
    if (closed) throw fail("ACCOUNT_CANCELLED");
    if (account.snapshot().phase === "authenticated")
      throw fail("ACCOUNT_ALREADY_SIGNED_IN");
    cancel();
    const generation = epoch;
    await measure("account.login", action);
    if (!current(generation)) return snapshot();
    const refreshing = refreshDevices();
    if (waitForDevices) return refreshing;
    void refreshing.catch((error) => {
      if (!current(generation)) return;
      platform = { phase: "unavailable", reason: safeReason(error) };
      emit();
    });
    return snapshot();
  }
  function refreshDevices() {
    if (refreshWork) return refreshWork;
    const work = refreshDevicesImpl().finally(() => {
      if (refreshWork === work) refreshWork = null;
    });
    refreshWork = work;
    return work;
  }
  async function refreshDevicesImpl() {
    authenticated();
    authorizationDeadline = 0;
    const generation = epoch;
    if (localBoxes) {
      const found = await localBoxes.list().catch(() => []);
      if (!current(generation)) return snapshot();
      localDevices = found;
      if (activeLocalDeviceId && !found.some(device => device.deviceId === activeLocalDeviceId && device.canOpen))
        await retireDirect();
      emit();
    }
    // A live session with the same box access needs fresh reads, not another
    // write-side preparation and NetBird projection under the account lock.
    const accessKey = () => JSON.stringify(boxes.map(box =>
      [box.deviceId, box.deviceRole, box.accessState]).sort((a, b) => a[0].localeCompare(b[0])));
    const previousAccess = accessKey();
    const ready = enabled && !activeWork && !prepareNeeded &&
      platform.phase === "ready" && usableLease();
    const listing = loadDirectory(generation);
    if (ready) {
      const loaded = await listing;
      if (!current(generation) || !enabled) return snapshot();
      if (loaded && !activeWork && usableLease() && previousAccess === accessKey() &&
          !boxes.some(box => box.accessState === "authorization_pending")) {
        try {
          await Promise.all([
            transport.network.refresh(),
            loadNetworkDevices(generation, undefined, { requireLiveSession: true }),
          ]);
          if (current(generation)) scheduleAuthorizationPolling(generation);
          return snapshot();
        } catch (error) {
          // The normal activation path owns lease revocation and transient
          // recovery; never convert a failed authorization read into readiness.
          if (!current(generation)) return snapshot();
          if (["NETWORK_REVOCATION_PENDING", "NETWORK_SESSION_REVOKED",
            "NETWORK_LEASE_EXPIRED", "ACCOUNT_ACCESS_DENIED"].includes(error.code)) {
            const selected = activeLink === transport ? activeLink?.client.snapshot().connection : null;
            cancel();
            const recoveryGeneration = epoch;
            void persistResume(null);
            networkSession = null;
            devices = [];
            platform = { phase: "unavailable", reason: safeReason(error) };
            if (selected?.deviceId)
              reconnectTarget = { deviceId: selected.deviceId, selection: connectionEpoch };
            const retiring = retireTransport();
            emit();
            await retiring;
            if (!current(recoveryGeneration) || !enabled) return snapshot();
          }
          await activate();
          return snapshot();
        }
      }
    }
    if (enabled) {
      prepareNeeded = true;
      await Promise.all([listing, activate()]);
      if (
        current(generation) &&
        enabled &&
        prepareNeeded &&
        platform.phase === "ready"
      )
        await activate();
    } else await listing;
    return snapshot();
  }
  async function ownershipChange(operation) {
    authenticated();
    const generation = epoch;
    const transfer = await operation();
    if (!current(generation)) throw fail("ACCOUNT_CANCELLED");
    // The server has committed. Refresh errors must not invite duplicate transfers.
    const selected = activeLink?.client.snapshot().connection;
    if (selected?.deviceId === transfer.deviceId) {
      connectionEpoch++;
      selectionController?.abort();
      selectionController = null;
      await activeLink.client.disconnect();
    }
    if (!current(generation)) throw fail("ACCOUNT_CANCELLED");
    let refreshRequired = false;
    try { await refreshDevices(); refreshRequired = directory.phase !== "ready"; } catch { refreshRequired = true; }
    if (!current(generation)) throw fail("ACCOUNT_CANCELLED");
    return { ...transfer, refreshRequired };
  }
  const api = {
    snapshot,
    async applicationContext() {
      const state = snapshot();
      if (state.phase !== "ready" || !state.connection?.deviceId) throw fail("NETWORK_NOT_READY");
      const response = await activeLink.client.request({ path: "/api/auth/me" });
      if (response.status < 200 || response.status >= 300) throw fail("BOX_IDENTITY_UNAVAILABLE");
      let user;
      try { user = JSON.parse(response.body.toString("utf8")); } catch { throw fail("BOX_IDENTITY_INVALID"); }
      return {
        protocolVersion: 1,
        accountId: state.account.accountId,
        clientId: state.account.clientId,
        boxId: state.connection.deviceId,
        user,
        connection: "ready",
      };
    },
    async applicationRequest(input) {
      if (!activeLink?.client) throw fail("NETWORK_NOT_READY");
      return activeLink.client.request(input);
    },
    async applicationStream(input) {
      if (!activeLink?.client) throw fail("NETWORK_NOT_READY");
      return activeLink.client.openWebSocket(input);
    },
    async applicationConnection(applicationId, options) {
      const connectionOptions = validateApplicationConnectionOptions(options);
      const link = activeLink, generation = connectionEpoch;
      const state = snapshot();
      if (state.phase !== "ready" || !state.connection?.deviceId) throw fail("NETWORK_NOT_READY");
      const connection = link.client.applicationConnection(applicationId, connectionOptions);
      const assertLive = () => {
        const next = snapshot();
        if (closed || activeLink !== link || generation !== connectionEpoch ||
            !["ready", "recovering"].includes(next.phase) || next.account.phase !== "authenticated") throw fail("NETWORK_CHANGED");
        return next.phase;
      };
      const assertReady = () => { if (assertLive() !== "ready") throw fail("NETWORK_NOT_READY"); };
      const response = await connection.request({ path: "/api/auth/me" });
      assertLive();
      if (response.status !== 200) throw fail("BOX_IDENTITY_UNAVAILABLE");
      let user;
      try { user = JSON.parse(response.body.toString("utf8")); } catch { throw fail("BOX_IDENTITY_INVALID"); }
      let metering = null;
      async function meteredInput(input) {
        // Development authority tokens must never be forwarded to another box.
        const local = localDevices.find(d => d.deviceId === state.connection.deviceId);
        if (!creditsServiceURL || !local || new URL(local.serviceUrl).origin !== new URL(creditsServiceURL).origin)
          return input;
        if (!metering || metering.expires_at * 1000 < Date.now() + 30000) {
          try {
            const result = await account.creditsRequest({ serviceURL: creditsServiceURL,
              path: `/api/credits/meter-session?application_id=${applicationId}` });
            assertLive();
            const value = JSON.parse(result.body.toString("utf8"));
            if (result.status !== 200 || value.mode !== "shadow" || typeof value.token !== "string" ||
                !/^[A-Za-z0-9_-]{32,128}$/.test(value.token) || !Number.isSafeInteger(value.expires_at)) return input;
            metering = value;
          } catch { return input; } // Shadow collection must not block an existing free app.
        }
        assertReady();
        return { ...input, headers: { ...input.headers, "x-wanx-metering-session": metering.token } };
      }
      const context = { protocolVersion: 1, accountId: state.account.accountId, clientId: state.account.clientId, boxId: state.connection.deviceId, user, connection: "ready" };
      return {
        context: () => ({ ...context, connection: assertLive() }),
        request: (input) => { assertReady(); return meteredInput(input).then(value => { assertReady(); return connection.request(value); }); },
        businessRequest: (service, input) => { assertReady(); return meteredInput(input).then(value => { assertReady(); return connection.businessRequest(service, value); }); },
        openStream: (input) => { assertReady(); return meteredInput(input).then(value => { assertReady(); return connection.openStream(value); }); },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async initialize() {
      const generation = epoch;
      try {
        const preference = await readPreference();
        if (!current(generation)) return snapshot();
        enabled = preference !== false;
        await measure("account.restore", () => account.restore());
        if (!current(generation)) return snapshot();
        const identity = account.getIdentity();
        if (enabled && identity && resumeStore) {
          const saved = await resumeStore.load().catch(() => null);
          if (!current(generation)) return snapshot();
          if (validResume(saved, identity)) resumeHint = saved;
          else if (saved) void persistResume(null);
        }
      } catch (error) {
        if (current(generation))
          platform = { phase: "unavailable", reason: safeReason(error) };
      }
      if (!current(generation)) return snapshot();
      if (account.snapshot().phase === "authenticated") return refreshDevices();
      return emit();
    },
    loginPassword: (input, options) => afterLogin(() => account.loginPassword(input), options),
    getRememberedLogin: () => account.getRememberedLogin(),
    forgetRememberedLogin: () => account.forgetRememberedLogin(),
    loginSMS: (input, options) => afterLogin(() => account.loginSMS(input), options),
    register: (input, options) => afterLogin(() => account.register(input), options),
    sendSMS: ({ phone, scene }) => account.sendSMS(phone, scene),
    sendResetCode: (input) => account.sendResetCode(input),
    resetPassword: (input) => account.resetPassword(input),
    sendChangeCode: () => account.sendChangeCode(),
    changePassword: (input) => account.changePassword(input),
    refreshDevices,
    lookupDeviceDiscovery: (deviceIds) => account.lookupDeviceDiscovery(deviceIds),
    redeemConsoleClaim: (input) => ownershipChange(() => account.redeemConsoleClaim(input)),
    getConsoleClaimAuthorization: (deviceId) => account.getConsoleClaimAuthorization(deviceId),
    listOwnershipTransfers: () => account.listOwnershipTransfers(),
    sendTransferCode: () => account.sendTransferCode(),
    createOwnershipTransfer: (input) => ownershipChange(() => account.createOwnershipTransfer(input)),
    acceptOwnershipTransfer: (input) => ownershipChange(() => account.acceptOwnershipTransfer(input)),
    async networkChanged() {
      if (closed || !enabled || !account.getIdentity()) return snapshot();
      const generation = epoch;
      // Let an in-flight startup settle before repairing its path. A late system
      // notification must never resurrect a disabled or logged-out generation.
      if (activeWork) await activeWork;
      if (!current(generation) || !enabled) return snapshot();
      if (transport && usableLease()) {
        await measure("network.recover", () =>
          transport.client.networkChanged(),
        );
        if (current(generation)) emit();
      } else if (retryActivation) {
        // Retry only a previously requested, transiently failed activation.
        // Auth rejection, a hard lease expiry, and logout cannot enter this path.
        await activate();
      }
      if (directTransport && activeLink === directTransport) await directTransport.client.networkChanged();
      return snapshot();
    },
    async setNetworkEnabled(value) {
      if (closed) throw fail("NETWORK_CANCELLED");
      if (typeof value !== "boolean") throw fail("NETWORK_INVALID_SWITCH");
      cancel();
      enabled = value;
      const generation = epoch;
      if (!enabled) {
        networkSession = null;
        devices = [];
        platform = { phase: "idle", reason: null };
        const stopping = transport?.network.setEnabled(false);
        emit();
        await stopping;
      }
      if (!current(generation)) return snapshot();
      try {
        await writePreference(value);
      } catch (error) {
        if (current(generation) && enabled && networkSession) {
          guardLease(generation);
          schedule(generation);
        }
        throw error;
      }
      if (!current(generation)) return snapshot();
      if (account.getIdentity()) return refreshDevices();
      return emit();
    },
    async connect(input) {
      reconnectTarget = null;
      if (input?.mode !== "direct") throw fail("NETWORK_USE_AUTHORIZED_DEVICE");
      activeLocalDeviceId = null;
      const selection = ++connectionEpoch;
      selectionController?.abort();
      selectionController = null;
      const generation = epoch;
      await activeLink?.client.disconnect();
      if (selection !== connectionEpoch || !current(generation))
        return snapshot();
      if (!directTransport) {
        directTransport = createTransport(null);
        unsubscribeDirect = directTransport.client.subscribe(() => emit());
      }
      const target = directTransport;
      activeLink = target;
      return target.client.connect(input).then(() => snapshot());
    },
    async connectBox(deviceId) {
      reconnectTarget = null;
      const identity = authenticated();
      const local = localDevices.find(device => device.deviceId === deviceId);
      if (local && localBoxes) {
        const generation = epoch, selection = ++connectionEpoch;
        selectionController?.abort();
        const controller = new AbortController();
        selectionController = controller;
        activeLocalDeviceId = null;
        await activeLink?.client.disconnect();
        if (selection !== connectionEpoch || !current(generation)) return snapshot();
        if (!directTransport) {
          directTransport = createTransport(null);
          unsubscribeDirect = directTransport.client.subscribe(() => emit());
        }
        const target = directTransport;
        activeLink = target;
        // Only this registered, authenticated path can project a local box.
        activeLocalDeviceId = deviceId;
        await target.client.connect({ deviceId, name: local.displayName, url: local.serviceUrl, mode: "direct" }, {
          createSession: ({ url, signal }) => localBoxes.createSession(deviceId, {
            url, signal: AbortSignal.any([signal, controller.signal]),
            onExpired: () => { if (activeLink === target && activeLocalDeviceId === deviceId) void target.client.disconnect(); },
          }),
        });
        if (selection !== connectionEpoch || !current(generation)) return snapshot();
        selectionController = null;
        return emit();
      }
      if (
        !enabled ||
        platform.phase !== "ready" ||
        !networkSession ||
        directory.phase !== "ready" ||
        !transport
      )
        throw fail("NETWORK_NOT_READY");
      const generation = epoch;
      const selection = ++connectionEpoch;
      selectionController?.abort();
      const controller = new AbortController();
      selectionController = controller;
      await activeLink?.client.disconnect();
      try {
        await loadNetworkDevices(generation, controller.signal);
      } catch (error) {
        if (selection !== connectionEpoch || !current(generation))
          return snapshot();
        devices = [];
        emit();
        throw error;
      }
      if (selection !== connectionEpoch || !current(generation))
        return snapshot();
      const device = devices.find((item) => item.deviceId === deviceId);
      if (
        !device ||
        !boxes.some(
          (box) => box.deviceId === deviceId && box.accessState === "ready",
        )
      )
        throw fail("NETWORK_DEVICE_ACCESS_DENIED");
      const target = transport;
      activeLocalDeviceId = null;
      activeLink = target;
      const sessionId = networkSession.networkSessionId;
      await target.client.connect(
        {
          deviceId,
          name: device.displayName,
          url: device.serviceUrl,
          mode: "netbird",
        },
        {
          createSession: ({ url, agent, signal }) =>
            createSession({
              url,
              agent,
              account,
              device,
              identity,
              networkSessionId: sessionId,
              signal,
              measure,
              onExpired: (reason) => {
                if (transport === target && selection === connectionEpoch) {
                  if (reason === "expired" && usableLease() && account.snapshot().phase === "authenticated")
                    target.client.recoverSession();
                  else void target.client.disconnect();
                }
              },
            }),
        },
      );
      return snapshot();
    },
    async disconnect() {
      reconnectTarget = null;
      connectionEpoch++;
      selectionController?.abort();
      selectionController = null;
      await activeLink?.client.disconnect();
      return emit();
    },
    async retryConnection() {
      if (closed || !account.getIdentity()) return snapshot();
      await activeLink?.client.retryConnection();
      return emit();
    },
    async logout() {
      if (closed) return snapshot();
      cancel();
      networkSession = null;
      devices = [];
      boxes = [];
      directory = { phase: "idle", reason: null };
      prepareNeeded = true;
      void persistResume(null);
      platform = { phase: "idle", reason: null };
      // Detach the old gateway immediately. Network process shutdown can take
      // seconds; ensureTransport already drains it before creating a new one.
      void Promise.allSettled([retireTransport(), retireDirect()]);
      emit();
      await account.logout();
      return emit();
    },
    async close() {
      if (closed) return;
      closed = true;
      cancel();
      unsubscribeAccount();
      await retireTransport();
      await retireDirect();
      await switching.catch(() => {});
      await Promise.allSettled([...draining]);
      await account.close();
      await resumeWrites;
      listeners.clear();
    },
  };
  return api;
}
