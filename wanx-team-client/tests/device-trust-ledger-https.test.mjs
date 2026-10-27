import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeviceTrustCoordinator } from '../device-trust/coordinator.mjs';
import { createPinnedTransport } from '../device-trust/pinned-transport.mjs';
import { createRecoveryFiles } from '../shell/recovery-files.mjs';
import { startLedgerRuntime } from './ledger-runtime-harness.mjs';

const passphrase = 'synthetic https local passphrase';
test('real Python authority, pinned HTTPS and desktop vault agree on migrated v2 state and owner activation', async t => {
  const runtime = await startLedgerRuntime(t);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ledger-desktop-https-'));
  const failures = [];
  const service = await createDeviceTrustCoordinator({ directory, ledgerTransportFactory: descriptor => {
    const transport = createPinnedTransport({ descriptor, protocolVersion: 2 });
    return { request: async (...args) => {
      try { return await transport.request(...args); } catch (error) { failures.push(error.code); throw error; }
    } };
  } });
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  await service.createProfile({ passphrase });
  const first = await service.prepareFirstRoot({ deliveryPacket: runtime.deliveryPacket });
  await service.confirmFirstRoot({ reviewHandle: first.reviewHandle, passphrase });
  await runtime.command('migrate');
  const current = await service.refreshSecurityState({ boxId: runtime.descriptor.boxId });
  assert.equal(current.self.active, true);
  assert.deepEqual(current.capabilities, ['device.approve_use']);
  assert.equal(current.qualifiedOriginalOwnerRoot, true);
  const review = await service.prepareActivatePolicy({ boxId: runtime.descriptor.boxId,
    capabilities: ['device.approve_manage', 'device.approve_use', 'device.revoke', 'member.invite', 'member.revoke', 'recovery.configure'] });
  const result = await service.confirmSecurityMutation({ reviewHandle: review.reviewHandle, passphrase });
  assert.equal(result.state, 'committed', failures.join(', '));
  assert.equal(result.self.active, true);
  const after = await service.refreshSecurityState({ boxId: runtime.descriptor.boxId });
  assert.equal(after.qualifiedOriginalOwnerRoot, false);
  assert.ok(after.capabilities.includes('device.revoke'));
  await runtime.command('restart');
  const replay = await service.refreshSecurityMutation({ boxId: runtime.descriptor.boxId, requestId: review.requestId });
  assert.equal(replay.state, 'committed');
  assert.equal(replay.self.active, true);
});

test('real HTTPS independent members, device revocation and offline-file recovery preserve principal separation', async t => {
  const runtime = await startLedgerRuntime(t);
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ledger-recovery-https-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let selected = path.join(directory, 'recovery-one.json');
  const files = createRecoveryFiles({ dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: selected }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }),
  } });
  t.after(() => files.close());
  const client = async name => {
    const service = await createDeviceTrustCoordinator({ directory: path.join(directory, name), files });
    t.after(() => service.close()); await service.createProfile({ passphrase }); return service;
  };
  const owner = await client('owner'), manager = await client('manager'), member = await client('member');
  const boxId = runtime.descriptor.boxId;
  const root = await owner.prepareFirstRoot({ deliveryPacket: runtime.deliveryPacket });
  await owner.confirmFirstRoot({ reviewHandle: root.reviewHandle, passphrase });
  await runtime.command('migrate');
  const activation = await owner.prepareActivatePolicy({ boxId,
    capabilities: ['device.approve_manage', 'device.approve_use', 'device.revoke', 'member.invite', 'member.revoke', 'recovery.configure'] });
  assert.equal((await owner.confirmSecurityMutation({ reviewHandle: activation.reviewHandle, passphrase })).state, 'committed');
  async function enroll(target, method) {
    const { targetInfo } = await target.exportTargetInfo();
    const review = await owner[method]({ boxId, targetInfo, capabilities: ['device.approve_use', 'device.revoke', 'recovery.configure'],
      grants: [{ resourceId: 'space:personal', actions: ['read', 'write'] }],
      delegableGrants: [{ resourceId: 'space:personal', actions: ['read', 'write'] }], expiresAt: null, delegationExpiresAt: null });
    const targetReview = await target.prepareTargetApproval(await owner.exportTargetReview({ reviewHandle: review.reviewHandle }));
    const confirmed = await target.confirmTargetApproval({ reviewHandle: targetReview.reviewHandle, passphrase });
    await owner.importTargetProofs({ reviewHandle: review.reviewHandle, targetProofs: confirmed.targetProofs });
    const result = await owner.confirmSecurityMutation({ reviewHandle: review.reviewHandle, passphrase });
    assert.equal(result.state, 'committed');
    const accepted = await target.acceptEnrollmentReceipt(await owner.exportSecurityReceipt({ boxId, requestId: review.requestId }));
    assert.equal(accepted.self.active, true);
    return accepted;
  }
  const samePrincipal = await enroll(manager, 'prepareManagerEnrollment');
  const independent = await enroll(member, 'prepareMemberInvitation');
  assert.notEqual(independent.self.principalId, samePrincipal.self.principalId);
  const memberState = await member.refreshSecurityState({ boxId });
  assert.equal(memberState.devices.length, 1);
  assert.ok(memberState.grants.every(grant => grant.principalId === independent.self.principalId));
  await assert.rejects(member.prepareDeviceRevocation({ boxId, bindingId: samePrincipal.self.bindingId, mode: 'normal' }));
  const revoked = await owner.prepareDeviceRevocation({ boxId, bindingId: samePrincipal.self.bindingId, mode: 'normal' });
  assert.equal((await owner.confirmSecurityMutation({ reviewHandle: revoked.reviewHandle, passphrase })).state, 'committed');
  assert.equal((await manager.refreshSelfBinding({ boxId })).self.active, false);

  const material = await owner.beginRecoveryConfiguration({ boxId });
  await assert.rejects(owner.prepareRecoveryConfiguration({ materialHandle: material.materialHandle }), /REIMPORT_REQUIRED/);
  assert.equal((await owner.exportRecoveryMaterial({ materialHandle: material.materialHandle })).state, 'exported');
  assert.equal((await owner.reimportRecoveryMaterial({ materialHandle: material.materialHandle })).state, 'reimport_verified');
  const setup = await owner.prepareRecoveryConfiguration({ materialHandle: material.materialHandle });
  const configured = await owner.confirmSecurityMutation({ reviewHandle: setup.reviewHandle, passphrase });
  assert.equal(configured.state, 'committed');
  assert.equal(configured.recoveryOutcome, 'configuration-committed');
  const recovered = await client('recovered-new-device');
  const current = await recovered.importIdentityRecovery();
  assert.equal(current.principalId, samePrincipal.self.principalId);
  const replacement = await recovered.beginIdentityRecovery({ recoveryHandle: current.recoveryHandle });
  selected = path.join(directory, 'recovery-two.json');
  await recovered.exportRecoveryMaterial({ materialHandle: replacement.materialHandle });
  await recovered.reimportRecoveryMaterial({ materialHandle: replacement.materialHandle });
  const recovery = await recovered.prepareIdentityRecovery({ materialHandle: replacement.materialHandle });
  const restored = await recovered.confirmIdentityRecovery({ reviewHandle: recovery.reviewHandle, passphrase });
  assert.equal(restored.state, 'committed');
  assert.equal(restored.recoveryOutcome, 'identity-recovered');
  assert.equal(restored.self.active, true);
  assert.equal((await owner.refreshSelfBinding({ boxId })).self.active, false);
  assert.equal((await member.refreshSelfBinding({ boxId })).self.active, true);
  await runtime.command('restart');
  assert.equal((await recovered.refreshSelfBinding({ boxId })).self.active, true);
});

test('registered v2 manager approves a use-device request over HTTPS after the anonymous read pool is full', async t => {
  const runtime = await startLedgerRuntime(t);
  t.after(() => { if (runtime.diagnostic()) t.diagnostic(runtime.diagnostic()); });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ledger-manager-read-'));
  const calls = [];
  const factory = protocolVersion => descriptor => { const transport = createPinnedTransport({ descriptor, protocolVersion });
    return { request: async (route, ...args) => { calls.push(`${protocolVersion}:${route}`); try { return await transport.request(route, ...args); }
      catch (error) { throw Object.assign(new Error(`${protocolVersion}:${route}:${error.code}`), { code: error.code }); } } }; };
  const owner = await createDeviceTrustCoordinator({ directory: path.join(directory, 'owner'), transportFactory: factory(1), ledgerTransportFactory: factory(2) });
  const applicant = await createDeviceTrustCoordinator({ directory: path.join(directory, 'applicant') });
  t.after(async () => { owner.close(); applicant.close(); await rm(directory, { recursive: true, force: true }); });
  await owner.createProfile({ passphrase }); await applicant.createProfile({ passphrase });
  const root = await owner.prepareFirstRoot({ deliveryPacket: runtime.deliveryPacket });
  await owner.confirmFirstRoot({ reviewHandle: root.reviewHandle, passphrase }); await runtime.command('migrate');
  const boxId = runtime.descriptor.boxId;
  const joining = await applicant.prepareJoin(await owner.exportJoinInfo({ boxId }));
  const submitted = await applicant.submitJoin({ reviewHandle: joining.reviewHandle });
  assert.equal((await runtime.command('challenge.saturate')).capacityRejected, true);
  const reviewed = await owner.prepareApproval({ invitation: submitted.invitation });
  const approved = await owner.confirmApproval({ reviewHandle: reviewed.reviewHandle, passphrase });
  assert.equal(approved.state, 'approved');
  assert.ok(calls.includes('2:/authenticated-challenge'));
});
