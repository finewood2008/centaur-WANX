import { createHash, createPublicKey, verify } from "node:crypto";
import semver from "semver";
import { TEST_APP_ID, TEST_EXTENSION, isTestClientIdentity } from "./test-build.mjs";

export const updateError = code => Object.assign(new Error(code), { code });
export const errorCode = error => /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code || error?.message || "")
  ? (error.code || error.message) : "UPDATE_REQUEST_FAILED";
export function canonicalJSON(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  throw updateError("CONTRACT_UNSUPPORTED");
}
export const digestPayload = value => createHash("sha256").update(canonicalJSON(value)).digest("hex");
const safeText = value => typeof value === "string" && value.length > 0 && value.length <= 256;
export function secureURL(value) {
  let url;
  try { url = new URL(value); } catch { throw updateError("UPDATE_INVALID_ARTIFACT"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw updateError("UPDATE_INVALID_ARTIFACT");
  return url;
}
export function verifyRelease(envelope, { keys = {}, product, now = Date.now(), testIdentity } = {}) {
  const { payload, signature } = envelope || {};
  const extensions = payload?.requiredExtensions ?? [];
  if (!payload || payload.schemaVersion !== 1 || payload.purpose !== "wanx.release.v1" ||
      payload.product !== product || !Array.isArray(extensions) || new Set(extensions).size !== extensions.length ||
      extensions.some(extension => !(product === "wanx-box" && extension === "wanx.foundation-modules.v1") &&
        !(product === "wanx-client" && extension === TEST_EXTENSION && isTestClientIdentity(testIdentity))) ||
      payload.backendContract !== 1 || payload.hostProtocol !== 1 || payload.dataPolicy !== "backward-compatible")
    throw updateError("CONTRACT_UNSUPPORTED");
  if (extensions.includes(TEST_EXTENSION) && (payload.testIsolation?.applicationId !== TEST_APP_ID ||
      payload.testIsolation?.testRunId !== testIdentity.testRunId || payload.channel !== testIdentity.channel ||
      !/^[a-f0-9]{64}$/.test(payload.sourceSnapshot || "")) ||
      isTestClientIdentity(testIdentity) && !extensions.includes(TEST_EXTENSION)) throw updateError("CONTRACT_UNSUPPORTED");
  if (signature?.algorithm !== "ed25519" || !Object.hasOwn(keys, signature?.keyId || ""))
    throw updateError("UPDATE_UNTRUSTED_KEY");
  const bytes = Buffer.from(canonicalJSON(payload));
  try {
    const key = createPublicKey(keys[signature.keyId]);
    const sig = Buffer.from(signature.signatureBase64, "base64");
    if (key.asymmetricKeyType !== "ed25519" || sig.length !== 64 || sig.toString("base64") !== signature.signatureBase64 || !verify(null, bytes, key, sig)) throw new Error();
  } catch { throw updateError("SIGNATURE_INVALID"); }
  if (![payload.releaseId, payload.buildId, payload.channel].every(safeText) ||
      semver.valid(payload.version) !== payload.version || !Number.isSafeInteger(payload.metadataSequence) || payload.metadataSequence < 1 ||
      !Number.isSafeInteger(payload.securityEpoch) || payload.securityEpoch < 0 ||
      !Number.isFinite(Date.parse(payload.createdAt)) || Date.parse(payload.createdAt) > now ||
      !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= now)
    throw updateError("UPDATE_INVALID_RELEASE");
  if (!payload.platform || !["linux", "darwin", "win32"].includes(payload.platform.os) ||
      !["x64", "arm64"].includes(payload.platform.arch) || !safeText(payload.platform.osVersion) ||
      !payload.components || !Array.isArray(payload.artifacts) || !payload.artifacts.length)
    throw updateError("UPDATE_INVALID_RELEASE");
  for (const artifact of payload.artifacts) {
    secureURL(artifact.url);
    if (!safeText(artifact.component) || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0 ||
        payload.components[artifact.component]?.sha256 !== artifact.sha256)
      throw updateError("UPDATE_INVALID_ARTIFACT");
  }
  if (product === "wanx-box") {
    const foundation = payload.artifacts.filter(artifact => ["discovery", "p2p"].includes(artifact.component));
    if (foundation.length && !extensions.includes("wanx.foundation-modules.v1") ||
        extensions.includes("wanx.foundation-modules.v1") &&
        (!semver.valid(payload.minUpdaterVersion) || semver.lt(payload.minUpdaterVersion, "1.1.0")))
      throw updateError("CONTRACT_UNSUPPORTED");
    if (foundation.some(artifact => artifact.kind !== "module-tar" || Object.hasOwn(artifact, "imageId") || Object.hasOwn(artifact, "sha512")) ||
        Object.entries(payload.components).some(([name, component]) => ["discovery", "p2p"].includes(name) && Object.hasOwn(component || {}, "imageId")))
      throw updateError("UPDATE_INVALID_ARTIFACT");
  }
  if (product === "wanx-client") {
    const artifact = payload.artifacts[0];
    if (payload.artifacts.length !== 1 || Object.keys(payload.components).length !== 1 || artifact.component !== "wanx-client" ||
        payload.components["wanx-client"].version !== payload.version ||
        artifact.kind !== ({ darwin: "mac-zip", win32: "nsis" })[payload.platform.os] ||
        typeof artifact.sha512 !== "string" || Buffer.from(artifact.sha512, "base64").length !== 64 ||
        Buffer.from(artifact.sha512, "base64").toString("base64") !== artifact.sha512 ||
        !secureURL(artifact.url).pathname.endsWith(payload.platform.os === "darwin" ? ".zip" : ".exe"))
      throw updateError("UPDATE_INVALID_ARTIFACT");
    if (!Array.isArray(payload.supportedOsVersions) || payload.supportedOsVersions.some(value => !safeText(value)) ||
        !Array.isArray(payload.compatibleApplications) || payload.compatibleApplications.some(rule => !safeText(rule?.applicationId) ||
          typeof rule.versionRange !== "string" || !semver.validRange(rule.versionRange)) ||
        new Set(payload.compatibleApplications.map(rule => rule.applicationId)).size !== payload.compatibleApplications.length)
      throw updateError("CONTRACT_UNSUPPORTED");
  }
  return { release: structuredClone(payload), digest: createHash("sha256").update(bytes).digest("hex") };
}

export function clientBlockers(release, current, applications) {
  const blockers = [];
  if (release.platform.os !== current.platform || release.platform.arch !== current.arch ||
      !release.supportedOsVersions?.includes(current.osVersion)) blockers.push({ code: "UNSUPPORTED_PLATFORM" });
  if (release.securityEpoch < current.securityEpoch) blockers.push({ code: "UPDATE_SECURITY_DOWNGRADE" });
  if (release.minClientVersion && (!semver.valid(release.minClientVersion) || semver.lt(current.productVersion, release.minClientVersion)))
    blockers.push({ code: "CONTRACT_UNSUPPORTED" });
  for (const app of applications) {
    const rule = release.compatibleApplications?.find(rule => rule.applicationId === app.applicationId);
    if (app.selectionRequired || !rule || !semver.validRange(rule.versionRange) || !semver.valid(app.version) ||
        !semver.satisfies(app.version, rule.versionRange))
      blockers.push({ code: "DEPENDENCY_CONFLICT", applicationId: app.applicationId, version: app.version });
  }
  return blockers;
}
