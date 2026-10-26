import { constants } from 'node:fs';
import { lstat, open, realpath, link, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { protectPrivateFile } from './private-storage.mjs';

const CHUNK = 1024 * 1024, MAXIMUM = 200 * CHUNK;
const fail = () => Object.assign(new Error('LOCAL_BACKUP_FILE_INVALID'), { code: 'LOCAL_BACKUP_FILE_INVALID' });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const digest = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;

// Paths and file descriptors never leave main. Source files are ciphertext;
// private recovery keys continue to use the separate 16 KiB recovery adapter.
export function createBackupFiles({ dialog, parentWindow = () => undefined, packaged = false,
  platform = process.platform, protectFile = protectPrivateFile } = {}) {
  const handles = new Map(), cleanups = new Set();
  let closed = false, generation = 0;
  const guard = (signal, expected = generation) => {
    if (closed || expected !== generation || signal?.aborted) throw fail();
  };
  const choose = (method, options) => {
    const window = parentWindow(); return window ? dialog[method](window, options) : dialog[method](options);
  };
  async function parent(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw fail();
    const directory = path.dirname(file), info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw fail();
    return { directory, info };
  }
  async function checkParent(value) {
    const info = await lstat(value.directory);
    if (!same(info, value.info) || !info.isDirectory() || info.isSymbolicLink()
      || await realpath(value.directory) !== value.directory) throw fail();
  }
  function checkFile(info, writing = false) {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAXIMUM
      || (platform !== 'win32' && (info.uid !== process.getuid() || info.mode & (writing ? 0o077 : 0o022)))) throw fail();
  }
  async function checkSource(item) {
    const info = await item.fd.stat(); checkFile(info);
    if (!same(info, item.info) || info.size !== item.info.size || info.mtimeMs !== item.info.mtimeMs
      || info.ctimeMs !== item.info.ctimeMs || !same(info, await lstat(item.file))) throw fail();
    await checkParent(item.parent);
  }
  async function cleanup(item) {
    await item.fd?.close().catch(() => {});
    if (item.partial && item.info) {
      const current = await lstat(item.partial).catch(() => null);
      if (current && same(current, item.info)) await unlink(item.partial).catch(() => {});
    }
  }
  function release(handle) {
    const item = handles.get(handle); if (!item) return Promise.resolve();
    handles.delete(handle);
    const task = cleanup(item); cleanups.add(task); void task.finally(() => cleanups.delete(task)); return task;
  }
  function remember(item) {
    if (handles.size >= 4) throw fail();
    const handle = randomBytes(32).toString('base64url'); handles.set(handle, item);
    return { handle, label: path.basename(item.file) };
  }
  async function use(handle, kind, signal, operation) {
    const expected = generation, item = handles.get(handle);
    guard(signal, expected);
    if (!item || item.kind !== kind || item.busy) throw fail();
    item.busy = true;
    const live = () => { guard(signal, expected); if (handles.get(handle) !== item) throw fail(); };
    let result;
    try { result = await operation(item, live); live(); return result; }
    catch { if (Buffer.isBuffer(result)) result.fill(0); await release(handle); throw fail(); }
    finally { item.busy = false; }
  }
  return Object.freeze({
    async chooseSource({ signal } = {}) {
      const expected = generation; guard(signal, expected);
      const result = await choose('showOpenDialog', { title: '选择加密业务备份（不是恢复材料）', buttonLabel: '检查备份',
        properties: ['openFile'], filters: [{ name: '加密业务备份', extensions: ['cxb'] }] });
      guard(signal, expected); if (result.canceled) return null;
      if (!Array.isArray(result.filePaths) || result.filePaths.length !== 1) throw fail();
      const file = path.resolve(result.filePaths[0]), container = await parent(file);
      let item, buffer;
      try {
        const before = await lstat(file); checkFile(before); if (!before.size) throw fail();
        const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        item = { kind: 'source', file, fd, parent: container, info: before };
        await checkSource(item); guard(signal, expected);
        const hash = createHash('sha256'); buffer = Buffer.alloc(Math.min(CHUNK, before.size));
        for (let offset = 0; offset < before.size;) {
          guard(signal, expected); await checkSource(item);
          const length = Math.min(buffer.length, before.size - offset);
          const { bytesRead } = await fd.read(buffer, 0, length, offset);
          if (bytesRead !== length) throw fail(); hash.update(buffer.subarray(0, length)); offset += length;
        }
        await checkSource(item); guard(signal, expected);
        item.archiveSha256 = hash.digest('base64url');
        return { ...remember(item), archiveBytes: before.size, archiveSha256: item.archiveSha256 };
      } catch { await cleanup(item || {}); throw fail(); }
      finally { buffer?.fill(0); }
    },
    readSource({ handle, offset, length, signal } = {}) {
      return use(handle, 'source', signal, async (item, live) => {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1
          || length > CHUNK || offset + length > item.info.size) throw fail();
        await checkSource(item); live();
        const bytes = Buffer.alloc(length);
        try {
          const { bytesRead } = await item.fd.read(bytes, 0, length, offset);
          if (bytesRead !== length) throw fail(); await checkSource(item); live(); return bytes;
        } catch (error) { bytes.fill(0); throw error; }
      });
    },
    async chooseDestination({ suggestedName, archiveBytes, archiveSha256, signal } = {}) {
      const expected = generation; guard(signal, expected);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(suggestedName || '') || !Number.isSafeInteger(archiveBytes)
        || archiveBytes < 1 || archiveBytes > MAXIMUM || !digest(archiveSha256)) throw fail();
      const result = await choose('showSaveDialog', { title: '另存加密业务备份', buttonLabel: '选择保存位置', defaultPath: suggestedName,
        filters: [{ name: '加密业务备份', extensions: ['cxb'] }] });
      guard(signal, expected); if (result.canceled || !result.filePath) return null;
      const file = path.resolve(result.filePath), container = await parent(file);
      let item;
      try {
        if (await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw fail();
        const partial = path.join(container.directory, '.centuarai-backup-' + randomBytes(16).toString('hex') + '.partial');
        const fd = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        item = { kind: 'destination', file, partial, fd, parent: container, archiveBytes,
          archiveSha256, offset: 0, hash: createHash('sha256') };
        item.info = await fd.stat();
        if (platform === 'win32') await protectFile(partial, { packaged });
        else await fd.chmod(0o600);
        checkFile(await fd.stat(), true); await checkParent(container); guard(signal, expected);
        return remember(item);
      } catch { await cleanup(item || {}); throw fail(); }
    },
    writeDestination({ handle, offset, bytes, signal } = {}) {
      return use(handle, 'destination', signal, async (item, live) => {
        if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > CHUNK || offset !== item.offset
          || offset + bytes.length > item.archiveBytes) throw fail();
        checkFile(await item.fd.stat(), true); await checkParent(item.parent); live();
        const copy = Buffer.from(bytes);
        try {
          let written = 0;
          while (written < copy.length) {
            live(); const result = await item.fd.write(copy, written, copy.length - written, offset + written);
            if (!result.bytesWritten) throw fail(); written += result.bytesWritten;
          }
          live(); item.hash.update(copy); item.offset += copy.length;
          return { writtenBytes: item.offset };
        } finally { copy.fill(0); }
      });
    },
    async commitDestination({ handle, signal } = {}) {
      const result = await use(handle, 'destination', signal, async (item, live) => {
        if (item.offset !== item.archiveBytes || item.hash.digest('base64url') !== item.archiveSha256) throw fail();
        await item.fd.sync(); const info = await item.fd.stat(); checkFile(info, true);
        if (info.size !== item.archiveBytes || !same(info, await lstat(item.partial))) throw fail();
        await checkParent(item.parent); live();
        // link() is an atomic no-replace publish; rename() could overwrite a
        // file created after the native dialog. Unsupported filesystems fail.
        await link(item.partial, item.file);
        try {
          live(); if (!same(info, await lstat(item.file))) throw fail();
          await unlink(item.partial); item.partial = null; await checkParent(item.parent); live();
          if (platform !== 'win32') {
            const directory = await open(item.parent.directory, constants.O_RDONLY | constants.O_DIRECTORY);
            try { await directory.sync(); } finally { await directory.close(); }
          }
          return { label: path.basename(item.file), archiveBytes: item.archiveBytes, archiveSha256: item.archiveSha256 };
        } catch (error) {
          const published = await lstat(item.file).catch(() => null);
          if (published && same(published, info)) await unlink(item.file).catch(() => {});
          throw error;
        }
      });
      await release(handle); return result;
    },
    release,
    invalidate() { generation++; return Promise.all([...handles.keys()].map(release)); },
    async close() { closed = true; generation++; await Promise.all([...handles.keys()].map(release)); await Promise.all([...cleanups]); },
  });
}
