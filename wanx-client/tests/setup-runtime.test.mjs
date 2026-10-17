import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSetupRuntime } from '../shell/setup.mjs';
import { createProvisioningHost } from '../shell/provisioning-host.cjs';
const candidate = { candidateId: 'candidate', transport: 'ble-gatt', transportHandle: 'handle', selectionLeaseId: 'lease', advertisedName: 'CentaurOS-Setup', rssi: -40, firstSeenMonotonicMs: 0, lastSeenMonotonicMs: 1 };
async function harness({ preview = { cloud_enrollment_status: 'ready', pairing_mode_remaining_seconds: 300 }, scanWifi = async () => [], ownerWifi = false,
  advertisementNames = { subscribe() { return () => {}; } }, connectTransport = false,
  ownershipState = 'unclaimed', claimStatusUnavailable = false, expireHandshake = 0, expireOwnership = false,
  changedIdentityOnReconnect = false, claimStatusWait, taskClock } = {}) {
  preview = { device_id: 'box-new', identity_public_key_sha256: 'a'.repeat(64), ...preview };
  const ipcMain = new EventEmitter(); const handlers = new Map();
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  ipcMain.removeHandler = (name) => handlers.delete(name);
  const webContents = new EventEmitter(); webContents.mainFrame = { url: 'file:///test/index.html' };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const sent = [];
  webContents.send = (name, input) => {
    sent.push([name, input]);
    if (name === 'wanx:setup:transport') queueMicrotask(() => ipcMain.emit('wanx:setup:transport-result', event, { requestId: input.requestId, ok: true, value: input.operation === 'connect' ? 'test-connection' : null }));
  };
  let identity = { accountId: 'a', clientId: 'c' }, refreshes = 0, pickerDisposed = 0, handshakes = 0;
  const accountListeners = new Set();
  const account = { request: async () => {
    await claimStatusWait;
    if (claimStatusUnavailable) throw Object.assign(new Error('offline'), { code: 'ACCOUNT_SERVICE_UNAVAILABLE' });
    const actions = { unclaimed: 'claim', owned_self: 'connect', owned_other: 'transfer', legacy_bound: 'contact_operator',
      history_review: 'contact_operator', reset_pending: 'wait_for_reset' };
    return { data: { deviceId: 'box-new', ownershipState, canClaim: ownershipState === 'unclaimed', nextAction: actions[ownershipState], reasonCode: null },
      requestId: 'req-1', serverTime: '2026-10-17T00:00:00Z', receivedMonotonicMs: 1 };
  }, getIdentity: () => identity, snapshot: () => ({ phase: identity ? 'authenticated' : 'signed_out' }),
    subscribe: (fn) => { accountListeners.add(fn); return () => accountListeners.delete(fn); } };
  let pickerInput, coordinators = 0, ownershipSubmissions = 0;
  const runtime = await createSetupRuntime({ control: { webContents, isDestroyed: () => false }, controlURL: webContents.mainFrame.url,
    ipcMain, account, client: { refreshDevices: async () => { refreshes++; } },
    consumerBaseUrl: 'https://consumer.example', userData: 'unused',
    advertisementNames,
    makeStore: () => ({ load: async () => [] }),
    installPicker: (input) => { pickerInput = input; return () => { pickerDisposed++; }; },
    makeHost: (options) => {
      const factory = ({ transportFactory, consumerApi }) => {
      coordinators++;
      const currentPreview = changedIdentityOnReconnect && coordinators > 1 ? { ...preview, identity_public_key_sha256: 'b'.repeat(64) } : preview;
      let state = { flowId: 'flow-1', state: 'idle', preview: currentPreview, ...(ownerWifi ? { mode: 'wifi' } : {}) }, notify;
      const set = (next) => { state = { ...state, state: next }; notify?.(); };
      return { getSnapshot: () => state, subscribe: (fn) => { notify = fn; return () => {}; },
        begin: async (input, signal) => {
          if (connectTransport) await transportFactory.connect(input.selected, signal);
          set('previewReady');
        }, confirmPhysicalDevice: async () => {
          handshakes++;
          if (handshakes <= expireHandshake) throw Object.assign(new Error('expired'), { code: 'PAIRING_EXPIRED' });
          if (ownerWifi) state.pairingSessionId = '11111111-1111-4111-8111-111111111111';
          state.pairingExpiresInMs = 300000;
          set('awaitingWifi');
        },
        scanWifi,
        provideWifi: async (wifi) => { assert.equal(wifi.ssid, 'office'); set(ownerWifi ? 'completed' : 'awaitingOwnershipConfirmation'); },
        confirmOwnership: async () => { ownershipSubmissions++; if (expireOwnership) { await consumerApi.provePairing().catch(() => {}); throw Object.assign(new Error('expired'), { code: 'PAIRING_EXPIRED' }); } set('completed'); }, cancel: async () => set('cancelled'),
        suspend: async () => {}, dispose: async () => {},
      };
      };
      return createProvisioningHost({ ...options, ...(taskClock ? { clock: taskClock } : {}), cryptoFactory: () => ({}), coordinatorFactory: factory,
        ...(ownerWifi ? { ownerWifiCoordinatorFactory: factory } : {}) });
    },
  });
  return { ownershipSubmissions: () => ownershipSubmissions, runtime, handlers, event, sent, pickerInput, advertisementNames, handshakes: () => handshakes, refreshes: () => refreshes, pickerDisposed: () => pickerDisposed,
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

test('setup waits for native discovery handoff before dispatching the GATT connect RPC', async () => {
  let release, waits = 0;
  const advertisementNames = { subscribe() { return () => {}; }, stopAndWait() {
    waits++; return new Promise(resolve => { release = resolve; });
  } };
  const h = await harness({ advertisementNames, connectTransport: true });
  try {
    const pending = h.invoke('begin', candidate);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(waits, 1);
    assert.equal(h.sent.some(([name, input]) => name === 'wanx:setup:transport' && input.operation === 'connect'), false);
    release();
    assert.equal((await pending).value.state, 'previewReady');
    assert.equal(h.sent.filter(([name, input]) => name === 'wanx:setup:transport' && input.operation === 'connect').length, 1);
  } finally { await h.runtime.dispose(); }
});

test('failed native handoff never dispatches a GATT connect', async () => {
  const h = await harness({ connectTransport: true, advertisementNames: {
    subscribe() { return () => {}; },
    async stopAndWait() { throw Object.assign(new Error('LOCAL_CONNECT_TIMEOUT'), { code: 'LOCAL_CONNECT_TIMEOUT' }); },
  } });
  try {
    const result = await h.invoke('begin', candidate);
    assert.equal(result.code, 'LOCAL_CONNECT_TIMEOUT');
    assert.equal(h.sent.some(([name, input]) => name === 'wanx:setup:transport' && input.operation === 'connect'), false);
  } finally { await h.runtime.dispose(); }
});
test('owner Wi-Fi mode crosses a closed claim window and cannot invoke ownership operations', async () => {
  const h = await harness({ ownerWifi: true, preview: { cloud_enrollment_status: 'ready', pairing_mode_remaining_seconds: 0 } });
  try {
    assert.equal((await h.invoke('begin', { ...candidate, mode: 'wifi' })).value.mode, 'wifi');
    assert.equal((await h.invoke('confirmPhysical')).value.state, 'awaitingWifi');
    assert.equal((await h.invoke('confirmOwnership')).code, 'CLAIM_INVALID_STATE');
    assert.equal((await h.invoke('refresh')).code, 'CLAIM_INVALID_STATE');
    assert.equal((await h.invoke('redeemClaimCode', 'ABCD234567')).code, 'CLAIM_INVALID_STATE');
    assert.equal((await h.invoke('wifi', { ssid: 'office', hidden: false, security: 'open' })).value.state, 'completed');
    assert.equal(h.handshakes(), 1);
  } finally { await h.runtime.dispose(); }
});
test('renderer crash discards the owner Wi-Fi session instead of restoring a claim task', async () => {
  const h = await harness({ ownerWifi: true });
  try {
    await h.invoke('begin', { ...candidate, mode: 'wifi' });
    await h.invoke('confirmPhysical');
    h.event.sender.emit('render-process-gone');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await h.invoke('state')).value.state, 'idle');
    assert.equal(h.refreshes(), 0);
  } finally { await h.runtime.dispose(); }
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

for (const [ownershipState, code] of [
  ['owned_self', 'DEVICE_ALREADY_OWNED'], ['owned_other', 'DEVICE_OWNED_BY_OTHER'],
  ['legacy_bound', 'LEGACY_BINDING_REVIEW_REQUIRED'], ['history_review', 'CLAIM_HISTORY_REVIEW_REQUIRED'],
  ['reset_pending', 'DEVICE_RESET_PENDING'],
]) test(`authoritative ${ownershipState} blocks a claim before hello despite BLE availability`, async () => {
  const h = await harness({ ownershipState });
  try {
    const result = await h.invoke('begin', candidate);
    assert.equal(result.value.ownershipState, ownershipState);
    assert.equal(result.value.canClaim, false);
    assert.equal((await h.invoke('confirmPhysical')).code, code);
    assert.equal(h.handshakes(), 0);
  } finally { await h.runtime.dispose(); }
});
test('unavailable ownership lookup fails closed before any claim handshake', async () => {
  const h = await harness({ claimStatusUnavailable: true });
  try {
    assert.equal((await h.invoke('begin', candidate)).value.claimStatusError, 'CLAIM_STATUS_UNAVAILABLE');
    assert.equal((await h.invoke('confirmPhysical')).code, 'CLAIM_STATUS_UNAVAILABLE');
    assert.equal(h.handshakes(), 0);
  } finally { await h.runtime.dispose(); }
});
test('expired preparation reconnects the selected identity and starts one fresh session', async () => {
  const h = await harness({ expireHandshake: 1, connectTransport: true });
  try {
    await h.invoke('begin', candidate);
    const result = await h.invoke('confirmPhysical');
    assert.equal(result.value.state, 'awaitingWifi');
    assert.equal(result.value.sessionRenewed, true);
    assert.equal(h.handshakes(), 2);
    assert.equal(h.ownershipSubmissions(), 0);
  } finally { await h.runtime.dispose(); }
});
test('persistent expiry is bounded and never starts ownership submission', async () => {
  const h = await harness({ expireHandshake: 2 });
  try {
    await h.invoke('begin', candidate);
    assert.equal((await h.invoke('confirmPhysical')).code, 'PAIRING_EXPIRED');
    assert.equal(h.handshakes(), 2);
    assert.equal(h.ownershipSubmissions(), 0);
  } finally { await h.runtime.dispose(); }
});
test('renewal revalidates the exact device identity before preparing another session', async () => {
  const h = await harness({ expireHandshake: 1, changedIdentityOnReconnect: true });
  try {
    await h.invoke('begin', candidate);
    assert.equal((await h.invoke('confirmPhysical')).code, 'DEVICE_IDENTITY_MISMATCH');
    assert.equal(h.handshakes(), 1);
    assert.equal((await h.invoke('state')).value.state, 'idle');
  } finally { await h.runtime.dispose(); }
});
test('an expired read-only Wi-Fi scan renews preparation without replaying a Wi-Fi write', async () => {
  let scans = 0;
  const h = await harness({ scanWifi: async () => {
    if (++scans === 1) throw Object.assign(new Error('expired'), { code: 'PAIRING_EXPIRED' });
    return [{ ssid: 'office', signal: 90, security: 'open' }];
  } });
  try {
    await h.invoke('begin', candidate); await h.invoke('confirmPhysical');
    assert.deepEqual((await h.invoke('scanWifi')).value, [{ ssid: 'office', signal: 90, security: 'open' }]);
    assert.equal(h.handshakes(), 2);
    assert.equal(h.ownershipSubmissions(), 0);
  } finally { await h.runtime.dispose(); }
});
test('ownership submission is never automatically repeated when its response expires', async () => {
  const h = await harness({ expireOwnership: true });
  try {
    await h.invoke('begin', candidate); await h.invoke('confirmPhysical');
    await h.invoke('wifi', { ssid: 'office', hidden: false, security: 'open' });
    assert.equal((await h.invoke('confirmOwnership')).code, 'PAIRING_EXPIRED');
    assert.equal(h.ownershipSubmissions(), 1);
    assert.equal(h.handshakes(), 1);
  } finally { await h.runtime.dispose(); }
});

test('preview publication cannot start hello while the ownership lookup is pending', async () => {
  let release;
  const h = await harness({ claimStatusWait: new Promise(resolve => { release = resolve; }) });
  try {
    const beginning = h.invoke('begin', candidate);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await h.invoke('state')).value.state, 'previewReady');
    assert.equal((await h.invoke('confirmPhysical')).code, 'CLAIM_STATUS_CHECKING');
    assert.equal(h.handshakes(), 0);
    release();
    assert.equal((await beginning).value.canClaim, true);
  } finally { release(); await h.runtime.dispose(); }
});

for (const step of ['wifi', 'confirmOwnership']) test(`idle expiry before ${step} renews the session and requires fresh input without writes`, async () => {
  let now = 0;
  const h = await harness({ taskClock: { monotonicMs: () => now, nowUtc: () => '2026-10-17T00:00:00Z' } });
  try {
    await h.invoke('begin', candidate); await h.invoke('confirmPhysical');
    if (step === 'confirmOwnership') await h.invoke('wifi', { ssid: 'office', hidden: false, security: 'open' });
    now = 300001;
    const result = await h.invoke(step, step === 'wifi' ? { ssid: 'office', hidden: false, security: 'open' } : undefined);
    assert.equal(result.value.state, 'awaitingWifi');
    assert.equal(result.value.sessionRenewed, true);
    assert.equal(h.handshakes(), 2);
    assert.equal(h.ownershipSubmissions(), 0);
  } finally { await h.runtime.dispose(); }
});
