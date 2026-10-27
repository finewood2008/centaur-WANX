const { contextBridge, ipcRenderer } = require('electron');

const fields = {
  snapshot: [], createProfile: ['passphrase'], unlock: ['passphrase'], lock: [],
  prepareFirstRoot: ['deliveryPacket'], confirmFirstRoot: ['reviewHandle', 'passphrase'],
  exportJoinInfo: ['boxId'], prepareJoin: ['joinInfo'], submitJoin: ['reviewHandle'],
  prepareApproval: ['invitation'], confirmApproval: ['reviewHandle', 'passphrase'],
  refreshRequest: ['boxId', 'requestId'], cancelRequest: ['boxId', 'requestId'], refreshDevices: ['boxId'],
  refreshSecurityState: ['boxId'], refreshSelfBinding: ['boxId'], refreshMembers: ['boxId'],
  prepareActivatePolicy: ['boxId', 'capabilities'], prepareDeviceRevocation: ['boxId', 'bindingId', 'mode'],
  prepareDescendantReview: ['boxId', 'bindingIds'], prepareMemberRevocation: ['boxId', 'principalId'],
  confirmSecurityMutation: ['reviewHandle', 'passphrase'], refreshSecurityMutation: ['boxId', 'requestId'],
  refreshDataEffect: ['boxId', 'requestId'],
  exportTargetInfo: [],
  prepareManagerEnrollment: ['boxId', 'targetInfo', 'capabilities', 'grants', 'delegableGrants', 'expiresAt', 'delegationExpiresAt'],
  prepareMemberInvitation: ['boxId', 'targetInfo', 'capabilities', 'grants', 'delegableGrants', 'expiresAt', 'delegationExpiresAt'],
  exportTargetReview: ['reviewHandle'], importTargetProofs: ['reviewHandle', 'targetProofs'],
  prepareTargetApproval: ['reviewHandoff'], confirmTargetApproval: ['reviewHandle', 'passphrase'],
  exportSecurityReceipt: ['boxId', 'requestId'], acceptEnrollmentReceipt: ['boxId', 'requestId', 'receipt'],
  resumeTargetApproval: ['boxId', 'requestId'],
  beginRecoveryConfiguration: ['boxId'], exportRecoveryMaterial: ['materialHandle'], reimportRecoveryMaterial: ['materialHandle'],
  prepareRecoveryConfiguration: ['materialHandle'], importIdentityRecovery: [], beginIdentityRecovery: ['recoveryHandle'],
  prepareIdentityRecovery: ['materialHandle'], confirmIdentityRecovery: ['reviewHandle', 'passphrase'],
  refreshBackupTargets: ['boxId'], prepareBackupCreate: ['boxId', 'targetId', 'scopeProfile', 'includeBusinessSecrets'],
  importBackupSource: ['boxId'], prepareBackupRestore: ['sourceHandle'], refreshBackupOperation: ['boxId', 'requestId'],
  provideRestoreKey: ['boxId', 'requestId'], saveBackupArchive: ['boxId', 'requestId'],
  prepareOwnershipTransfer: ['boxId'],
  refreshOwnershipTransfer: ['boxId', 'requestId'],
  beginOfflineWifi: ['boxId', 'selected'], scanOfflineWifi: [],
  prepareOfflineWifi: ['ssid', 'security', 'hidden', 'password'],
  confirmOfflineWifi: ['reviewHandle', 'passphrase'], cancelOfflineWifi: [],
  prepareWifiAuthorization: ['boxId', 'bindingId', 'expiresAt', 'delegable'], prepareWifiRevocation: ['boxId', 'bindingId'],
};
const api = Object.fromEntries(Object.entries(fields).map(([method, keys]) => [method, async (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key)))
    throw Object.assign(new Error('LOCAL_TRUST_INVALID_INPUT'), { code: 'LOCAL_TRUST_INVALID_INPUT' });
  const result = await ipcRenderer.invoke(`wanx:device-trust:${method}`, Object.fromEntries(keys.map(key => [key, input[key]])));
  if (result?.ok !== true) {
    const code = typeof result?.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(result.code)
      ? result.code : 'LOCAL_TRUST_OPERATION_FAILED';
    throw Object.assign(new Error(code), { code });
  }
  return result.value;
}]));
api.onChanged = listener => {
  if (typeof listener !== 'function') throw new TypeError('listener must be a function');
  const receive = () => listener();
  ipcRenderer.on('wanx:device-trust:changed', receive);
  return () => ipcRenderer.removeListener('wanx:device-trust:changed', receive);
};
contextBridge.exposeInMainWorld('wanxDeviceTrust', Object.freeze(api));
// This renderer relays bounded GATT frames only. It cannot ask main to sign a
// byte string, choose a remote URL or export a key.
contextBridge.exposeInMainWorld('wanxSetupTransport', Object.freeze({
  scanTimeoutMs: 30000,
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const receive = (_event, request) => listener(request);
    ipcRenderer.on('wanx:local-wifi:transport', receive);
    return () => ipcRenderer.removeListener('wanx:local-wifi:transport', receive);
  },
  reply: result => ipcRenderer.send('wanx:local-wifi:transport-result', result),
  status() {},
}));
contextBridge.exposeInMainWorld('wanxDiscovery', Object.freeze({
  subscribe(onCandidates, onSettled) {
    if (typeof onCandidates !== 'function' || typeof onSettled !== 'function') throw new TypeError('listener must be a function');
    const candidates = (_event, value) => onCandidates(value), settled = (_event, value) => onSettled(value);
    ipcRenderer.on('nexusaos:discovery:candidates', candidates); ipcRenderer.on('nexusaos:discovery:settled', settled);
    return () => { ipcRenderer.removeListener('nexusaos:discovery:candidates', candidates); ipcRenderer.removeListener('nexusaos:discovery:settled', settled); };
  },
  select: (sessionId, candidateId) => ipcRenderer.send('nexusaos:discovery:select', { sessionId, candidateId }),
  cancel: sessionId => ipcRenderer.send('nexusaos:discovery:cancel', { sessionId }),
}));
