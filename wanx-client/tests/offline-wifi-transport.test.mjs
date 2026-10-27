import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOfflineWifiTransport } from '../shell/offline-wifi-transport.mjs';

const selected = { candidateId: 'candidate-1', transport: 'ble-gatt', transportHandle: 'handle-1',
  selectionLeaseId: 'lease-1', advertisedName: 'untrusted-name', rssi: null,
  firstSeenMonotonicMs: 1, lastSeenMonotonicMs: 1 };
function fixture(t, timeoutMs = 30) {
  const ipcMain = new EventEmitter(), sent = [];
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { url: 'file:///trusted-wifi.html' }, isDestroyed: () => false,
    send(channel, input) { sent.push({ channel, ...input }); },
  });
  const transport = createOfflineWifiTransport({ ipcMain, timeoutMs });
  transport.attach(contents, contents.mainFrame.url);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const reply = (request, value, source = event) => ipcMain.emit('wanx:local-wifi:transport-result', source,
    { requestId: request.requestId, ok: true, value });
  t.after(() => transport.dispose());
  return { transport, sent, contents, event, reply, ipcMain };
}

test('offline GATT relay accepts replies only from its exact main frame and window', async t => {
  const h = fixture(t), pending = h.transport.connect(selected, new AbortController().signal);
  const request = h.sent[0];
  h.reply(request, 'wrong', { sender: h.contents, senderFrame: { url: h.contents.mainFrame.url } });
  h.reply(request, 'connection-1');
  const connection = await pending;
  const reading = connection.readDeviceInfo(new AbortController().signal);
  h.reply(h.sent.at(-1), [1, 2, 3]);
  assert.deepEqual(await reading, Uint8Array.of(1, 2, 3));
  await assert.rejects(connection.request(new Uint8Array(2049), {}, new AbortController().signal), /PROTOCOL_CHANGED/);
});

test('lock invalidation rejects an in-flight connect and closes a delayed connection', async t => {
  const h = fixture(t), pending = h.transport.connect(selected, new AbortController().signal);
  const request = h.sent[0];
  h.transport.invalidate();
  await assert.rejects(pending, /CONTEXT_CHANGED/);
  h.reply(request, 'connection-late');
  assert.ok(h.sent.some(item => item.operation === 'close' && item.args[0] === 'connection-late'));
  await assert.rejects(h.transport.connect(selected, AbortSignal.abort()), /Abort/);
});

test('disconnect fences all old reads after a new window attaches', async t => {
  const h = fixture(t), pending = h.transport.connect(selected, new AbortController().signal);
  h.reply(h.sent.at(-1), 'connection-1');
  const connection = await pending;
  const reading = connection.readDeviceInfo(new AbortController().signal);
  h.transport.detach(h.contents);
  await assert.rejects(reading, /CONTEXT_CHANGED/);
  await assert.rejects(connection.readDeviceInfo(new AbortController().signal), /CONTEXT_CHANGED/);
  assert.equal(h.sent.at(-1).operation, 'closeAll');
});

test('timeout cancels the physical connect and delayed result cannot be reused', async t => {
  const h = fixture(t, 5), pending = h.transport.connect(selected, new AbortController().signal);
  const request = h.sent[0];
  await assert.rejects(pending, /CONNECT_TIMEOUT/);
  assert.ok(h.sent.some(item => item.operation === 'cancelConnect' && item.args[0] === request.requestId));
  h.reply(request, 'late');
  assert.ok(h.sent.some(item => item.operation === 'close' && item.args[0] === 'late'));
});
