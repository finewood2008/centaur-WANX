import { access, cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { readApplicationManifest, validateApplicationManifest } from "./manifest.mjs";

const fail = (code) => Object.assign(new Error(code), { code });

function safePart(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function createApplicationInstaller({ rootDir, now = () => Date.now(), copy = cp } = {}) {
  if (typeof rootDir !== "string" || !rootDir) throw new TypeError("rootDir is required");
  const installedPath = (manifest) => path.join(rootDir, safePart(manifest.applicationId), safePart(manifest.version));

  async function install({ sourceDir, manifest: suppliedManifest, manifestPath } = {}) {
    if (typeof sourceDir !== "string" || !sourceDir) throw fail("APPLICATION_SOURCE_REQUIRED");
    let source;
    try { source = await stat(sourceDir); } catch { throw fail("APPLICATION_SOURCE_NOT_FOUND"); }
    if (!source.isDirectory()) throw fail("APPLICATION_SOURCE_NOT_DIRECTORY");
    const manifest = suppliedManifest
      ? validateApplicationManifest(suppliedManifest)
      : await readApplicationManifest(manifestPath || path.join(sourceDir, "application.manifest.json"));
    const entry = path.resolve(sourceDir, manifest.entrypoint);
    if (!entry.startsWith(`${path.resolve(sourceDir)}${path.sep}`)) throw fail("INVALID_APPLICATION_ENTRYPOINT");
    try { await access(entry); } catch { throw fail("APPLICATION_ENTRYPOINT_NOT_FOUND"); }
    const target = installedPath(manifest);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.installing-${process.pid}-${now()}`;
    await rm(temporary, { recursive: true, force: true });
    try {
      await copy(sourceDir, temporary, { recursive: true, errorOnExist: true, force: false });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (error?.code === "EEXIST") throw fail("APPLICATION_VERSION_ALREADY_INSTALLED");
      throw fail("APPLICATION_INSTALL_FAILED");
    }
    const record = { ...manifest, installPath: target, installedAt: now() };
    await import("node:fs/promises").then(({ writeFile }) => writeFile(
      path.join(target, ".wanx-install.json"), JSON.stringify(record), { mode: 0o600 },
    ));
    return Object.freeze(record);
  }

  async function list() {
    const result = [];
    let apps;
    try { apps = await (await import("node:fs/promises")).readdir(rootDir, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return result; throw error; }
    for (const app of apps) {
      if (!app.isDirectory()) continue;
      let versions;
      try { versions = await (await import("node:fs/promises")).readdir(path.join(rootDir, app.name), { withFileTypes: true }); }
      catch { continue; }
      for (const version of versions) {
        if (!version.isDirectory()) continue;
        try { result.push(JSON.parse(await readFile(path.join(rootDir, app.name, version.name, ".wanx-install.json"), "utf8"))); }
        catch { /* Ignore incomplete installations. */ }
      }
    }
    return result;
  }

  return Object.freeze({ install, list, installedPath });
}
