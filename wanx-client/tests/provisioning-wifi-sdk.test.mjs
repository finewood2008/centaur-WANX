import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createSecureChannel, createClaimCoordinator, stableJson, ProtocolError } from '@nexusaos/local-provisioning-core';

const utf8 = (value) => new TextEncoder().encode(value);
const session = '11111111-1111-4111-8111-111111111111';
const request = '22222222-2222-4222-8222-222222222222';
const provider = {
  async aes256GcmEncrypt(key, nonce, aad, clear) {
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
    return new Uint8Array(Buffer.concat([cipher.update(clear), cipher.final(), cipher.getAuthTag()]));
  },
  async aes256GcmDecrypt(key, nonce, aad, cipher) {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(aad);
    decipher.setAuthTag(cipher.slice(-16));
    return new Uint8Array(Buffer.concat([decipher.update(cipher.slice(0, -16)), decipher.final()]));
  },
  zeroize(bytes) { bytes.fill(0); },
};
function harness() {
  const keys = { appToDeviceKey: new Uint8Array(randomBytes(32)), deviceToAppKey: new Uint8Array(randomBytes(32)), confirmKey: new Uint8Array(randomBytes(32)) };
  const channel = createSecureChannel(provider, { deviceId: 'box-22', pairingSessionId: session, keys });
  const incoming = async (body, counter = 1, type = 'wifi.scan') => {
    const messageType = `${type}.result`;
    const nonce = new Uint8Array(12); const view = new DataView(nonce.buffer);
    view.setUint32(0, 0x4e444556); view.setBigUint64(4, BigInt(counter));
    const aad = utf8(['NEXUSAOS-PROVISIONING-V2', 'box-22', session, 'device-to-app', request, messageType, String(counter)].join('\n'));
    const cipher = await provider.aes256GcmEncrypt(keys.deviceToAppKey, nonce, aad,
      utf8(stableJson({ request_id: request, message_type: messageType, ...body })));
    return utf8(stableJson({ schema_version: 2, pairing_session_id: session, request_id: request,
      message_type: messageType, direction: 'device-to-app', counter: String(counter), ciphertext: Buffer.from(cipher).toString('base64') }) + '\n');
  };
  return { channel, incoming, keys };
}
const network = { ssid: '办公室:Wi\\Fi😀', signal: 83, security: 'wpa_personal' };
const ready = { scan_state: 'ready', networks: [network], next_offset: null };
const expected = { requestId: request, messageType: 'wifi.scan' };

test('wifi.scan uses the existing AEAD envelope and a bounded encrypted response preserves SSID bytes', async () => {
  const h = harness();
  const outbound = await h.channel.sealRequest(request, 'wifi.scan', { offset: 0, refresh: true });
  assert.ok(outbound.length < 2048);
  const envelope = JSON.parse(new TextDecoder().decode(outbound));
  assert.equal(envelope.message_type, 'wifi.scan'); assert.equal(envelope.counter, '1');
  assert.equal(Object.hasOwn(envelope, 'payload'), false);
  const frame = await h.incoming({ status: 'completed', payload: ready });
  assert.ok(frame.length < 2048);
  assert.deepEqual((await h.channel.openIncoming(frame, expected)).payload, ready);
});

test('maximum page of six 32-byte names fits the unchanged BLE envelope limit', async () => {
  const h = harness();
  const payload = { scan_state: 'ready', networks: Array.from({ length: 6 }, (_, i) => ({
    ssid: '😀'.repeat(7) + String(i).repeat(4), signal: 100, security: 'unsupported' })), next_offset: 6 };
  const frame = await h.incoming({ status: 'completed', payload });
  assert.ok(frame.length <= 2048, `frame size ${frame.length}`);
  assert.deepEqual((await h.channel.openIncoming(frame, expected)).payload, payload);
});

test('scanning and retryable scan failures preserve the authenticated session for manual Wi-Fi', async () => {
  const h = harness();
  await h.channel.openIncoming(await h.incoming({ status: 'completed', payload: {
    scan_state: 'scanning', networks: [], next_offset: null } }), expected);
  const failure = await h.channel.openIncoming(await h.incoming({ status: 'failed', error: {
    code: 'wifi_unavailable', retryable: true } }, 2), expected);
  assert.equal(failure.error.code, 'wifi_unavailable');
  const manual = await h.channel.sealRequest(request, 'wifi.apply', {
    ssid: 'hidden-network', hidden: true, security: 'open' });
  assert.equal(JSON.parse(new TextDecoder().decode(manual)).message_type, 'wifi.apply');
  assert.ok(h.keys.deviceToAppKey.some(Boolean));
});

test('scan request rejects invalid offsets, refresh combinations and extra payload keys', async () => {
  for (const payload of [{ offset: -1, refresh: false }, { offset: 61, refresh: false },
    { offset: 1, refresh: true }, { offset: 0 }, { offset: 0, refresh: 'true' },
    { offset: 0, refresh: true, command: 'arbitrary' }]) {
    await assert.rejects(harness().channel.sealRequest(request, 'wifi.scan', payload), ProtocolError);
  }
});

test('malformed scan pages fail closed without weakening replay or session guards', async () => {
  const malformed = [
    { ...ready, extra: true }, { ...ready, networks: Array(7).fill(network) },
    { ...ready, next_offset: 0 }, { ...ready, next_offset: 61 },
    { ...ready, scan_state: 'scanning' },
    ...[{ ssid: '' }, { ssid: '盒'.repeat(11) }, { ssid: 'bad\nname' },
      { signal: 101 }, { signal: -1 }, { security: 'enterprise' }, { password: 'must not leak' }]
      .map((patch) => ({ ...ready, networks: [{ ...network, ...patch }] })),
  ];
  for (const payload of malformed) {
    const h = harness();
    await assert.rejects(h.channel.openIncoming(await h.incoming({ status: 'completed', payload }), expected), ProtocolError);
    assert.ok(h.keys.deviceToAppKey.every((byte) => byte === 0));
  }
  const h = harness(); const frame = await h.incoming({ status: 'completed', payload: ready });
  await h.channel.openIncoming(frame, expected);
  await assert.rejects(h.channel.openIncoming(frame, expected), ProtocolError);
});

test('coordinator forbids scanning before verified pairing and leaves the existing flow state unchanged', async () => {
  const coordinator = createClaimCoordinator({ clock: { monotonicMs: () => 0 } });
  await assert.rejects(coordinator.scanWifi(), { code: 'CLAIM_INVALID_STATE' });
  assert.equal(coordinator.getSnapshot().state, 'idle');
});
