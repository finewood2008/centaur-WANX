import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { protectPrivateFile } from './private-storage.mjs';

const MAX_MATERIAL_BYTES = 16 * 1024;
const fail = () => Object.assign(new Error('LOCAL_TRUST_RECOVERY_FILE_INVALID'), { code: 'LOCAL_TRUST_RECOVERY_FILE_INVALID' });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

// Only native dialogs supply paths. The renderer receives opaque handles and a
// basename; it cannot choose a filesystem path or request an arbitrary read.
export function createRecoveryFiles({ dialog, parentWindow = () => undefined, packaged = false,
  platform = process.platform, protectFile = protectPrivateFile } = {}) {
  const handles = new Map();
  let closed = false;
  const guard = signal => { if (closed) throw fail(); signal?.throwIfAborted(); };
  const choose = (method, options) => { const window = parentWindow(); return window ? dialog[method](window, options) : dialog[method](options); };
  const checkFile = info => {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_MATERIAL_BYTES
      || (platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw fail();
  };
  async function parent(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw fail();
    const directory = path.dirname(file), info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw fail();
    return { directory, info };
  }
  async function checkParent(value) {
    const info = await lstat(value.directory);
    if (!sameFile(value.info, info) || !info.isDirectory() || info.isSymbolicLink()
      || await realpath(value.directory) !== value.directory) throw fail();
  }
  function remember(file, bytes) {
    if (handles.size >= 8) throw fail();
    const handle = randomBytes(32).toString('base64url');
    handles.set(handle, { bytes });
    return { handle, label: path.basename(file), ...(bytes ? { bytes } : {}) };
  }
  return Object.freeze({
    async exportRecovery({ suggestedName, bytes, signal } = {}) {
      guard(signal);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/.test(suggestedName || '')
        || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_MATERIAL_BYTES) throw fail();
      const result = await choose('showSaveDialog', { title: '保存离线恢复材料',
        defaultPath: suggestedName, buttonLabel: '保存恢复材料', filters: [{ name: '恢复材料', extensions: ['json'] }] });
      guard(signal); if (result.canceled || !result.filePath) return null;
      const file = path.resolve(result.filePath), directory = await parent(file); guard(signal);
      let handle, created, success = false;
      const copy = Buffer.from(bytes);
      try {
        handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created = await handle.stat(); guard(signal);
        // ACL is installed before private bytes enter a newly created file.
        if (platform === 'win32') await protectFile(file, { packaged });
        checkFile(await handle.stat()); await checkParent(directory); guard(signal);
        await handle.writeFile(copy); await handle.sync(); guard(signal);
        const after = await lstat(file); checkFile(after);
        if (!sameFile(created, after)) throw fail();
        await checkParent(directory); guard(signal);
        const remembered = remember(file); success = true; return remembered;
      } catch { throw fail(); }
      finally {
        copy.fill(0); await handle?.close();
        if (created && !success) {
          const current = await lstat(file).catch(() => null);
          if (current && sameFile(created, current)) await unlink(file).catch(() => {});
        }
      }
    },
    async importRecovery({ signal } = {}) {
      guard(signal);
      const result = await choose('showOpenDialog', { title: '重新打开已保存的恢复材料',
        buttonLabel: '验证恢复材料', properties: ['openFile'], filters: [{ name: '恢复材料', extensions: ['json'] }] });
      guard(signal); if (result.canceled) return null;
      if (!Array.isArray(result.filePaths) || result.filePaths.length !== 1) throw fail();
      const file = path.resolve(result.filePaths[0]), directory = await parent(file);
      let handle, bytes;
      try {
        const before = await lstat(file); checkFile(before); guard(signal);
        if (platform === 'win32') await protectFile(file, { packaged, verify: true });
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = await handle.stat(); checkFile(opened);
        if (!sameFile(before, opened)) throw fail();
        bytes = Buffer.alloc(opened.size);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const after = await handle.stat();
        if (bytesRead !== bytes.length || !bytes.length || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs
          || !sameFile(after, await lstat(file))) throw fail();
        await checkParent(directory); guard(signal);
        return remember(file, bytes);
      } catch { bytes?.fill(0); throw fail(); }
      finally { await handle?.close(); }
    },
    release(handle) { const item = handles.get(handle); item?.bytes?.fill(0); handles.delete(handle); },
    close() { closed = true; for (const item of handles.values()) item.bytes?.fill(0); handles.clear(); },
  });
}
