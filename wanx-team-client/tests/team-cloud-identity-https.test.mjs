import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPinnedTransport } from '../device-trust/pinned-transport.mjs';
import { createDeviceTrustCoordinator } from '../device-trust/coordinator.mjs';
import { canonicalLedger } from '../device-trust/ledger-contract.mjs';
import { publicKeyThumbprint } from '../device-trust/binding-contract.mjs';
import { startLedgerRuntime } from './ledger-runtime-harness.mjs';
const id = () => randomBytes(32).toString('base64url');
const passphrase = 'synthetic team local passphrase';
function consumer(runtime, subject) {
  const key = createPrivateKey(runtime.cloudPrivateKey), clientId = 'consumer-' + subject, calls = [];
  let phase = 'authenticated';
  return { calls, logout() { phase = 'signed_out'; }, login() { phase = 'authenticated'; }, snapshot: () => ({ phase, accountId: subject, clientId }),
    async request(input) {
      calls.push(structuredClone(input));
      if (input.path === '/app-api/v1/team/associations/sync') {
        assert.deepEqual(Object.keys(input.body), ['receipt']);
        return { deliveryStatus: 'deviceAckPending' };
      }
      assert.equal(input.path, '/app-api/v1/team/identity-proofs');
      const body = input.body, now = Math.floor(Date.now() / 1000);
      assert.deepEqual(Object.keys(body).sort(), ['boxId','boxKeyThumbprint','deviceId','invitationId','nonce','ownershipEpoch','requestDigest','requestId','targetAccessKey','targetApprovalKey'].sort());
      const payload = { schemaVersion: 1, purpose: 'centuarai.team.identity-association', issuer: 'nexusaos-platform', audience: 'centuarai-local-team-identity',
        subject, jti: id(), issuedAt: now, expiresAt: now + 300, boxId: body.boxId, boxKeyThumbprint: body.boxKeyThumbprint,
        ownershipEpoch: body.ownershipEpoch, requestDigest: body.requestDigest, invitationId: body.invitationId,
        targetAccessKeyThumbprint: publicKeyThumbprint(body.targetAccessKey), targetApprovalKeyThumbprint: publicKeyThumbprint(body.targetApprovalKey),
        clientId, clientKeyThumbprint: id(), nonce: body.nonce };
      const encoded = [canonicalLedger({ alg: 'EdDSA', typ: 'centuarai-team-cloud-identity+jws', kid: runtime.cloudPolicy.kid }), canonicalLedger(payload)]
        .map(value => Buffer.from(value).toString('base64url')).join('.');
      return { proof: encoded + '.' + sign(null, Buffer.from(encoded), key).toString('base64url'), expiresAt: payload.expiresAt, associationId: id(), requestId: body.requestId };
    } };
}
for (const selfApproved of [false, true]) test('Consumer identity with ' + (selfApproved ? 'self-approved and use-device' : 'owner-approved') + ' resource scopes: real HTTPS activation, invitation, consent, restart and revocation', { timeout: 120000 }, async t => {
  const runtime = await startLedgerRuntime(t, { team: true });
  t.after(() => { if (runtime.diagnostic()) t.diagnostic(runtime.diagnostic()); });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-https-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transportFactory = descriptor => { const transport = createPinnedTransport({ descriptor, protocolVersion: 2 }); return { request: async (route, ...args) => { try { return await transport.request(route, ...args); } catch (error) { throw Object.assign(new Error(route + ':' + error.code), { code: error.code }); } } }; };
  const ownerCloud = consumer(runtime, 'synthetic-owner'), memberCloud = consumer(runtime, 'synthetic-member');
  const owner = await createDeviceTrustCoordinator({ directory: path.join(directory, 'owner'), account: ownerCloud, ledgerTransportFactory: transportFactory });
  let member = await createDeviceTrustCoordinator({ directory: path.join(directory, 'member'), account: memberCloud, ledgerTransportFactory: transportFactory });
  t.after(() => { owner.close(); member.close(); });
  await owner.createProfile({ passphrase }); await member.createProfile({ passphrase });
  const boxId = runtime.descriptor.boxId;
  const root = await owner.prepareFirstRoot({ deliveryPacket: runtime.deliveryPacket });
  await owner.confirmFirstRoot({ reviewHandle: root.reviewHandle, passphrase });
  await runtime.command('migrate');
  const policy = await owner.prepareActivatePolicy({ boxId, capabilities: ['device.approve_manage', 'device.approve_use', 'device.revoke', 'member.invite', 'member.revoke'] });
  assert.equal((await owner.confirmSecurityMutation({ reviewHandle: policy.reviewHandle, passphrase })).state, 'committed');
  const activation = await owner.prepareTeamActivation({ boxId, deviceId: boxId });
  assert.equal(JSON.stringify(activation).includes('cloudProof'), false, 'cloud identity proof stays in main');
  assert.equal((await owner.confirmSecurityMutation({ reviewHandle: activation.reviewHandle, passphrase })).state, 'committed');
  assert.equal((await owner.refreshTeam({ boxId })).members[0].roleId, 'owner');
  const resourceReview = await owner.prepareTeamKnowledgeResource({ boxId });
  const resourceId = resourceReview.args.resourceId;
  assert.match(resourceId, /^team:knowledge:[a-f0-9-]{36}$/);
  assert.equal((await owner.confirmSecurityMutation({ reviewHandle: resourceReview.reviewHandle, passphrase })).state, 'committed');
  const deviceResource = await owner.prepareTeamDeviceResource({ boxId, resourceId });
  assert.equal(deviceResource.action, 'team.device-resources');
  assert.equal((await owner.confirmSecurityMutation({ reviewHandle: deviceResource.reviewHandle, passphrase })).state, 'committed');
  assert.ok((await owner.refreshTeam({ boxId })).authority.grants.some(grant => grant.resourceId === resourceId));
  const invitation = await owner.prepareTeamInvite({ boxId, roleId: 'member', capabilities: selfApproved ? ['device.approve_use'] : [],
    grants: [{ resourceId: 'space:personal', actions: ['read', 'write'] }], delegableGrants: selfApproved ? [{ resourceId: 'space:personal', actions: ['read', 'write'] }] : [],
    expiresAt: Math.floor(Date.now() / 1000) + 3600, delegationExpiresAt: null });
  assert.equal((await owner.confirmSecurityMutation({ reviewHandle: invitation.reviewHandle, passphrase })).state, 'committed');
  const packet = await owner.exportTeamInvitation({ boxId, requestId: invitation.requestId });
  const request = await member.prepareTeamJoin({ ...packet, deviceId: boxId });
  assert.equal(request.subject, 'synthetic-member');
  memberCloud.logout();
  await assert.rejects(member.submitTeamJoin({ reviewHandle: request.reviewHandle, passphrase }), { code: 'TEAM_CLOUD_LOGIN_REQUIRED' });
  assert.equal(member.snapshot().boxes.length, 0);
  memberCloud.login();
  const pending = await member.submitTeamJoin({ reviewHandle: request.reviewHandle, passphrase });
  assert.equal(pending.state, 'pending');
  assert.equal(member.snapshot().boxes[0].bindingId, undefined, 'cloud identity and invitation grant no binding');
  const approval = await owner.prepareTeamAdmission({ boxId, requestId: pending.requestId });
  await assert.rejects(owner.confirmSecurityMutation({ reviewHandle: approval.reviewHandle, passphrase }), { code: 'TEAM_TARGET_CONSENT_REQUIRED' });
  const consent = await member.refreshTeamRequest({ boxId, requestId: pending.requestId });
  assert.equal(consent.kind, 'team-target');
  assert.equal(JSON.stringify(consent).includes('cloudProof'), false);
  await member.confirmTeamConsent({ reviewHandle: consent.reviewHandle, passphrase });
  assert.equal(member.snapshot().boxes[0].bindingId, undefined, 'target consent alone grants no binding');
  assert.equal((await owner.confirmSecurityMutation({ reviewHandle: approval.reviewHandle, passphrase })).state, 'committed');
  member.close();
  member = await createDeviceTrustCoordinator({ directory: path.join(directory, 'member'), account: memberCloud, ledgerTransportFactory: transportFactory });
  await member.unlock({ passphrase });
  const admitted = await member.refreshTeamRequest({ boxId, requestId: pending.requestId });
  assert.equal(admitted.self.active, true);
  assert.equal(admitted.member.roleId, 'member');
  assert.equal(admitted.member.subject, 'synthetic-member');
  assert.notEqual(admitted.self.principalId, owner.snapshot().profile.principalId);
  assert.equal(admitted.deliveryStatus, 'deviceAckPending', 'projection pending does not masquerade as complete delivery');
  const memberView = await member.refreshTeam({ boxId });
  assert.equal(memberView.manageTeam, false);
  assert.equal(memberView.members.length, 1, 'member cannot enumerate other members');
  const acl = await owner.prepareTeamResourceAccess({ boxId, resourceId, grants: [
    { principalId: admitted.self.principalId, actions: ['read'] },
    { principalId: owner.snapshot().profile.principalId, actions: ['read', 'write'] },
  ].sort((a, b) => a.principalId < b.principalId ? -1 : 1) });
  await owner.confirmSecurityMutation({ reviewHandle: acl.reviewHandle, passphrase });
  assert.ok((await member.refreshTeam({ boxId })).selfResources.availableGrants.some(grant => grant.resourceId === resourceId));
  if (selfApproved) {
    const selfReview = await member.prepareTeamDeviceResource({ boxId, resourceId });
    await member.confirmSecurityMutation({ reviewHandle: selfReview.reviewHandle, passphrase });
  } else await assert.rejects(member.prepareTeamDeviceResource({ boxId, resourceId }), { code: 'LOCAL_TRUST_CAPABILITY_REQUIRED' });
  let targetDevice = member;
  if (selfApproved) {
    const use = await createDeviceTrustCoordinator({ directory: path.join(directory, 'use'), account: memberCloud, ledgerTransportFactory: transportFactory });
    t.after(() => use.close()); await use.createProfile({ passphrase });
    const join = await use.prepareJoin(await member.exportJoinInfo({ boxId }));
    const sent = await use.submitJoin({ reviewHandle: join.reviewHandle });
    const consent = await member.prepareApproval({ invitation: sent.invitation });
    await member.confirmApproval({ reviewHandle: consent.reviewHandle, passphrase });
    const accepted = await use.refreshRequest({ boxId, requestId: sent.requestId });
    assert.equal(accepted.state, 'approved'); targetDevice = use;
  }
  const { resourceInfo } = await targetDevice.exportTeamDeviceResourceInfo({ boxId });
  const expansion = await owner.prepareTeamRemoteDeviceResource({ boxId, resourceInfo, resourceId });
  assert.equal(expansion.targetRequiresHandoff, true);
  const handoff = await owner.exportTargetReview({ reviewHandle: expansion.reviewHandle });
  const target = await targetDevice.prepareTargetApproval(handoff);
  assert.equal(target.principalId, admitted.self.principalId);
  const signed = await targetDevice.confirmTargetApproval({ reviewHandle: target.reviewHandle, passphrase });
  if (selfApproved) assert.equal(JSON.parse(signed.targetProofs).targetApprovalProof, null, 'use device proves only its approved access key');
  await owner.importTargetProofs({ reviewHandle: expansion.reviewHandle, targetProofs: signed.targetProofs });
  await owner.confirmSecurityMutation({ reviewHandle: expansion.reviewHandle, passphrase });
  const finalReceipt = await owner.exportSecurityReceipt({ boxId, requestId: expansion.requestId });
  await targetDevice.acceptEnrollmentReceipt({ ...finalReceipt });
  assert.ok((await targetDevice.refreshTeam({ boxId })).selfResources.approvedGrants.some(grant => grant.resourceId === resourceId));
  const revoke = await owner.prepareTeamMemberRevocation({ boxId, principalId: admitted.self.principalId });
  assert.equal((await owner.confirmSecurityMutation({ reviewHandle: revoke.reviewHandle, passphrase })).state, 'committed');
  assert.equal((await member.refreshSelfBinding({ boxId })).self.active, false);
});

test('real vault synchronously locks and hides saved identity on Consumer account or client changes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-account-fence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let current = { phase: 'authenticated', accountId: 'first', clientId: 'client1' };
  const listeners = new Set();
  const coordinator = await createDeviceTrustCoordinator({ directory,
    account: { snapshot: () => current, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } } });
  t.after(() => coordinator.close());
  await coordinator.createProfile({ passphrase });
  for (const next of [{ ...current, accountId: 'second' }, { ...current, clientId: 'client2' }, { phase: 'signed_out', accountId: null, clientId: null }]) {
    current = next; for (const listener of listeners) listener();
    assert.equal(coordinator.snapshot().profile.locked, true);
    assert.deepEqual(coordinator.snapshot().boxes, []);
    await coordinator.unlock({ passphrase });
  }
});
