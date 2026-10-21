import { lstat, opendir } from "node:fs/promises";
import path from "node:path";

export const IMPORT_PAGE = 20;
export const IMPORT_WINDOW = 80;
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const uploadStamp = info => info ? `${info.size}:${info.mtimeMs}:${info.ino}` : null;
export const validUploadName = name => typeof name === "string" && !!name.trim() && name === name.trim() && !/[\\/:*?"<>|\x00-\x1f]/.test(name) && !name.endsWith(".") && Buffer.byteLength(name, "utf8") <= 240;
export function sourceError(error) {
  return ({ ENOENT: "SPACE_SOURCE_MISSING", EACCES: "SPACE_SOURCE_UNREADABLE", EPERM: "SPACE_SOURCE_UNREADABLE", ENOTDIR: "SPACE_SOURCE_CHANGED" })[error?.code] || "SPACE_SOURCE_UNREADABLE";
}

// Only native main-process paths enter this iterator. Directory handles are bounded
// by depth, and each page is persisted before any of its files may be dispatched.
// Restart rescans roots and deduplicates by (batch, relative key), not by filename.
export async function* walkUploads(sources, signal) {
  async function* visit(localPath, name, key, relativePath, parentKey) {
    if (signal.aborted) throw signal.reason;
    let info;
    try { info = await lstat(localPath); }
    catch (error) { yield { localPath, name, key, relativePath, parentKey, kind: "file", error: sourceError(error) }; return; }
    const node = { localPath, name, key, relativePath, parentKey, kind: info.isDirectory() ? "folder" : "file", size: info.isFile() ? info.size : 0, localStamp: uploadStamp(info) };
    const error = !validUploadName(name) ? "SPACE_INVALID_NAME" : info.isSymbolicLink() ? "SPACE_SOURCE_LINK" : !info.isFile() && !info.isDirectory() ? "SPACE_SOURCE_UNSUPPORTED" : info.isFile() && info.size > MAX_UPLOAD_BYTES ? "SPACE_UPLOAD_LIMIT" : null;
    if (error) { yield { ...node, error }; return; }
    yield node;
    if (node.kind !== "folder") return;
    try {
      const directory = await opendir(localPath);
      for await (const child of directory) {
        if (signal.aborted) throw signal.reason;
        yield* visit(path.join(localPath, child.name), child.name, `${key}/${child.name}`, `${relativePath}/${child.name}`, key);
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      yield { ...node, kind: "scan-error", key: `${key}/`, error: sourceError(error) };
    }
  }
  for (const [index, source] of sources.entries()) yield* visit(source.localPath, source.name, String(index), source.name, null);
}

export function importSummaries(tasks, scope) {
  const groups = new Map();
  for (const task of tasks) {
    if (task.scope !== scope || !task.batchId || task.direction === "download") continue;
    let group = groups.get(task.batchId);
    if (!group) groups.set(task.batchId, group = { id: task.batchId, name: task.batchName || task.name, files: 0, folders: 0, completed: 0, failed: 0, pending: 0, paused: 0, size: 0, offset: 0, scanComplete: true });
    if (task.direction === "import") { group.scanComplete = task.scanComplete === true; group.scanner = task.phase; continue; }
    if (task.phase === "canceled") continue;
    if (task.kind === "folder") group.folders++;
    else if (task.kind !== "scan-error") { group.files++; group.size += task.size || 0; group.offset += task.offset || 0; }
    if (task.phase === "complete") group.completed++;
    else if (task.phase === "paused" && task.pauseReason === "error") group.failed++;
    else { group.pending++; if (task.phase === "paused") group.paused++; }
  }
  return [...groups.values()].map(group => ({ ...group, phase: !group.scanComplete && group.scanner !== "paused" ? "scanning" : group.pending ? group.paused === group.pending && (group.scanComplete || group.scanner === "paused") ? "paused" : "running" : !group.scanComplete && group.scanner === "paused" ? "paused" : group.failed ? "failed" : "complete" }));
}
