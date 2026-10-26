import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeviceTrustCoordinator } from '../device-trust/coordinator.mjs';
import { createIdentityVault } from '../device-trust/identity-vault.mjs';
import { ledgerFixture, randomId } from './ledger-test-fixture.mjs';

const passphrase = 'independent ledger passphrase';
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ledger-coordinator-'));
  const vault = createIdentityVault({ directory });
  let remote;
  const factory = () => ({ request: (...args) => remote.request(...args) });
  const service = await createDeviceTrustCoordinator({ directory, vault, ledgerTransportFactory: factory });
  await service.createProfile({ passphrase });
  remote = ledgerFixture(vault.snapshot().profile);
  const saved = vault.readState();
  saved.boxes[remote.descriptor.boxId] = { descriptor: remote.descriptor, role: 'manage',
    principalId: remote.own.principalId, bindingId: remote.own.bindingId, checkpoint: structuredClone(remote.context), requests: {} };
  await vault.writeState(saved);
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, vault, service, remote, factory };
}

test('v2 fresh state uses actual principal scope and per-operation passphrase binds immutable revoke effects', async t => {
  const { service, remote, vault } = await fixture(t);
  const current = await service.refreshSecurityState({ boxId: remote.descriptor.boxId });
  assert.equal(current.self.active, true);
  assert.equal(current.devices.length, 2);
  const review = await service.prepareDeviceRevocation({ boxId: remote.descriptor.boxId, bindingId: 'use-binding', mode: 'normal' });
  assert.equal(review.effects.revokedBindings.count, 1);
  assert.equal('mutationProof' in review, false);
  const result = await service.confirmSecurityMutation({ reviewHandle: review.reviewHandle, passphrase });
  assert.equal(result.state, 'committed');
  assert.equal(result.self.active, true);
  assert.equal(result.dataEffect.effectState, 'unknown');
  assert.equal(remote.target.status, 'revoked');
  assert.ok(vault.readState().boxes[remote.descriptor.boxId].mutations[review.requestId].proofs.mutationProof);
  await assert.rejects(service.confirmSecurityMutation({ reviewHandle: review.reviewHandle, passphrase }), /REVIEW_EXPIRED/);
});

test('lost commit reply keeps exact encrypted proofs; authenticated status restores historical ACK', async t => {
  const { service, remote, vault } = await fixture(t);
  const review = await service.prepareDeviceRevocation({ boxId: remote.descriptor.boxId, bindingId: 'use-binding', mode: 'normal' });
  remote.loseCommit();
  const result = await service.confirmSecurityMutation({ reviewHandle: review.reviewHandle, passphrase });
  assert.equal(result.state, 'outcome_unknown');
  const proofs = vault.readState().boxes[remote.descriptor.boxId].mutations[review.requestId].proofs;
  const resolved = await service.refreshSecurityMutation({ boxId: remote.descriptor.boxId, requestId: review.requestId });
  assert.equal(resolved.state, 'committed');
  assert.deepEqual(vault.readState().boxes[remote.descriptor.boxId].mutations[review.requestId].proofs, proofs);
  assert.equal(remote.calls.filter(call => call.path === '/mutations/prepare').length, 1);
  assert.equal(remote.calls.filter(call => call.path === '/mutations/commit').length, 1);
});

test('wrong passphrase or lock never submits a v2 mutation and consumed reviews cannot retry', async t => {
  const { service, remote } = await fixture(t);
  let review = await service.prepareDeviceRevocation({ boxId: remote.descriptor.boxId, bindingId: 'use-binding', mode: 'normal' });
  await assert.rejects(service.confirmSecurityMutation({ reviewHandle: review.reviewHandle, passphrase: 'wrong passphrase long enough' }), /LOCAL_IDENTITY_/);
  await assert.rejects(service.confirmSecurityMutation({ reviewHandle: review.reviewHandle, passphrase }), /REVIEW_EXPIRED/);
  review = await service.prepareDeviceRevocation({ boxId: remote.descriptor.boxId, bindingId: 'use-binding', mode: 'normal' });
  const pending = service.confirmSecurityMutation({ reviewHandle: review.reviewHandle, passphrase });
  service.lock('screen-locked');
  await assert.rejects(pending, /CONTEXT_CHANGED|LOCKED/);
  assert.equal(remote.calls.filter(call => call.path === '/mutations/commit').length, 0);
  assert.deepEqual(service.snapshot().securityOperations, []);
});

test('historical ACK never makes a revoked current binding active', async t => {
  const { service, remote } = await fixture(t);
  const review = await service.prepareDeviceRevocation({ boxId: remote.descriptor.boxId, bindingId: 'use-binding', mode: 'normal' });
  remote.beforeCommit = () => { remote.own.status = 'revoked'; };
  const result = await service.confirmSecurityMutation({ reviewHandle: review.reviewHandle, passphrase });
  assert.equal(result.state, 'committed');
  assert.equal(result.self.active, false);
  await assert.rejects(service.refreshDataEffect({ boxId: remote.descriptor.boxId, requestId: review.requestId }), /BINDING_INACTIVE/);
});

test('signed mutation cannot silently change the reviewed target or requested action', async t => {
  const { service, remote } = await fixture(t);
  remote.mutateReview = mutation => { mutation.args.bindingId = 'root-binding'; };
  await assert.rejects(service.prepareDeviceRevocation({ boxId: remote.descriptor.boxId, bindingId: 'use-binding', mode: 'normal' }), /MUTATION_CHANGED/);
  assert.equal(remote.calls.filter(call => call.path === '/mutations/commit').length, 0);
});

test('member private projection and old epoch active records do not authorize management', async t => {
  const { service, remote } = await fixture(t);
  remote.own.ownershipEpoch = 1; remote.context.ownershipEpoch = 2;
  const result = await service.refreshSelfBinding({ boxId: remote.descriptor.boxId });
  assert.equal(result.self.active, false);
  await assert.rejects(service.refreshSecurityState({ boxId: remote.descriptor.boxId }), /BINDING_INACTIVE/);
});

for (const action of ['manager', 'member']) test(`independent ${action} target co-signs final review then accepts receipt only after fresh self-binding`, async t => {
  const { service, remote } = await fixture(t);
  remote.own.capabilities = ['device.approve_manage', 'device.approve_use', 'device.revoke', 'member.invite'];
  const targetDirectory = await mkdtemp(path.join(os.tmpdir(), 'ledger-target-'));
  let targetVault = createIdentityVault({ directory: targetDirectory });
  let target = await createDeviceTrustCoordinator({ directory: targetDirectory, vault: targetVault,
    ledgerTransportFactory: () => ({ request: remote.request }) });
  t.after(async () => { target.close(); await rm(targetDirectory, { recursive: true, force: true }); });
  await target.createProfile({ passphrase });
  const info = await target.exportTargetInfo();
  const prepare = action === 'manager' ? 'prepareManagerEnrollment' : 'prepareMemberInvitation';
  const review = await service[prepare]({ boxId: remote.descriptor.boxId, targetInfo: info.targetInfo,
    capabilities: ['device.approve_use'], grants: [{ resourceId: 'space', actions: ['read'] }], delegableGrants: [], expiresAt: null, delegationExpiresAt: null });
  const handoff = await service.exportTargetReview({ reviewHandle: review.reviewHandle });
  const targetReview = await target.prepareTargetApproval(handoff);
  assert.equal(targetReview.kind, 'ledger-target');
  const proofs = await target.confirmTargetApproval({ reviewHandle: targetReview.reviewHandle, passphrase });
  assert.equal(target.snapshot().boxes[0].role, 'pending');
  target.close();
  targetVault = createIdentityVault({ directory: targetDirectory });
  target = await createDeviceTrustCoordinator({ directory: targetDirectory, vault: targetVault, ledgerTransportFactory: () => ({ request: remote.request }) });
  await target.unlock({ passphrase });
  assert.equal(target.snapshot().securityOperations[0].role, 'target');
  assert.equal((await target.resumeTargetApproval({ boxId: remote.descriptor.boxId, requestId: review.requestId })).targetProofs, proofs.targetProofs);
  const confirmedReview = await service.importTargetProofs({ reviewHandle: review.reviewHandle, targetProofs: proofs.targetProofs });
  assert.equal(confirmedReview.targetConfirmed, true);
  const committed = await service.confirmSecurityMutation({ reviewHandle: review.reviewHandle, passphrase });
  assert.equal(committed.state, 'committed');
  const receipt = await service.exportSecurityReceipt({ boxId: remote.descriptor.boxId, requestId: review.requestId });
  const accepted = await target.acceptEnrollmentReceipt(receipt);
  assert.equal(accepted.self.active, true);
  assert.equal(accepted.self.clientId, target.snapshot().profile.clientId);
  const current = await target.refreshSecurityState({ boxId: remote.descriptor.boxId });
  if (action === 'member') {
    assert.equal(current.devices.length, 1);
    assert.notEqual(current.self.principalId, remote.own.principalId);
  } else assert.equal(current.self.principalId, remote.own.principalId);
  const saved = targetVault.readState().boxes[remote.descriptor.boxId].targetReviews[review.requestId];
  assert.equal(Object.keys(saved.targetProofDigests).length, 2);
});

test('original transfer actor reads archived ready evidence across epoch without regaining management or accepting rollback', async t => {
  const { service, remote, vault } = await fixture(t);
  const requestId = randomId(), transferId = randomId(), original = structuredClone(remote.context);
  const state = vault.readState(), item = state.boxes[remote.descriptor.boxId];
  item.mutations = { [requestId]: { ack: 'synthetic-saved-freeze-ack', state: 'committed', mutation: {
    ...original, requestId, action: 'ownership.transfer-prepare', actor: { kind: 'binding', principalId: item.principalId, bindingId: item.bindingId, keyVersion: 1 },
    args: { transferId },
  } } };
  await vault.writeState(state);
  remote.context.rosterVersion++;
  let status = { requestId, transferId, state: 'frozen', sourceOwnershipEpoch: 1,
    checkpoint: { context: structuredClone(remote.context), eventDigest: randomId(), authorizationVersion: 3 },
    updatedAt: remote.now, resetEvidenceDigest: null, preparedDeliveryDigest: null };
  const request = remote.request;
  remote.request = async (path, input) => {
    if (path === '/read' && JSON.parse(Buffer.from(input.proof.split('.')[1], 'base64url')).operation === 'transfer-status')
      return remote.response('transfer-status', status);
    return request(path, input);
  };
  assert.equal((await service.refreshOwnershipTransfer({ boxId: remote.descriptor.boxId, requestId })).transferStatus.state, 'frozen');
  remote.context.ownershipEpoch = 2; remote.context.rosterVersion++;
  status = { ...status, state: 'redelivery_ready', checkpoint: { context: structuredClone(remote.context), eventDigest: randomId(), authorizationVersion: 4 },
    resetEvidenceDigest: randomId(), preparedDeliveryDigest: randomId() };
  assert.equal((await service.refreshOwnershipTransfer({ boxId: remote.descriptor.boxId, requestId })).transferStatus.state, 'redelivery_ready');
  remote.own.status = 'revoked'; remote.projection.ownershipView.state = 'unclaimed_ready';
  await assert.rejects(service.refreshSecurityState({ boxId: remote.descriptor.boxId }), /BINDING_INACTIVE/);
  remote.context.rosterVersion += 3;
  assert.equal((await service.refreshOwnershipTransfer({ boxId: remote.descriptor.boxId, requestId })).transferStatus.checkpoint.context.rosterVersion, 4);
  status = { ...status, state: 'frozen', checkpoint: { ...status.checkpoint, context: { ...status.checkpoint.context, ownershipEpoch: 1 } }, resetEvidenceDigest: null, preparedDeliveryDigest: null };
  await assert.rejects(service.refreshOwnershipTransfer({ boxId: remote.descriptor.boxId, requestId }), /STATUS_CHANGED/);
});
