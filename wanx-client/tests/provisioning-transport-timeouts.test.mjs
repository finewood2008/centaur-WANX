import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { COMMAND_UUID, DEVICE_INFO_UUID, fragmentLogicalFrame } from '@nexusaos/local-provisioning-electron-ble';
import { createProvisioningHost } from '../shell/provisioning-host.cjs';

const bundle = await readFile(new URL('../local-ui/renderer/device-setup.bundle.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const requestId = '12345678-1234-4234-8234-123456789abc';
const match = { requestId, responseMessageType: 'pairing.token.result' };
const encode = value => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
function tokenFrame(size = 1332) {
  const value = { request_id: requestId, message_type: 'pairing.token', token: '' };
  value.token = 'x'.repeat(size - encode(value).length);
  return encode(value);
}

// Exercise the shipped bundle and its actual SDK, including fragmentation,
// one-use selection, response routing, cancellation and the Main IPC deadline.
// Only physical Bluetooth and time are simulated; no real scan is performed.
async function harness(t, { writeMs = 100, respond = true, silentOperation, slowFirstConnect = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ipcMain = new EventEmitter(), contents = new EventEmitter();
  ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  contents.mainFrame = { url: 'file:///timeout-test.html' };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const writes = [], completed = [], operations = [];
  let listener, transport, disconnects = 0, notificationsStopped = 0;
  let frame = tokenFrame(), response, rejectWrite, releaseFirstConnect, notifications = 0;
  const device = new EventEmitter(), status = new EventEmitter();
  for (const target of [device, status]) {
    target.addEventListener = target.on.bind(target);
    target.removeEventListener = target.off.bind(target);
  }
  device.id = 'timeout-test-device'; device.name = 'CentaurOS-Setup-123456';
  status.startNotifications = async () => {
    if (slowFirstConnect && ++notifications === 1) await new Promise(resolve => { releaseFirstConnect = resolve; });
    return status;
  };
  status.stopNotifications = async () => { notificationsStopped++; return status; };
  const command = { async writeValueWithResponse(value) {
    const fragment = new Uint8Array(value);
    writes.push(fragment);
    if (writeMs) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { rejectWrite = undefined; resolve(); }, writeMs);
      rejectWrite = () => { clearTimeout(timer); reject(new DOMException('Disconnected', 'NetworkError')); };
    });
    completed.push(fragment);
    if (respond && (fragment[1] & 2)) {
      const reply = encode({ request_id: requestId, message_type: match.responseMessageType, ok: true });
      for (const part of fragmentLogicalFrame(reply, 7)) {
        status.value = new DataView(part.buffer);
        status.emit('characteristicvaluechanged', { target: status });
      }
    }
  } };
  device.gatt = {
    async connect() { return this; },
    async getPrimaryService() { return { async getCharacteristic(uuid) {
      if (uuid === COMMAND_UUID) return command;
      if (uuid === DEVICE_INFO_UUID) return { readValue: async () => new DataView(new Uint8Array([123, 125]).buffer) };
      return status;
    } }; },
    disconnect() { disconnects++; rejectWrite?.(); device.emit('gattserverdisconnected'); },
  };
  const window = { wanxSetupTransport: {
    subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    reply(value) { ipcMain.emit('wanx:setup:transport-result', event, value); },
    status(value) { ipcMain.emit('wanx:setup:transport-status', event, value); },
  } };
  vm.runInNewContext(bundle, { window, navigator: { bluetooth: {
    requestDevice: async () => device, getAvailability: async () => true,
  } }, crypto: globalThis.crypto, performance: { now: () => Date.now() },
  setTimeout, clearTimeout, AbortController, DOMException, TextEncoder, TextDecoder,
  Uint8Array, DataView, ArrayBuffer });
  contents.send = (channel, input) => {
    if (channel !== 'wanx:setup:transport') return;
    operations.push(input.operation);
    if (input.operation !== silentOperation) listener?.(input);
  };
  const host = await createProvisioningHost({ webContents: contents, ipcMain, documentUrl: contents.mainFrame.url,
    consumer: { current: async () => ({ accountId: 'test-account', clientId: 'test-client' }), pairingApi: async () => ({}) },
    cryptoFactory: () => ({}), resumeStore: {}, trustedRootCertificatesPem: [], trustedRootSpkiPins: [],
    clock: { monotonicMs: () => Date.now(), nowUtc: () => new Date().toISOString() },
    coordinatorFactory: ({ transportFactory }) => ({
      subscribe: () => () => {},
      getSnapshot: () => ({ flowId: 'timeout-test', state: 'previewReady', preview: {
        cloud_enrollment_status: 'ready', pairing_mode_remaining_seconds: 600,
      } }),
      async begin(input, signal) { transport = await transportFactory.connect(input.selected, signal); },
      async confirmPhysicalDevice(signal) { response = await transport.request(frame, match, signal); },
      async cancel() { await transport?.close(); },
      async suspend() { await transport?.close(); },
      async dispose() { await transport?.close(); },
    }),
  });
  t.after(async () => { await host.dispose(); await window.wanxDeviceSetupTransport.dispose(); });
  return { host, writes, completed, operations,
    begin: async () => host.begin(await window.wanxDeviceSetupTransport.requestDeviceFromUserGesture()),
    frame(value) { frame = value; },
    read: () => transport.readDeviceInfo(new AbortController().signal),
    releaseFirstConnect: () => releaseFirstConnect(),
    get response() { return response; },
    get disconnects() { return disconnects; },
    get notificationsStopped() { return notificationsStopped; },
  };
}

test('a 111-fragment token survives both old 5s SDK and 10s IPC limits', async t => {
  const h = await harness(t);
  await h.begin();
  let settled = false;
  const request = h.host.confirmPhysical().finally(() => { settled = true; });
  await flush();
  assert.equal(new DataView(h.writes[0].buffer).getUint16(6), 111);
  for (let elapsed = 100; elapsed <= 11000; elapsed += 100) {
    t.mock.timers.tick(100); await flush();
    if (elapsed === 5000 || elapsed === 10000) {
      assert.equal(settled, false, `still transferring at ${elapsed}ms`);
      assert.equal(h.disconnects, 0);
    }
  }
  assert.equal(h.completed.length, 110);
  t.mock.timers.tick(100); await flush();
  await request;
  assert.equal(h.completed.length, 111);
  assert.equal(h.disconnects, 0);
  assert.equal(JSON.parse(new TextDecoder().decode(h.response)).ok, true);
});

test('a fully written token with no response closes at the 30s SDK deadline', async t => {
  const h = await harness(t, { writeMs: 0, respond: false });
  await h.begin();
  let settled = false;
  const outcome = h.host.confirmPhysical().then(() => null, error => error).finally(() => { settled = true; });
  await flush();
  assert.equal(h.completed.length, 111);
  t.mock.timers.tick(29999); await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1); await flush();
  assert.equal((await outcome).code, 'GATT_FRAGMENT_INCOMPLETE');
  assert.equal(h.disconnects, 1);
  assert.equal(h.notificationsStopped, 1);
});

test('user cancellation while awaiting the token reply promptly retires GATT', async t => {
  const h = await harness(t, { writeMs: 0, respond: false });
  await h.begin();
  const outcome = h.host.confirmPhysical().then(() => null, error => error);
  await flush();
  assert.equal(h.completed.length, 111);
  await h.host.cancel();
  await flush();
  assert.equal((await outcome).name, 'AbortError');
  assert.equal(Date.now(), 0, 'cancel did not wait for a request deadline');
  assert.equal(h.disconnects, 1);
  assert.equal(h.notificationsStopped, 1);
  t.mock.timers.tick(35000); await flush();
  assert.equal(h.completed.length, 111, 'cancelled token never transmits again');
});

test('a missing renderer request reply has a bounded 35s IPC fallback', async t => {
  const h = await harness(t, { silentOperation: 'request' });
  await h.begin();
  let settled = false;
  const outcome = h.host.confirmPhysical().then(() => null, error => error).finally(() => { settled = true; });
  await flush();
  t.mock.timers.tick(34999); await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1); await flush();
  assert.equal((await outcome).code, 'GATT_FRAGMENT_INCOMPLETE');
});

test('connect retains its shorter 10s IPC deadline', async t => {
  const h = await harness(t, { silentOperation: 'connect' });
  let settled = false;
  const outcome = h.begin().then(() => null, error => error).finally(() => { settled = true; });
  await flush();
  t.mock.timers.tick(9999); await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1); await flush();
  assert.equal((await outcome).code, 'LOCAL_CONNECT_TIMEOUT');
});


test('a timed-out connect cannot disconnect a new connection when its notification subscription resolves late', async t => {
  const h = await harness(t, { slowFirstConnect: true });
  const first = h.begin().then(() => null, error => error);
  await flush();
  t.mock.timers.tick(10000); await flush();
  assert.equal((await first).code, 'LOCAL_CONNECT_TIMEOUT');
  assert.equal(h.disconnects, 1, 'timeout immediately retires the physical attempt');
  await h.begin();
  const before = h.disconnects;
  h.releaseFirstConnect(); await flush();
  assert.equal(h.disconnects, before, 'retired connect must not disconnect the new connection');
  assert.deepEqual(Array.from(await h.read()), [123, 125]);
});
