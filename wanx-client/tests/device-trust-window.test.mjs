import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDeviceTrustWindow } from '../shell/device-trust-window.mjs';

const requestId = Buffer.alloc(32, 1).toString('base64url');
const reviewHandle = Buffer.alloc(32, 2).toString('base64url');
const enrollmentInput = { boxId: 'box-1', targetInfo: '{}', capabilities: ['device.approve_use'],
  grants: [{ resourceId: 'space:personal', actions: ['read'] }], delegableGrants: [], expiresAt: null, delegationExpiresAt: null };
const methodInputs = {
  snapshot: {}, createProfile: { passphrase: 'local-secret-passphrase' }, unlock: { passphrase: 'local-secret-passphrase' }, lock: {},
  prepareFirstRoot: { deliveryPacket: '{}' }, confirmFirstRoot: { reviewHandle, passphrase: 'local-secret-passphrase' },
  exportJoinInfo: { boxId: 'box-1' }, prepareJoin: { joinInfo: '{}' }, submitJoin: { reviewHandle },
  prepareApproval: { invitation: '{}' }, confirmApproval: { reviewHandle, passphrase: 'local-secret-passphrase' },
  refreshRequest: { boxId: 'box-1', requestId }, cancelRequest: { boxId: 'box-1', requestId }, refreshDevices: { boxId: 'box-1' },
  refreshSecurityState: { boxId: 'box-1' }, refreshSelfBinding: { boxId: 'box-1' }, refreshMembers: { boxId: 'box-1' },
  prepareActivatePolicy: { boxId: 'box-1', capabilities: ['device.approve_use', 'device.revoke'] },
  prepareDeviceRevocation: { boxId: 'box-1', bindingId: 'binding-1', mode: 'normal' },
  prepareDescendantReview: { boxId: 'box-1', bindingIds: ['binding-1'] },
  prepareMemberRevocation: { boxId: 'box-1', principalId: 'member-1' },
  confirmSecurityMutation: { reviewHandle, passphrase: 'local-secret-passphrase' },
  refreshSecurityMutation: { boxId: 'box-1', requestId }, refreshDataEffect: { boxId: 'box-1', requestId },
  exportTargetInfo: {}, prepareManagerEnrollment: enrollmentInput, prepareMemberInvitation: enrollmentInput,
  exportTargetReview: { reviewHandle }, importTargetProofs: { reviewHandle, targetProofs: '{}' },
  prepareTargetApproval: { reviewHandoff: '{}' }, confirmTargetApproval: { reviewHandle, passphrase: 'local-secret-passphrase' },
  exportSecurityReceipt: { boxId: 'box-1', requestId }, resumeTargetApproval: { boxId: 'box-1', requestId }, acceptEnrollmentReceipt: { boxId: 'box-1', requestId, receipt: 'fixed-proof' },
  refreshBackupTargets: { boxId: 'box-1' }, prepareBackupCreate: { boxId: 'box-1', targetId: 'local-managed', scopeProfile: 'semantica-private-v1', includeBusinessSecrets: false },
  importBackupSource: { boxId: 'box-1' }, prepareBackupRestore: { sourceHandle: requestId },
  refreshBackupOperation: { boxId: 'box-1', requestId }, provideRestoreKey: { boxId: 'box-1', requestId }, saveBackupArchive: { boxId: 'box-1', requestId }, prepareOwnershipTransfer: { boxId: 'box-1' }, refreshOwnershipTransfer: { boxId: 'box-1', requestId },
  beginRecoveryConfiguration: { boxId: 'box-1' }, exportRecoveryMaterial: { materialHandle: requestId },
  reimportRecoveryMaterial: { materialHandle: requestId }, prepareRecoveryConfiguration: { materialHandle: requestId },
  importIdentityRecovery: {}, beginIdentityRecovery: { recoveryHandle: requestId },
  prepareIdentityRecovery: { materialHandle: requestId }, confirmIdentityRecovery: { reviewHandle, passphrase: 'local-secret-passphrase' },
};
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function harness(t, overrides = {}) {
  const handlers = new Map(), calls = [], windows = [], errors = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; windows.push(this);
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: '' }, send: (...args) => calls.push(['send', ...args]),
        setWindowOpenHandler: fn => { this.openHandler = fn; },
        session: { setPermissionRequestHandler: fn => { this.permission = fn; }, setPermissionCheckHandler: fn => { this.permissionCheck = fn; },
          webRequest: { onBeforeRequest: fn => { this.beforeRequest = fn; } } },
      });
    }
    async loadURL(url) { this.url = url; this.webContents.mainFrame.url = url; }
    isDestroyed() { return this.destroyed; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    close() { this.emit('close'); this.destroy(); }
  }
  const service = Object.fromEntries(Object.keys(methodInputs).map(method => [method, async input => {
    calls.push([method, input]);
    return method === 'snapshot' ? { profile: { locked: false }, boxes: [] } : { method };
  }]));
  Object.assign(service, overrides);
  const controller = createDeviceTrustWindow({ BrowserWindow: Window,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    service, onError: error => errors.push(error),
  });
  t.after(async () => { await controller.dispose().catch(() => {}); });
  await controller.open();
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const invoke = (method, input = methodInputs[method], source = event(windows.at(-1))) => handlers.get(`wanx:device-trust:${method}`)(source, input);
  return { controller, calls, windows, handlers, invoke, event, service, errors };
}

test('window uses a private nonpersistent session, sandbox and fixed local document', async t => {
  const h = await harness(t), window = h.windows[0], preferences = window.options.webPreferences;
  assert.equal(preferences.nodeIntegration, false);
  for (const key of ['contextIsolation', 'sandbox', 'webSecurity']) assert.equal(preferences[key], true);
  assert.equal(preferences.devTools, false);
  assert.match(preferences.partition, /^wanx-device-trust-/);
  assert.equal(preferences.partition.startsWith('persist:'), false);
  assert.equal(window.shown, true);
  assert.match(window.url, /\/local-ui\/device-trust\/index\.html$/);
  assert.deepEqual(window.openHandler(), { action: 'deny' });
  window.permission({}, 'clipboard-read', result => assert.equal(result, false));
  assert.equal(window.permissionCheck(), false);
  for (const url of ['https://example.test', 'file:///private/secret', `${window.url}?bad=1`]) window.beforeRequest({ url }, result => assert.equal(result.cancel, true));
  for (const name of ['index.html', 'view.mjs', 'styles.css']) window.beforeRequest({ url: new URL(name, window.url).href }, result => assert.equal(result.cancel, false));
  assert.deepEqual((await h.invoke('snapshot')).value.window, { view: 'overview' });
});

for (const type of ['foreign', 'same-url-other-window', 'subframe', 'query', 'hash', 'destroyed']) {
  test(`every method rejects ${type} before calling service`, async t => {
    const h = await harness(t), window = h.windows[0];
    let source = h.event(window);
    if (type === 'foreign') source = {};
    if (type === 'same-url-other-window') source = { sender: { mainFrame: window.webContents.mainFrame }, senderFrame: window.webContents.mainFrame };
    if (type === 'subframe') source.senderFrame = { url: window.url };
    if (type === 'query' || type === 'hash') window.webContents.mainFrame.url += type === 'query' ? '?fake=1' : '#fake';
    if (type === 'destroyed') window.destroyed = true;
    for (const method of Object.keys(methodInputs)) assert.deepEqual(await h.invoke(method, methodInputs[method], source), { ok: false, code: 'LOCAL_TRUST_UNTRUSTED_SENDER' });
    assert.equal(h.calls.length, 0);
  });
}

test('exact schemas reject extra confirmation, raw signatures, network data and missing fields', async t => {
  const h = await harness(t);
  for (const method of Object.keys(methodInputs)) {
    for (const extra of [{ verified: true }, { signature: 'raw' }, { url: 'https://attacker.test' }, { trustedState: {} }])
      assert.equal((await h.invoke(method, { ...methodInputs[method], ...extra })).code, 'LOCAL_TRUST_INVALID_INPUT');
    if (Object.keys(methodInputs[method]).length) assert.equal((await h.invoke(method, {})).code, 'LOCAL_TRUST_INVALID_INPUT');
    for (const input of [null, [], 'raw']) assert.equal((await h.invoke(method, input)).code, 'LOCAL_TRUST_INVALID_INPUT');
  }
  assert.equal((await h.invoke('prepareFirstRoot', { deliveryPacket: '中'.repeat(2800) })).code, 'LOCAL_TRUST_INVALID_INPUT');
  assert.equal((await h.invoke('prepareApproval', { invitation: 'x'.repeat(32769) })).code, 'LOCAL_TRUST_INVALID_INPUT');
  assert.equal((await h.invoke('unlock', { passphrase: 'a\0b' })).code, 'LOCAL_TRUST_INVALID_INPUT');
  assert.equal((await h.invoke('refreshDevices', { boxId: '../box' })).code, 'LOCAL_TRUST_INVALID_INPUT');
  for (const capabilities of [['admin'], ['device.revoke', 'device.approve_use'], ['device.revoke', 'device.revoke'], []])
    assert.equal((await h.invoke('prepareActivatePolicy', { boxId: 'box-1', capabilities })).code, 'LOCAL_TRUST_INVALID_INPUT');
  assert.equal((await h.invoke('prepareDeviceRevocation', { boxId: 'box-1', bindingId: 'binding-1', mode: 'erase' })).code, 'LOCAL_TRUST_INVALID_INPUT');
  for (const invalid of [{ ...enrollmentInput, grants: [{ resourceId: 'space', actions: ['admin'] }] },
    { ...enrollmentInput, grants: [{ resourceId: 'space', actions: ['read'], namespaceId: 'another-user' }] },
    { ...enrollmentInput, expiresAt: 1.5 }, { ...enrollmentInput, filePath: '/private/material' }])
    assert.equal((await h.invoke('prepareManagerEnrollment', invalid)).code, 'LOCAL_TRUST_INVALID_INPUT');
  assert.equal(h.calls.length, 0);
  assert.equal(h.handlers.has('wanx:device-trust:sign'), false);
});

test('business methods forward only their declared input and errors never expose secrets', async t => {
  const h = await harness(t);
  for (const method of Object.keys(methodInputs).filter(method => method !== 'lock')) {
    assert.equal((await h.invoke(method)).ok, true);
    assert.deepEqual(h.calls.at(-1), [method, methodInputs[method]]);
  }
  h.service.confirmApproval = () => { throw new Error('passphrase=do-not-report-secret'); };
  assert.deepEqual(await h.invoke('confirmApproval'), { ok: false, code: 'LOCAL_TRUST_OPERATION_FAILED' });
});

test('locking during confirmation invalidates its late result and executes immediately', async t => {
  const pending = deferred(), started = deferred();
  const h = await harness(t, { confirmApproval: async () => { started.resolve(); return pending.promise; } });
  const approval = h.invoke('confirmApproval'); await started.promise;
  assert.equal((await h.invoke('prepareJoin')).code, 'LOCAL_TRUST_BUSY');
  assert.equal((await h.invoke('lock')).ok, true);
  assert.ok(h.calls.some(call => call[0] === 'lock' && call[1] === 'manual'));
  pending.resolve({ ack: { bindingId: 'should-never-be-visible' } });
  assert.deepEqual(await approval, { ok: false, code: 'LOCAL_TRUST_CONTEXT_CHANGED' });
});

for (const reason of ['close', 'render-process-gone', 'will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview', 'did-start-navigation']) {
  test(`${reason} locks and fences pending work`, async t => {
    const pending = deferred(), started = deferred();
    const h = await harness(t, { confirmApproval: async () => { started.resolve(); return pending.promise; } });
    const work = h.invoke('confirmApproval'); await started.promise;
    const window = h.windows[0]; let prevented = false;
    if (reason === 'close') window.close();
    else window.webContents.emit(reason, { preventDefault() { prevented = true; } });
    assert.ok(h.calls.some(([method]) => method === 'lock'));
    if (reason.startsWith('will-')) assert.equal(prevented, true);
    pending.resolve({ secret: 'late' });
    assert.equal((await work).code, 'LOCAL_TRUST_CONTEXT_CHANGED');
  });
}

test('reopening one window updates context only after lock and removes all IPC on dispose', async t => {
  const h = await harness(t);
  await h.controller.open({ view: 'devices', boxId: 'box-2' });
  assert.equal(h.windows.length, 1);
  assert.deepEqual(h.calls[0], ['lock', 'window-context-changed']);
  assert.deepEqual((await h.invoke('snapshot')).value.window, { view: 'devices', boxId: 'box-2' });
  await h.controller.dispose();
  assert.equal(h.handlers.size, 0);
  assert.equal(h.windows[0].isDestroyed(), true);
  await assert.rejects(h.controller.open(), /LOCAL_TRUST_WINDOW_CLOSED/);
});

test('lock failure blocks further service reads without logging sensitive errors', async t => {
  const h = await harness(t);
  h.service.lock = () => { throw new Error('private-passphrase'); };
  assert.equal((await h.invoke('lock')).code, 'LOCAL_TRUST_LOCK_FAILED');
  assert.equal((await h.invoke('snapshot')).code, 'LOCAL_TRUST_LOCK_FAILED');
  assert.equal(h.calls.filter(call => call[0] !== 'send').length, 0);
  assert.equal(h.errors[0].message, 'LOCAL_TRUST_OPERATION_FAILED');
});

test('concurrent open calls create only one trusted window', async t => {
  const h = await harness(t);
  h.windows[0].close();
  await Promise.all([h.controller.open(), h.controller.open()]);
  assert.equal(h.windows.length, 2);
});

test('main lifecycle invalidation locks immediately and notifies only the trusted window', async t => {
  const h = await harness(t);
  await h.controller.invalidate('system-suspended');
  assert.deepEqual(h.calls, [['lock', 'system-suspended'], ['send', 'wanx:device-trust:changed']]);
});

test('box tokens match the protocol and request identifiers require canonical 32-byte values', async t => {
  const h = await harness(t);
  assert.equal((await h.invoke('refreshDevices', { boxId: 'box:lab.v1-root' })).ok, true);
  for (const requestId of ['request-1', 'A'.repeat(42), 'B'.repeat(43), 'A'.repeat(43) + '='])
    assert.equal((await h.invoke('refreshRequest', { boxId: 'box:lab', requestId })).code, 'LOCAL_TRUST_INVALID_INPUT');
});
