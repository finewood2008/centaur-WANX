import { createHash } from "node:crypto";

const fail = code => Object.assign(new Error(code), { code });
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_.:@-]{1,128}$/.test(value);
const registry = value => typeof value === "string" && /^centauros-(?:[0-9a-f]{24}|[0-9a-f]{32})$/.test(value);
const text = (value, max) => typeof value === "string" && value.trim() && [...value].length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const time = value => typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const immutableKeys = ["requestId", "deviceId", "identityDeviceId", "operatorId", "operatorName", "ownerBindingId", "ownershipEpoch", "reason", "scope", "durationMinutes", "createdAt", "requestExpiresAt"];

// Only this narrow projection crosses IPC. Never return generic platform data,
// credentials, or an operator-supplied URL to the renderer.
export function readSupportRequest(value, device, now = Date.now()) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.registryDeviceId !== device.deviceId ||
      !registry(value.identityDeviceId) || !["requestId", "deviceId", "operatorId", "ownerBindingId"].every(key => identifier(value[key])) ||
      !text(value.operatorName, 255) || !text(value.reason, 255) || value.scope !== "support.vnc" ||
      value.ownershipEpoch !== device.ownershipEpoch || !Number.isSafeInteger(value.durationMinutes) || value.durationMinutes < 1 || value.durationMinutes > 60 ||
      !time(value.createdAt) || !time(value.requestExpiresAt) || Date.parse(value.requestExpiresAt) <= Date.parse(value.createdAt) ||
      !/^[a-f0-9]{64}$/.test(value.requestDigest || "") || !Number.isSafeInteger(value.supportRevision) || value.supportRevision < 0 ||
      !["pending", "approved", "rejected", "expired", "cancelled"].includes(value.decision) ||
      !["none", "active", "revoked", "expired"].includes(value.authorization)) throw fail("SUPPORT_INVALID_RESPONSE");
  const immutable = Object.fromEntries([...immutableKeys].sort().map(key => [key, value[key]]));
  if (createHash("sha256").update(JSON.stringify(immutable)).digest("hex") !== value.requestDigest) throw fail("SUPPORT_INVALID_RESPONSE");
  if (value.decision === "approved" ? !identifier(value.supportSessionId) || !time(value.expiresAt) || !time(value.approvedAt) || value.authorization === "none"
      : value.authorization !== "none" || value.supportSessionId != null) throw fail("SUPPORT_INVALID_RESPONSE");
  const result = { ...immutable, registryDeviceId: value.registryDeviceId, requestDigest: value.requestDigest,
    decision: value.decision, authorization: value.authorization, supportRevision: value.supportRevision,
    supportSessionId: value.supportSessionId || null, expiresAt: value.expiresAt || null, approvedAt: value.approvedAt || null,
    observation: null, audit: [] };
  const observation = value.observation;
  if (observation && observation.supportRevision === value.supportRevision &&
      (observation.requestId === value.requestId || observation.requestId === null) &&
      (observation.supportSessionId === value.supportSessionId || observation.supportSessionId === null) &&
      time(observation.observedAt) && now - Date.parse(observation.observedAt) <= 30000 && Date.parse(observation.observedAt) <= now + 5000 &&
      ["waiting", "connected", "disconnected", "unknown"].includes(observation.connection) &&
      ["not_started", "running", "closed", "cleanup_failed", "unknown"].includes(observation.desktop)) {
    result.observation = Object.fromEntries(["supportRevision", "requestId", "supportSessionId", "observedAt", "connection", "desktop"].map(key => [key, observation[key]]));
  }
  if (Array.isArray(value.audit)) result.audit = value.audit.slice(-30).filter(event =>
    text(event.event, 80) && identifier(event.actorId) && time(event.at)).map(({ event, actorId, at }) => ({ event, actorId, at }));
  return result;
}

export function createRemoteSupport({ account, now = Date.now }) {
  let generation = 0, closed = false, identity = JSON.stringify(account.getIdentity());
  const active = new Set();
  const unsubscribe = account.subscribe(state => {
    const next = JSON.stringify(account.getIdentity());
    if (state.phase !== "authenticated" || next !== identity) { generation++; active.clear(); }
    identity = next;
  });
  function context(input, mutation) {
    const keys = mutation ? ["deviceId", "ownershipEpoch", "requestId", "requestDigest", "confirmed", ...(mutation === "decide" ? ["decision"] : ["supportSessionId"])] : ["deviceId"];
    if (!input || Object.keys(input).some(key => !keys.includes(key)) || !registry(input.deviceId)) throw fail("SUPPORT_INVALID_INPUT");
    if (mutation && (input.confirmed !== true || !Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1 ||
        !identifier(input.requestId) || !/^[a-f0-9]{64}$/.test(input.requestDigest || "") ||
        (mutation === "decide" ? !["approved", "rejected"].includes(input.decision) : !identifier(input.supportSessionId)))) throw fail("SUPPORT_INVALID_INPUT");
    if (!account.getIdentity() || account.snapshot().phase !== "authenticated") throw fail("ACCOUNT_LOGIN_REQUIRED");
    const captured = generation, capturedIdentity = identity;
    const check = () => {
      if (closed || generation !== captured || capturedIdentity !== JSON.stringify(account.getIdentity()) || account.snapshot().phase !== "authenticated") throw fail("SUPPORT_SESSION_CHANGED");
    };
    check(); return { check, captured };
  }
  async function run(input, mutation, action) {
    const { check, captured } = context(input, mutation);
    const deviceId = input.deviceId, key = `${captured}:${deviceId}`;
    if (active.has(key)) throw fail("SUPPORT_BUSY");
    active.add(key);
    try {
      // Fetch current cloud ownership even when there is no P2P/business session.
      const devices = await account.listDevices(); check();
      const device = devices.find(row => row.deviceId === deviceId);
      if (!device || device.role !== "owner" || device.status !== "active" || !Number.isSafeInteger(device.ownershipEpoch) || device.ownershipEpoch < 1) throw fail("OWNER_REQUIRED");
      if (mutation && device.ownershipEpoch !== input.ownershipEpoch) throw fail("OWNER_CHANGED");
      const prefix = `/app-api/devices/${encodeURIComponent(deviceId)}`;
      const current = readSupportRequest(await account.request({ path: `${prefix}/support-requests/current` }), device, now()); check();
      const result = await action({ device, current, prefix, check }); check();
      return { deviceId, ownershipEpoch: device.ownershipEpoch, request: result };
    } finally { active.delete(key); }
  }
  const matching = (input, current) => {
    if (!current || current.requestId !== input.requestId || current.requestDigest !== input.requestDigest ||
        current.ownershipEpoch !== input.ownershipEpoch) throw fail("SUPPORT_REQUEST_CHANGED");
  };
  async function mutate(input, kind) {
    return run(input, kind, async ({ device, current, prefix, check }) => {
      matching(input, current);
      if (kind === "decide" && (current.decision !== "pending" || Date.parse(current.requestExpiresAt) <= now())) throw fail("SUPPORT_REQUEST_CHANGED");
      if (kind === "revoke" && (current.supportSessionId !== input.supportSessionId || current.authorization !== "active")) throw fail("SUPPORT_REQUEST_CHANGED");
      const reply = await account.request(kind === "decide" ? { method: "POST", path: `${prefix}/support-requests/${encodeURIComponent(current.requestId)}/decision`,
        body: { decision: input.decision, requestDigest: current.requestDigest } } :
        { method: "DELETE", path: `${prefix}/support-sessions/${encodeURIComponent(current.supportSessionId)}` });
      check();
      const result = readSupportRequest(reply, device, now()); matching(input, result);
      if (result.supportRevision < current.supportRevision || (kind === "decide"
        ? result.decision !== input.decision || (input.decision === "approved" && result.authorization !== "active")
        : result.supportSessionId !== current.supportSessionId || !["revoked", "expired"].includes(result.authorization))) throw fail("SUPPORT_INVALID_RESPONSE");
      return result;
    });
  }
  return {
    current: input => run(input, null, ({ current }) => current),
    decide: input => mutate(input, "decide"),
    revoke: input => mutate(input, "revoke"),
    close() { closed = true; generation++; active.clear(); unsubscribe(); },
  };
}
