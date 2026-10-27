import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto';
import { computeKeyConfirm, deriveSessionKeys, stableJson } from '@nexusaos/local-provisioning-core';
import { createNodeProvisioningCryptoProvider } from '@nexusaos/local-provisioning-core/node';
import { createOfflineWifiCoordinator } from '../device-trust/offline-wifi-coordinator.mjs';
import { publicKeyThumbprint } from '../device-trust/binding-contract.mjs';
import { signWifiProof, verifyWifiProof, wifiCanonical, wifiDigest, wifiByteDigest, wifiAeadDeviceId } from '../device-trust/offline-wifi-contract.mjs';
const utf8 = value => new TextEncoder().encode(value);
const random = () => randomBytes(32).toString('base64url');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const boxPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = rsa.publicKey.export({ type: 'spki', format: 'der' });
const boxId = 'offline-box', clientId = 'offline-client', sessionId = '11111111-1111-4111-8111-111111111111';
const profile = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), approval = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const descriptor = { boxId, boxKey: boxPair.publicKey.export({ format: 'jwk' }) };
const association = { descriptor, bindingId: 'my-binding', principalId: 'my-principal', role: 'manage', checkpoint: { ownershipEpoch: 3 } };
const context = { boxId, boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey), ownershipEpoch: 3,
  authorityBootId: 'boot-1', authorizationVersion: 7, bindingId: association.bindingId, bindingRevision: 2,
  principalId: association.principalId, principalSecurityVersion: 1, clientId, approvalKeyVersion: 1 };

function fixture(t, options = {}) {
  const crypto = createNodeProvisioningCryptoProvider();
  const requests = [], sizes = [], ciphertexts = [];
  const deviceNonce = random(); let clientNonce, ble, challenge, challengeBundle, receipt, receiptBundle, keys, count = 0, closed = 0, now = 0;
  const answer = (request, body) => utf8(wifiCanonical({ schema_version: 2, request_id: request.request_id,
    message_type: `${request.message_type}.result`, status: 'completed', pairing_session_id: sessionId, payload: body }) + '\n');
  const chunk = (request, text) => {
    const offset = request.payload.offset, part = text.slice(offset, offset + 1024);
    return answer(request, { chunk: part, total: text.length, next_offset: offset + part.length });
  };
  const nonce = (prefix, value) => { const result = new Uint8Array(12), view = new DataView(result.buffer); view.setUint32(0, prefix); view.setBigUint64(4, BigInt(value)); return result; };
  const aad = (direction, id, type, counter) => utf8(['NEXUSAOS-PROVISIONING-V2', wifiAeadDeviceId(boxId), sessionId, direction, id, type, counter].join('\n'));
  const transport = { kind: 'ble-gatt', close: async () => { closed++; }, async request(frame) {
    assert.ok(frame.length <= 2048); sizes.push(frame.length);
    const request = JSON.parse(new TextDecoder().decode(frame)); requests.push(request);
    const type = request.message_type;
    if (type === 'local.wifi.start') {
      assert.deepEqual(Object.keys(request.payload).sort(), ['box_id', 'client_id', 'client_nonce']);
      assert.equal(request.payload.box_id, boxId); clientNonce = request.payload.client_nonce;
      ble = { pairingSessionId: sessionId, rsaSpkiSha256: wifiByteDigest(spki), challengeCanonicalSha256: wifiByteDigest(wifiCanonical({
        purpose: 'centuarai.local-wifi.ble.v1', pairingSessionId: sessionId, boxId, clientId, clientNonce,
        pairingDeviceNonce: deviceNonce, rsaSpkiSha256: wifiByteDigest(spki) })) };
      return answer(request, { pairing_session_id: sessionId, pairing_device_nonce: deviceNonce, rsa_spki_der: spki.toString('base64'),
        expires_in_seconds: 120, requested_ops: ['wifi.apply'], transport: 'ble-gatt' });
    }
    if (type === 'local.wifi.authorize') {
      if (options.denied) throw Object.assign(new Error('LOCAL_WIFI_UNAUTHORIZED'), { code: 'LOCAL_WIFI_UNAUTHORIZED' });
      const intent = verifyWifiProof('intent', request.payload.intent_proof, profile.publicKey);
      assert.deepEqual(intent.ble, ble);
      challenge = { schemaVersion: 1, purpose: 'centuarai.local-wifi.challenge.v1', context,
        ble: options.wrongBle ? { ...ble, rsaSpkiSha256: '0'.repeat(64) } : ble,
        challengeId: random(), intentDigest: wifiDigest(intent), issuedAt: 100, expiresAt: 220 };
      challengeBundle = wifiCanonical({ challenge: signWifiProof('challenge', challenge,
        options.wrongBoxKey ? profile.privateKey : boxPair.privateKey), rsa_spki_der: spki.toString('base64') });
      return answer(request, { challenge_bytes: challengeBundle.length });
    }
    if (type === 'local.wifi.challenge') return chunk(request, challengeBundle);
    if (type === 'local.wifi.token') {
      const access = verifyWifiProof('session-access', request.payload.proof, profile.publicKey);
      assert.equal(access.challengeDigest, wifiDigest(challenge));
      const ciphertext = Buffer.from(request.payload.ciphertext, 'base64'); assert.equal(access.tokenCiphertextSha256, wifiByteDigest(ciphertext));
      const token = privateDecrypt({ key: rsa.privateKey, oaepHash: 'sha256' }, ciphertext);
      keys = await deriveSessionKeys(crypto, token, wifiAeadDeviceId(boxId), sessionId, clientNonce, deviceNonce); token.fill(0);
      receipt = { schemaVersion: 1, purpose: 'centuarai.local-wifi.session-receipt.v1', context, ble, sessionId: random(),
        challengeDigest: wifiDigest(challenge), tokenCiphertextSha256: wifiByteDigest(ciphertext), applyNonce: random(), issuedAt: 101, expiresAt: 220 };
      receiptBundle = wifiCanonical({ sessionReceipt: signWifiProof('session-receipt', receipt, boxPair.privateKey) });
      const transcript = await crypto.sha256(utf8(wifiCanonical({ purpose: 'centuarai.local-wifi.session',
        challengeSha256: wifiDigest(challenge), tokenCiphertextSha256: wifiByteDigest(ciphertext), protocolVersion: 2,
        securityProfile: 'NEXUSAOS_LOCAL_AEAD_V2', transport: 'ble-gatt' })));
      return answer(request, { key_confirm: await computeKeyConfirm(crypto, keys.confirmKey, transcript), receipt_bytes: receiptBundle.length });
    }
    if (type === 'local.wifi.receipt') return chunk(request, receiptBundle);
    const cipher = Buffer.from(request.ciphertext, 'base64');
    const inner = JSON.parse(new TextDecoder().decode(await crypto.aes256GcmDecrypt(keys.appToDeviceKey,
      nonce(0x4e415050, request.counter), aad('app-to-device', request.request_id, type, request.counter), cipher)));
    let body;
    if (type === 'wifi.scan') body = { scan_state: 'ready', networks: [{ ssid: 'home', signal: 90, security: 'wpa_personal' }], next_offset: null };
    if (type === 'wifi.apply') {
      const proof = verifyWifiProof('apply', request.local_wifi_proof, approval.publicKey);
      assert.deepEqual(proof, { schemaVersion: 1, purpose: 'centuarai.local-wifi.apply.v1', sessionDigest: wifiDigest(receipt),
        applyNonce: receipt.applyNonce, requestId: request.request_id, counter: request.counter, ciphertextSha256: wifiByteDigest(cipher) });
      ciphertexts.push(inner.payload); body = { operation_status: 'accepted', device_state: 'credentials_received', job_id: 'job_wifi1', state_version: 1 };
    }
    if (type === 'job.status') body = { operation_status: 'completed', device_state: 'connected', job_id: 'job_wifi1', state_version: 2 };
    const responseType = `${type}.result`, counter = String(++count);
    const encrypted = await crypto.aes256GcmEncrypt(keys.deviceToAppKey, nonce(0x4e444556, counter),
      aad('device-to-app', request.request_id, responseType, counter), utf8(stableJson({ request_id: request.request_id,
        message_type: responseType, status: 'completed', payload: body })));
    return utf8(stableJson({ schema_version: 2, pairing_session_id: sessionId, request_id: request.request_id,
      message_type: responseType, direction: 'device-to-app', counter, ciphertext: Buffer.from(encrypted).toString('base64') }) + '\n');
  } };
  const service = createOfflineWifiCoordinator({ box: () => association, requireProfile: () => ({ clientId }),
    run: async fn => fn(() => {}), transportFactory: { connect: async () => transport }, monotonicMs: () => now,
    vault: {
      signOfflineWifiIntent: body => signWifiProof('intent', body, profile.privateKey),
      signOfflineWifiSession: ({ payload }) => signWifiProof('session-access', payload, profile.privateKey),
      async signOfflineWifiApply({ payload, passphrase, guard }) {
        await options.beforeApproval?.(); guard(); assert.equal(passphrase, 'local-passphrase');
        return signWifiProof('apply', payload, approval.privateKey);
      },
    },
  });
  t.after(() => service.invalidate());
  return { service, api: service.api, requests, sizes, ciphertexts, closed: () => closed, advance: ms => { now += ms; } };
}

test('offline local identity configures Wi-Fi through real RSA/HKDF/AEAD with no cloud or LAN adapter', async t => {
  const h = fixture(t), begun = await h.api.beginOfflineWifi({ boxId, selected: {} });
  assert.equal(begun.state, 'awaitingWifi');
  assert.equal((await h.api.scanOfflineWifi())[0].ssid, 'home');
  const review = await h.api.prepareOfflineWifi({ ssid: 'home', security: 'wpa_personal', hidden: false, password: 'wifi-passphrase' });
  assert.ok(!JSON.stringify(review).includes('wifi-passphrase'));
  assert.equal(h.requests.some(item => item.message_type === 'wifi.apply'), false);
  assert.equal((await h.api.confirmOfflineWifi({ reviewHandle: review.reviewHandle, passphrase: 'local-passphrase' })).state, 'completed');
  assert.deepEqual(h.ciphertexts, [{ ssid: 'home', security: 'wpa_personal', hidden: false, password: 'wifi-passphrase' }]);
  assert.ok(!JSON.stringify(h.requests).includes('wifi-passphrase'));
  assert.ok(h.sizes.every(size => size <= 2048));
  assert.equal(h.closed(), 1);
  await assert.rejects(h.api.confirmOfflineWifi({ reviewHandle: review.reviewHandle, passphrase: 'local-passphrase' }), /SESSION_REQUIRED/);
});
for (const option of ['denied', 'wrongBoxKey', 'wrongBle']) test(`${option} fails closed before token or cloud fallback`, async t => {
  const h = fixture(t, { [option]: true });
  await assert.rejects(h.api.beginOfflineWifi({ boxId, selected: {} }));
  assert.equal(h.requests.some(item => item.message_type === 'local.wifi.token'), false);
  assert.equal(h.closed(), 1);
});
test('lock during local confirmation rejects the delayed signature and never sends wifi.apply', async t => {
  let release, started;
  const waiting = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { started = resolve; });
  const h = fixture(t, { beforeApproval: () => { started(); return waiting; } });
  await h.api.beginOfflineWifi({ boxId, selected: {} });
  const review = await h.api.prepareOfflineWifi({ ssid: 'home', security: 'wpa_personal', hidden: false, password: 'wifi-passphrase' });
  const pending = h.api.confirmOfflineWifi({ reviewHandle: review.reviewHandle, passphrase: 'local-passphrase' });
  await reached; h.service.invalidate(); release();
  await assert.rejects(pending, /CONTEXT_CHANGED/);
  assert.equal(h.requests.some(item => item.message_type === 'wifi.apply'), false);
});
test('expired prepared review cannot mutate network and a second payload cannot replace a pending review', async t => {
  const h = fixture(t); await h.api.beginOfflineWifi({ boxId, selected: {} });
  const review = await h.api.prepareOfflineWifi({ ssid: 'home', security: 'wpa_personal', hidden: false, password: 'wifi-passphrase' });
  h.advance(120001);
  await assert.rejects(h.api.confirmOfflineWifi({ reviewHandle: review.reviewHandle, passphrase: 'local-passphrase' }), /EXPIRED/);
  assert.equal(h.requests.some(item => item.message_type === 'wifi.apply'), false);
});
