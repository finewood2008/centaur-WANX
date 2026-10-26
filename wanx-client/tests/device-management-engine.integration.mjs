import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDeviceTrustCoordinator } from '../device-trust/coordinator.mjs';
import { createPinnedTransport } from '../device-trust/pinned-transport.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/local-management-engine.py', import.meta.url));
const passphrase = 'integration-only separate local passphrase';
async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function startEngine(directory, port, restart = false) {
  let diagnostics = '';
  const process = spawn('uv', ['run', '--project', 'wanx-bridge', '--no-sync', 'python', fixture,
    path.join(directory, 'authority'), String(port), ...(restart ? ['restart'] : [])],
  { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  process.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8192); });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Test engine exited: ${diagnostics}`);
    const listening = await new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (listening) return { process, async stop() {
      if (process.exitCode !== null) return;
      const exited = once(process, 'exit'); process.kill('SIGTERM'); await exited;
    } };
    await delay(100);
  }
  process.kill('SIGKILL');
  throw new Error(`Test engine startup timed out: ${diagnostics}`);
}

test('real HTTPS + encrypted desktop identities + SQLite enrollment, cancellation and restart', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'local-management-e2e-'));
  const services = [];
  let engine;
  t.after(async () => { for (const service of services) service.close(); await engine?.stop(); await rm(directory, { recursive: true, force: true }); });
  const port = await freePort();
  engine = await startEngine(directory, port);
  const deliveryPacket = await readFile(path.join(directory, 'delivery.json'), 'utf8');
  const packet = JSON.parse(deliveryPacket);
  const descriptor = { boxId: packet.boxId, baseUrl: packet.baseUrl, boxKey: packet.boxKey, tlsSpkiSha256: packet.tlsSpkiSha256 };
  const identity = async name => {
    const service = await createDeviceTrustCoordinator({ directory: path.join(directory, name) });
    services.push(service); await service.createProfile({ passphrase }); return service;
  };
  const manager = await identity('manager');
  const rootReview = await manager.prepareFirstRoot({ deliveryPacket });
  const rootAck = await manager.confirmFirstRoot({ reviewHandle: rootReview.reviewHandle, passphrase });
  assert.equal(rootAck.ack.role, 'manage');
  assert.equal(rootAck.ack.recoveryConfigured, false);
  const attacker = await identity('attacker');
  await assert.rejects(attacker.prepareFirstRoot({ deliveryPacket }));
  const join = await manager.exportJoinInfo({ boxId: descriptor.boxId });
  const applicant = await identity('applicant');
  const joinReview = await applicant.prepareJoin(join);
  const receipt = await applicant.submitJoin({ reviewHandle: joinReview.reviewHandle });
  assert.equal(receipt.state, 'pending');
  assert.equal(applicant.snapshot().boxes[0].role, 'pending');
  const approvalReview = await manager.prepareApproval({ invitation: receipt.invitation });
  const committed = await manager.confirmApproval({ reviewHandle: approvalReview.reviewHandle, passphrase });
  assert.equal(committed.ack.clientId, applicant.snapshot().profile.clientId);
  assert.equal(manager.snapshot().boxes[0].role, 'manage');
  assert.equal((await applicant.refreshRequest({ boxId: descriptor.boxId, requestId: receipt.requestId })).state, 'approved');
  assert.equal(applicant.snapshot().boxes[0].role, 'use');
  await assert.rejects(applicant.exportJoinInfo({ boxId: descriptor.boxId }));
  const inventory = await manager.refreshDevices({ boxId: descriptor.boxId });
  assert.equal(inventory.devices.length, 2);
  assert.equal(inventory.devices.filter(binding => binding.role === 'manage').length, 1);

  const cancelledClient = await identity('cancelled-client');
  const cancelledReview = await cancelledClient.prepareJoin(join);
  const cancelledReceipt = await cancelledClient.submitJoin({ reviewHandle: cancelledReview.reviewHandle });
  const staleApproval = await manager.prepareApproval({ invitation: cancelledReceipt.invitation });
  assert.equal((await cancelledClient.cancelRequest({ boxId: descriptor.boxId, requestId: cancelledReceipt.requestId })).state, 'cancelled');
  await assert.rejects(manager.confirmApproval({ reviewHandle: staleApproval.reviewHandle, passphrase }));
  assert.equal((await manager.refreshDevices({ boxId: descriptor.boxId })).devices.length, 2);

  const wrongPin = { ...descriptor, tlsSpkiSha256: Buffer.alloc(32, 99).toString('base64url') };
  await assert.rejects(createPinnedTransport({ descriptor: wrongPin }).request('/auth/challenge', {}), /PIN/);
  await engine.stop();
  engine = await startEngine(directory, port, true);
  assert.equal((await manager.refreshDevices({ boxId: descriptor.boxId })).devices.length, 2);
  assert.equal((await manager.refreshRequest({ boxId: descriptor.boxId, requestId: rootReview.requestId })).ack.bindingId, rootAck.ack.bindingId);
  assert.equal((await applicant.refreshRequest({ boxId: descriptor.boxId, requestId: receipt.requestId })).ack.bindingId, committed.ack.bindingId);
  // Server restart does not issue a fresh first-root claim for the same packet.
  await assert.rejects(attacker.prepareFirstRoot({ deliveryPacket }));
});
