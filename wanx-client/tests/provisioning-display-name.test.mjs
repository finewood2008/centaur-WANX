import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { decodeDeviceInfo, ProtocolError, stableJson } from '@nexusaos/local-provisioning-core';
import { createProvisioningHost } from '../shell/provisioning-host.cjs';

// Public read-only DeviceInfo captured from box 22; no pairing window is open.
const fixture = '{"cloud_enrollment_status":"ready","device_id":"centauros-e8c61ed41ade3ac92c486856","display_name":"CentaurOS-22","identity_public_key_sha256":"7dd1a4305c73f7298961388146d2b05e8f8f10d7df2c61fbb0fed3a24b4ee436","max_message_bytes":2048,"model":"C100","network_state":"unprovisioned","pairing_mode_remaining_seconds":0,"provisioning_protocol_version":2,"schema_version":3,"security_profile":"NEXUSAOS_LOCAL_AEAD_V2","serial_suffix":"0000"}';
const info = JSON.parse(fixture);
const encode = (value) => new TextEncoder().encode(value);
const decode = (source) => decodeDeviceInfo(encode(source), 'ble-gatt');
const changed = (fields) => stableJson({ ...info, ...fields });

test('the real 437-byte box 22 fixture retains its exact public name and canonical bytes', () => {
  const bytes = encode(fixture), original = bytes.slice();
  assert.equal(bytes.length, 437);
  const parsed = decodeDeviceInfo(bytes, 'ble-gatt');
  assert.equal(parsed.display_name, 'CentaurOS-22');
  assert.equal(parsed.device_id, info.device_id);
  assert.equal(parsed.pairing_mode_remaining_seconds, 0);
  assert.equal(stableJson(parsed), fixture, 'hello hashes and identity checks must see the original bytes');
  assert.deepEqual(bytes, original);
});

test('fixed names, specific names and bounded well-formed Unicode remain compatible', () => {
  for (const display_name of ['CentaurAI Box', 'CentaurOS-22', '办公室盒子', '盒子😀', 'x'.repeat(64), ' 保留名称空格 ']) {
    assert.equal(decode(changed({ display_name })).display_name, display_name);
  }
});

test('empty, non-string, long, control and unpaired-surrogate names fail closed', () => {
  for (const display_name of ['', '   ', null, 3, [], {}, 'x'.repeat(65), '\ud800', '\udfff', 'A\ud800B']) {
    const value = { ...info, display_name };
    // JSON.stringify permits lone surrogates; the decoder must reject them.
    const source = JSON.stringify(value, Object.keys(value).sort());
    assert.throws(() => decode(source), ProtocolError);
  }
  for (const code of [...Array.from({ length: 32 }, (_, i) => i),
    ...Array.from({ length: 33 }, (_, i) => 0x7f + i)]) {
    assert.throws(() => decode(changed({ display_name: `A${String.fromCharCode(code)}B` })), ProtocolError);
  }
  assert.throws(() => decode(changed({ display_name: '😀'.repeat(33) })), ProtocolError);
});

test('all other public identity, protocol, canonical encoding and size constraints remain strict', () => {
  for (const fields of [
    { extra: 'not allowed' }, { schema_version: 2 }, { provisioning_protocol_version: 1 },
    { security_profile: 'LEGACY' }, { device_id: '../box' }, { device_id: 'a'.repeat(37) },
    { identity_public_key_sha256: 'bad' }, { max_message_bytes: 16384 },
    { pairing_mode_remaining_seconds: 601 }, { cloud_enrollment_status: 'unknown' },
    { cloud_enrollment_status: 'not_enrolled', pairing_mode_remaining_seconds: 5 },
  ]) assert.throws(() => decode(changed(fields)), ProtocolError);
  const missing = { ...info }; delete missing.device_id;
  assert.throws(() => decode(stableJson(missing)), ProtocolError);
  for (const source of [`${fixture}\n`, ` ${fixture}`, JSON.stringify(info, null, 2),
    fixture.replace('"display_name":', '"display_name":"duplicate","display_name":'),
    changed({ display_name: '盒'.repeat(64) })]) assert.throws(() => decode(source), ProtocolError);
});

test('actual host and coordinator reach previewReady but a closed window sends no hello or claim', async () => {
  const ipcMain = new EventEmitter(), handlers = new Map();
  ipcMain.handle = (name, callback) => handlers.set(name, callback);
  ipcMain.removeHandler = (name) => handlers.delete(name);
  const webContents = new EventEmitter();
  webContents.mainFrame = { url: 'file:///test/setup.html' };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const operations = [];
  webContents.send = (channel, request) => {
    if (channel !== 'wanx:setup:transport') return;
    operations.push(request.operation);
    const value = request.operation === 'connect' ? 'connection-22' :
      request.operation === 'readDeviceInfo' ? Array.from(encode(fixture)) : null;
    queueMicrotask(() => ipcMain.emit('wanx:setup:transport-result', event,
      { requestId: request.requestId, ok: true, value }));
  };
  const host = await createProvisioningHost({ webContents, ipcMain, documentUrl: webContents.mainFrame.url,
    consumer: { current: async () => ({ accountId: 'account-22', clientId: 'client-22' }),
      pairingApi: async () => new Proxy({}, { get(_target, key) {
        return key === 'then' ? undefined : () => assert.fail('read-only preview must not call pairing API');
      } }) },
    cryptoFactory: () => ({ randomBytes: (size) => new Uint8Array(randomBytes(size)) }),
    resumeStore: {}, trustedRootCertificatesPem: [], trustedRootSpkiPins: [],
  });
  try {
    const preview = await host.begin({ candidateId: 'candidate-22', transport: 'ble-gatt',
      transportHandle: 'handle-22', selectionLeaseId: 'lease-22', advertisedName: 'CentaurOS-Setup-486856',
      rssi: -40, firstSeenMonotonicMs: 0, lastSeenMonotonicMs: 1 });
    assert.equal(preview.state, 'previewReady');
    assert.equal(preview.preview.display_name, 'CentaurOS-22');
    await assert.rejects(host.confirmPhysical(), { code: 'PAIRING_MODE_CLOSED' });
    assert.deepEqual(operations, ['connect', 'readDeviceInfo']);
    assert.equal(host.state().state, 'previewReady');
  } finally { await host.dispose(); }
});

test('vendored SDK patches reproduce byte-for-byte from the pinned upstream archives', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../tools/patch-provisioning-display-name.mjs', import.meta.url)), '--check'],
    { stdio: 'pipe' });
});
