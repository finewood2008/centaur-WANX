import {
  createHash, createHmac, createPrivateKey, createPublicKey, KeyObject, sign, verify,
} from 'node:crypto';
import { publicKeyThumbprint, requestDigest, verifyRequestProof } from './binding-contract.mjs';

const MAX_PACKET = 8192;
const MAX_RESPONSE = 262144;
const CONTEXT = ['boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'rosterVersion', 'rosterDigest', 'policyVersion'];
const DESCRIPTOR = ['boxId', 'baseUrl', 'boxKey', 'tlsSpkiSha256'];
const STATES = ['pending', 'cancelled', 'expired', 'approved'];
const ACK = ['requestId', 'requestDigest', 'bindingId', 'principalId', 'clientId', 'role',
  'accessKeyThumbprint', 'ownershipEpoch', 'rosterVersion', 'rosterDigest', 'policyVersion',
  'committedAt', 'recoveryConfigured'];

export class ManagementProtocolError extends Error {
  constructor(code = 'LOCAL_MANAGEMENT_INVALID') {
    super(code);
    this.name = 'ManagementProtocolError';
    this.code = code;
  }
}

function requireThat(condition, code) {
  if (!condition) throw new ManagementProtocolError(code);
}

function record(value) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  requireThat(Reflect.ownKeys(value).every((key) => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && d.enumerable && Object.hasOwn(d, 'value');
  }));
}

function exact(value, fields) {
  record(value);
  requireThat(Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)));
}

function canonical(value, depth = 0) {
  requireThat(depth <= 32);
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    requireThat(Number.isSafeInteger(value) && !Object.is(value, -0));
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    requireThat(/^[\x00-\x7f]*$/.test(value));
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    requireThat(Reflect.ownKeys(value).length === value.length + 1);
    return `[${Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      requireThat(d && Object.hasOwn(d, 'value'));
      return canonical(d.value, depth + 1);
    }).join(',')}]`;
  }
  record(value);
  return `{${Object.keys(value).sort().map((key) => `${canonical(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
}

function frozen(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

function copy(value) { return frozen(JSON.parse(canonical(value))); }
function integer(value) { requireThat(Number.isSafeInteger(value) && value > 0); }
function token(value) { requireThat(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.exec(value)?.[0] === value); }
function bytes(value, length = 32) {
  requireThat(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value));
  const result = Buffer.from(value, 'base64url');
  requireThat(result.toString('base64url') === value && (length === null || result.length === length));
  return result;
}
function key(jwk) {
  // Reuse evidence-v1's exact JWK / on-curve / private-field rejection.
  publicKeyThumbprint(jwk);
  return createPublicKey({ key: jwk, format: 'jwk' });
}
function expiry(value) { if (value !== null) integer(value); }
function lifetime(issuedAt, expiresAt, maximum = 300) {
  integer(issuedAt); integer(expiresAt);
  requireThat(issuedAt < expiresAt && expiresAt - issuedAt <= maximum);
}
function live(issuedAt, expiresAt, now) {
  requireThat(issuedAt <= now && now < expiresAt, 'LOCAL_MANAGEMENT_EXPIRED');
}
function grants(value, empty = false) {
  requireThat(Array.isArray(value) && value.length >= (empty ? 0 : 1) && value.length <= 16);
  let previous = '';
  for (const grant of value) {
    exact(grant, ['resourceId', 'actions']); token(grant.resourceId);
    requireThat(grant.resourceId > previous); previous = grant.resourceId;
    requireThat(Array.isArray(grant.actions) && grant.actions.length > 0 && grant.actions.length <= 3);
    let actionBefore = '';
    for (const action of grant.actions) {
      requireThat(['execute', 'read', 'write'].includes(action) && action > actionBefore); actionBefore = action;
    }
  }
}
function context(value) {
  exact(value, CONTEXT); token(value.boxId); bytes(value.boxKeyThumbprint); bytes(value.rosterDigest);
  for (const name of ['ownershipEpoch', 'rosterVersion', 'policyVersion']) integer(value[name]);
}

export function validateDescriptor(value) {
  exact(value, DESCRIPTOR); token(value.boxId); key(value.boxKey); bytes(value.tlsSpkiSha256);
  requireThat(typeof value.baseUrl === 'string' && value.baseUrl.length <= 2048
    && /^[\x21-\x7e]+$/.test(value.baseUrl), 'LOCAL_MANAGEMENT_URL_INVALID');
  let url;
  try { url = new URL(value.baseUrl); } catch { throw new ManagementProtocolError('LOCAL_MANAGEMENT_URL_INVALID'); }
  requireThat(url.protocol === 'https:' && url.hostname && !url.username && !url.password
    && !url.search && !url.hash && !/[?#\\]/.test(value.baseUrl) && url.pathname === '/'
    && [url.origin, `${url.origin}/`].includes(value.baseUrl), 'LOCAL_MANAGEMENT_URL_INVALID');
  return copy({ ...value, baseUrl: url.origin });
}

// Imports allow ordinary JSON formatting, but reject duplicate keys and alternate
// number/string spellings. JWS segments additionally require sorted canonical JSON.
function parseImport(text) {
  requireThat(typeof text === 'string' && Buffer.byteLength(text) <= MAX_PACKET && /^[\x00-\x7f]*$/.test(text));
  let value;
  try { value = JSON.parse(text); } catch { throw new ManagementProtocolError(); }
  let compact = '', inString = false, escaped = false;
  for (const character of text) {
    if (inString || !/[\x20\t\r\n]/.test(character)) compact += character;
    if (inString && escaped) escaped = false;
    else if (inString && character === '\\') escaped = true;
    else if (character === '"') inString = !inString;
  }
  requireThat(JSON.stringify(value) === compact);
  canonical(value);
  return value;
}

export function parseDeliveryPacket(text) {
  const value = parseImport(text);
  exact(value, ['schemaVersion', 'type', ...DESCRIPTOR, 'provisioningId', 'ownershipEpoch', 'claimSecret']);
  requireThat(value.schemaVersion === 1 && value.type === 'centuarai-local-trust-delivery');
  const descriptor = validateDescriptor(Object.fromEntries(DESCRIPTOR.map((name) => [name, value[name]])));
  bytes(value.provisioningId); bytes(value.claimSecret); integer(value.ownershipEpoch);
  return copy({ ...value, ...descriptor });
}

export function parseJoinInfo(text) {
  const value = parseImport(text);
  exact(value, ['schemaVersion', 'type', 'descriptor', 'principalId', 'grants', 'grantExpiresAt']);
  requireThat(value.schemaVersion === 1 && value.type === 'centuarai-local-trust-join');
  token(value.principalId); grants(value.grants); expiry(value.grantExpiresAt);
  return copy({ ...value, descriptor: validateDescriptor(value.descriptor) });
}

export function parseInvitation(text) {
  const value = parseImport(text);
  exact(value, ['schemaVersion', 'type', 'descriptor', 'requestId', 'requestDigest']);
  requireThat(value.schemaVersion === 1 && value.type === 'centuarai-local-trust-invitation');
  bytes(value.requestId); bytes(value.requestDigest);
  return copy({ ...value, descriptor: validateDescriptor(value.descriptor) });
}

export function validateFirstRootPayload(value) {
  exact(value, ['schemaVersion', 'purpose', 'boxId', 'boxKeyThumbprint', 'provisioningId',
    'ownershipEpoch', 'challenge', 'requestId', 'issuedAt', 'expiresAt', 'principalId',
    'clientId', 'accessKey', 'approvalKey', 'grants', 'grantExpiresAt', 'keyProtection']);
  requireThat(value.schemaVersion === 1 && value.purpose === 'centuarai.local-management.first-root'
    && value.keyProtection === 'software-passphrase-v1' && value.grantExpiresAt === null);
  for (const name of ['boxId', 'principalId', 'clientId']) token(value[name]);
  for (const name of ['boxKeyThumbprint', 'provisioningId', 'challenge', 'requestId']) bytes(value[name]);
  integer(value.ownershipEpoch); lifetime(value.issuedAt, value.expiresAt); grants(value.grants);
  key(value.accessKey); key(value.approvalKey);
  requireThat(publicKeyThumbprint(value.accessKey) !== publicKeyThumbprint(value.approvalKey));
  return copy(value);
}

export function firstRootDigest(payload) {
  return createHash('sha256').update(canonical(validateFirstRootPayload(payload))).digest('base64url');
}

export function validateReadPayload(value) {
  exact(value, ['schemaVersion', 'purpose', 'boxId', 'boxKeyThumbprint', 'ownershipEpoch',
    'nonce', 'issuedAt', 'expiresAt', 'clientId', 'operation', 'requestId']);
  requireThat(value.schemaVersion === 1 && value.purpose === 'centuarai.local-management.read');
  token(value.boxId); token(value.clientId); bytes(value.boxKeyThumbprint); bytes(value.nonce);
  integer(value.ownershipEpoch); lifetime(value.issuedAt, value.expiresAt, 60);
  requireThat(['state', 'request'].includes(value.operation));
  if (value.operation === 'state') requireThat(value.requestId === null);
  else bytes(value.requestId);
  return copy(value);
}

function privateKey(value) {
  let result;
  try { result = value instanceof KeyObject ? value : createPrivateKey(value); }
  catch { throw new ManagementProtocolError(); }
  requireThat(result.type === 'private' && result.asymmetricKeyType === 'ec'
    && result.asymmetricKeyDetails?.namedCurve === 'prime256v1');
  return result;
}
function signingInput(payload, typ, alg = 'ES256') {
  const input = `${Buffer.from(canonical({ alg, typ })).toString('base64url')}.${Buffer.from(canonical(payload)).toString('base64url')}`;
  requireThat(input.length + 87 <= 16384);
  return input;
}
function asymmetricProof(payload, typ, signingKey) {
  const input = signingInput(payload, typ);
  return `${input}.${sign('sha256', Buffer.from(input, 'ascii'), { key: signingKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

export function signFirstRoot(payload, { accessPrivateKey, approvalPrivateKey, claimSecret }) {
  const value = validateFirstRootPayload(payload);
  const access = privateKey(accessPrivateKey), approval = privateKey(approvalPrivateKey);
  requireThat(publicKeyThumbprint(createPublicKey(access).export({ format: 'jwk' })) === publicKeyThumbprint(value.accessKey)
    && publicKeyThumbprint(createPublicKey(approval).export({ format: 'jwk' })) === publicKeyThumbprint(value.approvalKey),
  'LOCAL_MANAGEMENT_KEY_MISMATCH');
  const secret = bytes(claimSecret), secretKey = createHash('sha256').update(secret).digest();
  try {
    const input = signingInput(value, 'centuarai-first-root-secret+jws', 'HS256');
    return Object.freeze({
      accessProof: asymmetricProof(value, 'centuarai-first-root-access+jws', access),
      approvalProof: asymmetricProof(value, 'centuarai-first-root-approval+jws', approval),
      secretProof: `${input}.${createHmac('sha256', secretKey).update(input, 'ascii').digest('base64url')}`,
    });
  } finally { secret.fill(0); secretKey.fill(0); }
}

export function signRead(payload, accessPrivateKey) {
  return asymmetricProof(validateReadPayload(payload), 'centuarai-local-management-read+jws', privateKey(accessPrivateKey));
}

function parseSegment(segment) {
  const raw = bytes(segment, null);
  requireThat(raw.every((byte) => byte <= 127));
  let value;
  try { value = JSON.parse(raw.toString('ascii')); } catch { throw new ManagementProtocolError(); }
  requireThat(canonical(value) === raw.toString('ascii'));
  return value;
}

function bindings(value, ctx) {
  requireThat(Array.isArray(value) && value.length <= 1024);
  const ids = new Set(), clients = new Set(), keys = new Set();
  for (const binding of value) {
    exact(binding, ['bindingId', 'principalId', 'clientId', 'role', 'status', 'accessKey', 'approvalKey',
      'approvalKeyVersion', 'canApproveUseDevices', 'delegableGrants', 'expiresAt',
      'delegationExpiresAt', 'establishedAt', 'establishedVersion']);
    for (const name of ['bindingId', 'principalId', 'clientId']) token(binding[name]);
    requireThat(!ids.has(binding.bindingId) && !clients.has(binding.clientId));
    ids.add(binding.bindingId); clients.add(binding.clientId);
    requireThat(['manage', 'use'].includes(binding.role) && ['active', 'suspended', 'revoked'].includes(binding.status)
      && typeof binding.canApproveUseDevices === 'boolean');
    grants(binding.delegableGrants, true); expiry(binding.expiresAt); expiry(binding.delegationExpiresAt);
    integer(binding.establishedAt); integer(binding.establishedVersion);
    requireThat(binding.establishedVersion <= ctx.rosterVersion);
    const purposeKeys = [binding.accessKey];
    if (binding.approvalKey === null) requireThat(binding.approvalKeyVersion === null && !binding.canApproveUseDevices);
    else { integer(binding.approvalKeyVersion); purposeKeys.push(binding.approvalKey); }
    if (binding.role === 'use') requireThat(binding.approvalKey === null && !binding.canApproveUseDevices
      && binding.delegableGrants.length === 0 && binding.delegationExpiresAt === null);
    for (const jwk of purposeKeys) {
      const thumbprint = publicKeyThumbprint(jwk); requireThat(!keys.has(thumbprint)); keys.add(thumbprint);
    }
  }
  // The authority hashes its full, ordered roster including revoked key history.
  // A valid box signature alone must not conceal a mismatched checkpoint/body.
  requireThat(createHash('sha256').update(canonical(value)).digest('base64url') === ctx.rosterDigest,
    'LOCAL_MANAGEMENT_CONTEXT_MISMATCH');
}

function matchExpected(body, expected) {
  record(expected);
  for (const field of Object.keys(expected)) {
    requireThat(Object.hasOwn(body, field) && canonical(body[field]) === canonical(expected[field]),
      'LOCAL_MANAGEMENT_CONTEXT_MISMATCH');
  }
}

function ackBody(body) {
  exact(body, ACK);
  for (const name of ['requestId', 'requestDigest', 'accessKeyThumbprint', 'rosterDigest']) bytes(body[name]);
  for (const name of ['bindingId', 'principalId', 'clientId']) token(body[name]);
  for (const name of ['ownershipEpoch', 'rosterVersion', 'policyVersion', 'committedAt']) integer(body[name]);
  requireThat(['manage', 'use'].includes(body.role) && typeof body.recoveryConfigured === 'boolean');
}

function responseBody(body, kind, descriptor, now, issuedAt) {
  if (kind === 'first-root-challenge') {
    exact(body, ['provisioningId', 'ownershipEpoch', 'challenge', 'issuedAt', 'expiresAt', 'grants']);
    bytes(body.provisioningId); bytes(body.challenge); integer(body.ownershipEpoch); grants(body.grants);
    lifetime(body.issuedAt, body.expiresAt); live(body.issuedAt, body.expiresAt, now);
    requireThat(body.issuedAt === issuedAt);
  } else if (kind === 'auth-challenge') {
    exact(body, ['nonce', 'issuedAt', 'expiresAt', 'ownershipEpoch']);
    bytes(body.nonce); integer(body.ownershipEpoch); lifetime(body.issuedAt, body.expiresAt, 60);
    live(body.issuedAt, body.expiresAt, now); requireThat(body.issuedAt === issuedAt);
  } else if (kind === 'binding-challenge') {
    exact(body, ['context', 'challenge', 'issuedAt', 'expiresAt']);
    context(body.context); bytes(body.challenge); lifetime(body.issuedAt, body.expiresAt);
    live(body.issuedAt, body.expiresAt, now); requireThat(body.issuedAt === issuedAt);
  } else if (kind === 'state') {
    exact(body, ['context', 'bindings', 'recoveryConfigured']); context(body.context);
    bindings(body.bindings, body.context); requireThat(typeof body.recoveryConfigured === 'boolean');
  } else if (kind === 'request-receipt') {
    exact(body, ['requestId', 'requestDigest', 'state', 'expiresAt']);
    bytes(body.requestId); bytes(body.requestDigest); integer(body.expiresAt); requireThat(STATES.includes(body.state));
  } else if (kind === 'request') {
    exact(body, ['requestId', 'requestDigest', 'state', 'requestJws', 'ack']);
    bytes(body.requestId); bytes(body.requestDigest); requireThat(STATES.includes(body.state));
    const request = verifyRequestProof(body.requestJws);
    requireThat(request.boxId === descriptor.boxId && request.boxKeyThumbprint === publicKeyThumbprint(descriptor.boxKey)
      && request.requestId === body.requestId && requestDigest(request) === body.requestDigest,
    'LOCAL_MANAGEMENT_CONTEXT_MISMATCH');
    if (body.state === 'approved') {
      const ack = verifyResponse(body.ack, { descriptor, kind: 'binding-ack', now, expected: {
        requestId: request.requestId, requestDigest: body.requestDigest, principalId: request.principalId,
        clientId: request.clientId, role: request.role, accessKeyThumbprint: publicKeyThumbprint(request.accessKey),
        ownershipEpoch: request.ownershipEpoch, policyVersion: request.policyVersion,
      } }).body;
      requireThat(ack.rosterVersion > request.rosterVersion);
    } else requireThat(body.ack === null);
  } else if (kind === 'binding-ack') {
    ackBody(body); requireThat(body.committedAt <= issuedAt);
  } else throw new ManagementProtocolError('LOCAL_MANAGEMENT_KIND_INVALID');
  if (Object.hasOwn(body, 'context')) requireThat(body.context.boxId === descriptor.boxId
    && body.context.boxKeyThumbprint === publicKeyThumbprint(descriptor.boxKey), 'LOCAL_MANAGEMENT_CONTEXT_MISMATCH');
}

export function verifyResponse(jws, { descriptor, kind, now, expected = {} }) {
  const trusted = validateDescriptor(descriptor); integer(now);
  requireThat(typeof jws === 'string' && jws.length <= MAX_RESPONSE && /^[\x00-\x7f]+$/.test(jws));
  const parts = jws.split('.'); requireThat(parts.length === 3);
  const header = parseSegment(parts[0]); exact(header, ['alg', 'typ']);
  requireThat(header.alg === 'ES256' && header.typ === 'centuarai-local-management-response+jws');
  const payload = parseSegment(parts[1]);
  exact(payload, ['schemaVersion', 'purpose', 'boxId', 'boxKeyThumbprint', 'kind', 'issuedAt', 'body']);
  requireThat(payload.schemaVersion === 1 && payload.purpose === 'centuarai.local-management.response'
    && payload.kind === kind, 'LOCAL_MANAGEMENT_KIND_INVALID');
  requireThat(payload.boxId === trusted.boxId && payload.boxKeyThumbprint === publicKeyThumbprint(trusted.boxKey),
    'LOCAL_MANAGEMENT_CONTEXT_MISMATCH');
  integer(payload.issuedAt); requireThat(payload.issuedAt <= now, 'LOCAL_MANAGEMENT_EXPIRED');
  requireThat(verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
    { key: key(trusted.boxKey), dsaEncoding: 'ieee-p1363' }, bytes(parts[2], 64)), 'LOCAL_MANAGEMENT_SIGNATURE_INVALID');
  responseBody(payload.body, kind, trusted, now, payload.issuedAt);
  matchExpected(payload.body, expected);
  return frozen(payload);
}
