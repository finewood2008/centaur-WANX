import { mkdtemp, open, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { verifyEnvelope, marketFailure, validApplicationId } from "./descriptor.mjs";
import { compareVersions, validateVersion } from "./version.mjs";

export function createApplicationMarket({ request, applications, wanxVersion, platform = process.platform,
  arch = process.arch, trustedKeys = {}, fetch: fetcher = globalThis.fetch,
  captureSession = () => () => {}, temporaryRoot = os.tmpdir() } = {}) {
  validateVersion(wanxVersion);
  const targetOS = ({ darwin: "macos", win32: "windows", macos: "macos", windows: "windows" })[platform];
  const offers = new Map(), operations = new Set();
  const assertId = (id) => { if (!validApplicationId(id)) throw marketFailure("INVALID_APPLICATION_ID"); };
  async function locked(id, operation) {
    assertId(id);
    if (operations.has(id)) throw marketFailure("MARKET_OPERATION_BUSY");
    operations.add(id);
    try { return await operation(); } finally { operations.delete(id); }
  }
  async function resolveCandidate(id, assertSession) {
    assertId(id);
    assertSession();
    if (!targetOS || !["x64", "arm64"].includes(arch)) return { status: "incompatible", reason: "unsupported_platform" };
    const installed = (await applications.listInstalled()).find((item) => item.applicationId === id);
    assertSession();
    const result = await request({ method: "POST", path: `/app-api/market/apps/${id}/candidate`, body: {
      os: targetOS, arch, wanxVersion, hostProtocol: 1,
      ...(installed ? { currentVersion: installed.version, ...(installed.artifactId ? { currentArtifactId: installed.artifactId } : {}) } : {}),
    } });
    assertSession();
    if (!result || !["available", "up_to_date", "local_newer", "incompatible", "unavailable"].includes(result.status))
      throw marketFailure("MARKET_INVALID_RESPONSE");
    if (result.status !== "available") return result;
    const descriptor = verifyEnvelope(result.artifact?.envelope, trustedKeys);
    if (descriptor.applicationId !== id || descriptor.os !== targetOS || descriptor.arch !== arch ||
      descriptor.packageType !== "wanxapp" || descriptor.hostProtocol !== 1 || compareVersions(wanxVersion, descriptor.minWanxVersion) < 0 ||
      descriptor.artifactId !== result.artifact.artifactId || descriptor.version !== result.release?.version ||
      descriptor.sha256 !== result.artifact.sha256 || descriptor.size !== result.artifact.size ||
      result.artifact.status !== "ready" ||
      ["os", "arch", "packageType", "fileName"].some((key) => descriptor[key] !== result.artifact[key]))
      throw marketFailure("MARKET_INCOMPATIBLE");
    if (installed) {
      const compared = compareVersions(descriptor.version, installed.version);
      if (compared <= 0) return {
        status: compared < 0 ? "local_newer" : installed.artifactId === descriptor.artifactId ? "up_to_date" : "incompatible",
        ...(compared === 0 && installed.artifactId !== descriptor.artifactId ? { reason: "reinstall_required" } : {}),
      };
    }
    return result;
  }
  async function download(descriptor, assertSession, destination) {
    const link = await request({ method: "POST", path: `/app-api/market/artifacts/${descriptor.artifactId}/download`, body: {} });
    assertSession();
    let url;
    try { url = new URL(link.url); } catch { throw marketFailure("MARKET_INVALID_RESPONSE"); }
    if (link.artifactId !== descriptor.artifactId || url.protocol !== "https:" || url.username || url.password || url.hash)
      throw marketFailure("MARKET_INVALID_RESPONSE");
    const response = await fetcher(url.href, { redirect: "error", signal: AbortSignal.timeout(300000) });
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
    async list() {
      const assertSession = captureSession();
      assertSession();
      const result = await request({ path: "/app-api/market/apps", method: "GET" });
      assertSession();
      if (!Array.isArray(result?.items)) throw marketFailure("MARKET_INVALID_RESPONSE");
      return result;
    },
    async candidate(id) {
      const assertSession = captureSession();
      const result = await resolveCandidate(id, assertSession);
      if (result.status === "available") offers.set(id, { artifactId: result.artifact.artifactId, assertSession });
      else offers.delete(id);
      return result;
    },
    async install(id) {
      return locked(id, async () => {
        const assertSession = captureSession(), offered = offers.get(id);
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
        const assertSession = captureSession();
        assertSession();
        const result = await applications.uninstall(id, assertSession);
        offers.delete(id);
        return result;
      });
    },
    async rollback(id) {
      return locked(id, async () => {
        const assertSession = captureSession();
        assertSession();
        const result = await applications.rollback(id, assertSession);
        offers.delete(id);
        return result;
      });
    },
  });
}
