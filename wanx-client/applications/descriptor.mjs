import { createPublicKey, verify } from "node:crypto";
import { validateApplicationManifest } from "./manifest.mjs";
import { validateVersion } from "./version.mjs";
import { assertNoCriticalExtensions, validateCompatibility } from "./compatibility.mjs";

export const marketFailure = (code) => Object.assign(new Error(code), { code });
export const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
export const validApplicationId = (value) => typeof value === "string" && /^[a-z][a-z0-9._-]{1,63}$/.test(value);

export function matchesApplicationTarget(descriptor, os, arch) {
  if (!["macos", "windows"].includes(os) || !["x64", "arm64"].includes(arch)) return false;
  return (descriptor.packageType === "wanxapp" && descriptor.os === "universal" && descriptor.arch === "universal") ||
    (descriptor.os === os && descriptor.arch === arch);
}

export function validateDescriptor(value) {
  try {
    if (!value || ![1, 2, 3].includes(value.schemaVersion) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.artifactId) ||
      !validApplicationId(value.applicationId) ||
      !["wanxapp", "dmg", "exe"].includes(value.packageType) || value.hostProtocol !== 1 ||
      typeof value.fileName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value.fileName) ||
      !value.fileName.endsWith(`.${value.packageType}`) || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_PACKAGE_BYTES)
      throw new Error();
    assertNoCriticalExtensions(value);
    if (value.schemaVersion === 1 && value.compatibility !== undefined) throw new Error();
    if (value.schemaVersion >= 2) {
      const allowed = ["schemaVersion", "artifactId", "applicationId", "version", "os", "arch", "packageType", "hostProtocol", "fileName", "sha256", "size", "minWanxVersion", "manifest", "buildId", "compatibility", "critical"];
      if (Object.keys(value).some(key => !allowed.includes(key)) || value.packageType !== "wanxapp") throw new Error();
      validateCompatibility(value.compatibility, value.schemaVersion);
    }
    const universal = value.packageType === "wanxapp" && value.os === "universal" && value.arch === "universal";
    if (!universal && (!["macos", "windows"].includes(value.os) || !["arm64", "x64"].includes(value.arch))) throw new Error();
    if ((value.packageType === "dmg" && value.os !== "macos") || (value.packageType === "exe" && value.os !== "windows")) throw new Error();
    validateVersion(value.version);
    validateVersion(value.minWanxVersion);
    if (value.packageType === "wanxapp") {
      const manifest = validateApplicationManifest(value.manifest, { signed: true });
      if (manifest.protocolVersion !== value.schemaVersion || value.schemaVersion >= 2 &&
          JSON.stringify(manifest.compatibility) !== JSON.stringify(validateCompatibility(value.compatibility, value.schemaVersion))) throw new Error();
      if (universal && (manifest.platform !== undefined || manifest.arch !== undefined)) throw new Error();
      if (manifest.applicationId !== value.applicationId || manifest.version !== value.version || manifest.launchMode !== "shared" ||
          manifest.platform && manifest.platform !== ({ macos: "darwin", windows: "win32" })[value.os] ||
          manifest.arch && manifest.arch !== value.arch && manifest.arch !== "universal") throw new Error();
    }
    if (value.buildId !== undefined && (typeof value.buildId !== "string" || !value.buildId || value.buildId.length > 128)) throw new Error();
    return Object.freeze(structuredClone(value));
  } catch { throw marketFailure("MARKET_INVALID_DESCRIPTOR"); }
}

function decode(value) {
  if (typeof value !== "string" || value.length > 100000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw marketFailure("MARKET_INVALID_SIGNATURE");
  const result = Buffer.from(value, "base64");
  if (result.toString("base64") !== value) throw marketFailure("MARKET_INVALID_SIGNATURE");
  return result;
}

export function verifyEnvelope(envelope, trustedKeys = {}) {
  if (!envelope || typeof envelope.keyId !== "string" || !Object.hasOwn(trustedKeys, envelope.keyId))
    throw marketFailure("MARKET_UNTRUSTED_KEY");
  const bytes = decode(envelope.descriptorBase64), signature = decode(envelope.signatureBase64);
  let key;
  try { key = createPublicKey(trustedKeys[envelope.keyId]); } catch { throw marketFailure("MARKET_UNTRUSTED_KEY"); }
  if (key.asymmetricKeyType !== "ed25519" || signature.length !== 64 || !verify(null, bytes, key, signature))
    throw marketFailure("MARKET_INVALID_SIGNATURE");
  let descriptor;
  try { descriptor = JSON.parse(bytes.toString("utf8")); } catch { throw marketFailure("MARKET_INVALID_DESCRIPTOR"); }
  return validateDescriptor(descriptor);
}
