import { access, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readApplicationManifest, validateApplicationManifest } from "./manifest.mjs";
import { verifyEnvelope, marketFailure, validApplicationId } from "./descriptor.mjs";
import { compareVersions } from "./version.mjs";
import { extractApplicationArchive, verifyPackageHash } from "./archive.mjs";

const fail = (code) => Object.assign(new Error(code), { code });
const safePart = (value) => value.replace(/[^A-Za-z0-9._-]/g, "_");

export function createApplicationInstaller({ rootDir, now = () => Date.now(), copy = cp, trustedKeys = {} } = {}) {
  if (typeof rootDir !== "string" || !rootDir) throw new TypeError("rootDir is required");
  rootDir = path.resolve(rootDir);
  const locks = new Set();
  const appPath = (id) => {
    if (!validApplicationId(id)) throw fail("INVALID_APPLICATION_ID");
    return path.join(rootDir, id);
  };
  const installedPath = (manifest) => path.join(appPath(manifest.applicationId), safePart(manifest.version));
  async function locked(id, operation) {
    appPath(id);
    if (locks.has(id)) throw marketFailure("MARKET_OPERATION_BUSY");
    locks.add(id);
    try { return await operation(); } finally { locks.delete(id); }
  }
  async function stateFor(id) {
    try {
      const value = JSON.parse(await readFile(path.join(appPath(id), ".wanx-state.json"), "utf8"));
      if (value.schemaVersion !== 1 || typeof value.current !== "string" || !/^[A-Za-z0-9.+_-]+$/.test(value.current) ||
          (value.previous != null && !/^[A-Za-z0-9.+_-]+$/.test(value.previous))) throw new Error();
      return value;
    } catch (error) { if (error?.code === "ENOENT") return null; throw marketFailure("MARKET_INSTALL_STATE_INVALID"); }
  }
  async function writeState(id, value, assertSession = () => {}) {
    const statePath = path.join(appPath(id), ".wanx-state.json"), temporary = `${statePath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ schemaVersion: 1, ...value })); await file.sync(); } finally { await file.close(); }
      // The session check and atomic pointer replacement run in the same event-loop turn.
      assertSession();
      renameSync(temporary, statePath);
    } finally { await rm(temporary, { force: true }); }
  }
  async function readRecord(id, key) {
    const directory = path.join(appPath(id), key);
    const stored = JSON.parse(await readFile(path.join(directory, ".wanx-install.json"), "utf8"));
    const manifest = validateApplicationManifest(stored);
    if (manifest.applicationId !== id) throw marketFailure("MARKET_INSTALL_STATE_INVALID");
    if (stored.envelope) {
      const descriptor = verifyEnvelope(stored.envelope, trustedKeys);
      if (descriptor.artifactId !== key || JSON.stringify(validateApplicationManifest(descriptor.manifest)) !== JSON.stringify(manifest))
        throw marketFailure("MARKET_INSTALL_STATE_INVALID");
    }
    return { ...stored, ...manifest, installPath: directory };
  }
  async function listAll() {
    const result = [];
    let apps;
    try { apps = await readdir(rootDir, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return result; throw error; }
    for (const app of apps) {
      if (!app.isDirectory() || !validApplicationId(app.name)) continue;
      for (const version of await readdir(appPath(app.name), { withFileTypes: true })) {
        if (!version.isDirectory() || version.name.startsWith(".")) continue;
        try { result.push(await readRecord(app.name, version.name)); } catch { /* Incomplete or untrusted installations cannot launch. */ }
      }
    }
    return result;
  }
  async function list() {
    const result = [];
    const records = await listAll();
    for (const id of new Set(records.map((record) => record.applicationId))) {
      let state;
      try { state = await stateFor(id); } catch { continue; }
      const own = records.filter((record) => record.applicationId === id);
      // Migrate pre-market directory installs by selecting the newest version, never enumeration order.
      const current = state ? own.find((record) => path.basename(record.installPath) === state.current)
        : own.filter((record) => !record.envelope).sort((a, b) => compareVersions(b.version, a.version))[0];
      if (!current) continue;
      const previous = state?.previous && own.find((record) => path.basename(record.installPath) === state.previous);
      result.push({ ...current, previous: previous ? { version: previous.version, artifactId: previous.artifactId ?? null } : null });
    }
    return result;
  }
  async function recover() {
    let apps;
    try { apps = await readdir(rootDir, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
    for (const app of apps) {
      if (app.name.startsWith(".removed-")) { await rm(path.join(rootDir, app.name), { recursive: true, force: true }); continue; }
      if (!app.isDirectory() || !validApplicationId(app.name)) continue;
      let state;
      try { state = await stateFor(app.name); } catch { continue; }
      for (const item of await readdir(appPath(app.name))) {
        if (item.startsWith(".staging-") || (item.startsWith(".wanx-state.json.") && item.endsWith(".tmp")) ||
          (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(item) && item !== state?.current && item !== state?.previous))
          await rm(path.join(appPath(app.name), item), { recursive: true, force: true });
      }
    }
  }
  async function install({ sourceDir, manifest: suppliedManifest, manifestPath } = {}) {
    if (typeof sourceDir !== "string" || !sourceDir) throw fail("APPLICATION_SOURCE_REQUIRED");
    let source;
    try { source = await stat(sourceDir); } catch { throw fail("APPLICATION_SOURCE_NOT_FOUND"); }
    if (!source.isDirectory()) throw fail("APPLICATION_SOURCE_NOT_DIRECTORY");
    const manifest = suppliedManifest ? validateApplicationManifest(suppliedManifest)
      : await readApplicationManifest(manifestPath || path.join(sourceDir, "application.manifest.json"));
    return locked(manifest.applicationId, async () => {
      const entry = path.resolve(sourceDir, manifest.entrypoint);
      if (!entry.startsWith(`${path.resolve(sourceDir)}${path.sep}`)) throw fail("INVALID_APPLICATION_ENTRYPOINT");
      try { await access(entry); } catch { throw fail("APPLICATION_ENTRYPOINT_NOT_FOUND"); }
      const target = installedPath(manifest), temporary = path.join(appPath(manifest.applicationId), `.staging-${randomUUID()}`);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const previous = await stateFor(manifest.applicationId);
      const record = { ...manifest, installPath: target, installedAt: now() };
      try {
        await copy(sourceDir, temporary, { recursive: true, errorOnExist: true, force: false });
        await writeFile(path.join(temporary, ".wanx-install.json"), JSON.stringify(record), { mode: 0o600 });
        await rename(temporary, target);
        await writeState(manifest.applicationId, { current: path.basename(target), previous: previous?.current ?? null });
      } catch (error) {
        if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw fail("APPLICATION_VERSION_ALREADY_INSTALLED");
        throw error;
      } finally { await rm(temporary, { recursive: true, force: true }); }
      return Object.freeze(record);
    });
  }
  async function installVerifiedPackage({ archivePath, envelope, assertSession = () => {} } = {}) {
    const descriptor = verifyEnvelope(envelope, trustedKeys);
    if (descriptor.packageType !== "wanxapp") throw marketFailure("MARKET_INCOMPATIBLE");
    return locked(descriptor.applicationId, async () => {
      assertSession();
      const current = (await list()).find((item) => item.applicationId === descriptor.applicationId);
      if (current && compareVersions(descriptor.version, current.version) <= 0) throw marketFailure("MARKET_UPDATE_NOT_AVAILABLE");
      const appDir = appPath(descriptor.applicationId), target = path.join(appDir, descriptor.artifactId);
      await mkdir(appDir, { recursive: true, mode: 0o700 });
      const temporary = path.join(appDir, `.staging-${randomUUID()}`);
      let moved = false, committed = false;
      try {
        await verifyPackageHash(archivePath, descriptor, assertSession);
        const manifest = await extractApplicationArchive(archivePath, temporary, descriptor, assertSession);
        const record = { ...manifest, artifactId: descriptor.artifactId, descriptor, envelope, installPath: target, installedAt: now() };
        await writeFile(path.join(temporary, ".wanx-install.json"), JSON.stringify(record), { mode: 0o600, flag: "wx" });
        assertSession();
        // An abandoned target from a crash before pointer commit is safe to replace.
        const state = await stateFor(descriptor.applicationId);
        if (state?.previous === descriptor.artifactId) {
          const retained = await readRecord(descriptor.applicationId, descriptor.artifactId);
          if (JSON.stringify(retained.envelope) !== JSON.stringify(envelope)) throw marketFailure("MARKET_PACKAGE_INVALID");
          await compareInstalledContent(temporary, target, assertSession);
        } else {
          if (state?.current !== descriptor.artifactId) await rm(target, { recursive: true, force: true });
          await rename(temporary, target);
          moved = true;
        }
        await writeState(descriptor.applicationId, { current: descriptor.artifactId, previous: current ? path.basename(current.installPath) : null }, assertSession);
        committed = true;
        return { ...record, previous: current ? { version: current.version, artifactId: current.artifactId ?? null } : null };
      } finally {
        await rm(temporary, { recursive: true, force: true });
        if (moved && !committed) await rm(target, { recursive: true, force: true });
      }
    });
  }
  async function uninstall(id, assertSession = () => {}) {
    return locked(id, async () => {
      assertSession();
      const source = appPath(id), removed = path.join(rootDir, `.removed-${randomUUID()}`);
      try { renameSync(source, removed); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      await rm(removed, { recursive: true, force: true });
      return { applicationId: id, state: "uninstalled" };
    });
  }
  async function rollback(id, assertSession = () => {}) {
    return locked(id, async () => {
      const state = await stateFor(id);
      if (!state?.previous) throw marketFailure("MARKET_ROLLBACK_UNAVAILABLE");
      const previous = await readRecord(id, state.previous);
      if (!previous.envelope) throw marketFailure("MARKET_ROLLBACK_UNAVAILABLE");
      await access(path.join(previous.installPath, previous.entrypoint));
      await writeState(id, { current: state.previous, previous: state.current }, assertSession);
      return { ...previous, previous: { version: (await readRecord(id, state.current)).version, artifactId: state.current } };
    });
  }
  return Object.freeze({ install, installVerifiedPackage, list, listAll, installedPath, recover, uninstall, rollback });
}

// Reinstalling the retained previous artifact must not overwrite a usable copy.
// Compare it with the freshly verified archive before switching the active pointer.
async function compareInstalledContent(expectedDir, actualDir, assertSession) {
  const expected = (await readdir(expectedDir)).filter((name) => name !== ".wanx-install.json").sort();
  const actual = (await readdir(actualDir)).filter((name) => name !== ".wanx-install.json").sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw marketFailure("MARKET_PACKAGE_INVALID");
  for (const name of expected) {
    assertSession();
    const a = path.join(expectedDir, name), b = path.join(actualDir, name);
    const as = await lstat(a), bs = await lstat(b);
    if (bs.isSymbolicLink() || as.isDirectory() !== bs.isDirectory() || as.isFile() !== bs.isFile()) throw marketFailure("MARKET_PACKAGE_INVALID");
    if (as.isDirectory()) await compareInstalledContent(a, b, assertSession);
    else {
      if (as.size !== bs.size) throw marketFailure("MARKET_PACKAGE_INVALID");
      const { createHash } = await import("node:crypto"), { createReadStream } = await import("node:fs");
      const hash = async (file) => {
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(file)) { assertSession(); digest.update(chunk); }
        return digest.digest("hex");
      };
      if (await hash(a) !== await hash(b)) throw marketFailure("MARKET_PACKAGE_INVALID");
    }
  }
}
