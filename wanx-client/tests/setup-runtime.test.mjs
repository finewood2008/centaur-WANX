import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSetupRuntime } from '../shell/setup.mjs';
import { createProvisioningHost } from '../shell/provisioning-host.cjs';
const candidate = { candidateId: 'candidate', transport: 'ble-gatt', transportHandle: 'handle', selectionLeaseId: 'lease', advertisedName: 'CentaurOS-Setup', rssi: -40, firstSeenMonotonicMs: 0, lastSeenMonotonicMs: 1 };
async function harness({ preview = { cloud_enrollment_status: 'ready', pairing_mode_remaining_seconds: 300 }, scanWifi = async () => [] } = {}) {
  const ipcMain = new EventEmitter(); const handlers = new Map();
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  ipcMain.removeHandler = (name) => handlers.delete(name);
  const webContents = new EventEmitter(); webContents.mainFrame = { url: 'file:///test/index.html' };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const sent = [];
  webContents.send = (name, input) => {
    sent.push([name, input]);
    if (name === 'wanx:setup:transport') queueMicrotask(() => ipcMain.emit('wanx:setup:transport-result', event, { requestId: input.requestId, ok: true, value: null }));
  };
  let identity = { accountId: 'a', clientId: 'c' }, refreshes = 0, pickerDisposed = 0, handshakes = 0;
  const accountListeners = new Set();
  const account = { getIdentity: () => identity, snapshot: () => ({ phase: identity ? 'authenticated' : 'signed_out' }),
    subscribe: (fn) => { accountListeners.add(fn); return () => accountListeners.delete(fn); } };
  let pickerInput;
  const advertisementNames = { subscribe() { return () => {}; } };
  const runtime = await createSetupRuntime({ control: { webContents, isDestroyed: () => false }, controlURL: webContents.mainFrame.url,
    ipcMain, account, client: { refreshDevices: async () => { refreshes++; } },
    consumerBaseUrl: 'https://consumer.example', userData: 'unused',
    advertisementNames,
    makeStore: () => ({ load: async () => [] }),
    installPicker: (input) => { pickerInput = input; return () => { pickerDisposed++; }; },
    makeHost: (options) => createProvisioningHost({ ...options, cryptoFactory: () => ({}), coordinatorFactory: () => {
      let state = { flowId: 'flow-1', state: 'idle', preview }, notify;
      const set = (next) => { state = { ...state, state: next }; notify?.(); };
      return { getSnapshot: () => state, subscribe: (fn) => { notify = fn; return () => {}; },
        begin: async () => set('previewReady'), confirmPhysicalDevice: async () => { handshakes++; set('awaitingWifi'); },
        scanWifi,
        provideWifi: async (wifi) => { assert.equal(wifi.ssid, 'office'); set('awaitingOwnershipConfirmation'); },
        confirmOwnership: async () => set('completed'), cancel: async () => set('cancelled'),
        suspend: async () => {}, dispose: async () => {},
      };
    } }),
  });
  return { runtime, handlers, event, sent, pickerInput, advertisementNames, handshakes: () => handshakes, refreshes: () => refreshes, pickerDisposed: () => pickerDisposed,
    logout() { identity = null; for (const fn of accountListeners) fn(); },
    invoke: (name, input) => handlers.get(`wanx:setup:${name}`)(event, input),
  };
}
test('trusted setup IPC completes identity, Wi-Fi and ownership then refreshes only the directory', async () => {
  const h = await harness();
  assert.equal(h.pickerInput.documentUrl, h.event.senderFrame.url);
  assert.equal(h.pickerInput.advertisementNames, h.advertisementNames);
  assert.ok(h.sent.some(([name]) => name === 'wanx:setup:ready'));
  assert.equal((await h.invoke('begin', candidate)).value.state, 'previewReady');
  assert.equal((await h.invoke('confirmPhysical')).value.state, 'awaitingWifi');
  assert.equal((await h.invoke('wifi', { ssid: 'office', hidden: false, security: 'open' })).value.state, 'awaitingOwnershipConfirmation');
  assert.equal((await h.invoke('confirmOwnership')).value.state, 'completed');
  assert.equal(h.refreshes(), 1);
  await h.runtime.dispose();
  assert.equal(h.handlers.size, 0); assert.equal(h.pickerDisposed(), 1);
});
test('Wi-Fi scan IPC is identity-gated, deduplicated and revoked on logout', async () => {
  let calls = 0, resolveScan, signal;
  const h = await harness({ scanWifi: (abort) => { calls++; signal = abort; return new Promise(resolve => { resolveScan = resolve; }); } });
  try {
    await h.invoke('begin', candidate);
    assert.equal((await h.invoke('scanWifi')).code, 'CLAIM_INVALID_STATE');
    const foreign = await h.handlers.get('wanx:setup:scanWifi')({ ...h.event, senderFrame: { url: h.event.senderFrame.url } });
    assert.equal(foreign.code, 'IPC_ACCESS_DENIED');
    await h.invoke('confirmPhysical');
    const first = h.invoke('scanWifi'), second = h.invoke('scanWifi');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    h.logout();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    resolveScan([{ ssid: 'office', signal: 90, security: 'open' }]);
    assert.equal((await first).ok, false);
    assert.equal((await second).ok, false);
  } finally { await h.runtime.dispose(); }
});
test('manual Wi-Fi submission cancels scanning before configuring the selected network', async () => {
  const h = await harness({ scanWifi: (signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
  }) });
  try {
    await h.invoke('begin', candidate); await h.invoke('confirmPhysical');
    const scanning = h.invoke('scanWifi');
    await new Promise(resolve => setImmediate(resolve));
    const result = await h.invoke('wifi', { ssid: 'office', hidden: false, security: 'open' });
    assert.equal(result.value.state, 'awaitingOwnershipConfirmation');
    assert.equal((await scanning).ok, false);
  } finally { await h.runtime.dispose(); }
});
test('setup rejects a foreign renderer and discards account-bound context on logout', async () => {
  const h = await harness();
  const reply = await h.handlers.get('wanx:setup:begin')({ ...h.event, senderFrame: { url: h.event.senderFrame.url } }, candidate);
  assert.equal(reply.code, 'IPC_ACCESS_DENIED');
  await h.invoke('begin', candidate); h.logout();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await h.invoke('state')).value.state, 'idle');
  assert.equal((await h.invoke('confirmOwnership')).ok, false);
  assert.equal(h.refreshes(), 0); await h.runtime.dispose();
});

for (const [preview, code] of [
  [{ cloud_enrollment_status: 'not_enrolled', pairing_mode_remaining_seconds: 0 }, 'DEVICE_NOT_ENROLLED'],
  [{ cloud_enrollment_status: 'ready', pairing_mode_remaining_seconds: 0 }, 'PAIRING_MODE_CLOSED'],
]) {
  test(`read-only discovery previews stop before any pairing handshake: ${code}`, async () => {
    const h = await harness({ preview });
    try {
      assert.equal((await h.invoke('begin', candidate)).value.state, 'previewReady');
      const result = await h.invoke('confirmPhysical');
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
      assert.equal(h.handshakes(), 0);
      assert.equal(h.refreshes(), 0);
      assert.equal((await h.invoke('state')).value.state, 'previewReady');
    } finally { await h.runtime.dispose(); }
  });
}
