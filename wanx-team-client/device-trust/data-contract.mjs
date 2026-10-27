import { createHash, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { publicKeyThumbprint } from './binding-contract.mjs';
import { validateDescriptor } from './management-contract.mjs';

// A strict wire codec, deliberately without route decisions or an arbitrary signer.
export const DATA_HEADER_FIELDS = Object.freeze(['contentType', 'range', 'ifRange', 'ifMatch',
  'lastEventId', 'agentId', 'dataContext', 'idempotencyKey', 'webSocketKey',
  'webSocketProtocol', 'spaceLink', 'contentSha256']);
const IDENTITY = ['boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'principalId', 'bindingId', 'clientId'];
const CHANNEL = ['schemaVersion', 'purpose', 'boxId', 'sessionId', 'gatewayGeneration',
  'applicationId', 'launchId', 'jti', 'issuedAtMs', 'expiresAtMs'];
const REQUEST = [...CHANNEL, 'transport', 'method', 'rawTarget', 'headers', 'bodySha256', 'bodyBytes'];
const EMPTY = createHash('sha256').update('').digest('base64url');

export class DataProtocolError extends Error {
  constructor(code = 'LOCAL_DATA_INVALID') { super(code); this.name = 'DataProtocolError'; this.code = code; }
}
function need(condition, code) { if (!condition) throw new DataProtocolError(code); }
function record(value) {
  need(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  need(Reflect.ownKeys(value).every((name) => {
    const d = Object.getOwnPropertyDescriptor(value, name);
    return typeof name === 'string' && d.enumerable && Object.hasOwn(d, 'value');
  }));
}
function exact(value, names) {
  record(value); need(Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name)));
}
function canonical(value, depth = 0) {
  need(depth <= 32);
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { need(Number.isSafeInteger(value) && !Object.is(value, -0)); return JSON.stringify(value); }
  if (typeof value === 'string') { need(/^[\x00-\x7f]*$/.test(value)); return JSON.stringify(value); }
  if (Array.isArray(value)) {
    need(Reflect.ownKeys(value).length === value.length + 1);
    return `[${Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i)); need(d && Object.hasOwn(d, 'value'));
      return canonical(d.value, depth + 1);
    }).join(',')}]`;
  }
  record(value);
  return `{${Object.keys(value).sort().map((name) => `${canonical(name)}:${canonical(value[name], depth + 1)}`).join(',')}}`;
}
function frozen(value) {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function copy(value) { return frozen(JSON.parse(canonical(value))); }
function integer(value, zero = false) { need(Number.isSafeInteger(value) && !Object.is(value, -0) && value >= (zero ? 0 : 1)); }
function token(value) { need(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.exec(value)?.[0] === value); }
function bytes(value, length = 32) {
  need(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value));
  const result = Buffer.from(value, 'base64url');
  need(result.toString('base64url') === value && (length === null || result.length === length)); return result;
}
function publicKey(jwk) {
  try { publicKeyThumbprint(jwk); return createPublicKey({ key: jwk, format: 'jwk' }); }
  catch { throw new DataProtocolError(); }
}
function window(value, max) {
  integer(value.issuedAtMs); integer(value.expiresAtMs);
  need(value.issuedAtMs < value.expiresAtMs && value.expiresAtMs - value.issuedAtMs <= max);
}
function base(value, purpose) { need(value.schemaVersion === 1 && value.purpose === `centuarai.local-data.${purpose}`); }
function identity(value) {
  ['boxId', 'principalId', 'bindingId', 'clientId'].forEach((name) => token(value[name]));
  bytes(value.boxKeyThumbprint); integer(value.ownershipEpoch);
}
function channel(value, purpose) {
  base(value, purpose); token(value.boxId); token(value.applicationId);
  ['sessionId', 'gatewayGeneration', 'launchId', 'jti'].forEach((name) => bytes(value[name]));
}
function session(value) {
  exact(value, [...IDENTITY, 'schemaVersion', 'purpose', 'gatewayGeneration', 'challenge', 'requestId',
    'issuedAtMs', 'expiresAtMs', 'applicationId', 'launchId', 'channelKey']);
  base(value, 'session'); identity(value); window(value, 30000); token(value.applicationId); publicKey(value.channelKey);
  ['gatewayGeneration', 'challenge', 'requestId', 'launchId'].forEach((name) => bytes(value[name]));
}
function sessionIntent(value) {
  exact(value, ['schemaVersion', 'purpose', 'boxId', 'boxKeyThumbprint', 'bindingId', 'applicationId',
    'launchId', 'requestId', 'channelKey', 'jti', 'issuedAtMs', 'expiresAtMs']);
  base(value, 'session-intent'); window(value, 3000); publicKey(value.channelKey);
  ['boxId', 'bindingId', 'applicationId'].forEach((name) => token(value[name]));
  ['boxKeyThumbprint', 'launchId', 'requestId', 'jti'].forEach((name) => bytes(value[name]));
}
export function validateRawTarget(value) {
  need(typeof value === 'string' && /^[\x21-\x7e]{1,8192}$/.test(value) && value.startsWith('/')
    && !value.startsWith('//') && !/[#\\]/.test(value) && !/%(?![a-fA-F0-9]{2})/.test(value));
  const question = value.indexOf('?'); const path = question < 0 ? value : value.slice(0, question);
  try {
    const decoded = decodeURIComponent(path);
    need(!decoded.split('/').some((part) => ['.', '..'].includes(part)) && !decoded.includes('//')
      && !/[\\\x00-\x1f\x7f]/.test(decoded) && decodeURIComponent(decoded) === decoded);
    need(![...path.matchAll(/%([a-fA-F0-9]{2})/g)].some((match) => parseInt(match[1], 16) < 128));
    const query = question < 0 ? '' : value.slice(question + 1);
    for (const [name] of new URLSearchParams(query)) need(!['token', 'access_token', 'authorization', 'gateway_proof', 'data_proof'].includes(name.toLowerCase()));
  } catch (error) { if (error instanceof DataProtocolError) throw error; throw new DataProtocolError(); }
  return value;
}
export function validateDataHeaders(value) {
  exact(value, DATA_HEADER_FIELDS);
  need(Object.values(value).every((item) => item === null || typeof item === 'string' && /^[\x20-\x7e]{1,4096}$/.test(item)));
  need(Object.values(value).reduce((sum, item) => sum + (item?.length ?? 0), 0) <= 8192);
  need(value.dataContext === null || value.dataContext === 'personal' || /^team:(?:space|knowledge|agent):[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value.dataContext) || /^team:application:ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(value.dataContext));
  return copy(value);
}
function request(value) {
  exact(value, REQUEST); channel(value, 'request'); window(value, 10000);
  need(['http', 'websocket'].includes(value.transport) && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(value.method));
  validateRawTarget(value.rawTarget); validateDataHeaders(value.headers); bytes(value.bodySha256); integer(value.bodyBytes, true);
  if (value.transport === 'websocket') need(value.method === 'GET' && value.bodyBytes === 0 && value.bodySha256 === EMPTY && value.headers.webSocketKey !== null);
  else need(value.headers.webSocketKey === null && value.headers.webSocketProtocol === null);
}
function heartbeat(value) { exact(value, [...CHANNEL, 'sequence']); channel(value, 'heartbeat'); window(value, 3000); integer(value.sequence); }
function renewal(value) { exact(value, [...CHANNEL, 'requestId', 'channelKey']); channel(value, 'renewal'); window(value, 3000); bytes(value.requestId); publicKey(value.channelKey); }
function close(value) { exact(value, [...CHANNEL, 'reason']); channel(value, 'close'); window(value, 3000); need(['lock', 'user-close', 'app-exit', 'superseded'].includes(value.reason)); }
function grants(value) {
  need(Array.isArray(value) && value.length > 0 && value.length <= 16); let previous = '';
  for (const grant of value) {
    exact(grant, ['resourceId', 'actions']); token(grant.resourceId); need(grant.resourceId > previous); previous = grant.resourceId;
    need(Array.isArray(grant.actions) && grant.actions.length > 0 && grant.actions.length <= 3); let last = '';
    for (const action of grant.actions) { need(['execute', 'read', 'write'].includes(action) && action > last); last = action; }
  }
}
function authorization(value) {
  exact(value, [...IDENTITY, 'authorizationVersion', 'principalSecurityVersion', 'bindingRevision', 'grants', 'grantExpiresAtMs']);
  identity(value); ['authorizationVersion', 'principalSecurityVersion', 'bindingRevision'].forEach((name) => integer(value[name])); grants(value.grants);
  if (value.grantExpiresAtMs !== null) integer(value.grantExpiresAtMs);
}
function responseBody(kind, body) {
  if (kind === 'session-challenge') {
    exact(body, ['challenge', 'gatewayGeneration', 'issuedAtMs', 'expiresAtMs']); bytes(body.challenge); bytes(body.gatewayGeneration); window(body, 30000);
  } else if (kind === 'session') {
    exact(body, ['sessionId', 'gatewayGeneration', 'applicationId', 'launchId', 'channelKeyThumbprint', 'issuedAtMs', 'expiresAtMs',
      'presenceExpiresAtMs', 'heartbeatIntervalMs', 'authorization']);
    ['sessionId', 'gatewayGeneration', 'launchId', 'channelKeyThumbprint'].forEach((name) => bytes(body[name]));
    token(body.applicationId); window(body, 300000); integer(body.presenceExpiresAtMs);
    need(body.issuedAtMs < body.presenceExpiresAtMs && body.presenceExpiresAtMs <= Math.min(body.expiresAtMs, body.issuedAtMs + 3000)
      && body.heartbeatIntervalMs === 1000); authorization(body.authorization);
    need(body.authorization.grantExpiresAtMs === null || body.expiresAtMs <= body.authorization.grantExpiresAtMs);
  } else if (kind === 'heartbeat') {
    exact(body, ['sessionId', 'sequence', 'issuedAtMs', 'presenceExpiresAtMs', 'authorizationVersion', 'bindingRevision']); bytes(body.sessionId);
    ['sequence', 'issuedAtMs', 'presenceExpiresAtMs', 'authorizationVersion', 'bindingRevision'].forEach((name) => integer(body[name]));
    need(body.issuedAtMs < body.presenceExpiresAtMs && body.presenceExpiresAtMs <= body.issuedAtMs + 3000);
  } else if (kind === 'closed') {
    exact(body, ['sessionId', 'closedAtMs']); bytes(body.sessionId); integer(body.closedAtMs);
  } else if (kind === 'effect') {
    exact(body, ['operationId', 'targetScope', 'authorizationVersion', 'committedAtMs', 'deadlineMs', 'effectState', 'gateway', 'native', 'observedAtMs', 'evidenceDigest']);
    bytes(body.operationId); bytes(body.evidenceDigest); exact(body.targetScope, ['kind', 'id']);
    need(['session', 'binding', 'principal', 'ownership'].includes(body.targetScope.kind));
    if (body.targetScope.kind === 'session') bytes(body.targetScope.id); else token(body.targetScope.id);
    ['authorizationVersion', 'committedAtMs', 'deadlineMs', 'observedAtMs'].forEach((name) => integer(body[name]));
    need(body.deadlineMs === body.committedAtMs + 5000 && ['pending', 'effective', 'failed', 'unknown'].includes(body.effectState));
    exact(body.gateway, ['generation', 'targetSessions', 'closedSessions', 'pendingSessions']); bytes(body.gateway.generation);
    exact(body.native, ['targetOperations', 'closedOperations', 'pendingOperations', 'unknownOperations']);
    for (const group of [body.gateway, body.native]) for (const [name, value] of Object.entries(group)) if (name !== 'generation') integer(value, true);
    need(body.gateway.targetSessions === body.gateway.closedSessions + body.gateway.pendingSessions
      && body.native.targetOperations === body.native.closedOperations + body.native.pendingOperations + body.native.unknownOperations);
    if (body.effectState === 'effective') need(body.gateway.pendingSessions === 0 && body.native.pendingOperations === 0 && body.native.unknownOperations === 0);
  } else throw new DataProtocolError();
}
function response(value) {
  exact(value, ['schemaVersion', 'purpose', 'boxId', 'boxKeyThumbprint', 'kind', 'issuedAtMs', 'body']);
  base(value, 'response'); token(value.boxId); bytes(value.boxKeyThumbprint); integer(value.issuedAtMs); responseBody(value.kind, value.body);
  if (Object.hasOwn(value.body, 'issuedAtMs')) need(value.body.issuedAtMs === value.issuedAtMs);
  if (value.kind === 'session') need(value.body.authorization.boxId === value.boxId && value.body.authorization.boxKeyThumbprint === value.boxKeyThumbprint);
}
function signPayload(value, key, kind, validator) {
  // Canonicalize first so no getter is invoked by a purpose validator.
  const payload = JSON.parse(canonical(value)); validator(payload);
  need(key instanceof KeyObject && key.type === 'private' && key.asymmetricKeyType === 'ec'
    && key.asymmetricKeyDetails?.namedCurve === 'prime256v1');
  if (['session', 'session-intent', 'renewal'].includes(kind)) need(publicKeyThumbprint(payload.channelKey) !== publicKeyThumbprint(createPublicKey(key).export({ format: 'jwk' })));
  const input = `${Buffer.from(canonical({ alg: 'ES256', typ: `centuarai-local-data-${kind}+jws` })).toString('base64url')}.${Buffer.from(canonical(payload)).toString('base64url')}`;
  need(input.length + 87 <= 16384);
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
export function validateSessionPayload(value) { const result = copy(value); session(result); return result; }
export function validateSessionIntentPayload(value) { const result = copy(value); sessionIntent(result); return result; }
export function validateRequestPayload(value) { const result = copy(value); request(result); return result; }
export function signSession(payload, key) { return signPayload(payload, key, 'session', session); }
export function signSessionIntent(payload, key) { return signPayload(payload, key, 'session-intent', sessionIntent); }
export function signHeartbeat(payload, key) { return signPayload(payload, key, 'heartbeat', heartbeat); }
export function signRenewal(payload, key) { return signPayload(payload, key, 'renewal', renewal); }
export function signClose(payload, key) { return signPayload(payload, key, 'close', close); }
export function signRequest(payload, key) { return signPayload(payload, key, 'request', request); }
export function verifyDataResponse(jws, { descriptor, kind, nowMs, expected = {} }) {
  const trusted = validateDescriptor(descriptor); integer(nowMs); record(expected);
  need(typeof jws === 'string' && /^[\x00-\x7f]*$/.test(jws) && jws.length <= 65536);
  const parts = jws.split('.'); need(parts.length === 3);
  const parse = (part) => {
    const raw = bytes(part, null).toString('ascii'); let result;
    try { result = JSON.parse(raw); } catch { throw new DataProtocolError(); }
    need(canonical(result) === raw && Buffer.from(raw).toString('base64url') === part); return result;
  };
  const header = parse(parts[0]); exact(header, ['alg', 'typ']);
  need(header.alg === 'ES256' && header.typ === 'centuarai-local-data-response+jws');
  const payload = parse(parts[1]); response(payload);
  need(verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKey(trusted.boxKey), dsaEncoding: 'ieee-p1363' }, bytes(parts[2], 64)), 'LOCAL_DATA_FORBIDDEN');
  need(payload.boxId === trusted.boxId && payload.boxKeyThumbprint === publicKeyThumbprint(trusted.boxKey) && payload.kind === kind, 'LOCAL_DATA_CONTEXT_CHANGED');
  need(payload.issuedAtMs <= nowMs, 'LOCAL_DATA_SESSION_EXPIRED');
  if (['session', 'session-challenge'].includes(kind)) need(payload.body.issuedAtMs <= nowMs && nowMs < payload.body.expiresAtMs, 'LOCAL_DATA_SESSION_EXPIRED');
  if (['session', 'heartbeat'].includes(kind)) need(nowMs < payload.body.presenceExpiresAtMs, 'LOCAL_DATA_SESSION_EXPIRED');
  for (const [name, value] of Object.entries(expected)) need(Object.hasOwn(payload.body, name) && canonical(payload.body[name]) === canonical(value), 'LOCAL_DATA_CONTEXT_CHANGED');
  return frozen(payload);
}
