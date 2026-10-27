import { createHash, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { canonicalLedger, ledgerDigest } from './ledger-contract.mjs';

export const wifiCanonical = canonicalLedger;
export const wifiDigest = ledgerDigest;
export const wifiByteDigest = value => createHash('sha256').update(value).digest('hex');
// This adapts the wider signed local box token to the legacy AEAD device-id
// field. Identity decisions always use the full boxId and pinned box key.
export const wifiAeadDeviceId = boxId => `lwf-${createHash('sha256').update(boxId, 'utf8').digest('base64url').slice(0, 32)}`;
const kinds = {
  intent: ['boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'bindingId', 'clientId', 'ble', 'nonce'],
  challenge: ['context', 'ble', 'challengeId', 'intentDigest', 'issuedAt', 'expiresAt'],
  'session-access': ['challengeDigest', 'tokenCiphertextSha256'],
  'session-receipt': ['context', 'ble', 'sessionId', 'challengeDigest', 'tokenCiphertextSha256', 'applyNonce', 'issuedAt', 'expiresAt'],
  apply: ['sessionDigest', 'applyNonce', 'requestId', 'counter', 'ciphertextSha256'],
  'result-receipt': ['sessionDigest', 'requestId', 'outcome', 'issuedAt'],
};
const maximum = { intent: 2048, challenge: 8192, 'session-access': 1024, 'session-receipt': 8192, apply: 1536, 'result-receipt': 1024 };
const fail = () => { throw Object.assign(new Error('LOCAL_WIFI_INVALID'), { code: 'LOCAL_WIFI_INVALID' }); };
const need = value => { if (!value) fail(); };
function exact(value, fields) {
  need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)));
}
const token = value => need(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.exec(value)?.[0] === value);
const integer = value => need(Number.isSafeInteger(value) && value > 0);
function decoded(value, size) {
  need(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value));
  const bytes = Buffer.from(value, 'base64url');
  need(bytes.toString('base64url') === value && (!size || bytes.length === size));
  return bytes;
}
const digest = value => decoded(value, 32);
const hex = value => need(typeof value === 'string' && /^[a-f0-9]{64}$/.exec(value)?.[0] === value);
function ble(value) {
  exact(value, ['pairingSessionId', 'challengeCanonicalSha256', 'rsaSpkiSha256']);
  token(value.pairingSessionId); hex(value.challengeCanonicalSha256); hex(value.rsaSpkiSha256);
}
function context(value) {
  exact(value, ['boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'authorityBootId', 'authorizationVersion',
    'bindingId', 'bindingRevision', 'principalId', 'principalSecurityVersion', 'clientId', 'approvalKeyVersion']);
  for (const key of ['boxId', 'authorityBootId', 'bindingId', 'principalId', 'clientId']) token(value[key]);
  digest(value.boxKeyThumbprint);
  for (const key of ['ownershipEpoch', 'authorizationVersion', 'bindingRevision', 'principalSecurityVersion', 'approvalKeyVersion']) integer(value[key]);
}
export function validateWifiPayload(kind, input) {
  need(Object.hasOwn(kinds, kind));
  // Canonical validation rejects getters, prototype tricks, non-ASCII protocol
  // strings and non-integer values before any copy or signature is made.
  const value = JSON.parse(wifiCanonical(input));
  exact(value, ['schemaVersion', 'purpose', ...kinds[kind]]);
  need(value.schemaVersion === 1 && value.purpose === `centuarai.local-wifi.${kind}.v1`);
  if (value.context) context(value.context);
  if (value.ble) ble(value.ble);
  for (const key of ['boxId', 'bindingId', 'clientId', 'requestId']) if (Object.hasOwn(value, key)) token(value[key]);
  for (const key of ['boxKeyThumbprint', 'nonce', 'challengeId', 'intentDigest', 'challengeDigest', 'sessionId', 'sessionDigest', 'applyNonce'])
    if (Object.hasOwn(value, key)) digest(value[key]);
  for (const key of ['tokenCiphertextSha256', 'ciphertextSha256']) if (Object.hasOwn(value, key)) hex(value[key]);
  for (const key of ['ownershipEpoch', 'issuedAt', 'expiresAt']) if (Object.hasOwn(value, key)) integer(value[key]);
  if (value.expiresAt) need(value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 120);
  if (Object.hasOwn(value, 'counter')) need(typeof value.counter === 'string' && /^[1-9][0-9]{0,19}$/.exec(value.counter)?.[0] === value.counter && BigInt(value.counter) <= 18446744073709551615n);
  if (Object.hasOwn(value, 'outcome')) need(['succeeded', 'failed', 'interrupted'].includes(value.outcome));
  return value;
}
export function signWifiProof(kind, input, key) {
  const value = validateWifiPayload(kind, input);
  const header = Buffer.from(wifiCanonical({ alg: 'ES256', typ: `centuarai-local-wifi-${kind}+jws` })).toString('base64url');
  const payload = Buffer.from(wifiCanonical(value)).toString('base64url'), text = `${header}.${payload}`;
  const proof = `${text}.${sign('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  need(Buffer.byteLength(proof) <= maximum[kind]);
  return proof;
}
export function verifyWifiProof(kind, proof, publicKey) {
  need(Object.hasOwn(kinds, kind) && typeof proof === 'string' && Buffer.byteLength(proof) <= maximum[kind]);
  const parts = proof.split('.'); need(parts.length === 3);
  const headerText = decoded(parts[0]).toString('utf8'), payloadText = decoded(parts[1]).toString('utf8');
  let header, payload;
  try { header = JSON.parse(headerText); payload = JSON.parse(payloadText); } catch { fail(); }
  need(wifiCanonical(header) === headerText && wifiCanonical(payload) === payloadText);
  exact(header, ['alg', 'typ']); need(header.alg === 'ES256' && header.typ === `centuarai-local-wifi-${kind}+jws`);
  const key = publicKey instanceof KeyObject ? publicKey : createPublicKey({ key: publicKey, format: 'jwk' });
  need(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1');
  need(verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, decoded(parts[2], 64)));
  return validateWifiPayload(kind, payload);
}
