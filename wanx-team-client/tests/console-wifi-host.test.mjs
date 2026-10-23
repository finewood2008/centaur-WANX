import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createProvisioningHost } from '../shell/provisioning-host.cjs';

const claimCode = 'ABCD234567';
const clientAttemptId = '11111111-1111-4111-8111-111111111111';
const candidate = { candidateId: 'candidate', transport: 'ble-gatt', transportHandle: 'handle',
  selectionLeaseId: 'lease', advertisedName: 'CentaurOS-Setup', rssi: -40,
  firstSeenMonotonicMs: 0, lastSeenMonotonicMs: 1 };
const fail = code => Object.assign(new Error(code), { code });

async function harness(options = {}) {
  const handlers = new Map(), sent = [], calls = [], inputs = [];
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  ipcMain.removeHandler = name => handlers.delete(name);
  const webContents = new EventEmitter();
  webContents.mainFrame = { url: 'file:///test/index.html' };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  webContents.send = (name, value) => {
    sent.push([name, value]);
    if (name === 'wanx:setup:transport') queueMicrotask(() => ipcMain.emit('wanx:setup:transport-result',
      event, { requestId: value.requestId, ok: true, value: null }));
  };
  let identity = { accountId: 'account-one', clientId: 'client-one' }, handshakes = 0, gates = 0;
  const factory = mode => () => {
    let value = { mode, state: 'idle', preview: { device_id: 'box-one', identity_public_key_sha256: 'a'.repeat(64),
      network_state: 'unprovisioned', cloud_enrollment_status: 'ready', pairing_mode_remaining_seconds: 300,
      ...options.preview } }, listener;
    const update = state => { value = { ...value, state }; listener?.(); };
    return {
      getSnapshot: () => value,
      subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
      async begin(input) { inputs.push(input); update('previewReady'); },
      async confirmPhysicalDevice() {
        if (++handshakes <= (options.expireHandshake || 0)) throw fail('PAIRING_EXPIRED');
        value.pairingSessionId = clientAttemptId;
        value.pairingExpiresInMs = 300000;
        update('awaitingWifi');
      },
      async provideWifi() { value.networkState = 'connected'; update('awaitingCodeClaim'); },
      async cancel() { update('cancelled'); },
      async suspend() {}, async dispose() {},
    };
  };
  const host = await createProvisioningHost({ webContents, ipcMain, documentUrl: webContents.mainFrame.url,
    consumer: { current: async () => identity, pairingApi: async () => ({
      getClaimState: async () => { gates++; return { data: { deviceId: 'box-one', ownershipState: 'unclaimed', canClaim: true, nextAction: 'claim' } }; },
    }) },
    redeemConsoleClaim: async (...args) => {
      calls.push(args);
      return options.redeem ? options.redeem(...args) : { deviceId: args[1], ownership: 'claimed', authorizationState: 'deviceAckPending' };
    },
    resumeStore: new Proxy({}, { get() { throw new Error('Wi-Fi must not use resume storage'); } }),
    trustedRootCertificatesPem: [], trustedRootSpkiPins: [], cryptoFactory: () => ({}),
    coordinatorFactory: factory('claim'), consoleWifiCoordinatorFactory: factory('console'),
  });
  return { host, inputs, calls, sent, gates: () => gates, handshakes: () => handshakes,
    identity: value => { identity = value; }, crash: () => webContents.emit('render-process-gone'),
    invoke: (name, value, foreign = false) => handlers.get(`wanx:setup:${name}`)(foreign
      ? { ...event, senderFrame: { url: event.senderFrame.url } } : event, value),
    begin: () => host.begin({ ...candidate, mode: 'console', claimCode }),
    async network() { await host.begin({ ...candidate, mode: 'console', claimCode });
      await host.confirmPhysical(); await host.wifi({ ssid: 'office', security: 'open', hidden: false }); },
  };
}

test('code mode fixes the target from BLE and allows binding only after networking completes', async () => {
  const h = await harness();
  try {
    assert.equal((await h.begin()).mode, 'console');
    assert.equal(h.gates(), 0, 'factory-code devices do not use the ordinary BLE claim gate');
    await assert.rejects(h.host.redeemClaimCode(claimCode), { code: 'CLAIM_INVALID_STATE' });
    await h.host.confirmPhysical();
    await assert.rejects(h.host.redeemClaimCode(claimCode), { code: 'CLAIM_INVALID_STATE' });
    assert.equal((await h.host.wifi({ ssid: 'office', security: 'open', hidden: false })).state, 'awaitingCodeClaim');
    assert.equal(h.calls.length, 0);
    await assert.rejects(h.host.confirmOwnership(), { code: 'CLAIM_INVALID_STATE' });
    await assert.rejects(h.host.refresh(), { code: 'CLAIM_INVALID_STATE' });
    const result = await h.host.redeemClaimCode({ claimCode, clientAttemptId });
    assert.deepEqual(result, { deviceId: 'box-one', ownership: 'claimed', authorizationState: 'deviceAckPending' });
    assert.equal(h.calls.length, 1);
    const [code, deviceId, identity] = h.calls[0];
    assert.equal(code, claimCode); assert.equal(deviceId, 'box-one');
    assert.equal(identity.accountId, 'account-one'); assert.equal(identity.clientId, 'client-one');
    assert.equal(identity.clientAttemptId, clientAttemptId);
    assert.equal(h.inputs[0].claimCode, undefined, 'main releases the code after successful binding');
    assert.ok(!JSON.stringify(h.sent).includes(claimCode));
    assert.deepEqual(await h.host.redeemClaimCode({ claimCode, clientAttemptId }), result);
    assert.equal(h.calls.length, 1, 'duplicate confirmation returns the previous receipt');
  } finally { await h.host.dispose(); }
});

test('code binding rejects foreign renderers, changed codes and renderer-supplied target IDs', async () => {
  const h = await harness();
  try {
    await h.network();
    assert.equal((await h.invoke('redeemClaimCode', { claimCode, clientAttemptId }, true)).code, 'IPC_ACCESS_DENIED');
    assert.equal((await h.invoke('redeemClaimCode', { claimCode, clientAttemptId, expectedDeviceId: 'box-other' })).code, 'INVALID_REQUEST');
    assert.equal((await h.invoke('redeemClaimCode', { claimCode: 'ABCD234566', clientAttemptId })).code, 'CLAIM_INVALID_STATE');
    assert.equal(h.calls.length, 0);
  } finally { await h.host.dispose(); }
});

test('unknown binding result retains the same attempt across retry instead of issuing another claim', async () => {
  let requests = 0;
  const h = await harness({ redeem: async (_code, deviceId) => {
    if (++requests === 1) throw fail('REQUEST_TIMEOUT');
    return { deviceId, ownership: 'claimed', authorizationState: 'deviceAckPending' };
  } });
  try {
    await h.network();
    await assert.rejects(h.host.redeemClaimCode(claimCode), { code: 'REQUEST_TIMEOUT' });
    await assert.rejects(h.host.redeemClaimCode({ claimCode, clientAttemptId }), { code: 'CLAIM_INVALID_STATE' });
    assert.equal((await h.host.redeemClaimCode(claimCode)).authorizationState, 'deviceAckPending');
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0][2].clientAttemptId, h.calls[1][2].clientAttemptId);
  } finally { await h.host.dispose(); }
});

test('legacy preview redemption still pins the device and generates an idempotency attempt', async () => {
  const h = await harness();
  try {
    await h.host.begin(candidate);
    const value = await h.host.redeemClaimCode(claimCode);
    assert.equal(value.deviceId, 'box-one');
    assert.match(h.calls[0][2].clientAttemptId, /^[a-f0-9-]{36}$/);
  } finally { await h.host.dispose(); }
});

for (const action of ['cancel', 'reset', 'crash']) test(`${action} discards code authority without a resumable claim`, async () => {
  const h = await harness();
  try {
    await h.begin(); await h.host.confirmPhysical();
    if (action === 'crash') { h.crash(); await new Promise(resolve => setImmediate(resolve)); }
    else await h.host[action]();
    assert.equal(h.inputs[0].claimCode, undefined);
    await assert.rejects(h.host.redeemClaimCode(claimCode), { code: 'CLAIM_INVALID_STATE' });
    assert.equal(h.calls.length, 0);
  } finally { await h.host.dispose(); }
});

for (const [preview, code] of [
  [{ cloud_enrollment_status: 'not_enrolled' }, 'DEVICE_NOT_ENROLLED'],
  [{ pairing_mode_remaining_seconds: 0 }, 'PAIRING_MODE_CLOSED'],
]) test(`console Wi-Fi preserves the physical device gate: ${code}`, async () => {
  const h = await harness({ preview });
  try {
    await h.begin();
    await assert.rejects(h.host.confirmPhysical(), { code });
    assert.equal(h.handshakes(), 0);
  } finally { await h.host.dispose(); }
});

test('preparation renewal transfers the code only to the same selected device and clears the old context', async () => {
  const h = await harness({ expireHandshake: 1 });
  try {
    await h.begin();
    assert.equal((await h.host.confirmPhysical()).state, 'awaitingWifi');
    assert.equal(h.inputs.length, 2);
    assert.equal(h.inputs[0].claimCode, undefined);
    assert.equal(h.inputs[1].claimCode, claimCode);
    assert.deepEqual(h.inputs[1].selected, candidate);
  } finally { await h.host.dispose(); }
  assert.equal(h.inputs[1].claimCode, undefined);
});

test('an account change during binding invalidates the late response', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const h = await harness({ redeem: async (_code, deviceId) => { await wait;
    return { deviceId, ownership: 'claimed', authorizationState: 'ready' }; } });
  try {
    await h.network();
    const pending = h.host.redeemClaimCode({ claimCode, clientAttemptId });
    await new Promise(resolve => setImmediate(resolve));
    h.identity({ accountId: 'account-two', clientId: 'client-two' });
    release();
    await assert.rejects(pending, { code: 'AUTH_SESSION_CHANGED' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.inputs[0].claimCode, undefined);
    assert.equal(h.host.state().state, 'idle');
  } finally { release(); await h.host.dispose(); }
});

for (const ownership of [undefined, 'unclaimed']) test(`binding never invents ownership from an incomplete receipt: ${ownership}`, async () => {
  const h = await harness({ redeem: async (_code, deviceId) => ({ deviceId, ownership, authorizationState: 'ready' }) });
  try {
    await h.network();
    await assert.rejects(h.host.redeemClaimCode({ claimCode, clientAttemptId }), { code: 'CONTRACT_MISMATCH' });
    assert.equal(h.inputs[0].claimCode, claimCode, 'keep the attempt for reconciliation after an unknown response');
  } finally { await h.host.dispose(); }
});
