import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { publicKeyThumbprint } from './binding-contract.mjs';
import { validateDescriptor } from './management-contract.mjs';

export const LEDGER_CAPABILITIES = Object.freeze([
  'backup.create', 'backup.restore', 'device.approve_manage', 'device.approve_use',
  'device.review_descendants', 'device.revoke', 'member.invite', 'member.revoke',
  'ownership.transfer', 'recovery.configure',
]);
export const LEDGER_ACTIONS = Object.freeze([
  'owner-policy.activate-v2', 'device.add-manager', 'principal.invite', 'device.revoke',
  'device.review-descendants', 'principal.revoke', 'recovery.setup', 'recovery.rotate',
  'recovery.recover', 'backup.create', 'backup.restore', 'ownership.transfer-prepare',
]);
const CONTEXT = ['boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'rosterVersion', 'rosterDigest', 'policyVersion'];
export const V1_BINDING_FIELDS = Object.freeze(['bindingId', 'principalId', 'clientId', 'role', 'status',
  'accessKey', 'approvalKey', 'approvalKeyVersion', 'canApproveUseDevices', 'delegableGrants',
  'expiresAt', 'delegationExpiresAt', 'establishedAt', 'establishedVersion']);
const PREPARE = ['schemaVersion', 'purpose', ...CONTEXT, 'requestId', 'challenge', 'issuedAt', 'expiresAt', 'actor', 'action', 'args'];
const READS = ['self-binding', 'principal-state', 'membership-directory', 'mutation-status', 'operation-status', 'data-effect', 'recovery-state', 'transfer-status'];
const RECOVERY_REVIEW = ['principalId', 'recoveryId', 'version', 'status', 'signingKey', 'backupKey',
  'grants', 'delegableGrants', 'capabilities', 'expiresAt', 'delegationExpiresAt'];
const RECOVERY_PUBLIC = [...RECOVERY_REVIEW, 'establishedAt', 'establishedSequence', 'retiredAtSequence'];
const TARGET_KEYS = ['clientId', 'accessKey', 'approvalKey', 'keyProtection'];
const TARGET_AUTHORITY = ['capabilities', 'grants', 'delegableGrants', 'expiresAt', 'delegationExpiresAt'];
const PROOFS = ['mutationProof', 'targetAccessProof', 'targetApprovalProof', 'recoveryMaterialProof', 'sourceRecoveryProof'];
const MAX_JWS = 16384;

export class LedgerProtocolError extends Error {
  constructor(code = 'LOCAL_LEDGER_INVALID') { super(code); this.name = 'LedgerProtocolError'; this.code = code; }
}
function need(value, code) { if (!value) throw new LedgerProtocolError(code); }
function record(value) {
  need(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  need(Reflect.ownKeys(value).every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && d.enumerable && Object.hasOwn(d, 'value');
  }));
}
function exact(value, fields) {
  record(value); need(Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)));
}
export function canonicalLedger(value, depth = 0) {
  need(depth <= 32);
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { need(Number.isSafeInteger(value) && !Object.is(value, -0)); return JSON.stringify(value); }
  if (typeof value === 'string') { need(/^[\x00-\x7f]*$/.test(value)); return JSON.stringify(value); }
  if (Array.isArray(value)) {
    need(Reflect.ownKeys(value).length === value.length + 1);
    return `[${Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i)); need(d && Object.hasOwn(d, 'value'));
      return canonicalLedger(d.value, depth + 1);
    }).join(',')}]`;
  }
  record(value);
  return `{${Object.keys(value).sort().map(key => `${canonicalLedger(key)}:${canonicalLedger(value[key], depth + 1)}`).join(',')}}`;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function copy(value) { return freeze(JSON.parse(canonicalLedger(value))); }
export function ledgerDigest(value) { return createHash('sha256').update(canonicalLedger(value)).digest('base64url'); }
function integer(value, zero = false) { need(Number.isSafeInteger(value) && !Object.is(value, -0) && value >= (zero ? 0 : 1)); }
function token(value) { need(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.exec(value)?.[0] === value); }
function bytes(value, length = 32) {
  need(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value));
  const result = Buffer.from(value, 'base64url'); need(result.toString('base64url') === value && (length === null || result.length === length));
  return result;
}
function nullable(value, validator = token) { if (value !== null) validator(value); }
function boolean(value) { need(typeof value === 'boolean'); }
function expiry(value) { nullable(value, integer); }
function oneOf(value, choices) { need(choices.includes(value)); }
function sorted(value, validate, maximum = 16, minimum = 0, id = item => item) {
  need(Array.isArray(value) && value.length >= minimum && value.length <= maximum);
  let previous = '';
  for (const item of value) { validate(item); need(id(item) > previous); previous = id(item); }
}
function capabilities(value) { sorted(value, item => oneOf(item, LEDGER_CAPABILITIES), LEDGER_CAPABILITIES.length); }
function grants(value, empty = false) {
  sorted(value, grant => { exact(grant, ['resourceId', 'actions']); token(grant.resourceId);
    sorted(grant.actions, action => oneOf(action, ['execute', 'read', 'write']), 3, 1);
  }, 16, empty ? 0 : 1, grant => grant.resourceId);
}
function p256(value) { try { publicKeyThumbprint(value); } catch { throw new LedgerProtocolError(); } }
export function validateBackupPublicKey(value) {
  value = copy(value);
  exact(value, ['kty', 'n', 'e']); need(value.kty === 'RSA' && value.e === 'AQAB');
  const n = bytes(value.n, 384); need(n[0] >= 128);
  try { const key = createPublicKey({ key: value, format: 'jwk' }); need(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength === 3072); }
  catch { throw new LedgerProtocolError(); }
  return copy(value);
}
function context(value) {
  exact(value, CONTEXT); token(value.boxId); bytes(value.boxKeyThumbprint); bytes(value.rosterDigest);
  ['ownershipEpoch', 'rosterVersion', 'policyVersion'].forEach(name => integer(value[name]));
}
function fieldsContext(value) { context(Object.fromEntries(CONTEXT.map(name => [name, value[name]]))); }
function actor(value) {
  exact(value, ['kind', 'principalId', 'bindingId', 'keyVersion']);
  oneOf(value.kind, ['binding', 'recovery']); token(value.principalId); integer(value.keyVersion);
  if (value.kind === 'binding') token(value.bindingId); else need(value.bindingId === null);
}
function lifetime(value, maximum = 300) {
  integer(value.issuedAt); integer(value.expiresAt); need(value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= maximum);
}
function fresh(value, now) { integer(now); need(value.issuedAt <= now && now < value.expiresAt, 'LOCAL_LEDGER_EXPIRED'); }
function target(value, authority = true) {
  exact(value, [...TARGET_KEYS, ...(authority ? TARGET_AUTHORITY : [])]); token(value.clientId);
  p256(value.accessKey); p256(value.approvalKey);
  need(publicKeyThumbprint(value.accessKey) !== publicKeyThumbprint(value.approvalKey) && value.keyProtection === 'software-passphrase-v1');
  if (authority) { capabilities(value.capabilities); grants(value.grants); grants(value.delegableGrants, true);
    expiry(value.expiresAt); expiry(value.delegationExpiresAt); }
}
export function validateNewRecovery(value) {
  value = copy(value);
  exact(value, ['recoveryId', 'version', 'signingKey', 'backupKey']); bytes(value.recoveryId); integer(value.version);
  p256(value.signingKey); validateBackupPublicKey(value.backupKey); return copy(value);
}
function recoveryConfiguration(value, review = false) {
  exact(value, review ? RECOVERY_REVIEW : RECOVERY_PUBLIC); token(value.principalId); bytes(value.recoveryId); integer(value.version);
  oneOf(value.status, ['active', 'retired']); p256(value.signingKey); validateBackupPublicKey(value.backupKey);
  grants(value.grants, true); grants(value.delegableGrants, true); capabilities(value.capabilities);
  expiry(value.expiresAt); expiry(value.delegationExpiresAt);
  if (!review) { integer(value.establishedAt); integer(value.establishedSequence); expiry(value.retiredAtSequence); }
}
function ownerMapping(value) {
  sorted(value, item => { exact(item, ['sourcePrincipalId', 'targetPrincipalId', 'resourceIds']);
    token(item.sourcePrincipalId); token(item.targetPrincipalId); sorted(item.resourceIds, token, 16, 1);
  }, 16, 1, item => `${item.sourcePrincipalId}\0${item.targetPrincipalId}`);
}
function args(action, value) {
  oneOf(action, LEDGER_ACTIONS);
  switch (action) {
    case 'owner-policy.activate-v2': exact(value, ['capabilities']); capabilities(value.capabilities); need(value.capabilities.includes('device.approve_use')); break;
    case 'device.add-manager': exact(value, ['target']); target(value.target); break;
    case 'principal.invite': exact(value, ['principalId', 'target']); token(value.principalId); target(value.target); break;
    case 'device.revoke': exact(value, ['bindingId', 'mode']); token(value.bindingId); oneOf(value.mode, ['normal', 'emergency-lock']); break;
    case 'device.review-descendants': exact(value, ['bindingIds']); sorted(value.bindingIds, token, 16, 1); break;
    case 'principal.revoke': exact(value, ['principalId']); token(value.principalId); break;
    case 'recovery.setup': case 'recovery.rotate': case 'recovery.recover':
      exact(value, ['expectedRecoveryVersion', 'newRecovery', ...(action === 'recovery.recover' ? ['expectedPrincipalSecurityVersion', 'target'] : [])]);
      integer(value.expectedRecoveryVersion, action === 'recovery.setup');
      if (action === 'recovery.setup') need(value.expectedRecoveryVersion === 0);
      validateNewRecovery(value.newRecovery); need(value.newRecovery.version === value.expectedRecoveryVersion + 1);
      if (action === 'recovery.recover') { integer(value.expectedPrincipalSecurityVersion); target(value.target, false); }
      break;
    case 'backup.create':
      exact(value, ['scopeProfile', 'resourceIds', 'expectedRecoveryVersion', 'recipientKeyThumbprint', 'targetId', 'includeBusinessSecrets']);
      token(value.scopeProfile); sorted(value.resourceIds, token, 16, 1); integer(value.expectedRecoveryVersion);
      bytes(value.recipientKeyThumbprint); token(value.targetId); boolean(value.includeBusinessSecrets); break;
    case 'backup.restore':
      exact(value, ['backupId', 'archiveSha256', 'sourceBoxKeyThumbprint', 'manifestSha256', 'targetDescriptorDigest', 'scopeProfile', 'resourceIds', 'ownerMapping', 'sourceId']);
      ['backupId', 'archiveSha256', 'sourceBoxKeyThumbprint', 'manifestSha256', 'targetDescriptorDigest'].forEach(name => bytes(value[name]));
      token(value.scopeProfile); token(value.sourceId); sorted(value.resourceIds, token, 16, 1); ownerMapping(value.ownerMapping); break;
    case 'ownership.transfer-prepare':
      exact(value, ['transferId', 'dataDisposition', 'expectedOwnerPrincipalId', 'scopeManifestDigest', 'retainedIndependentBackups']);
      bytes(value.transferId); bytes(value.scopeManifestDigest); token(value.expectedOwnerPrincipalId);
      need(value.dataDisposition === 'erase-local' && value.retainedIndependentBackups === true); break;
  }
}
function mutation(value, preparing = false) {
  value = copy(value);
  exact(value, [...PREPARE, ...(preparing ? [] : ['effectsDigest'])]);
  need(value.schemaVersion === 2 && value.purpose === `centuarai.local-ledger.${preparing ? 'prepare' : 'mutation'}`);
  fieldsContext(value); bytes(value.requestId); bytes(value.challenge); lifetime(value); actor(value.actor); args(value.action, value.args);
  if (!preparing) bytes(value.effectsDigest);
  if (value.actor.kind === 'recovery') need(value.action === 'recovery.recover');
  if (value.action === 'recovery.recover') need(value.actor.kind === 'recovery' && value.actor.keyVersion === value.args.expectedRecoveryVersion);
  return copy(value);
}
export function validateLedgerPrepare(value) { return mutation(value, true); }
export function validateLedgerMutation(value) { return mutation(value); }
export function mutationDigest(value) { validateLedgerMutation(value); return ledgerDigest(value); }
export function validateLedgerAuthChallenge(value) {
  value = copy(value);
  exact(value, ['schemaVersion', 'purpose', 'boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'actor', 'clientNonce', 'issuedAt', 'expiresAt']);
  need(value.schemaVersion === 2 && value.purpose === 'centuarai.local-ledger.auth-challenge');
  token(value.boxId); bytes(value.boxKeyThumbprint); actor(value.actor); bytes(value.clientNonce); lifetime(value, 60);
  if (value.ownershipEpoch === null) need(value.actor.kind === 'recovery'); else integer(value.ownershipEpoch);
  return value;
}
export function validateLedgerAuthMutationChallenge(value) {
  value = copy(value);
  exact(value, ['schemaVersion', 'purpose', 'boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'actor', 'clientNonce', 'issuedAt', 'expiresAt', 'action']);
  need(value.purpose === 'centuarai.local-ledger.auth-mutation-challenge');
  const { action, ...challenge } = value;
  validateLedgerAuthChallenge({ ...challenge, purpose: 'centuarai.local-ledger.auth-challenge' });
  oneOf(action, LEDGER_ACTIONS);
  if (value.actor.kind === 'recovery') need(action === 'recovery.recover');
  if (action === 'recovery.recover') need(value.actor.kind === 'recovery');
  return value;
}
export function validateLedgerRead(value) {
  value = copy(value);
  exact(value, ['schemaVersion', 'purpose', 'boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'nonce', 'issuedAt', 'expiresAt', 'actor', 'operation', 'requestId', 'bindingId']);
  need(value.schemaVersion === 2 && value.purpose === 'centuarai.local-ledger.read');
  token(value.boxId); bytes(value.boxKeyThumbprint); integer(value.ownershipEpoch); bytes(value.nonce); lifetime(value, 60); actor(value.actor); oneOf(value.operation, READS);
  if (value.operation === 'self-binding') { need(value.actor.kind === 'binding' && value.bindingId === value.actor.bindingId && value.requestId === null); }
  else if (['mutation-status', 'operation-status', 'data-effect', 'transfer-status'].includes(value.operation)) { bytes(value.requestId); need(value.bindingId === null); }
  else need(value.requestId === null && value.bindingId === null);
  if (value.operation === 'transfer-status') need(value.actor.kind === 'binding');
  return copy(value);
}
function targetSummary(value) {
  exact(value, ['bindingId', 'principalId', 'clientId', 'role', 'accessKeyThumbprint', 'approvalKeyThumbprint', 'bindingRevision', 'status', 'capabilities', 'expiresAt', 'delegationExpiresAt']);
  ['bindingId', 'principalId', 'clientId'].forEach(name => token(value[name])); oneOf(value.role, ['use', 'manage']);
  bytes(value.accessKeyThumbprint); nullable(value.approvalKeyThumbprint, bytes); integer(value.bindingRevision);
  oneOf(value.status, ['active', 'suspended', 'revoked']); capabilities(value.capabilities); expiry(value.expiresAt); expiry(value.delegationExpiresAt);
}
export function validateLedgerEffects(value) {
  value = copy(value);
  exact(value, ['targetPrincipalId', 'targetBindingIds', 'targetSummaries', 'revokedBindings', 'suspendedBindings', 'invalidatedRequests',
    'principalSecurityVersionBefore', 'principalSecurityVersionAfter', 'recoveryVersionBefore', 'recoveryVersionAfter',
    'recoveryBefore', 'recoveryAfter', 'remainingIndependentManagers', 'verifiedRecoveryAvailable', 'grantsBefore', 'grantsAfter',
    'capabilitiesBefore', 'capabilitiesAfter', 'resultingAuthority', 'redacted', 'ownershipStateAfter', 'requiresVerifiedErase']);
  nullable(value.targetPrincipalId); sorted(value.targetBindingIds, token); sorted(value.targetSummaries, targetSummary, 16, 0, item => item.bindingId);
  for (const name of ['revokedBindings', 'suspendedBindings', 'invalidatedRequests']) {
    exact(value[name], ['count', 'digest']); integer(value[name].count, true); bytes(value[name].digest);
    if (value[name].count === 0) need(value[name].digest === ledgerDigest([]));
  }
  ['principalSecurityVersionBefore', 'principalSecurityVersionAfter'].forEach(name => nullable(value[name], integer));
  ['recoveryVersionBefore', 'recoveryVersionAfter'].forEach(name => nullable(value[name], item => integer(item, true)));
  ['recoveryBefore', 'recoveryAfter'].forEach(name => nullable(value[name], item => recoveryConfiguration(item, true)));
  ['grantsBefore', 'grantsAfter'].forEach(name => nullable(value[name], item => grants(item, true)));
  ['capabilitiesBefore', 'capabilitiesAfter'].forEach(name => nullable(value[name], capabilities));
  nullable(value.resultingAuthority, authority => { exact(authority, TARGET_AUTHORITY); capabilities(authority.capabilities);
    grants(authority.grants, true); grants(authority.delegableGrants, true); expiry(authority.expiresAt); expiry(authority.delegationExpiresAt); });
  integer(value.remainingIndependentManagers, true); boolean(value.verifiedRecoveryAvailable); boolean(value.redacted); boolean(value.requiresVerifiedErase);
  oneOf(value.ownershipStateAfter, ['unclaimed_ready', 'owned', 'transfer_frozen', 'erase_pending']);
  if (value.redacted) need(value.targetSummaries.length === 0 && value.grantsBefore === null && value.grantsAfter === null
    && value.capabilitiesBefore === null && value.capabilitiesAfter === null);
  return copy(value);
}
function internalBinding(value) {
  exact(value, [...V1_BINDING_FIELDS, 'bindingRevision', 'ownershipEpoch', 'capabilities', 'createdByBindingId', 'createdByRecoveryId', 'sourceRequestId', 'sourceEventSequence']);
  ['bindingId', 'principalId', 'clientId'].forEach(name => token(value[name]));
  oneOf(value.role, ['use', 'manage']); oneOf(value.status, ['active', 'suspended', 'revoked']); p256(value.accessKey);
  if (value.role === 'use') need(value.approvalKey === null && value.approvalKeyVersion === null && !value.canApproveUseDevices && value.capabilities.length === 0);
  else { p256(value.approvalKey); integer(value.approvalKeyVersion); need(publicKeyThumbprint(value.approvalKey) !== publicKeyThumbprint(value.accessKey)); }
  boolean(value.canApproveUseDevices); grants(value.delegableGrants, true); expiry(value.expiresAt); expiry(value.delegationExpiresAt); capabilities(value.capabilities);
  ['bindingRevision', 'ownershipEpoch', 'establishedAt', 'establishedVersion', 'sourceEventSequence'].forEach(name => integer(value[name]));
  nullable(value.createdByBindingId); nullable(value.createdByRecoveryId, bytes); bytes(value.sourceRequestId);
  need(value.canApproveUseDevices === value.capabilities.includes('device.approve_use'));
}
function principal(value) {
  exact(value, ['principalId', 'ownershipEpoch', 'status', 'principalSecurityVersion', 'createdSequence', 'recoveryVersion']);
  token(value.principalId); oneOf(value.status, ['active', 'suspended', 'revoked']);
  ['ownershipEpoch', 'principalSecurityVersion', 'createdSequence'].forEach(name => integer(value[name])); integer(value.recoveryVersion, true);
}
function resourceGrant(value) {
  exact(value, ['grantId', 'ownershipEpoch', 'principalId', 'bindingId', 'resourceId', 'resourceScope', 'resourceNamespaceId',
    'actions', 'delegableActions', 'expiresAt', 'delegationExpiresAt', 'status', 'sourceGrantIds', 'sourceBindingId', 'createdSequence', 'revision']);
  ['grantId', 'principalId', 'resourceId', 'resourceNamespaceId'].forEach(name => token(value[name]));
  nullable(value.bindingId); nullable(value.sourceBindingId); oneOf(value.resourceScope, ['principal-private', 'shared']);
  oneOf(value.status, ['active', 'suspended', 'revoked']); sorted(value.actions, item => oneOf(item, ['execute', 'read', 'write']), 3, 1);
  sorted(value.delegableActions, item => { oneOf(item, ['execute', 'read', 'write']); need(value.actions.includes(item)); }, 3);
  sorted(value.sourceGrantIds, token, 256); expiry(value.expiresAt); expiry(value.delegationExpiresAt);
  ['ownershipEpoch', 'createdSequence', 'revision'].forEach(name => integer(value[name]));
}
function ack(value) {
  exact(value, ['requestId', 'mutationDigest', 'action', 'effectsDigest', 'eventId', 'eventDigest', 'ownershipEpoch', 'rosterVersion', 'rosterDigest', 'policyVersion', 'authorizationVersion', 'committedAt', 'ownershipState', 'result']);
  ['requestId', 'mutationDigest', 'effectsDigest', 'eventDigest', 'rosterDigest'].forEach(name => bytes(value[name])); token(value.eventId);
  ['ownershipEpoch', 'rosterVersion', 'policyVersion', 'authorizationVersion', 'committedAt'].forEach(name => integer(value[name]));
  oneOf(value.action, LEDGER_ACTIONS); oneOf(value.ownershipState, ['unclaimed_ready', 'owned', 'transfer_frozen', 'erase_pending']);
  exact(value.result, ['principalId', 'bindingId', 'principalSecurityVersion', 'recoveryVersion', 'transferId', 'operationId']);
  ['principalId', 'bindingId'].forEach(name => nullable(value.result[name]));
  nullable(value.result.principalSecurityVersion, integer); nullable(value.result.recoveryVersion, item => integer(item, true));
  nullable(value.result.transferId, bytes); nullable(value.result.operationId, bytes);
  if (value.action.startsWith('backup.')) need(value.result.operationId === value.requestId);
  else need(value.result.operationId === null);
}
function backupResult(value, action) {
  const common = ['type', 'operationId', 'backupId', 'archiveSha256', 'manifestSha256', 'scopeProfile', 'resourceIds', 'completedAt'];
  if (action === 'backup.create') {
    exact(value, [...common, 'recoveryId', 'recoveryVersion', 'recipientKeyThumbprint', 'targetId', 'bytes', 'targetDurable']);
    need(value.type === 'backup-created' && value.targetDurable === true); bytes(value.recoveryId); bytes(value.recipientKeyThumbprint);
    integer(value.recoveryVersion); integer(value.bytes, true); token(value.targetId);
  } else {
    exact(value, [...common, 'targetBoxId', 'targetDescriptorDigest', 'ownerMapping', 'verifiedFiles', 'verifiedBytes', 'securityStateUnchanged', 'integrationsActivated']);
    need(value.type === 'data-restore-completed' && value.securityStateUnchanged === true && value.integrationsActivated === false);
    token(value.targetBoxId); bytes(value.targetDescriptorDigest); ownerMapping(value.ownerMapping); integer(value.verifiedFiles, true); integer(value.verifiedBytes, true);
  }
  ['operationId', 'backupId', 'archiveSha256', 'manifestSha256'].forEach(name => bytes(value[name]));
  token(value.scopeProfile); sorted(value.resourceIds, token, 16, 1); integer(value.completedAt);
}
function responseBody(kind, value) {
  switch (kind) {
    case 'mutation-challenge':
      exact(value, ['context', 'actor', 'action', 'challenge', 'issuedAt', 'expiresAt']); context(value.context); actor(value.actor);
      oneOf(value.action, LEDGER_ACTIONS); bytes(value.challenge); lifetime(value); break;
    case 'read-challenge': exact(value, ['context', 'nonce', 'issuedAt', 'expiresAt']); context(value.context); bytes(value.nonce); lifetime(value, 60); break;
    case 'mutation-review': exact(value, ['mutation', 'effects']); validateLedgerMutation(value.mutation); validateLedgerEffects(value.effects);
      need(value.mutation.effectsDigest === ledgerDigest(value.effects), 'LOCAL_LEDGER_EFFECTS_CHANGED'); break;
    case 'mutation-ack': ack(value); break;
    case 'self-binding':
      exact(value, ['bindingId', 'principalId', 'clientId', 'bindingOwnershipEpoch', 'currentContext', 'status', 'principalStatus', 'ownershipState',
        'bindingRevision', 'principalSecurityVersion', 'authorizationVersion']);
      ['bindingId', 'principalId', 'clientId'].forEach(name => token(value[name])); context(value.currentContext);
      ['bindingOwnershipEpoch', 'bindingRevision', 'principalSecurityVersion', 'authorizationVersion'].forEach(name => integer(value[name]));
      ['status', 'principalStatus'].forEach(name => oneOf(value[name], ['active', 'suspended', 'revoked']));
      oneOf(value.ownershipState, ['unclaimed_ready', 'owned', 'transfer_frozen', 'erase_pending']); break;
    case 'principal-state': {
      exact(value, ['context', 'projection', 'projectionDigest']); context(value.context); bytes(value.projectionDigest);
      const p = value.projection; exact(p, ['principal', 'ownershipView', 'bindings', 'grants', 'recoverySummary', 'qualifiedOriginalOwnerRoot']);
      principal(p.principal); exact(p.ownershipView, ['ownershipEpoch', 'state', 'isOwnerPrincipal', 'allowedOwnerActions']);
      integer(p.ownershipView.ownershipEpoch); oneOf(p.ownershipView.state, ['unclaimed_ready', 'owned', 'transfer_frozen', 'erase_pending']);
      boolean(p.ownershipView.isOwnerPrincipal); capabilities(p.ownershipView.allowedOwnerActions); boolean(p.qualifiedOriginalOwnerRoot);
      sorted(p.bindings, internalBinding, 1024, 0, item => item.bindingId); sorted(p.grants, resourceGrant, 4096, 0, item => item.grantId);
      nullable(p.recoverySummary, recoveryConfiguration);
      need(p.bindings.every(item => item.principalId === p.principal.principalId)
        && p.grants.every(item => item.principalId === p.principal.principalId)
        && (!p.recoverySummary || p.recoverySummary.principalId === p.principal.principalId), 'LOCAL_LEDGER_SCOPE_MISMATCH');
      need(value.projectionDigest === ledgerDigest(p), 'LOCAL_LEDGER_PROJECTION_CHANGED'); break;
    }
    case 'membership-directory':
      exact(value, ['context', 'members']); context(value.context);
      sorted(value.members, item => { exact(item, ['principalId', 'status', 'createdSequence', 'createdEventDigest']); token(item.principalId);
        oneOf(item.status, ['active', 'suspended', 'revoked']); integer(item.createdSequence); bytes(item.createdEventDigest);
      }, 1024, 0, item => item.principalId); break;
    case 'recovery-state':
      exact(value, ['principalId', 'principalSecurityVersion', 'configuration']); token(value.principalId); integer(value.principalSecurityVersion);
      nullable(value.configuration, recoveryConfiguration); need(value.configuration === null || value.configuration.principalId === value.principalId); break;
    case 'mutation-status':
      exact(value, ['requestId', 'mutationDigest', 'action', 'state', 'ack']); bytes(value.requestId); bytes(value.mutationDigest); oneOf(value.action, LEDGER_ACTIONS);
      oneOf(value.state, ['prepared', 'committed', 'cancelled', 'expired']); need((value.state === 'committed') === (value.ack !== null));
      if (value.ack !== null) compact(value.ack); break;
    case 'operation-status': {
      exact(value, ['status', 'operationEventDigest']); bytes(value.operationEventDigest); const s = value.status;
      exact(s, ['operationId', 'requestId', 'action', 'mutationDigest', 'attempt', 'stateVersion', 'state', 'phase', 'errorCode', 'recoveryRequired', 'result', 'updatedAt']);
      bytes(s.operationId); bytes(s.requestId); bytes(s.mutationDigest); need(s.operationId === s.requestId); oneOf(s.action, ['backup.create', 'backup.restore']);
      integer(s.attempt); integer(s.stateVersion); integer(s.updatedAt); boolean(s.recoveryRequired); nullable(s.errorCode);
      oneOf(s.state, ['queued', 'running', 'completed', 'failed', 'cancelled']);
      oneOf(s.phase, ['queued', 'validating', 'awaiting_key', 'quiescing', 'snapshotting', 'encrypting', 'staged', 'applying', 'data_verified', 'publishing', 'complete', 'failed_safe', 'recovery_required', 'cancelled']);
      if (s.state === 'completed') { need(s.errorCode === null && s.recoveryRequired === false && s.phase === 'complete'); backupResult(s.result, s.action); need(s.result.operationId === s.operationId); }
      else need(s.result === null); break;
    }
    case 'restore-key-received':
      exact(value, ['operationId', 'archiveSha256', 'receivedAt']); bytes(value.operationId); bytes(value.archiveSha256); integer(value.receivedAt); break;
    case 'transfer-status': {
      exact(value, ['requestId', 'transferId', 'state', 'sourceOwnershipEpoch', 'checkpoint', 'updatedAt', 'resetEvidenceDigest', 'preparedDeliveryDigest']);
      bytes(value.requestId); bytes(value.transferId); integer(value.sourceOwnershipEpoch); integer(value.updatedAt);
      oneOf(value.state, ['frozen', 'erase_pending', 'redelivery_ready']);
      exact(value.checkpoint, ['context', 'eventDigest', 'authorizationVersion']); context(value.checkpoint.context);
      bytes(value.checkpoint.eventDigest); integer(value.checkpoint.authorizationVersion);
      nullable(value.resetEvidenceDigest, bytes); nullable(value.preparedDeliveryDigest, bytes);
      need((value.state !== 'frozen') === (value.resetEvidenceDigest !== null)
        && (value.state === 'redelivery_ready') === (value.preparedDeliveryDigest !== null)
        && value.checkpoint.context.ownershipEpoch === value.sourceOwnershipEpoch + (value.state === 'redelivery_ready' ? 1 : 0));
      break;
    }
    default: throw new LedgerProtocolError('LOCAL_LEDGER_RESPONSE_KIND');
  }
}
function compact(jws) { need(typeof jws === 'string' && jws.length <= MAX_JWS && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jws)); }
const ledgerType = kind => ['auth-challenge', 'auth-mutation-challenge'].includes(kind) ? `centuarai-local-ledger.${kind}+jws` : `centuarai-local-ledger-${kind}+jws`;
function decode(jws, kind) {
  compact(jws); const [header, payload, signature] = jws.split('.');
  const parse = segment => {
    const raw = bytes(segment, null); need(raw.every(byte => byte <= 127));
    let value; try { value = JSON.parse(raw.toString('ascii')); } catch { throw new LedgerProtocolError(); }
    need(canonicalLedger(value) === raw.toString('ascii')); return value;
  };
  const h = parse(header); exact(h, ['alg', 'typ']); need(h.alg === 'ES256' && h.typ === ledgerType(kind));
  return { value: parse(payload), signature: bytes(signature, 64), input: Buffer.from(`${header}.${payload}`) };
}
function signing(value, privateKey, kind, validate = validateLedgerMutation) {
  const payload = validate(copy(value)); let key;
  try { key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey); }
  catch { throw new LedgerProtocolError(); }
  need(key.type === 'private' && key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails.namedCurve === 'prime256v1');
  const input = `${Buffer.from(canonicalLedger({ alg: 'ES256', typ: ledgerType(kind) })).toString('base64url')}.${Buffer.from(canonicalLedger(payload)).toString('base64url')}`;
  const jws = `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  compact(jws); return jws;
}
function verifying(jws, publicKey, kind, validate, now) {
  const decoded = decode(jws, kind); validate(decoded.value); p256(publicKey);
  need(verify('sha256', decoded.input, { key: createPublicKey({ key: publicKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, decoded.signature), 'LOCAL_LEDGER_SIGNATURE_INVALID');
  if (now !== undefined) fresh(decoded.value, now); return copy(decoded.value);
}
export const signLedgerPrepare = (payload, key) => signing(payload, key, 'prepare', validateLedgerPrepare);
export const signLedgerRead = (payload, key) => signing(payload, key, 'read', validateLedgerRead);
export const signLedgerAuthChallenge = (payload, key) => signing(payload, key, 'auth-challenge', validateLedgerAuthChallenge);
export const verifyLedgerAuthChallenge = (proof, key, now) => verifying(proof, key, 'auth-challenge', validateLedgerAuthChallenge, now);
export const signLedgerAuthMutationChallenge = (payload, key) => signing(payload, key, 'auth-mutation-challenge', validateLedgerAuthMutationChallenge);
export const verifyLedgerAuthMutationChallenge = (proof, key, now) => verifying(proof, key, 'auth-mutation-challenge', validateLedgerAuthMutationChallenge, now);
export const signLedgerMutation = (payload, key) => signing(payload, key, 'mutation');
export function signLedgerTargetAccess(payload, key) { const value = validateLedgerMutation(payload); need(['device.add-manager', 'principal.invite', 'recovery.recover'].includes(value.action)); return signing(value, key, 'target-access'); }
export function signLedgerTargetApproval(payload, key) { const value = validateLedgerMutation(payload); need(['device.add-manager', 'principal.invite', 'recovery.recover'].includes(value.action)); return signing(value, key, 'target-approval'); }
export function signLedgerRecoveryMaterial(payload, key) { const value = validateLedgerMutation(payload); need(['recovery.setup', 'recovery.rotate', 'recovery.recover'].includes(value.action)); return signing(value, key, 'recovery-material'); }
export function signLedgerSourceRecovery(payload, key) { const value = validateLedgerMutation(payload); need(value.action === 'backup.restore'); return signing(value, key, 'source-recovery'); }
export const verifyLedgerPrepare = (jws, key, now) => verifying(jws, key, 'prepare', validateLedgerPrepare, now);
export const verifyLedgerRead = (jws, key, now) => verifying(jws, key, 'read', validateLedgerRead, now);
export const verifyLedgerMutation = (jws, key, now) => verifying(jws, key, 'mutation', validateLedgerMutation, now);
export function verifyLedgerTargetProofs(proofs, mutation, now) {
  exact(proofs, ['targetAccessProof', 'targetApprovalProof']); validateLedgerMutation(mutation);
  for (const [field, kind, key] of [['targetAccessProof', 'target-access', mutation.args.target?.accessKey], ['targetApprovalProof', 'target-approval', mutation.args.target?.approvalKey]]) {
    const signed = verifying(proofs[field], key, kind, validateLedgerMutation, now);
    need(canonicalLedger(signed) === canonicalLedger(mutation), 'LOCAL_LEDGER_MUTATION_CHANGED');
  }
  return copy(proofs);
}
export function validateCommitProofs(value) { exact(value, PROOFS); compact(value.mutationProof); PROOFS.slice(1).forEach(name => nullable(value[name], compact)); return copy(value); }
export function ledgerRequestSpec(path, input) {
  const body = copy(input);
  let kind;
  if (path === '/mutations/challenge') {
    exact(body, ['actor', 'action']); actor(body.actor); oneOf(body.action, LEDGER_ACTIONS); kind = 'mutation-challenge';
  } else if (path === '/mutations/authenticated-challenge') {
    exact(body, ['proof']); validateLedgerAuthMutationChallenge(decode(body.proof, 'auth-mutation-challenge').value); kind = 'mutation-challenge';
  } else if (path === '/mutations/prepare') {
    exact(body, ['prepareProof']); validateLedgerPrepare(decode(body.prepareProof, 'prepare').value); kind = 'mutation-review';
  } else if (path === '/mutations/commit') {
    validateCommitProofs(body); kind = 'mutation-ack';
  } else if (path === '/auth/challenge') {
    exact(body, []); kind = 'read-challenge';
  } else if (path === '/authenticated-challenge') {
    exact(body, ['proof']); validateLedgerAuthChallenge(decode(body.proof, 'auth-challenge').value); kind = 'read-challenge';
  } else if (path === '/read') {
    exact(body, ['proof']); const read = validateLedgerRead(decode(body.proof, 'read').value);
    kind = read.operation === 'data-effect' ? 'effect' : read.operation;
  } else throw new LedgerProtocolError('LOCAL_LEDGER_ROUTE_INVALID');
  const encoded = Buffer.from(canonicalLedger(body)); need(encoded.length <= 96 * 1024);
  return { kind, encoded };
}
export function validateLedgerResponse(value) {
  value = copy(value);
  exact(value, ['schemaVersion', 'purpose', 'boxId', 'boxKeyThumbprint', 'kind', 'issuedAt', 'body']);
  need(value.schemaVersion === 2 && value.purpose === 'centuarai.local-ledger.response'); token(value.boxId); bytes(value.boxKeyThumbprint); integer(value.issuedAt);
  responseBody(value.kind, value.body); return copy(value);
}
export function signLedgerResponse(payload, key) { return signing(payload, key, 'response', validateLedgerResponse); }
export function verifyLedgerResponse(jws, { descriptor, kind, now, expected = {} }) {
  const trusted = validateDescriptor(descriptor);
  const response = verifying(jws, trusted.boxKey, 'response', validateLedgerResponse);
  need(response.boxId === trusted.boxId && response.boxKeyThumbprint === publicKeyThumbprint(trusted.boxKey) && response.kind === kind, 'LOCAL_LEDGER_CONTEXT_CHANGED');
  integer(now); need(response.issuedAt <= now + 5 && (kind === 'mutation-ack' || now - response.issuedAt <= 300), 'LOCAL_LEDGER_RESPONSE_EXPIRED');
  for (const [name, value] of Object.entries(expected)) need(canonicalLedger(response.body[name]) === canonicalLedger(value), 'LOCAL_LEDGER_RESPONSE_CHANGED');
  if (['mutation-challenge', 'read-challenge'].includes(kind)) fresh(response.body, now);
  if (kind === 'mutation-review') fresh(response.body.mutation, now);
  return response;
}
export function parseLedgerPacket(text) {
  need(typeof text === 'string' && Buffer.byteLength(text) <= 65536 && /^[\x00-\x7f]*$/.test(text));
  let value; try { value = JSON.parse(text); } catch { throw new LedgerProtocolError(); }
  // Preserve input key order to reject duplicate keys and alternate spellings,
  // while accepting whitespace around an explicitly imported document.
  let compacted = '', quoted = false, escaped = false;
  for (const c of text) { if (quoted || !/[\x20\t\r\n]/.test(c)) compacted += c;
    if (quoted && escaped) escaped = false; else if (quoted && c === '\\') escaped = true; else if (c === '"') quoted = !quoted; }
  need(JSON.stringify(value) === compacted); canonicalLedger(value); return value;
}
export function parseReviewHandoff(text, now) {
  const value = parseLedgerPacket(text); exact(value, ['schemaVersion', 'type', 'baseUrl', 'tlsSpkiSha256', 'boxKey', 'reviewJws']);
  need(value.schemaVersion === 2 && value.type === 'centuarai-local-ledger-review-handoff');
  const decoded = decode(value.reviewJws, 'response'); validateLedgerResponse(decoded.value);
  const descriptor = validateDescriptor({ boxId: decoded.value.boxId, baseUrl: value.baseUrl, tlsSpkiSha256: value.tlsSpkiSha256, boxKey: value.boxKey });
  const review = verifyLedgerResponse(value.reviewJws, { descriptor, kind: 'mutation-review', now });
  return copy({ descriptor, reviewJws: value.reviewJws, ...review.body });
}
export function parseTargetProofPacket(text, mutation, now) {
  const value = parseLedgerPacket(text); exact(value, ['schemaVersion', 'type', 'requestId', 'mutationDigest', 'targetAccessProof', 'targetApprovalProof']);
  need(value.schemaVersion === 2 && value.type === 'centuarai-local-ledger-target-proofs'
    && value.requestId === mutation.requestId && value.mutationDigest === mutationDigest(mutation), 'LOCAL_LEDGER_MUTATION_CHANGED');
  return verifyLedgerTargetProofs({ targetAccessProof: value.targetAccessProof, targetApprovalProof: value.targetApprovalProof }, mutation, now);
}
export function validateTargetInfo(value) {
  const input = copy(value);
  exact(input, ['schemaVersion', 'type', 'principalId', ...TARGET_KEYS]);
  need(input.schemaVersion === 2 && input.type === 'centuarai-local-ledger-target-info'); token(input.principalId);
  target(Object.fromEntries(TARGET_KEYS.map(name => [name, input[name]])), false);
  return input;
}
export function parseTargetInfo(text) { return validateTargetInfo(parseLedgerPacket(text)); }
