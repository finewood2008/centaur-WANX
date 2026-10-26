import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeviceTrustCoordinator } from '../device-trust/coordinator.mjs';
import { startLedgerRuntime } from './ledger-runtime-harness.mjs';

const passphrase = 'synthetic transfer desktop passphrase';
test('actual OS erase is gated by two approvals and resumes across interruption before new epoch root delivery', { timeout: 90000 }, async t => {
  const runtime = await startLedgerRuntime(t, { transfer: true });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-transfer-https-'));
  const original = await createDeviceTrustCoordinator({ directory: path.join(directory, 'original') });
  const next = await createDeviceTrustCoordinator({ directory: path.join(directory, 'next') });
  t.after(async () => { original.close(); next.close(); await rm(directory, { recursive: true, force: true }); if (runtime.diagnostic()) t.diagnostic(runtime.diagnostic()); });
  await original.createProfile({ passphrase }); await next.createProfile({ passphrase });
  const first = await original.prepareFirstRoot({ deliveryPacket: runtime.deliveryPacket });
  await original.confirmFirstRoot({ reviewHandle: first.reviewHandle, passphrase });
  await runtime.command('migrate');
  const boxId = runtime.descriptor.boxId;
  const activation = await original.prepareActivatePolicy({ boxId, capabilities: ['device.approve_use', 'ownership.transfer'] });
  await original.confirmSecurityMutation({ reviewHandle: activation.reviewHandle, passphrase });
  await runtime.command('challenge.saturate');
  const review = await original.prepareOwnershipTransfer({ boxId });
  assert.ok(review.transferPlan.scope.resourceRoots.includes('/var/lib/centuarai/wanx'));
  assert.equal(review.transferPlan.scope.affectedPrincipals, 1);
  const transferId = review.args.transferId;
  // Real human review crosses wall-clock seconds. A refreshed OS preview must
  // preserve the approved scope even when its observation timestamp advances.
  await new Promise(resolve => setTimeout(resolve, 1100));
  const ack = await original.confirmSecurityMutation({ reviewHandle: review.reviewHandle, passphrase });
  assert.equal(ack.state, 'committed'); assert.equal(ack.self.active, false);
  assert.equal((await original.refreshOwnershipTransfer({ boxId, requestId: review.requestId })).transferStatus.state, 'frozen');
  const noPermit = await runtime.command('transfer.prepare', { transferId });
  assert.equal(noPermit.ok, false); assert.match(noPermit.code, /CLOUD_ERASE_APPROVAL_REQUIRED/);
  let inspected = await runtime.command('transfer.inspect', { transferId });
  assert.ok(inspected.privateFilesRemaining > 0); assert.equal(inspected.deliveryPacket, null);
  await runtime.command('transfer.authorize', { transferId });
  const prepared = await runtime.command('transfer.prepare', { transferId }); assert.equal(prepared.ok, true, prepared.code);
  const pending = await original.refreshOwnershipTransfer({ boxId, requestId: review.requestId });
  assert.equal(pending.transferStatus.state, 'erase_pending'); assert.equal(pending.transferStatus.preparedDeliveryDigest, null);
  // The entire HTTPS authority is stopped/reopened at the irreversible boundary.
  // No completion result or new delivery packet is invented by the desktop.
  await runtime.command('restart');
  assert.deepEqual(await original.refreshOwnershipTransfer({ boxId, requestId: review.requestId }), pending);
  const finished = await runtime.command('transfer.finish', { transferId }); assert.equal(finished.ok, true, finished.code);
  inspected = await runtime.command('transfer.inspect', { transferId });
  assert.equal(inspected.privateFilesRemaining, 0); assert.equal(inspected.externalBackupRetained, true); assert.ok(inspected.deliveryPacket);
  const ready = await original.refreshOwnershipTransfer({ boxId, requestId: review.requestId });
  assert.equal(ready.transferStatus.state, 'redelivery_ready'); assert.equal(ready.transferStatus.checkpoint.context.ownershipEpoch, 2);
  await assert.rejects(original.refreshSecurityState({ boxId }), /BINDING_INACTIVE/);
  const second = await next.prepareFirstRoot({ deliveryPacket: inspected.deliveryPacket });
  assert.equal(second.ownershipEpoch, 2);
  await next.confirmFirstRoot({ reviewHandle: second.reviewHandle, passphrase });
  assert.equal((await next.refreshSelfBinding({ boxId })).self.active, true);
  assert.equal((await original.refreshSelfBinding({ boxId })).self.active, false);
  assert.deepEqual(await original.refreshOwnershipTransfer({ boxId, requestId: review.requestId }), ready);
});
