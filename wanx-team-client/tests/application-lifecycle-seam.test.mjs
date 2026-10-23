import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import path from 'node:path';
import { createApplicationLauncher } from '../applications/launcher.mjs';

const record = { applicationId: 'test.lifecycle', version: '1.0.0', installPath: path.resolve('installed/lifecycle'), entrypoint: 'main.cjs' };
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function fixture({ prepare, resolveRecord, onStarted, exitOnKill = true } = {}) {
  const children = [], sessions = [];
  const launcher = createApplicationLauncher({
    resolveRecord, onStarted,
    host: { async createSession() {
      const session = { launchId: String(sessions.length + 1), environment: { WANX_HOST_LAUNCH_ID: String(sessions.length + 1) }, closes: 0, async close() { this.closes++; } };
      sessions.push(session);
      if (prepare) await prepare.promise;
      return session;
    } },
    spawn(_file, _args, options) {
      const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, signals: [] });
      child.exit = () => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); };
      child.kill = signal => { child.signals.push(signal || 'SIGTERM'); if (exitOnKill) child.exit(); return true; };
      child.send = () => {};
      children.push(child);
      queueMicrotask(() => child.emit('message', { type: 'wanx:application-ready', launchId: options.env.WANX_HOST_LAUNCH_ID }));
      return child;
    },
  });
  return { launcher, children, sessions };
}

test('concurrent opens during session preparation share one process and launch', async () => {
  const prepare = deferred(), f = fixture({ prepare });
  const first = f.launcher.launch(record), second = f.launcher.launch(record);
  await setImmediate();
  prepare.resolve();
  const results = await Promise.all([first, second]);
  await f.launcher.stop(record.applicationId);
  for (const child of f.children) if (!child.signalCode) child.exit();
  assert.equal(f.children.length, 1);
  assert.equal(f.sessions.length, 1);
  assert.equal(results[0].launchId, results[1].launchId);
  assert.equal(f.sessions[0].closes, 1);
});

test('stop cancels preparation and closes the late session without spawning', async () => {
  const prepare = deferred(), f = fixture({ prepare });
  const result = f.launcher.launch(record).then(() => 'running', e => e.code);
  await setImmediate();
  const stopped = f.launcher.stop(record.applicationId);
  prepare.resolve();
  await stopped;
  const outcome = await result;
  await f.launcher.stop(record.applicationId);
  assert.equal(outcome, 'APPLICATION_START_CANCELED');
  assert.equal(f.children.length, 0);
  assert.equal(f.sessions[0].closes, 1);
});

test('stop waits for exit and coalesces opens queued during shutdown', async () => {
  const f = fixture({ exitOnKill: false });
  await f.launcher.launch(record);
  let stopped = false;
  const stopping = f.launcher.stop(record.applicationId).then(() => { stopped = true; });
  const next = f.launcher.launch(record), same = f.launcher.launch(record);
  await setImmediate();
  assert.equal(stopped, false);
  assert.equal(f.sessions[0].closes, 1);
  assert.equal(f.children.length, 1);
  f.children[0].exit();
  await stopping;
  const results = await Promise.all([next, same]);
  assert.equal(f.children.length, 2);
  assert.equal(results[0].launchId, results[1].launchId);
  const cleanup = f.launcher.close();
  await setImmediate();
  f.children[1].exit();
  await cleanup;
});

test('stop covers asynchronous record lookup and close rejects future opens', async () => {
  const lookup = deferred(), f = fixture({ resolveRecord: () => lookup.promise });
  const outcome = f.launcher.launch(record.applicationId).catch(e => e.code);
  await setImmediate();
  const closing = f.launcher.close();
  lookup.resolve(record);
  await closing;
  assert.equal(await outcome, 'APPLICATION_START_CANCELED');
  assert.equal(f.children.length, 0);
  assert.equal(f.sessions.length, 0);
  await assert.rejects(f.launcher.launch(record.applicationId), { code: 'APPLICATIONS_CLOSED' });
});

test('a second stop cancels queued opens instead of resurrecting the application', async () => {
  const f = fixture({ exitOnKill: false });
  await f.launcher.launch(record);
  const stopped = f.launcher.stop(record.applicationId);
  const queued = f.launcher.launch(record).catch(e => e.code);
  const stoppedAgain = f.launcher.stop(record.applicationId);
  await setImmediate();
  f.children[0].exit();
  await Promise.all([stopped, stoppedAgain]);
  assert.equal(await queued, 'APPLICATION_START_CANCELED');
  assert.equal(f.children.length, 1);
});

test('stop escalates and reports failure without allowing another process', async t => {
  const f = fixture({ exitOnKill: false });
  await f.launcher.launch(record);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopped = f.launcher.stop(record.applicationId).catch(e => e.code);
  const next = f.launcher.launch(record).catch(e => e.code);
  await setImmediate();
  t.mock.timers.tick(5000);
  await setImmediate();
  assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']);
  t.mock.timers.tick(2000);
  assert.equal(await stopped, 'APPLICATION_STOP_FAILED');
  assert.equal(await next, 'APPLICATION_STOP_FAILED');
  assert.equal(f.children.length, 1);
  f.children[0].exit();
  await f.launcher.close();
});


test('stop revokes and terminates an existing child while post-start work is blocked', async () => {
  const cleanup = deferred();
  const f = fixture({ onStarted: () => cleanup.promise });
  const opened = f.launcher.launch(record).catch(e => e.code);
  await setImmediate();
  const stopping = f.launcher.stop(record.applicationId);
  await setImmediate();
  const closesBeforeCleanup = f.sessions[0].closes;
  const signalsBeforeCleanup = [...f.children[0].signals];
  cleanup.resolve();
  await stopping;
  assert.equal(await opened, 'APPLICATION_START_CANCELED');
  assert.equal(closesBeforeCleanup, 1);
  assert.deepEqual(signalsBeforeCleanup, ['SIGTERM']);
});

test('stop resolves only after an actual child process has exited', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanx-real-child-'));
  const script = path.join(root, 'child.cjs');
  await writeFile(script, "process.send({ type: 'wanx:application-ready', launchId: process.env.WANX_HOST_LAUNCH_ID }); setInterval(() => {}, 1000);");
  let child, closes = 0;
  const launcher = createApplicationLauncher({
    host: { async createSession() { return { launchId: 'real-child', environment: { WANX_HOST_LAUNCH_ID: 'real-child' }, async close() { closes++; } }; } },
    electronPath: process.execPath, runtimeArgs: [script],
    spawn(...args) { child = spawn(...args); return child; },
  });
  t.after(async () => { await launcher.close(); await rm(root, { recursive: true, force: true }); });
  await launcher.launch({ ...record, installPath: root });
  await launcher.stop(record.applicationId);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(closes, 1);
});
