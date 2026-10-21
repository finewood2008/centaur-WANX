import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

// Audited shared Zhijun releases 0.4.7–0.5.2 use identical host-runtime/roles
// readers: host-scopes/<sha256>/roles.json has {version: 1, users: {...}}.
// Their renderer partition is non-persistent. The Chromium entries below are
// opaque runtime metadata, not evidence about arbitrary applications' schemas.
const metadataDirectories = new Set([
  "Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache",
  "Local Storage", "Session Storage", "Shared Dictionary", "blob_storage", "Network",
]);
const metadataFiles = new Set([
  "Preferences", "Local State", "Network Persistent State", "TransportSecurity",
  "SharedStorage", "SharedStorage-wal", "SharedStorage-shm",
  "Trust Tokens", "Trust Tokens-journal", "Cookies", "Cookies-journal",
]);
const maximumRolesBytes = 1024 * 1024;
const unknown = () => { throw new Error("ZHIJUN_DATA_UNKNOWN"); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;

function validRoles(value) {
  if (!object(value) || value.version !== 1 || !object(value.users)) return false;
  return Object.values(value.users).every(roles => Array.isArray(roles) && roles.every(role =>
    object(role) && typeof role.id === "string" && role.id.length > 0 &&
    (role.ready === undefined || typeof role.ready === "boolean") &&
    ["name", "description", "agentId", "libraryId", "requestId", "createdAt"].every(field =>
      role[field] === undefined || typeof role[field] === "string")));
}

/** Read schema evidence without changing, migrating or deleting any profile. */
export async function inspectZhijunData({ manifest, profileDirectories } = {}) {
  if (manifest?.applicationId !== "centaurai.wanx.zhijun" || manifest.runtime !== "electron" ||
      manifest.launchMode !== "shared" || manifest.entrypoint !== "market/main.mjs" ||
      !Number.isSafeInteger(manifest.protocolVersion) || manifest.protocolVersion < 2) return null;
  if (!Array.isArray(profileDirectories) || !profileDirectories.length ||
      profileDirectories.some(directory => typeof directory !== "string" || !path.isAbsolute(directory))) return { status: "unknown" };
  try {
    const inspectedDirectories = [];
    let rolesPresent = false, totalBytes = 0;
    async function directory(filename, expectedPath) {
      const info = await lstat(filename);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(filename) !== expectedPath) unknown();
      const entries = await readdir(filename);
      if (entries.length > 1024) unknown();
      inspectedDirectories.push({ filename, info, expectedPath });
      return entries;
    }
    async function rolesFile(filename, expectedPath) {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximumRolesBytes ||
          (totalBytes += info.size) > 16 * maximumRolesBytes || await realpath(filename) !== expectedPath) unknown();
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!sameFile(info, opened)) unknown();
        // A bounded read also covers a file growing between stat and read.
        const bytes = Buffer.alloc(maximumRolesBytes + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length !== info.size || !sameFile(info, await handle.stat()) ||
            !sameFile(info, await lstat(filename)) || await realpath(filename) !== expectedPath ||
            !validRoles(JSON.parse(bytes.subarray(0, length).toString("utf8")))) unknown();
        rolesPresent = true;
      } finally { await handle.close(); }
    }
    for (const filename of profileDirectories) {
      // Inspect the direct profile parent before checking the child: a dangling
      // .runtime/application-data link must not look like an absent profile.
      const parent = path.dirname(filename);
      let parentInfo;
      try { parentInfo = await lstat(parent); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) unknown();
      const expectedParent = await realpath(parent);
      inspectedDirectories.push({ filename: parent, info: parentInfo, expectedPath: expectedParent });
      try { await lstat(filename); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const expectedPath = path.join(expectedParent, path.basename(filename));
      const entries = await directory(filename, expectedPath);
      for (const name of entries) {
        const entry = path.join(filename, name), expectedEntry = path.join(expectedPath, name);
        if (name === "host-scopes") {
          for (const scope of await directory(entry, expectedEntry)) {
            if (!/^[a-f0-9]{64}$/.test(scope)) unknown();
            const scopedPath = path.join(entry, scope), expectedScope = path.join(expectedEntry, scope);
            for (const file of await directory(scopedPath, expectedScope)) {
              if (file !== "roles.json") unknown();
              await rolesFile(path.join(scopedPath, file), path.join(expectedScope, file));
            }
          }
        } else {
          const info = await lstat(entry);
          if (info.isSymbolicLink() || await realpath(entry) !== expectedEntry ||
              !(metadataDirectories.has(name) && info.isDirectory() ||
                metadataFiles.has(name) && info.isFile() && info.nlink === 1)) unknown();
        }
      }
    }
    // A partially read or replaced tree must not become a successful probe.
    for (const { filename, info, expectedPath } of inspectedDirectories)
      if (!sameFile(info, await lstat(filename)) || await realpath(filename) !== expectedPath) unknown();
    return rolesPresent ? { localDataPresent: true, localDataSchemaVersion: "1.0.0" } : { localDataPresent: false };
  } catch { return { status: "unknown" }; }
}
