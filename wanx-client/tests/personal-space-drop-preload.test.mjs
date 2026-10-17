import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../local-ui/remote-preload.cjs', import.meta.url), 'utf8');
test('native drop bridge accepts disk-backed Files and keeps their paths out of web results', async () => {
  const exposed = {}, calls = [], file = { name: 'drop.bin' };
  vm.runInNewContext(source, {
    process: { platform: 'darwin' },
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
      ipcRenderer: { on() {}, invoke: async (...args) => { calls.push(args); } },
      webUtils: { getPathForFile: value => { if (value === file) return '/private/local/drop.bin'; if (typeof value === 'object') return ''; throw new Error('Not a File'); } },
    }),
  });
  const result = await exposed.wanxClient.uploadDroppedFiles([file], { parent: 'a'.repeat(32) });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['wanx-client:space-upload-dropped', { parent: 'a'.repeat(32), paths: ['/private/local/drop.bin'] }]]);
  assert.doesNotMatch(JSON.stringify(result), /private|drop\.bin/);
  assert.equal((await exposed.wanxClient.uploadDroppedFiles([{ name: 'synthetic.bin' }])).ok, false);
  assert.equal((await exposed.wanxClient.uploadDroppedFiles(['/arbitrary/path'])).ok, false);
  assert.equal(calls.length, 1);
});

test('quick panel File bridge fixes the narrow channel and hides native paths and raw errors', async () => {
  const source = await readFile(new URL('../local-ui/panel-preload.cjs', import.meta.url), 'utf8');
  const exposed = {}, calls = [], files = [{ name: 'one.txt' }, { name: 'two.txt' }];
  let rejectUpload = false;
  vm.runInNewContext(source, {
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
      ipcRenderer: { on() {}, invoke: async (...args) => {
        calls.push(args);
        if (rejectUpload) throw new Error('SPACE_DROP_FILES_ONLY /private/path');
        return { privatePath: '/never-expose' };
      } },
      webUtils: { getPathForFile: file => files.includes(file) ? `/private/${file.name}` : '' },
    }),
  });
  const api = exposed.wanxPanel;
  const result = await api.uploadDroppedFiles(files, 'scope-a');
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /private|never-expose/);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['wanx-client:panel-space-upload', { paths: ['/private/one.txt', '/private/two.txt'], scope: 'scope-a' }]]);
  assert.equal((await api.uploadDroppedFiles(['/arbitrary/path'], 'scope-a')).ok, false);
  assert.equal(calls.length, 1);
  rejectUpload = true;
  assert.deepEqual(JSON.parse(JSON.stringify(await api.uploadDroppedFiles(files, 'scope-a'))), { ok: false, code: 'SPACE_DROP_FILES_ONLY' });
  await assert.rejects(api.action('panel-space-upload', { paths: ['/arbitrary'] }), /PANEL_ACTION_NOT_ALLOWED/);
});
