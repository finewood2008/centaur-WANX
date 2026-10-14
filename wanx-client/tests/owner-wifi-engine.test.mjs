import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createNodeProvisioningCryptoProvider } from '@nexusaos/local-provisioning-core/node';
import { createOwnerWifiCoordinator } from '../account/owner-wifi.mjs';

// Run explicitly with CENTUAROS_TEST_REPO=/absolute/os/repo and optionally
// CENTUAROS_TEST_PYTHON pointing at a Python runtime with cryptography installed.
test('owner coordinator interoperates with the real Python box protocol engine', {
  skip: !process.env.CENTUAROS_TEST_REPO, timeout: 15000,
}, async () => {
  const child = spawn(process.env.CENTUAROS_TEST_PYTHON || 'python3', [
    fileURLToPath(new URL('./fixtures/owner-wifi-engine.py', import.meta.url)), process.env.CENTUAROS_TEST_REPO,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = [];
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('exit', (code) => { for (const { reject } of pending.splice(0)) reject(new Error(`engine exited ${code}: ${stderr}`)); });
  lines.on('line', (line) => { const next = pending.shift(), reply = JSON.parse(line);
    reply.ok ? next.resolve(reply.value) : next.reject(new Error(reply.error)); });
  const rpc = (op, args = {}) => new Promise((resolve, reject) => {
    pending.push({ resolve, reject }); child.stdin.write(`${JSON.stringify({ op, ...args })}\n`);
  });
  let coordinator;
  try {
    const meta = await rpc('metadata');
    const envelope = (data) => ({ data, serverTime: meta.serverTime, requestId: 'integration-test', receivedMonotonicMs: 0 });
    coordinator = createOwnerWifiCoordinator({ crypto: createNodeProvisioningCryptoProvider({ trustedRootCertificatesPem: [meta.root] }),
      trustedRootSpkiPins: [meta.pin], clock: { monotonicMs: () => performance.now() }, clientVersion: 'wanx-client/test',
      consumerApi: { getOwnerWifiAttestation: async () => envelope(meta.attestation),
        authorizeOwnerWifi: async (body) => envelope(await rpc('authorize', { body })) },
      transportFactory: { connect: async () => ({ kind: 'ble-gatt',
        readDeviceInfo: async () => new Uint8Array(Buffer.from(await rpc('read'), 'base64')),
        request: async (frame) => new Uint8Array(Buffer.from(await rpc('request', { frame: Buffer.from(frame).toString('base64') }), 'base64')),
        close: () => rpc('close'),
      }) },
    });
    await coordinator.begin({ accountId: 'owner-account', clientId: 'owner-client', selected: {} });
    await coordinator.confirmPhysicalDevice();
    assert.equal(coordinator.getSnapshot().state, 'awaitingWifi');
    await coordinator.provideWifi({ ssid: 'new-router', security: 'wpa_personal', hidden: false, passwordUtf8: new TextEncoder().encode('wifi-pass') });
    assert.equal(coordinator.getSnapshot().state, 'completed');
    const stats = await rpc('stats');
    assert.equal(stats.wifiApplyCalls, 1);
    assert.equal(stats.claimRecordExists, false);
    assert.equal(stats.owner.ownerAccountId, 'owner-account');
    assert.equal(stats.owner.ownershipEpoch, 1);
  } finally {
    await coordinator?.dispose(); lines.close(); child.kill();
  }
});
