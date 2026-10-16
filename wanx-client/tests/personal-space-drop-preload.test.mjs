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
