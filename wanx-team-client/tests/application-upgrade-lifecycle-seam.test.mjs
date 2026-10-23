import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { createApplicationManager } from '../applications/manager.mjs';

const manifest = { applicationId: 'test.upgrade', name: 'Upgrade', version: '1.0.0', protocolVersion: 1, runtime: 'electron', entrypoint: 'main.cjs' };
async function fixture(t, { createConnection, automaticReady = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanx-upgrade-'));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'main.cjs'), 'fixture');
  const children = [];
  let failStart = false;
  const manager = await createApplicationManager({
    applicationRoot: path.join(root, 'installed'), applicationId: 'test-host', createConnection,
    context: () => ({ connection: 'ready', boxId: 'fixture' }),
    spawn(_file, _args, options) {
      const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, environment: options.env });
      child.send = () => {};
      child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); return true; };
      children.push(child);
      child.ready = () => child.emit('message', { type: failStart ? 'wanx:application-failed' : 'wanx:application-ready', launchId: options.env.WANX_HOST_LAUNCH_ID });
      if (automaticReady) queueMicrotask(child.ready);
      return child;
    },
  });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { source, manager, children, failStart(value) { failStart = value; }, async install(version) {
    await writeFile(path.join(source, 'application.manifest.json'), JSON.stringify({ ...manifest, version }));
    return manager.install({ sourceDir: source });
  } };
}

test('installing an update preserves the running directory until the next successful open', async t => {
  const f = await fixture(t);
  const old = await f.install('1.0.0');
  await f.manager.launch(manifest.applicationId);
  const next = await f.install('1.1.0');
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].signalCode, null);
  assert.equal(await readFile(path.join(old.installPath, 'main.cjs'), 'utf8'), 'fixture');
  assert.deepEqual((await f.manager.listInstalled()).map(r => r.version), ['1.1.0']);
  // A stale renderer's version argument cannot select an old installation.
  await f.manager.launch(manifest.applicationId, '1.0.0');
  assert.equal(f.children[0].signalCode, 'SIGTERM');
  assert.equal(f.children.length, 2);
  await assert.rejects(access(old.installPath), { code: 'ENOENT' });
  await access(next.installPath);
});

test('a failed first launch retains the selected update and can retry with fresh credentials', async t => {
  const f = await fixture(t);
  await f.install('1.0.0'); await f.manager.launch(manifest.applicationId);
  const next = await f.install('1.1.0'); f.failStart(true);
  await assert.rejects(f.manager.launch(manifest.applicationId), { code: 'APPLICATION_START_FAILED' });
  assert.equal((await f.manager.listInstalled())[0].version, '1.1.0');
  await access(next.installPath);
  const failedToken = f.children[1].environment.WANX_HOST_TOKEN;
  f.failStart(false);
  await f.manager.launch(manifest.applicationId);
  assert.notEqual(f.children[2].environment.WANX_HOST_TOKEN, failedToken);
  assert.equal(f.children[1].signalCode, 'SIGTERM');
});

test('manager close cancels a pending box lease and forbids later installation or launch', async t => {
  let resolve, entered;
  const inConnection = new Promise(r => { entered = r; });
  const f = await fixture(t, { createConnection: () => { entered(); return new Promise(r => { resolve = r; }); } });
  await f.install('1.0.0');
  const opened = f.manager.launch(manifest.applicationId).catch(e => e.code);
  await inConnection;
  const closing = f.manager.close();
  resolve({ context: () => ({ connection: 'ready', boxId: 'fixture' }) });
  await closing;
  assert.equal(await opened, 'APPLICATION_START_CANCELED');
  assert.equal(f.children.length, 0);
  await assert.rejects(f.manager.launch(manifest.applicationId), { code: 'APPLICATIONS_CLOSED' });
  await assert.rejects(f.install('1.1.0'), { code: 'APPLICATIONS_CLOSED' });
});

test('stopping while waiting for the first window rejects launch and releases its channel', async t => {
  const f = await fixture(t, { automaticReady: false });
  await f.install('1.0.0');
  const opened = f.manager.launch(manifest.applicationId).catch(e => e.code);
  while (!f.children.length) await setImmediate();
  await f.manager.stop(manifest.applicationId);
  f.children[0].ready();
  assert.equal(await opened, 'APPLICATION_START_CANCELED');
  assert.equal(f.children[0].signalCode, 'SIGTERM');
});
