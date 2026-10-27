import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { signWifiProof, verifyWifiProof, validateWifiPayload, wifiDigest, wifiAeadDeviceId } from '../device-trust/offline-wifi-contract.mjs';
import { encodeJsonLine } from '@nexusaos/local-provisioning-core';
const nonce = () => randomBytes(32).toString('base64url');
const context = { boxId: 'box-1', boxKeyThumbprint: nonce(), ownershipEpoch: 2, authorityBootId: 'boot-1',
  authorizationVersion: 4, bindingId: 'binding-1', bindingRevision: 2, principalId: 'principal-1',
  principalSecurityVersion: 3, clientId: 'client-1', approvalKeyVersion: 1 };
const ble = { pairingSessionId: 'session-1', challengeCanonicalSha256: 'a'.repeat(64), rsaSpkiSha256: 'b'.repeat(64) };
const payloads = {
  intent: { boxId: context.boxId, boxKeyThumbprint: context.boxKeyThumbprint, ownershipEpoch: 2,
    bindingId: context.bindingId, clientId: context.clientId, ble, nonce: nonce() },
  challenge: { context, ble, challengeId: nonce(), intentDigest: nonce(), issuedAt: 100, expiresAt: 220 },
  'session-access': { challengeDigest: nonce(), tokenCiphertextSha256: 'c'.repeat(64) },
  'session-receipt': { context, ble, sessionId: nonce(), challengeDigest: nonce(), tokenCiphertextSha256: 'c'.repeat(64), applyNonce: nonce(), issuedAt: 110, expiresAt: 220 },
  apply: { sessionDigest: nonce(), applyNonce: nonce(), requestId: 'request-1', counter: '1', ciphertextSha256: 'd'.repeat(64) },
};
test('legacy AEAD identity alias matches independent Python SHA256 vectors for full local box tokens', () => {
  assert.equal(wifiAeadDeviceId('box:test'), 'lwf-2mXJhFO-ISPB0U9C8t_TgAiyAIbH2Tps');
  assert.equal(wifiAeadDeviceId('b'.repeat(128)), 'lwf-cK4cUwf1JQ1cueQHQrqWE_zfm42ett05');
  assert.match(wifiAeadDeviceId('box:test'), /^[A-Za-z0-9._-]{36}$/);
});
for (const [kind, body] of Object.entries(payloads)) test(`offline Wi-Fi ${kind} is a closed domain separated canonical proof`, () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const payload = { schemaVersion: 1, purpose: `centuarai.local-wifi.${kind}.v1`, ...body };
  const proof = signWifiProof(kind, payload, key.privateKey);
  assert.deepEqual(verifyWifiProof(kind, proof, key.publicKey), payload);
  assert.match(wifiDigest(payload), /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => validateWifiPayload(kind, { ...payload, cloudOwner: true }));
  assert.throws(() => verifyWifiProof(kind, proof, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey));
  const parts = proof.split('.'); parts[1] += '=';
  assert.throws(() => verifyWifiProof(kind, parts.join('.'), key.publicKey));
});
test('apply counter rejects zero, leading zero, unsafe formats and uint64 overflow', () => {
  for (const counter of ['0', '01', '-1', '1.0', '18446744073709551616', 1])
    assert.throws(() => validateWifiPayload('apply', { schemaVersion: 1, purpose: 'centuarai.local-wifi.apply.v1', ...payloads.apply, counter }));
});
test('largest legal local identities and RSA3072 token fit the unchanged 2048-byte BLE envelope', t => {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const intent = { schemaVersion: 1, purpose: 'centuarai.local-wifi.intent.v1', ...payloads.intent,
    boxId: 'b'.repeat(128), bindingId: 'd'.repeat(128), clientId: 'c'.repeat(128),
    ownershipEpoch: Number.MAX_SAFE_INTEGER, ble: { ...ble, pairingSessionId: '11111111-1111-4111-8111-111111111111' } };
  const common = { schema_version: 2, request_id: '22222222-2222-4222-8222-222222222222', pairing_session_id: intent.ble.pairingSessionId };
  const access = { schemaVersion: 1, purpose: 'centuarai.local-wifi.session-access.v1', ...payloads['session-access'] };
  const frames = [
    encodeJsonLine({ ...common, message_type: 'local.wifi.authorize', payload: { intent_proof: signWifiProof('intent', intent, key.privateKey) } }),
    encodeJsonLine({ ...common, message_type: 'local.wifi.token', payload: { algorithm: 'RSA-OAEP-SHA256-MGF1-SHA256',
      ciphertext: Buffer.alloc(384).toString('base64'), proof: signWifiProof('session-access', access, key.privateKey) } }),
  ];
  for (const frame of frames) assert.ok(frame.length <= 2048);
  t.diagnostic(`maximum identity intent envelope=${frames[0].length}; RSA3072 token envelope=${frames[1].length}`);
});
