import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import { verifyEnvelope, marketFailure } from "./descriptor.mjs";
import { extractApplicationArchive as extractVerifiedArchive, verifyPackageHash } from "./verified-archive.mjs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import semver from "semver";
import { assertApplicationPlatform, isComparableApplicationVersion, readApplicationManifest, resolveApplicationEntry, validateApplicationManifest } from "./manifest.mjs";
import { extractApplicationArchive } from "./archive.mjs";

const fail = (code) => Object.assign(new Error(code), { code });
const safePart = value => value.replace(/[^A-Za-z0-9._-]/g, "_");

export function createApplicationInstaller({ rootDir, now = () => Date.now(), copy = cp, trustedKeys = {} } = {}) {
  if (typeof rootDir !== "string" || !rootDir) throw new TypeError("rootDir is required");
  rootDir = path.resolve(rootDir);
  const installedPath = manifest => path.join(rootDir, safePart(manifest.applicationId), safePart(manifest.version));
  const operations = new Map();
  function serialize(id, operation) {
    const result = (operations.get(id) || Promise.resolve()).catch(() => {}).then(operation);
    operations.set(id, result);
    void result.finally(() => { if (operations.get(id) === result) operations.delete(id); }).catch(() => {});
    return result;
  }
  function appDirectory(id) {
    if (typeof id !== "string" || !/^[a-z][a-z0-9._-]{1,63}$/.test(id)) throw fail("INVALID_APPLICATION_ID");
    return path.join(rootDir, id);
  }
  async function recordsFor(id) {
    const directory = appDirectory(id);
    let versions;
    try { versions = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const records = [];
    for (const version of versions) {
      if (!version.isDirectory() || version.name.startsWith(".")) continue;
      try {
        const record = JSON.parse(await readFile(path.join(directory, version.name, ".wanx-install.json"), "utf8"));
        validateApplicationManifest(record, { allowLegacyVersion: true, signed: Boolean(record.envelope) });
        if (record.applicationId !== id || path.resolve(record.installPath) !== path.resolve(directory, version.name)) continue;
        if (record.envelope) {
          const descriptor = verifyEnvelope(record.envelope, trustedKeys);
          if (record.artifactId !== descriptor.artifactId || descriptor.artifactId !== version.name ||
              JSON.stringify(validateApplicationManifest(descriptor.manifest, { signed: true })) !== JSON.stringify(validateApplicationManifest(record, { signed: true }))) continue;
        } else if (safePart(record.version) !== version.name) continue;
        records.push(record);
      } catch { /* Ignore incomplete installations, never their containing current-version record. */ }
    }
    return records;
  }
  const choice = records => ({
    applicationId: records[0].applicationId, name: records[0].name,
    selectionRequired: true,
    versions: records.map(({ version, installedAt }) => ({ version, installedAt })),
  });
  async function currentFor(id, records = null) {
    records ||= await recordsFor(id);
    if (!records.length) return null;
    let current;
    try { current = JSON.parse(await readFile(path.join(appDirectory(id), ".current-version.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw fail("APPLICATION_CURRENT_INVALID"); }
    if (!current) {
      try {
        const state = JSON.parse(await readFile(path.join(appDirectory(id), ".wanx-state.json"), "utf8"));
        if (state.schemaVersion !== 1 || typeof state.current !== "string") throw fail("APPLICATION_CURRENT_INVALID");
        current = { key: state.current, previousKey: state.previous };
      } catch (error) { if (error.code !== "ENOENT") throw fail("APPLICATION_CURRENT_INVALID"); }
    }
    if (current) {
      if (Array.isArray(current.choices)) {
        const choices = current.choices.map(version => records.find(record => record.version === version));
        if (!choices.length || choices.some(record => !record)) throw fail("APPLICATION_CURRENT_INVALID");
        return choice(choices);
      }
      const record = records.find(record => current.key ? path.basename(record.installPath) === current.key : record.version === current.version);
      if (!record) throw fail("APPLICATION_CURRENT_INVALID");
      const previous = records.find(record => path.basename(record.installPath) === current.previousKey);
      return { ...record, ...(previous?.envelope ? { previous: { version: previous.version, artifactId: previous.artifactId } } : {}) };
    }
    // A signed artifact without a committed pointer is an interrupted install.
    records = records.filter(record => !record.envelope);
    if (!records.length) return null;
    if (records.some(record => !isComparableApplicationVersion(record.version))) return choice(records);
    const sorted = records.toSorted((a, b) => semver.rcompare(a.version, b.version));
    if (sorted.length > 1 && semver.eq(sorted[0].version, sorted[1].version)) return choice(records);
    return sorted[0];
  }
  async function publish(id, current, signal, assertSession = () => {}) {
    const directory = appDirectory(id), temporary = path.join(directory, `.current-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(current), { mode: 0o600, flag: "wx" });
      signal?.throwIfAborted();
      // Authorization and pointer publication must not yield between checking and commit.
      assertSession();
      renameSync(temporary, path.join(directory, ".current-version.json"));
    } finally { await rm(temporary, { force: true }); }
  }

  async function install({ archivePath, sourceDir, ...options } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (archivePath !== undefined) {
      if (typeof archivePath !== "string" || !archivePath || sourceDir || Object.keys(options).length)
        throw fail("APPLICATION_SOURCE_REQUIRED");
      await mkdir(rootDir, { recursive: true, mode: 0o700 });
      const staging = await mkdtemp(path.join(await realpath(rootDir), ".unpacking-"));
      try {
        const extracted = await extractApplicationArchive(archivePath, staging);
        return await installDirectory({ sourceDir: extracted }, signal);
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    return installDirectory({ sourceDir, ...options }, signal);
  }
  async function installDirectory({ sourceDir, manifest: suppliedManifest, manifestPath }, signal) {
    if (typeof sourceDir !== "string" || !sourceDir) throw fail("APPLICATION_SOURCE_REQUIRED");
    let source;
    try { source = await stat(sourceDir); } catch { throw fail("APPLICATION_SOURCE_NOT_FOUND"); }
    if (!source.isDirectory()) throw fail("APPLICATION_SOURCE_NOT_DIRECTORY");
    const manifest = suppliedManifest ? validateApplicationManifest(suppliedManifest)
      : await readApplicationManifest(manifestPath || path.join(sourceDir, "application.manifest.json"));
    assertApplicationPlatform(manifest);
    await resolveApplicationEntry(sourceDir, manifest);
    return serialize(manifest.applicationId, async () => {
      signal?.throwIfAborted();
      const current = await currentFor(manifest.applicationId);
      if (current?.selectionRequired) throw fail("APPLICATION_VERSION_SELECTION_REQUIRED");
      if (current && isComparableApplicationVersion(current.version)) {
        const comparison = semver.compare(manifest.version, current.version);
        if (comparison <= 0) throw fail(comparison === 0 ? "APPLICATION_VERSION_ALREADY_INSTALLED" : "APPLICATION_VERSION_DOWNGRADE");
      }
      const target = installedPath(manifest);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      try { await access(target); throw fail("APPLICATION_VERSION_ALREADY_INSTALLED"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const staging = await mkdtemp(path.join(path.dirname(target), ".installing-"));
      const temporary = path.join(staging, "content");
      const record = { ...manifest, installPath: target, installedAt: now() };
      let committed = false;
      try {
        await copy(sourceDir, temporary, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        await writeFile(path.join(temporary, ".wanx-install.json"), JSON.stringify(record), { mode: 0o600, flag: "wx" });
        signal?.throwIfAborted();
        await rename(temporary, target);
        committed = true;
        const selection = current && !isComparableApplicationVersion(current.version)
          ? { choices: [current.version, record.version] } : { version: record.version };
        await publish(manifest.applicationId, selection, signal);
        return selection.choices ? choice([current, record]) : Object.freeze(record);
      } catch (error) {
        if (committed) await rm(target, { recursive: true, force: true });
        if (signal?.aborted) throw signal.reason;
        if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw fail("APPLICATION_VERSION_ALREADY_INSTALLED");
        throw fail("APPLICATION_INSTALL_FAILED");
      } finally { await rm(staging, { recursive: true, force: true }); }
    });
  }

  async function list() {
    let apps;
    try { apps = await readdir(rootDir, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const result = [];
    for (const app of apps) {
      if (!app.isDirectory() || !/^[a-z][a-z0-9._-]{1,63}$/.test(app.name)) continue;
      const current = await serialize(app.name, () => currentFor(app.name));
      if (current) result.push(current);
    }
    return result;
  }
  async function resolveCurrent(id) {
    appDirectory(id);
    return serialize(id, async () => {
      const current = await currentFor(id);
      if (!current) throw fail("APPLICATION_NOT_INSTALLED");
      if (current.selectionRequired) throw fail("APPLICATION_VERSION_SELECTION_REQUIRED");
      return current;
    });
  }
  async function selectCurrent(id, version, { signal } = {}) {
    appDirectory(id);
    return serialize(id, async () => {
      const current = await currentFor(id);
      if (!current?.selectionRequired || !current.versions.some(record => record.version === version))
        throw fail("APPLICATION_VERSION_SELECTION_INVALID");
      await publish(id, { version }, signal);
      return currentFor(id);
    });
  }
  async function prune(id, inUseVersion) {
    return serialize(id, async () => {
      const records = await recordsFor(id), current = await currentFor(id, records);
      if (!current || current.selectionRequired) return;
      for (const record of records) {
        if (record.version !== current.version && record.version !== inUseVersion && !(record.artifactId && record.artifactId === current.previous?.artifactId))
          await rm(record.installPath, { recursive: true, force: true });
      }
    });
  }
  async function installVerifiedPackage({ archivePath, envelope, assertSession = () => {} } = {}, { signal } = {}) {
    const descriptor = verifyEnvelope(envelope, trustedKeys);
    if (descriptor.packageType !== "wanxapp") throw marketFailure("MARKET_INCOMPATIBLE");
    const check = () => { signal?.throwIfAborted(); assertSession(); };
    return serialize(descriptor.applicationId, async () => {
      check();
      const current = await currentFor(descriptor.applicationId);
      if (current?.selectionRequired) throw fail("APPLICATION_VERSION_SELECTION_REQUIRED");
      if (current && isComparableApplicationVersion(current.version) && semver.compare(descriptor.version, current.version) <= 0)
        throw marketFailure("MARKET_UPDATE_NOT_AVAILABLE");
      const directory = appDirectory(descriptor.applicationId), target = path.join(directory, descriptor.artifactId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `.staging-${randomUUID()}`);
      let moved = false, committed = false;
      try {
        await verifyPackageHash(archivePath, descriptor, check);
        const manifest = await extractVerifiedArchive(archivePath, temporary, descriptor, check);
        const record = { ...manifest, artifactId: descriptor.artifactId, descriptor, envelope, installPath: target, installedAt: now() };
        await writeFile(path.join(temporary, ".wanx-install.json"), JSON.stringify(record), { mode: 0o600, flag: "wx" });
        check();
        const retained = (await recordsFor(descriptor.applicationId)).find(item => item.installPath === target);
        if (retained) {
          if (JSON.stringify(retained.envelope) !== JSON.stringify(envelope)) throw marketFailure("MARKET_PACKAGE_INVALID");
          await compareInstalledContent(temporary, target, check);
        } else {
          await rename(temporary, target);
          moved = true;
        }
        const selection = current && !isComparableApplicationVersion(current.version)
          ? { choices: [current.version, record.version] }
          : { version: record.version, key: descriptor.artifactId, previousKey: current ? path.basename(current.installPath) : null };
        await publish(descriptor.applicationId, selection, signal, assertSession);
        committed = true;
        return selection.choices ? choice([current, record]) : await currentFor(descriptor.applicationId);
      } finally {
        await rm(temporary, { recursive: true, force: true });
        if (moved && !committed) await rm(target, { recursive: true, force: true });
      }
    });
  }
  async function recover() {
    let apps;
    try { apps = await readdir(rootDir, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const app of apps) {
      if (app.name.startsWith(".removed-") || app.name.startsWith(".unpacking-")) {
        await rm(path.join(rootDir, app.name), { recursive: true, force: true });
      } else if (app.isDirectory() && /^[a-z][a-z0-9._-]{1,63}$/.test(app.name)) {
        let current;
        try { current = await currentFor(app.name); } catch { continue; }
        const retainedVersions = current?.selectionRequired ? current.versions.map(item => item.version) : [current?.version, current?.previous?.version];
        for (const record of await recordsFor(app.name)) {
          if (record.envelope && !retainedVersions.includes(record.version)) await rm(record.installPath, { recursive: true, force: true });
        }
        for (const item of await readdir(appDirectory(app.name))) {
          if (item.startsWith(".staging-") || item.startsWith(".installing-") ||
              (item.startsWith(".current-") || item.startsWith(".wanx-state.json.")) && item.endsWith(".tmp"))
            await rm(path.join(appDirectory(app.name), item), { recursive: true, force: true });
        }
      }
    }
  }
  async function uninstall(id, assertSession = () => {}) {
    appDirectory(id);
    return serialize(id, async () => {
      assertSession();
      const removed = path.join(rootDir, `.removed-${randomUUID()}`);
      try { renameSync(appDirectory(id), removed); } catch (error) { if (error.code !== "ENOENT") throw error; }
      await rm(removed, { recursive: true, force: true });
      return { applicationId: id, state: "uninstalled" };
    });
  }
  async function rollback(id, assertSession = () => {}) {
    appDirectory(id);
    return serialize(id, async () => {
      const current = await currentFor(id), records = await recordsFor(id);
      const previous = current?.previous && records.find(record => record.artifactId === current.previous.artifactId);
      if (!previous?.envelope) throw marketFailure("MARKET_ROLLBACK_UNAVAILABLE");
      await resolveApplicationEntry(previous.installPath, previous);
      await publish(id, { version: previous.version, key: previous.artifactId, previousKey: path.basename(current.installPath) }, undefined, assertSession);
      return currentFor(id);
    });
  }
  return Object.freeze({ install, installVerifiedPackage, list, installedPath, resolveCurrent, selectCurrent, prune, recover, uninstall, rollback });
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
