const { contextBridge, ipcRenderer } = require('electron');

const fields = {
  exportTeamDeviceResourceInfo: ['boxId'], prepareTeamRemoteDeviceResource: ['boxId', 'resourceInfo', 'resourceId'],
  prepareTeamKnowledgeResource: ['boxId'], prepareTeamDeviceResource: ['boxId', 'resourceId'], prepareTeamResourceAccess: ['boxId', 'resourceId', 'grants'],
  prepareTeamActivation: ['boxId', 'deviceId'], prepareTeamLink: ['boxId', 'deviceId'],
  refreshTeam: ['boxId'], refreshTeamAssociation: ['boxId'],
  prepareTeamInvite: ['boxId', 'roleId', 'capabilities', 'grants', 'delegableGrants', 'expiresAt', 'delegationExpiresAt'],
  prepareTeamInviteRevocation: ['boxId', 'invitationId'], prepareTeamMemberRole: ['boxId', 'principalId', 'roleId'],
  prepareTeamMemberSuspension: ['boxId', 'principalId'], prepareTeamMemberRevocation: ['boxId', 'principalId'],
  exportTeamInvitation: ['boxId', 'requestId'], prepareTeamJoin: ['invitation', 'deviceId'],
  submitTeamJoin: ['reviewHandle', 'passphrase'], refreshTeamRequest: ['boxId', 'requestId'],
  confirmTeamConsent: ['reviewHandle', 'passphrase'], prepareTeamAdmission: ['boxId', 'requestId'],
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
