import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createOfflineWifiCoordinator } from '../device-trust/offline-wifi-coordinator.mjs';
import { signWifiProof } from '../device-trust/offline-wifi-contract.mjs';

test('desktop interoperates with real Python authority and OS BLE, RSA3072, no cloud or LAN', {
  skip: !process.env.CENTUAROS_TEST_REPO, timeout: 30000,
}, async t => {
  const bridge = fileURLToPath(new URL('../../wanx-bridge/', import.meta.url));
  const child = spawn('uv', ['run', '--project', bridge, '--no-sync', 'python',
    fileURLToPath(new URL('./fixtures/offline-wifi-engine.py', import.meta.url)), process.env.CENTUAROS_TEST_REPO],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = [], sizes = []; let stderr = '';
  const lines = createInterface({ input: child.stdout });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('exit', code => { for (const request of pending.splice(0)) request.reject(new Error(`fixture exited ${code}: ${stderr}`)); });
  lines.on('line', line => { const next = pending.shift(), reply = JSON.parse(line);
    if (next) reply.ok ? next.resolve(reply.value) : next.reject(new Error(reply.error)); });
  const rpc = (op, input = {}) => new Promise((resolve, reject) => {
    pending.push({ resolve, reject }); child.stdin.write(JSON.stringify({ op, ...input }) + '\n');
  });
  let coordinator;
  t.after(() => { coordinator?.invalidate(); lines.close(); child.stdin.end(); child.kill(); });
  const metadata = await rpc('metadata');
  const access = createPrivateKey(metadata.accessPrivateKey), approval = createPrivateKey(metadata.approvalPrivateKey);
  delete metadata.accessPrivateKey; delete metadata.approvalPrivateKey;
  coordinator = createOfflineWifiCoordinator({
    requireProfile: () => ({ clientId: metadata.clientId }), run: async operation => operation(() => {}),
    box: () => ({ descriptor: metadata.descriptor, bindingId: metadata.bindingId, principalId: metadata.principalId,
      checkpoint: { ownershipEpoch: metadata.ownershipEpoch } }),
    vault: {
      signOfflineWifiIntent: body => signWifiProof('intent', body, access),
      signOfflineWifiSession: ({ payload }) => signWifiProof('session-access', payload, access),
      signOfflineWifiApply: async ({ payload, passphrase, guard }) => { assert.equal(passphrase, 'synthetic-local-passphrase'); guard(); return signWifiProof('apply', payload, approval); },
    },
    transportFactory: { connect: async () => ({ kind: 'ble-gatt', close: () => rpc('close'),
      async request(frame) { sizes.push(frame.length); const reply = Buffer.from(await rpc('request', { frame: Buffer.from(frame).toString('base64') }), 'base64');
        sizes.push(reply.length); assert.ok(reply.length <= 2048); return new Uint8Array(reply); },
    }) },
  });
  const api = coordinator.api;
  assert.equal((await api.beginOfflineWifi({ boxId: metadata.descriptor.boxId, selected: {} })).state, 'awaitingWifi');
  const input = { ssid: '新路由器', security: 'wpa_personal', hidden: true, password: 'synthetic-wifi-passphrase' };
  const review = await api.prepareOfflineWifi(input);
  let result;
  try { result = await api.confirmOfflineWifi({ reviewHandle: review.reviewHandle, passphrase: 'synthetic-local-passphrase' }); }
  catch (error) { t.diagnostic(JSON.stringify(await rpc('stats'))); throw error; }
  assert.equal(result.state, 'completed');
  const stats = await rpc('stats');
  assert.equal(stats.physicalApplyCount, 1); assert.equal(stats.proofRecordExists, false);
  for (const call of ['challenge', 'session', 'check', 'consume', 'result']) assert.ok(stats.authorityCalls.includes(call));
  assert.ok(sizes.every(size => size <= 2048));
  t.diagnostic(`maximum actual RSA3072 wire frame: ${Math.max(...sizes)} bytes (limit 2048)`);
  await api.beginOfflineWifi({ boxId: metadata.descriptor.boxId, selected: {} });
  const stale = await api.prepareOfflineWifi(input); await rpc('revoke');
  await assert.rejects(api.confirmOfflineWifi({ reviewHandle: stale.reviewHandle, passphrase: 'synthetic-local-passphrase' }));
  assert.equal((await rpc('stats')).physicalApplyCount, 1);
});
