import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createPlatformSession } from "./octop/platform.mjs";

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
  managementURL = "https://p2p.qeeshu.com",
  readPreference = async () => true,
  writePreference = async () => {},
  renewIntervalMs = 60_000,
  pollIntervalMs = 500,
  pollAttempts = 60,
} = {}) {
  let enabled = true;
  let transport = null,
    transportKey = null,
    unsubscribeTransport;
  let networkSession = null;
  let directTransport = null,
    unsubscribeDirect,
    activeLink = null;
  let devices = [],
    boxes = [];
  let directory = { phase: "idle", reason: null };
  let directoryRevision = 0,
    prepareNeeded = true;
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
  const draining = new Set(),
    listeners = new Set();
  const empty = () => ({
    phase: "disconnected",
    connection: null,
    reason: null,
  });
  const snapshot = () => {
    const connection = activeLink?.client.snapshot() || empty();
    const signedIn = account.snapshot().phase === "authenticated";
    const network = !enabled
      ? { phase: "disabled", reason: null }
      : !signedIn
      ? { phase: "auth_required", reason: null }
      : platform.phase === "enrolling"
      ? { phase: "checking", reason: null }
      : platform.phase === "unavailable"
      ? { phase: "unavailable", reason: platform.reason }
      : transport?.network.snapshot() || { phase: "checking", reason: null };
    return structuredClone({
      ...connection,
      account: account.snapshot(),
      devices: boxes.map((box) => {
        const endpoint = devices.find((item) => item.deviceId === box.deviceId);
        return {
          ...box,
          canOpen: Boolean(
            enabled &&
              platform.phase === "ready" &&
              directory.phase === "ready" &&
              box.accessState === "ready" &&
              endpoint,
          ),
        };
      }),
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
  function cancel() {
    epoch++;
    directoryRevision++;
    clearTimeout(timer);
    clearTimeout(leaseTimer);
    timer = null;
    connectionEpoch++;
    selectionController?.abort();
    selectionController = null;
    activeController?.abort();
    activeController = null;
    activeWork = null;
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
  async function retireDirect() {
    unsubscribeDirect?.();
    unsubscribeDirect = null;
    const old = directTransport;
    directTransport = null;
    if (activeLink === old) activeLink = null;
    await old?.client.close();
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
        unsubscribeTransport = transport.client.subscribe(() => emit());
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
        cancel();
        networkSession = null;
        devices = [];
        platform = { phase: "unavailable", reason: "NETWORK_LEASE_EXPIRED" };
        void retireTransport().catch(() => {});
        emit();
      },
      Math.max(1, networkSession.leaseExpiresAt * 1000 - Date.now()),
    );
    leaseTimer.unref?.();
  }
  function schedule(generation, interval = renewIntervalMs) {
    clearTimeout(timer);
    if (!current(generation) || !enabled || !networkSession) return;
    const remaining = networkSession.leaseExpiresAt * 1000 - Date.now();
    timer = setTimeout(
      () => {
        void activate();
      },
      Math.max(1, Math.min(interval, remaining / 2)),
    );
    timer.unref?.();
  }
  async function loadDirectory(generation, { prepare = false, signal } = {}) {
    const revision = prepare ? directoryRevision : ++directoryRevision;
    directory = { phase: "loading", reason: null };
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
      if (revision !== directoryRevision) return false;
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
      if (!current(generation) || revision !== directoryRevision) return false;
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
  async function loadNetworkDevices(generation, signal) {
    const result = await request(
      { path: "/app-api/network/devices" },
      generation,
      signal,
    );
    if (
      !Array.isArray(result?.devices) ||
      result.networkSessionId !== networkSession?.networkSessionId
    )
      throw fail("NETWORK_INVALID_RESPONSE");
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
    const identity = authenticated();
    if (!enabled) return snapshot();
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
    let status = await target.network.setEnabled(true);
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
    if (status.phase !== "ready") throw fail("NETWORK_ENGINE_UNAVAILABLE");
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
    platform = { phase: "ready", reason: null };
    schedule(generation);
    return emit();
  }
  function activate() {
    if (activeWork) return activeWork;
    const generation = epoch;
    const controller = new AbortController();
    activeController = controller;
    const work = activateImpl(generation, controller.signal)
      .catch(async (error) => {
        if (current(generation)) {
          const transient =
            error.code === "ACCOUNT_NETWORK_ERROR" ||
            error.status === 429 ||
            (error.status >= 500 && error.status < 600);
          if (
            transient &&
            platform.phase === "ready" &&
            networkSession?.leaseExpiresAt * 1000 > Date.now() &&
            transport?.network.snapshot().phase === "ready"
          ) {
            devices = [];
            // Existing authorization remains bounded by the independent deadline.
            schedule(generation, 5000);
            return emit();
          }
          clearTimeout(leaseTimer);
          networkSession = null;
          devices = [];
          platform = { phase: "unavailable", reason: safeReason(error) };
          await retireTransport();
          if (current(generation)) emit();
        }
        return snapshot();
      })
      .finally(() => {
        if (activeWork === work) {
          activeWork = null;
          activeController = null;
        }
      });
    activeWork = work;
    return work;
  }
  let accountKey = account.getIdentity()?.accountId || null;
  const unsubscribeAccount = account.subscribe((state) => {
    if (closed) return;
    const nextAccountKey =
      state.phase === "authenticated" ? state.accountId : null;
    if (
      state.phase === "signed_out" ||
      (accountKey && nextAccountKey && accountKey !== nextAccountKey)
    ) {
      cancel();
      networkSession = null;
      devices = [];
      boxes = [];
      directory = { phase: "idle", reason: null };
      prepareNeeded = true;
      platform = { phase: "idle", reason: null };
      void retireTransport().catch(() => {});
    }
    accountKey = nextAccountKey;
    emit();
  });
  async function afterLogin(action) {
    if (closed) throw fail("ACCOUNT_CANCELLED");
    if (account.snapshot().phase === "authenticated")
      throw fail("ACCOUNT_ALREADY_SIGNED_IN");
    cancel();
    const generation = epoch;
    await action();
    if (!current(generation)) return snapshot();
    return refreshDevices();
  }
  async function refreshDevices() {
    authenticated();
    const generation = epoch;
    const listing = loadDirectory(generation);
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
  return {
    snapshot,
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
        await account.restore();
      } catch (error) {
        if (current(generation))
          platform = { phase: "unavailable", reason: safeReason(error) };
      }
      if (!current(generation)) return snapshot();
      if (account.snapshot().phase === "authenticated") return refreshDevices();
      return emit();
    },
    loginPassword: (input) => afterLogin(() => account.loginPassword(input)),
    loginSMS: (input) => afterLogin(() => account.loginSMS(input)),
    sendSMS: ({ phone }) => account.sendSMS(phone),
    refreshDevices,
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
      if (input?.mode !== "direct") throw fail("NETWORK_USE_AUTHORIZED_DEVICE");
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
      const identity = authenticated();
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
              onExpired: () => {
                if (transport === target && selection === connectionEpoch)
                  void target.client.disconnect();
              },
            }),
        },
      );
      return snapshot();
    },
    async disconnect() {
      connectionEpoch++;
      selectionController?.abort();
      selectionController = null;
      await activeLink?.client.disconnect();
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
      platform = { phase: "idle", reason: null };
      const stopping = Promise.all([retireTransport(), retireDirect()]);
      emit();
      let reason;
      try {
        if (account.getIdentity())
          await account.request({
            method: "DELETE",
            path: "/app-api/network/current",
          });
      } catch (error) {
        reason = safeReason(error);
      }
      try {
        await account.logout();
      } catch (error) {
        reason ||= safeReason(error);
      }
      await stopping;
      if (reason) platform = { phase: "unavailable", reason };
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
      listeners.clear();
    },
  };
}
