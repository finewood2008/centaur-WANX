import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const fail = (code) => Object.assign(new Error(code), { code });
const applicationID = (value) => typeof value === "string" && /^[a-z][a-z0-9._-]{1,63}$/.test(value);
const deviceID = (value) => typeof value === "string" && /^[A-Za-z0-9._-]{1,36}$/.test(value) && ![".", ".."].includes(value);
const errorCode = (error) => {
  const code = error?.code || error?.message;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : "APPLICATION_OPERATION_FAILED";
};

// Main-process UI coordination only. Preferences are hints, never authorization.
export async function createUIState({
  client, account, applications, preferenceFile, serviceURL,
  onChanged = () => {}, onOpened = () => {}, onOperation = () => {},
}) {
  let preferences = { version: 1, lastDevices: {} };
  try {
    const saved = JSON.parse(await readFile(preferenceFile, "utf8"));
    if (saved?.version === 1 && saved.lastDevices && typeof saved.lastDevices === "object") {
      preferences.lastDevices = Object.fromEntries(Object.entries(saved.lastDevices).filter(([, id]) => deviceID(id)));
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw fail("UI_PREFERENCE_READ_FAILED");
  }
  const environment = new URL(serviceURL).href.replace(/\/$/, "");
  const operations = new Map();
  let intent = null, generation = 0, closed = false, writes = Promise.resolve();
  const identityKey = () => {
    const state = account.snapshot();
    if (state.phase !== "authenticated") return null;
    const identity = account.getIdentity?.() || state;
    return JSON.stringify([identity.accountId, identity.clientId]);
  };
  let identity = identityKey();
  const preferenceKey = () => {
    const state = account.snapshot();
    return state.phase === "authenticated" && state.accountId
      ? JSON.stringify([environment, state.accountId]) : null;
  };
  const snapshot = () => {
    const key = preferenceKey();
    return {
      lastDeviceId: key ? preferences.lastDevices[key] || null : null,
      pendingOpen: intent ? {
        id: intent.id, applicationId: intent.applicationId, deviceId: intent.deviceId,
        phase: intent.phase, ...(intent.error ? { error: intent.error } : {}),
      } : null,
      applicationOperations: Object.fromEntries([...operations].map(([id, operation]) => [id, {
        phase: operation.phase, ...(operation.error ? { error: operation.error } : {}),
      }])),
    };
  };
  const emit = () => { if (!closed) onChanged(snapshot()); };
  const assertOpen = () => { if (closed) throw fail("UI_STATE_CLOSED"); };
  const assertAccount = () => {
    assertOpen();
    if (!identityKey()) throw fail("ACCOUNT_LOGIN_REQUIRED");
  };
  const connected = (state) => state.account?.phase === "authenticated" &&
    state.phase === "ready" && deviceID(state.connection?.deviceId) &&
    (state.connection.mode === "local" || (state.network?.enabled !== false &&
      ["ready", "recovering"].includes(state.network?.phase) && state.platform?.phase === "ready" && state.connection.mode === "netbird"));
  const assertIntent = (current) => {
    assertOpen();
    if (current.generation !== generation || current.identity !== identityKey()) throw fail("ACCOUNT_SESSION_CHANGED");
    if (intent !== current) throw fail("APPLICATION_OPEN_CANCELLED");
  };
  const assertTarget = (current) => {
    assertIntent(current);
    const state = client.snapshot();
    if (!connected(state) || state.connection.deviceId !== current.deviceId) throw fail("NETWORK_CHANGED");
  };
  function invalidateOpen() {
    if (intent) { intent = null; emit(); }
    return snapshot();
  }
  function rememberConnection() {
    if (closed) return writes;
    const state = client.snapshot(), key = preferenceKey();
    if (!key || !connected(state) || state.account.accountId !== account.snapshot().accountId) return writes;
    const id = state.connection.deviceId;
    if (preferences.lastDevices[key] === id) return writes;
    preferences.lastDevices[key] = id;
    const contents = JSON.stringify(preferences);
    // A preference write failure must not turn a working connection into an error.
    writes = writes.then(async () => {
      const temporary = `${preferenceFile}.${randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(preferenceFile), { recursive: true, mode: 0o700 });
        await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
        await rename(temporary, preferenceFile);
      } finally { await unlink(temporary).catch(() => {}); }
    }).catch(() => {});
    emit();
    return writes;
  }
  async function runApplicationOperation(id, phase, operation) {
    assertOpen();
    if (!applicationID(id)) throw fail("INVALID_APPLICATION_ID");
    if (operations.has(id) && operations.get(id).phase !== "failed") throw fail("MARKET_OPERATION_BUSY");
    const current = { phase }, accountId = client.snapshot().account?.accountId;
    operations.set(id, current);
    emit();
    try {
      const value = await operation();
      if (operations.get(id) === current) operations.delete(id);
      if (!value?.canceled) { try { onOperation({ accountId, applicationId: id, phase, status: "succeeded" }); } catch { /* A notification must not fail an installation. */ } }
      return value;
    } catch (error) {
      if (operations.get(id) === current) operations.set(id, { phase: "failed", error: errorCode(error) });
      try { onOperation({ accountId, applicationId: id, phase, status: "failed" }); } catch { /* Preserve the original operation error. */ }
      throw error;
    } finally { emit(); }
  }
  async function openIntent(current, connect) {
    try {
      assertIntent(current);
      delete current.error;
      if (connect) {
        current.phase = "connecting";
        emit();
        await client.connectBox(current.deviceId);
      }
      // connectBox can resolve normally after being superseded or cancelled.
      assertTarget(current);
      void rememberConnection();
      current.phase = "opening";
      emit();
      const value = await runApplicationOperation(current.applicationId, "opening", () => {
        assertTarget(current);
        return applications.launch(current.applicationId);
      });
      assertTarget(current);
      if (value?.state !== "running") throw fail("APPLICATION_START_FAILED");
      intent = null;
      emit();
      onOpened(value);
      return value;
    } catch (error) {
      if (intent === current) {
        current.phase = "failed";
        current.error = errorCode(error);
        emit();
      }
      throw error;
    }
  }
  async function requestOpen(id) {
    assertAccount();
    if (!applicationID(id)) throw fail("INVALID_APPLICATION_ID");
    if (intent && ["connecting", "opening"].includes(intent.phase)) throw fail("APPLICATION_OPEN_BUSY");
    if (operations.has(id) && operations.get(id).phase !== "failed") throw fail("MARKET_OPERATION_BUSY");
    const state = client.snapshot();
    const ready = connected(state);
    const devices = state.devices || [];
    intent = {
      id: randomUUID(), applicationId: id,
      deviceId: ready ? state.connection.deviceId : snapshot().lastDeviceId || (devices.length === 1 ? devices[0].deviceId : null),
      phase: ready ? "opening" : "confirm", generation, identity: identityKey(),
    };
    emit();
    return ready ? openIntent(intent, false) : snapshot().pendingOpen;
  }
  async function confirmOpen({ intentId, deviceId } = {}) {
    assertAccount();
    const current = intent;
    if (!current || current.id !== intentId) throw fail("APPLICATION_OPEN_NOT_PENDING");
    if (!["confirm", "failed"].includes(current.phase)) throw fail("APPLICATION_OPEN_BUSY");
    if (!deviceID(deviceId)) throw fail("INVALID_DEVICE_ID");
    const state = client.snapshot();
    if (!(state.devices || []).some(device => device.deviceId === deviceId)) throw fail("NETWORK_DEVICE_ACCESS_DENIED");
    current.deviceId = deviceId;
    return openIntent(current, !(connected(state) && state.connection.deviceId === deviceId));
  }
  async function cancelOpen({ intentId } = {}) {
    const current = intent;
    if (!current || (intentId && intentId !== current.id)) return snapshot();
    const state = client.snapshot();
    invalidateOpen();
    if (current.phase === "connecting" && (!state.connection?.deviceId || state.connection.deviceId === current.deviceId)) {
      await client.disconnect();
    } else if (current.phase === "opening") {
      await applications.stop(current.applicationId);
    }
    return snapshot();
  }
  const unsubscribeAccount = account.subscribe(() => {
    const next = identityKey();
    if (!next || next !== identity) {
      generation++;
      intent = null;
      operations.clear();
    }
    identity = next;
    emit();
  });
  const unsubscribeClient = client.subscribe(() => { void rememberConnection(); });
  void rememberConnection();
  return Object.freeze({
    snapshot, requestOpen, confirmOpen, cancelOpen, invalidateOpen,
    dismissPanel() { return intent?.phase === "confirm" ? invalidateOpen() : snapshot(); },
    runApplicationOperation, rememberConnection,
    async dispose() {
      if (!closed) {
        closed = true;
        intent = null;
        operations.clear();
        unsubscribeAccount();
        unsubscribeClient();
      }
      await writes;
    },
  });
}
