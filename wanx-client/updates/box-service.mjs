import { randomUUID } from "node:crypto";
import { digestPayload, errorCode, updateError, verifyRelease } from "./contracts.mjs";

const prefix = "/app-api/v1/upgrades";
const id = value => {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw updateError("UPDATE_INVALID_INPUT");
  return value;
};
const initial = deviceId => ({ deviceId, phase: deviceId ? "unknown" : "no_device", inventory: null,
  candidate: null, plan: null, operation: null, canUpgrade: false, checkedAt: null, reason: deviceId ? "INVENTORY_UNKNOWN" : null, blockers: [] });
const baseline = inventory => ({ deviceId: inventory.deviceId, ownershipEpoch: inventory.ownershipEpoch,
  platform: inventory.platform, components: inventory.components });

export async function createBoxUpdates({ request, getScope, captureSession, keys = {}, store, now = Date.now }) {
  let saved, stateInvalid = false;
  try { saved = store ? await store.load() : { schemaVersion: 1, sequences: {} };
    if (saved.schemaVersion !== 1 || !saved.sequences) throw updateError("UPDATE_STATE_INVALID");
  } catch { saved = { schemaVersion: 1, sequences: {} }; stateInvalid = true; }
  saved.idempotency ||= {};
  let scope, epoch = 0, state = initial(null), offer, closed = false, active;
  const listeners = new Set();
  const snapshot = () => structuredClone(state);
  function publish(patch) { state = { ...state, ...patch }; for (const listener of listeners) listener(snapshot()); }
  function sync() {
    const next = getScope();
    const key = JSON.stringify(next);
    if (key !== scope) { scope = key; epoch++; offer = null; state = initial(next?.deviceId || null); publish({}); }
  }
  function context(input = {}) {
    sync(); const selected = getScope();
    if (!selected?.accountId) throw updateError("ACCOUNT_LOGIN_REQUIRED");
    if (!selected.deviceId) throw updateError("BOX_CONNECTION_REQUIRED");
    if (input.deviceId !== undefined && input.deviceId !== selected.deviceId) throw updateError("PLAN_STALE");
    const captured = epoch, assertSession = captureSession();
    const check = () => {
      sync(); assertSession();
      if (closed || captured !== epoch) throw updateError("UPDATE_SESSION_CHANGED");
    };
    check(); return { check, deviceId: id(selected.deviceId), accountId: selected.accountId };
  }
  async function run(input, operation) {
    const contextValue = context(input);
    if (active) throw updateError("UPDATE_IN_PROGRESS");
    const captured = epoch;
    const task = Promise.resolve().then(() => operation(contextValue)); active = task;
    try { return await task; }
    catch (error) { if (!closed && captured === epoch) publish({ phase: "failed", reason: errorCode(error) }); throw error; }
    finally { if (active === task) active = null; }
  }
  function acceptOperation(value, deviceId) {
    if (!value || value.deviceId !== deviceId || !["queued", "prechecking", "downloading", "staged", "waiting_window", "applying", "verifying", "succeeded", "rolling_back", "rolled_back", "failed", "needs_attention", "cancelled"].includes(value.state) ||
        !Array.isArray(value.allowedActions) || !Number.isSafeInteger(value.attemptGeneration) || value.attemptGeneration < 1 ||
        !Number.isSafeInteger(value.lastSequence) || value.lastSequence < 0) throw updateError("UPDATE_INVALID_RESPONSE");
    id(value.operationId);
    const previous = state.operation;
    if (previous?.operationId === value.operationId &&
        (value.attemptGeneration < previous.attemptGeneration || value.attemptGeneration === previous.attemptGeneration && value.lastSequence < previous.lastSequence))
      throw updateError("UPDATE_STALE_RESPONSE");
    publish({ operation: value, phase: ["succeeded", "rolled_back", "cancelled"].includes(value.state) ? "idle" : ["failed", "needs_attention"].includes(value.state) ? "failed" : "executing", reason: value.errorCode || null });
  }
  sync();
  return {
    snapshot, sync,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    invalidate() { scope = undefined; sync(); },
    check(input = {}) { return run(input, async ({ check, deviceId }) => {
      publish({ phase: "checking", plan: null, reason: null }); offer = null;
      const result = await request({ method: "GET", path: `${prefix}/devices/${deviceId}` }); check();
      const inventory = result?.inventory;
      if (inventory && (inventory.deviceId !== deviceId || inventory.schemaVersion !== 1 || !inventory.components)) throw updateError("UPDATE_INVALID_RESPONSE");
      const previous = state.inventory;
      if (previous && inventory && inventory.reportSequence < previous.reportSequence) throw updateError("UPDATE_STALE_RESPONSE");
      const stale = !inventory || !Number.isFinite(Date.parse(inventory.observedAt)) || now() - Date.parse(inventory.observedAt) > 15 * 60 * 1000 || Date.parse(inventory.observedAt) > now() + 60000;
      let reason = !inventory ? "INVENTORY_UNKNOWN" : stale ? "INVENTORY_STALE" : null;
      let candidate = null;
      if (result.candidate?.release && Object.keys(keys).length) {
        const verified = verifyRelease(result.candidate.release, { keys, product: "wanx-box", now: now() });
        if (verified.digest !== result.candidate.releaseDigest) throw updateError("UPDATE_INVALID_RELEASE");
        offer = verified;
        candidate = { status: result.candidate.status, release: { payload: verified.release }, releaseDigest: verified.digest,
          ...(result.candidate.reasonCode ? { reasonCode: result.candidate.reasonCode } : {}) };
      } else if (result.candidate?.release) reason ||= "UPDATE_NOT_CONFIGURED";
      if (result.candidate?.status === "blocked") reason ||= result.candidate.reasonCode || "RELEASE_UNAVAILABLE";
      publish({ inventory: inventory || null, candidate, canUpgrade: result.canUpgrade === true, checkedAt: new Date(now()).toISOString(), reason,
        phase: reason ? "blocked" : candidate && result.candidate?.status === "available" ? "available" : "idle", operation: result.activeOperation || state.operation });
      if (result.activeOperation) acceptOperation(result.activeOperation, deviceId);
      return snapshot();
    }); },
    plan(input = {}) { return run(input, async ({ check, deviceId }) => {
      if (!state.canUpgrade) throw updateError("UPDATE_PERMISSION_REQUIRED");
      if (stateInvalid) throw updateError("UPDATE_STATE_INVALID");
      if (!offer || state.phase !== "available" || input.releaseId !== offer.release.releaseId) throw updateError("PLAN_STALE");
      publish({ phase: "planning", plan: null, reason: null });
      const result = await request({ method: "POST", path: `${prefix}/plans`, body: { deviceId, releaseId: input.releaseId } }); check();
      const { planDigest, ...plan } = result || {};
      const verified = verifyRelease(plan.release, { keys, product: "wanx-box", now: now() });
      if (plan.schemaVersion !== 1 || plan.deviceId !== deviceId || plan.releaseId !== offer.release.releaseId ||
          plan.releaseDigest !== offer.digest || verified.digest !== offer.digest || digestPayload(plan) !== planDigest ||
          digestPayload(plan.baseline) !== plan.baselineDigest || digestPayload(baseline(state.inventory)) !== plan.baselineDigest ||
          !Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= now() || plan.dataPolicy !== "backward-compatible" ||
          plan.impact?.dataMigration !== false) throw updateError("PLAN_STALE");
      if (verified.release.requiredExtensions?.includes("wanx.foundation-modules.v1")) {
        const changed = ["discovery", "p2p", "wanx", "semantica"].filter(name => verified.release.components[name] &&
          verified.release.components[name].sha256 !== plan.baseline.components[name]?.artifactDigest);
        if (!changed.length || JSON.stringify(plan.steps) !== JSON.stringify(changed)) throw updateError("PLAN_STALE");
      }
      id(plan.planId);
      publish({ phase: "planned", plan: { ...plan, planDigest }, reason: null });
      return snapshot();
    }); },
    execute(input = {}) { return run(input, async ({ check, deviceId, accountId }) => {
      if (!state.canUpgrade) throw updateError("UPDATE_PERMISSION_REQUIRED");
      if (stateInvalid) throw updateError("UPDATE_STATE_INVALID");
      const plan = state.plan;
      if (input.confirmed !== true) throw updateError("UPDATE_CONFIRMATION_REQUIRED");
      if (!plan || input.planId !== plan.planId || plan.deviceId !== deviceId || Date.parse(plan.expiresAt) <= now()) throw updateError("PLAN_STALE");
      const key = digestPayload({ accountId, deviceId, planDigest: plan.planDigest });
      saved.idempotency[key] ||= randomUUID();
      await store?.save(saved); check();
      const operation = await request({ method: "POST", path: `${prefix}/operations`, body: {
        planId: plan.planId, planDigest: plan.planDigest, idempotencyKey: saved.idempotency[key], maintenanceConfirmed: true,
      } }); check();
      if (operation.planId !== plan.planId || operation.planDigest !== plan.planDigest) throw updateError("UPDATE_INVALID_RESPONSE");
      acceptOperation(operation, deviceId);
      return snapshot();
    }); },
    status(input = {}) { return run(input, async ({ check, deviceId }) => {
      if (state.operation?.operationId !== input.operationId) throw updateError("PLAN_STALE");
      const operation = await request({ method: "GET", path: `${prefix}/operations/${id(input.operationId)}` }); check();
      acceptOperation(operation, deviceId);
      if (["succeeded", "rolled_back"].includes(operation.state)) {
        const latest = await request({ method: "GET", path: `${prefix}/devices/${deviceId}` }); check();
        if (latest?.inventory?.deviceId !== deviceId || latest.inventory.schemaVersion !== 1 || !latest.inventory.components ||
            latest.inventory.reportSequence < (state.inventory?.reportSequence || 0)) throw updateError("UPDATE_STALE_RESPONSE");
        publish({ inventory: latest.inventory, canUpgrade: latest.canUpgrade === true, checkedAt: new Date(now()).toISOString() });
      }
      return snapshot();
    }); },
    ...Object.fromEntries(["cancel", "resume"].map(action => [action, (input = {}) => run(input, async ({ check, deviceId }) => {
      if (!state.canUpgrade) throw updateError("UPDATE_PERMISSION_REQUIRED");
      if (state.operation?.operationId !== input.operationId || !state.operation.allowedActions.includes(action)) throw updateError("UPDATE_ACTION_NOT_ALLOWED");
      if (action === "resume" && input.confirmed !== true) throw updateError("UPDATE_CONFIRMATION_REQUIRED");
      const operation = await request({ method: "POST", path: `${prefix}/operations/${id(input.operationId)}/${action}`, body: {} }); check();
      acceptOperation(operation, deviceId); return snapshot();
    })])),
    close() { closed = true; epoch++; listeners.clear(); },
  };
}
