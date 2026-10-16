"use strict";
const { randomUUID } = require("node:crypto");
const LIMIT = 128 * 1024;
const METHODS = [
  "state",
  "begin",
  "resume",
  "confirmPhysical",
  "scanWifi",
  "redeemClaimCode",
  "wifi",
  "confirmOwnership",
  "refresh",
  "cancel",
  "reset",
];
const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 128) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const codeOf = (error) =>
  /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || "")
    ? error.code
    : "CLAIM_UNKNOWN_ERROR";
const failure = (code) => Object.assign(new Error(code), { code });
const bytes = (value, max) => {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > max ||
    value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  )
    throw failure("PROTOCOL_CHANGED");
  return Uint8Array.from(value);
};
function bounded(value) {
  try {
    if (Buffer.byteLength(JSON.stringify(value) ?? "") > LIMIT)
      throw failure("INVALID_REQUEST");
  } catch {
    throw failure("INVALID_REQUEST");
  }
}
function selected(value) {
  if (
    !plain(value) ||
    value.transport !== "ble-gatt" ||
    !text(value.candidateId) ||
    !text(value.transportHandle) ||
    !text(value.selectionLeaseId) ||
    typeof value.advertisedName !== "string" ||
    value.advertisedName.length > 64 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value.advertisedName) ||
    !(
      value.rssi === null ||
      (Number.isFinite(value.rssi) && value.rssi <= 0)
    ) ||
    !Number.isFinite(value.firstSeenMonotonicMs) ||
    value.firstSeenMonotonicMs < 0 ||
    !Number.isFinite(value.lastSeenMonotonicMs) ||
    value.lastSeenMonotonicMs < value.firstSeenMonotonicMs ||
    Object.keys(value).some(
      (key) =>
        ![
          "candidateId",
          "transport",
          "transportHandle",
          "selectionLeaseId",
          "advertisedName",
          "rssi",
          "firstSeenMonotonicMs",
          "lastSeenMonotonicMs",
        ].includes(key),
    )
  )
    throw failure("INVALID_REQUEST");
  return { ...value };
}
function snapshot(value) {
  const result = {};
  for (const key of [
    "flowId",
    "mode",
    "state",
    "verifiedDeviceId",
    "networkState",
    "pairingSessionId",
    "pairingExpiresInMs",
    "claimState",
    "errorCode",
    "retryable",
    "supportCode",
    "restartReason",
  ]) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  for (const key of ["preview", "compatiblePreview"]) {
    if (!plain(value[key])) continue;
    result[key] = {};
    for (const field of [
      "schema_version",
      "device_id",
      "display_name",
      "model",
      "serial_suffix",
      "provisioning_protocol_version",
      "security_profile",
      "identity_public_key_sha256",
      "pairing_mode_remaining_seconds",
      "network_state",
      "cloud_enrollment_status",
      "max_message_bytes",
    ]) {
      if (value[key][field] !== undefined)
        result[key][field] = value[key][field];
    }
  }
  bounded(result);
  return result;
}

/** Main owns authority and crypto; the trusted Renderer owns only GATT handles. */
async function createProvisioningHost({
  webContents,
  ipcMain,
  documentUrl,
  consumer,
  redeemConsoleClaim,
  resumeStore,
  trustedRootCertificatesPem,
  trustedRootSpkiPins,
  coordinatorFactory,
  ownerWifiCoordinatorFactory,
  cryptoFactory,
  beforeConnect = async () => {},
  clock = {
    monotonicMs: () => performance.now(),
    nowUtc: () => new Date().toISOString(),
  },
  transportTimeoutMs = 10000,
}) {
  const core = coordinatorFactory
    ? undefined
    : await import("@nexusaos/local-provisioning-core");
  const contracts = coordinatorFactory
    ? undefined
    : await import("@nexusaos/local-provisioning-contracts");
  const makeCoordinator = coordinatorFactory || core.createClaimCoordinator;
  const makeOwnerWifiCoordinator = ownerWifiCoordinatorFactory ||
    (await import('../account/owner-wifi.mjs')).createOwnerWifiCoordinator;
  const makeCrypto =
    cryptoFactory ||
    (await import("@nexusaos/local-provisioning-core/node"))
      .createNodeProvisioningCryptoProvider;
  const timeoutMs = Math.max(1, Math.min(transportTimeoutMs, 30000));
  const localFailure = (code) =>
    contracts ? new contracts.LocalProvisioningFailure(code) : failure(code);
  let disposed = false,
    disposing,
    resetting,
    rendererActive = true,
    beginning = false,
    resuming = false,
    claimPending = false,
    context,
    generation = 0;
  const pending = new Map(),
    lateConnections = new Map(),
    subscriptions = new Map();
  const stateListeners = new Set();
  const trusted = (event) =>
    !disposed &&
    event.sender === webContents &&
    event.senderFrame === webContents.mainFrame &&
    event.senderFrame?.url === documentUrl;
  const send = (channel, payload) => {
    if (
      !disposed &&
      !webContents.isDestroyed?.() &&
      webContents.mainFrame?.url === documentUrl
    )
      webContents.send(channel, payload);
  };
  const state = () =>
    snapshot(
      context?.coordinator.getSnapshot() || { flowId: "", state: "idle" },
    );
  const publish = () => {
    const value = state();
    send("wanx:setup:state", value);
    for (const listener of stateListeners) {
      try { listener(value); } catch { /* observers cannot break provisioning */ }
    }
  };
  const rpc = (operation, args, signal) => {
    if (
      disposed ||
      !rendererActive ||
      webContents.isDestroyed?.() ||
      webContents.mainFrame?.url !== documentUrl
    )
      return Promise.reject(localFailure("LOCAL_TRANSPORT_DISCONNECTED"));
    if (signal?.aborted)
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (pending.size >= 16)
      return Promise.reject(failure("RESOURCE_EXHAUSTED"));
    bounded(args);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        if (!pending.delete(requestId)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error && operation === "connect") {
          lateConnections.set(requestId, clock.monotonicMs() + 30000);
          // A timeout ends the physical attempt too, before a retry can reuse
          // the same BluetoothDevice. Late-result cleanup remains a fallback.
          try {
            send("wanx:setup:transport", {
              requestId: randomUUID(), operation: "cancelConnect", args: [requestId],
            });
          } catch { /* Renderer teardown cannot prevent settling the caller. */ }
        }
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(
        () =>
          finish(
            localFailure(
              operation === "request"
                ? "GATT_FRAGMENT_INCOMPLETE"
                : "LOCAL_CONNECT_TIMEOUT",
            ),
          ),
        // Allow the renderer's 30-second GATT request to finish (including all
        // token fragments) before the IPC fallback fires. Connect/read/close
        // retain their shorter deadline.
        operation === "request" ? 35_000 : timeoutMs,
      );
      pending.set(requestId, { operation, finish });
      signal?.addEventListener("abort", abort, { once: true });
      try {
      send("wanx:setup:transport", { requestId, operation, args });
      } catch {
        finish(localFailure("LOCAL_TRANSPORT_DISCONNECTED"));
      }
    });
  };
  const transportFactory = {
    async connect(candidate, signal) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        await beforeConnect();
      } catch {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        throw localFailure("LOCAL_CONNECT_TIMEOUT");
      }
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const id = await rpc("connect", [candidate], signal);
      if (!text(id)) throw failure("PROTOCOL_CHANGED");
      if (signal.aborted) {
        await rpc("close", [id]).catch(() => {});
        throw new DOMException("Aborted", "AbortError");
      }
      let closed = false;
      const active = () => {
        if (closed) throw failure("LOCAL_TRANSPORT_DISCONNECTED");
      };
      return {
        kind: "ble-gatt",
        capabilities: { statusNotifications: true },
        async readDeviceInfo(caller) {
          active();
          return bytes(await rpc("readDeviceInfo", [id], caller), 512);
        },
        async request(frame, match, caller) {
          active();
          if (!(frame instanceof Uint8Array) || frame.length > 2048)
            throw failure("PROTOCOL_CHANGED");
          return bytes(
            await rpc("request", [id, Array.from(frame), match], caller),
            2048,
          );
        },
        async subscribeStatus(listener, caller) {
          active();
          const clear = () => subscriptions.delete(id);
          subscriptions.set(id, listener);
          try {
            await rpc("subscribeStatus", [id], caller);
          } catch (error) {
            clear();
            throw error;
          }
          caller.addEventListener("abort", clear, { once: true });
          return async () => {
            clear();
            caller.removeEventListener("abort", clear);
          };
        },
        async close() {
          if (closed) return;
          closed = true;
          subscriptions.delete(id);
          await rpc("close", [id]).catch(() => {});
        },
      };
    },
  };
  const resultListener = (event, value) => {
    if (
      !trusted(event) ||
      !plain(value) ||
      !text(value.requestId) ||
      typeof value.ok !== "boolean"
    )
      return;
    try {
      bounded(value);
    } catch {
      return;
    }
    for (const [id, expiry] of lateConnections)
      if (clock.monotonicMs() > expiry) lateConnections.delete(id);
    const entry = pending.get(value.requestId);
    if (!entry) {
      if (
        lateConnections.delete(value.requestId) &&
        value.ok &&
        text(value.value)
      )
        void rpc("close", [value.value]).catch(() => {});
      return;
    }
    const code = codeOf(value);
    entry.finish(
      value.ok
        ? undefined
        : /^(?:LOCAL_|GATT_)/.test(code)
          ? localFailure(code)
          : failure(code),
      value.value,
    );
  };
  const statusListener = (event, value) => {
    if (!trusted(event) || !plain(value) || !text(value.connectionId)) return;
    const listener = subscriptions.get(value.connectionId);
    if (!listener) return;
    try {
      bounded(value);
      listener(bytes(value.frame, 2048));
    } catch {
      void reset("renderer_crash").catch(() => {});
    }
  };
  ipcMain.on("wanx:setup:transport-result", resultListener);
  ipcMain.on("wanx:setup:transport-status", statusListener);

  async function release(current, reason) {
    if (!current) return;
    current.abort.abort();
    current.unsubscribe?.();
    await current.coordinator.suspend(reason).catch(() => {});
    await current.coordinator.dispose().catch(() => {});
  }
  function reset(reason = "app_background") {
    if (resetting) return resetting;
    resetting = (async () => {
      const current = context;
      context = undefined;
      ++generation;
      subscriptions.clear();
      await release(current, reason);
      // A failed/late connect may not yet have entered the coordinator's transport.
      await rpc("closeAll", []).catch(() => {});
      publish();
      return state();
    })().finally(() => {
      resetting = undefined;
    });
    return resetting;
  }
  async function check(current) {
    if (!current || context !== current || disposed || disposing)
      throw failure("CLAIM_INVALID_STATE");
    let session;
    try {
      session = await consumer.current();
    } catch (error) {
      void reset().catch(() => {});
      throw error;
    }
    if (
      context !== current ||
      session.accountId !== current.accountId ||
      session.clientId !== current.clientId
    ) {
      if (context === current) void reset().catch(() => {});
      throw failure("AUTH_SESSION_CHANGED");
    }
    return current;
  }
  function claimPreviewId(current) {
    const preview = current.coordinator.getSnapshot();
    const deviceId = (preview.preview ?? preview.compatiblePreview)?.device_id;
    if (
      !rendererActive ||
      webContents.isDestroyed?.() ||
      webContents.mainFrame?.url !== documentUrl ||
      current.abort.signal.aborted ||
      preview.state !== "previewReady" ||
      typeof deviceId !== "string" ||
      !/^[A-Za-z0-9._-]{1,36}$(?![\s\S])/u.test(deviceId)
    )
      throw failure("CLAIM_INVALID_STATE");
    return deviceId;
  }
  function createContext(session, pairing, mode = 'claim') {
    const current = {
      mode,
      accountId: session.accountId,
      clientId: session.clientId,
      abort: new AbortController(),
    };
    const consumerApi = {};
    for (const method of [
      "preparePairing",
      "getDeviceAttestation",
      "provePairing",
      "cancelPairing",
      "getPairing",
      "syncBootstrap",
      "getOwnerWifiAttestation",
      "authorizeOwnerWifi",
    ]) {
      consumerApi[method] = async (...args) => {
        try {
          await check(current);
          const result = await pairing[method](...args);
          await check(current);
          return result;
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          throw core
            ? new core.ClaimCoordinatorFailure(
                codeOf(error),
                ["REQUEST_TIMEOUT", "ACCOUNT_SERVICE_UNAVAILABLE"].includes(
                  error?.code,
                ),
              )
            : error;
        }
      };
    }
    current.coordinator = (mode === 'wifi' ? makeOwnerWifiCoordinator : makeCoordinator)({
      transportFactory,
      crypto: makeCrypto({ trustedRootCertificatesPem }),
      consumerApi,
      resumeStore,
      trustedRootSpkiPins,
      clock,
      clientVersion: "wanx-client/0.1.0",
    });
    current.unsubscribe = current.coordinator.subscribe(() => {
      if (context === current) publish();
    });
    return current;
  }
  async function invoke(method, argument) {
    const current = await check(context);
    if (current.suspending) await current.suspending;
    await check(current);
    if (current.mode === 'wifi' && !['confirmPhysicalDevice', 'provideWifi'].includes(method))
      throw failure('CLAIM_INVALID_STATE');
    if (method === "confirmPhysicalDevice") {
      const value = current.coordinator.getSnapshot();
      const preview = value.preview ?? value.compatiblePreview;
      if (value.state !== "previewReady") throw failure("CLAIM_INVALID_STATE");
      // Discovery also exposes read-only previews outside pairing mode. Do not
      // attempt hello, device proof or account claim for these candidates.
      if (preview?.cloud_enrollment_status === "not_enrolled") throw failure("DEVICE_NOT_ENROLLED");
      if (preview?.cloud_enrollment_status !== "ready" ||
        !Number.isInteger(preview.pairing_mode_remaining_seconds)) throw failure("PROTOCOL_CHANGED");
      if (current.mode !== 'wifi' && preview.pairing_mode_remaining_seconds <= 0) throw failure("PAIRING_MODE_CLOSED");
    }
    await current.coordinator[method](
      ...(argument === undefined ? [current.abort.signal] : [argument]),
    );
    await check(current);
    return state();
  }
  const api = {
    state,
    subscribe(listener) {
      if (typeof listener !== "function") throw failure("INVALID_REQUEST");
      stateListeners.add(listener);
      listener(state());
      return () => stateListeners.delete(listener);
    },
    async begin(value) {
      if (disposed || disposing) throw failure("CLAIM_INVALID_STATE");
      if (beginning) throw failure("CLAIM_OPERATION_IN_PROGRESS");
      const mode = value?.mode ?? 'claim';
      if (!['claim', 'wifi'].includes(mode)) throw failure('INVALID_REQUEST');
      const candidate = selected(plain(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'mode')) : value);
      beginning = true;
      try {
        if (resetting) await resetting;
        rendererActive = true;
        const expected = ++generation;
        const previous = context;
        context = undefined;
        subscriptions.clear();
        // The new chooser has already issued its one-use selection lease.
        // Retire only the old coordinator's connections: closeAll also revokes
        // the renderer's newly selected lease. Late connects are closed by the
        // existing request-ID cleanup in resultListener.
        await release(previous, "app_background");
        if (disposed || disposing || generation !== expected)
          throw failure("STALE_GENERATION");
        const session = await consumer.current();
        if (disposed || disposing || generation !== expected)
          throw failure("STALE_GENERATION");
        if (previous && (previous.accountId !== session.accountId ||
            previous.clientId !== session.clientId)) {
          await reset();
          throw failure("AUTH_SESSION_CHANGED");
        }
        const pairing = await consumer.pairingApi();
        if (disposed || disposing || generation !== expected)
          throw failure("STALE_GENERATION");
        const current = createContext(session, pairing, mode);
        context = current;
        await current.coordinator.begin(
          {
            selected: candidate,
            accountId: current.accountId,
            clientId: current.clientId,
            clientPlatform:
              { darwin: "macos", win32: "windows", linux: "linux" }[
                process.platform
              ] || "unknown",
          },
          current.abort.signal,
        );
        await check(current);
        return state();
      } finally {
        beginning = false;
      }
    },
    async resume(value = {}) {
      if (disposed || disposing) throw failure("CLAIM_INVALID_STATE");
      if (resuming || beginning) throw failure("CLAIM_OPERATION_IN_PROGRESS");
      if (!plain(value) || Object.keys(value).some((key) => !["deviceId", "pairingSessionId"].includes(key)) ||
          (value.deviceId !== undefined && !text(value.deviceId, 36)) ||
          (value.pairingSessionId !== undefined && !text(value.pairingSessionId, 64)))
        throw failure("INVALID_REQUEST");
      resuming = true;
      try {
        if (resetting) await resetting;
        if (context) await reset();
        rendererActive = true;
        const session = await consumer.current();
        const records = await resumeStore.load(session.accountId);
        const record = records
          .filter((item) =>
            (value.deviceId === undefined || item.deviceId === value.deviceId) &&
            (value.pairingSessionId === undefined || item.pairingSessionId === value.pairingSessionId))
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
        if (!record) return state();
        const pairing = await consumer.pairingApi();
        const current = createContext(session, pairing);
        context = current;
        await current.coordinator.resume(record, current.abort.signal);
        await check(current);
        return state();
      } catch (error) {
        if (context) await reset("resume_failed").catch(() => {});
        throw error;
      } finally {
        resuming = false;
      }
    },
    async redeemClaimCode(code) {
      if (
        typeof code !== "string" ||
        !/^(?:[A-Z2-7]{10}|[A-Z2-7]{20})$(?![\s\S])/u.test(code)
      )
        throw failure("INVALID_REQUEST");
      if (claimPending) throw failure("CLAIM_OPERATION_IN_PROGRESS");
      claimPending = true;
      try {
        const current = await check(context);
        if (current.mode === 'wifi') throw failure('CLAIM_INVALID_STATE');
        const deviceId = claimPreviewId(current);
        if (typeof redeemConsoleClaim !== "function")
          throw failure("CONSOLE_CLAIM_UNAVAILABLE");
        await check(current);
        if (claimPreviewId(current) !== deviceId)
          throw failure("CLAIM_INVALID_STATE");
        const result = await redeemConsoleClaim(code, deviceId, {
          accountId: current.accountId,
          clientId: current.clientId,
          signal: current.abort.signal,
        });
        await check(current);
        if (claimPreviewId(current) !== deviceId)
          throw failure("CLAIM_INVALID_STATE");
        if (
          !plain(result) ||
          result.deviceId !== deviceId ||
          !["deviceAckPending", "ready", "blocked"].includes(
            result.authorizationState,
          )
        )
          throw failure("CONTRACT_MISMATCH");
        return Object.freeze({
          deviceId,
          authorizationState: result.authorizationState,
        });
      } finally {
        claimPending = false;
      }
    },
    confirmPhysical: () => invoke("confirmPhysicalDevice"),
    async scanWifi() {
      const current = await check(context);
      if (current.coordinator.getSnapshot().state !== "awaitingWifi")
        throw failure("CLAIM_INVALID_STATE");
      if (!current.wifiScan) {
        const abort = new AbortController();
        const cancel = () => abort.abort();
        current.abort.signal.addEventListener("abort", cancel, { once: true });
        if (current.abort.signal.aborted) cancel();
        current.wifiScanAbort = abort;
        current.wifiScan = (async () => {
          const networks = await current.coordinator.scanWifi(abort.signal);
          await check(current);
          if (current.coordinator.getSnapshot().state !== "awaitingWifi")
            throw failure("CLAIM_INVALID_STATE");
          return networks;
        })().finally(() => {
          current.abort.signal.removeEventListener("abort", cancel);
          current.wifiScan = undefined;
          current.wifiScanAbort = undefined;
        });
      }
      return current.wifiScan;
    },
    async wifi(input) {
      if (!plain(input) || typeof input.ssid !== "string" || input.ssid.length > 32 ||
          !["open", "wpa_personal"].includes(input.security) ||
          (input.password !== undefined && typeof input.password !== "string") ||
          typeof input.hidden !== "boolean")
        throw failure("INVALID_REQUEST");
      const current = await check(context);
      if (current.wifiScan) {
        current.wifiScanAbort.abort();
        await current.wifiScan.catch(() => {});
        await check(current);
      }
      const passwordUtf8 = input.password === undefined
        ? undefined
        : new TextEncoder().encode(input.password);
      return invoke("provideWifi", {
        ssid: input.ssid,
        security: input.security,
        ...(passwordUtf8 ? { passwordUtf8 } : {}),
        hidden: input.hidden,
      });
    },
    confirmOwnership: () => invoke("confirmOwnership"),
    refresh: () => invoke("refreshAuthority"),
    async cancel() {
      const current = await check(context);
      current.abort.abort();
      await current.coordinator.cancel("user_cancelled");
      await check(current);
      return state();
    },
    reset: () => reset(),
    dispose() {
      if (disposing) return disposing;
      disposing = (async () => {
        if (disposed) return;
        if (resetting) await resetting;
        const current = context;
        context = undefined;
        ++generation;
        await release(current, "process_exit");
        await rpc("closeAll", []).catch(() => {});
        disposed = true;
        for (const entry of [...pending.values()])
          entry.finish(failure("LOCAL_TRANSPORT_DISCONNECTED"));
        pending.clear();
        lateConnections.clear();
        subscriptions.clear();
        stateListeners.clear();
        ipcMain.removeListener("wanx:setup:transport-result", resultListener);
        ipcMain.removeListener("wanx:setup:transport-status", statusListener);
        for (const method of METHODS)
          ipcMain.removeHandler(`wanx:setup:${method}`);
        webContents.removeListener("render-process-gone", crashed);
        webContents.removeListener("did-start-navigation", navigated);
        webContents.removeListener("destroyed", crashed);
      })();
      return disposing;
    },
  };
  for (const method of METHODS)
        ipcMain.handle(`wanx:setup:${method}`, async (event, value) => {
      if (!trusted(event) || disposing)
        return { ok: false, code: "IPC_ACCESS_DENIED" };
      try {
        bounded(value);
        return { ok: true, value: await api[method](value) };
      } catch (error) {
        return { ok: false, code: codeOf(error) };
      }
    });
  const crashed = () => {
    rendererActive = false;
    for (const entry of [...pending.values()])
      entry.finish(localFailure("LOCAL_TRANSPORT_DISCONNECTED"));
    subscriptions.clear();
    const current = context;
    const previous = current?.coordinator.getSnapshot();
    // A submitted claim belongs to Main, not the retiring renderer. Suspend
    // local transport and secrets, retaining the original cloud task to query.
    if (
      current &&
      current.mode !== 'wifi' &&
      (previous.pairingSessionId ||
        ["waitingCloud", "attentionRequired", "completed"].includes(
          previous.state,
        ))
    ) {
      current.suspending = current.coordinator
        .suspend("renderer_crash")
        .catch(() => {})
        .finally(() => {
          current.suspending = undefined;
          if (context === current) publish();
        });
    } else void reset("renderer_crash").catch(() => {});
  };
  const navigated = (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) crashed();
  };
  webContents.on("render-process-gone", crashed);
  webContents.on("did-start-navigation", navigated);
  webContents.on("destroyed", crashed);
  return api;
}
module.exports = { createProvisioningHost };
