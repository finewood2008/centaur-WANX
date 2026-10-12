import { readFile } from "node:fs/promises";
import { validateVersion } from "./version.mjs";

export const WANX_APP_PROTOCOL_VERSION = 1;
const ID = /^[a-z][a-z0-9._-]{1,63}$/;
const CAPABILITIES = new Set([
  "identity.read",
  "experts.read",
  "experts.select",
  "http.request",
  "chat.stream",
  "files.upload",
]);

const fail = (code) => Object.assign(new Error(code), { code });

function relativeEntry(value) {
  if (typeof value !== "string" || !value || value.length > 256)
    throw fail("INVALID_APPLICATION_ENTRYPOINT");
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || /[:\x00-\x1f]/.test(value))
    throw fail("INVALID_APPLICATION_ENTRYPOINT");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw fail("INVALID_APPLICATION_ENTRYPOINT");
  return parts.join("/");
}

export function validateApplicationManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw fail("INVALID_APPLICATION_MANIFEST");
  const manifest = input;
  if (typeof manifest.applicationId !== "string" || !ID.test(manifest.applicationId)) throw fail("INVALID_APPLICATION_ID");
  if (typeof manifest.name !== "string" || !manifest.name.trim() || manifest.name.length > 128)
    throw fail("INVALID_APPLICATION_NAME");
  validateVersion(manifest.version);
  if (manifest.protocolVersion !== WANX_APP_PROTOCOL_VERSION)
    throw fail("APPLICATION_PROTOCOL_UNSUPPORTED");
  if (manifest.runtime !== "electron") throw fail("APPLICATION_RUNTIME_UNSUPPORTED");
  const entrypoint = relativeEntry(manifest.entrypoint);
  const capabilities = manifest.capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.some((value) => !CAPABILITIES.has(value)))
    throw fail("INVALID_APPLICATION_CAPABILITIES");
  return Object.freeze({
    applicationId: manifest.applicationId,
    name: manifest.name.trim(),
    version: manifest.version,
    protocolVersion: WANX_APP_PROTOCOL_VERSION,
    runtime: "electron",
    entrypoint,
    capabilities: Object.freeze([...new Set(capabilities)]),
    description: typeof manifest.description === "string" ? manifest.description.slice(0, 2000) : "",
  });
}

export async function readApplicationManifest(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw fail("APPLICATION_MANIFEST_READ_FAILED");
  }
  return validateApplicationManifest(value);
}
