import { access, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertApplicationPlatform, readApplicationManifest, resolveApplicationEntry, validateApplicationManifest } from "./manifest.mjs";
import { extractApplicationArchive } from "./archive.mjs";

const fail = (code) => Object.assign(new Error(code), { code });

function safePart(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function createApplicationInstaller({ rootDir, now = () => Date.now(), copy = cp } = {}) {
  if (typeof rootDir !== "string" || !rootDir) throw new TypeError("rootDir is required");
  const installedPath = (manifest) => path.join(rootDir, safePart(manifest.applicationId), safePart(manifest.version));

  async function install({ archivePath, sourceDir, ...options } = {}) {
    if (archivePath !== undefined) {
      if (typeof archivePath !== "string" || !archivePath || sourceDir || Object.keys(options).length)
        throw fail("APPLICATION_SOURCE_REQUIRED");
      await mkdir(rootDir, { recursive: true, mode: 0o700 });
      const staging = await mkdtemp(path.join(await realpath(rootDir), ".unpacking-"));
      try {
        const extracted = await extractApplicationArchive(archivePath, staging);
        return await installDirectory({ sourceDir: extracted });
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    return installDirectory({ sourceDir, ...options });
  }

  async function installDirectory({ sourceDir, manifest: suppliedManifest, manifestPath }) {
    if (typeof sourceDir !== "string" || !sourceDir) throw fail("APPLICATION_SOURCE_REQUIRED");
    let source;
    try { source = await stat(sourceDir); } catch { throw fail("APPLICATION_SOURCE_NOT_FOUND"); }
    if (!source.isDirectory()) throw fail("APPLICATION_SOURCE_NOT_DIRECTORY");
    const manifest = suppliedManifest
      ? validateApplicationManifest(suppliedManifest)
      : await readApplicationManifest(manifestPath || path.join(sourceDir, "application.manifest.json"));
    assertApplicationPlatform(manifest);
    await resolveApplicationEntry(sourceDir, manifest);
    const target = installedPath(manifest);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try { await access(target); throw fail("APPLICATION_VERSION_ALREADY_INSTALLED"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const staging = await mkdtemp(path.join(path.dirname(target), ".installing-"));
    const temporary = path.join(staging, "content");
    const record = { ...manifest, installPath: target, installedAt: now() };
    try {
      await copy(sourceDir, temporary, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      await writeFile(path.join(temporary, ".wanx-install.json"), JSON.stringify(record), { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw fail("APPLICATION_VERSION_ALREADY_INSTALLED");
      throw fail("APPLICATION_INSTALL_FAILED");
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return Object.freeze(record);
  }

  async function list() {
    const result = [];
    let apps;
    try { apps = await (await import("node:fs/promises")).readdir(rootDir, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return result; throw error; }
    for (const app of apps) {
      if (!app.isDirectory() || app.name.startsWith(".")) continue;
      let versions;
      try { versions = await (await import("node:fs/promises")).readdir(path.join(rootDir, app.name), { withFileTypes: true }); }
      catch { continue; }
      for (const version of versions) {
        if (!version.isDirectory() || version.name.startsWith(".")) continue;
        try { result.push(JSON.parse(await readFile(path.join(rootDir, app.name, version.name, ".wanx-install.json"), "utf8"))); }
        catch { /* Ignore incomplete installations. */ }
      }
    }
    return result;
  }

  return Object.freeze({ install, list, installedPath });
}
