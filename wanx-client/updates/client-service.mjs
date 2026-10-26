import semver from "semver";
import { clientBlockers, clientRequirement, digestPayload, errorCode, updateError, verifyRelease } from "./contracts.mjs";
import { isTestClientIdentity } from "./test-build.mjs";

export async function createClientUpdates({ current, request, applications, keys = {}, store,
  createAdapter, requestInstall, installationId, captureSession = () => () => {}, now = Date.now }) {
  let persisted, stateInvalid = false;
  try {
    persisted = await store.load();
    if (persisted.schemaVersion !== 1 || !persisted.sequences || typeof persisted.sequences !== "object") throw updateError("UPDATE_STATE_INVALID");
  } catch {
    stateInvalid = true;
    persisted = { schemaVersion: 1, sequences: {}, operation: null };
  }
  let phase = !current.packaged ? "development" : current.distributionClass !== "formal" && !isTestClientIdentity(current) || !Object.keys(keys).length ? "unavailable" : "idle";
  if (stateInvalid) phase = "unavailable";
  const unsupportedInstallation = current.packaged && current.platform === "win32" && current.installationScope !== "per-user";
  if (unsupportedInstallation) phase = "unavailable";
  const initialReason = stateInvalid ? "UPDATE_STATE_INVALID" : unsupportedInstallation ? "UPDATE_INSTALL_LOCATION_UNSUPPORTED" : phase === "development" ? "UPDATE_DEVELOPMENT_BUILD" : phase === "unavailable" ? "UPDATE_NOT_CONFIGURED" : null;
  const requirementFor = envelope => clientRequirement(envelope, { current, keys, now: now() });
  let requirement = null;
  if (!initialReason && persisted.mandatoryRelease) {
    try { requirement = requirementFor(persisted.mandatoryRelease); }
    catch { persisted.mandatoryRelease = null; }
  }
  let state = { current, phase, reason: initialReason, candidate: null, checkedAt: null, progress: null, blockers: [], lastResult: null, requirement };
  let target, downloaded, adapter, active, generation = 0, closed = false;
  let controller = new AbortController();
  const listeners = new Set();
  const currentRequirement = () => state.requirement && Date.parse(persisted.mandatoryRelease?.payload?.expiresAt) > now()
    ? state.requirement : null;
  const snapshot = () => structuredClone({ ...state, requirement: currentRequirement() });
  function publish(patch) { state = { ...state, ...patch }; for (const listener of listeners) listener(snapshot()); }
  function context() {
    const session = captureSession(), epoch = generation;
    const check = () => { session(); if (closed || epoch !== generation) throw updateError("UPDATE_SESSION_CHANGED"); };
    check.signal = AbortSignal.any([controller.signal, ...(session.signal ? [session.signal] : [])]);
    check(); return check;
  }
  function configured() {
    if (initialReason) throw updateError(initialReason);
    if (closed) throw updateError("UPDATE_CLOSED");
  }
  async function run(operation) {
    if (active) throw updateError("UPDATE_IN_PROGRESS");
    const task = Promise.resolve().then(operation);
    active = task;
    try { return await task; }
    catch (error) {
      if (persisted.operation?.phase === "installing" && state.phase === "installing") {
        persisted.operation = { ...persisted.operation, phase: "failed", errorCode: errorCode(error) };
        await store.save(persisted);
      }
      if (!closed && errorCode(error) !== "UPDATE_SESSION_CHANGED" && errorCode(error) !== "MARKET_SESSION_CHANGED")
        publish({ phase: initialReason ? phase : "failed", reason: errorCode(error), progress: null });
      throw error;
    } finally { if (active === task) active = null; }
  }
  const applicationBaseline = installed => digestPayload(installed.map(app => ({
    applicationId: app.applicationId, version: app.version || null,
    artifactId: app.artifactId || null, selectionRequired: Boolean(app.selectionRequired),
  })).sort((a, b) => a.applicationId.localeCompare(b.applicationId)));
  async function applyRequirement(result, check) {
    // Missing means an older server or a temporarily unavailable candidate;
    // only an explicit, authenticated null revokes a previously known policy.
    if (!Object.hasOwn(result, "mandatoryRelease")) return;
    if (result.mandatoryRelease !== null && (typeof result.mandatoryRelease !== "object" || Array.isArray(result.mandatoryRelease)))
      throw updateError("UPDATE_INVALID_RESPONSE");
    const next = requirementFor(result.mandatoryRelease);
    persisted.mandatoryRelease = next ? result.mandatoryRelease : null;
    await store.save(persisted); check();
    publish({ requirement: next });
  }
  async function query(check, fixedTarget) {
    const installed = await applications.listInstalled(); check();
    const result = await request({ method: "POST", path: "/app-api/v1/upgrades/candidates", body: {
      product: "wanx-client", channel: current.channel,
      platform: { os: current.platform, arch: current.arch, osVersion: current.osVersion },
      currentVersion: current.productVersion, currentBuildId: current.buildId,
      securityEpoch: current.securityEpoch, backendContract: 1, hostProtocol: current.hostProtocol,
      ...(fixedTarget ? { releaseId: fixedTarget.release.releaseId } : {}),
    } }); check();
    if (!result || !["available", "current", "blocked"].includes(result.status)) throw updateError("UPDATE_INVALID_RESPONSE");
    if (result.status === "blocked") {
      await applyRequirement(result, check);
      return { blocked: result.reasonCode || "RELEASE_UNAVAILABLE" };
    }
    const verified = verifyRelease(result.release, { keys, product: "wanx-client", now: now(), testIdentity: current });
    const { release, digest } = verified;
    if (result.releaseDigest !== digest || release.channel !== current.channel) throw updateError("UPDATE_INVALID_RELEASE");
    if (fixedTarget && (release.releaseId !== fixedTarget.release.releaseId || digest !== fixedTarget.digest))
      throw updateError("UPDATE_CANDIDATE_CHANGED");
    const scope = `${release.channel}:${current.platform}:${current.arch}`;
    const previous = persisted.sequences[scope];
    if (previous && (release.metadataSequence < previous.sequence ||
        release.metadataSequence === previous.sequence && digest !== previous.digest || release.securityEpoch < previous.securityEpoch))
      throw updateError("UPDATE_METADATA_REPLAY");
    persisted.sequences[scope] = { sequence: release.metadataSequence, digest, securityEpoch: release.securityEpoch };
    await store.save(persisted); check();
    await applyRequirement(!Object.hasOwn(result, "mandatoryRelease") && release.forceUpdate === true
      ? { mandatoryRelease: result.release } : result, check);
    const blockers = clientBlockers(release, current, installed);
    const required = currentRequirement();
    if (required && semver.lt(release.version, required.minimumVersion))
      blockers.push({ code: "CLIENT_UPDATE_REQUIRED" });
    return { ...verified, downloadUrls: result.downloadUrls || {}, blockers, baseline: applicationBaseline(installed) };
  }
  function presentation(release) {
    return { productVersion: release.version, buildId: release.buildId, releaseId: release.releaseId,
      releaseNotes: typeof release.releaseNotes === "string" ? release.releaseNotes.slice(0, 20000) : "",
      size: release.artifacts[0].sizeBytes, requiresRestart: true };
  }
  async function revalidate(check) {
    const checked = await query(check, target);
    if (!target || checked.blocked || checked.digest !== target.digest) throw updateError(checked.blocked || "UPDATE_CANDIDATE_CHANGED");
    if (checked.blockers.length) throw updateError(checked.blockers[0].code);
    return checked;
  }
  return {
    snapshot,
    assertUsable() { if (currentRequirement()?.required) throw updateError("CLIENT_UPDATE_REQUIRED"); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async ready() {
      const previous = persisted.operation;
      if (!previous) return snapshot();
      const matchesInstallation = previous.version === current.productVersion && previous.buildId === current.buildId && previous.installationId === installationId;
      if (previous.phase === "installing" && matchesInstallation) {
        // Called only after the new Host has initialized applications and UI.
        state.lastResult = { phase: "succeeded", releaseId: previous.releaseId, productVersion: current.productVersion, completedAt: new Date(now()).toISOString() };
        publish({ phase: "succeeded", lastResult: state.lastResult, reason: null });
        persisted.operation = { ...previous, phase: "succeeded", completedAt: state.lastResult.completedAt };
        await store.save(persisted);
      } else if (previous.phase !== "succeeded" || !matchesInstallation) {
        publish({ lastResult: { phase: "interrupted", releaseId: previous.releaseId, productVersion: previous.version }, reason: "UPDATE_RECOVERY_REQUIRED" });
      } else publish({ phase: "succeeded", lastResult: { phase: "succeeded", releaseId: previous.releaseId, productVersion: previous.version, completedAt: previous.completedAt } });
      return snapshot();
    },
    check() { return run(async () => {
      configured(); const check = context();
      publish({ phase: "checking", reason: null, blockers: [], progress: null });
      target = null; downloaded = null;
      const result = await query(check); check();
      const checkedAt = new Date(now()).toISOString();
      if (result.blocked) { publish({ phase: "blocked", reason: result.blocked, candidate: null, checkedAt }); return snapshot(); }
      target = result;
      const compared = semver.compare(result.release.version, current.productVersion);
      const reason = result.blockers[0]?.code || (compared < 0 ? "UPDATE_LOCAL_NEWER" : compared === 0 && result.release.buildId !== current.buildId ? "UPDATE_SAME_VERSION_BUILD" : null);
      publish({ phase: reason ? "blocked" : compared === 0 ? "up_to_date" : "available", reason,
        blockers: result.blockers, candidate: presentation(result.release), checkedAt });
      return snapshot();
    }); },
    download() { return run(async () => {
      configured(); const check = context();
      if (!target || !["available", "failed"].includes(state.phase) || semver.lte(target.release.version, current.productVersion)) throw updateError("UPDATE_NOT_AVAILABLE");
      const checked = await revalidate(check);
      adapter ||= await createAdapter(); check();
      publish({ phase: "downloading", reason: null, progress: { transferred: 0, total: target.release.artifacts[0].sizeBytes } });
      downloaded = await adapter.download(target.release, checked.downloadUrls, { signal: check.signal,
        onProgress(progress) {
          if (!closed && state.phase === "downloading") publish({ progress: { transferred: Math.max(0, Math.min(target.release.artifacts[0].sizeBytes, Math.floor(progress.transferred || 0))), total: target.release.artifacts[0].sizeBytes } });
        } }); check();
      target.baseline = checked.baseline;
      persisted.operation = { phase: "downloaded", releaseId: target.release.releaseId, releaseDigest: target.digest,
        version: target.release.version, buildId: target.release.buildId, installationId, startedAt: new Date(now()).toISOString() };
      await store.save(persisted); check();
      publish({ phase: "downloaded", reason: null, progress: null });
      return snapshot();
    }); },
    install(input) { return run(async () => {
      configured(); const check = context();
      if (input?.confirmed !== true) throw updateError("UPDATE_CONFIRMATION_REQUIRED");
      if (state.phase !== "downloaded" || !downloaded || !target) throw updateError("UPDATE_NOT_DOWNLOADED");
      const releaseMaintenance = applications.beginMaintenance();
      try {
        const checked = await revalidate(check);
        if (checked.baseline !== target.baseline) throw updateError("PLAN_STALE");
        await adapter.verify(downloaded.file, target.release); check();
        persisted.operation = { ...persisted.operation, phase: "installing" };
        await store.save(persisted); check();
        publish({ phase: "installing", reason: null });
        await requestInstall(() => adapter.install());
        return snapshot();
      } catch (error) { releaseMaintenance(); throw error; }
    }); },
    invalidate() {
      if (state.phase === "installing") return;
      generation++; controller.abort(updateError("UPDATE_SESSION_CHANGED")); controller = new AbortController();
      target = null; downloaded = null;
      const recovery = state.lastResult?.phase === "interrupted";
      publish({ phase: state.lastResult?.phase === "succeeded" ? "succeeded" : phase,
        reason: initialReason || (recovery ? "UPDATE_RECOVERY_REQUIRED" : null),
        candidate: null, checkedAt: null, blockers: [], progress: null });
    },
    close() {
      if (state.phase !== "installing") { closed = true; generation++; controller.abort(); }
      adapter?.close(); listeners.clear();
    },
  };
}
