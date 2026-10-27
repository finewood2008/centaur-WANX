import test from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { publicKeyThumbprint } from '../device-trust/binding-contract.mjs';
import {
  canonicalLedger, ledgerDigest, validateLedgerMutation, validateLedgerResponse,
  signLedgerMutation, verifyLedgerMutation, signLedgerTargetAccess, signLedgerTargetApproval,
  verifyLedgerTargetProofs, verifyLedgerResponse, ledgerRequestSpec,
  signLedgerAuthChallenge, verifyLedgerAuthChallenge, signLedgerAuthMutationChallenge, verifyLedgerAuthMutationChallenge,
} from '../device-trust/ledger-contract.mjs';
import { keyPair, randomId, emptyEffect, ledgerFixture } from './ledger-test-fixture.mjs';

function fixture() {
  const access = keyPair(), approval = keyPair();
  const profile = { principalId: 'principal-one', clientId: 'client-one', accessKey: access.publicKey.export({ format: 'jwk' }), approvalKey: approval.publicKey.export({ format: 'jwk' }) };
  const remote = ledgerFixture(profile), effects = emptyEffect();
  const mutation = { schemaVersion: 2, purpose: 'centuarai.local-ledger.mutation', ...remote.context,
    requestId: randomId(), challenge: randomId(), issuedAt: remote.now, expiresAt: remote.now + 300,
    actor: { kind: 'binding', principalId: profile.principalId, bindingId: 'root-binding', keyVersion: 1 },
    action: 'device.revoke', args: { bindingId: 'use-binding', mode: 'normal' }, effectsDigest: ledgerDigest(effects) };
  return { remote, profile, access, approval, effects, mutation };
}

test('authenticated challenge domains bind a short lived actor nonce and exact mutation action', () => {
  const { mutation, access } = fixture(), key = access.publicKey.export({ format: 'jwk' });
  const payload = { schemaVersion: 2, purpose: 'centuarai.local-ledger.auth-challenge', boxId: mutation.boxId,
    boxKeyThumbprint: mutation.boxKeyThumbprint, ownershipEpoch: 1, actor: mutation.actor,
    clientNonce: randomId(), issuedAt: mutation.issuedAt, expiresAt: mutation.issuedAt + 60 };
  const proof = signLedgerAuthChallenge(payload, access.privateKey);
  assert.deepEqual(verifyLedgerAuthChallenge(proof, key, mutation.issuedAt), payload);
  assert.equal(JSON.parse(Buffer.from(proof.split('.')[0], 'base64url')).typ, 'centuarai-local-ledger.auth-challenge+jws');
  assert.equal(ledgerRequestSpec('/authenticated-challenge', { proof }).kind, 'read-challenge');
  for (const patch of [{ ownershipEpoch: null }, { operation: 'read' }, { clientNonce: 'bad' }, { expiresAt: payload.issuedAt + 61 }])
    assert.throws(() => signLedgerAuthChallenge({ ...payload, ...patch }, access.privateKey), /LOCAL_LEDGER_/);
  const recovery = { ...payload, ownershipEpoch: null, actor: { kind: 'recovery', principalId: payload.actor.principalId, bindingId: null, keyVersion: 1 } };
  assert.deepEqual(verifyLedgerAuthChallenge(signLedgerAuthChallenge(recovery, access.privateKey), key, mutation.issuedAt), recovery);
  const changing = { ...payload, purpose: 'centuarai.local-ledger.auth-mutation-challenge', action: 'device.revoke' };
  const mutationProof = signLedgerAuthMutationChallenge(changing, access.privateKey);
  assert.deepEqual(verifyLedgerAuthMutationChallenge(mutationProof, key, mutation.issuedAt), changing);
  assert.equal(ledgerRequestSpec('/mutations/authenticated-challenge', { proof: mutationProof }).kind, 'mutation-challenge');
  assert.throws(() => ledgerRequestSpec('/mutations/authenticated-challenge', { proof }), /LOCAL_LEDGER_/);
  assert.throws(() => ledgerRequestSpec('/authenticated-challenge', { proof: mutationProof }), /LOCAL_LEDGER_/);
  assert.throws(() => signLedgerAuthMutationChallenge({ ...changing, actor: recovery.actor, ownershipEpoch: null }, access.privateKey), /LOCAL_LEDGER_/);
});

test('ledger proof has fixed domain, exact schema and immutable complete mutation', () => {
  const { mutation, approval } = fixture();
  const proof = signLedgerMutation(mutation, approval.privateKey);
  const decoded = verifyLedgerMutation(proof, approval.publicKey.export({ format: 'jwk' }), mutation.issuedAt);
  assert.deepEqual(decoded, mutation); assert.equal(Object.isFrozen(decoded.args), true);
  const parts = proof.split('.');
  const header = Buffer.from(canonicalLedger({ alg: 'ES256', typ: 'centuarai-local-ledger-target-access+jws' })).toString('base64url');
  assert.throws(() => verifyLedgerMutation([header, ...parts.slice(1)].join('.'), approval.publicKey.export({ format: 'jwk' })), /LOCAL_LEDGER_/);
});

test('unknown action, fields, capability and noncanonical values fail before signing', () => {
  const { mutation, approval } = fixture();
  for (const change of [value => { value.verified = true; }, value => { value.action = 'device.sign-anything'; },
    value => { value.actor.keyVersion = -0; }, value => { value.args.mode = 'soft-delete'; },
    value => { value.effectsDigest += '='; }, value => { value.expiresAt = value.issuedAt + 301; },
    value => { value.actor.kind = 'recovery'; value.actor.bindingId = null; }]) {
    const value = structuredClone(mutation); change(value);
    assert.throws(() => signLedgerMutation(value, approval.privateKey), /LOCAL_LEDGER_/);
  }
  let called = false;
  const value = structuredClone(mutation); Object.defineProperty(value.args, 'bindingId', { enumerable: true, get() { called = true; return 'hidden'; } });
  assert.throws(() => validateLedgerMutation(value), /LOCAL_LEDGER_/); assert.equal(called, false);
});

test('target access and approval proofs must cover the same full final review', () => {
  const { mutation } = fixture(), targetAccess = keyPair(), targetApproval = keyPair();
  const payload = { ...mutation, action: 'device.add-manager', args: { target: {
    clientId: 'new-client', accessKey: targetAccess.publicKey.export({ format: 'jwk' }), approvalKey: targetApproval.publicKey.export({ format: 'jwk' }),
    keyProtection: 'software-passphrase-v1', capabilities: ['device.approve_use'], grants: [{ resourceId: 'space', actions: ['read'] }],
    delegableGrants: [], expiresAt: null, delegationExpiresAt: null,
  } } };
  const proofs = { targetAccessProof: signLedgerTargetAccess(payload, targetAccess.privateKey), targetApprovalProof: signLedgerTargetApproval(payload, targetApproval.privateKey) };
  assert.deepEqual(verifyLedgerTargetProofs(proofs, payload, mutation.issuedAt), proofs);
  assert.throws(() => verifyLedgerTargetProofs(proofs, { ...payload, effectsDigest: randomId() }, mutation.issuedAt), /MUTATION_CHANGED/);
  assert.throws(() => signLedgerTargetAccess(mutation, targetAccess.privateKey), /LOCAL_LEDGER_/);
});

test('scoped projection cannot include another member private bindings or a false digest', () => {
  const { remote } = fixture();
  const value = { schemaVersion: 2, purpose: 'centuarai.local-ledger.response', boxId: remote.descriptor.boxId,
    boxKeyThumbprint: publicKeyThumbprint(remote.descriptor.boxKey), kind: 'principal-state', issuedAt: remote.now,
    body: { context: remote.context, projection: remote.projection, projectionDigest: ledgerDigest(remote.projection) } };
  assert.doesNotThrow(() => validateLedgerResponse(value));
  const foreign = structuredClone(value); foreign.body.projection.bindings[1].principalId = 'another-principal';
  foreign.body.projectionDigest = ledgerDigest(foreign.body.projection);
  assert.throws(() => validateLedgerResponse(foreign), /SCOPE_MISMATCH/);
  const changed = structuredClone(value); changed.body.projectionDigest = randomId();
  assert.throws(() => validateLedgerResponse(changed), /PROJECTION_CHANGED/);
});

test('box signature does not allow an unbound or edited effect summary', () => {
  const { remote, mutation, effects } = fixture();
  const payload = { schemaVersion: 2, purpose: 'centuarai.local-ledger.response', boxId: remote.descriptor.boxId,
    boxKeyThumbprint: publicKeyThumbprint(remote.descriptor.boxKey), kind: 'mutation-review', issuedAt: remote.now,
    body: { mutation, effects: { ...effects, remainingIndependentManagers: 99 } } };
  const input = [
    { alg: 'ES256', typ: 'centuarai-local-ledger-response+jws' }, payload,
  ].map(value => Buffer.from(canonicalLedger(value)).toString('base64url')).join('.');
  const proof = `${input}.${sign('sha256', Buffer.from(input), { key: remote.key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  assert.throws(() => verifyLedgerResponse(proof, { descriptor: remote.descriptor, kind: 'mutation-review', now: remote.now }), /EFFECTS_CHANGED/);
});

test('v2 transport accepts only exact fixed endpoints and explicit unused proof slots', () => {
  const { mutation, approval } = fixture();
  const proofs = { mutationProof: signLedgerMutation(mutation, approval.privateKey), targetAccessProof: null,
    targetApprovalProof: null, recoveryMaterialProof: null, sourceRecoveryProof: null };
  assert.equal(ledgerRequestSpec('/mutations/commit', proofs).kind, 'mutation-ack');
  const { sourceRecoveryProof, ...missing } = proofs;
  assert.throws(() => ledgerRequestSpec('/mutations/commit', missing), /LOCAL_LEDGER_/);
  for (const route of ['/arbitrary', '/mutations/commit?token=1', 'https://elsewhere/'])
    assert.throws(() => ledgerRequestSpec(route, proofs), /ROUTE_INVALID/);
});

test('transfer status distinguishes freeze, pending erasure and ready evidence at the exact historical epoch', () => {
  const { remote } = fixture();
  const payload = { schemaVersion: 2, purpose: 'centuarai.local-ledger.response', boxId: remote.descriptor.boxId,
    boxKeyThumbprint: publicKeyThumbprint(remote.descriptor.boxKey), kind: 'transfer-status', issuedAt: remote.now,
    body: { requestId: randomId(), transferId: randomId(), state: 'frozen', sourceOwnershipEpoch: 1,
      checkpoint: { context: remote.context, eventDigest: randomId(), authorizationVersion: 2 },
      updatedAt: remote.now, resetEvidenceDigest: null, preparedDeliveryDigest: null } };
  assert.doesNotThrow(() => validateLedgerResponse(payload));
  for (const state of ['erase_pending', 'redelivery_ready']) {
    const value = structuredClone(payload); value.body.state = state;
    assert.throws(() => validateLedgerResponse(value));
    value.body.resetEvidenceDigest = randomId();
    if (state === 'redelivery_ready') { value.body.preparedDeliveryDigest = randomId(); value.body.checkpoint.context.ownershipEpoch = 2; }
    assert.doesNotThrow(() => validateLedgerResponse(value));
    value.body.checkpoint.context.ownershipEpoch++;
    assert.throws(() => validateLedgerResponse(value));
  }
  const disclosed = structuredClone(payload); disclosed.body.claimSecret = randomId();
  assert.throws(() => validateLedgerResponse(disclosed));
});

test('signed ledger v2 team membership digests accept underscore/dash prefixes and reject noncanonical tail bits without relaxing token IDs', () => {
  const { remote } = fixture();
  const signResponse = (kind, body) => {
    const payload = { schemaVersion: 2, purpose: 'centuarai.local-ledger.response', boxId: remote.descriptor.boxId,
      boxKeyThumbprint: publicKeyThumbprint(remote.descriptor.boxKey), kind, issuedAt: remote.now, body };
    const input = [{ alg: 'ES256', typ: 'centuarai-local-ledger-response+jws' }, payload]
      .map(value => Buffer.from(canonicalLedger(value)).toString('base64url')).join('.');
    return input + '.' + sign('sha256', Buffer.from(input), { key: remote.key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  };
  const verifyBody = (kind, body) => verifyLedgerResponse(signResponse(kind, body), { descriptor: remote.descriptor, kind, now: remote.now }).body;
  for (const first of [0xfc, 0xf8]) {
    const bytes = Buffer.alloc(32); bytes[0] = first;
    const membershipId = bytes.toString('base64url'); assert.match(membershipId, /^[_-]/);
    const member = { membershipId, principalId: 'principal-one', issuer: 'nexusaos-platform', subject: 'cloud-subject',
      roleId: 'member', status: 'active', revision: 1, createdAt: remote.now, expiresAt: null };
    const invitation = { invitationId: randomId(), roleId: 'member', targetPolicy: { capabilities: [], grants: [{ resourceId: 'wanx', actions: ['read'] }],
      delegableGrants: [], expiresAt: null, delegationExpiresAt: null }, expiresAt: remote.now + 300, status: 'used', revision: 1,
      createdAt: remote.now, usedByMembershipId: membershipId };
    const state = { context: remote.context, members: [member], invitations: [invitation], resources: [], requests: [] };
    assert.equal(verifyBody('self-member', { context: remote.context, member }).member.membershipId, membershipId);
    assert.equal(verifyBody('team-state', state).invitations[0].usedByMembershipId, membershipId);
    for (const invalid of [membershipId.slice(0, -1) + 'B', membershipId + '=', membershipId.slice(1)]) {
      assert.throws(() => verifyBody('self-member', { context: remote.context, member: { ...member, membershipId: invalid } }), /LOCAL_LEDGER_/);
      assert.throws(() => verifyBody('team-state', { ...state, invitations: [{ ...invitation, usedByMembershipId: invalid }] }), /LOCAL_LEDGER_/);
    }
    assert.throws(() => verifyBody('self-member', { context: remote.context, member: { ...member, principalId: membershipId } }), /LOCAL_LEDGER_/);
  }
});
