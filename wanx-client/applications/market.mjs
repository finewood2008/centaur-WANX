import { mkdtemp, open, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { verifyEnvelope, marketFailure, validApplicationId, matchesApplicationTarget } from "./descriptor.mjs";
import { isComparableApplicationVersion } from "./manifest.mjs";
import { compareVersions, validateVersion } from "./version.mjs";
import { evaluateApplicationCompatibility } from "./compatibility.mjs";

export function createApplicationMarket({ request, applications, wanxVersion, platform = process.platform,
  arch = process.arch, trustedKeys = {}, fetch: fetcher = globalThis.fetch,
  captureSession = () => () => {}, temporaryRoot = os.tmpdir(), getCompatibilityContext, authorizeRelease } = {}) {
  validateVersion(wanxVersion);
  const targetOS = ({ darwin: "macos", win32: "windows", macos: "macos", windows: "windows" })[platform];
  const offers = new Map(), operations = new Set(), pending = new Set();
  const controller = new AbortController();
  function session() {
    const captured = captureSession();
    const check = () => { controller.signal.throwIfAborted(); captured(); };
    check.signal = AbortSignal.any([controller.signal, ...(captured.signal ? [captured.signal] : [])]);
    check();
    return check;
  }
  const assertId = (id) => { if (!validApplicationId(id)) throw marketFailure("INVALID_APPLICATION_ID"); };
  async function locked(id, operation) {
    assertId(id);
    if (operations.has(id)) throw marketFailure("MARKET_OPERATION_BUSY");
    operations.add(id);
    const task = Promise.resolve().then(operation);
    pending.add(task);
    try { return await task; } finally { operations.delete(id); pending.delete(task); }
  }
  async function resolveCandidate(id, assertSession) {
    assertId(id);
    assertSession();
    if (!targetOS || !["x64", "arm64"].includes(arch)) return { status: "incompatible", reason: "unsupported_platform" };
    const local = (await applications.listInstalled()).find((item) => item.applicationId === id);
    // A downloaded frontend whose box dependencies are still pending has no
    // current version. Keep offering the same signed artifact for preparation.
    const installed = local?.installationState === "pending" ? null : local;
    assertSession();
    if (installed?.selectionRequired) return { status: "incompatible", reason: "version_selection_required" };
    const comparable = installed && isComparableApplicationVersion(installed.version);
    const checkCompatibility = async descriptor => {
      const context = { clientVersion: wanxVersion, hostProtocol: 1,
        ...(descriptor.schemaVersion >= 2 ? await getCompatibilityContext?.({ manifest: descriptor.manifest, descriptor, phase: "candidate" }) : {}) };
      assertSession();
      return { context, compatibility: evaluateApplicationCompatibility(descriptor.manifest, context, { phase: "candidate" }) };
    };
    const query = async backendReadiness => {
      const body = {
      os: targetOS, arch, wanxVersion, hostProtocol: 1, supportedDescriptorSchemas: [1, 2, 3], supportsReleaseAccess: true,
      ...(backendReadiness ? { backendReadiness } : {}),
      ...(comparable ? { currentVersion: installed.version, ...(installed.artifactId ? { currentArtifactId: installed.artifactId } : {}) } : {}),
      };
      const input = { method: "POST", path: `/app-api/market/apps/${id}/candidate`, body };
      try { return await request(input); }
      catch (error) {
        if (error.status !== 422 || error.code !== "MARKET_RELEASE_CAPABILITY_UNSUPPORTED") throw error;
        assertSession();
        const { supportsReleaseAccess, ...legacy } = body;
        return request({ ...input, body: legacy });
      }
    };
    let result = await query();
    // A selected box can require a still-supported historical artifact. Catalog
    // evidence only selects bytes; each returned envelope is independently verified.
    for (let attempt = 0; attempt < 2; attempt++) {
    assertSession();
    if (!result || !["available", "up_to_date", "local_newer", "incompatible", "unavailable"].includes(result.status))
      throw marketFailure("MARKET_INVALID_RESPONSE");
    if (["incompatible", "unavailable"].includes(result.status)) return result;
    // Old schema1 services can return status only. A v2 installed application
    // must not become "up to date" without a signed target and current-box check.
    if (result.status !== "available" && !result.artifact?.envelope) {
      if (installed?.protocolVersion >= 2) throw marketFailure("MARKET_INVALID_RESPONSE");
      return result;
    }
    const descriptor = verifyEnvelope(result.artifact?.envelope, trustedKeys);
    if (descriptor.applicationId !== id || !matchesApplicationTarget(descriptor, targetOS, arch) ||
      descriptor.packageType !== "wanxapp" || descriptor.hostProtocol !== 1 || compareVersions(wanxVersion, descriptor.minWanxVersion) < 0 ||
      descriptor.artifactId !== result.artifact.artifactId || descriptor.version !== result.release?.version ||
      descriptor.sha256 !== result.artifact.sha256 || descriptor.size !== result.artifact.size ||
      result.artifact.status !== "ready" ||
      ["os", "arch", "packageType", "fileName"].some((key) => descriptor[key] !== result.artifact[key]))
      throw marketFailure("MARKET_INCOMPATIBLE");
    const { context, compatibility } = await checkCompatibility(descriptor);
    if (compatibility.status === "blocked") {
      if (attempt === 0 && context.backendRequired && context.backend) { result = await query(context.backend); continue; }
      return { status: "incompatible", reason: compatibility.checks[0].code, compatibility };
    }
    if (comparable) {
      const compared = compareVersions(descriptor.version, installed.version);
      if (compared < 0) {
        let recoveryRequired = result.selection === "compatible_history";
        if (!recoveryRequired && installed.protocolVersion >= 2) {
          const local = await checkCompatibility(verifyEnvelope(installed.envelope, trustedKeys));
          if (local.compatibility.status === "blocked") {
            if (attempt === 0 && local.context.backendRequired && local.context.backend) {
              result = await query(local.context.backend); continue;
            }
            recoveryRequired = true;
          }
        }
        if (recoveryRequired) return {
          ...result, status: "incompatible", reason: "compatible_history_requires_recovery", compatibility,
        };
      }
      const sameArtifact = installed.artifactId ? installed.artifactId === descriptor.artifactId : result.status === "up_to_date";
      if (compared <= 0) return {
        ...result, compatibility,
        status: compared < 0 ? "local_newer" : sameArtifact ? "up_to_date" : "incompatible",
        ...(compared === 0 && !sameArtifact ? { reason: "reinstall_required" } : {}),
      };
    }
    return { ...result, compatibility };
    }
  }
  async function download(descriptor, assertSession, destination) {
    if (descriptor.manifest.releaseAccess === "account") {
      if (!authorizeRelease) throw marketFailure("MARKET_RELEASE_ACCESS_REQUIRED");
      const permit = await authorizeRelease(descriptor, { signal: assertSession.signal });
      assertSession();
      if (!permit) throw marketFailure("MARKET_RELEASE_ACCESS_REQUIRED");
      permit.assertLive();
    }
    const link = await request({ method: "POST", path: `/app-api/market/artifacts/${descriptor.artifactId}/download`, body: {} });
    assertSession();
    let url;
    try { url = new URL(link.url); } catch { throw marketFailure("MARKET_INVALID_RESPONSE"); }
    if (link.artifactId !== descriptor.artifactId || url.protocol !== "https:" || url.username || url.password || url.hash)
      throw marketFailure("MARKET_INVALID_RESPONSE");
    const expires = typeof link.expiresAt === "string" ? Date.parse(link.expiresAt) : NaN;
    if (!Number.isFinite(expires) || expires <= Date.now()) throw marketFailure("MARKET_DOWNLOAD_EXPIRED");
    const response = await fetcher(link.url, { redirect: "error", signal: AbortSignal.any([assertSession.signal, AbortSignal.timeout(300000)]) });
    assertSession();
    if (!response.ok || response.redirected || !response.body) throw marketFailure("MARKET_DOWNLOAD_FAILED");
    const advertisedSize = response.headers?.get?.("content-length");
    if (advertisedSize !== null && advertisedSize !== undefined && Number(advertisedSize) !== descriptor.size)
      throw marketFailure("MARKET_PACKAGE_HASH_MISMATCH");
    const digest = createHash("sha256");
    const file = await open(destination, "wx", 0o600);
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        assertSession();
        bytes += chunk.length;
        if (bytes > descriptor.size) throw marketFailure("MARKET_PACKAGE_TOO_LARGE");
        digest.update(chunk);
        await file.writeFile(chunk);
      }
      assertSession();
      if (bytes !== descriptor.size || digest.digest("hex") !== descriptor.sha256) throw marketFailure("MARKET_PACKAGE_HASH_MISMATCH");
    } finally { await file.close(); }
  }
  return Object.freeze({
    async close() {
      controller.abort(marketFailure("MARKET_SESSION_CHANGED"));
      offers.clear();
      await Promise.allSettled([...pending]);
    },
    async list() {
      const assertSession = session();
      assertSession();
      const result = await request({ path: "/app-api/market/apps", method: "GET" });
      assertSession();
      if (!Array.isArray(result?.items)) throw marketFailure("MARKET_INVALID_RESPONSE");
      return result;
    },
    async candidate(id) {
      const assertSession = session();
      const result = await resolveCandidate(id, assertSession);
      if (result.status === "available") offers.set(id, { artifactId: result.artifact.artifactId, assertSession });
      else offers.delete(id);
      return result;
    },
    async install(id) {
      return locked(id, async () => {
        const assertSession = session(), offered = offers.get(id);
        assertSession();
        if (!offered) throw marketFailure("MARKET_CANDIDATE_CHANGED");
        offered.assertSession();
        const candidate = await resolveCandidate(id, assertSession);
        if (candidate.status !== "available") throw marketFailure("MARKET_UPDATE_NOT_AVAILABLE");
        if (candidate.artifact.artifactId !== offered.artifactId) throw marketFailure("MARKET_CANDIDATE_CHANGED");
        const descriptor = verifyEnvelope(candidate.artifact.envelope, trustedKeys);
        const temporary = await mkdtemp(path.join(temporaryRoot, "wanx-market-"));
        try {
          const archivePath = path.join(temporary, "application.wanxapp");
          await download(descriptor, assertSession, archivePath);
          assertSession();
          const result = await applications.installVerifiedPackage({ archivePath, envelope: candidate.artifact.envelope, descriptor, assertSession });
          offers.delete(id);
          return result;
        } finally { await rm(temporary, { recursive: true, force: true }); }
      });
    },
    async uninstall(id) {
      return locked(id, async () => {
        const assertSession = session();
        assertSession();
        const result = await applications.uninstall(id, assertSession);
        offers.delete(id);
        return result;
      });
    },
    async rollback(id) {
      return locked(id, async () => {
        const assertSession = session();
        assertSession();
        const result = await applications.rollback(id, assertSession);
        offers.delete(id);
        return result;
      });
    },
  });
}
