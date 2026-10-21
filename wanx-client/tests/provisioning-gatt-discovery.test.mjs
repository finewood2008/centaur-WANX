import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { PROVISIONING_SERVICE_UUID, DEVICE_INFO_UUID, COMMAND_UUID, STATUS_UUID } from '@nexusaos/local-provisioning-electron-ble';

const bundle = await readFile(new URL('../local-ui/renderer/device-setup.bundle.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

// Run the shipped renderer and SDK. Simulate only the physical Bluetooth API;
// its single-flight discovery behavior reproduces concurrent GATT failures.
async function harness(t, { failAt, errorName = 'NetworkError', onDiscover } = {}) {
  let requestListener, reply, disconnects = 0, inFlight = false;
  const calls = [], device = new EventEmitter(), status = new EventEmitter();
  for (const target of [device, status]) {
    target.addEventListener = target.on.bind(target);
    target.removeEventListener = target.off.bind(target);
  }
  const fail = phase => {
    if (failAt === phase) throw new DOMException('private OS diagnostic', errorName);
  };
  status.startNotifications = async () => status;
  status.stopNotifications = async () => status;
  const service = { async getCharacteristic(uuid) {
    if (inFlight) throw new DOMException('GATT operation already in progress', 'NetworkError');
    inFlight = true;
    calls.push(uuid);
    try {
      await flush();
      fail(uuid);
      await onDiscover?.(uuid);
      return uuid === STATUS_UUID ? status : {};
    } finally { inFlight = false; }
  } };
  device.name = 'CentaurOS-Setup-3D64DC';
  device.gatt = {
    async connect() { fail('connect'); return this; },
    async getPrimaryService(uuid) {
      assert.equal(uuid, PROVISIONING_SERVICE_UUID);
      fail('service'); return service;
    },
    disconnect() { disconnects++; },
  };
  const window = { wanxSetupTransport: {
    subscribe(callback) { requestListener = callback; return () => {}; },
    reply(value) { reply(value); }, status() {},
  } };
  vm.runInNewContext(bundle, { window, navigator: { bluetooth: { async requestDevice(options) {
    assert.equal(options.filters[0].services[0], PROVISIONING_SERVICE_UUID);
    assert.equal(options.optionalServices[0], PROVISIONING_SERVICE_UUID);
    return device;
  } } }, crypto: globalThis.crypto, performance, setTimeout, clearTimeout,
  AbortController, DOMException, TextEncoder, TextDecoder, Uint8Array, DataView, ArrayBuffer });
  t.after(() => window.wanxDeviceSetupTransport.dispose());
  return {
    calls,
    get disconnects() { return disconnects; },
    dispose: () => window.wanxDeviceSetupTransport.dispose(),
    async connect() {
      const selected = await window.wanxDeviceSetupTransport.requestDeviceFromUserGesture();
      return new Promise(resolve => {
        reply = resolve;
        requestListener({ requestId: 'gatt-test', operation: 'connect', args: [selected] });
      });
    },
  };
}

test('the shipped renderer discovers all three characteristics without overlapping GATT operations', async t => {
  const h = await harness(t);
  assert.equal((await h.connect()).ok, true);
  assert.deepEqual(h.calls, [DEVICE_INFO_UUID, COMMAND_UUID, STATUS_UUID]);
  assert.equal(h.disconnects, 0);
});

for (const [phase, name, code] of [
  ['connect', 'NetworkError', 'LOCAL_TRANSPORT_DISCONNECTED'],
  ['connect', 'NotFoundError', 'LOCAL_TRANSPORT_DISCONNECTED'],
  ['service', 'NetworkError', 'LOCAL_TRANSPORT_DISCONNECTED'],
  ['service', 'NotFoundError', 'GATT_SERVICE_NOT_FOUND'],
  [COMMAND_UUID, 'NetworkError', 'LOCAL_TRANSPORT_DISCONNECTED'],
  [COMMAND_UUID, 'NotFoundError', 'GATT_CHARACTERISTIC_MISMATCH'],
]) {
  test(`${phase} ${name} reports ${code} and closes the incomplete connection`, async t => {
    const h = await harness(t, { failAt: phase, errorName: name });
    const result = await h.connect();
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.diagnostic.stage, phase === COMMAND_UUID ? 'characteristic' : phase);
    assert.equal(result.diagnostic.errorName, name);
    assert.equal(h.disconnects, 1);
    assert.equal(JSON.stringify(result).includes('private OS diagnostic'), false);
    if (phase === COMMAND_UUID) assert.deepEqual(h.calls, [DEVICE_INFO_UUID, COMMAND_UUID]);
  });
}

test('cancellation during discovery stops before opening more characteristics', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const h = await harness(t, { onDiscover: async uuid => {
    if (uuid === DEVICE_INFO_UUID) {
      entered(); await new Promise(resolve => { release = resolve; });
    }
  } });
  void h.connect();
  await waiting;
  await h.dispose();
  release();
  await flush();
  assert.deepEqual(h.calls, [DEVICE_INFO_UUID]);
  assert.equal(h.disconnects, 1);
});

test('the vendored GATT patch reproduces from the pinned upstream archive', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../tools/patch-provisioning-gatt.mjs', import.meta.url)), '--check'],
    { stdio: 'pipe' });
});
