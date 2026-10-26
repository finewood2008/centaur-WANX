import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, lstat, readdir, symlink, link, rm, truncate } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createBackupFiles } from '../shell/backup-files.mjs';

const CHUNK = 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('base64url');
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'backup-files-')));
  const file = path.join(root, 'encrypted-backup.cab');
  const service = createBackupFiles({ dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: file }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [file] }),
  }, ...options });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, file, service,
    destination: bytes => service.chooseDestination({ suggestedName: 'encrypted-backup.cab', archiveBytes: bytes.length, archiveSha256: sha(bytes) }) };
}
test('native ciphertext save/import hashes actual bounded chunks and exposes only opaque metadata', async t => {
  const e = await fixture(t), bytes = Buffer.alloc(CHUNK + 17, 37), target = await e.destination(bytes);
  assert.deepEqual(Object.keys(target).sort(), ['handle', 'label']);
  await assert.rejects(lstat(e.file), { code: 'ENOENT' });
  for (let offset = 0; offset < bytes.length; offset += CHUNK)
    await e.service.writeDestination({ handle: target.handle, offset, bytes: bytes.subarray(offset, offset + CHUNK) });
  const result = await e.service.commitDestination({ handle: target.handle });
  assert.deepEqual(result, { label: 'encrypted-backup.cab', archiveBytes: bytes.length, archiveSha256: sha(bytes) });
  assert.deepEqual(await readFile(e.file), bytes);
  if (process.platform !== 'win32') assert.equal((await lstat(e.file)).mode & 0o777, 0o600);
  const source = await e.service.chooseSource();
  assert.deepEqual(Object.keys(source).sort(), ['archiveBytes', 'archiveSha256', 'handle', 'label']);
  assert.equal(source.archiveSha256, sha(bytes));
  assert.deepEqual(await e.service.readSource({ handle: source.handle, offset: CHUNK, length: 17 }), bytes.subarray(CHUNK));
  await e.service.release(source.handle);
  await assert.rejects(e.service.readSource({ handle: source.handle, offset: 0, length: 1 }));
  assert.deepEqual(await readdir(e.root), ['encrypted-backup.cab']);
});
test('wrong hash, out-of-order write and oversized chunk never publish or retain partial files', async t => {
  const e = await fixture(t), bytes = Buffer.from('ciphertext');
  for (const mutate of ['hash', 'offset', 'chunk']) {
    const target = await e.destination(bytes);
    if (mutate === 'hash') {
      await e.service.writeDestination({ handle: target.handle, offset: 0, bytes: Buffer.alloc(bytes.length, 1) });
      await assert.rejects(e.service.commitDestination({ handle: target.handle }));
    } else await assert.rejects(e.service.writeDestination({ handle: target.handle, offset: mutate === 'offset' ? 1 : 0,
      bytes: mutate === 'chunk' ? Buffer.alloc(CHUNK + 1) : bytes }));
    assert.deepEqual(await readdir(e.root), []);
  }
});
test('existing or racing destination is never replaced and source symlink/hardlink/changed inode fail', async t => {
  const e = await fixture(t), bytes = Buffer.from('ciphertext'), target = await e.destination(bytes);
  await e.service.writeDestination({ handle: target.handle, offset: 0, bytes });
  await writeFile(e.file, 'unrelated', { mode: 0o600 });
  await assert.rejects(e.service.commitDestination({ handle: target.handle }));
  assert.equal(await readFile(e.file, 'utf8'), 'unrelated');
  await assert.rejects(e.destination(bytes));
  const source = await e.service.chooseSource();
  await rm(e.file); await writeFile(e.file, 'replacement', { mode: 0o600 });
  await assert.rejects(e.service.readSource({ handle: source.handle, offset: 0, length: 1 }));
  await link(e.file, path.join(e.root, 'second'));
  await assert.rejects(e.service.chooseSource());
  if (process.platform !== 'win32') {
    await rm(e.file); await symlink(path.join(e.root, 'second'), e.file);
    await assert.rejects(e.service.chooseSource());
  }
});
test('lock aborts open dialog and clears source/destination handles and partial bytes', async t => {
  let finish;
  const pendingDialog = new Promise(resolve => { finish = resolve; });
  const e = await fixture(t), bytes = Buffer.from('ciphertext'), target = await e.destination(bytes);
  await e.service.writeDestination({ handle: target.handle, offset: 0, bytes });
  await e.service.invalidate();
  await assert.rejects(e.service.commitDestination({ handle: target.handle }));
  assert.deepEqual(await readdir(e.root), []);
  const later = createBackupFiles({ dialog: { showSaveDialog: () => pendingDialog } });
  const task = later.chooseDestination({ suggestedName: 'backup.cab', archiveBytes: bytes.length, archiveSha256: sha(bytes) });
  const rejected = assert.rejects(task); await later.invalidate(); finish({ canceled: false, filePath: e.file }); await rejected;
  await later.close(); assert.deepEqual(await readdir(e.root), []);
});
test('200 MiB limit is checked from real stat and Windows ACL runs before ciphertext', async t => {
  const e = await fixture(t);
  await writeFile(e.file, '', { mode: 0o600 }); await truncate(e.file, 200 * CHUNK + 1);
  await assert.rejects(e.service.chooseSource()); await rm(e.file);
  const bytes = Buffer.from('ciphertext'); let observed;
  const windows = await fixture(t, { platform: 'win32', protectFile: async file => {
    observed = await readFile(file); throw new Error('synthetic ACL failure');
  } });
  await assert.rejects(windows.destination(bytes));
  assert.equal(observed.length, 0); assert.deepEqual(await readdir(windows.root), []);
});
