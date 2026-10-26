import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { canonicalLedger, ledgerDigest, validateBackupPublicKey } from './ledger-contract.mjs';
import { publicKeyThumbprint } from './binding-contract.mjs';
import { validateDescriptor } from './management-contract.mjs';

export const BACKUP_IO_OPERATIONS = Object.freeze(['targets.list', 'source.begin', 'source.append', 'source.finalize', 'source.read', 'archive.read', 'transfer.plan']);
export const BACKUP_CHUNK_BYTES = 1048576;
export const BACKUP_MAX_BYTES = 209715200;
export const BACKUP_PROFILES = Object.freeze({
  'semantica-private-v1': Object.freeze(['semantica']),
  'wanx-personal-v1': Object.freeze(['clipboard', 'space:personal']),
});
const SHARED = ['schemaVersion', 'purpose', 'boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'principalSecurityVersion', 'nonce', 'issuedAt', 'expiresAt', 'actor'];
export class BackupProtocolError extends Error {
  constructor(code = 'LOCAL_BACKUP_INVALID') { super(code); this.code = code; this.name = 'BackupProtocolError'; }
}
const need = (value, code) => { if (!value) throw new BackupProtocolError(code); };
const copy = value => JSON.parse(canonicalLedger(value));
const exact = (value, fields) => need(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(name => Object.hasOwn(value, name)));
const integer = (value, min = 1, max = Number.MAX_SAFE_INTEGER) => need(Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max);
const token = value => need(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.exec(value)?.[0] === value);
function bytes(value, length = 32, base64 = false) {
  need(typeof value === 'string' && (base64 ? /^[A-Za-z0-9+/]*={0,2}$/ : /^[A-Za-z0-9_-]+$/).test(value));
  const raw = Buffer.from(value, base64 ? 'base64' : 'base64url');
  need(raw.toString(base64 ? 'base64' : 'base64url') === value && (length === null || raw.length === length)); return raw;
}
const boolean = value => need(typeof value === 'boolean');
function shared(value, purpose) {
  need(value.schemaVersion === 1 && value.purpose === purpose); token(value.boxId); bytes(value.boxKeyThumbprint);
  integer(value.ownershipEpoch); integer(value.principalSecurityVersion); bytes(value.nonce);
  integer(value.issuedAt); integer(value.expiresAt); need(value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 60);
  exact(value.actor, ['kind', 'principalId', 'bindingId', 'keyVersion']); need(value.actor.kind === 'binding');
  token(value.actor.principalId); token(value.actor.bindingId); integer(value.actor.keyVersion);
}
export function validateBackupIOProof(input) {
  const value = copy(input); exact(value, [...SHARED, 'operation', 'bodySha256']);
  shared(value, 'centuarai.local-backup.io'); need(BACKUP_IO_OPERATIONS.includes(value.operation)); bytes(value.bodySha256); return value;
}
export function validateRestoreKeyProof(input) {
  const value = copy(input); exact(value, [...SHARED, 'operationId', 'archiveSha256', 'dataKeySha256']);
  shared(value, 'centuarai.local-restore.key'); ['operationId', 'archiveSha256', 'dataKeySha256'].forEach(name => bytes(value[name])); return value;
}
function signFixed(payload, key, typ, validator) {
  const value = validator(payload), privateKey = key instanceof KeyObject ? key : createPrivateKey(key);
  need(privateKey.type === 'private' && privateKey.asymmetricKeyType === 'ec' && privateKey.asymmetricKeyDetails.namedCurve === 'prime256v1');
  const input = `${Buffer.from(canonicalLedger({ alg: 'ES256', typ })).toString('base64url')}.${Buffer.from(canonicalLedger(value)).toString('base64url')}`;
  const proof = `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  need(proof.length <= 16384); return proof;
}
function decoded(jws, typ) {
  need(typeof jws === 'string' && jws.length <= 16384 && jws.split('.').length === 3);
  const [h, p, s] = jws.split('.');
  const json = encoded => { const raw = bytes(encoded, null); need(raw.every(byte => byte <= 127));
    let value; try { value = JSON.parse(raw.toString('ascii')); } catch { throw new BackupProtocolError(); }
    need(canonicalLedger(value) === raw.toString('ascii')); return value; };
  const header = json(h); exact(header, ['alg', 'typ']); need(header.alg === 'ES256' && header.typ === typ);
  return { payload: json(p), signature: bytes(s, 64), input: Buffer.from(`${h}.${p}`) };
}
function verifyFixed(proof, key, typ, validator) {
  const value = decoded(proof, typ); publicKeyThumbprint(key);
  need(verify('sha256', value.input, { key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, value.signature), 'LOCAL_BACKUP_SIGNATURE_INVALID');
  return validator(value.payload);
}
export const signBackupIOProof = (payload, key) => signFixed(payload, key, 'centuarai-local-backup-io+jws', validateBackupIOProof);
export const signRestoreKeyProof = (payload, key) => signFixed(payload, key, 'centuarai-local-restore-key+jws', validateRestoreKeyProof);
export const verifyBackupIOProof = (proof, key) => verifyFixed(proof, key, 'centuarai-local-backup-io+jws', validateBackupIOProof);
export const verifyRestoreKeyProof = (proof, key) => verifyFixed(proof, key, 'centuarai-local-restore-key+jws', validateRestoreKeyProof);

export function validateBackupIOBody(operation, input) {
  const body = copy(input); need(BACKUP_IO_OPERATIONS.includes(operation));
  if (['targets.list', 'transfer.plan'].includes(operation)) exact(body, []);
  if (operation === 'source.begin') {
    exact(body, ['archiveBytes', 'archiveSha256', 'source']); integer(body.archiveBytes, 1, BACKUP_MAX_BYTES); bytes(body.archiveSha256); validateDescriptor(body.source);
  }
  if (operation === 'source.append') {
    exact(body, ['uploadId', 'offset', 'chunkBase64']); token(body.uploadId); integer(body.offset, 0, BACKUP_MAX_BYTES);
    const chunk = bytes(body.chunkBase64, null, true); integer(chunk.length, 1, BACKUP_CHUNK_BYTES); need(body.offset + chunk.length <= BACKUP_MAX_BYTES);
  }
  if (operation === 'source.finalize') { exact(body, ['uploadId']); token(body.uploadId); }
  if (operation === 'source.read') { exact(body, ['sourceId']); token(body.sourceId); }
  if (operation === 'archive.read') {
    exact(body, ['operationId', 'offset', 'length']); bytes(body.operationId); integer(body.offset, 0, BACKUP_MAX_BYTES);
    integer(body.length, 1, BACKUP_CHUNK_BYTES); need(body.offset + body.length <= BACKUP_MAX_BYTES);
  }
  return body;
}
export function backupIORequestSpec(path, input) {
  need(typeof path === 'string' && path.startsWith('/backup-io/'));
  const operation = path.slice('/backup-io/'.length), outer = copy(input); exact(outer, ['body', 'proof']);
  const body = validateBackupIOBody(operation, outer.body), proof = validateBackupIOProof(decoded(outer.proof, 'centuarai-local-backup-io+jws').payload);
  need(proof.operation === operation && proof.bodySha256 === ledgerDigest(body));
  const encoded = Buffer.from(canonicalLedger(outer)); need(encoded.length <= (operation === 'source.append' ? 1420000 : 32768));
  return { encoded, operation, request: proof, responseLimit: operation === 'archive.read' ? 1420000 : 32768 };
}
export function restoreKeyRequestSpec(input) {
  const body = copy(input); exact(body, ['operationId', 'archiveSha256', 'dataKey', 'proof']);
  bytes(body.operationId); bytes(body.archiveSha256); const key = bytes(body.dataKey);
  const payload = validateRestoreKeyProof(decoded(body.proof, 'centuarai-local-restore-key+jws').payload);
  try { need(payload.operationId === body.operationId && payload.archiveSha256 === body.archiveSha256
    && payload.dataKeySha256 === createHash('sha256').update(key).digest('base64url')); }
  finally { key.fill(0); }
  const encoded = Buffer.from(canonicalLedger(body)); need(encoded.length <= 32768);
  return { kind: 'restore-key-received', encoded };
}

export function validateBackupHeader(input) {
  const value = copy(input); exact(value, ['schemaVersion', 'format', 'backupId', 'sourceBoxId', 'sourceBoxKeyThumbprint', 'sourceOwnershipEpoch',
    'principalId', 'principalSecurityVersion', 'recoveryId', 'recoveryVersion', 'sourceRecoverySigningKey', 'recipientKeyThumbprint', 'createdAt',
    'scopeProfile', 'scopeDigest', 'wrapAlgorithm', 'wrappedDataKey', 'cipher', 'noncePrefix', 'chunkSize', 'chunkCount', 'plaintextBytes', 'manifestBytes', 'manifestSha256']);
  need(Buffer.byteLength(canonicalLedger(value)) <= 16384);
  need(value.schemaVersion === 1 && value.format === 'centuarai-business-backup-v1' && value.wrapAlgorithm === 'RSA-OAEP-256' && value.cipher === 'A256GCM'
    && value.chunkSize === BACKUP_CHUNK_BYTES);
  ['backupId', 'sourceBoxKeyThumbprint', 'recoveryId', 'recipientKeyThumbprint', 'scopeDigest', 'manifestSha256'].forEach(name => bytes(value[name]));
  ['sourceBoxId', 'principalId', 'scopeProfile'].forEach(name => token(value[name]));
  ['sourceOwnershipEpoch', 'principalSecurityVersion', 'recoveryVersion', 'createdAt', 'chunkCount', 'plaintextBytes', 'manifestBytes'].forEach(name => integer(value[name]));
  need(value.plaintextBytes <= 1024 ** 4 && value.manifestBytes <= 16 * 1024 * 1024 && value.manifestBytes <= value.plaintextBytes
    && value.chunkCount === Math.ceil(value.plaintextBytes / value.chunkSize));
  bytes(value.wrappedDataKey, 384); bytes(value.noncePrefix, 4); publicKeyThumbprint(value.sourceRecoverySigningKey); return value;
}
export function verifyBackupSourceProof(proof, descriptor, header) {
  need(typeof proof === 'string' && proof.length <= 8192);
  header = validateBackupHeader(header); descriptor = validateDescriptor(descriptor);
  const result = verifyFixed(proof, descriptor.boxKey, 'centuarai-business-backup+jws', input => {
    const value = copy(input); exact(value, ['schemaVersion', 'purpose', 'boxId', 'boxKeyThumbprint', 'backupId', 'headerSha256', 'ciphertextSha256',
      'ciphertextBytes', 'manifestSha256', 'scopeDigest', 'createdAt']);
    need(value.schemaVersion === 1 && value.purpose === 'centuarai.business-backup'); token(value.boxId);
    ['boxKeyThumbprint', 'backupId', 'headerSha256', 'ciphertextSha256', 'manifestSha256', 'scopeDigest'].forEach(name => bytes(value[name]));
    integer(value.ciphertextBytes); integer(value.createdAt); return value;
  });
  need(result.boxId === descriptor.boxId && result.boxKeyThumbprint === publicKeyThumbprint(descriptor.boxKey)
    && header.sourceBoxId === result.boxId && header.sourceBoxKeyThumbprint === result.boxKeyThumbprint
    && result.headerSha256 === ledgerDigest(header) && result.backupId === header.backupId && result.createdAt === header.createdAt
    && result.manifestSha256 === header.manifestSha256 && result.scopeDigest === header.scopeDigest, 'LOCAL_BACKUP_SOURCE_CHANGED');
  return result;
}
export function validateTransferPlan(input) {
  const value = copy(input);
  exact(value, ['type', 'scopeManifestDigest', 'resetPlanDigest', 'dataDisposition', 'retainedIndependentBackups', 'scope']);
  need(value.type === 'ownership-transfer-plan' && value.dataDisposition === 'erase-local' && value.retainedIndependentBackups === true);
  bytes(value.scopeManifestDigest); bytes(value.resetPlanDigest);
  exact(value.scope, ['resourceRoots', 'cacheRoots', 'preservedSecurityRoots', 'affectedPrincipals', 'affectedBindings', 'retainedExternalBackups']);
  integer(value.scope.affectedPrincipals, 0); integer(value.scope.affectedBindings, 0); need(value.scope.retainedExternalBackups === true);
  let count = 0;
  for (const name of ['resourceRoots', 'cacheRoots', 'preservedSecurityRoots']) {
    const roots = value.scope[name]; need(Array.isArray(roots) && roots.length > 0);
    count += roots.length;
    for (let i = 0; i < roots.length; i++) {
      const path = roots[i];
      need(typeof path === 'string' && path.length <= 256 && /^[\x21-\x7e]+$/.test(path) && path.startsWith('/')
        && !path.includes('\\') && path.slice(1).split('/').every(part => part && part !== '.' && part !== '..')
        && (i === 0 || roots[i - 1] < path));
    }
  }
  need(count <= 64);
  need(value.scopeManifestDigest === ledgerDigest({ purpose: 'centuarai.local-ledger.transfer-scope',
    resetPlanDigest: value.resetPlanDigest, scope: value.scope }), 'LOCAL_TRANSFER_SCOPE_CHANGED');
  return value;
}
function resultBody(operation, input) {
  const body = copy(input);
  if (operation === 'transfer.plan') return validateTransferPlan(body);
  if (operation === 'targets.list') {
    exact(body, ['type', 'targets']); need(body.type === 'backup-targets' && Array.isArray(body.targets) && body.targets.length <= 16);
    for (const target of body.targets) {
      exact(target, ['targetId', 'kind', 'durability', 'scopeProfiles', 'resourceIds', 'maxArchiveBytes']);
      need(target.targetId === 'local-managed' && target.kind === 'local-managed' && target.durability === 'same-box'
        && Array.isArray(target.scopeProfiles) && target.scopeProfiles.length > 0 && target.scopeProfiles.length <= 2
        && target.scopeProfiles.every((profile, index) => Object.hasOwn(BACKUP_PROFILES, profile)
          && (index === 0 || target.scopeProfiles[index - 1] < profile))
        && canonicalLedger(target.resourceIds) === canonicalLedger([...new Set(target.scopeProfiles.flatMap(profile => BACKUP_PROFILES[profile]))].sort())
        && target.maxArchiveBytes === BACKUP_MAX_BYTES);
    }
    need(new Set(body.targets.map(value => value.targetId)).size === body.targets.length);
  } else if (operation === 'source.begin') {
    exact(body, ['type', 'uploadId', 'offset', 'chunkMaxBytes', 'archiveMaxBytes', 'expiresAt']);
    need(body.type === 'backup-source-upload' && body.offset === 0 && body.chunkMaxBytes === BACKUP_CHUNK_BYTES && body.archiveMaxBytes === BACKUP_MAX_BYTES);
    token(body.uploadId); integer(body.expiresAt);
  } else if (operation === 'source.append') {
    exact(body, ['type', 'uploadId', 'offset', 'expiresAt']); need(body.type === 'backup-source-upload-progress');
    token(body.uploadId); integer(body.offset, 1, BACKUP_MAX_BYTES); integer(body.expiresAt);
  } else if (['source.finalize', 'source.read'].includes(operation)) {
    exact(body, ['type', 'sourceId', 'archiveBytes', 'archiveSha256', 'source', 'header', 'sourceProof', 'expiresAt']);
    need(body.type === 'backup-source'); token(body.sourceId); integer(body.archiveBytes, 1, BACKUP_MAX_BYTES); bytes(body.archiveSha256); integer(body.expiresAt);
    validateDescriptor(body.source); validateBackupHeader(body.header); verifyBackupSourceProof(body.sourceProof, body.source, body.header);
  } else if (operation === 'archive.read') {
    exact(body, ['type', 'operationId', 'backupId', 'archiveSha256', 'offset', 'length', 'totalBytes', 'contentSha256', 'eof']);
    need(body.type === 'backup-archive-range'); ['operationId', 'backupId', 'archiveSha256', 'contentSha256'].forEach(name => bytes(body[name]));
    integer(body.offset, 0, BACKUP_MAX_BYTES); integer(body.length, 1, BACKUP_CHUNK_BYTES); integer(body.totalBytes, 1, BACKUP_MAX_BYTES); boolean(body.eof);
    need(body.offset + body.length <= body.totalBytes && body.eof === (body.offset + body.length === body.totalBytes));
  } else throw new BackupProtocolError();
  return body;
}
export function validateBackupIOResponse(input) {
  const value = copy(input); exact(value, ['schemaVersion', 'purpose', 'boxId', 'boxKeyThumbprint', 'operation', 'nonce', 'requestBodySha256', 'issuedAt', 'body']);
  need(value.schemaVersion === 1 && value.purpose === 'centuarai.local-backup.io-response'); token(value.boxId); bytes(value.boxKeyThumbprint);
  need(BACKUP_IO_OPERATIONS.includes(value.operation)); bytes(value.nonce); bytes(value.requestBodySha256); integer(value.issuedAt); resultBody(value.operation, value.body); return value;
}
export const signBackupIOResponse = (payload, key) => signFixed(payload, key, 'centuarai-local-backup-io-response+jws', validateBackupIOResponse);
export function verifyBackupIOResponse(text, { descriptor, request, now }) {
  need(typeof text === 'string' && Buffer.byteLength(text) <= (request.operation === 'archive.read' ? 1420000 : 32768));
  let outer; try { outer = JSON.parse(text); } catch { throw new BackupProtocolError(); }
  // HTTP JSON need not sort its two keys. Reject duplicates/alternate encodings
  // while signed receipt payloads remain canonical ASCII JSON.
  need(JSON.stringify(outer) === text.replace(/[\x20\t\r\n]/g, '')); exact(outer, ['receipt', 'contentBase64']);
  const pinned = validateDescriptor(descriptor), response = verifyFixed(outer.receipt, pinned.boxKey, 'centuarai-local-backup-io-response+jws', validateBackupIOResponse);
  need(response.boxId === pinned.boxId && response.boxKeyThumbprint === publicKeyThumbprint(pinned.boxKey) && response.operation === request.operation
    && response.nonce === request.nonce && response.requestBodySha256 === request.bodySha256, 'LOCAL_BACKUP_RESPONSE_CHANGED');
  integer(now); need(response.issuedAt >= request.issuedAt && response.issuedAt <= now + 5 && now - response.issuedAt <= 60, 'LOCAL_BACKUP_EXPIRED');
  let content = null;
  if (request.operation === 'archive.read') {
    content = bytes(outer.contentBase64, response.body.length, true);
    need(createHash('sha256').update(content).digest('base64url') === response.body.contentSha256, 'LOCAL_BACKUP_CONTENT_CHANGED');
  } else need(outer.contentBase64 === null);
  return { ...response, content, receipt: outer.receipt };
}

export function backupRecipientThumbprint(key) { return ledgerDigest(validateBackupPublicKey(key)); }
