import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from 'node:crypto';

// Offline signature evidence only. This module does not establish a trusted root,
// attest to native user verification, or create an authorization grant.
const PREFIX = 'LOCAL_BINDING_';
const MAX_JWS_BYTES = 16384;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CONTEXT_FIELDS = [
  'boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'rosterVersion', 'rosterDigest', 'policyVersion',
];
const REQUEST_FIELDS = [
  ...CONTEXT_FIELDS, 'schemaVersion', 'purpose', 'requestId', 'challenge', 'issuedAt',
  'expiresAt', 'principalId', 'clientId', 'accessKey', 'approvalKey', 'role', 'grants',
  'delegationAllowed', 'grantExpiresAt',
];
const APPROVAL_FIELDS = [
  'schemaVersion', 'purpose', 'requestDigest', 'approverBindingId', 'approvalKeyVersion',
  'approvedAt', 'expiresAt',
];
const CANCEL_FIELDS = [
  'schemaVersion', 'purpose', 'requestId', 'requestDigest', 'issuedAt', 'expiresAt',
];
const BINDING_FIELDS = [
  'bindingId', 'principalId', 'clientId', 'role', 'status', 'accessKey', 'approvalKey',
  'approvalKeyVersion', 'canApproveUseDevices', 'delegableGrants', 'expiresAt',
  'delegationExpiresAt', 'establishedAt', 'establishedVersion',
];

export class BindingProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BindingProtocolError';
    this.code = code;
  }
}

function requireCondition(condition, code = 'INVALID') {
  if (!condition) throw new BindingProtocolError(PREFIX + code);
}

function exactFields(value, fields) {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value));
  const prototype = Object.getPrototypeOf(value);
  requireCondition(prototype === Object.prototype || prototype === null);
  const keys = Reflect.ownKeys(value);
  requireCondition(keys.length === fields.length && fields.every((key) => keys.includes(key)));
  requireCondition(keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor.enumerable && Object.hasOwn(descriptor, 'value');
  }));
}

function positiveInteger(value) {
  requireCondition(Number.isSafeInteger(value) && value > 0);
}

function clockTime(now) {
  positiveInteger(now);
}

function token(value) {
  requireCondition(typeof value === 'string' && TOKEN.exec(value)?.[0] === value);
}

function base64url(value, length) {
  requireCondition(typeof value === 'string' && BASE64URL.test(value));
  const bytes = Buffer.from(value, 'base64url');
  requireCondition(bytes.toString('base64url') === value && (length === undefined || bytes.length === length));
  return bytes;
}

function digest(value) {
  base64url(value, 32);
}

function canonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    requireCondition(Number.isSafeInteger(value) && !Object.is(value, -0));
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    requireCondition(/^[\x00-\x7f]*$/.test(value));
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(',')}]`;
  requireCondition(value !== null && typeof value === 'object');
  const prototype = Object.getPrototypeOf(value);
  requireCondition(prototype === Object.prototype || prototype === null);
  return `{${Object.keys(value).sort().map((key) => `${canonical(key)}:${canonical(value[key])}`).join(',')}}`;
}

function publicKey(jwk) {
  exactFields(jwk, ['crv', 'kty', 'x', 'y']);
  requireCondition(jwk.crv === 'P-256' && jwk.kty === 'EC');
  base64url(jwk.x, 32);
  base64url(jwk.y, 32);
  try {
    return createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new BindingProtocolError(PREFIX + 'INVALID');
  }
}

export function publicKeyThumbprint(jwk) {
  publicKey(jwk);
  return createHash('sha256').update(canonical(jwk)).digest('base64url');
}

function grants(value, allowEmpty = false) {
  requireCondition(Array.isArray(value) && value.length >= (allowEmpty ? 0 : 1) && value.length <= 16);
  let previousResource = '';
  for (const grant of value) {
    exactFields(grant, ['resourceId', 'actions']);
    token(grant.resourceId);
    requireCondition(grant.resourceId > previousResource);
    previousResource = grant.resourceId;
    requireCondition(Array.isArray(grant.actions) && grant.actions.length >= 1 && grant.actions.length <= 3);
    let previousAction = '';
    for (const action of grant.actions) {
      requireCondition(['execute', 'read', 'write'].includes(action) && action > previousAction);
      previousAction = action;
    }
  }
}

function contextFields(value) {
  token(value.boxId);
  digest(value.boxKeyThumbprint);
  positiveInteger(value.ownershipEpoch);
  positiveInteger(value.rosterVersion);
  digest(value.rosterDigest);
  positiveInteger(value.policyVersion);
}

function lifetime(issuedAt, expiresAt) {
  positiveInteger(issuedAt);
  positiveInteger(expiresAt);
  requireCondition(issuedAt < expiresAt && expiresAt - issuedAt <= 300);
}

function nullableExpiry(value) {
  if (value !== null) positiveInteger(value);
}

function requestSchema(value) {
  exactFields(value, REQUEST_FIELDS);
  requireCondition(value.schemaVersion === 1 && value.purpose === 'centuarai.local-device-binding.request');
  contextFields(value);
  digest(value.requestId);
  digest(value.challenge);
  lifetime(value.issuedAt, value.expiresAt);
  token(value.principalId);
  token(value.clientId);
  publicKey(value.accessKey);
  requireCondition(value.approvalKey === null && value.role === 'use' && value.delegationAllowed === false);
  grants(value.grants);
  nullableExpiry(value.grantExpiresAt);
  requireCondition(value.grantExpiresAt === null || value.grantExpiresAt >= value.expiresAt);
}

export function canonicalRequest(value) {
  requestSchema(value);
  return Buffer.from(canonical(value), 'utf8');
}

export function requestDigest(value) {
  return createHash('sha256').update(canonicalRequest(value)).digest('base64url');
}

function approvalSchema(value) {
  exactFields(value, APPROVAL_FIELDS);
  requireCondition(value.schemaVersion === 1 && value.purpose === 'centuarai.local-device-binding.approval');
  digest(value.requestDigest);
  token(value.approverBindingId);
  positiveInteger(value.approvalKeyVersion);
  positiveInteger(value.approvedAt);
  positiveInteger(value.expiresAt);
  requireCondition(value.approvedAt < value.expiresAt);
}

function cancelSchema(value) {
  exactFields(value, CANCEL_FIELDS);
  requireCondition(value.schemaVersion === 1 && value.purpose === 'centuarai.local-device-binding.cancel');
  digest(value.requestId);
  digest(value.requestDigest);
  lifetime(value.issuedAt, value.expiresAt);
}

function header(type) {
  return { alg: 'ES256', typ: `centuarai-device-binding-${type}+jws` };
}

function signEvidence(payload, key, type, schema) {
  schema(payload);
  let privateKey;
  try {
    privateKey = key instanceof KeyObject ? key : createPrivateKey(key);
  } catch {
    throw new BindingProtocolError(PREFIX + 'INVALID');
  }
  requireCondition(privateKey.type === 'private' && privateKey.asymmetricKeyType === 'ec'
    && privateKey.asymmetricKeyDetails?.namedCurve === 'prime256v1');
  if (type === 'request') {
    const signingPublicKey = createPublicKey(privateKey).export({ format: 'jwk' });
    requireCondition(publicKeyThumbprint(signingPublicKey) === publicKeyThumbprint(payload.accessKey));
  }
  const encodedHeader = Buffer.from(canonical(header(type))).toString('base64url');
  const encodedPayload = Buffer.from(canonical(payload)).toString('base64url');
  const input = `${encodedHeader}.${encodedPayload}`;
  requireCondition(input.length + 1 + 86 <= MAX_JWS_BYTES);
  const signature = sign('sha256', Buffer.from(input, 'ascii'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

function parseCanonical(encoded) {
  const bytes = base64url(encoded);
  requireCondition(bytes.every((byte) => byte <= 0x7f));
  let value;
  try {
    value = JSON.parse(bytes.toString('ascii'));
    requireCondition(canonical(value) === bytes.toString('ascii'));
  } catch {
    throw new BindingProtocolError(PREFIX + 'INVALID');
  }
  return value;
}

function parseEvidence(jws, type, schema) {
  requireCondition(typeof jws === 'string' && jws.length <= MAX_JWS_BYTES && /^[\x00-\x7f]+$/.test(jws));
  const parts = jws.split('.');
  requireCondition(parts.length === 3);
  const protectedHeader = parseCanonical(parts[0]);
  exactFields(protectedHeader, ['alg', 'typ']);
  requireCondition(protectedHeader.alg === 'ES256' && protectedHeader.typ === header(type).typ);
  const payload = parseCanonical(parts[1]);
  schema(payload);
  const signature = base64url(parts[2], 64);
  return { payload, signature, signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii') };
}

function verifyEvidence(evidence, jwk) {
  const key = publicKey(jwk);
  requireCondition(verify('sha256', evidence.signingInput,
    { key, dsaEncoding: 'ieee-p1363' }, evidence.signature), 'SIGNATURE_INVALID');
}

export function signRequest(request, key) {
  return signEvidence(request, key, 'request', requestSchema);
}

export function verifyRequestProof(jws) {
  const evidence = parseEvidence(jws, 'request', requestSchema);
  verifyEvidence(evidence, evidence.payload.accessKey);
  return evidence.payload;
}

function requestFreshness(request, now) {
  clockTime(now);
  requireCondition(request.issuedAt <= now && now < request.expiresAt, 'EXPIRED');
}

function matchesContext(request, context, fields) {
  requireCondition(fields.every((field) => request[field] === context[field]), 'CONTEXT_MISMATCH');
}

export function validateRequestContext(request, context, now) {
  requestSchema(request);
  exactFields(context, [...CONTEXT_FIELDS, 'challenge']);
  contextFields(context);
  digest(context.challenge);
  requestFreshness(request, now);
  matchesContext(request, context, [...CONTEXT_FIELDS, 'challenge']);
}

function trustedStateSchema(state) {
  exactFields(state, [...CONTEXT_FIELDS, 'bindings']);
  contextFields(state);
  requireCondition(Array.isArray(state.bindings));
  const bindingIds = new Set();
  const clientIds = new Set();
  const keyThumbprints = new Set();
  for (const binding of state.bindings) {
    exactFields(binding, BINDING_FIELDS);
    for (const field of ['bindingId', 'principalId', 'clientId']) token(binding[field]);
    requireCondition(['manage', 'use'].includes(binding.role));
    requireCondition(['active', 'suspended', 'revoked'].includes(binding.status));
    requireCondition(typeof binding.canApproveUseDevices === 'boolean');
    grants(binding.delegableGrants, true);
    nullableExpiry(binding.expiresAt);
    nullableExpiry(binding.delegationExpiresAt);
    positiveInteger(binding.establishedAt);
    positiveInteger(binding.establishedVersion);
    requireCondition(!bindingIds.has(binding.bindingId) && !clientIds.has(binding.clientId));
    bindingIds.add(binding.bindingId);
    clientIds.add(binding.clientId);
    const keys = [binding.accessKey];
    if (binding.approvalKey === null) {
      requireCondition(binding.approvalKeyVersion === null);
    } else {
      positiveInteger(binding.approvalKeyVersion);
      keys.push(binding.approvalKey);
    }
    // Include revoked history and both key purposes; never select a conflicting
    // active row as authority while silently ignoring a revoked row.
    for (const key of keys) {
      const thumbprint = publicKeyThumbprint(key);
      requireCondition(!keyThumbprints.has(thumbprint));
      keyThumbprints.add(thumbprint);
    }
  }
  return { clientIds, keyThumbprints };
}

export function signApproval(payload, key) {
  return signEvidence(payload, key, 'approval', approvalSchema);
}

export function verifyApprovalSignature(approvalJws, requestJws, trustedState, now) {
  const request = verifyRequestProof(requestJws);
  const evidence = parseEvidence(approvalJws, 'approval', approvalSchema);
  const approval = evidence.payload;
  const history = trustedStateSchema(trustedState);
  requestFreshness(request, now);
  matchesContext(request, trustedState, CONTEXT_FIELDS);
  requireCondition(approval.requestDigest === requestDigest(request), 'CONTEXT_MISMATCH');
  requireCondition(request.issuedAt <= approval.approvedAt && approval.approvedAt <= now
    && now < approval.expiresAt && approval.expiresAt <= request.expiresAt, 'EXPIRED');
  requireCondition(!history.clientIds.has(request.clientId), 'CLIENT_REUSE');
  requireCondition(!history.keyThumbprints.has(publicKeyThumbprint(request.accessKey)), 'KEY_REUSE');
  const approver = trustedState.bindings.find((binding) => binding.bindingId === approval.approverBindingId);
  requireCondition(approver !== undefined && approver.status === 'active' && approver.role === 'manage'
    && approver.canApproveUseDevices && approver.principalId === request.principalId
    && approver.approvalKey !== null && approver.approvalKeyVersion === approval.approvalKeyVersion
    && approver.establishedAt <= request.issuedAt && approver.establishedVersion <= request.rosterVersion,
  'APPROVAL_FORBIDDEN');
  verifyEvidence(evidence, approver.approvalKey);
  for (const limit of [approver.expiresAt, approver.delegationExpiresAt]) {
    requireCondition(limit === null || now < limit, 'EXPIRED');
    requireCondition(limit === null || (request.grantExpiresAt !== null && request.grantExpiresAt <= limit),
      'LIFETIME_EXCEEDED');
  }
  const authority = new Map(approver.delegableGrants.map((grant) => [grant.resourceId, new Set(grant.actions)]));
  requireCondition(request.grants.every((grant) => grant.actions.every((action) => authority.get(grant.resourceId)?.has(action))),
    'SCOPE_EXCEEDED');
  return approval;
}

export function signCancel(payload, key) {
  return signEvidence(payload, key, 'cancel', cancelSchema);
}

// Unverified lookup material only; the caller must locate the saved request and
// then call verifyCancelProof before changing even a pending journal entry.
export function decodeCancelPayload(jws) {
  return parseEvidence(jws, 'cancel', cancelSchema).payload;
}

export function verifyCancelProof(cancelJws, request, now) {
  requestSchema(request);
  const evidence = parseEvidence(cancelJws, 'cancel', cancelSchema);
  const cancellation = evidence.payload;
  clockTime(now);
  requireCondition(cancellation.issuedAt <= now && now < cancellation.expiresAt, 'EXPIRED');
  requireCondition(cancellation.requestId === request.requestId
    && cancellation.requestDigest === requestDigest(request), 'CONTEXT_MISMATCH');
  verifyEvidence(evidence, request.accessKey);
  return cancellation;
}
