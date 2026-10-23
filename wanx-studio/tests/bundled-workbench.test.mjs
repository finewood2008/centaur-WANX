import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installBundledWorkbench } from '../integration/bundled-workbench.mjs';

test('bundled workbench materializes nested files once and cleans staging after install', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'studio-bundle-test-'));
  let directory, installed = [], calls = 0;
  try {
    await mkdir(path.join(source, 'shell'));
    await writeFile(path.join(source, 'application.manifest.json'), JSON.stringify({ applicationId: 'ai.wanx.studio', version: '0.1.1' }));
    await writeFile(path.join(source, 'shell/main.cjs'), 'trusted bundle');
    const installer = { list: async () => installed, install: async input => {
      calls++; directory = input.sourceDir;
      assert.equal(await readFile(path.join(directory, 'shell/main.cjs'), 'utf8'), 'trusted bundle');
      installed = [{ applicationId: 'ai.wanx.studio', version: '0.1.1' }];
    } };
    await installBundledWorkbench(installer, source);
    await assert.rejects(access(directory), { code: 'ENOENT' });
    await installBundledWorkbench(installer, source);
    assert.equal(calls, 1);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('failed bundled install cleans staging and remains retryable', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'studio-bundle-test-'));
  let directory;
  try {
    await writeFile(path.join(source, 'application.manifest.json'), JSON.stringify({ applicationId: 'ai.wanx.studio', version: '0.1.1' }));
    const installer = { list: async () => [], install: async input => { directory = input.sourceDir; throw new Error('INSTALL_FAILED'); } };
    await assert.rejects(installBundledWorkbench(installer, source), /INSTALL_FAILED/);
    await assert.rejects(access(directory), { code: 'ENOENT' });
    await assert.rejects(installBundledWorkbench(installer, source, { signal: AbortSignal.abort() }));
  } finally { await rm(source, { recursive: true, force: true }); }
});
