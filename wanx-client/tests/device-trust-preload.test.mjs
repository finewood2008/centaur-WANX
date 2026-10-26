import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../local-ui/device-trust-preload.cjs', import.meta.url), 'utf8');
function harness() {
  let api; const calls = [], listeners = new Map();
  vm.runInNewContext(source, { require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'wanxDeviceTrust'); api = value; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true, value: { public: true } }; },
        on: (name, fn) => listeners.set(name, fn), removeListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); } } };
  } });
  return { api, calls, listeners };
}
test('preload exposes fixed business methods and never generic IPC or signing', async () => {
  const h = harness();
  assert.deepEqual(Object.keys(h.api).sort(), ['snapshot', 'createProfile', 'unlock', 'lock', 'prepareFirstRoot', 'confirmFirstRoot', 'exportJoinInfo', 'prepareJoin', 'submitJoin', 'prepareApproval', 'confirmApproval', 'refreshRequest', 'cancelRequest', 'refreshDevices', 'onChanged',
    'refreshSecurityState', 'refreshSelfBinding', 'refreshMembers', 'prepareActivatePolicy', 'prepareDeviceRevocation',
    'prepareDescendantReview', 'prepareMemberRevocation', 'confirmSecurityMutation', 'refreshSecurityMutation', 'refreshDataEffect',
    'exportTargetInfo', 'prepareManagerEnrollment', 'prepareMemberInvitation', 'exportTargetReview', 'importTargetProofs',
    'prepareTargetApproval', 'confirmTargetApproval', 'exportSecurityReceipt', 'resumeTargetApproval', 'acceptEnrollmentReceipt',
    'refreshBackupTargets', 'prepareBackupCreate', 'importBackupSource', 'prepareBackupRestore', 'refreshBackupOperation', 'provideRestoreKey', 'saveBackupArchive', 'prepareOwnershipTransfer', 'refreshOwnershipTransfer',
    'beginRecoveryConfiguration', 'exportRecoveryMaterial', 'reimportRecoveryMaterial', 'prepareRecoveryConfiguration',
    'importIdentityRecovery', 'beginIdentityRecovery', 'prepareIdentityRecovery', 'confirmIdentityRecovery'].sort());
  assert.equal(Object.isFrozen(h.api), true);
  await h.api.confirmApproval({ reviewHandle: 'review-1', passphrase: 'local-password' });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), ['wanx:device-trust:confirmApproval', { reviewHandle: 'review-1', passphrase: 'local-password' }]);
  await assert.rejects(h.api.confirmApproval({ reviewHandle: 'review-1', passphrase: 'local-password', verified: true }), /LOCAL_TRUST_INVALID_INPUT/);
  await assert.rejects(h.api.snapshot({ url: 'file:///private' }), /LOCAL_TRUST_INVALID_INPUT/);
  assert.equal(h.calls.length, 1);
});
test('changed subscription discards the Electron event and all supplied payloads', () => {
  const h = harness(); let args;
  const unsubscribe = h.api.onChanged((...values) => { args = values; });
  h.listeners.get('wanx:device-trust:changed')({ sender: 'privileged' }, { secret: 'untrusted' });
  assert.deepEqual(args, []);
  unsubscribe(); assert.equal(h.listeners.size, 0);
});
