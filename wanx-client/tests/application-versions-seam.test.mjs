import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApplicationInstaller } from '../applications/installer.mjs';

const manifest = { applicationId: 'test.versions', name: 'Versions', version: '1.0.0', protocolVersion: 1, runtime: 'electron', entrypoint: 'main.cjs' };
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanx-versions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), installed = path.join(root, 'installed');
  await mkdir(source);
  await writeFile(path.join(source, 'main.cjs'), 'fixture');
  const installer = createApplicationInstaller({ rootDir: installed, ...options });
  return { root, source, installed, installer, install: version => installer.install({ sourceDir: source, manifest: { ...manifest, version } }) };
}

test('higher versions replace the single current record using semantic ordering', async t => {
  const f = await fixture(t);
  const old = await f.install('1.9.0');
  await f.install('1.10.0');
  assert.deepEqual((await f.installer.list()).map(r => r.version), ['1.10.0']);
  assert.equal(await readFile(path.join(old.installPath, 'main.cjs'), 'utf8'), 'fixture');
  await assert.rejects(f.install('1.8.0'), { code: 'APPLICATION_VERSION_DOWNGRADE' });
  await assert.rejects(f.install('1.10.0+rebuilt'), { code: 'APPLICATION_VERSION_ALREADY_INSTALLED' });
});

test('prerelease ordering and strict new package versions are enforced', async t => {
  const f = await fixture(t);
  await f.install('2.0.0-beta.2');
  await f.install('2.0.0-beta.10');
  await assert.rejects(f.install('2.0.0-alpha.9'), { code: 'APPLICATION_VERSION_DOWNGRADE' });
  await f.install('2.0.0');
  for (const version of ['v3.0.0', '03.0.0', 'next', '3', '3.0.0-01']) {
    await assert.rejects(f.install(version), { code: 'INVALID_APPLICATION_VERSION' });
  }
});

test('failed package preparation leaves the current version and contents intact', async t => {
  const f = await fixture(t);
  await f.install('1.0.0');
  const broken = createApplicationInstaller({ rootDir: f.installed, copy: async () => { throw new Error('disk failure'); } });
  await assert.rejects(broken.install({ sourceDir: f.source, manifest: { ...manifest, version: '2.0.0' } }), { code: 'APPLICATION_INSTALL_FAILED' });
  assert.equal((await f.installer.resolveCurrent(manifest.applicationId)).version, '1.0.0');
});

test('concurrent updates cannot downgrade or publish duplicate installations', async t => {
  const f = await fixture(t);
  await f.install('1.0.0');
  const updates = await Promise.allSettled([f.install('2.0.0'), f.install('3.0.0'), f.install('2.0.0')]);
  assert.equal(updates[1].status, 'fulfilled');
  assert.ok(!(updates[0].status === 'fulfilled' && updates[2].status === 'fulfilled'));
  for (const result of updates.filter(r => r.status === 'rejected')) {
    assert.ok(['APPLICATION_VERSION_ALREADY_INSTALLED', 'APPLICATION_VERSION_DOWNGRADE'].includes(result.reason.code));
  }
  assert.equal((await f.installer.resolveCurrent(manifest.applicationId)).version, '3.0.0');
});

async function legacy(f, version) {
  const installPath = path.join(f.installed, manifest.applicationId, version.replace(/[^A-Za-z0-9._-]/g, '_'));
  await mkdir(installPath, { recursive: true });
  await writeFile(path.join(installPath, 'main.cjs'), 'legacy');
  await writeFile(path.join(installPath, '.wanx-install.json'), JSON.stringify({ ...manifest, version, installPath }));
  return installPath;
}

test('legacy semantic versions select the highest while ambiguous labels require a persistent choice', async t => {
  const f = await fixture(t);
  await legacy(f, '1.9.0'); await legacy(f, '1.10.0');
  assert.equal((await f.installer.resolveCurrent(manifest.applicationId)).version, '1.10.0');
  const old = await legacy(f, 'preview');
  assert.equal((await f.installer.list())[0].selectionRequired, true);
  await assert.rejects(f.installer.resolveCurrent(manifest.applicationId), { code: 'APPLICATION_VERSION_SELECTION_REQUIRED' });
  await assert.rejects(f.install('2.0.0'), { code: 'APPLICATION_VERSION_SELECTION_REQUIRED' });
  await f.installer.selectCurrent(manifest.applicationId, '1.10.0');
  const reopened = createApplicationInstaller({ rootDir: f.installed });
  assert.equal((await reopened.resolveCurrent(manifest.applicationId)).version, '1.10.0');
  assert.equal(await readFile(path.join(old, 'main.cjs'), 'utf8'), 'legacy');
  await assert.rejects(reopened.selectCurrent(manifest.applicationId, '1.9.0'), { code: 'APPLICATION_VERSION_SELECTION_INVALID' });
});

test('a selected legacy label can migrate to a standard version only by explicit selection', async t => {
  const f = await fixture(t);
  await legacy(f, 'preview');
  await f.installer.selectCurrent(manifest.applicationId, 'preview');
  await f.install('1.0.0');
  const pending = (await f.installer.list())[0];
  assert.equal(pending.selectionRequired, true);
  assert.deepEqual(pending.versions.map(r => r.version), ['preview', '1.0.0']);
  await f.installer.selectCurrent(manifest.applicationId, '1.0.0');
  await f.install('1.0.1');
  assert.equal((await f.installer.resolveCurrent(manifest.applicationId)).version, '1.0.1');
});

test('cancellation before commit leaves the installed version unchanged', async t => {
  const f = await fixture(t);
  await f.install('1.0.0');
  const controller = new AbortController();
  const { cp } = await import('node:fs/promises');
  const installer = createApplicationInstaller({ rootDir: f.installed, copy: async (...args) => {
    await cp(...args); controller.abort();
  } });
  await assert.rejects(installer.install({ sourceDir: f.source, manifest: { ...manifest, version: '2.0.0' } }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await f.installer.resolveCurrent(manifest.applicationId)).version, '1.0.0');
});
