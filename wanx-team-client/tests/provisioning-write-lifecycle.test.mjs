import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createElectronGattTransportFactory, DEVICE_INFO_UUID, COMMAND_UUID, fragmentLogicalFrame } from '@nexusaos/local-provisioning-electron-ble';

const flush = () => new Promise(resolve => setImmediate(resolve));
const candidate = { candidateId: 'write-test', transportHandle: 'write-test', selectionLeaseId: 'write-test' };
const frame = new TextEncoder().encode(JSON.stringify({ request_id: 'request-one', message_type: 'hello', payload: {} }) + '\n');
const match = { requestId: 'request-one', responseMessageType: 'hello.result' };
async function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const device = new EventEmitter(), status = new EventEmitter();
  for (const emitter of [device, status]) {
    emitter.addEventListener = emitter.on.bind(emitter);
    emitter.removeEventListener = emitter.off.bind(emitter);
  }
  let writes = 0, disconnects = 0, release, rejectWrite;
  status.startNotifications = async () => { if (options.notificationError) throw options.notificationError; return status; };
  status.stopNotifications = async () => status;
  const command = { writeValueWithResponse(value) {
    writes++;
    if (options.sameTickDisconnect && writes === 1) return new Promise(resolve => {
      release = () => {
        resolve();
        queueMicrotask(() => device.emit('gattserverdisconnected'));
      };
    });
    return (async () => {
    if (writes === 1) await new Promise((resolve, reject) => { release = resolve; rejectWrite = reject; });
    if (options.respond && (new Uint8Array(value)[1] & 2)) {
      const response = new TextEncoder().encode(JSON.stringify({ request_id: match.requestId,
        message_type: match.responseMessageType, payload: {} }) + '\n');
      for (const fragment of fragmentLogicalFrame(response, 1)) {
        status.value = new DataView(fragment.buffer);
        status.emit('characteristicvaluechanged', { target: status });
      }
    }
    })();
  } };
  const info = { readValue: async () => new DataView(Uint8Array.from([123, 125]).buffer) };
  device.gatt = {
    connect: async () => { if (options.connectError) throw options.connectError; return device.gatt; },
    getPrimaryService: async () => ({ getCharacteristic: async uuid => uuid === DEVICE_INFO_UUID ? info : uuid === COMMAND_UUID ? command : status }),
    disconnect() { disconnects++; device.emit('gattserverdisconnected'); },
  };
  const factory = createElectronGattTransportFactory({ consumeSelectionLease: async () => device,
    clock: { monotonicMs: () => performance.now() }, requestTimeoutMs: 30 });
  const transport = await factory.connect(candidate, new AbortController().signal);
  t.after(async () => { release?.(); await transport.close(); await flush(); });
  return { transport, device, get writes() { return writes; }, get disconnects() { return disconnects; },
    release: () => release(), rejectWrite: () => rejectWrite(new DOMException('native failure', 'NetworkError')) };
}

test('request deadline settles a blocked native write and never sends its remaining fragments', async t => {
  const h = await fixture(t);
  let settled = false;
  const outcome = h.transport.request(frame, match, new AbortController().signal)
    .then(() => null, error => error).finally(() => { settled = true; });
  await flush();
  assert.equal(h.writes, 1);
  t.mock.timers.tick(30);
  await flush();
  assert.equal(settled, true, 'native write must not keep the timed-out request pending');
  assert.equal((await outcome).code, 'GATT_FRAGMENT_INCOMPLETE');
  assert.equal(h.disconnects, 1);
  h.release(); await flush();
  assert.equal(h.writes, 1, 'a late write cannot resume transmission after timeout');
  await assert.rejects(h.transport.request(frame, match, new AbortController().signal), { code: 'LOCAL_TRANSPORT_DISCONNECTED' });
});

for (const reason of ['disconnect', 'abort']) {
  for (const late of ['resolve', 'reject']) {
    test(`${reason} settles a blocked write; its late ${late} cannot resume or reject unhandled`, async t => {
      const h = await fixture(t), controller = new AbortController();
      let settled = false;
      const outcome = h.transport.request(frame, match, controller.signal)
        .then(() => null, error => error).finally(() => { settled = true; });
      await flush();
      if (reason === 'abort') controller.abort();
      else h.device.emit('gattserverdisconnected');
      await flush();
      assert.equal(settled, true, 'termination must not await the physical write callback');
      const error = await outcome;
      assert.equal(reason === 'abort' ? error.name : error.code,
        reason === 'abort' ? 'AbortError' : 'LOCAL_TRANSPORT_DISCONNECTED');
      assert.equal(h.disconnects, 1);
      if (late === 'resolve') h.release(); else h.rejectWrite();
      await flush();
      t.mock.timers.tick(100); await flush();
      assert.equal(h.writes, 1);
      assert.equal(h.disconnects, 1, 'deadline and late rejection cannot trigger more cleanup');
      await assert.rejects(h.transport.request(frame, match, new AbortController().signal), { code: 'LOCAL_TRANSPORT_DISCONNECTED' });
    });
  }
}

test('GATT connection failures retain only an allowlisted native name and stage', async t => {
  const error = await fixture(t, { connectError: new DOMException('private diagnostic token', 'NetworkError') }).then(() => null, error => error);
  assert.equal(error.code, 'LOCAL_TRANSPORT_DISCONNECTED');
  assert.deepEqual(error.diagnostic, { stage: 'connect', errorName: 'NetworkError' });
  assert.equal(JSON.stringify(error).includes('private diagnostic token'), false);
});

test('a successful fragmented request still completes without replay or premature close', async t => {
  const h = await fixture(t, { respond: true });
  const outcome = h.transport.request(frame, match, new AbortController().signal);
  await flush(); h.release();
  const response = JSON.parse(new TextDecoder().decode(await outcome));
  assert.equal(response.message_type, 'hello.result');
  assert.equal(h.writes, Math.ceil(frame.length / 12));
  t.mock.timers.tick(100); await flush();
  assert.equal(h.disconnects, 0, 'the completed response retired its deadline');
});

test('unknown native names cannot enter the diagnostic payload', async t => {
  const error = await fixture(t, { connectError: { name: 'private-token', message: 'private-message' } }).then(() => null, error => error);
  assert.deepEqual(error.diagnostic, { stage: 'connect', errorName: 'UnknownError' });
  assert.equal(JSON.stringify(error).includes('private'), false);
});

test('notification failures expose their safe stage and name', async t => {
  const error = await fixture(t, { notificationError: new DOMException('private notification', 'NetworkError') }).then(() => null, error => error);
  assert.equal(error.code, 'LOCAL_TRANSPORT_DISCONNECTED');
  assert.deepEqual(error.diagnostic, { stage: 'notifications', errorName: 'NetworkError' });
  assert.equal(JSON.stringify(error).includes('private notification'), false);
});

test('disconnect between write completion and its continuation prevents the next fragment', async t => {
  const h = await fixture(t, { sameTickDisconnect: true });
  const outcome = h.transport.request(frame, match, new AbortController().signal).then(() => null, error => error);
  await flush();
  assert.equal(h.writes, 1);
  h.release();
  const error = await outcome;
  assert.equal(error.code, 'LOCAL_TRANSPORT_DISCONNECTED');
  assert.equal(h.writes, 1, 'a completed write cannot authorize another fragment after disconnect');
  assert.equal(h.disconnects, 1);
});
