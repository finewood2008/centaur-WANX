import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stableJson } from '@nexusaos/local-provisioning-core';
import { DEVICE_INFO_UUID } from '@nexusaos/local-provisioning-contracts';
import { createProvisioningHost } from '../shell/provisioning-host.cjs';

const bundle = await readFile(new URL('../local-ui/renderer/device-setup.bundle.js', import.meta.url), 'utf8');
const payload = new TextEncoder().encode(stableJson({ schema_version: 3,
  device_id: 'box-reselection', display_name: 'CentaurAI Box', model: 'C100', serial_suffix: '0000',
  provisioning_protocol_version: 2, security_profile: 'NEXUSAOS_LOCAL_AEAD_V2',
  identity_public_key_sha256: 'a'.repeat(64), pairing_mode_remaining_seconds: 0,
  network_state: 'connected', cloud_enrollment_status: 'ready', max_message_bytes: 2048 }));

async function harness(t) {
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const webContents = new EventEmitter(); webContents.mainFrame = { url: 'file:///test/setup.html' };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  let listener, broken = false, identity = { accountId: 'account-1', clientId: 'client-1' };
  const operations = [], devices = [];
  const window = { wanxSetupTransport: {
    subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    reply(value) { ipcMain.emit('wanx:setup:transport-result', event, value); },
    status(value) { ipcMain.emit('wanx:setup:transport-status', event, value); },
  } };
  const bluetooth = { async requestDevice() {
    const device = new EventEmitter();
    device.id = `device-${devices.length}`; device.name = 'CentaurOS-Setup-000000';
    device.addEventListener = device.on.bind(device); device.removeEventListener = device.off.bind(device);
    device.disconnects = 0;
    const status = new EventEmitter();
    status.addEventListener = status.on.bind(status); status.removeEventListener = status.off.bind(status);
    status.startNotifications = async () => status; status.stopNotifications = async () => status;
    const service = { async getCharacteristic(uuid) {
      if (uuid === DEVICE_INFO_UUID) return { async readValue() {
        if (broken) throw Error('read failed');
        return new DataView(payload.buffer);
      } };
      return status;
    } };
    device.gatt = { async connect() { return this; }, getPrimaryService: async () => service,
      disconnect() { device.disconnects++; } };
    devices.push(device); return device;
  } };
  // Real shipped renderer, selection lease endpoint and GATT endpoint. Only the
  // physical Bluetooth API is fake; closeAll really revokes selection leases.
  vm.runInNewContext(bundle, { window, navigator: { bluetooth }, crypto: globalThis.crypto,
    performance, setTimeout, clearTimeout, AbortController, DOMException, TextEncoder, TextDecoder,
    Uint8Array, DataView, ArrayBuffer });
  webContents.send = (channel, input) => {
    if (channel === 'wanx:setup:transport') { operations.push(input.operation); listener(input); }
  };
  const host = await createProvisioningHost({ webContents, ipcMain, documentUrl: webContents.mainFrame.url,
    consumer: { current: async () => identity, pairingApi: async () => ({ getClaimState: async deviceId => ({ data: { deviceId, ownershipState: 'unclaimed', canClaim: true, nextAction: 'claim', reasonCode: null } }) }) },
    cryptoFactory: () => ({ randomBytes: (size) => new Uint8Array(randomBytes(size)) }),
    resumeStore: {}, trustedRootCertificatesPem: [], trustedRootSpkiPins: [] });
  t.after(async () => { await host.dispose(); await window.wanxDeviceSetupTransport.dispose(); });
  return { host, operations, devices, select: () => window.wanxDeviceSetupTransport.requestDeviceFromUserGesture(),
    broken(value) { broken = value; }, changeAccount() { identity = { accountId: 'account-2', clientId: 'client-2' }; } };
}

test('a failed read can be rescanned and selected repeatedly without revoking the fresh lease', async (t) => {
  const h = await harness(t);
  h.broken(true);
  await assert.rejects(h.host.begin(await h.select()));
  assert.equal(h.host.state().state, 'terminalError');
  h.broken(false);
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await h.host.begin(await h.select());
    assert.equal(state.state, 'previewReady');
    assert.equal(state.preview.device_id, 'box-reselection');
    await assert.rejects(h.host.confirmPhysical(), { code: 'PAIRING_MODE_CLOSED' });
  }
  assert.equal(h.operations.includes('closeAll'), false);
  assert.ok(h.devices.slice(0, -1).every((device) => device.disconnects >= 1), 'old physical connections were closed');
  assert.equal(h.operations.includes('request'), false, 'no pairing handshake is used to bypass selection');
});

test('explicit reset still revokes a fresh selection lease and only a new scan can connect', async (t) => {
  const h = await harness(t);
  await h.host.begin(await h.select());
  const stale = await h.select();
  await h.host.reset();
  await assert.rejects(h.host.begin(stale), { code: 'LOCAL_SELECTION_LEASE_INVALID' });
  assert.equal((await h.host.begin(await h.select())).state, 'previewReady');
  assert.ok(h.operations.includes('closeAll'));
});

test('switching account during reselection revokes the lease instead of reusing prior authority', async (t) => {
  const h = await harness(t);
  await h.host.begin(await h.select());
  const selected = await h.select();
  h.changeAccount();
  await assert.rejects(h.host.begin(selected), { code: 'AUTH_SESSION_CHANGED' });
  await assert.rejects(h.host.begin(selected), { code: 'LOCAL_SELECTION_LEASE_INVALID' });
  assert.equal((await h.host.begin(await h.select())).state, 'previewReady');
});
