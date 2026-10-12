import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export const WANX_APP_PROTOCOL_VERSION = 1;
const ID = /^[a-z][a-z0-9._-]{1,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

const fail = (code) => Object.assign(new Error(code), { code });

function relativeEntry(value) {
  if (typeof value !== "string" || !value || value.length > 256)
    throw fail("INVALID_APPLICATION_ENTRYPOINT");
  if (value.startsWith("/") || /[\\:\x00-\x1f]/.test(value))
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
  if (!VERSION.test(manifest.version)) throw fail("INVALID_APPLICATION_VERSION");
  if (manifest.protocolVersion !== WANX_APP_PROTOCOL_VERSION)
    throw fail("APPLICATION_PROTOCOL_UNSUPPORTED");
  if (manifest.runtime !== "electron") throw fail("APPLICATION_RUNTIME_UNSUPPORTED");
  const launchMode = manifest.launchMode ?? "shared";
  if (!["shared", "bundled"].includes(launchMode)) throw fail("APPLICATION_RUNTIME_UNSUPPORTED");
  if (manifest.platform !== undefined && !["darwin", "win32", "linux"].includes(manifest.platform))
    throw fail("APPLICATION_PLATFORM_UNSUPPORTED");
  if (manifest.arch !== undefined && !["x64", "arm64", "universal"].includes(manifest.arch))
    throw fail("APPLICATION_PLATFORM_UNSUPPORTED");
  if (launchMode === "bundled" && (!manifest.platform || !manifest.arch))
    throw fail("APPLICATION_PLATFORM_REQUIRED");
  if (manifest.arch === "universal" && manifest.platform !== "darwin")
    throw fail("APPLICATION_PLATFORM_UNSUPPORTED");
  const entrypoint = relativeEntry(manifest.entrypoint);
  return Object.freeze({
    applicationId: manifest.applicationId,
    name: manifest.name.trim(),
    version: manifest.version,
    protocolVersion: WANX_APP_PROTOCOL_VERSION,
    runtime: "electron",
    launchMode,
    ...(manifest.platform ? { platform: manifest.platform } : {}),
    ...(manifest.arch ? { arch: manifest.arch } : {}),
    entrypoint,
    description: typeof manifest.description === "string" ? manifest.description.slice(0, 2000) : "",
  });
}

export function assertApplicationPlatform(manifest) {
  if ((manifest.platform && manifest.platform !== process.platform) ||
      (manifest.arch && manifest.arch !== process.arch && manifest.arch !== "universal"))
    throw fail("APPLICATION_PLATFORM_UNSUPPORTED");
}

export async function resolveApplicationEntry(directory, manifest) {
  const root = await realpath(directory);
  let entry;
  try { entry = await realpath(path.resolve(root, manifest.entrypoint)); }
  catch { throw fail("APPLICATION_ENTRYPOINT_NOT_FOUND"); }
  if (!entry.startsWith(`${root}${path.sep}`) || !(await stat(entry)).isFile())
    throw fail("INVALID_APPLICATION_ENTRYPOINT");
  if (manifest.launchMode === "bundled" && process.platform !== "win32") {
    try { await access(entry, constants.X_OK); }
    catch { throw fail("APPLICATION_ENTRYPOINT_NOT_EXECUTABLE"); }
  }
  return entry;
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
