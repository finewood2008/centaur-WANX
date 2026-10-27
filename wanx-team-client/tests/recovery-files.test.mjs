import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, lstat, symlink, link, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRecoveryFiles } from '../shell/recovery-files.mjs';

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'recovery-file-test-')));
  const file = path.join(root, 'recovery.json');
  const service = createRecoveryFiles({ dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: file }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [file] }),
  }, ...options });
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, file, service };
}
test('recovery export and actual re-import use a private file and opaque releasable handles', async t => {
  const { file, service } = await fixture(t);
  const bytes = Buffer.from('{"synthetic":"not a real recovery key"}');
  const saved = await service.exportRecovery({ suggestedName: 'recovery.json', bytes });
  assert.deepEqual(Object.keys(saved).sort(), ['handle', 'label']);
  assert.equal(saved.label, 'recovery.json'); assert.equal(saved.handle.length, 43);
  assert.deepEqual(await readFile(file), bytes);
  if (process.platform !== 'win32') assert.equal((await lstat(file)).mode & 0o077, 0);
  const imported = await service.importRecovery(); assert.deepEqual(imported.bytes, bytes);
  service.release(imported.handle); assert.ok(imported.bytes.every(byte => byte === 0));
  service.release(saved.handle);
});
test('export never overwrites an existing recovery file or follows a final symlink', async t => {
  const { root, file, service } = await fixture(t);
  await writeFile(file, 'original', { mode: 0o600 });
  await assert.rejects(service.exportRecovery({ suggestedName: 'recovery.json', bytes: Buffer.from('new') }));
  assert.equal(await readFile(file, 'utf8'), 'original');
  if (process.platform === 'win32') return;
  await rm(file); const target = path.join(root, 'target'); await writeFile(target, 'target', { mode: 0o600 });
  await symlink(target, file);
  await assert.rejects(service.importRecovery());
  await assert.rejects(service.exportRecovery({ suggestedName: 'recovery.json', bytes: Buffer.from('new') }));
  assert.equal(await readFile(target, 'utf8'), 'target');
});
test('import rejects oversized, multiply linked and public recovery material', async t => {
  const { root, file, service } = await fixture(t);
  await writeFile(file, Buffer.alloc(16 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(service.importRecovery());
  await rm(file); await writeFile(file, 'synthetic', { mode: 0o600 });
  await link(file, path.join(root, 'other'));
  await assert.rejects(service.importRecovery());
  await rm(file); await writeFile(file, 'synthetic', { mode: 0o644 });
  if (process.platform !== 'win32') await assert.rejects(service.importRecovery());
});
test('lock while a native dialog is open prevents file creation', async t => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const { file, service } = await fixture(t, { dialog: { showSaveDialog: () => response } });
  const controller = new AbortController();
  const pending = service.exportRecovery({ suggestedName: 'recovery.json', bytes: Buffer.from('synthetic'), signal: controller.signal });
  const rejected = assert.rejects(pending); controller.abort(); finish({ canceled: false, filePath: file }); await rejected;
  await assert.rejects(lstat(file), { code: 'ENOENT' });
});
test('Windows file ACL protection runs before writing bytes and failures leave no material', async t => {
  let seen;
  const { file, service } = await fixture(t, { platform: 'win32', protectFile: async target => {
    seen = await readFile(target); throw new Error('synthetic ACL failure');
  } });
  await assert.rejects(service.exportRecovery({ suggestedName: 'recovery.json', bytes: Buffer.from('secret') }));
  assert.equal(seen.length, 0); await assert.rejects(lstat(file), { code: 'ENOENT' });
});
