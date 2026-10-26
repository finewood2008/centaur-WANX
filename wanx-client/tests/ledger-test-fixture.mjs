import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { publicKeyThumbprint } from '../device-trust/binding-contract.mjs';
import { ledgerDigest, mutationDigest, signLedgerResponse, verifyLedgerPrepare,
  verifyLedgerRead, verifyLedgerMutation, verifyLedgerTargetProofs, verifyLedgerAuthChallenge, verifyLedgerAuthMutationChallenge } from '../device-trust/ledger-contract.mjs';

export const randomId = () => randomBytes(32).toString('base64url');
export const keyPair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const assertChallengeIdentity = (binding, payload) => {
  if (!binding || payload.actor.principalId !== binding.principalId || payload.ownershipEpoch !== binding.ownershipEpoch)
    throw new Error('Invalid synthetic challenge actor');
};
export const emptyEffect = () => ({
  targetPrincipalId: 'principal-one', targetBindingIds: [], targetSummaries: [],
  revokedBindings: { count: 0, digest: ledgerDigest([]) }, suspendedBindings: { count: 0, digest: ledgerDigest([]) },
  invalidatedRequests: { count: 0, digest: ledgerDigest([]) }, principalSecurityVersionBefore: null,
  principalSecurityVersionAfter: null, recoveryVersionBefore: null, recoveryVersionAfter: null,
  recoveryBefore: null, recoveryAfter: null, remainingIndependentManagers: 1, verifiedRecoveryAvailable: false,
  grantsBefore: null, grantsAfter: null, capabilitiesBefore: null, capabilitiesAfter: null,
  resultingAuthority: null, redacted: false, ownershipStateAfter: 'owned', requiresVerifiedErase: false,
});
export function ledgerFixture(profile) {
  const key = keyPair(), second = keyPair();
  const now = Math.floor(Date.now() / 1000);
  const descriptor = { boxId: 'ledger-box', baseUrl: 'https://127.0.0.1:9443',
    boxKey: key.publicKey.export({ format: 'jwk' }), tlsSpkiSha256: randomId() };
  const context = { boxId: descriptor.boxId, boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey),
    ownershipEpoch: 1, rosterVersion: 2, rosterDigest: randomId(), policyVersion: 1 };
  const grants = [{ resourceId: 'space', actions: ['read', 'write'] }];
  const principalId = profile.principalId;
  const own = { bindingId: 'root-binding', principalId, clientId: profile.clientId, role: 'manage', status: 'active',
    accessKey: profile.accessKey, approvalKey: profile.approvalKey, approvalKeyVersion: 1,
    canApproveUseDevices: true, delegableGrants: grants, expiresAt: null, delegationExpiresAt: null,
    establishedAt: now - 60, establishedVersion: 1, bindingRevision: 1, ownershipEpoch: 1,
    capabilities: ['device.approve_use', 'device.revoke'], createdByBindingId: null, createdByRecoveryId: null,
    sourceRequestId: randomId(), sourceEventSequence: 1 };
  const target = { ...structuredClone(own), bindingId: 'use-binding', clientId: 'use-client', role: 'use',
    accessKey: second.publicKey.export({ format: 'jwk' }), approvalKey: null, approvalKeyVersion: null,
    canApproveUseDevices: false, delegableGrants: [], capabilities: [], createdByBindingId: own.bindingId,
    sourceRequestId: randomId(), sourceEventSequence: 2 };
  const projection = { principal: { principalId, ownershipEpoch: 1, status: 'active', principalSecurityVersion: 1,
    createdSequence: 1, recoveryVersion: 0 }, ownershipView: { ownershipEpoch: 1, state: 'owned', isOwnerPrincipal: true, allowedOwnerActions: [] },
    bindings: [own, target], grants: [], recoverySummary: null, qualifiedOriginalOwnerRoot: true };
  const response = (kind, body) => signLedgerResponse({ schemaVersion: 2, purpose: 'centuarai.local-ledger.response',
    boxId: descriptor.boxId, boxKeyThumbprint: context.boxKeyThumbprint, kind, issuedAt: now, body }, key.privateKey);
  let prepared, reviewJws, ack, loseCommit = false;
  const calls = [];
  const fixture = {
    key, descriptor, context, projection, own, target, now, calls, response,
    loseCommit() { loseCommit = true; },
    mutateReview: null, beforeCommit: null,
    request: async (path, input) => {
      calls.push({ path, input });
      if (path === '/authenticated-challenge' || path === '/mutations/authenticated-challenge') {
        const locator = JSON.parse(Buffer.from(input.proof.split('.')[1], 'base64url'));
        const binding = projection.bindings.find(value => value.bindingId === locator.actor.bindingId);
        assertChallengeIdentity(binding, locator);
        const changing = path === '/mutations/authenticated-challenge';
        const proof = (changing ? verifyLedgerAuthMutationChallenge : verifyLedgerAuthChallenge)(input.proof, binding.accessKey, Math.floor(Date.now() / 1000));
        return response(changing ? 'mutation-challenge' : 'read-challenge', { context,
          ...(changing ? { actor: proof.actor, action: proof.action, challenge: randomId() } : { nonce: randomId() }),
          issuedAt: now, expiresAt: now + (changing ? 300 : 60) });
      }
      if (path === '/read') {
        const locator = JSON.parse(Buffer.from(input.proof.split('.')[1], 'base64url'));
        const binding = projection.bindings.find(value => value.bindingId === locator.actor.bindingId);
        const proof = verifyLedgerRead(input.proof, binding.accessKey, now);
        if (proof.operation === 'self-binding') return response('self-binding', {
          bindingId: binding.bindingId, principalId: binding.principalId, clientId: binding.clientId, bindingOwnershipEpoch: binding.ownershipEpoch,
          currentContext: context, status: binding.status, principalStatus: projection.principal.status, ownershipState: projection.ownershipView.state,
          bindingRevision: binding.bindingRevision, principalSecurityVersion: 1, authorizationVersion: context.rosterVersion,
        });
        if (proof.operation === 'principal-state') {
          const scoped = { ...projection, principal: { ...projection.principal, principalId: binding.principalId },
            bindings: projection.bindings.filter(value => value.principalId === binding.principalId),
            qualifiedOriginalOwnerRoot: binding === own };
          return response('principal-state', { context, projection: scoped, projectionDigest: ledgerDigest(scoped) });
        }
        if (proof.operation === 'mutation-status') return response('mutation-status', { requestId: prepared.requestId,
          mutationDigest: mutationDigest(prepared), action: prepared.action, state: ack ? 'committed' : 'prepared', ack: ack || null });
        throw new Error('Unexpected read');
      }
      if (path === '/mutations/prepare') {
        const proof = verifyLedgerPrepare(input.prepareProof, own.accessKey, now);
        const effects = emptyEffect(); effects.targetPrincipalId = principalId;
        if (proof.action === 'device.revoke') {
          effects.targetBindingIds = [target.bindingId];
          effects.revokedBindings = { count: 1, digest: ledgerDigest([target.bindingId]) };
          effects.targetSummaries = [{ bindingId: target.bindingId, principalId, clientId: target.clientId, role: 'use',
            accessKeyThumbprint: publicKeyThumbprint(target.accessKey), approvalKeyThumbprint: null,
            bindingRevision: 1, status: 'active', capabilities: [], expiresAt: null, delegationExpiresAt: null }];
        } else if (proof.action === 'owner-policy.activate-v2') {
          effects.capabilitiesBefore = [...own.capabilities]; effects.capabilitiesAfter = proof.args.capabilities;
        }
        prepared = { ...structuredClone(proof), purpose: 'centuarai.local-ledger.mutation', effectsDigest: ledgerDigest(effects) };
        fixture.mutateReview?.(prepared, effects);
        reviewJws = response('mutation-review', { mutation: prepared, effects }); return reviewJws;
      }
      if (path === '/mutations/commit') {
        verifyLedgerMutation(input.mutationProof, own.approvalKey); // exact retry remains valid after expiry
        if (['device.add-manager', 'principal.invite'].includes(prepared.action)) verifyLedgerTargetProofs({
          targetAccessProof: input.targetAccessProof, targetApprovalProof: input.targetApprovalProof,
        }, prepared, now);
        await fixture.beforeCommit?.();
        if (!ack) {
          context.rosterVersion++; context.rosterDigest = randomId();
          if (prepared.action === 'device.revoke') { target.status = 'revoked'; target.bindingRevision++; }
          if (prepared.action === 'owner-policy.activate-v2') own.capabilities = prepared.args.capabilities;
          let resultBinding = target;
          if (['device.add-manager', 'principal.invite'].includes(prepared.action)) {
            resultBinding = { ...structuredClone(own), ...prepared.args.target, bindingId: 'new-manager-binding',
              principalId: prepared.args.principalId || principalId, establishedAt: now, establishedVersion: context.rosterVersion,
              bindingRevision: 1, createdByBindingId: own.bindingId, sourceRequestId: prepared.requestId,
              sourceEventSequence: context.rosterVersion, canApproveUseDevices: prepared.args.target.capabilities.includes('device.approve_use') };
            delete resultBinding.keyProtection; delete resultBinding.grants;
            projection.bindings.push(resultBinding); projection.bindings.sort((a, b) => a.bindingId.localeCompare(b.bindingId));
          }
          ack = response('mutation-ack', { requestId: prepared.requestId, mutationDigest: mutationDigest(prepared), action: prepared.action,
            effectsDigest: prepared.effectsDigest, eventId: 'event:' + randomId(), eventDigest: randomId(), ownershipEpoch: 1,
            rosterVersion: context.rosterVersion, rosterDigest: context.rosterDigest, policyVersion: 1, authorizationVersion: context.rosterVersion,
            committedAt: now, ownershipState: 'owned', result: { principalId: resultBinding.principalId, bindingId: resultBinding.bindingId,
              principalSecurityVersion: 1, recoveryVersion: null, transferId: null, operationId: null } });
        }
        if (loseCommit) { loseCommit = false; throw new Error('SYNTHETIC_REPLY_LOST'); }
        return ack;
      }
      throw new Error('Unexpected route');
    },
  };
  return fixture;
}
