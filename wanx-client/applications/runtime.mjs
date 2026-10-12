import { readFile, realpath, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyEnvelope, marketFailure, validApplicationId } from "./descriptor.mjs";
import { validateApplicationManifest } from "./manifest.mjs";

/** Invoked by the shell before acquiring the WANX single-instance lock. */
export async function runManagedApplication({ applicationRoot, trustedKeys = {}, app } = {}) {
  const id = process.env.WANX_HOST_CLIENT_APPLICATION_ID;
  if (!validApplicationId(id) || !process.env.WANX_HOST_TOKEN || !process.env.WANX_HOST_SOCKET || !process.env.WANX_HOST_LAUNCH_ID)
    throw marketFailure("MARKET_APPLICATION_SESSION_REQUIRED");
  const root = await realpath(path.join(applicationRoot, id));
  const directory = await realpath(process.env.WANX_HOST_INSTALL_ROOT || "");
  if (path.dirname(directory) !== root) throw marketFailure("MARKET_INSTALL_STATE_INVALID");
  const record = JSON.parse(await readFile(path.join(directory, ".wanx-install.json"), "utf8"));
  const descriptor = verifyEnvelope(record.envelope, trustedKeys);
  const manifest = validateApplicationManifest(descriptor.manifest);
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : null;
  if (manifest.applicationId !== id || descriptor.artifactId !== path.basename(directory) || descriptor.os !== os || descriptor.arch !== process.arch)
    throw marketFailure("MARKET_INCOMPATIBLE");
  const installed = validateApplicationManifest(JSON.parse(await readFile(path.join(directory, "wanx-app.json"), "utf8")));
  if (JSON.stringify(installed) !== JSON.stringify(manifest)) throw marketFailure("MARKET_PACKAGE_INVALID");
  const entry = await realpath(path.join(directory, manifest.entrypoint));
  if (!entry.startsWith(`${directory}${path.sep}`) || !(await stat(entry)).isFile()) throw marketFailure("MARKET_PACKAGE_INVALID");
  const data = path.join(path.dirname(path.resolve(applicationRoot)), "application-data", id);
  await mkdir(data, { recursive: true, mode: 0o700 });
  app.setPath("userData", data);
  app.setName(manifest.name);
  process.env.WANX_HOST_APPLICATION_DATA = data;
  // The signed manifest fixes the entry; package.json and command-line paths cannot override it.
  await import(pathToFileURL(entry).href);
}
