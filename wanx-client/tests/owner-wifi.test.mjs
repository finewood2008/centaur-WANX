import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, sign, createHash } from 'node:crypto';
import { createOwnerWifiCoordinator } from '../account/owner-wifi.mjs';
import { createPairingConsumer } from '../account/pairing.mjs';
import { createNodeProvisioningCryptoProvider } from '@nexusaos/local-provisioning-core/node';
import { stableJson, challengeCanonical, computeKeyConfirm, deriveSessionKeys } from '@nexusaos/local-provisioning-core';

const utf8 = (text) => new TextEncoder().encode(text);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const b64url = (size, byte) => Buffer.alloc(size, byte).toString('base64url');
const sessionId = '11111111-1111-4111-8111-111111111111';
const deviceId = 'centauros-37859979e324b9e257c586da';
const clientId = 'owner-client';
const ownerAccountId = 'owner-account';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
const spkiHash = hash(spki);
const envelope = (data) => ({ data, requestId: 'request-one', serverTime: '2026-10-14T10:00:00Z', receivedMonotonicMs: 0 });
const attestation = { deviceId, certificatePem: '-----BEGIN CERTIFICATE-----', certificateChainPem: [],
  publicKeySha256: spkiHash, serialNumber: '01', certificateStatus: 'active',
  expiresAt: '2027-10-14T10:00:00Z', statusCheckedAt: '2026-10-14T10:00:00Z' };
const permitFor = (fields, overrides = {}) => ({ payload: { schemaVersion: 1, purpose: 'owner-wifi', deviceId,
  ownerAccountId, bindingId: 'binding-one', ownershipEpoch: 1, authVersion: 1, clientId,
  pairingSessionId: sessionId, challengeCanonicalSha256: fields.challengeCanonicalSha256,
  pairingTokenCiphertextSha256: fields.pairingTokenCiphertextSha256, expiresInSeconds: 300, ...overrides },
  keyId: 'owner-wifi-key-1', algorithm: 'Ed25519', signature: Buffer.alloc(64, 1).toString('base64') });

async function harness(options = {}) {
  let now = 0, closed = 0, counter = 0, appNonce, start, canonical, digest, keys, authorizedInput;
  const messages = [], requests = [], secretRefs = [], apiCalls = [];
  const crypto = { ...createNodeProvisioningCryptoProvider() };
  const nodeRandom = crypto.randomBytes;
  crypto.randomBytes = async (size) => { const bytes = await nodeRandom(size); secretRefs.push(bytes); return bytes; };
  crypto.verifyDeviceCertificateProfile = async ({ expectedDeviceId }) => {
    assert.equal(expectedDeviceId, deviceId);
    return { leafSpkiDer: spki, publicKeySha256: options.wrongCertificate ? '0'.repeat(64) : spkiHash, serialNumber: '01' };
  };
  const preview = { schema_version: 3, device_id: deviceId, display_name: 'CentaurAI Box', model: 'C100', serial_suffix: '86DA',
    provisioning_protocol_version: 2, security_profile: 'NEXUSAOS_LOCAL_AEAD_V2', identity_public_key_sha256: spkiHash,
    pairing_mode_remaining_seconds: 0, network_state: 'connected', cloud_enrollment_status: 'ready', max_message_bytes: 2048 };
  const info = utf8(stableJson(preview));
  const fields = () => ({ deviceId, pairingSessionId: sessionId, helloContextId: b64url(16, 1), appNonce,
    clientAttemptId: start.client_attempt_id, clientId, clientNonce: start.client_nonce,
    pairingDeviceNonce: b64url(32, 2), challengeNonce: b64url(32, 3), deviceInfoSha256: hash(info),
    requestedOpsSha256: hash('["wifi.apply"]'), expiresInSeconds: '300', transport: 'ble-gatt' });
  const aad = (direction, requestId, messageType, count) => utf8(['NEXUSAOS-PROVISIONING-V2', deviceId,
    sessionId, direction, requestId, messageType, count].join('\n'));
  const nonce = (prefix, count) => { const bytes = new Uint8Array(12), view = new DataView(bytes.buffer);
    view.setUint32(0, prefix); view.setBigUint64(4, BigInt(count)); return bytes; };
  const reply = (request, payload) => utf8(`${stableJson({ schema_version: 2, request_id: request.request_id,
    message_type: `${request.message_type}.result`, status: 'completed',
    ...(['pairing.start', 'pairing.challenge', 'pairing.token'].includes(request.message_type) ? { pairing_session_id: sessionId } : {}), payload })}\n`);
  const transport = {
    kind: 'ble-gatt', readDeviceInfo: async () => info, close: async () => { closed++; },
    async request(bytes, _match, signal) {
      assert.ok(bytes.length <= 2048); const request = JSON.parse(new TextDecoder().decode(bytes));
      messages.push(request.message_type); requests.push(request);
      if (request.message_type === 'hello') {
        appNonce = request.payload.app_nonce;
        return reply(request, { selected_version: 2, hello_context_id: b64url(16, 1), device_info: preview, device_info_sha256: hash(info) });
      }
      if (request.message_type === 'pairing.start') {
        start = request.payload; assert.deepEqual(start.requested_ops, ['wifi.apply']);
        return reply(request, { pairing_session_id: sessionId, pairing_device_nonce: b64url(32, 2), expires_in_seconds: 300,
          requested_ops: options.wrongOps ? ['wifi.apply', 'claim'] : ['wifi.apply'], transport: 'ble-gatt' });
      }
      if (request.message_type === 'pairing.challenge') {
        const canonicalFields = { ...fields(), challengeNonce: request.payload.challenge_nonce };
        canonical = challengeCanonical(canonicalFields);
        return reply(request, { signature: sign('sha256', options.badChallenge ? utf8('wrong') : canonical, pair.privateKey).toString('base64'),
          signature_algorithm: 'RSASSA-PKCS1-v1_5-SHA256' });
      }
      if (request.message_type === 'pairing.token') {
        assert.deepEqual(request.payload.owner_wifi_permit, permitFor({ challengeCanonicalSha256: hash(canonical),
          pairingTokenCiphertextSha256: hash(Buffer.from(request.payload.ciphertext, 'base64')) }));
        const token = privateDecrypt({ key: pair.privateKey, oaepHash: 'sha256' }, Buffer.from(request.payload.ciphertext, 'base64'));
        keys = await deriveSessionKeys(crypto, token, deviceId, sessionId, start.client_nonce, b64url(32, 2));
        token.fill(0);
        digest = await crypto.sha256(utf8(stableJson({ appNonce, attestationSpkiSha256: spkiHash, challengeCanonicalSha256: hash(canonical),
          clientAttemptId: start.client_attempt_id, clientId, clientNonce: start.client_nonce, deviceInfoSha256: hash(info), deviceId,
          helloContextId: b64url(16, 1), pairingDeviceNonce: b64url(32, 2), expiresInSeconds: 300, pairingSessionId: sessionId,
          pairingTokenCiphertextSha256: hash(Buffer.from(request.payload.ciphertext, 'base64')), protocolVersion: 2,
          requestedOps: ['wifi.apply'], securityProfile: 'NEXUSAOS_LOCAL_AEAD_V2', transport: 'ble-gatt' })));
        return reply(request, { key_confirm: options.badConfirm ? Buffer.alloc(32).toString('base64') : await computeKeyConfirm(crypto, keys.confirmKey, digest) });
      }
      const inner = JSON.parse(new TextDecoder().decode(await crypto.aes256GcmDecrypt(keys.appToDeviceKey,
        nonce(0x4e415050, request.counter), aad('app-to-device', request.request_id, request.message_type, request.counter),
        Buffer.from(request.ciphertext, 'base64'))));
      let payload;
      if (request.message_type === 'wifi.scan') payload = { scan_state: 'ready', networks: [{ ssid: 'office', signal: 85, security: 'wpa_personal' }], next_offset: null };
      if (request.message_type === 'wifi.apply') {
        assert.deepEqual(inner.payload, { ssid: 'office', security: 'wpa_personal', password: 'wifi-pass', hidden: false });
        if (options.blockWifiApply) {
          options.blockWifiApply();
          await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
        }
        payload = { operation_status: 'accepted', device_state: 'credentials_received', job_id: 'job_wifi1', state_version: 1 };
      }
      if (request.message_type === 'job.status') payload = { operation_status: 'completed', device_state: options.incompleteJob ? 'connecting' : 'connected', job_id: 'job_wifi1', state_version: 2 };
      if (request.message_type === 'pairing.cancel') { assert.equal(inner.payload.reason, 'user_cancelled'); payload = { cancelled: true }; }
      const messageType = `${request.message_type}.result`, count = String(++counter);
      const cipher = await crypto.aes256GcmEncrypt(keys.deviceToAppKey, nonce(0x4e444556, count),
        aad('device-to-app', request.request_id, messageType, count), utf8(stableJson({ request_id: request.request_id, message_type: messageType, status: 'completed', payload })));
      return utf8(stableJson({ schema_version: 2, pairing_session_id: sessionId, request_id: request.request_id,
        message_type: messageType, direction: 'device-to-app', counter: count, ciphertext: Buffer.from(cipher).toString('base64') }) + '\n');
    },
  };
  const coordinator = createOwnerWifiCoordinator({ crypto, transportFactory: { connect: async () => transport },
    consumerApi: {
      async getOwnerWifiAttestation(id) { apiCalls.push('attestation'); assert.equal(id, deviceId);
        if (options.notOwner) throw Object.assign(new Error('OWNER_REQUIRED'), { code: 'OWNER_REQUIRED' });
        return envelope(attestation); },
      async authorizeOwnerWifi(input) {
        apiCalls.push('authorize'); authorizedInput = input;
        assert.equal(input.signature, sign('sha256', canonical, pair.privateKey).toString('base64'));
        await options.authorizeWait?.();
        return envelope({ permit: permitFor({ challengeCanonicalSha256: hash(canonical),
          pairingTokenCiphertextSha256: input.pairingTokenCiphertextSha256 }, options.grantOverrides) });
      },
    }, trustedRootSpkiPins: [], clientVersion: 'wanx-client/test', clock: { monotonicMs: () => now } });
  return { coordinator, messages, requests, apiCalls, secretRefs, authorized: () => authorizedInput,
    closed: () => closed, advance: (ms) => { now += ms; },
    begin: () => coordinator.begin({ selected: {}, accountId: ownerAccountId, clientId, expectedDeviceId: options.expectedDeviceId }),
    pair: async () => { await coordinator.begin({ selected: {}, accountId: ownerAccountId, clientId, expectedDeviceId: options.expectedDeviceId }); await coordinator.confirmPhysicalDevice(); } };
}

test('owner changes Wi-Fi over real RSA/HKDF/AEAD with closed claim window and no claim APIs', async () => {
  const h = await harness({ expectedDeviceId: deviceId });
  try {
    await h.pair(); assert.equal(h.coordinator.getSnapshot().state, 'awaitingWifi');
    assert.deepEqual(await h.coordinator.scanWifi(), [{ ssid: 'office', signal: 85, security: 'wpa_personal' }]);
    const passwordUtf8 = utf8('wifi-pass');
    await h.coordinator.provideWifi({ ssid: 'office', security: 'wpa_personal', hidden: false, passwordUtf8 });
    assert.equal(h.coordinator.getSnapshot().state, 'completed');
    assert.equal(h.coordinator.getSnapshot().mode, 'wifi');
    assert.equal(h.coordinator.getSnapshot().networkState, 'connected');
    assert.deepEqual(h.apiCalls, ['attestation', 'authorize']);
    assert.ok(passwordUtf8.every((byte) => byte === 0));
    assert.ok(!JSON.stringify(h.requests).includes('wifi-pass'));
    assert.ok(!JSON.stringify(h.authorized()).includes('wifi-pass'));
    assert.equal(h.closed(), 1);
    assert.ok(h.secretRefs.at(-1).every((byte) => byte === 0), 'pairing token erased');
    await h.coordinator.dispose();
    assert.equal(h.coordinator.getSnapshot().state, 'completed');
    assert.ok(!h.messages.includes('pairing.cancel'));
  } finally { await h.coordinator.dispose(); }
});

test('a different box is rejected before preview, owner authorization or Wi-Fi writes', async () => {
  const h = await harness({ expectedDeviceId: 'centauros-000000000000000000000001' });
  const states = [];
  h.coordinator.subscribe(value => states.push(value.state));
  try {
    await assert.rejects(h.begin(), { code: 'DEVICE_IDENTITY_MISMATCH' });
    assert.equal(h.coordinator.getSnapshot().state, 'terminalError');
    assert.ok(!states.includes('previewReady'));
    assert.deepEqual(h.apiCalls, []);
    assert.deepEqual(h.messages, []);
    assert.equal(h.closed(), 1);
    await assert.rejects(h.coordinator.confirmPhysicalDevice(), { code: 'CLAIM_INVALID_STATE' });
  } finally { await h.coordinator.dispose(); }
});

for (const [options, code, forbidden] of [
  [{ notOwner: true }, 'OWNER_REQUIRED', 'hello'],
  [{ wrongCertificate: true }, 'DEVICE_IDENTITY_MISMATCH', 'hello'],
  [{ wrongOps: true }, 'PROTOCOL_CHANGED', 'pairing.challenge'],
  [{ badChallenge: true }, 'DEVICE_IDENTITY_MISMATCH', 'pairing.token'],
  [{ grantOverrides: { ownerAccountId: 'other-account' } }, 'PAIRING_MISMATCH', 'pairing.token'],
  [{ grantOverrides: { challengeCanonicalSha256: '0'.repeat(64) } }, 'PAIRING_MISMATCH', 'pairing.token'],
  [{ badConfirm: true }, 'DEVICE_IDENTITY_MISMATCH', 'wifi.apply'],
]) {
  test(`owner Wi-Fi rejects ${JSON.stringify(options)} before ${forbidden}`, async () => {
    const h = await harness(options);
    try { await assert.rejects(h.pair(), { code }); assert.ok(!h.messages.includes(forbidden)); assert.equal(h.closed(), 1); }
    finally { await h.coordinator.dispose(); }
  });
}

test('encrypted job completion must explicitly report connected', async () => {
  const h = await harness({ incompleteJob: true });
  try { await h.pair(); await assert.rejects(h.coordinator.provideWifi({ ssid: 'office', security: 'wpa_personal', hidden: false, passwordUtf8: utf8('wifi-pass') }), { code: 'PROTOCOL_CHANGED' });
    assert.equal(h.coordinator.getSnapshot().state, 'terminalError'); }
  finally { await h.coordinator.dispose(); }
});

test('session expires after 300 seconds and does not send Wi-Fi credentials', async () => {
  const h = await harness();
  try { await h.pair(); h.advance(300001); await assert.rejects(h.coordinator.scanWifi(), { code: 'PAIRING_EXPIRED' });
    assert.ok(!h.messages.includes('wifi.scan')); }
  finally { await h.coordinator.dispose(); }
});

test('cancel sends an authenticated cancellation before closing the BLE transport', async () => {
  const h = await harness();
  try { await h.pair(); await h.coordinator.cancel();
    assert.equal(h.messages.at(-1), 'pairing.cancel');
    assert.equal(h.coordinator.getSnapshot().state, 'cancelled');
    assert.equal(h.closed(), 1);
    assert.deepEqual(h.apiCalls, ['attestation', 'authorize']);
  } finally { await h.coordinator.dispose(); }
});

for (const method of ['cancel', 'suspend', 'dispose']) test(`${method} aborts the active Wi-Fi exchange before sending encrypted cancellation`, async () => {
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const h = await harness({ blockWifiApply: entered });
  try {
    await h.pair();
    const passwordUtf8 = utf8('wifi-pass');
    const applying = h.coordinator.provideWifi({ ssid: 'office', security: 'wpa_personal', hidden: false, passwordUtf8 });
    const rejected = assert.rejects(applying, { name: 'AbortError' });
    await reached; await h.coordinator[method](); await rejected;
    assert.deepEqual(h.messages.slice(-2), ['wifi.apply', 'pairing.cancel']);
    assert.ok(passwordUtf8.every(byte => byte === 0));
    assert.equal(h.coordinator.getSnapshot().state, method === 'cancel' ? 'cancelled' : 'provisioningWifi');
  } finally { await h.coordinator.dispose(); }
});

test('cancellation during authorization discards a late permit and erases the token', async () => {
  let release, entered;
  const wait = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  const h = await harness({ authorizeWait: async () => { entered(); await wait; } });
  const pairing = h.pair(); await reached; await h.coordinator.cancel(); release();
  await assert.rejects(pairing, { name: 'AbortError' });
  assert.ok(!h.messages.includes('pairing.token'));
  assert.equal(h.coordinator.getSnapshot().state, 'cancelled');
  assert.ok(h.secretRefs.at(-1).every(byte => byte === 0));
  await h.coordinator.dispose();
});

test('owner account adapter validates requests and permits and rejects stale account generations', async () => {
  const listeners = new Set(), calls = [];
  let reply = envelope(attestation);
  const consumer = createPairingConsumer({ getIdentity: () => ({ accountId: ownerAccountId, clientId }),
    snapshot: () => ({ phase: 'authenticated' }), subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    request: async (input) => { calls.push(input); return reply; } });
  const api = await consumer.pairingApi();
  assert.equal((await api.getOwnerWifiAttestation(deviceId)).data.deviceId, deviceId);
  assert.equal(calls.at(-1).path, `/app-api/v1/devices/${deviceId}/wifi-attestation`);
  const input = { deviceId, clientId, pairingSessionId: sessionId, helloContextId: b64url(16, 1), appNonce: b64url(32, 2),
    clientAttemptId: sessionId, clientNonce: b64url(32, 3), pairingDeviceNonce: b64url(32, 4), challengeNonce: b64url(32, 5),
    deviceInfoSha256: 'a'.repeat(64), signature: Buffer.alloc(256).toString('base64'), pairingTokenCiphertextSha256: 'b'.repeat(64) };
  reply = envelope({ permit: permitFor({ challengeCanonicalSha256: 'a'.repeat(64), pairingTokenCiphertextSha256: 'b'.repeat(64) }) });
  await api.authorizeOwnerWifi(input);
  assert.equal(calls.at(-1).path, '/app-api/v1/device-wifi/authorize');
  assert.equal(calls.at(-1).method, 'POST');
  assert.throws(() => api.authorizeOwnerWifi({ ...input, clientId: 'another-client' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => api.authorizeOwnerWifi({ ...input, requestedOps: ['claim'] }), { code: 'INVALID_REQUEST' });
  reply.data.permit.payload.purpose = 'claim';
  await assert.rejects(api.authorizeOwnerWifi(input), { code: 'CONTRACT_MISMATCH' });
  for (const fn of listeners) fn();
  await assert.rejects(api.getOwnerWifiAttestation(deviceId), { code: 'AUTH_SESSION_CHANGED' });
  consumer.dispose();
});
