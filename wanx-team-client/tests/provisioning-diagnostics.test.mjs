import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTimingRecorder } from '../shell/timings.mjs';
import { createProvisioningHost } from '../shell/provisioning-host.cjs';

test('provisioning diagnostics persist only fixed stages and errors, never credentials or arbitrary labels', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wanx-setup-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'connection.jsonl');
  const recorder = createTimingRecorder({ filePath });
  recorder.provisioning({
    operation: 'connect', outcome: 'failed', durationMs: 123, attempt: 2,
    source: 'renderer', stage: 'service', errorName: 'NetworkError',
    errorCode: 'LOCAL_TRANSPORT_DISCONNECTED',
    requestId: '12345678-1234-4234-8234-123456789abc',
    password: 'SECRET', message: 'SECRET', deviceId: 'SECRET', stack: 'SECRET',
  });
  recorder.provisioning({
    operation: 'request', outcome: 'failed', durationMs: 35000,
    source: 'deadline', messageType: 'pairing.token.result',
    errorCode: 'GATT_FRAGMENT_INCOMPLETE', token: 'SECRET', frame: 'SECRET',
  });
  recorder.provisioning({
    operation: 'readDeviceInfo', outcome: 'failed', durationMs: -1,
    source: 'SECRET', stage: 'SECRET', errorName: 'SECRET', errorCode: 'SECRET',
    requestId: 'SECRET', attempt: 'SECRET', messageType: 'SECRET',
  });
  recorder.provisioning({ operation: 'SECRET', outcome: 'failed' });
  await recorder.flush();
  const contents = await readFile(filePath, 'utf8');
  assert.doesNotMatch(contents, /SECRET|password|token":|frame":|deviceId|stack|message":/);
  const rows = contents.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].step, 'setup.transport');
  assert.equal(rows[0].stage, 'service');
  assert.equal(rows[0].errorName, 'NetworkError');
  assert.equal(rows[0].attempt, 2);
  assert.equal(rows[1].messageType, 'pairing.token.result');
  assert.equal(rows[1].source, 'deadline');
  assert.equal(rows[2].errorCode, 'UNKNOWN_ERROR');
  assert.equal(Object.hasOwn(rows[2], 'durationMs'), false);
});

test('Main records both failed connection attempts with renderer stage and bounded elapsed time', async t => {
  const ipcMain = new EventEmitter(), contents = new EventEmitter(), records = [];
  ipcMain.handle = () => {};
  ipcMain.removeHandler = () => {};
  contents.mainFrame = { url: 'file:///diagnostic-test.html' };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  contents.send = (channel, input) => {
    if (channel !== 'wanx:setup:transport') return;
    queueMicrotask(() => ipcMain.emit('wanx:setup:transport-result', event, {
      requestId: input.requestId, ok: input.operation !== 'connect',
      code: 'LOCAL_TRANSPORT_DISCONNECTED',
      diagnostic: { stage: 'service', errorName: 'NetworkError', message: 'SECRET' },
    }));
  };
  let ticks = 0;
  const host = await createProvisioningHost({
    webContents: contents, ipcMain, documentUrl: contents.mainFrame.url,
    onDiagnostic: record => records.push(record),
    clock: { monotonicMs: () => ++ticks, nowUtc: () => new Date().toISOString() },
    consumer: {
      current: async () => ({ accountId: 'SECRET-account', clientId: 'SECRET-client' }),
      pairingApi: async () => ({}),
    },
    cryptoFactory: () => ({}),
    coordinatorFactory: ({ transportFactory }) => ({
      subscribe: () => () => {},
      getSnapshot: () => ({ state: 'idle' }),
      begin: async (input, signal) => { await transportFactory.connect(input.selected, signal); },
      suspend: async () => {}, dispose: async () => {},
    }),
  });
  t.after(() => host.dispose());
  await assert.rejects(host.begin({
    candidateId: 'candidate', transport: 'ble-gatt', transportHandle: 'handle',
    selectionLeaseId: 'lease', advertisedName: 'SECRET-name', rssi: -40,
    firstSeenMonotonicMs: 0, lastSeenMonotonicMs: 1,
  }), { code: 'LOCAL_TRANSPORT_DISCONNECTED' });
  const failures = records.filter(record => record.operation === 'connect');
  assert.equal(failures.length, 2);
  assert.deepEqual(failures.map(record => record.attempt), [1, 2]);
  for (const record of failures) {
    assert.equal(record.source, 'renderer');
    assert.equal(record.stage, 'service');
    assert.equal(record.errorName, 'NetworkError');
    assert.ok(record.durationMs >= 0);
  }
  assert.doesNotMatch(JSON.stringify(records), /SECRET/);
});
